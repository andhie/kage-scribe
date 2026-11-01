/* Kage Scribe — demo shim for README screenshots (never shipped; not in extension/).
 * Injected by shoot.mjs before the panel/popup scripts. Runs the real
 * background.js in this page against an in-memory chrome.* fake, feeds it
 * made-up chats (no real user data), then lets the real UI render.
 * ?shot=simple|advanced|developer picks the panel view. */
'use strict';
(() => {
  const BASE = location.origin + '/extension/';
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  const pageListeners = [];
  let bgListener = null;

  /* ---- chrome.* for the background (service worker side) */
  const data = {};
  const bgChrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(data);
          const out = {};
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          for (const k of list) if (k in data) out[k] = clone(data[k]);
          if (keys && typeof keys === 'object' && !Array.isArray(keys)) for (const [k, d] of Object.entries(keys)) if (!(k in out)) out[k] = d;
          return out;
        },
        async set(obj) { Object.assign(data, clone(obj)); }
      }
    },
    runtime: {
      onMessage: { addListener(fn) { bgListener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (p) => BASE + p,
      getManifest: () => ({ content_scripts: [{ matches: ['https://*.kagesekai.ai/*', 'https://*.isekaizero.ai/*'] }] }),
      async sendMessage(msg) { setTimeout(() => pageListeners.forEach((fn) => fn(clone(msg), {}, () => {})), 0); }
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: { create() {}, async query() { return []; }, async sendMessage() {} }
  };

  function loadSync(path) {
    const x = new XMLHttpRequest();
    x.open('GET', BASE + path, false);
    x.send();
    return x.responseText;
  }
  // a function scope keeps background.js's top-level consts apart from the page's
  new Function('chrome', 'importScripts', loadSync('background.js'))(
    bgChrome, (p) => (0, eval)(loadSync(p)));

  const callBg = (msg, sender) => new Promise((resolve) => {
    bgListener(clone(msg), sender, (r) => resolve(clone(r)));
  });

  /* ---- made-up chats */
  const CHATS = [
    { id: '6b10a0c1d2e3f40011223344', site: 'www.kagesekai.ai', name: 'The Lantern Keeper’s Apprentice - #1', who: 'Mira', n: 14, ago: 2 },
    { id: '6b10a0c1d2e3f40011223355', site: 'www.isekaizero.ai', name: 'Station Nine After Dark - #2', who: 'Captain Vale', n: 8, ago: 26 },
    { id: '6b10a0c1d2e3f40011223366', site: 'www.kagesekai.ai', name: 'Tea House on Cloud Street', who: 'Old Fen', n: 6, ago: 75 }
  ];
  const USER = [
    'I step into the workshop and shake the rain off my coat. "Is this where the lanterns are made?"',
    'Can you show me how the flame stays lit without oil?',
    'I pick up the smallest lantern and turn it over in my hands.',
    '"What happens if one of them goes out?"',
    'I follow you up the narrow stairs to the roof.',
    '"Teach me the first rule, then."',
    'I hold the lantern up to the dark and wait.'
  ];
  const BOT = [
    'The old door creaks as you enter. Shelves of brass lanterns glow in every colour, humming softly like a hive of sleepy bees.\n\n"It is," she says, without looking up from her bench. "Close the door. The light gets shy in a draft."',
    'She taps the glass twice. Inside, a tiny flame wakes and stretches.\n\n"It does not burn oil. It burns attention. Every time someone looks at it with hope, it lasts another night."',
    'The lantern is warm, though nothing inside it moves. Etched on its base, in a careful hand, are three words: remember the way.',
    'Her hands go still. For a moment the whole room seems to dim.\n\n"Then somebody, somewhere, forgets their way home. That is why we keep them lit."',
    'The city spreads out below, dark except for a scatter of small, steady lights — hundreds of them, each one a lantern from this shop.',
    '"First rule," she says, handing you a match that is not a match. "Never light a lantern for yourself. Light it for the next person who comes looking."',
    'At first nothing happens. Then, far across the rooftops, another small light flickers on in answer.'
  ];
  const DAY = 86400000;
  function messagesFor(chat) {
    const t0 = Date.now() - chat.ago * 3600000 - DAY;
    const out = [];
    for (let i = 0; i < chat.n; i++) {
      const user = i % 2 === 0;
      const id = chat.id.slice(-8) + String(i).padStart(16, '0'); // unique across chats
      const at = new Date(t0 + i * 240000).toISOString();
      const choice = {
        _id: id + 'c', _messageId: id, _chatId: chat.id, content: (user ? USER : BOT)[(i >> 1) % 7],
        characterName: user ? '' : chat.who, finishReason: user ? '' : 'stop', deleted: false, createdAt: at,
        moderation: user ? undefined : { sexual: 'none', violence: 'none', hate: 'none' },
        timing: user ? undefined : { totalElapsed: 4200 + i * 310 },
        llmUsages: user ? [] : [{ model: 'demo-model', llmSnapshot: { name: 'Demo Model 8B' }, promptTokens: 2100 + i * 180, completionTokens: 180 + i * 7, totalTokens: 2280 + i * 187, finishReason: 'stop', totalCost: 0.0004 + i * 0.00003 }]
      };
      out.push({ _id: id, _chatId: chat.id, role: user ? 'user' : 'assistant', type: user ? 'message' : 'continue',
        deleted: false, createdAt: at, updatedAt: at, _selectedChoiceId: choice._id, choiceIndex: 0, choices: [choice] });
    }
    return out.reverse(); // the site sends page 1 newest first
  }
  const capture = (site, path, body) => ({
    method: 'GET', url: 'https://' + site.replace('www.', 'api.') + path, status: 200, ok: true,
    contentType: 'application/json', requestBody: '', body: JSON.stringify(body),
    requestHeaders: { authorization: 'Bearer demo' }, source: 'live', durationMs: 180
  });

  const ready = (async () => {
    for (const c of CHATS) {
      const sender = { tab: { id: 1 }, url: 'https://' + c.site + '/chat/' + c.id };
      await callBg({ type: 'ks:capture', entry: capture(c.site, '/api/users/me', { data: { _id: 'u1', name: 'Demo User' } }) }, sender);
      await callBg({ type: 'ks:capture', entry: capture(c.site, '/api/chats/' + c.id, { data: { _id: c.id, history: { _id: 'h' + c.id, name: c.name } } }) }, sender);
      await callBg({ type: 'ks:capture', entry: capture(c.site, '/api/chats/' + c.id + '/messages?page=1&pageSize=20',
        { code: 200, data: { data: messagesFor(c), page: 1, pageSize: 20, totalCount: c.n, totalPages: 1, hasNext: false, hasPrev: false } }) }, sender);
    }
  })();

  /* ---- chrome.* for the extension page (panel / popup) */
  const SELF = { id: 'demo', url: BASE + location.pathname.split('/extension/')[1] };
  Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: {
    runtime: {
      async sendMessage(msg) { await ready; return callBg(msg, SELF); },
      onMessage: { addListener(fn) { pageListeners.push(fn); } },
      getURL: (p) => BASE + p,
      getManifest: () => ({ version: '0.0.0-demo' })
    },
    tabs: { create() {} },
    downloads: { async download() { return 1; } }
  } });

  /* ---- pick the view to photograph */
  const shot = new URLSearchParams(location.search).get('shot') || 'simple';
  try { localStorage.setItem('ks_view', shot === 'simple' ? 'simple' : 'advanced'); } catch (e) { /* ignore */ }
  if (shot === 'advanced') {
    window.addEventListener('load', () => setTimeout(() => {
      const sel = document.querySelector('#selChat');
      sel.value = CHATS[0].id; // one chat, so names and story line up
      sel.dispatchEvent(new Event('change'));
    }, 400));
  }
  if (shot === 'developer') {
    window.addEventListener('load', () => setTimeout(() => {
      document.querySelector('.tabs button[data-tab="captures"]').click();
      const msg = document.querySelector('#reqList .badge-msg');
      if (msg) msg.closest('.req').click();
    }, 400));
  }
})();
