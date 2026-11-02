// External validation of the generated DOCX storybook: zip CRC, well-formed
// XML, the parts, and the content rules against the sample fixture.
//
// Expected text per non-OOC message, oldest first: the scene header's inner text
// (when the message opens with one) + the body, with the `*` of matched `*...*`
// spans and the `**` of matched `**...**` spans removed. The document text (all
// <w:t>, whitespace removed) must contain each expected text, in order. Also:
// user turns start with a bold run ending in ":" (one per user message, plus the
// hostile message the test adds), and every scene header paragraph is italic.
// With --colored, the file is the every-role-colored build: 5 parts (a page tint
// needs word/settings.xml + its relationship) and each role's run color checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZip, parseXml, all, child } from './officezip.mjs';

const [docxPath, samplePath] = process.argv.slice(2);
const colored = process.argv.includes('--colored');

const z = readZip(docxPath);
const PARTS = colored
  ? ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/settings.xml']
  : ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
assert.deepEqual([...z.names].sort(), [...PARTS].sort(), `${z.names}`); // part order in a zip is irrelevant
const trees = Object.fromEntries(z.names.map((n) => [n, parseXml(z.get(n).toString('utf8'))])); // CRC + well-formed
const doc = trees['word/document.xml'];
const paras = child(doc, 'body').kids.filter((k) => k.name === 'p');
assert.ok(paras.length, 'no paragraphs');

// Same patterns as ITALIC_SRC / BOLD_SRC in extension/lib/exporter.js (\w is Unicode in the Python-era original).
const ITALIC = /(?<![*\p{L}\p{N}_])\*(?![\s*])([^*\n]*?[^\s*])?\*(?![*\p{L}\p{N}_])/gu;
const BOLD = /(?<![*\p{L}\p{N}_])\*\*(?![\s*])([^*\n]*?[^\s*])?\*\*(?![*\p{L}\p{N}_])/gu;
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
  const stripped = body.replace(BOLD, (_, g) => g ?? '').replace(ITALIC, (_, g) => g ?? '');
  return [squash(header + stripped), header];
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
// the made-up messages tests/test-export.cjs appends (newest): a user turn and a story turn
expected.push(expectedText('evil <&> "quotes" *x*\nsecond line\n\nfourth after blank')[0]);
users += 1;
{
  const STORY = '<t>Day 4 · Dawn · The kitchen</t>\n\n“Quiet now,” she whispered, and the house held its breath. *Nothing stirs at this hour.* The kettle **began to rumble**, loud as thunder.';
  const [e, h] = expectedText(STORY);
  if (e) expected.push(e);
  if (h) headers.push(squash(h));
}

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
const SCENE_COLOR = colored ? '6D5BA6' : '7B5EA7';
const hdr = paras.filter((p) => runsOf(p).length && runsOf(p).every((r) => color(r) === SCENE_COLOR) && runT(runsOf(p)[0]) !== '✦');
assert.ok(hdr.every((p) => runsOf(p).every((r) => isOn(r, 'i'))), 'scene header not italic');
assert.deepEqual(hdr.map((p) => squash(runsOf(p).map(runT).join(''))), headers, 'scene headers differ from fixture');

const brs = all(doc, 'br').length;
assert.ok(brs >= 5, `expected >=5 preserved line breaks, got ${brs}`);

if (colored) {
  // the colors tests/test-export.cjs built the file with (kept here on purpose:
  // independent of the writers, like everything in this validator)
  const C = { narration: '2A2638', dialogue: 'B85C1E', thoughts: '8E8AA0', bold: 'A03030', scene: '6D5BA6', persona: '43386E', background: 'F7F5FA' };
  assert.equal(child(doc, 'background')?.attrs.color, C.background, 'page tint element');
  assert.ok(child(trees['word/settings.xml'], 'displayBackgroundShape'), 'displayBackgroundShape setting present');
  const runByText = (t) => paras.flatMap(runsOf).find((r) => runT(r) === t);
  const c = (t, label) => {
    const r = runByText(t);
    assert.ok(r, `no run with text ${JSON.stringify(t)}`);
    assert.equal(color(r), C[label], `run ${JSON.stringify(t.slice(0, 30))} color`);
    return r;
  };
  c('“Quiet now,”', 'dialogue');
  const b = c('began to rumble', 'bold');
  assert.ok(isOn(b, 'b'), 'bold run is bold');
  assert.ok(isOn(c('Nothing stirs at this hour.', 'thoughts'), 'i'), 'thoughts run is italic');
  c('Day 4 · Dawn · The kitchen', 'scene');
  c('Mira:', 'persona');
  const hostile = c('evil <&> "quotes" ', 'persona'); // user turn: quotes are not dialogue there
  { // the *x* span right after it: italic, still persona — user turns are not thoughts-colored
    const runs = paras.flatMap(runsOf);
    const x = runs[runs.indexOf(hostile) + 1];
    assert.equal(runT(x), 'x', 'run after the hostile text is the *x* span');
    assert.ok(isOn(x, 'i'), 'user-turn action italic');
    assert.equal(color(x), C.persona, 'user-turn action keeps the persona color');
  }
  c(', loud as thunder.', 'narration');
}

console.log(`DOCX VALID${colored ? ' (colored)' : ''}: ${expected.length} messages in order, ${turns.length} user turns, ${hdr.length} scene headers italic, ${brs} line breaks, ${PARTS.length} parts`);
