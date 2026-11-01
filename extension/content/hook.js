/*
 * Kage Scribe — network hook (runs in the page's MAIN world).
 * Patches window.fetch and XMLHttpRequest before the app loads, captures
 * matching responses (cloned, so the page is unaffected) and relays them to
 * the ISOLATED-world bridge via window.postMessage.
 */
(() => {
  if (window.__ksHookInstalled) return;
  window.__ksHookInstalled = true;

  const DEFAULT_FILTER = '/api/';
  const MAX_BODY = 4000000;
  const MAX_REQ_BODY = 200000;

  let enabled = true;
  const re = new RegExp(DEFAULT_FILTER, 'i'); // fixed: page scripts cannot widen it

  function want(url) {
    return enabled && re.test(url);
  }

  /** Relay one capture; adds the fields every capture shares. */
  function post(started, entry) {
    const common = { ts: Date.now(), durationMs: Math.round(performance.now() - started), source: 'live' };
    try { window.postMessage({ __ks_cap: true, entry: { ...common, ...entry } }, window.location.origin); } catch (e) { /* page being torn down */ }
  }

  function headersToMap(h) {
    if (!h) return {};
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const o = {};
        h.forEach((v, k) => { o[k] = v; });
        return o;
      }
      if (Array.isArray(h)) {
        const o = {};
        for (const pair of h) if (pair && pair.length >= 2) o[pair[0]] = pair[1];
        return o;
      }
      if (typeof h === 'object') return { ...h };
    } catch (e) { /* ignore */ }
    return {};
  }

  function bodyPreview(b) {
    try {
      if (b == null) return '';
      if (typeof b === 'string') return b.slice(0, MAX_REQ_BODY);
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString().slice(0, MAX_REQ_BODY);
      if (typeof FormData !== 'undefined' && b instanceof FormData) return '[FormData]';
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ']';
      return '[' + ((b.constructor && b.constructor.name) || typeof b) + ']';
    } catch (e) {
      return '';
    }
  }

  /* ---------------- fetch ---------------- */

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      let reqHeaders = {};
      let reqBody = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const m = (init && init.method) || (input && typeof input.method === 'string' && input.method);
        method = String(m || 'GET').toUpperCase();
        reqHeaders = headersToMap((init && init.headers) || (input && input.headers));
        reqBody = bodyPreview(init && init.body);
      } catch (e) { /* best effort */ }

      const matched = want(url);
      const started = performance.now();
      const pr = origFetch.apply(this, arguments);
      if (!matched) return pr;

      pr.then((res) => {
        try {
          const ct = (res.headers && res.headers.get('content-type')) || '';
          if (/event-stream/i.test(ct)) return; // SSE token streams: skip
          res.clone().text().then(
            (text) => post(started, {
              method, url,
              status: res.status,
              ok: res.ok,
              contentType: ct,
              requestHeaders: reqHeaders,
              requestBody: reqBody,
              credentials: (init && init.credentials) || 'same-origin',
              body: text.slice(0, MAX_BODY)
            }),
            () => { /* body unreadable */ }
          );
        } catch (e) { /* ignore */ }
      }, (err) => {
        try {
          post(started, {
            method, url,
            status: 0,
            ok: false,
            contentType: '',
            requestHeaders: reqHeaders,
            requestBody: reqBody,
            credentials: 'same-origin',
            body: '',
            error: String((err && err.message) || err)
          });
        } catch (e) { /* ignore */ }
      });
      return pr;
    };
  }

  /* ---------------- XMLHttpRequest ---------------- */

  const XHR = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (XHR && XHR.open && XHR.send) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;

    XHR.open = function (method, url) {
      const r = origOpen.apply(this, arguments);
      try {
        this.__ksMeta = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: {} };
      } catch (e) { /* ignore */ }
      return r;
    };

    XHR.setRequestHeader = function (k, v) {
      try { if (this.__ksMeta) this.__ksMeta.headers[k] = v; } catch (e) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };

    XHR.send = function (body) {
      const meta = this.__ksMeta;
      if (meta && want(meta.url)) {
        const started = performance.now();
        const reqBody = bodyPreview(body);
        this.addEventListener('loadend', () => {
          try {
            const ct = this.getResponseHeader('content-type') || '';
            if (/event-stream/i.test(ct)) return;
            let text = '';
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json' && this.response != null) text = JSON.stringify(this.response);
            post(started, {
              method: meta.method,
              url: meta.url,
              status: this.status,
              ok: this.status >= 200 && this.status < 300,
              contentType: ct,
              requestHeaders: meta.headers,
              requestBody: reqBody,
              credentials: this.withCredentials ? 'include' : 'same-origin',
              body: text.slice(0, MAX_BODY)
            });
          } catch (e) { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ---------------- control channel (from bridge) ---------------- */

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ks_ctrl !== true) return;
    if (typeof d.enabled === 'boolean') enabled = d.enabled;
  });
})();
