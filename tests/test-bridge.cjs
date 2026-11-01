/* Test: ISOLATED-world bridge — settings push to the page and capture relay
 * to the service worker, including the security guards. */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('node:events');

const sent = [];             // chrome.runtime.sendMessage calls
const storageListeners = []; // chrome.storage.onChanged listeners (must stay empty)
const runtimeListeners = []; // chrome.runtime.onMessage listeners
const storedSettings = { enabled: true, captureFilter: '/api/' };

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        const out = {};
        for (const [k, d] of Object.entries(defaults)) out[k] = k === 'ks_settings' ? storedSettings : d;
        return out;
      }
    },
    onChanged: { addListener(fn) { storageListeners.push(fn); } }
  },
  runtime: {
    sendMessage(msg) { sent.push(msg); return Promise.resolve({ ok: true }); },
    onMessage: { addListener(fn) { runtimeListeners.push(fn); } }
  }
};

const posted = [];           // window.postMessage calls (to the hook)
class Win extends EventEmitter {
  constructor() {
    super();
    this.location = { origin: 'https://www.kagesekai.ai' };
  }
  addEventListener(type, fn) { this.on(type, fn); }
  postMessage(data, origin) {
    assert.strictEqual(origin, 'https://www.kagesekai.ai', 'ctrl messages posted to page origin only');
    posted.push(data);
  }
}
const win = new Win();
globalThis.window = win;

require('../extension/content/bridge.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 1. initial settings push on load (hook gets `enabled` only)
  await sleep(20);
  assert.strictEqual(posted.length, 1, 'initial ctrl message');
  assert.deepStrictEqual(posted[0], { __ks_ctrl: true, enabled: true });

  // ---- 2. hook captures relayed to the service worker
  win.emit('message', { source: win, origin: 'https://www.kagesekai.ai', data: { __ks_cap: true, entry: { url: 'u1', body: 'b1' } } });
  assert.deepStrictEqual(sent, [{ type: 'ks:capture', entry: { url: 'u1', body: 'b1' } }]);

  // ---- 3. spoofed / foreign messages ignored
  win.emit('message', { source: {}, origin: 'https://www.kagesekai.ai', data: { __ks_cap: true, entry: { url: 'evil' } } });
  win.emit('message', { source: win, origin: 'https://evil.example', data: { __ks_cap: true, entry: { url: 'evil2' } } });
  win.emit('message', { source: win, origin: 'https://www.kagesekai.ai', data: { unrelated: true } });
  assert.strictEqual(sent.length, 1, 'only same-window, same-origin __ks_cap messages forwarded');

  // ---- 4. settings pushed by the background re-pushed into the page
  runtimeListeners.forEach((fn) => fn({ type: 'ks:pushSettings', settings: { enabled: false, captureFilter: '/messages' } }));
  // a stray captureFilter in the pushed settings is not forwarded
  assert.strictEqual(posted.length, 2);
  assert.deepStrictEqual(posted[1], { __ks_ctrl: true, enabled: false });

  // ---- 5. other runtime messages do not re-push; storage saves never reach this tab
  runtimeListeners.forEach((fn) => fn({ type: 'ks:changed' }));
  assert.strictEqual(posted.length, 2);
  assert.strictEqual(storageListeners.length, 0, 'no storage.onChanged listener (it would copy every save into the tab)');

  // ---- 6. rejected sendMessage swallowed (SW asleep / channel closed)
  sent.length = 0;
  globalThis.chrome.runtime.sendMessage = () => Promise.reject(new Error('sw gone'));
  win.emit('message', { source: win, origin: 'https://www.kagesekai.ai', data: { __ks_cap: true, entry: { url: 'u2' } } });
  await sleep(20); // an unhandled rejection would fail the process here

  console.log('PASS bridge: initial push, relay, spoof guards, change re-push, rejection swallowed');
})().catch((err) => { console.error(err); process.exit(1); });
