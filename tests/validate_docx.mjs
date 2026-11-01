// External validation of the generated DOCX storybook: zip CRC, well-formed
// XML, 3 parts, and the content rules against the sample fixture.
//
// Expected text per non-OOC message, oldest first: the scene header's inner text
// (when the message opens with one) + the body, with the `*` of matched `*...*`
// spans removed. The document text (all <w:t>, whitespace removed) must contain
// each expected text, in order. Also: user turns start with a bold run ending in
// ":" (one per user message, plus the hostile message the test adds), and every
// scene header paragraph (colour 7B5EA7) is italic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZip, parseXml, all, child } from './officezip.mjs';

const [docxPath, samplePath] = process.argv.slice(2);

const z = readZip(docxPath);
assert.deepEqual(z.names, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'], `${z.names}`);
const trees = Object.fromEntries(z.names.map((n) => [n, parseXml(z.get(n).toString('utf8'))])); // CRC + well-formed
const doc = trees['word/document.xml'];
const paras = child(doc, 'body').kids.filter((k) => k.name === 'p');
assert.ok(paras.length, 'no paragraphs');

// Same pattern as ITALIC_SRC in extension/lib/exporter.js (\w is Unicode in the Python-era original).
const ITALIC = /(?<![*\p{L}\p{N}_])\*(?![\s*])([^*\n]*?[^\s*])?\*(?![*\p{L}\p{N}_])/gu;
// Same as SCENE_HEADER_RE in extension/lib/exportflow.js.
const HEADER = /^\s*<\s*t\s*>([\s\S]*?)<\s*\/\s*t\s*>\s*/i;

const squash = (t) => t.replace(/\s+/g, '');

function selected(m) {
  const cs = (m.choices ?? []).filter(Boolean);
  const hit = cs.find((c) => c._id === m._selectedChoiceId);
  if (hit) return hit;
  const ci = m.choiceIndex;
  if (Number.isInteger(ci) && ci >= 0 && ci < cs.length) return cs[ci];
  return cs[0] ?? null;
}

function expectedText(content) {
  const h = HEADER.exec(content);
  const [header, body] = h ? [h[1].trim(), content.slice(h[0].length)] : ['', content];
  return [squash(header + body.replace(ITALIC, (_, g) => g ?? '')), header];
}

const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
const msgs = [...sample.data.data].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
const expected = [], headers = [];
let users = 0;
for (const m of msgs) {
  if (m.type === 'ooc') continue;
  const [e, h] = expectedText(selected(m)?.content ?? '');
  if (e) expected.push(e);
  if (h) headers.push(squash(h));
  users += m.role === 'user';
}
// the made-up message tests/test-export.cjs appends (newest, a user turn)
expected.push(expectedText('evil <&> "quotes" *x*\nsecond line\n\nfourth after blank')[0]);
users += 1;

const runsOf = (p) => p.kids.filter((k) => k.name === 'r');
const runT = (r) => r.kids.filter((k) => k.name === 't').map((t) => t.text).join('');
const isOn = (r, tag) => !!child(child(r, 'rPr') ?? { kids: [] }, tag);
const color = (r) => child(child(r, 'rPr') ?? { kids: [] }, 'color')?.attrs.val;

const docText = squash(paras.flatMap(runsOf).map(runT).join(''));
let pos = 0;
expected.forEach((e, i) => {
  const at = docText.indexOf(e, pos);
  assert.ok(at >= 0, `message ${i} missing or out of order: ${JSON.stringify(e.slice(0, 60))}`);
  pos = at + e.length;
});
assert.ok(!docText.includes('OOC-SECRET'), 'an OOC message is in the document');

// user turns: first run bold and ending in ":"
const turns = paras.filter((p) => runsOf(p).length && isOn(runsOf(p)[0], 'b') && runT(runsOf(p)[0]).endsWith(':'));
assert.equal(turns.length, users, `${turns.length} bold-name paragraphs for ${users} user messages`);
assert.ok(turns.every((p) => runT(runsOf(p)[0]) === 'Mira:'), 'persona name');

// scene headers: found by colour, all italic; one per fixture header
const hdr = paras.filter((p) => runsOf(p).length && runsOf(p).every((r) => color(r) === '7B5EA7') && runT(runsOf(p)[0]) !== '✦');
assert.ok(hdr.every((p) => runsOf(p).every((r) => isOn(r, 'i'))), 'scene header not italic');
assert.deepEqual(hdr.map((p) => squash(runsOf(p).map(runT).join(''))), headers, 'scene headers differ from fixture');

const brs = all(doc, 'br').length;
assert.ok(brs >= 5, `expected >=5 preserved line breaks, got ${brs}`);
console.log(`DOCX VALID: ${expected.length} messages in order, ${turns.length} user turns, ${hdr.length} scene headers italic, ${brs} line breaks, 3 parts`);
