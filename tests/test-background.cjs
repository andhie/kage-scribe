/* Test: background service worker — state handling, capture+merge pipeline,
 * dedup, settings validation, persistence, eviction caps, fetch-all replay
 * (happy path, auth failure, concurrency guard), chat-name sniffing (list,
 * detail `history.name`, fetch-all backfill) and lifecycle events.
 * background.js is loaded against a fake `chrome` and a fake `fetch`. */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

require('../extension/lib/merge.js');
require('../extension/lib/exportflow.js'); // KSFlow.loadState: the panel's paged state read

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8'));
const sampleBody = JSON.stringify(sample);
const CHAT_ID = '6adf35d941b1d32e4ee75f98';
const CHAT_URL = `https://api.kagesekai.ai/api/chats/${CHAT_ID}/messages?page=1&pageSize=10`;

function makeChrome(initialStorage) {
  const chrome = {
    __actionLog: [],
    __tabsCreated: [],
    __setLog: [],       // keys written to storage.local (flush-guard assertions)
    __runtimeSent: [],  // chrome.runtime.sendMessage from the SW (ks:changed)
    __tabSent: [],      // chrome.tabs.sendMessage [tabId, msg]
    __onMessage: null,
    __onInstalled: null,
    __onStartup: null,
    storage: {
      local: {
        _data: JSON.parse(JSON.stringify(initialStorage || {})),
        async get(keys) {
          if (keys == null) return JSON.parse(JSON.stringify(this._data));
          const out = {};
          const pick = (k, d) => { out[k] = (k in this._data) ? this._data[k] : d; };
          if (typeof keys === 'string') pick(keys);
          else if (Array.isArray(keys)) keys.forEach((k) => pick(k));
          else Object.entries(keys).forEach(([k, d]) => pick(k, d));
          return out;
        },
        async set(obj) {
          chrome.__setLog.push(Object.keys(obj));
          Object.assign(this._data, JSON.parse(JSON.stringify(obj)));
        }
      },
      onChanged: { addListener() { /* not used by SW */ } }
    },
    runtime: {
      onMessage: { addListener(fn) { chrome.__onMessage = fn; } },
      onInstalled: { addListener(fn) { chrome.__onInstalled = fn; } },
      onStartup: { addListener(fn) { chrome.__onStartup = fn; } },
      getURL(p) { return 'chrome-extension://test/' + p; },
      getManifest() { return { content_scripts: [{ matches: ['https://*.kagesekai.ai/*'] }] }; },
      sendMessage(msg) { chrome.__runtimeSent.push(msg); return Promise.resolve(); }
    },
    action: {
      setBadgeText(o) { chrome.__actionLog.push(['text', o && o.text]); },
      setBadgeBackgroundColor() {}
    },
    tabs: {
      create(o) { chrome.__tabsCreated.push(o); },
      async query(q) { return q && q.url ? [{ id: 7 }] : []; },
      sendMessage(id, msg) { chrome.__tabSent.push([id, msg]); return Promise.resolve(); }
    }
  };
  return chrome;
}

function loadBackground({ storage, fetchImpl } = {}) {
  globalThis.chrome = makeChrome(storage);
  globalThis.fetch = fetchImpl || (async () => { throw new Error('unexpected fetch call'); });
  globalThis.importScripts = (p) => require(path.resolve(__dirname, '..', 'extension', p));
  const bgPath = require.resolve('../extension/background.js');
  delete require.cache[bgPath];
  require(bgPath); // registers listeners on the fresh chrome shim
  const ref = globalThis.chrome;
  return {
    chrome: ref,
    state() { return globalThis.KSFlow.loadState((type, extra) => this.send({ type, ...(extra || {}) })); },
    // sender {} is an extension page; replies are JSON-copied, as Chrome does
    send(msg, sender) {
      return new Promise((resolve) => {
        let done = false;
        ref.__onMessage(msg, sender || {}, (resp) => { done = true; resolve(resp === undefined ? resp : JSON.parse(JSON.stringify(resp))); });
        setTimeout(() => { if (!done) resolve(undefined); }, 100);
      });
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout: ' + what);
    await sleep(20);
  }
}

const capture = (url, body, extra) => ({
  method: 'GET', url, status: 200, ok: true,
  contentType: 'application/json', requestBody: '', body,
  requestHeaders: {}, source: 'live', ...(extra || {})
});

(async () => {
  /* ---- 1. fresh state defaults */
  {
    const bg = loadBackground();
    const st = await bg.state();
    assert.deepStrictEqual(st.settings, { enabled: true });
    assert.deepStrictEqual(st.patterns, { captureFilter: '/api/', messagesPattern: '/api/chats/.*/messages' });
    assert.deepStrictEqual(st.raw, []);
    assert.deepStrictEqual(st.merged, []);
  }

  /* ---- 2. capture → merge from the real sample */
  {
    const bg = loadBackground();
    const r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { authorization: 'Bearer tok' } }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.newMessages, 10);
    const st = await bg.state();
    assert.strictEqual(st.raw.length, 1);
    assert.strictEqual(st.raw[0].isMessages, true);
    assert.strictEqual(st.raw[0].chatId, CHAT_ID, 'chatId parsed from URL');
    assert.strictEqual(st.merged.length, 10);
    // the state reply stays small: no raw bodies/headers, slim messages
    assert.strictEqual(st.raw[0].body, undefined, 'no body in getState');
    assert.strictEqual(st.raw[0].requestHeaders, undefined, 'no headers in getState');
    assert.strictEqual(st.raw[0].bodyLen, sampleBody.length);
    assert.ok(JSON.stringify(st.merged).length < sampleBody.length / 2, 'messages sent slim');
    const full = await bg.send({ type: 'ks:getRaw', id: st.raw[0].id });
    assert.strictEqual(full.entry.body, sampleBody, 'ks:getRaw returns the full body');
    assert.strictEqual(full.entry.requestHeaders.authorization, 'Bearer tok');
    assert.strictEqual((await bg.send({ type: 'ks:getRaw', id: 'nope' })).entry, null);
    assert.ok(bg.chrome.__actionLog.some(([, t]) => t === '1'), 'badge shows count');

    // non-messages URL: recorded, not merged
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/users/me', '{"data":{"name":"u"}}') });
    const st2 = await bg.state();
    assert.strictEqual(st2.raw.length, 2);
    assert.strictEqual(st2.raw[1].isMessages, false);
    assert.strictEqual(st2.merged.length, 10);

    // send / delete / regenerate on the messages path: recorded, not messages
    const base = `https://api.kagesekai.ai/api/chats/${CHAT_ID}/messages`;
    await bg.send({ type: 'ks:capture', entry: capture(base, '{"data":{"_id":"x"}}', { method: 'POST' }) });
    await bg.send({ type: 'ks:capture', entry: capture(`${base}/m1`, '{"success":true}', { method: 'DELETE' }) });
    await bg.send({ type: 'ks:capture', entry: capture(`${base}/m1/regenerate?x=1`, '{"data":{}}') });
    await bg.send({ type: 'ks:capture', entry: capture(`${base}/?page=2`, sampleBody) });
    const st3 = await bg.state();
    assert.deepStrictEqual(st3.raw.slice(2).map((e) => e.isMessages), [false, false, false, true]);
    assert.strictEqual(st3.merged.length, 10);
  }

  /* ---- 2b. fetch-all ignores old entries that flagged a DELETE as messages */
  {
    const bg = loadBackground({ storage: { ks_raw: [{
      id: 'r1', method: 'DELETE', url: `https://api.kagesekai.ai/api/chats/${CHAT_ID}/messages/m1`,
      isMessages: true, chatId: CHAT_ID, requestHeaders: { authorization: 'Bearer tok' }, source: 'live', ts: 1
    }] } });
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.error && /No captured messages request/.test(r.error), 'DELETE entry is not a replay base');
  }

  /* ---- 3. dedup across pages + last-seen-wins on edits */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    const again = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=2'), sampleBody) });
    assert.strictEqual(again.newMessages, 0, 're-capture adds nothing');
    let st = await bg.state();
    assert.strictEqual(st.merged.length, 10);

    const edited = JSON.parse(sampleBody);
    edited.data.data[0].choices[0].content = 'EDITED CONTENT';
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(edited)) });
    st = await bg.state();
    assert.strictEqual(st.merged.length, 10, 'same message id, no duplicate');
    const m = st.merged.find((x) => x._id === edited.data.data[0]._id);
    assert.strictEqual(m.choices[0].content, 'EDITED CONTENT', 'latest version kept');
  }

  /* ---- 4. settings validation + badge cleared when disabled */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    // removed settings are ignored; only `enabled` is accepted
    let r = await bg.send({ type: 'ks:settings', settings: { captureFilter: '/messages', messagesPattern: 'x', autoSync: false } });
    assert.deepStrictEqual(r.settings, { enabled: true });
    r = await bg.send({ type: 'ks:settings', settings: { captureFilter: '/messages', enabled: false } });
    assert.deepStrictEqual(r.settings, { enabled: false });
    assert.deepStrictEqual(bg.chrome.__tabSent[bg.chrome.__tabSent.length - 1],
      [7, { type: 'ks:pushSettings', settings: r.settings }], 'new settings pushed to site tabs');
    const texts = bg.chrome.__actionLog.filter(([k]) => k === 'text').map(([, t]) => t);
    assert.strictEqual(texts[texts.length - 1], '', 'badge cleared when disabled');
    assert.deepStrictEqual(
      bg.chrome.storage.local._data.ks_settings,
      { enabled: false },
      'settings persisted'
    );

    // Word storybook colors: known keys only, '' or RRGGBB, uppercased, junk dropped
    // (before the `old` load below: a second loadBackground swaps the global
    //  chrome shim, and this background's writes would land in that storage)
    r = await bg.send({
      type: 'ks:settings',
      settings: { enabled: true, docxColors: { narration: '2a2638', dialogue: '', thoughts: 'oops', bold: 7, scene: '#B4562B', persona: 'B4562B', background: 'F7F5FA', rouge: 'AABBCC' } }
    });
    assert.deepStrictEqual(r.settings.docxColors,
      { narration: '2A2638', dialogue: '', persona: 'B4562B', background: 'F7F5FA' }, 'docxColors cleaned');
    assert.deepStrictEqual(bg.chrome.storage.local._data.ks_settings.docxColors,
      { narration: '2A2638', dialogue: '', persona: 'B4562B', background: 'F7F5FA' }, 'docxColors persisted');

    // a store saved by an older version loads as {enabled} and onInstalled writes it back clean
    const old = loadBackground({ storage: { ks_settings: { enabled: false, captureFilter: '/x/', messagesPattern: 'y', autoSync: true } } });
    assert.deepStrictEqual((await old.state()).settings, { enabled: false });
    await old.chrome.__onInstalled({ reason: 'update' });
    assert.deepStrictEqual(old.chrome.storage.local._data.ks_settings, { enabled: false }, 'old keys leave storage on update');
    // a tampered docxColors store is cleaned on load
    const tampered = loadBackground({ storage: { ks_settings: { enabled: true, docxColors: { scene: '6d5ba6', background: '', evil: 'FF0000' } } } });
    assert.deepStrictEqual((await tampered.state()).settings, { enabled: true, docxColors: { scene: '6D5BA6', background: '' } });
  }

  /* ---- 5. persistence across service-worker restarts */
  {
    const bg1 = loadBackground();
    await bg1.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    await bg1.state(); // forces flush
    const bg2 = loadBackground({ storage: bg1.chrome.storage.local._data });
    const st = await bg2.state();
    assert.strictEqual(st.raw.length, 1);
    assert.strictEqual(st.merged.length, 10, 'merged store survives SW restart');
  }

  /* ---- 6. clear scopes */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/x', '{}') });
    await bg.send({ type: 'ks:clear', scope: 'raw' });
    let st = await bg.state();
    assert.strictEqual(st.raw.length, 0);
    assert.strictEqual(st.merged.length, 10, 'merged untouched by raw clear');
    assert.ok(st.chats[CHAT_ID], 'chat meta present before the full clear');
    await bg.send({ type: 'ks:clear', scope: 'all' });
    st = await bg.state();
    assert.strictEqual(st.merged.length, 0);
    assert.strictEqual(st.raw.length, 0);
    assert.deepStrictEqual(st.chats, {}, 'chat names, totals and stale counts cleared');
    assert.strictEqual(st.fetchStatus, null);
    assert.deepStrictEqual(bg.chrome.storage.local._data.ks_chats, {}, 'cleared in storage too');
  }

  /* ---- 7. raw eviction: cap 250 entries, messages responses survive first */
  {
    const bg = loadBackground();
    for (let i = 0; i < 260; i++) {
      await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/other' + i, '{"i":' + i + '}') });
    }
    let st = await bg.state();
    assert.strictEqual(st.raw.length, 250, 'raw capped at 250');
    for (let p = 1; p <= 5; p++) {
      await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=' + p), sampleBody) });
    }
    st = await bg.state();
    assert.strictEqual(st.raw.length, 250);
    assert.strictEqual(st.raw.filter((e) => e.isMessages).length, 5, 'messages responses evicted last');
  }

  /* ---- 8. no global merged cap: a big chat never evicts another chat's messages */
  {
    const bg = loadBackground();
    const many = { data: { data: [] } };
    for (let i = 0; i < 10051; i++) {
      many.data.data.push({
        _id: 'm' + i, _chatId: CHAT_ID, role: 'user',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        choices: [{ _id: 'c' + i, content: 'msg ' + i }]
      });
    }
    const body = JSON.stringify(many);
    assert.ok(body.length < 4000000, 'fixture under body cap');
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/older/messages?page=1&pageSize=10', JSON.stringify({ data: { data: [{ _id: 'old1', _chatId: 'older', role: 'user', createdAt: '2020-01-01T00:00:00.000Z', choices: [{ _id: 'oc', content: 'oldest message' }] }] } })) });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, body) });
    const st = await bg.state();
    assert.strictEqual(st.merged.length, 10052, 'every message kept');
    assert.ok(st.merged.some((m) => m._id === 'old1'), 'the other chat keeps its oldest message');
  }

  /* ---- 9. oversized body truncated to the 4M-char cap */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/big', 'x'.repeat(4500000)) });
    const st = await bg.state();
    assert.strictEqual(st.raw[0].bodyLen, 4000000);
    assert.strictEqual((await bg.send({ type: 'ks:getRaw', id: st.raw[0].id })).entry.body.length, 4000000);
  }

  /* ---- 10. fetch-all happy path: header replay, paging, merge */
  {
    const calls = [];
    const bg = loadBackground({
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        const page = new URL(url).searchParams.get('page');
        const body = page === '1'
          ? sampleBody
          : JSON.stringify({ code: 200, data: { data: [], page: Number(page), totalPages: 2 } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { Authorization: 'Bearer tok', 'Content-Length': '999' } }) });
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.ok, 'started: ' + JSON.stringify(r));
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; }, 5000, 'fetch-all finished');

    const st = await bg.state();
    assert.ok(!st.fetchStatus.error, 'no error: ' + st.fetchStatus.error);
    assert.strictEqual(st.fetchStatus.page, 2, 'stopped after empty page 2');
    assert.ok(calls.length >= 2, 'at least two pages requested');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok', 'captured auth header replayed');
    assert.ok(!('Content-Length' in calls[0].opts.headers), 'hop-by-hop header stripped');
    assert.strictEqual(calls[0].opts.credentials, 'include', 'cookies attached');
    assert.ok(calls[0].url.includes('page=1') && calls[0].url.includes('pageSize=10'), 'original page size kept');
    assert.strictEqual(st.merged.length, 10, 'pages merged');
    assert.ok(st.raw.some((e) => e.source === 'fetch-all' && e.isMessages), 'replayed pages recorded as fetch-all');
  }

  /* ---- 11. fetch-all auth failure surfaced */
  {
    const bg = loadBackground({ fetchImpl: async () => new Response('nope', { status: 401 }) });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { Authorization: 'Bearer stale' } }) });
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.ok);
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; });
    const st = await bg.state();
    assert.ok(/HTTP 401/.test(st.fetchStatus.error), 'status in error');
    assert.ok(/auth rejected/.test(st.fetchStatus.error), 'hint in error');
  }

  /* ---- 12. fetch-all guards: unknown chat, and concurrency */
  {
    const bg = loadBackground();
    const r = await bg.send({ type: 'ks:fetchAll', chatId: 'zzz' });
    assert.ok(r.error && /No captured messages request/.test(r.error), 'no base request error');
  }
  {
    let release;
    const gate = new Promise((res) => { release = res; });
    let firstCall = true;
    const bg = loadBackground({
      fetchImpl: async () => {
        if (firstCall) { firstCall = false; await gate; }
        return new Response('{"data":{"data":[]}}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { a: 'b' } }) });
    const first = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(first.ok);
    const second = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(second.error && /already in progress/i.test(second.error), 'concurrent run rejected');
    release();
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; });
  }

  /* ---- 13. lifecycle: install opens dashboard, update does not */
  {
    const bg = loadBackground();
    await bg.chrome.__onInstalled({ reason: 'install' });
    assert.strictEqual(bg.chrome.__tabsCreated.length, 1);
    assert.ok(bg.chrome.__tabsCreated[0].url.includes('panel/panel.html'));
    await bg.chrome.__onInstalled({ reason: 'update' });
    assert.strictEqual(bg.chrome.__tabsCreated.length, 1, 'no tab on update');
  }

  /* ---- 14. chat name sniffing from chat list/detail responses */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats?page=1&limit=50',
      JSON.stringify({ data: { data: [{ _id: 'c1', name: 'Chat One' }, { _id: 'c2', name: 'Chat Two' }, { _id: 'c3' }] } })) });
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/c1',
      JSON.stringify({ data: { _id: 'c1', name: 'Chat One Renamed' } })) });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) }); // messages response: must NOT sniff
    const st = await bg.state();
    assert.strictEqual(st.chats.c1.name, 'Chat One Renamed', 'last seen wins');
    assert.strictEqual(st.chats.c2.name, 'Chat Two');
    assert.ok(!st.chats.c3, 'chat without a name not stored');
    // messages responses may create a name-less totals entry, but never a name
    assert.ok(!st.chats[CHAT_ID] || !st.chats[CHAT_ID].name, 'messages response not sniffed for chat meta');
    // persisted across SW restart
    const bg2 = loadBackground({ storage: bg.chrome.storage.local._data });
    const st2 = await bg2.state();
    assert.strictEqual(st2.chats.c2.name, 'Chat Two', 'chat names persisted');
  }

  /* ---- 15. removeChat: delete one chat's merged messages, keep the rest */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    const other = JSON.parse(sampleBody);
    other.data.data = other.data.data.map((m) => ({
      ...m,
      _id: 'x' + m._id,
      _chatId: 'other999',
      choices: (m.choices || []).map((c) => ({ ...c, _id: 'x' + c._id, _chatId: 'other999' }))
    }));
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/other999/messages?page=1&pageSize=10', JSON.stringify(other)) });
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/other999', '{"data":{"_id":"other999","name":"Accidental Chat"}}') });
    let st = await bg.state();
    assert.strictEqual(st.merged.length, 20, 'both chats merged');
    assert.strictEqual(st.chats.other999.name, 'Accidental Chat');

    const r = await bg.send({ type: 'ks:removeChat', chatId: 'other999' });
    assert.strictEqual(r.removed, 10);
    st = await bg.state();
    assert.strictEqual(st.merged.length, 10);
    assert.ok(st.merged.every((m) => m._chatId === CHAT_ID), 'only the other chat remains');
    assert.ok(!st.chats.other999, 'chat meta removed with the chat');
    assert.strictEqual(st.raw.length, 3, 'raw responses kept for inspection');

    const again = await bg.send({ type: 'ks:removeChat', chatId: 'other999' });
    assert.strictEqual(again.removed, 0, 'removing an absent chat is a no-op');
    const bad = await bg.send({ type: 'ks:removeChat', chatId: '' });
    assert.ok(bad.error, 'empty chatId rejected');
  }

  /* ---- 16. deletion reconciliation from live page-1 captures */
  {
    const VICTIM = '6ae3463f19b7fa992af2f7f1'; // user msg at 13:12:31, mid-page
    const VICTIM2 = '6ae3463f54d447cc0c68f7a7'; // assistant msg at 13:12:32
    const bg = loadBackground();

    // seed: full page-1 (10 msgs) + an older message only ever seen on page 7
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    const older = { _id: 'older1', _chatId: CHAT_ID, role: 'user', createdAt: '2026-10-28T00:00:00.000Z', choices: [{ _id: 'oc1', content: 'old message' }] };
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=7'), JSON.stringify({ code: 200, data: { data: [older], page: 7, pageSize: 10, hasNext: true, totalPages: 16 } })) });
    let st = await bg.state();
    assert.strictEqual(st.merged.length, 11);

    // window mode: fresh page=1&pageSize=9 without VICTIM (|R| == pageSize, hasNext true)
    const refreshed = JSON.parse(sampleBody);
    refreshed.data.data = refreshed.data.data.filter((m) => m._id !== VICTIM);
    refreshed.data.pageSize = 9;
    let r = await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/' + CHAT_ID + '/messages?page=1&pageSize=9', JSON.stringify(refreshed)) });
    assert.strictEqual(r.removedMessages, 1, 'window inference removes the deleted message');
    st = await bg.state();
    assert.strictEqual(st.merged.length, 10);
    assert.ok(!st.merged.some((m) => m._id === VICTIM));
    assert.ok(st.merged.some((m) => m._id === 'older1'), 'older-than-cutoff absence is inconclusive → kept');

    // full coverage: hasNext:false on page 1 → older1 (absent, off-page) removed too
    refreshed.data.hasNext = false;
    r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('pageSize=10', 'pageSize=9'), JSON.stringify(refreshed)) });
    assert.strictEqual(r.removedMessages, 1, 'full-coverage removes off-page stragglers');
    st = await bg.state();
    assert.strictEqual(st.merged.length, 9);
    assert.ok(!st.merged.some((m) => m._id === 'older1'));

    // page > 1 never reconciles
    const p2 = JSON.parse(sampleBody);
    p2.data.data = p2.data.data.slice(0, 5);
    r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=2'), JSON.stringify(p2)) });
    assert.strictEqual(r.removedMessages, 0, 'page-2 subset deletes nothing');
    st = await bg.state();
    assert.strictEqual(st.merged.length, 9);

    // empty page-1 is inconclusive: never wipes the chat
    r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify({ code: 200, data: { data: [], page: 1, pageSize: 10 } })) });
    assert.strictEqual(r.removedMessages, 0);
    st = await bg.state();
    assert.strictEqual(st.merged.length, 9);

    // not newest-first → guard skips inference entirely
    const asc = JSON.parse(sampleBody);
    asc.data.data = asc.data.data.filter((m) => m._id !== VICTIM2 && m._id !== VICTIM).slice(0, 6).reverse();
    r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(asc)) });
    assert.strictEqual(r.removedMessages, 0, 'unverified order → no inference');
    st = await bg.state();
    assert.strictEqual(st.merged.length, 9, 'nothing lost to the order guard');
  }

  /* ---- 17. fetch-all completion reconciles stale merged messages */
  const onePageChat = (() => { const o = JSON.parse(sampleBody); o.data.totalCount = 10; return JSON.stringify(o); })();
  {
    const bg = loadBackground({
      fetchImpl: async (url) => {
        const page = new URL(url).searchParams.get('page');
        const body = page === '1'
          ? onePageChat
          : JSON.stringify({ code: 200, data: { data: [], page: Number(page), totalPages: 2 } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { Authorization: 'Bearer tok' } }) });
    // stale message older than the page-1 cutoff: only page-1-insensitive paths can remove it
    const stale = { _id: 'stale1', _chatId: CHAT_ID, role: 'assistant', createdAt: '2026-10-29T08:00:00.000Z', choices: [{ _id: 'sc1', content: 'stale deleted message' }] };
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=5'), JSON.stringify({ code: 200, data: { data: [stale], page: 5 } })) });
    let st = await bg.state();
    assert.strictEqual(st.merged.length, 11);

    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.ok);
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; });
    st = await bg.state();
    assert.ok(!st.fetchStatus.error, st.fetchStatus.error);
    assert.strictEqual(st.fetchStatus.reconciled, 1, 'stale message removed after the full walk');
    assert.strictEqual(st.merged.length, 10);
    assert.ok(!st.merged.some((m) => m._id === 'stale1'));
  }

  /* ---- 17b. a walk that missed a message (deleted mid-walk) deletes nothing */
  {
    // the site reports 10 messages but page 1 shifted: the walk saw only 9
    const shifted = JSON.parse(onePageChat);
    const missed = shifted.data.data.pop();
    const bg = loadBackground({
      fetchImpl: async (url) => {
        const page = new URL(url).searchParams.get('page');
        const body = page === '1' ? JSON.stringify(shifted) : JSON.stringify({ code: 200, data: { data: [], page: 2, totalPages: 2 } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=3'), sampleBody, { requestHeaders: { Authorization: 'Bearer tok' } }) });
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.ok);
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; });
    const st = await bg.state();
    assert.ok(!st.fetchStatus.error, st.fetchStatus.error);
    assert.strictEqual(st.fetchStatus.reconciled, 0, 'nothing deleted after an incomplete walk');
    assert.ok(st.merged.some((m) => m._id === missed._id), 'the skipped message is kept');
  }

  /* ---- 18. totalCount drop (any page's envelope) detects deletions; the reload starts from an explicit ks:fetchAll */
  {
    const V1 = '6ae3463f19b7fa992af2f7f1';
    const V2 = '6ae34854d567989f858aa973';
    const oldest = sample.data.data[sample.data.data.length - 1]; // deep-page msg already merged
    let fetchCalls = 0;
    let victims = [];
    const bg = loadBackground({
      fetchImpl: async (url) => {
        fetchCalls++;
        const page = new URL(url).searchParams.get('page');
        let body;
        if (page === '1') {
          const fixed = JSON.parse(sampleBody);
          fixed.data.data = fixed.data.data.filter((m) => !victims.includes(m._id));
          fixed.data.totalCount = fixed.data.data.length;
          fixed.data.hasNext = false;
          fixed.data.totalPages = 1;
          body = JSON.stringify(fixed);
        } else {
          body = JSON.stringify({ code: 200, data: { data: [], page: Number(page) } });
        }
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    // seed: whole chat captured, totals consistent — in sync
    const full = JSON.parse(sampleBody);
    full.data.totalCount = 10;
    full.data.hasNext = false;
    full.data.totalPages = 1;
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(full)) });
    let st = await bg.state();
    assert.strictEqual(st.merged.length, 10);
    assert.ok(!st.chats[CHAT_ID].stale, 'in sync — no staleness');
    assert.strictEqual(fetchCalls, 0, 'no network without a change');

    // deletion #1: a later page (page 14) reports totalCount 9 — flagged stale, nothing fetched
    victims = [V1];
    const p14 = (total) => JSON.stringify({
      code: 200,
      data: { data: [oldest], page: 14, pageSize: 10, totalCount: total, totalPages: 16, hasNext: true, hasPrev: true }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=14'), p14(9)) });
    st = await bg.state();
    assert.strictEqual(st.chats[CHAT_ID].stale, 1, 'staleness surfaced');
    assert.strictEqual(fetchCalls, 0, 'a stale capture starts no fetch');
    assert.ok(await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID }), 'user starts the reload');
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false && s.doneAt; }, 5000, 'first fetch-all run');
    st = await bg.state();
    // page 1 + the chat-name backfill (this chat has no name): every run is manual now
    assert.strictEqual(fetchCalls, 2, 'one fetch-all run');
    assert.strictEqual(st.merged.length, 9, 'deleted message pinpointed and removed');
    assert.ok(!st.merged.some((m) => m._id === V1));
    assert.strictEqual(st.chats[CHAT_ID].totalCount, 9, 'totals tracked from envelope');
    assert.ok(!st.chats[CHAT_ID].stale, 'count invariant satisfied again');

    // deletion #2
    const doneAt1 = st.fetchStatus.doneAt;
    victims = [V1, V2];
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=14'), p14(8)) });
    assert.strictEqual(fetchCalls, 2, 'still no automatic fetch');
    await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    await waitFor(() => {
      const s = bg.chrome.storage.local._data.ks_fetch;
      return s && s.running === false && s.doneAt && s.doneAt !== doneAt1;
    }, 5000, 'second fetch-all run');
    st = await bg.state();
    assert.strictEqual(fetchCalls, 4, 'second run: page 1 + name backfill');
    assert.strictEqual(st.merged.length, 8);
    assert.ok(!st.merged.some((m) => m._id === V2));
    assert.ok(!st.chats[CHAT_ID].stale);
  }

  /* ---- 19. a stale capture starts no fetch (no network request at all) */
  {
    let calls = 0;
    const bg = loadBackground({
      fetchImpl: async () => { calls++; return new Response('{"data":{"data":[]}}', { status: 200 }); }
    });
    const full = JSON.parse(sampleBody);
    full.data.totalCount = 10;
    full.data.hasNext = false;
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(full)) });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=3'), JSON.stringify({ code: 200, data: { data: [], page: 3, pageSize: 10, totalCount: 9, hasNext: true } })) });
    const st = await bg.state();
    assert.strictEqual(calls, 0, 'no network request without a user click');
    assert.strictEqual(st.chats[CHAT_ID].stale, 1, 'staleness still surfaced for the UI warning');
  }

  /* ---- 20. delete + add with net-zero totalCount: blind spot, then a manual reload fixes it */
  {
    const OLD = sample.data.data[sample.data.data.length - 1]; // oldest message, outside any page-1 window
    const NEW = { _id: 'brand-new-1', _chatId: CHAT_ID, role: 'user', createdAt: '2026-10-29T23:59:00.000Z', choices: [{ _id: 'bc1', content: 'the newly added message' }] };
    let fetchCalls = 0;
    const serverPage1 = () => { // server truth after delete+add: OLD gone, NEW present
      const b = JSON.parse(sampleBody);
      b.data.data = [NEW, ...b.data.data.slice(0, 9)];
      b.data.totalCount = 10;
      b.data.hasNext = false;
      b.data.totalPages = 1;
      return b;
    };
    const bg = loadBackground({
      fetchImpl: async (url) => {
        fetchCalls++;
        const page = new URL(url).searchParams.get('page');
        const body = page === '1'
          ? JSON.stringify(serverPage1())
          : JSON.stringify({ code: 200, data: { data: [], page: Number(page) } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    // seed: whole chat, in sync (T=10)
    const full = JSON.parse(sampleBody);
    full.data.totalCount = 10;
    full.data.hasNext = false;
    full.data.totalPages = 1;
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(full)) });
    let st = await bg.state();
    assert.ok(!st.chats[CHAT_ID].stale);
    assert.strictEqual(fetchCalls, 0);

    // delete+add happened server-side; a deep page still reports totalCount 10 —
    // the known blind spot: live 10 == T 10, nothing detected, nothing fired
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=3'), JSON.stringify({ code: 200, data: { data: [OLD], page: 3, pageSize: 10, totalCount: 10, hasNext: true } })) });
    st = await bg.state();
    assert.ok(!st.chats[CHAT_ID].stale, 'net-zero totals are undetectable at this moment');
    assert.strictEqual(fetchCalls, 0, 'no network on an ambiguous signal');

    // the response that teaches us about the NEW message also breaks the tie:
    // live becomes 11 (10 + NEW) vs T 10 → stale; the user's reload pinpoints and removes OLD
    const refresh = serverPage1();
    refresh.data.hasNext = true; // full page → window mode keeps OLD (below cutoff)
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, JSON.stringify(refresh)) });
    assert.strictEqual(fetchCalls, 0, 'stale, but nothing fetched on its own');
    assert.strictEqual((await bg.state()).chats[CHAT_ID].stale, 1);
    await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false && s.doneAt; }, 5000, 'manual reload');
    st = await bg.state();
    assert.ok(fetchCalls >= 1, 'the reload fetched');
    assert.strictEqual(st.merged.length, 10);
    assert.ok(st.merged.some((m) => m._id === 'brand-new-1'), 'new message present');
    assert.ok(!st.merged.some((m) => m._id === OLD._id), 'deleted message removed');
    assert.ok(!st.chats[CHAT_ID].stale, 'invariant restored');
  }

  /* ---- 21. chat name from the real GET /api/chats/{id} detail shape */
  {
    // shape from the live site: the label sits at data.history.name (keyed by
    // the history's own _id) — it must land under the CHAT id, not that one,
    // and must not wipe the totals bookkeeping kept on the same meta object
    const HISTORY_ID = '6adf35d941b1d32e4ee75f99';
    const detail = JSON.stringify({
      code: 200, status: 'success',
      data: {
        _id: CHAT_ID,
        history: { _id: HISTORY_ID, name: 'A Dragon Boy Appeared in My Apartment?! - #1' },
        storylineSnapshot: {
          title: 'Um Garoto Dragão Surgiu no Meu Apartamento?!',
          cover: {
            url: 'https://s3.alterworld.ai/uploads/story.webp',
            thumbnailUrl: 'https://s3.alterworld.ai/uploads/thumbs/story.webp',
            width: 480, height: 640
          }
        }
      }
    });
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) }); // records totalCount
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/' + CHAT_ID, detail) });
    const st = await bg.state();
    assert.strictEqual(st.chats[CHAT_ID].name, 'A Dragon Boy Appeared in My Apartment?! - #1',
      'history.name preferred over storylineSnapshot.title');
    assert.strictEqual(st.chats[CHAT_ID].totalCount, sample.data.totalCount, 'name refresh keeps the tracked totals');
    assert.strictEqual(st.chats[CHAT_ID].site, 'kagesekai', 'chat meta records which site it came from');
    assert.strictEqual(st.chats[CHAT_ID].coverUrl, 'https://s3.alterworld.ai/uploads/story.webp');
    assert.strictEqual(st.chats[CHAT_ID].coverThumbnailUrl, 'https://s3.alterworld.ai/uploads/thumbs/story.webp');
    assert.deepStrictEqual([st.chats[CHAT_ID].coverWidth, st.chats[CHAT_ID].coverHeight], [480, 640]);
    assert.ok(!st.chats[HISTORY_ID], 'stored under the chat id, never the history id');

    // storyline snapshot title alone still yields a label
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/nohist',
      JSON.stringify({ data: { _id: 'nohist', storylineSnapshot: { title: 'Snapshot Title' } } })) });
    const st2 = await bg.state();
    assert.strictEqual(st2.chats.nohist.name, 'Snapshot Title');

    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/badcover',
      JSON.stringify({ data: { _id: 'badcover', name: 'Bad cover', storylineSnapshot: { cover: {
        url: 'http://s3.alterworld.ai/not-https.webp', thumbnailUrl: 'https://example.com/not-allowed.webp'
      } } } })) });
    const stBad = await bg.state();
    assert.ok(!stBad.chats.badcover.coverUrl && !stBad.chats.badcover.coverThumbnailUrl, 'untrusted cover hosts are dropped');

    // chat-list capture on the sister site labels its chats isekaizero
    await bg.send({ type: 'ks:capture', entry: capture('https://api.isekaizero.ai/api/chats',
      JSON.stringify({ data: { data: [{ _id: 'ise1', name: 'Zero Chat' }] } })) });
    const st3 = await bg.state();
    assert.strictEqual(st3.chats.ise1.site, 'isekaizero');
    assert.strictEqual(st3.chats.ise1.name, 'Zero Chat');
  }

  /* ---- 22. manual fetch-all backfills an unknown chat name */
  {
    const calls = [];
    const bg = loadBackground({
      fetchImpl: async (url) => {
        calls.push(url);
        const u = new URL(url);
        if (!/\/messages\/?$/.test(u.pathname)) {
          return new Response(
            JSON.stringify({ code: 200, data: { _id: CHAT_ID, history: { _id: 'h1', name: 'Backfilled Name' } } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const page = u.searchParams.get('page');
        const body = page === '1'
          ? sampleBody
          : JSON.stringify({ code: 200, data: { data: [], page: Number(page), totalPages: 2 } });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { Authorization: 'Bearer tok' } }) });
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(r.ok);
    await waitFor(() => { const s = bg.chrome.storage.local._data.ks_fetch; return s && s.running === false; });
    const st = await bg.state();
    assert.ok(!st.fetchStatus.error, st.fetchStatus.error);
    assert.strictEqual(st.chats[CHAT_ID].name, 'Backfilled Name', 'detail endpoint consulted after the walk');
    const metaCall = calls.find((c) => !c.includes('/messages'));
    assert.strictEqual(metaCall, 'https://api.kagesekai.ai/api/chats/' + CHAT_ID,
      'detail URL derived from the messages URL, query stripped');
    assert.strictEqual(st.chats[CHAT_ID].totalCount, sample.data.totalCount, 'totals intact alongside the backfilled name');
  }

  /* ---- 23. getState never rewrites a clean store (flush guard) */
  {
    const bg = loadBackground();
    await bg.state(); // initial load, nothing dirty
    const before = bg.chrome.__setLog.length;
    await bg.state(); // clean read — must not write
    assert.strictEqual(bg.chrome.__setLog.length, before, 'clean getState writes nothing');

    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) }); // debounce pending
    await bg.state(); // dirty read — flushes the pending capture
    const last = bg.chrome.__setLog[bg.chrome.__setLog.length - 1] || [];
    assert.ok(last.includes('ks_raw') && last.includes('ks_merged'), 'pending capture persisted on read');
    const afterFlush = bg.chrome.__setLog.length;
    await bg.state(); // clean again
    assert.strictEqual(bg.chrome.__setLog.length, afterFlush, 'no write after the flush');
  }

  /* ---- 24. a run left "running" by a dead worker is reset on load */
  {
    const bg = loadBackground({ storage: { ks_fetch: { running: true, chatId: CHAT_ID, page: 3 } } });
    const st = await bg.state();
    assert.strictEqual(st.fetchStatus.running, false, 'not running after a restart');
    assert.ok(/Interrupted/.test(st.fetchStatus.error));
    assert.ok(st.fetchStatus.doneAt);
    const fs = await bg.send({ type: 'ks:getFetchStatus' });
    assert.strictEqual(fs.fetchStatus.running, false);
  }

  /* ---- 24b. raw entries stored before ids existed get ids that survive a restart */
  {
    const bg1 = loadBackground({ storage: { ks_raw: [{ url: 'https://api.kagesekai.ai/api/x', body: 'b', ts: 1 }] } });
    const id = (await bg1.state()).raw[0].id;
    assert.ok(id, 'id assigned');
    const bg2 = loadBackground({ storage: bg1.chrome.storage.local._data });
    assert.strictEqual((await bg2.send({ type: 'ks:getRaw', id })).entry.body, 'b', 'same id after a restart');
  }

  /* ---- 25. saves write only changed keys and notify open pages */
  {
    const bg = loadBackground();
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    await bg.state(); // flush
    assert.ok(bg.chrome.__runtimeSent.some((m) => m.type === 'ks:changed'), 'pages told to refresh');
    await bg.send({ type: 'ks:removeChat', chatId: CHAT_ID });
    const last = bg.chrome.__setLog[bg.chrome.__setLog.length - 1];
    assert.deepStrictEqual(last.slice().sort(), ['ks_chats', 'ks_merged'], 'removeChat does not rewrite the raw store');
    await bg.send({ type: 'ks:clear', scope: 'raw' });
    assert.deepStrictEqual(bg.chrome.__setLog[bg.chrome.__setLog.length - 1], ['ks_raw']);
  }

  /* ---- 26. messages come in pages under the 64 MB reply cap; a save between pages is caught */
  {
    const N = 12001; // three pages of LIMITS.mergedPage (5000)
    const merged = {};
    for (let i = 0; i < N; i++) {
      merged['m' + i] = { _id: 'm' + i, _chatId: i % 2 ? 'c1' : 'c2', role: 'user', deleted: i === 0 };
    }
    const bg = loadBackground({ storage: { ks_merged: merged } });
    const head = await bg.send({ type: 'ks:getState' });
    assert.strictEqual(head.merged, undefined, 'getState sends no messages');
    assert.strictEqual(head.mergedCount, N);
    assert.strictEqual(head.liveMessages, N - 1, 'popup count skips deleted');
    assert.strictEqual(head.liveChats, 2);
    const p1 = await bg.send({ type: 'ks:getMerged', rev: head.mergedRev, offset: 0 });
    assert.strictEqual(p1.items.length, 5000, 'one page');

    const st = await bg.state();
    assert.strictEqual(st.merged.length, N, 'pages add up to the store');
    assert.strictEqual(new Set(st.merged.map((m) => m._id)).size, N, 'no message twice');

    await bg.send({ type: 'ks:removeChat', chatId: 'c1' }); // store moves after head was read
    const old = await bg.send({ type: 'ks:getMerged', rev: head.mergedRev, offset: 5000 });
    assert.strictEqual(old.stale, true, 'page of an old revision refused');
    assert.strictEqual((await bg.state()).merged.length, 6001, 'fresh read after the change');

    // a capture between two pages of one read: loadState starts again
    let calls = 0;
    const racing = (type, extra) => {
      if (type === 'ks:getMerged' && ++calls === 2) {
        return bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) })
          .then(() => bg.send({ type, ...extra }));
      }
      return bg.send({ type, ...(extra || {}) });
    };
    const raced = await globalThis.KSFlow.loadState(racing);
    assert.strictEqual(raced.merged.length, 6001 + 10, 'complete after a restart of the read');
    assert.ok(calls > 2, 'read started again');
  }

  /* ---- 27. a site tab may only send captures; an extension page in a tab may do all */
  {
    const bg = loadBackground();
    const site = { tab: { id: 3 }, url: 'https://www.kagesekai.ai/chat/x' };
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { authorization: 'Bearer tok' } }) }, site);
    const st = await bg.state();
    assert.strictEqual(st.merged.length, 10, 'capture from the site accepted');
    for (const msg of [
      { type: 'ks:getRaw', id: st.raw[0].id },
      { type: 'ks:clear', scope: 'all' },
      { type: 'ks:settings', settings: { enabled: false } },
      { type: 'ks:fetchAll', chatId: CHAT_ID },
      { type: 'ks:getState' }
    ]) {
      const r = await bg.send(msg, site);
      assert.ok(r && /not allowed/.test(r.error), msg.type + ' refused from a site tab');
    }
    assert.strictEqual((await bg.state()).merged.length, 10, 'nothing cleared');
    const page = { tab: { id: 4 }, url: 'chrome-extension://test/panel/panel.html' };
    const r = await bg.send({ type: 'ks:getRaw', id: st.raw[0].id }, page);
    assert.strictEqual(r.entry.requestHeaders.authorization, 'Bearer tok', 'panel opened in a tab still reads');
  }

  /* ---- 28. a forged capture is trimmed to known fields and sizes; '__proto__' ids stay data */
  {
    const bg = loadBackground();
    const headers = {};
    for (let i = 0; i < 100; i++) headers['x-h' + i] = 'v'.repeat(1000);
    await bg.send({ type: 'ks:capture', entry: {
      ...capture('https://api.kagesekai.ai/api/chats/__proto__/messages?page=1&pageSize=10&q=' + 'u'.repeat(50000),
        JSON.stringify({ data: { totalCount: 1, data: [{ _id: '__proto__', _chatId: '__proto__', role: 'user', createdAt: '2024-01-01', choices: [{ content: 'x' }] }] } })),
      requestHeaders: headers, evil: 'x'.repeat(1000), status: '200'
    } });
    await bg.send({ type: 'ks:capture', entry: capture('https://api.kagesekai.ai/api/chats/__proto__', '{"data":{"_id":"__proto__","name":"P"}}', { method: 'get'.repeat(100) }) });
    assert.strictEqual(({}).totalCount, undefined, 'Object.prototype untouched');
    assert.strictEqual(({}).name, undefined, 'Object.prototype untouched');
    const st = await bg.state();
    const e = (await bg.send({ type: 'ks:getRaw', id: st.raw[0].id })).entry;
    assert.strictEqual(e.evil, undefined, 'unknown field dropped');
    assert.strictEqual(e.url.length, 16000, 'url capped');
    assert.ok(Object.keys(e.requestHeaders).length < 40, 'headers capped');
    const e2 = (await bg.send({ type: 'ks:getRaw', id: st.raw[1].id })).entry;
    assert.strictEqual(e2.method.length, 16, 'method capped');
    assert.strictEqual(e.status, 0, 'non-number status dropped');
    assert.strictEqual(st.merged.length, 1, 'message with id __proto__ stored as data');
    assert.strictEqual(st.chats.__proto__.name, 'P', 'chat with id __proto__ stored as data');
  }

  /* ---- 29. fetch-all replays auth headers only to the two sites over https */
  {
    let fetched = 0;
    const bg = loadBackground({ fetchImpl: async () => { fetched++; return new Response('{}'); } });
    for (const url of [
      'https://api.kagesekai.ai.evil.example/api/chats/' + CHAT_ID + '/messages?page=1',
      'https://evil.example/kagesekai/api/chats/' + CHAT_ID + '/messages?page=1',
      'http://api.kagesekai.ai/api/chats/' + CHAT_ID + '/messages?page=1'
    ]) {
      await bg.send({ type: 'ks:capture', entry: capture(url, sampleBody, { requestHeaders: { authorization: 'Bearer tok' } }) });
    }
    const r = await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    assert.ok(/No captured messages request/.test(r.error), 'no site capture to replay: ' + JSON.stringify(r));
    await sleep(50);
    assert.strictEqual(fetched, 0, 'nothing sent to another host');
  }

  /* ---- 30. a paused worker drops live captures but keeps fetch-all pages */
  {
    const bg = loadBackground({
      fetchImpl: async (url) => new Response(
        new URL(url).searchParams.get('page') === '1' ? sampleBody : JSON.stringify({ code: 200, data: { data: [], page: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { requestHeaders: { authorization: 'Bearer tok' } }) });
    await bg.send({ type: 'ks:settings', settings: { enabled: false } });
    const r = await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody) });
    assert.strictEqual(r.skipped, 'paused');
    assert.strictEqual((await bg.state()).raw.length, 1, 'live capture dropped while paused');
    await bg.send({ type: 'ks:fetchAll', chatId: CHAT_ID });
    await waitFor(() => { const f = bg.chrome.storage.local._data.ks_fetch; return f && f.running === false && f.doneAt; }, 5000, 'fetch-all while paused');
    const st = await bg.state();
    assert.ok(st.raw.some((e) => e.source === 'fetch-all'), 'fetch-all pages still saved while paused');
    assert.strictEqual(st.merged.length, 10);
  }

  /* ---- 31. capture health: formatOk / msgCount on raw entries, badge, restart */
  {
    const badge = (bg) => { const t = bg.chrome.__actionLog.filter(([k]) => k === 'text'); return t[t.length - 1][1]; };
    const bg = loadBackground();
    let h = (await bg.state()).health;
    assert.deepStrictEqual(h, { formatError: false, lastSavedAt: null }, 'fresh install: no warning, nothing saved');

    // 200 with an unknown shape: format error, red '!' badge
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, '{"data":{"foo":1}}') });
    h = (await bg.state()).health;
    assert.strictEqual(h.formatError, true);
    assert.strictEqual(badge(bg), '!');

    // unparseable body too
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, 'not json') });
    assert.strictEqual((await bg.state()).health.formatError, true);

    // a failed HTTP status (ok:false) is not a format change
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, '', { ok: false, status: 500 }) });
    assert.strictEqual((await bg.state()).health.formatError, true, 'status 500 leaves the flag as it was');

    // a good capture clears it; lastSavedAt is its ts
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, sampleBody, { ts: 1700000000000 }) });
    h = (await bg.state()).health;
    assert.deepStrictEqual(h, { formatError: false, lastSavedAt: 1700000000000 });
    assert.notStrictEqual(badge(bg), '!');

    // a valid empty chat and a page past the end are healthy, and do not move lastSavedAt
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, '{"data":{"data":[],"page":1,"pageSize":10,"totalCount":0,"totalPages":0}}', { ts: 1700000001000 }) });
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.replace('page=1', 'page=9'), '{"data":{"data":[],"page":9,"pageSize":10,"totalCount":10,"totalPages":1}}', { ts: 1700000002000 }) });
    h = (await bg.state()).health;
    assert.deepStrictEqual(h, { formatError: false, lastSavedAt: 1700000000000 });

    // POST on the messages path is not a messages capture: no flag
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL.split('?')[0], '{"data":{"foo":1}}', { method: 'POST' }) });
    const st = await bg.state();
    assert.strictEqual(st.raw[st.raw.length - 1].formatOk, undefined);
    assert.strictEqual(st.health.formatError, false);

    // pause: no badge text while a format error is set, and no new live capture
    await bg.send({ type: 'ks:capture', entry: capture(CHAT_URL, '{"data":{"foo":1}}') });
    assert.strictEqual(badge(bg), '!');
    await bg.send({ type: 'ks:settings', settings: { enabled: false } });
    assert.strictEqual(badge(bg), '', 'paused: badge empty');

    // "Clear raw" clears the warning
    await bg.send({ type: 'ks:clear', scope: 'raw' });
    assert.deepStrictEqual((await bg.state()).health, { formatError: false, lastSavedAt: null });
  }

  /* ---- 31b. the warning survives a worker restart; fetch-all pages never set it */
  {
    const bg1 = loadBackground();
    await bg1.send({ type: 'ks:capture', entry: capture(CHAT_URL, '{"data":{"foo":1}}') });
    await bg1.state(); // flush
    const bg2 = loadBackground({ storage: bg1.chrome.storage.local._data });
    assert.strictEqual((await bg2.state()).health.formatError, true, 'formatOk is read back from ks_raw');
    const seeded = loadBackground({ storage: { ks_raw: [{ id: 'r1', ts: 5, method: 'GET', url: CHAT_URL, isMessages: true, formatOk: false }] } });
    assert.strictEqual((await seeded.state()).health.formatError, true);

    const bg3 = loadBackground();
    await bg3.send({ type: 'ks:capture', entry: capture(CHAT_URL, '{"data":{"data":[]}}', { source: 'fetch-all' }) });
    const st = await bg3.state();
    assert.strictEqual(st.raw[0].formatOk, undefined, 'fetch-all empty page: no flag');
    assert.strictEqual(st.health.formatError, false);
  }

  /* ---- 32. plotSummary from the chat detail: trimmed, capped, strings only */
  {
    const bg = loadBackground();
    const detail = (ps) => JSON.stringify({ data: { _id: CHAT_ID, name: 'Named', storylineSnapshot: { plotSummary: ps } } });
    const url = 'https://api.isekaizero.ai/api/chats/' + CHAT_ID;
    await bg.send({ type: 'ks:capture', entry: capture(url, detail('  ' + 'p'.repeat(5000))) });
    let st = await bg.state();
    assert.strictEqual(st.chats[CHAT_ID].plotSummary.length, 2000, 'capped at 2000');
    await bg.send({ type: 'ks:capture', entry: capture(url, detail({ not: 'a string' })) });
    st = await bg.state();
    assert.strictEqual(st.chats[CHAT_ID].plotSummary.length, 2000, 'a non-string is ignored, the old one stays');
    await bg.send({ type: 'ks:capture', entry: capture('https://api.isekaizero.ai/api/chats/other', detail('   ').replace(CHAT_ID, 'other')) });
    assert.strictEqual('plotSummary' in (await bg.state()).chats.other, false, 'empty summary not stored');
  }

  console.log('PASS background: 35 scenarios (state, merge, dedup, caps, settings, fetch-all, lifecycle, chat separation, deletion reconcile + totals + net-zero blind spot (manual reload), pause enforced in the worker, capture health, chat names list/detail/backfill, flush guard, slim state + getRaw, interrupted-run reset, missed-message guard, changed-keys-only saves, paged messages, sender gate, forged-capture trim, replay host pin)');
})().catch((err) => { console.error(err); process.exit(1); });
