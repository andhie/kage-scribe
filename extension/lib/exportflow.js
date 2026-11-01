/*
 * Kage Scribe — export flow (shared: panel page + Node tests).
 * Decides what goes into an export (chat/role/search/order scope), whether a
 * chat is fully loaded yet, and drives the "load the whole chat before
 * export" wait/retry loop against the background's fetch-all replay.
 * Loaded after lib/merge.js (uses KSMerge); attaches plain helpers as KSFlow
 * so it works in the panel page and in Node require() for tests.
 */
(function (g) {
  'use strict';

  const FETCH_WAIT_MS = 15 * 60 * 1000;
  const BLOCK_SIZE = 20;
  const SCENE_HEADER_RE = /^\s*<\s*t\s*>([\s\S]*?)<\s*\/\s*t\s*>\s*/i;
  const DEFAULT_PERSONA = 'You';
  const UNTITLED_CHAT = 'Untitled chat';
  const RELOAD_WARNING = 'Could not reload this chat; deleted messages may still be in the file.';

  /** Live (non-deleted) messages grouped per chat, newest activity first. */
  function chatSummaries(merged, chatsMeta) {
    const list = [];
    const byChat = new Map();
    for (const m of merged) {
      if (m.deleted === true) continue;
      const id = m._chatId || '(unknown)';
      let rec = byChat.get(id);
      if (!rec) { rec = { id, count: 0, updated: '' }; byChat.set(id, rec); list.push(rec); }
      rec.count++;
      const ca = String(m.createdAt || '');
      if (ca > rec.updated) rec.updated = ca;
    }
    const metas = (chatsMeta && typeof chatsMeta === 'object') ? chatsMeta : {};
    for (const r of list) {
      const meta = metas[r.id] || {};
      r.name = meta.name || '';
      r.site = meta.site || '';
      r.total = typeof meta.totalCount === 'number' ? meta.totalCount : null;
    }
    list.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : b.count - a.count));
    return list;
  }

  /** A chat is incomplete when the server's message total is known and differs
   *  from what we merged: above it (history lazy-loads ~10 messages at a time)
   *  or below it (a deleted message is still saved). */
  function chatIsIncomplete(chatsMeta, merged, chatId) {
    const meta = (chatsMeta && chatsMeta[chatId]) || {};
    if (typeof meta.totalCount !== 'number') return false;
    let live = 0;
    for (const m of merged) {
      if (m.deleted !== true && (m._chatId || '') === chatId) live++;
    }
    return live !== meta.totalCount;
  }

  /** Export scope over the merged store: chat / role / content search / order.
   *  The advanced table's filters and every export path share this one filter. */
  function filteredMessages(merged, chatId, role, q, dir) {
    let list = merged.filter((m) => m.deleted !== true); // deleted-flagged stay hidden
    if (chatId && chatId !== 'all') list = list.filter((m) => (m._chatId || '') === chatId);
    if (role && role !== 'all') list = list.filter((m) => m.role === role);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((m) => {
        const c = KSMerge.selectedChoice(m) || {};
        return ((c.content || '') + ' ' + (c.characterName || '')).toLowerCase().includes(needle);
      });
    }
    return KSMerge.sortMessages(list, dir || 'asc');
  }

  /** Every live message of one chat (or of all chats), oldest first. */
  function messagesFor(merged, chatId) {
    return filteredMessages(merged, chatId, 'all', '', 'asc');
  }

  /**
   * Block number of each message: per chat, live messages oldest first, OOC
   * skipped, 20 per block. Call it on the WHOLE store, before any filter, so a
   * role/search/order change never moves a number. OOC messages get no entry.
   * Map<message _id, number>
   */
  function blockNumbers(merged) {
    const seen = new Map(); // chat id -> non-OOC messages numbered so far
    const out = new Map();
    for (const m of KSMerge.sortMessages(merged.filter((x) => x.deleted !== true), 'asc')) {
      if (m.type === 'ooc') continue;
      const key = m._chatId || '';
      const i = seen.get(key) || 0;
      seen.set(key, i + 1);
      out.set(m._id, Math.floor(i / BLOCK_SIZE) + 1);
    }
    return out;
  }

  /**
   * What the storybook Word export shows, per chat, oldest first. OOC messages
   * are left out. A user message carries the persona name of its own choice
   * ("You" when empty); an AI message has no name (one reply often speaks for
   * several characters). A leading scene header is split off as `header`
   * (inner text, trimmed); text that does not match stays whole in `text`.
   * Chats keep the order in which they first appear.
   */
  function storyBlocks(msgs, chatsMeta) {
    const metas = (chatsMeta && typeof chatsMeta === 'object') ? chatsMeta : {};
    const byChat = new Map();
    for (const m of KSMerge.sortMessages(msgs, 'asc')) {
      if (m.type === 'ooc') continue;
      const c = KSMerge.selectedChoice(m) || {};
      let text = typeof c.content === 'string' ? c.content : '';
      let header = null;
      const h = SCENE_HEADER_RE.exec(text);
      if (h) { header = h[1].trim(); text = text.slice(h[0].length); }
      if (header === null && !text.trim()) continue; // nothing to show
      const id = m._chatId || '(unknown)';
      let chat = byChat.get(id);
      if (!chat) {
        const meta = metas[id] || {};
        chat = { title: meta.name || UNTITLED_CHAT, site: meta.site || '', plotSummary: meta.plotSummary || '', count: 0, items: [] };
        byChat.set(id, chat);
      }
      const isUser = m.role === 'user';
      chat.items.push({ isUser, name: isUser ? (c.characterName || DEFAULT_PERSONA) : null, header, text });
      chat.count++;
    }
    return { chats: [...byChat.values()] };
  }

  /** Translate a fetch-all failure into something a non-technical user can act on. */
  function friendlyFetchError(err, site) {
    const s = String(err || '');
    const tab = (site ? site + ' ' : 'site ') + 'tab';
    if (/401|403|auth/i.test(s)) return 'The site logged this session out. Refresh the ' + tab + ', open the chat once, then try again.';
    if (/No captured messages request/i.test(s)) return 'This chat hasn’t been opened on the site yet. Open it once, then try again.';
    if (/already in progress/i.test(s)) return 'Another chat was still loading. Try again in a moment.';
    return 'The site didn’t respond. Refresh the ' + tab + ', then try again.';
  }

  /**
   * The load-before-export wait loop. Hooks:
   *  - getState: async () => fresh {merged, chats, fetchStatus} (pulls from the SW)
   *  - send: (type, extra) => Promise of the SW's response
   *  - getFetchStatus: optional async () => fetchStatus alone, for the poll
   *    (default: getState().fetchStatus)
   *  - waitMs / pollMs: run timeout and poll interval (defaults 15 min / 400 ms)
   * Only one replay runs in the background at a time, so ensureComplete waits
   * out whatever is in flight, starts its own run, and retries once if another
   * run squeezed in between the wait and the start.
   */
  function createFlow(hooks) {
    const getState = hooks.getState;
    const send = hooks.send;
    const getFetchStatus = hooks.getFetchStatus || (async () => (await getState()).fetchStatus);
    const waitMs = hooks.waitMs || FETCH_WAIT_MS;
    const pollMs = hooks.pollMs != null ? hooks.pollMs : 400;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shortId = (id) => (id ? String(id).slice(0, 10) + '…' : '');

    /** Poll the fetch status until pred(fetchStatus) holds; false on timeout. */
    async function pollUntil(pred, timeoutMs) {
      const t0 = Date.now();
      for (;;) {
        if (pred(await getFetchStatus())) return true;
        if (Date.now() - t0 > timeoutMs) return false;
        await sleep(pollMs);
      }
    }

    // A reload that cannot finish only matters when the file would be incomplete
    // (live below totalCount). With live above totalCount the saved copy is
    // complete but may still hold messages deleted on the site: warn, go on.
    async function failure(chatId, error) {
      const st = await getState();
      const c = chatSummaries(st.merged, st.chats).find((x) => x.id === chatId);
      if (c && c.total != null && c.count > c.total) return { ok: true, warning: RELOAD_WARNING };
      return { ok: false, error };
    }

    async function ensureOneComplete(chatId) {
      const isComplete = async () => {
        const st = await getState();
        return !chatIsIncomplete(st.chats, st.merged, chatId);
      };
      const waitIdle = () => pollUntil((fs) => !fs || !fs.running, waitMs);
      const timeoutMsg = 'Loading took too long and was stopped — try again, progress is kept.';
      const siteOfChat = async () => { const st = await getState(); return (st.chats[chatId] || {}).site; };

      if (await isComplete()) return { ok: true };
      if (!(await waitIdle())) return failure(chatId, timeoutMsg);
      if (await isComplete()) return { ok: true }; // that run may have covered it

      const startedAt = Date.now();
      let r = await send('ks:fetchAll', { chatId, pageSize: 100 });
      if (r && r.error && /already in progress/i.test(r.error)) {
        // another run squeezed in between our wait and our start — wait and retry once
        if (!(await waitIdle())) return failure(chatId, timeoutMsg);
        if (await isComplete()) return { ok: true };
        r = await send('ks:fetchAll', { chatId, pageSize: 100 });
      }
      if (r && r.error) return failure(chatId, friendlyFetchError(r.error, await siteOfChat()));

      const done = await pollUntil(
        (fs) => fs && fs.chatId === chatId && !fs.running && fs.doneAt && fs.doneAt >= startedAt - 1500,
        waitMs);
      const st = await getState();
      if (!done) return failure(chatId, timeoutMsg);
      if (st.fetchStatus && st.fetchStatus.chatId === chatId && st.fetchStatus.error) {
        return failure(chatId, friendlyFetchError(st.fetchStatus.error, (st.chats[chatId] || {}).site));
      }
      return { ok: true };
    }

    async function ensureComplete(chatId) {
      if (chatId !== 'all') return ensureOneComplete(chatId);
      const snapshot = await getState();
      const warned = [];
      for (const c of chatSummaries(snapshot.merged, snapshot.chats)) {
        const st = await getState();
        if (!chatIsIncomplete(st.chats, st.merged, c.id)) continue;
        const r = await ensureOneComplete(c.id);
        if (!r.ok) return { ok: false, error: '“' + (c.name || shortId(c.id)) + '” — ' + r.error };
        if (r.warning) warned.push(c.name || shortId(c.id));
      }
      return warned.length ? { ok: true, warning: RELOAD_WARNING + ' (' + warned.join(', ') + ')' } : { ok: true };
    }

    return { ensureComplete, ensureOneComplete, pollUntil };
  }

  /**
   * The full state with every slim message, or null. Chrome caps one runtime
   * message at 64 MB, so ks:getState sends only mergedCount/mergedRev and the
   * messages come in pages (ks:getMerged). A save between pages makes the SW
   * answer `stale`; then the read starts again, a few times at most.
   */
  async function loadState(send) {
    for (let tries = 0; tries < 5; tries++) {
      const st = await send('ks:getState');
      if (!st || st.error) return null;
      st.merged = [];
      while (st.merged.length < st.mergedCount) {
        const p = await send('ks:getMerged', { rev: st.mergedRev, offset: st.merged.length });
        if (!p || p.error) return null;
        if (p.stale || !p.items.length) break;
        for (const m of p.items) st.merged.push(m);
      }
      if (st.merged.length === st.mergedCount) return st;
    }
    return null;
  }

  g.KSFlow = {
    FETCH_WAIT_MS,
    loadState,
    chatSummaries,
    chatIsIncomplete,
    filteredMessages,
    messagesFor,
    friendlyFetchError,
    storyBlocks,
    blockNumbers,
    BLOCK_SIZE,
    createFlow
  };
})(typeof self !== 'undefined' ? self : globalThis);
