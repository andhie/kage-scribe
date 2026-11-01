/*
 * Kage Scribe — bridge (runs in the ISOLATED world).
 * Forwards hook captures to the background service worker and pushes the
 * pause switch (`enabled`) into the page. The capture filter is fixed in hook.js.
 */
(() => {
  const origin = window.location.origin;

  function pushSettings(s) {
    window.postMessage({
      __ks_ctrl: true,
      enabled: !!(s && s.enabled)
    }, origin);
  }

  chrome.storage.local.get({ ks_settings: { enabled: true } })
    .then((got) => pushSettings(got && got.ks_settings))
    .catch(() => {});

  // Changes come from the background, not storage.onChanged: that event would
  // copy every save of the (multi-MB) capture store into this tab.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ks:pushSettings') pushSettings(msg.settings);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== origin) return;
    const d = e.data;
    if (!d || d.__ks_cap !== true) return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'ks:capture', entry: d.entry });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) { /* service worker unavailable */ }
  });
})();
