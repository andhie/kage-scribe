/* Test: XMLHttpRequest interception path of the MAIN-world hook.
 * A minimal fake XHR class provides the transport; the hook's real prototype
 * wrapping (open/setRequestHeader/send/loadend) is exercised for real. */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('node:events');

const sampleBody = fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8');

const captured = [];
class Win extends EventEmitter {
  constructor() {
    super();
    this.location = { origin: 'https://www.isekaizero.ai' };
  }
  addEventListener(type, fn) { this.on(type, fn); }
  postMessage(data, origin) {
    assert.strictEqual(origin, 'https://www.isekaizero.ai', 'posts to page origin only');
    if (data && data.__ks_cap === true) captured.push(data.entry);
  }
}

class FakeXHR {
  constructor() {
    this._listeners = {};
    this._ct = null;
    this.status = 0;
    this.responseText = '';
    this.responseType = '';
    this.withCredentials = false;
  }
  // "real" implementations the hook wraps around
  open(method, url) { this.__opened = { method, url }; }
  setRequestHeader(k, v) { (this.__hdr = this.__hdr || {})[k] = v; }
  send() { this.__sent = true; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  getResponseHeader(name) {
    return String(name).toLowerCase() === 'content-type' ? this._ct : null;
  }
  __respond(status, body, contentType) {
    this.status = status;
    this.responseText = body;
    this._ct = contentType;
    (this._listeners.loadend || []).forEach((fn) => fn());
  }
}

const win = new Win();
globalThis.window = win;
globalThis.XMLHttpRequest = FakeXHR;
win.XMLHttpRequest = FakeXHR;

new Function(fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'hook.js'), 'utf8'))();
assert.ok(win.__ksHookInstalled, 'hook installed');
assert.ok(FakeXHR.prototype.open.toString().includes('__ksMeta'), 'XHR.open wrapped by hook');
assert.ok(FakeXHR.prototype.setRequestHeader.toString().includes('__ksMeta'), 'setRequestHeader wrapped');

// ---- 1. matching XHR captured with headers + body
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/api/chats/abc123/messages?page=1&pageSize=10');
  x.setRequestHeader('Authorization', 'Bearer tok');
  x.setRequestHeader('Accept', 'application/json');
  x.withCredentials = true;
  x.send(null);
  x.__respond(200, sampleBody, 'application/json');

  assert.strictEqual(captured.length, 1);
  const e = captured[0];
  assert.strictEqual(e.method, 'GET');
  assert.strictEqual(e.status, 200);
  assert.ok(e.ok);
  assert.strictEqual(e.body, sampleBody, 'full body captured');
  assert.strictEqual(e.requestHeaders.Authorization, 'Bearer tok', 'auth header captured for replay');
  assert.strictEqual(e.requestHeaders.Accept, 'application/json');
  assert.strictEqual(e.credentials, 'include', 'withCredentials mapped');
  assert.ok(e.url.includes('/api/chats/abc123/messages'));
  assert.ok(e.ts > 0 && e.durationMs >= 0);
  assert.strictEqual(e.source, 'live');
}

// ---- 2. non-matching URL not captured
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/static/logo.png');
  x.send();
  x.__respond(200, 'binary', 'image/png');
  assert.strictEqual(captured.length, 1);
}

// ---- 3. SSE stream skipped
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/api/chats/abc/messages?page=1');
  x.send();
  x.__respond(200, 'data: token\n\n', 'text/event-stream');
  assert.strictEqual(captured.length, 1, 'event-stream not captured');
}

// ---- 4. responseType=json stringified instead of responseText
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/api/chats/abc/messages?page=2');
  x.send();
  x.responseType = 'json';
  Object.defineProperty(x, 'response', { value: JSON.parse(sampleBody), configurable: true });
  x.__respond(200, '', 'application/json'); // responseText unavailable for responseType=json
  assert.strictEqual(captured.length, 2);
  const e = captured[1];
  assert.ok(e.body.startsWith('{"code"'), 'json response serialized');
  assert.ok(JSON.parse(e.body).data.data.length === 10, 'round-trips');
}

// ---- 5. HTTP error status still captured (not ok)
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/api/chats/abc/messages?page=3');
  x.send();
  x.__respond(500, '{"error":"boom"}', 'application/json');
  assert.strictEqual(captured.length, 3);
  assert.strictEqual(captured[2].status, 500);
  assert.ok(!captured[2].ok);
}

// ---- 6. disabled via control channel
win.emit('message', { source: win, data: { __ks_ctrl: true, enabled: false } });
{
  const x = new XMLHttpRequest();
  x.open('GET', 'https://api-us.isekaizero.ai/api/chats/abc/messages?page=4');
  x.send();
  x.__respond(200, '{}', 'application/json');
  assert.strictEqual(captured.length, 3, 'disabled hook captures nothing');
}

console.log('PASS xhr: %d entries captured (headers, body, sse, json, error, disable)', captured.length);
