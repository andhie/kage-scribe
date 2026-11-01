/* Kage Scribe — dashboard panel logic. */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let S = {
  settings: { enabled: true },
  patterns: null,
  raw: [],
  merged: [],
  chats: {},
  fetchStatus: null
};

const ui = {
  view: 'simple',      // 'simple' (chat list) or 'advanced' (dev dashboard)
  tab: 'merged',       // advanced tab: 'merged' (Messages) or 'captures' (Developer)
  sel: -1,            // index into S.raw
  insp: 'pretty',
  chat: 'all',
  role: 'all',
  q: '',
  dir: 'asc'
};

/* Simple-view transient state: which row is busy loading its full chat, and
   the last human-readable error per chat id ('all' = the all-chats row). */
const simpleBusy = {};
const simpleErrors = {};

/* Last selection the capture list scrolled to — re-renders triggered by live
   captures must not yank the user's scroll position back to it. */
let lastRenderedSel = null;

/* ------------------------------------------------ helpers */

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...(extra || {}) }).catch(() => null);
}

/** DOM builder: element with class and (safe, textContent-only) text. */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null && text !== '') n.textContent = text;
  return n;
}

const fmtBytes = (n) => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const shortId = (id) => (id ? String(id).slice(0, 10) + '…' : '');
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

function relTime(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) { const m = Math.floor(s / 60); return m + (m === 1 ? ' minute' : ' minutes') + ' ago'; }
  if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? ' hour' : ' hours') + ' ago'; }
  if (s < 172800) return 'yesterday';
  return new Date(t).toLocaleDateString();
}

/** Filename-safe version of a chat name; unicode letters kept, length capped. */
function safeFileBase(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return s || 'chat';
}

let toastTimer = 0;
function toast(text) {
  const e = $('#toast');
  e.textContent = text;
  e.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => e.classList.add('hidden'), 2600);
}

function urlParts(url) {
  try {
    const u = new URL(url, 'https://x.invalid');
    return { host: u.host, path: u.pathname, qs: u.search };
  } catch (e) {
    return { host: '', path: url, qs: '' };
  }
}

/** Chat name when known, else a shortened id. */
function chatLabel(chatId) {
  const meta = S.chats && S.chats[chatId];
  return (meta && meta.name) || 'chat ' + shortId(chatId);
}

function currentEntry() {
  return ui.sel >= 0 && ui.sel < S.raw.length ? S.raw[ui.sel] : null;
}

/** S.raw has no bodies or headers (see ks:getState); this fetches one full entry. */
async function fullEntry(meta) {
  const r = await send('ks:getRaw', { id: meta.id });
  return (r && r.entry) || meta;
}

/* The full entry the inspector shows, fetched when the selection changes. */
let inspFull = null; // { id, entry }

/* ------------------------------------------------ refresh loop */

async function refresh() {
  const r = await KSFlow.loadState(send);
  if (r) {
    S = r;
    renderAll();
  }
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 350);
}

// The background sends ks:changed after each save. Other runtime messages
// (popup, content scripts) reach this page too: ignore them, never respond.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ks:changed') scheduleRefresh();
});

/* ------------------------------------------------ render: header */

function renderHeader() {
  const on = !!S.settings.enabled;
  $('#tglEnabled').checked = on;
  $('#liveDot').classList.toggle('off', !on);
  $('#liveLabel').textContent = on ? 'Capturing' : 'Paused';
  const p = S.patterns;
  $('#patterns').textContent = p ? 'Capture filter: ' + p.captureFilter + ' · Messages endpoint: ' + p.messagesPattern : '';
}

function renderStats() {
  const chats = new Set(S.merged.map((m) => m._chatId || ''));
  $('#stats').textContent = '';
  const items = [
    [S.raw.length, 'responses'],
    [S.merged.filter((m) => m.deleted !== true).length, 'messages'],
    [chats.size, 'chats']
  ];
  for (const [n, label] of items) {
    const s = el('span');
    s.append(el('b', null, String(n)), ' ' + label);
    $('#stats').append(s);
  }
}

/* ------------------------------------------------ render: simple view */

/** Chat rows for the list view; grouping/sorting lives in lib/exportflow.js. */
function chatSummaries() {
  const list = KSFlow.chatSummaries(S.merged, S.chats);
  return { list, chatCount: list.length, liveCount: list.reduce((n, r) => n + r.count, 0) };
}

/** Export button for a chat row; the first format of a row is the filled
 *  main action, the rest are outline buttons. */
function fmtButton(chatId, fmt, title, primary) {
  const b = el('button', primary ? 'fmt primary' : 'fmt', primary ? 'Download ' + title.label : title.label);
  b.title = title.hint;
  b.dataset.fmt = fmt;
  b.dataset.chat = chatId;
  return b;
}

const EXPORT_FORMATS = {
  docx: { label: 'Word', hint: 'Word: a storybook to read, edit or save as PDF' },
  xlsx: { label: 'Excel', hint: 'Excel spreadsheet — every message, one row each' },
  csv: { label: 'CSV', hint: 'Plain-text table of every message — opens in Excel' },
  json: { label: 'JSON', hint: 'Raw data with every field — for programmers' }
};

function progressInto(container, label, frac) {
  const bar = el('div');
  if (frac != null) bar.style.width = Math.min(100, Math.round(frac * 100)) + '%';
  const barWrap = el('div', 'pbar');
  barWrap.append(bar);
  const wrap = el('div', 'chat-progress');
  wrap.append(el('div', 'plabel', label), barWrap);
  container.append(wrap);
}

/** "340 of 1,200" (messages), or "340 loaded" while the total is unknown. */
function seenLabel(fs) {
  const seen = fs.seen || 0;
  return fs.totalCount != null ? seen.toLocaleString() + ' of ' + fs.totalCount.toLocaleString() : seen.toLocaleString() + ' loaded';
}

/** Progress 0..1 by messages when the total is known, else by pages, else null. */
function loadRatio(fs) {
  if (fs.totalCount) return Math.min(1, (fs.seen || 0) / fs.totalCount);
  return fs.pages ? (fs.page || 0) / fs.pages : null;
}

function renderSimple() {
  const listEl = $('#chatList');
  const head = chatSummaries();
  $('#simpleSummary').textContent = head.chatCount
    ? plural(head.chatCount, 'chat') + ', ' + plural(head.liveCount, 'message') + ' saved'
    : '';
  listEl.textContent = '';
  if (!head.chatCount) {
    // one span per step: the li is a flex row (number + text)
    const step = (...parts) => { const t = el('span'); t.append(...parts); const li = el('li'); li.append(t); return li; };
    const steps = el('ol');
    steps.append(
      step('Open ', el('b', null, 'isekaizero.ai'), ' or ', el('b', null, 'kagesekai.ai'),
        '. If you just installed this extension, reload that tab.'),
      step('Open a chat. It appears here by itself.'),
      step('Come back here and press ', el('b', null, 'Download Word'), '.'));
    const wrap = el('div', 'simple-empty');
    wrap.append(el('h3', null, 'No chats yet'), steps);
    if (S.settings && S.settings.enabled === false) {
      wrap.append(el('p', 'paused', 'Capture is paused. Turn it back on with the switch at the top.'));
    }
    listEl.append(wrap);
    return;
  }

  const fs = S.fetchStatus;
  const fsRunning = fs && fs.running;

  const appendRow = (chatId, titleText, titleHint, countText, metaText, formats, site) => {
    const title = el('span', 'chat-title', titleText);
    if (titleHint) title.title = titleHint;
    const titleLine = el('div', 'chat-title-line');
    titleLine.append(title);
    if (site) titleLine.append(el('span', 'chat-site', site));
    titleLine.append(el('span', 'chat-count', countText));

    const actions = el('div', 'chat-actions');
    const busy = !!simpleBusy[chatId];
    formats.forEach((fmt, i) => {
      const b = fmtButton(chatId, fmt, EXPORT_FORMATS[fmt], i === 0);
      b.disabled = busy;
      actions.append(b);
    });
    if (chatId !== 'all') {
      const rm = el('button', 'link danger remove', 'Remove');
      rm.title = 'Remove this chat from the saved list';
      rm.dataset.chat = chatId;
      actions.append(rm);
    }

    const row = el('div', chatId === 'all' ? 'chat-row all' : 'chat-row');
    row.append(titleLine, el('div', 'chat-meta', metaText), actions);

    // loading progress for this row's chat (whoever started the run)
    const rowFetch = fsRunning && fs.chatId === chatId ? fs : null;
    if (rowFetch) {
      progressInto(row, 'Loading messages — ' + seenLabel(rowFetch), loadRatio(rowFetch));
    } else if (chatId === 'all' && fsRunning && simpleBusy.all) {
      const name = (S.chats && S.chats[fs.chatId] && S.chats[fs.chatId].name) || shortId(fs.chatId);
      progressInto(row, 'Loading chats — ' + name + ', ' + seenLabel(fs), loadRatio(fs));
    }

    const err = simpleErrors[chatId];
    if (err) row.append(el('div', 'chat-error', err));
    listEl.append(row);
  };

  if (head.chatCount > 1) {
    appendRow('all', 'All chats', null,
      plural(head.liveCount, 'message'),
      'Every saved message from ' + head.chatCount + ' chats, in one file',
      ['xlsx', 'csv', 'json']);
  }
  for (const c of head.list) {
    const rel = relTime(c.updated);
    let countText, metaText;
    if (c.total && c.count < c.total) {
      countText = c.count + ' of ' + c.total + ' messages';
      metaText = 'The full chat loads when you export' + (rel ? '. Updated ' + rel : '');
    } else {
      countText = plural(c.count, 'message');
      metaText = rel ? 'Updated ' + rel : '';
    }
    appendRow(c.id, c.name || 'Untitled chat', c.name ? c.id : 'Chat ' + c.id,
      countText, metaText, ['docx', 'xlsx', 'csv', 'json'], c.site);
  }
}

/* ------------------------------------------------ render: capture list */

function renderCaptureList() {
  const list = $('#reqList');
  list.textContent = '';
  $('#capCount').textContent = plural(S.raw.length, 'capture');
  if (!S.raw.length) {
    const d = el('div', 'empty');
    d.append('No captures yet. Open ', el('code', null, 'isekaizero.ai / kagesekai.ai'),
      ' and browse — matching API responses appear here live. Make sure the site tab was reloaded after installing.');
    list.append(d);
    return;
  }
  S.raw.forEach((e, i) => {
    const { path, qs } = urlParts(e.url);
    const row = el('div', 'req' + (i === ui.sel ? ' sel' : ''));
    const l1 = el('div', 'l1');
    l1.append(
      el('span', 'm ' + (e.method || 'GET'), e.method || 'GET'),
      el('span', 'st ' + (e.status >= 200 && e.status < 400 || e.ok ? 'ok' : 'bad'), e.status || 'ERR')
    );
    if (e.isMessages) l1.append(el('span', 'badge-msg', 'messages'));
    if (e.source === 'fetch-all') l1.append(el('span', 'badge-fa', 'fetched'));
    const p = el('div', 'path', path); // rtl ellipsis keeps the tail visible
    p.append(el('span', 'qs', qs));
    row.append(l1, p, el('div', 'sub', fmtTime(e.ts) + ' · ' + fmtBytes(e.bodyLen || 0)));
    row.addEventListener('click', () => { ui.sel = i; renderCaptureList(); renderInspector(); });
    list.append(row);
  });
  if (ui.sel === -1) { ui.sel = S.raw.length - 1; }
  if (ui.sel !== lastRenderedSel) {
    const selRow = list.children[ui.sel];
    if (selRow) selRow.scrollIntoView({ block: 'nearest' });
    lastRenderedSel = ui.sel;
  }
}

/* ------------------------------------------------ render: inspector */

function leafRow(label, text, kind) {
  const v = el('span', 'v ' + kind);
  const div = el('div', 'leaf');
  div.append(el('span', 'k', label + ':'), v);
  if (kind === 'string' && text.length > 500) {
    v.textContent = text.slice(0, 500) + ' …';
    const more = el('button', 'linklike', 'show all');
    more.addEventListener('click', () => { v.textContent = text; more.remove(); });
    div.append(more);
  } else {
    v.textContent = text;
  }
  return div;
}

function branchNode(label, countText, depth, kids) {
  const d = el('details');
  d.open = depth < 2;
  const s = el('summary');
  s.append(el('span', null, label), el('span', 'cnt', countText));
  const box = el('div', 'kids');
  for (const kid of kids) box.append(kid);
  d.append(s, box);
  return d;
}

function jsonNode(value, label, depth) {
  if (value === null) return leafRow(label, 'null', 'null');
  if (Array.isArray(value)) {
    const compact = value.every((x) => x === null || typeof x !== 'object');
    if (compact && value.length <= 20) return leafRow(label, JSON.stringify(value), 'arr');
    return branchNode(label, ' [' + value.length + ']', depth,
      value.map((x, i) => jsonNode(x, String(i), depth + 1)));
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return leafRow(label, '{}', 'obj');
    return branchNode(label, ' {' + keys.length + '}', depth,
      keys.map((k) => jsonNode(value[k], k, depth + 1)));
  }
  return leafRow(label, String(value), typeof value);
}

function renderInspector() {
  const box = $('#inspBody');
  box.textContent = '';
  const meta = currentEntry();
  if (!meta) {
    const d = el('div', 'empty', 'Select a capture on the left to inspect it.');
    d.style.margin = '20px auto';
    box.append(d);
    return;
  }
  if (!inspFull || inspFull.id !== meta.id) {
    box.append(el('div', 'empty', 'Loading…'));
    fullEntry(meta).then((entry) => {
      inspFull = { id: meta.id, entry };
      const now = currentEntry();
      if (now && now.id === meta.id) renderInspector();
    });
    return;
  }
  const e = inspFull.entry;

  if (ui.insp === 'pretty') {
    const parsed = KSMerge.tryParse(e.body || '');
    if (parsed == null) box.append(el('pre', 'raw', e.body || '(empty body)'));
    else box.append(jsonNode(parsed, 'response', 0));
  } else if (ui.insp === 'raw') {
    box.append(el('pre', 'raw', e.body || '(empty body)'));
  } else {
    const kv = el('div', 'kv');
    const rows = [
      ['Time', new Date(e.ts).toLocaleString()],
      ['Method', e.method],
      ['URL', e.url],
      ['Status', (e.status || 'ERR') + (e.error ? ' — ' + e.error : '')],
      ['Content-Type', e.contentType || ''],
      ['Duration', e.durationMs != null ? e.durationMs + ' ms' : ''],
      ['Response size', fmtBytes((e.body || '').length)],
      ['Source', e.source],
      ['Is messages API', e.isMessages ? 'yes → merged' : 'no'],
      ['Chat ID', e.chatId || ''],
      ['Credentials', e.credentials || ''],
      ['Request body', e.requestBody || '(none)']
    ];
    for (const [k, v] of rows) kv.append(el('div', 'k', k), el('div', 'v', v == null ? '' : v));
    const hv = el('div', 'v', e.requestHeaders && Object.keys(e.requestHeaders).length
      ? Object.entries(e.requestHeaders).map(([k, v]) => k + ': ' + v).join('\n')
      : '(none captured)');
    hv.style.whiteSpace = 'pre';
    kv.append(el('div', 'k', 'Request headers'), hv);
    box.append(kv);
  }
}

/* ------------------------------------------------ render: merged */

function mergedFiltered() {
  return KSFlow.filteredMessages(S.merged, ui.chat, ui.role, ui.q, ui.dir);
}

function renderMerged() {
  // chat selector — labeled with names when the chat list API was captured
  const counts = new Map();
  for (const m of S.merged) {
    if (m.deleted === true) continue;
    const id = m._chatId || '(unknown)';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const names = (S.chats && typeof S.chats === 'object') ? S.chats : {};
  const sel = $('#selChat');
  const prev = ui.chat;
  sel.textContent = '';
  const optAll = el('option', null, 'all chats (' + counts.size + ')');
  optAll.value = 'all';
  sel.append(optAll);
  for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const meta = names[id];
    const o = el('option', null, ((meta && meta.name) ? meta.name : id) + ' (' + n + ')');
    o.value = id;
    o.title = (meta && meta.name) ? id + ' · ' + meta.name : id;
    sel.append(o);
  }
  ui.chat = counts.has(prev) ? prev : 'all';
  sel.value = ui.chat;
  $('#btnRemoveChat').classList.toggle('hidden', ui.chat === 'all');

  // table
  const rows = mergedFiltered();
  const tbody = $('#msgRows');
  tbody.textContent = '';
  rows.forEach((m, i) => {
    const c = KSMerge.selectedChoice(m) || {};
    const u = (Array.isArray(c.llmUsages) && c.llmUsages[0]) || null;
    const tr = el('tr');

    tr.append(el('td', 'num', String(i + 1)));

    const tdR = el('td');
    tdR.append(el('span', 'role-pill ' + (m.role || ''), m.role || '?'));
    if (m.type && m.type !== 'normal') tdR.append(el('div', 'tok', m.type));
    tr.append(tdR);

    const tdN = el('td');
    tdN.append(el('div', 'name', c.characterName || ''));
    tr.append(tdN);

    const tdC = el('td');
    tdC.append(el('div', 'created', (m.createdAt || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z')));
    tr.append(tdC);

    const tdContent = el('td', 'cell-content');
    tdContent.append(el('div', 'clamp', typeof c.content === 'string' ? c.content : ''));
    tdContent.title = 'Click to view full message';
    tdContent.tabIndex = 0;
    tdContent.addEventListener('click', () => openModal(m, i + 1));
    tdContent.addEventListener('keydown', (e) => { if (e.key === 'Enter') openModal(m, i + 1); });
    tr.append(tdContent);

    const tdM = el('td');
    tdM.append(el('div', 'model', (u && ((u.llmSnapshot && u.llmSnapshot.name) || u.model)) || ''));
    tr.append(tdM);

    const tdT = el('td');
    tdT.append(el('div', 'tok', u ? (u.promptTokens || '?') + ' → ' + (u.completionTokens || '?') : ''));
    tr.append(tdT);

    tbody.append(tr);
  });

  if (!rows.length) {
    const td = el('td', 'empty', S.merged.length
      ? 'No messages match the current filters.'
      : 'No messages yet. Open a chat on the site and its messages appear here.');
    td.colSpan = 7;
    const tr = el('tr');
    tr.append(td);
    tbody.append(tr);
  }

  let stale = 0;
  const chatsMeta = S.chats || {};
  if (ui.chat === 'all') {
    for (const id of Object.keys(chatsMeta)) stale += (chatsMeta[id] && chatsMeta[id].stale) || 0;
  } else if (chatsMeta[ui.chat]) {
    stale = chatsMeta[ui.chat].stale || 0;
  }
  $('#mergedFoot').textContent =
    rows.length + ' message' + (rows.length === 1 ? '' : 's') + ' shown · export follows these filters' +
    (stale ? ' · ⚠ ' + stale + ' deleted message(s) pending — Reload full chat to sync' : '');
  $$('.exp').forEach((b) => { b.disabled = !rows.length; });

  renderFetchStatus();
}

function renderFetchStatus() {
  const box = $('#fetchStatus');
  const fs = S.fetchStatus;
  const btn = $('#btnFetchAll');
  btn.disabled = !!(fs && fs.running) || ui.chat === 'all';
  btn.title = ui.chat === 'all' ? 'Pick one chat first' : 'Load every page of this chat from the site';
  if (!fs) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.classList.toggle('err', !!fs.error);
  box.textContent = '';
  if (fs.running) {
    const bar = el('div');
    const ratio = loadRatio(fs);
    bar.style.width = ratio != null ? Math.round(ratio * 100) + '%' : '0';
    const barWrap = el('div', 'fetch-bar');
    barWrap.append(bar);
    box.append(
      el('span', 'spin'),
      el('span', null, 'Reloading ' + chatLabel(fs.chatId) + ' · ' + seenLabel(fs) + (fs.totalCount != null ? ' messages' : '')),
      barWrap
    );
  } else if (fs.error) {
    box.textContent = 'Reload failed: ' + fs.error;
  } else if (fs.doneAt) {
    box.textContent = 'Reloaded ' + chatLabel(fs.chatId) + ' · ' + (fs.page || 0) + ' page(s)' +
      ' · ' + (fs.mergedTotal || 0) + ' messages' +
      (fs.reconciled ? ' · removed ' + fs.reconciled + ' deleted message(s)' : '') +
      ' · done at ' + new Date(fs.doneAt).toLocaleTimeString();
  }
}

/* ------------------------------------------------ modal */

let modalReturnFocus = null;
function openModal(m, index) {
  const c = KSMerge.selectedChoice(m) || {};
  const bits = [
    '#' + index,
    m.role || '?',
    c.characterName || '',
    m.createdAt || '',
    'chat ' + shortId(m._chatId)
  ].filter(Boolean);
  $('#modalMeta').textContent = bits.join(' · ');
  $('#modalContent').textContent = typeof c.content === 'string' ? c.content : '(no content)';
  modalReturnFocus = document.activeElement;
  $('#modal').classList.remove('hidden');
  $('#btnCloseModal').focus();
}

function closeModal() {
  if ($('#modal').classList.contains('hidden')) return;
  $('#modal').classList.add('hidden');
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

/* ------------------------------------------------ export */

/** Download `msgs` (already filtered + ordered) as `fmt`. `opts.fileBase`
 *  names the file (DOCX may use `opts.docxBase`); `opts.jsonExtra` is merged
 *  into the JSON envelope. Returns { count, result }: the message count (0 when empty) and the
 *  download result ('ok', 'cancelled' or 'failed'). */
async function downloadMerged(msgs, fmt, opts) {
  if (!msgs.length) return { count: 0, result: 'ok' };
  let result;
  const o = opts || {};
  const stamp = KSExport.timestamp();
  const base = o.fileBase || 'chat-messages';
  // block numbers come from the whole store, not from `msgs`: a filter must not move them
  const blocks = KSFlow.blockNumbers(S.merged);
  if (fmt === 'docx') {
    // Storybook: title block per chat, persona names, scene headers, no OOC.
    result = await KSExport.download((o.docxBase || base) + '-' + stamp + '.docx', KSExport.DOCX_MIME, KSExport.buildDOCX(KSFlow.storyBlocks(msgs, S.chats)));
  } else if (fmt === 'json') {
    const rows = msgs.map((m, i) => KSMerge.messageToRow(m, i + 1, blocks.get(m._id)));
    result = await KSExport.download(base + '-' + stamp + '.json', 'application/json',
      JSON.stringify({ exportedAt: new Date().toISOString(), messageCount: rows.length, ...(o.jsonExtra || {}), messages: rows }, null, 2));
  } else {
    const cols = KSMerge.MERGED_COLUMNS;
    const headers = cols.map(([, h]) => h);
    const grid = msgs.map((m, i) => {
      const row = KSMerge.messageToRow(m, i + 1, blocks.get(m._id));
      return cols.map(([k]) => row[k]); // rows aligned to cols
    });
    if (fmt === 'csv') {
      result = await KSExport.download(base + '-' + stamp + '.csv', 'text/csv',
        KSExport.toCSV(headers, grid));
    } else {
      result = await KSExport.download(base + '-' + stamp + '.xlsx', KSExport.XLSX_MIME,
        KSExport.buildXLSX([{ name: 'Messages', headers, rows: grid, autoFilter: true }]));
    }
  }
  return { count: msgs.length, result };
}

/** The raw-response export fields, defined once: [jsonKey, header]. CSV/XLSX
 *  take the values in order; the JSON export zips the keys over them (with the
 *  body parsed when it is JSON). */
const RAW_FIELDS = [
  ['time', 'Time'], ['method', 'Method'], ['url', 'URL'], ['status', 'Status'],
  ['source', 'Source'], ['isMessages', 'Is Messages API'], ['chatId', 'Chat ID'],
  ['contentType', 'Content Type'], ['requestBody', 'Request Body'], ['body', 'Response Body']
];

const rawRow = (e) => [
  new Date(e.ts).toISOString(), e.method, e.url, e.status, e.source || 'live',
  e.isMessages ? 'yes' : 'no', e.chatId || '', e.contentType || '',
  e.requestBody || '', e.body || ''
];

function rawExportData(entries) {
  return entries.map((e) => {
    const vals = rawRow(e);
    const o = {};
    RAW_FIELDS.forEach(([k], i) => { o[k] = vals[i]; });
    const parsed = KSMerge.tryParse(e.body || '');
    o.body = parsed != null ? parsed : (e.body || '');
    return o;
  });
}

/** The toast after a download: nothing when the user cancelled the Save dialog. */
function saveToast(result, okText) {
  if (result === 'ok') toast(okText);
  else if (result === 'failed') toast('The download did not start. Try again.');
}

/** Messages tab: export the table's current filtered view. */
async function exportFiltered(fmt) {
  if (!mergedFiltered().length) { toast('Nothing to export — no messages match.'); return; }
  // Same as the "Your chats" buttons: load the whole chat first, so the file
  // is complete and holds no message deleted on the site.
  toast('Checking the chat before export…');
  const res = await flow.ensureComplete(ui.chat || 'all');
  if (!res.ok) { toast(res.error); return; }
  if (res.warning) toast(res.warning);
  await refresh();
  const msgs = mergedFiltered(); // again: the reload may have changed the messages
  if (!msgs.length) { toast('Nothing to export — no messages match.'); return; }
  const { count, result } = await downloadMerged(msgs, fmt, { fileBase: 'chat-messages', docxBase: 'chat-transcript', jsonExtra: { chatFilter: ui.chat } });
  saveToast(result, 'Exported ' + count + ' messages');
}

/** Developer tab: export the raw captured responses (no DOCX). */
async function exportCaptures(fmt) {
  const stamp = KSExport.timestamp();
  if (!S.raw.length) { toast('Nothing to export — no responses captured yet.'); return; }
  // one entry per message: all bodies in one reply could pass the 64 MB limit
  const entries = [];
  for (const meta of S.raw) entries.push(await fullEntry(meta));
  const headers = RAW_FIELDS.map(([, h]) => h);
  let result;
  if (fmt === 'json') {
    result = await KSExport.download('api-responses-' + stamp + '.json', 'application/json',
      JSON.stringify({ exportedAt: new Date().toISOString(), responseCount: entries.length, responses: rawExportData(entries) }, null, 2));
  } else {
    const rows = entries.map(rawRow);
    if (fmt === 'csv') {
      result = await KSExport.download('api-responses-' + stamp + '.csv', 'text/csv', KSExport.toCSV(headers, rows));
    } else {
      result = await KSExport.download('api-responses-' + stamp + '.xlsx', KSExport.XLSX_MIME,
        KSExport.buildXLSX([{ name: 'Responses', headers, rows }]));
    }
  }
  saveToast(result, 'Exported ' + entries.length + ' responses');
}

/* ------------------------------------------------ simple view: export */

/** The load-before-export loop lives in lib/exportflow.js; this instance pulls
 *  fresh state through the same 'ks:getState' channel the rest of the panel
 *  uses. */
const flow = KSFlow.createFlow({
  getState: async () => { await refresh(); return S; },
  getFetchStatus: async () => { const r = await send('ks:getFetchStatus'); return r ? r.fetchStatus : S.fetchStatus; },
  send
});

const FORMAT_NOUN = { docx: 'a Word document', xlsx: 'an Excel spreadsheet', csv: 'a CSV file', json: 'a JSON file' };

/** Simple-view export: make sure the whole chat is loaded, then download it. */
async function exportFromList(chatId, fmt) {
  if (simpleBusy[chatId]) return;
  delete simpleErrors[chatId];
  simpleBusy[chatId] = true;
  renderSimple();
  try {
    const needsLoad = chatId === 'all'
      ? chatSummaries().list.some((c) => KSFlow.chatIsIncomplete(S.chats, S.merged, c.id))
      : KSFlow.chatIsIncomplete(S.chats, S.merged, chatId);
    if (needsLoad) toast(chatId === 'all' ? 'Loading chats before export…' : 'Loading the full chat before export…');

    const res = await flow.ensureComplete(chatId);
    if (!res.ok) { simpleErrors[chatId] = res.error; renderSimple(); return; }
    if (res.warning) toast(res.warning);

    await refresh();
    const msgs = KSFlow.messagesFor(S.merged, chatId);
    if (!msgs.length) { toast('Nothing saved for this chat yet.'); return; }
    const meta = (S.chats && S.chats[chatId]) || {};
    const name = chatId === 'all' ? 'all-chats' : (meta.name || String(chatId).slice(0, 12));
    const jsonExtra = chatId === 'all'
      ? { chatCount: new Set(msgs.map((m) => m._chatId)).size }
      : { chat: { id: chatId, name: meta.name || '' } };
    const { count, result } = await downloadMerged(msgs, fmt, { fileBase: safeFileBase(name), jsonExtra });
    saveToast(result, 'Saved as ' + FORMAT_NOUN[fmt] + ' — ' + plural(count, 'message'));
  } finally {
    delete simpleBusy[chatId];
    renderSimple();
  }
}

/** Confirm, then remove one chat. The reply ({} when none came), or null
 *  when cancelled or refused. */
async function removeChat(chatId, label) {
  const n = S.merged.filter((m) => (m._chatId || '') === chatId).length;
  if (!window.confirm('Remove “' + label + '” (' + n + ' messages) from the saved list?')) return null;
  const r = await send('ks:removeChat', { chatId });
  if (r && r.error) { toast(r.error); return null; }
  return r || {};
}

async function removeChatFromList(chatId) {
  const label = (S.chats && S.chats[chatId] && S.chats[chatId].name) || chatId;
  if (!(await removeChat(chatId, label))) return;
  await refresh();
  toast('Removed');
}

/* ------------------------------------------------ wiring */

/** Draw the header and the visible view only; hidden views are drawn when shown. */
function renderAll() {
  renderHeader();
  renderStats();
  if (ui.view === 'simple') renderSimple();
  else if (ui.tab === 'merged') renderMerged();
  else { renderCaptureList(); renderInspector(); }
}

/** Mark the one active button in a switch group (class + aria-pressed). */
function setPressed(buttons, isActive) {
  buttons.forEach((b) => {
    const on = isActive(b);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function applyView(view) {
  ui.view = view;
  $('#view-simple').classList.toggle('hidden', view !== 'simple');
  $('#view-advanced').classList.toggle('hidden', view !== 'advanced');
  setPressed($$('.viewnav button'), (b) => b.dataset.view === view);
  try { localStorage.setItem('ks_view', view); } catch (e) { /* private mode etc. */ }
  renderAll();
}

function applyTab(tab) {
  ui.tab = tab;
  setPressed($$('.tabs button'), (b) => b.dataset.tab === tab);
  $('#view-captures').classList.toggle('hidden', tab !== 'captures');
  $('#view-merged').classList.toggle('hidden', tab !== 'merged');
  renderAll();
}

function wire() {
  $$('.viewnav button').forEach((b) => b.addEventListener('click', () => applyView(b.dataset.view)));
  try {
    applyView(localStorage.getItem('ks_view') === 'advanced' ? 'advanced' : 'simple');
  } catch (e) { applyView('simple'); }

  $('#chatList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.chat) return;
    if (btn.classList.contains('remove')) removeChatFromList(btn.dataset.chat);
    else if (btn.dataset.fmt) exportFromList(btn.dataset.chat, btn.dataset.fmt);
  });

  $('#tglEnabled').addEventListener('change', async (e) => {
    await send('ks:settings', { settings: { enabled: e.target.checked } });
    refresh();
  });


  $('#btnClearRaw').addEventListener('click', async () => {
    await send('ks:clear', { scope: 'raw' });
    ui.sel = -1;
    refresh();
  });
  $('#btnClearAll').addEventListener('click', async () => {
    if (!window.confirm('Delete every saved chat and capture? This cannot be undone.')) return;
    await send('ks:clear', { scope: 'all' });
    ui.sel = -1;
    refresh();
  });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => applyTab(b.dataset.tab)));
  applyTab(ui.tab);

  $$('.insp-tabs button[data-i]').forEach((b) => b.addEventListener('click', () => {
    ui.insp = b.dataset.i;
    setPressed($$('.insp-tabs button[data-i]'), (x) => x === b);
    renderInspector();
  }));

  $('#btnCopyBody').addEventListener('click', () => {
    const e = currentEntry();
    if (!e || !inspFull || inspFull.id !== e.id) return;
    navigator.clipboard.writeText(inspFull.entry.body || '').then(() => toast('Body copied'), () => toast('Copy failed'));
  });

  $('#selChat').addEventListener('change', (e) => { ui.chat = e.target.value; renderMerged(); });
  $('#selRole').addEventListener('change', (e) => { ui.role = e.target.value; renderMerged(); });
  $('#selDir').addEventListener('change', (e) => { ui.dir = e.target.value; renderMerged(); });
  let qTimer = 0;
  $('#inSearch').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { ui.q = e.target.value.trim(); renderMerged(); }, 200);
  });

  $('#btnFetchAll').addEventListener('click', async () => {
    if (ui.chat === 'all') { toast('Pick one chat first'); return; }
    const r = await send('ks:fetchAll', { chatId: ui.chat });
    if (r && r.error) toast(r.error);
    else toast('Reloading the full chat…');
    scheduleRefresh();
  });

  $('#btnRemoveChat').addEventListener('click', async () => {
    if (ui.chat === 'all') { toast('Pick one chat first'); return; }
    const r = await removeChat(ui.chat, chatLabel(ui.chat));
    if (!r) return;
    ui.chat = 'all';
    await refresh();
    toast(typeof r.removed === 'number' ? r.removed + ' message(s) removed' : 'Chat removed');
  });

  $$('.exp').forEach((b) => b.addEventListener('click', () => exportFiltered(b.dataset.fmt)));
  $$('.cap-exp').forEach((b) => b.addEventListener('click', () => exportCaptures(b.dataset.fmt)));

  $('#btnCloseModal').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('#btnCopyModal').addEventListener('click', () => {
    navigator.clipboard.writeText($('#modalContent').textContent || '').then(() => toast('Content copied'), () => toast('Copy failed'));
  });
}

wire();
refresh();
