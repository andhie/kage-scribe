/* Regenerates the README screenshots in docs/screenshots/ from the real
 * panel/popup UI, fed made-up chats by demo-shim.js (no real user data).
 * Run with: npm run screenshots   (needs Google Chrome; set CHROME=path to override) */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('../..', import.meta.url)));
const outDir = path.join(root, 'docs', 'screenshots');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) { console.error('Chrome not found; set CHROME=/path/to/chrome'); process.exit(1); }

const SHIM = '<script src="/tools/screenshots/demo-shim.js"></script>';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root + path.sep) || !existsSync(p)) { res.writeHead(404).end(); return; }
  let body = readFileSync(p);
  if (p.endsWith('.html')) body = String(body).replace('<head>', '<head>\n' + SHIM);
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/extension/`;

const shots = [
  ['panel-chats.png', 'panel/panel.html?shot=simple', '1200,720'],
  ['panel-messages.png', 'panel/panel.html?shot=advanced', '1200,800'],
  ['panel-style.png', 'panel/panel.html?shot=style', '1200,1120'],
  ['panel-developer.png', 'panel/panel.html?shot=developer', '1200,800'],
  ['popup.png', 'popup/popup.html', '320,235']
];
mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const [file, page, size] of shots) {
  // async: a sync spawn would block this process's server while Chrome loads from it
  const err = await new Promise((resolve) => execFile(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--force-device-scale-factor=2', `--window-size=${size}`, '--virtual-time-budget=4000',
    `--user-data-dir=${path.join(root, 'tests', 'out', 'chrome-profile')}`,
    `--screenshot=${path.join(outDir, file)}`, base + page
  ], { timeout: 60000 }, (e, _out, stderr) => resolve(e && stderr)));
  const ok = !err && existsSync(path.join(outDir, file));
  console.log(ok ? 'wrote' : 'FAIL', file);
  if (!ok) { failed++; console.error(err || ''); }
}
server.close();
process.exit(failed ? 1 : 0);
