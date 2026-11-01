/* Test: the MAIN-world fetch hook, run in Node with a window shim and a local
 * HTTP server standing in for the site's API. Verifies capture entry shape,
 * filtering, and the enable/disable control channel. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { EventEmitter } from 'node:events';
import assert from 'node:assert';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const sampleBody = fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8');

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-probe', '1');
  if (req.url.includes('page=2')) res.end('{"data":{"data":[],"totalPages":2}}');
  else res.end(sampleBody);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- window shim (stands in for the page)
const captured = [];
class Win extends EventEmitter {
  constructor() {
    super();
    this.location = { origin: 'https://www.kagesekai.ai' };
  }
  addEventListener(type, fn) { this.on(type, fn); }
  postMessage(data, origin) {
    assert.strictEqual(origin, 'https://www.kagesekai.ai', 'posts to page origin only');
    if (data && data.__ks_cap === true) captured.push(data.entry);
  }
}
const win = new Win();
globalThis.window = win;
win.fetch = globalThis.fetch.bind(globalThis); // what the page would expose

// install the hook exactly as the content script would
new Function(fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'hook.js'), 'utf8'))();
assert.ok(win.__ksHookInstalled, 'hook installed');

// ---- 1. matching URL is captured
const res1 = await win.fetch(`${base}/api/chats/6adf35d941b1d32e4ee75f98/messages?page=1&pageSize=10`);
assert.strictEqual(res1.status, 200);
assert.ok(await res1.json(), 'page can still read the body (clone not consumed)');
await new Promise((r) => setTimeout(r, 100));
assert.strictEqual(captured.length, 1, 'one entry captured');
const e = captured[0];
assert.strictEqual(e.method, 'GET');
assert.strictEqual(e.status, 200);
assert.ok(e.ok);
assert.ok(e.url.includes('/api/chats/6adf35d941b1d32e4ee75f98/messages'));
assert.strictEqual(e.body, sampleBody, 'full response body captured');
assert.ok(e.contentType.includes('application/json'));
assert.strictEqual(e.source, 'live');
assert.ok(typeof e.durationMs === 'number' && e.durationMs >= 0);
assert.ok(e.ts > 0);

// ---- 2. non-matching URL is not captured
await win.fetch(`${base}/static/app.js`);
await new Promise((r) => setTimeout(r, 50));
assert.strictEqual(captured.length, 1, 'non-matching URL skipped');

// ---- 3. a `filter` on the control channel is ignored; '/api/' still applies
win.emit('message', { source: win, data: { __ks_ctrl: true, enabled: true, filter: '/messages' } });
await win.fetch(`${base}/api/users/me`);
await win.fetch(`${base}/api/chats/abc/messages?page=2`);
await win.fetch(`${base}/static/other.js`);
await new Promise((r) => setTimeout(r, 100));
assert.strictEqual(captured.length, 3, 'both /api/ URLs captured, the non-/api/ one not');
win.emit('message', { source: win, data: { __ks_ctrl: true, enabled: true, filter: '.*' } });
await win.fetch(`${base}/static/wide.js`);
await new Promise((r) => setTimeout(r, 50));
assert.strictEqual(captured.length, 3, 'a widening filter is ignored too');

// ---- 4. disable stops capture entirely
win.emit('message', { source: win, data: { __ks_ctrl: true, enabled: false } });
await win.fetch(`${base}/api/chats/zzz/messages?page=1`);
await new Promise((r) => setTimeout(r, 50));
assert.strictEqual(captured.length, 3, 'disabled hook captures nothing');

// ---- 6. network error captured with status 0
win.emit('message', { source: win, data: { __ks_ctrl: true, enabled: true } });
await assert.doesNotReject(() => win.fetch('http://127.0.0.1:1/api/nope').catch(() => {}));
await new Promise((r) => setTimeout(r, 50));
assert.strictEqual(captured.length, 4, 'error response captured');
const errEntry = captured[captured.length - 1];
assert.strictEqual(errEntry.status, 0);
assert.ok(!errEntry.ok);

server.close();
console.log('PASS hook: %d entries captured, filter/ctrl/error paths OK', captured.length);
