/* Test runner: syntax checks + every test file + external XLSX validation.
 * Run with: npm test   (or: node tests/run-all.mjs) */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

const syntaxFiles = [
  'background.js', 'content/hook.js', 'content/bridge.js',
  'lib/merge.js', 'lib/exporter.js', 'lib/exportflow.js',
  'panel/panel.js', 'popup/popup.js'
];
const tests = [
  'test-merge.cjs',    // envelope extraction, selected choice, rows, sorting
  'test-xhr.cjs',      // XHR interception: headers, body, SSE, json, disable
  'test-hook.mjs',     // fetch interception: capture, filter, ctrl, errors
  'test-bridge.cjs',   // page<->SW relay, settings push, spoof guards
  'test-background.cjs', // SW: state, merge, dedup, caps, fetch-all, lifecycle
  'test-export.cjs',   // CSV round-trip, XLSX bytes, wide tables
  'test-flow.cjs'      // export scope filters + load-before-export wait loop
];

function run(label, cmd, args, cwd = root) {
  console.log(`\n━━━ ${label} ━━━`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.status !== 0) {
    console.log(`FAIL ${label}`);
    return false;
  }
  return true;
}

let failed = 0;

for (const f of syntaxFiles) {
  if (!run(`syntax ${f}`, 'node', ['--check', path.join('extension', f)])) failed++;
}

for (const t of tests) {
  if (!run(t, 'node', [path.join(root, 'tests', t)])) failed++;
}

const xlsx = path.join(root, 'tests', 'out', 'messages.xlsx');
if (existsSync(xlsx)) {
  console.log('\n━━━ validate_xlsx.mjs ━━━');
  const r = spawnSync('node', [path.join(root, 'tests', 'validate_xlsx.mjs'), xlsx], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('FAIL validate_xlsx.mjs');
    failed++;
  }
} else {
  console.log('\n(validate_xlsx.mjs skipped — no xlsx generated)');
}

const docx = path.join(root, 'tests', 'out', 'transcript.docx');
if (existsSync(docx)) {
  console.log('\n━━━ validate_docx.mjs ━━━');
  const r = spawnSync('node', [path.join(root, 'tests', 'validate_docx.mjs'), docx, path.join(root, 'tests', 'sample.json')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('FAIL validate_docx.mjs');
    failed++;
  }
} else {
  console.log('\n(validate_docx.mjs skipped — no docx generated)');
}

console.log(failed ? `\n${failed} step(s) FAILED` : `\nALL TESTS PASSED`);
process.exit(failed ? 1 : 0);
