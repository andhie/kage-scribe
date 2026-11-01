/*
 * Kage Scribe — background service worker (Manifest V3).
 * Owns all state: settings ({enabled} only; the capture patterns are
 * constants), raw captured responses (a live messages capture carries
 * `formatOk`/`msgCount`, the source of the capture-health warning), the merged message store
 * (deduplicated by message _id across pages/requests/chats) and the
 * "fetch all pages" replay that backfills an entire chat. No replay starts
 * without a user click (Export or "Reload full chat" in the panel).
 */
importScripts('lib/merge.js');

const KEYS = {
  settings: 'ks_settings',
  raw: 'ks_raw',
  merged: 'ks_merged',
  chats: 'ks_chats',
  fetch: 'ks_fetch'
};

// Fixed in code, not settings: a saved value would override every later fix.
// hook.js keeps its own copy of the filter.
const CAPTURE_FILTER = '/api/';
const MESSAGES_PATTERN = '/api/chats/.*/messages';
const MESSAGES_RE = new RegExp(MESSAGES_PATTERN, 'i');

const LIMITS = {
  maxRawEntries: 250,     // max number of raw responses kept for inspection
  maxRawBytes: 40 * 1024 * 1024,
  maxBodyChars: 4 * 1000 * 1000,
  maxUrlChars: 16000,
  maxPlotChars: 2000,     // chat plot summary kept for the Word cover
  maxHeaderChars: 32000,  // all request header names + values of one capture
  saveDebounceMs: 700,
  mergedPage: 5000        // slim messages per ks:getMerged reply (~7.5 MB, far below Chrome's 64 MB)
};

let _state = null;
let _loadPromise = null;
let _saveTimer = 0;
let _dirtyCount = 0;
const _dirty = new Set(); // KEYS names changed since the last write
let _rawSeq = 0;
let _fetchRunning = false;
// Changes whenever ks_merged changes, so a paged read (ks:getMerged) can tell
// that the store moved between pages. Starts at the clock so a worker restart
// never repeats an old value.
let _mergedRev = Date.now();

const newRawId = () => Date.now().toString(36) + '-' + (++_rawSeq);

// Message and chat ids come from captured (page-controlled) data. On a plain
// object, st.chats['__proto__'] is Object.prototype, so these maps have none.
const idMap = (v) => Object.assign(Object.create(null), (v && typeof v === 'object' && !Array.isArray(v)) ? v : {});

const SITE_DOMAINS = ['kagesekai.ai', 'isekaizero.ai']; // keep in step with manifest host_permissions

/* ------------------------------------------------ state */

async function getState() {
  if (_state) return _state;
  if (!_loadPromise) {
    _loadPromise = (async () => {
      const got = await chrome.storage.local.get(null);
      const raw = Array.isArray(got && got.ks_raw) ? got.ks_raw : [];
      if (raw.some((e) => !e.id)) { // entries stored before ids existed: give them stable ids once
        raw.forEach((e) => { if (!e.id) e.id = newRawId(); });
        _dirty.add('raw');
      }
      let fetchStatus = (got && got.ks_fetch) || null;
      if (fetchStatus && fetchStatus.running) {
        // the worker that ran it died (browser closed, worker stopped): it never wrote running:false
        fetchStatus = { ...fetchStatus, running: false, error: 'Interrupted: the extension stopped during the load.', doneAt: Date.now() };
      }
      _state = {
        // only `enabled` is read: keys of removed settings in an old store are ignored
        settings: { enabled: ((got && got.ks_settings) || {}).enabled !== false },
        raw,
        merged: idMap(got && got.ks_merged),
        chats: idMap(got && got.ks_chats),
        fetchStatus
      };
      return _state;
    })();
  }
  return _loadPromise;
}

/** keys: KEYS names ('raw', 'merged', 'chats', 'fetch') that changed. */
function scheduleSave(st, keys, force) {
  if (keys.includes('merged')) _mergedRev++;
  keys.forEach((k) => _dirty.add(k));
  _dirtyCount++;
  if (force || _dirtyCount >= 5) {
    flush(st);
    return;
  }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => flush(st), LIMITS.saveDebounceMs);
}

/** Write only the changed keys (raw alone can be 40 MB), then tell open
 *  extension pages to refresh. */
async function flush(st, keys) {
  clearTimeout(_saveTimer);
  if (keys && keys.includes('merged')) _mergedRev++;
  (keys || []).forEach((k) => _dirty.add(k));
  const names = [..._dirty];
  _dirty.clear();
  _dirtyCount = 0;
  if (!names.length) return;
  const field = { raw: 'raw', merged: 'merged', chats: 'chats', fetch: 'fetchStatus' };
  const obj = {};
  for (const k of names) obj[KEYS[k]] = st[field[k]];
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    names.forEach((k) => _dirty.add(k)); // retried on the next save
    console.warn('[KageScribe] storage flush failed:', e);
    return;
  }
  try { chrome.runtime.sendMessage({ type: 'ks:changed' }).catch(() => {}); } catch (e) { /* no page open */ }
}

/**
 * A messages capture is a GET of the list itself. A send, delete or
 * regenerate call on the same path (or below it) holds no list; as a
 * fetch-all base it would replay the wrong URL and wipe the chat.
 */
function isMessagesCapture(e) {
  if (e.method !== 'GET') return false;
  const path = String(e.url).split(/[?#]/)[0];
  const m = MESSAGES_RE.exec(path);
  return !!m && /^\/?$/.test(path.slice(m.index + m[0].length));
}

/* ------------------------------------------------ capture + merge */

function pruneRaw(st) {
  const size = (e) => (e.body ? e.body.length : 0) + (e.requestBody ? e.requestBody.length : 0);
  let bytes = st.raw.reduce((n, e) => n + size(e), 0);
  while (st.raw.length > LIMITS.maxRawEntries || (bytes > LIMITS.maxRawBytes && st.raw.length)) {
    // Evict the oldest non-messages entry first; messages responses are the valuable ones.
    const i = Math.max(0, st.raw.findIndex((e) => !e.isMessages));
    bytes -= size(st.raw[i]);
    st.raw.splice(i, 1);
  }
}

/**
 * A live capture is posted from the page's MAIN world, so any script on the
 * site can forge one. Keep only the known fields, with types and sizes checked.
 */
function cleanEntry(e) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const headers = {};
  let room = LIMITS.maxHeaderChars;
  if (e.requestHeaders && typeof e.requestHeaders === 'object') {
    for (const [k, v] of Object.entries(e.requestHeaders)) {
      const val = String(v);
      room -= k.length + val.length;
      if (room < 0) break;
      headers[k] = val;
    }
  }
  const out = {
    ts: num(e.ts) || Date.now(),
    durationMs: num(e.durationMs),
    method: str(e.method, 16).toUpperCase() || 'GET',
    url: str(e.url, LIMITS.maxUrlChars),
    status: num(e.status) || 0,
    ok: e.ok === true,
    contentType: str(e.contentType, 256),
    requestHeaders: headers,
    requestBody: str(e.requestBody, 200000),
    credentials: str(e.credentials, 32),
    body: str(e.body, LIMITS.maxBodyChars),
    source: e.source === 'fetch-all' ? 'fetch-all' : 'live',
    chatId: str(e.chatId, 200)
  };
  if (typeof e.error === 'string') out.error = e.error.slice(0, 1000);
  return out;
}

async function handleCapture(input) {
  const st = await getState();
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') return { error: 'bad entry' };
  const entry = cleanEntry(input);
  // The page can post `enabled` itself, so the pause is enforced here. A
  // fetch-all page still passes: an Export clicked while paused must work.
  if (entry.source === 'live' && !st.settings.enabled) return { ok: true, skipped: 'paused' };
  entry.id = newRawId();

  entry.isMessages = isMessagesCapture(entry);
  const cm = entry.url.match(/\/chats\/([^/?#]+)/i);
  entry.chatId = (cm && cm[1]) || entry.chatId || '';

  st.raw.push(entry);
  pruneRaw(st);

  let newMessages = 0;
  let removedMessages = 0;
  if (entry.isMessages) {
    const parsed = KSMerge.tryParse(entry.body);
    const msgs = KSMerge.extractMessages(parsed);
    if (entry.source === 'live' && entry.ok) {
      // Capture health: a 200 response that holds no readable messages, and is
      // not a valid empty chat or a page past the end, means the format changed.
      // fetch-all pages get no flag: the reload stops on an empty page itself.
      const pm = pageMetaOf(parsed);
      const emptyChat = pm.totalCount === 0;
      const pastEnd = pm.page != null && pm.totalPages != null && pm.page > pm.totalPages;
      entry.formatOk = !(parsed === null || (!msgs.length && !emptyChat && !pastEnd));
      entry.msgCount = msgs.length; // healthOf reads this: a raw body is too big to parse per getState
    }
    for (const m of msgs) {
      if (!m || !m._id) continue;
      // Last capture wins: regenerated choices update the same message _id,
      // and fetch-all re-fetches overwrite stale live copies.
      if (!st.merged[m._id]) newMessages++;
      st.merged[m._id] = m;
    }
    removedMessages = reconcileFirstPage(st, entry, msgs, parsed);
    updateChatTotals(st, entry, msgs, parsed);
  }

  sniffChatMeta(st, entry);

  scheduleSave(st, entry.isMessages ? ['raw', 'merged', 'chats'] : ['raw', 'chats']);
  updateBadge(st);
  return { ok: true, raw: st.raw.length, newMessages, removedMessages };
}

function pageMetaOf(parsed) {
  const d = (parsed && parsed.data) || {};
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  return {
    hasNext: typeof d.hasNext === 'boolean' ? d.hasNext : null,
    page: num(d.page),
    pageSize: num(d.pageSize),
    totalCount: num(d.totalCount),
    totalPages: num(d.totalPages)
  };
}

/**
 * Detect server-side deletions from a page-1 messages response. Absence alone
 * is ambiguous under pagination (the message may live on another page), so
 * only two inferences are allowed:
 *  - 'full': the server says hasNext:false, or page 1 returned fewer rows
 *    than pageSize => the response IS the whole chat => any merged message
 *    of that chat absent from it was deleted.
 *  - 'window': a full newest-first page 1 contains every message newer than
 *    its oldest row => a merged message strictly newer than that cutoff but
 *    absent was deleted. Absence at/below the cutoff is inconclusive.
 * Page>1, empty responses and responses not verifiably newest-first are
 * always inconclusive — this must never delete on a guess.
 */
function reconcileFirstPage(st, entry, msgs, parsed) {
  if (!msgs || !msgs.length) return 0;
  let u = null;
  try { u = new URL(entry.url); } catch (e) { return 0; }
  const pg = u.searchParams.get('page');
  if (pg != null && pg !== '1') return 0;

  const ca = (m) => String((m && m.createdAt) || '');
  for (let i = 1; i < msgs.length; i++) {
    if (ca(msgs[i - 1]) < ca(msgs[i])) return 0; // not newest-first → inconclusive
  }

  const chatIds = new Set(msgs.map((m) => m && m._chatId).filter(Boolean));
  if (entry.chatId) chatIds.add(entry.chatId);
  const present = new Set(msgs.map((m) => m && m._id).filter(Boolean));

  const meta = pageMetaOf(parsed);
  const psRaw = u.searchParams.get('pageSize');
  const ps = psRaw != null && /^\d+$/.test(psRaw) ? parseInt(psRaw, 10) : NaN;
  const fullPage = Number.isFinite(ps) && msgs.length >= ps;
  let mode;
  if (meta.hasNext === false) mode = 'full';
  else if (meta.hasNext === true) mode = fullPage ? 'window' : null;
  else if (Number.isFinite(ps)) mode = msgs.length < ps ? 'full' : 'window';
  else mode = 'window';
  if (!mode) return 0;

  let cutoff = '';
  if (mode === 'window') {
    cutoff = ca(msgs[msgs.length - 1]); // oldest row on the page
    if (!cutoff) return 0; // no verifiable window boundary
  }

  return removeMerged(st, (m) => chatIds.has(m._chatId) && !present.has(m._id)
    && (mode === 'full' || ca(m) > cutoff)); // below the window: on a later page, keep
}

/** After a completed fetch-all walk: anything of these chats not seen is deleted on the server. */
function reconcileChat(st, chatIds, seenIds) {
  const removed = removeMerged(st, (m) => chatIds.has(m._chatId) && !seenIds.has(m._id));
  if (removed) _mergedRev++; // fetch-all awaits more work before its final flush
  return removed;
}

/** Delete every merged message for which drop(m) holds; returns the count. */
function removeMerged(st, drop) {
  let removed = 0;
  for (const k of Object.keys(st.merged)) {
    if (st.merged[k] && drop(st.merged[k])) {
      delete st.merged[k];
      removed++;
    }
  }
  return removed;
}

/** Live (non-deleted) message and chat counts: all the popup shows. */
function liveStats(st) {
  const chats = new Set();
  let liveMessages = 0;
  for (const m of Object.values(st.merged)) {
    if (!m || m.deleted === true) continue;
    liveMessages++;
    chats.add(m._chatId || '');
  }
  return { liveMessages, liveChats: chats.size };
}

/** The store's live (non-deleted) message count for one chat — the number the
 *  count invariant compares against the server's totalCount. */
function liveCount(st, chatId) {
  let live = 0;
  for (const k of Object.keys(st.merged)) {
    const m = st.merged[k];
    if (m && m._chatId === chatId && m.deleted !== true) live++;
  }
  return live;
}

/**
 * Track the server-reported totals per chat and derive staleness from the
 * count invariant: if the merged live count for a chat exceeds the response's
 * totalCount, the store provably holds messages deleted on the site. Works
 * from any page's envelope (page 1 or page 14 alike). Returns {cid, stale}
 * when provably stale, else null (clears any previous stale flag).
 */
function updateChatTotals(st, entry, msgs, parsed) {
  const cid = (msgs.length && msgs[0] && msgs[0]._chatId) || entry.chatId;
  if (!cid) return null;
  const meta = (st.chats[cid] = st.chats[cid] || {});
  const site = siteOf(entry.url);
  if (site) meta.site = site;
  const m = pageMetaOf(parsed);
  if (m.totalCount != null) meta.totalCount = m.totalCount;
  if (m.totalPages != null) meta.totalPages = m.totalPages;
  if (meta.totalCount == null) return null;
  const stale = liveCount(st, cid) - meta.totalCount;
  if (stale > 0) {
    meta.stale = stale;
    return { cid, stale };
  }
  delete meta.stale;
  return null;
}

/**
 * Display name for a chat object, wherever the site keeps it: list items carry
 * `name`/`title` directly, while a GET /api/chats/{id} detail object keeps the
 * site's own label for the playthrough nested at `history.name` (e.g.
 * "Story Title - #2") with the storyline snapshot title as a last resort.
 */
function chatNameOf(c) {
  const s = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : '';
  return s(c.name)
    || s(c.title)
    || s(c.history && c.history.name)
    || s(c.storylineSnapshot && c.storylineSnapshot.title);
}

/** Which of the two supported sites an https URL belongs to ('' if neither).
 *  Also the gate for fetch-all: it replays captured auth headers only there. */
function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    const h = u.hostname.toLowerCase();
    const d = SITE_DOMAINS.find((s) => h === s || h.endsWith('.' + s));
    return d ? d.split('.')[0] : '';
  } catch (e) { return ''; }
}

/**
 * Best-effort chat metadata: pull chat names from chat list/detail responses
 * (e.g. GET /api/chats, GET /api/chats/{id}) so the merged view can label
 * chats instead of showing bare ids. Never throws; ignores anything that
 * doesn't look like chat objects with a resolvable name.
 */
function sniffChatMeta(st, entry) {
  const path = String(entry.url || '').split('?')[0];
  // matches /api/chats and /api/chats/{id} but NOT /api/chats/{id}/messages
  if (!/\/api\/chats(\/[^/?]+)?\/?$/i.test(path)) return;
  const parsed = KSMerge.tryParse(entry.body);
  if (!parsed) return;
  const d = parsed.data !== undefined ? parsed.data : parsed;
  const candidates = [];
  const push = (x) => { if (x && typeof x === 'object' && typeof x._id === 'string') candidates.push(x); };
  if (Array.isArray(d)) d.forEach(push);
  else if (d && Array.isArray(d.data)) d.data.forEach(push);
  else if (d && Array.isArray(d.chats)) d.chats.forEach(push);
  else if (d && typeof d === 'object') { push(d); if (d.chat) push(d.chat); }
  if (Array.isArray(parsed)) parsed.forEach(push);
  for (const c of candidates) {
    const name = chatNameOf(c);
    if (!name) continue;
    // last seen wins — merged, so the totals/stale bookkeeping
    // updateChatTotals keeps on the same object survives a name refresh
    const site = siteOf(entry.url);
    // a string, trimmed and capped: it comes from captured (page-controlled) data
    const ps = c.storylineSnapshot && c.storylineSnapshot.plotSummary;
    const plotSummary = typeof ps === 'string' ? ps.trim().slice(0, LIMITS.maxPlotChars).trim() : '';
    st.chats[c._id] = {
      ...(st.chats[c._id] || {}), name, ...(site ? { site } : {}), ...(plotSummary ? { plotSummary } : {}),
      ts: entry.ts || Date.now()
    };
  }
}

/**
 * Capture health from the raw entries, newest first. formatError: the newest
 * live messages capture that carries `formatOk` failed. lastSavedAt: `ts` of
 * the newest live messages capture that held at least one message. Both come
 * from ks_raw, so they survive a worker restart and clear with "Clear raw".
 */
function healthOf(st) {
  let formatError = null;
  let lastSavedAt = null;
  for (let i = st.raw.length - 1; i >= 0 && (formatError === null || lastSavedAt === null); i--) {
    const e = st.raw[i];
    if (formatError === null && typeof e.formatOk === 'boolean') formatError = e.formatOk === false;
    if (lastSavedAt === null && e.msgCount > 0) lastSavedAt = e.ts;
  }
  return { formatError: formatError === true, lastSavedAt };
}

function updateBadge(st) {
  const n = st.raw.length;
  const broken = st.settings.enabled && healthOf(st).formatError;
  const text = broken ? '!' : st.settings.enabled && n ? String(Math.min(n, 999)) : '';
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: broken ? '#d93025' : '#7c5cff' });
  } catch (e) { /* action unavailable */ }
}

/* ------------------------------------------------ fetch-all-pages replay */

function startFetchAll(chatId, pageSizeArg, st) {
  if (_fetchRunning) throw new Error('A "fetch all pages" run is already in progress.');
  const withHeaders = [];
  const any = [];
  for (let i = st.raw.length - 1; i >= 0; i--) {
    const e = st.raw[i];
    // Re-check: entries saved by older versions flagged any method as messages.
    if (!isMessagesCapture(e) || !siteOf(e.url)) continue;
    if (chatId && e.chatId && e.chatId !== chatId) continue;
    if (e.requestHeaders && Object.keys(e.requestHeaders).length) withHeaders.push(e);
    any.push(e);
  }
  const base = withHeaders[0] || any[0];
  if (!base) {
    throw new Error('No captured messages request found for this chat. Open the chat on the site once (so the messages API fires), then retry.');
  }
  if (!base.chatId) throw new Error('Could not determine the chat id from the captured request.');

  const status = {
    running: true,
    chatId: base.chatId,
    page: 0,
    pages: null,
    totalCount: null,
    fetched: 0,
    mergedTotal: Object.keys(st.merged).length,
    error: null,
    startedAt: Date.now()
  };
  st.fetchStatus = status;
  scheduleSave(st, ['fetch'], true);
  runFetchAll(base, pageSizeArg, st, status);
  return status;
}

async function runFetchAll(base, pageSizeArg, st, status) {
  _fetchRunning = true;
  try {
    const u = new URL(base.url);
    const origPageSize = parseInt(u.searchParams.get('pageSize') || '10', 10) || 10;
    const ps = Math.min(Math.max(parseInt(pageSizeArg, 10) || origPageSize, 1), 200);
    const headers = { ...(base.requestHeaders || {}) };
    for (const h of ['host', 'Host', 'content-length', 'Content-Length', 'connection', 'Connection']) delete headers[h];

    let page = 1;
    const seenIds = new Set();
    const seenChatIds = new Set(status.chatId ? [status.chatId] : []);
    while (page <= 1000) {
      u.searchParams.set('page', String(page));
      u.searchParams.set('pageSize', String(ps));
      const res = await fetch(u.toString(), { method: 'GET', headers, credentials: 'include' });
      if (!res.ok) {
        const hint = (res.status === 401 || res.status === 403)
          ? ' — auth rejected. Refresh the site tab (so it re-authenticates), interact once, then retry.'
          : '';
        throw new Error('HTTP ' + res.status + ' on page ' + page + hint);
      }
      const text = await res.text();
      const parsed = KSMerge.tryParse(text);
      const msgs = KSMerge.extractMessages(parsed);
      for (const m of msgs) {
        if (m && m._id) {
          seenIds.add(m._id);
          if (m._chatId) seenChatIds.add(m._chatId);
        }
      }

      await handleCapture({
        ts: Date.now(),
        durationMs: 0,
        method: 'GET',
        url: u.toString(),
        status: res.status,
        ok: true,
        contentType: res.headers.get('content-type') || '',
        requestBody: '',
        requestHeaders: headers,
        credentials: 'include',
        body: text,
        source: 'fetch-all'
      });

      status.page = page;
      status.fetched++;
      status.seen = seenIds.size;
      const pg = pageMetaOf(parsed);
      if (pg.totalPages != null) status.pages = pg.totalPages;
      if (pg.totalCount != null) status.totalCount = pg.totalCount;
      status.mergedTotal = Object.keys(st.merged).length;
      st.fetchStatus = { ...status };
      scheduleSave(st, ['fetch'], true);

      if (msgs.length === 0) break;
      if (status.pages && page >= status.pages) break;
      page++;
      await new Promise((r) => setTimeout(r, 300));
    }
    // A walk that saw the whole chat may delete what it did not see. A message
    // deleted on the site mid-walk shifts the pages, so one live message can
    // be skipped: then seen < totalCount and nothing is deleted.
    const sawAll = status.totalCount == null || seenIds.size >= status.totalCount;
    status.reconciled = sawAll ? reconcileChat(st, seenChatIds, seenIds) : 0;
    // A run doubles as "label this chat": if no name was ever captured (the
    // chat detail was never loaded), ask the chat-detail endpoint for it.
    // Best-effort — never fails the run.
    await backfillChatName(base, headers, st, status.chatId);
  } catch (err) {
    status.error = String((err && err.message) || err);
  } finally {
    status.running = false;
    status.doneAt = Date.now();
    _fetchRunning = false;
    st.fetchStatus = { ...status };
    await flush(st, ['fetch', 'merged', 'chats']);
  }
}

/** GET /api/chats/{id} for a chat whose name was never captured: derived from
 *  the replayed messages URL by stripping the trailing /messages segment. */
async function backfillChatName(base, headers, st, chatId) {
  const meta = st.chats[chatId];
  if (meta && meta.name) return;
  try {
    const u = new URL(base.url);
    if (!/\/messages\/?$/.test(u.pathname)) return;
    u.pathname = u.pathname.replace(/\/messages\/?$/, '');
    u.search = '';
    const res = await fetch(u.toString(), { method: 'GET', headers, credentials: 'include' });
    if (!res.ok) return;
    const parsed = KSMerge.tryParse(await res.text());
    const c = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
    const name = c ? chatNameOf(c) : '';
    if (name && String(c._id) === String(chatId)) {
      st.chats[chatId] = { ...(st.chats[chatId] || {}), name, ts: Date.now() };
      scheduleSave(st, ['chats']);
    }
  } catch (e) { /* name stays unknown — harmless */ }
}

/* ------------------------------------------------ settings */

function sanitizeSettings(next, current) {
  const out = { ...current };
  if (next) {
    if (typeof next.enabled === 'boolean') out.enabled = next.enabled;
  }
  return out;
}

/** Push changed capture settings to the bridge in every open site tab. */
async function pushSettingsToTabs(settings) {
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts[0].matches });
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'ks:pushSettings', settings }).catch(() => {});
  } catch (e) { /* tabs unavailable */ }
}

/** A raw entry without its bulky fields: what the capture list needs. */
function rawMeta(e) {
  const { body, requestBody, requestHeaders, ...meta } = e;
  return { ...meta, bodyLen: body ? body.length : 0 };
}

/* ------------------------------------------------ message router */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A site tab (the bridge) only sends captures. Refuse the rest from there:
  // they read auth headers, delete data, change settings or start replays.
  const fromSite = sender && sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (fromSite && !(msg && msg.type === 'ks:capture')) {
    sendResponse({ error: 'not allowed from a content script' });
    return false;
  }
  (async () => {
    try {
      const st = await getState();
      switch (msg && msg.type) {
        case 'ks:capture':
          sendResponse(await handleCapture(msg.entry));
          break;

        case 'ks:getState':
          // Persist pending debounced changes — but never write a clean store:
          // each write sends ks:changed to every open panel, which calls
          // getState again: a write/refresh loop that keeps this worker awake.
          if (_dirty.size) await flush(st);
          // One reply is capped at 64 MB: raw bodies come one at a time
          // through ks:getRaw, messages in pages through ks:getMerged.
          sendResponse({
            settings: st.settings,
            health: healthOf(st),
            patterns: { captureFilter: CAPTURE_FILTER, messagesPattern: MESSAGES_PATTERN },
            raw: st.raw.map(rawMeta),
            mergedCount: Object.keys(st.merged).length,
            mergedRev: _mergedRev,
            ...liveStats(st),
            chats: st.chats,
            fetchStatus: st.fetchStatus
          });
          break;

        case 'ks:getMerged': {
          // A page of another revision would skip or repeat messages.
          if (msg.rev !== _mergedRev) { sendResponse({ stale: true }); break; }
          const offset = Math.max(0, msg.offset | 0);
          sendResponse({
            items: Object.values(st.merged).slice(offset, offset + LIMITS.mergedPage).map(KSMerge.slimMessage)
          });
          break;
        }

        case 'ks:getRaw':
          sendResponse({ entry: st.raw.find((e) => e.id === msg.id) || null });
          break;

        case 'ks:getFetchStatus':
          sendResponse({ fetchStatus: st.fetchStatus });
          break;

        case 'ks:settings': {
          st.settings = sanitizeSettings(msg.settings, st.settings);
          await chrome.storage.local.set({ [KEYS.settings]: st.settings });
          pushSettingsToTabs(st.settings);
          updateBadge(st);
          sendResponse({ ok: true, settings: st.settings });
          break;
        }

        case 'ks:clear': {
          const scope = msg.scope || 'all';
          if (scope === 'raw' || scope === 'all') st.raw = [];
          if (scope === 'merged' || scope === 'all') st.merged = idMap();
          if (scope === 'all') { st.chats = idMap(); st.fetchStatus = null; } // names, totals, stale counts
          await flush(st, { raw: ['raw'], merged: ['merged'] }[scope] || ['raw', 'merged', 'chats', 'fetch']);
          updateBadge(st);
          sendResponse({ ok: true });
          break;
        }

        case 'ks:removeChat': {
          const id = String(msg.chatId || '');
          if (!id) {
            sendResponse({ error: 'chatId required' });
            break;
          }
          const removed = removeMerged(st, (m) => m._chatId === id);
          delete st.chats[id];
          await flush(st, ['merged', 'chats']);
          updateBadge(st);
          sendResponse({ ok: true, removed });
          break;
        }

        case 'ks:fetchAll': {
          try {
            const status = startFetchAll(msg.chatId, msg.pageSize, st);
            sendResponse({ ok: true, fetchStatus: status });
          } catch (err) {
            sendResponse({ error: String((err && err.message) || err) });
          }
          break;
        }

        default:
          sendResponse({ error: 'unknown message type' });
      }
    } catch (err) {
      try { sendResponse({ error: String((err && err.message) || err) }); } catch (e2) { /* channel closed */ }
    }
  })();
  return true; // async sendResponse
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const st = await getState();
  await chrome.storage.local.set({ [KEYS.settings]: st.settings });
  updateBadge(st);
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  updateBadge(st);
});
