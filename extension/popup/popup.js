/* Kage Scribe — popup: status, counts, and the door to the panel. */
'use strict';

const $ = (s) => document.querySelector(s);

// Where friends get a new version. Not set yet: the repo has no remote (design
// "Open Questions"). While empty, the warning shows without its button.
const RELEASES_URL = '';

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...(extra || {}) }).catch(() => null);
}

function showEnabled(on) {
  $('#liveDot').classList.toggle('off', !on);
  $('#statusText').textContent = on ? 'Capturing' : 'Paused';
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago" from epoch ms. */
function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const unit = (n, w) => n + ' ' + w + (n === 1 ? '' : 's') + ' ago';
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

async function refresh() {
  const r = await send('ks:getState');
  if (!r || r.error) return;
  const on = !!r.settings.enabled;
  $('#tglEnabled').checked = on;
  showEnabled(on);

  // The warning only shows while capture is on: a paused extension captured nothing.
  const broken = on && !!(r.health && r.health.formatError);
  $('#health').hidden = !broken;
  $('#btnUpdate').hidden = !RELEASES_URL;
  $('#liveDot').classList.toggle('bad', broken);
  if (broken) $('#statusText').textContent = 'Capture problem';
  const at = r.health && r.health.lastSavedAt;
  $('#lastSaved').textContent = at ? 'Last chat saved: ' + relTime(at) : 'No chat saved yet';

  $('#stats').textContent = '';
  const b = document.createElement('b');
  b.textContent = r.liveChats;
  $('#stats').append(b, ' ' + (r.liveChats === 1 ? 'chat' : 'chats') + ', ');
  const b2 = document.createElement('b');
  b2.textContent = r.liveMessages;
  $('#stats').append(b2, ' ' + (r.liveMessages === 1 ? 'message' : 'messages') + ' saved');
}

$('#tglEnabled').addEventListener('change', async (e) => {
  await send('ks:settings', { settings: { enabled: e.target.checked } });
  refresh(); // not showEnabled(): the warning depends on the switch too
});

$('#btnUpdate').addEventListener('click', () => {
  if (RELEASES_URL) chrome.tabs.create({ url: RELEASES_URL });
});

$('#btnOpen').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html') });
  window.close();
});

$('#version').textContent = 'v' + chrome.runtime.getManifest().version;
refresh();
