/* Test: CSV + XLSX exporters. Writes real files to tests/out for external
 * validation (unzip -t, XML parsing). */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

require('../extension/lib/merge.js');
require('../extension/lib/exporter.js');
require('../extension/lib/exportflow.js');
const M = globalThis.KSMerge;
const E = globalThis.KSExport;
const F = globalThis.KSFlow;

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// --- build merged rows from the real sample, plus adversarial values
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8'));
const msgs = M.extractMessages(sample);
const headers = M.MERGED_COLUMNS.map(([, h]) => h);
const rows = M.sortMessages(msgs, 'asc').map((m, i) => M.MERGED_COLUMNS.map(([k]) => M.messageToRow(m, i + 1)[k]));

// adversarial row: quotes, commas, newlines, unicode, >32k text (XLSX truncation)
const long = 'x'.repeat(45000);
const evil = ['1', new Date().toISOString(), 'user', 'Evil "Quote", Name', 'normal',
  'line1\nline2\ttab "quoted", comma — ünïcödé 🎉', 'model v1.2', 32308, 300, 32608, 'length', 0.0064155, 143277,
  'sexual=none', false, 'id<>&\'', 'chat&id', 'choice', 2];

const allRows = rows.concat([evil, ['2', '', '', '', '', long, '', '', '', '', '', '', '', '', '', '', '', '', '']]);

// --- CSV
const csv = E.toCSV(headers, allRows);
fs.writeFileSync(path.join(outDir, 'messages.csv'), csv, 'utf8');
assert.ok(csv.startsWith('\ufeff'), 'BOM for Excel');
assert.ok(csv.includes('"line1\nline2\ttab ""quoted"", comma'), 'CSV escaping');

// formula-like text cells get a leading apostrophe; numbers and plain text do not
const inj = E.toCSV(['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  [['=HYPERLINK("http://x")', '+1', '- list item', '@SUM(A1)', '\tx', -5, 'a=b']]).split('\r\n')[1];
assert.strictEqual(inj, '"\'=HYPERLINK(""http://x"")","\'+1","\'- list item","\'@SUM(A1)","\'\tx","-5","a=b"', 'CSV formula injection blocked');

// round-trip parse
function parseCsv(text) {
  const s = text.replace(/^\ufeff/, '');
  const out = [];
  let row = [], cell = '', i = 0, inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
      cell += c; i++;
    } else if (c === '"') { inQ = true; i++; }
    else if (c === ',') { row.push(cell); cell = ''; i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++; }
    else { cell += c; i++; }
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out;
}
const parsed = parseCsv(csv);
assert.strictEqual(parsed.length, allRows.length + 1, 'header + all rows round-trip');
assert.strictEqual(parsed[0].length, headers.length);
const evilRow = parsed.find((r) => r[15] === "id<>&'");
assert.ok(evilRow, 'evil row found by its Message ID');
assert.strictEqual(evilRow[5], 'line1\nline2\ttab "quoted", comma — ünïcödé 🎉', 'evil cell survived round-trip');
assert.strictEqual(evilRow[3], 'Evil "Quote", Name', 'quoted comma cell survived');
assert.strictEqual(evilRow[7], '32308', 'numeric cell as text');
assert.ok(/^\d+$/.test(parsed[1][7]), 'sample numeric cell serialized');
assert.strictEqual(parsed[parsed.length - 1][5], long, 'long content NOT truncated in CSV');

// --- XLSX
const xlsx = E.buildXLSX([
  { name: 'Messages', headers, rows: allRows, autoFilter: true },
  { name: 'Chats', headers: ['Chat ID', 'Messages'], rows: [['6adf35d941b1d32e4ee75f98', 10]] }
]);
fs.writeFileSync(path.join(outDir, 'messages.xlsx'), xlsx);
assert.ok(xlsx.length > 1000, 'xlsx produced');
assert.ok(xlsx[0] === 0x50 && xlsx[1] === 0x4b, 'zip magic PK');
// entries are STOREd (uncompressed), so raw-byte assertions are reliable
// (note: Buffer receiver — Uint8Array#includes is element-membership, not substring)
const xbuf = Buffer.from(xlsx);
assert.ok(xbuf.includes(Buffer.from('<v>32308</v>')), 'numeric cells written as <v>');
assert.ok(xbuf.includes(Buffer.from('<autoFilter ref="A1:S13"/>')), 'filter row over all 19 columns and 12 data rows');
assert.ok(!Buffer.from(E.buildXLSX([{ name: 'Chats', headers: ['a'], rows: [[1]] }])).includes(Buffer.from('autoFilter')), 'off unless asked');
assert.ok(xbuf.includes(Buffer.from('<v>10</v>')), 'sheet2 numeric cell');
assert.ok(!csv.includes(String.fromCharCode(0)), 'no NUL bytes');

// --- wide table: 30 columns exercises AA.. refs
const wideHeaders = Array.from({ length: 30 }, (_, i) => 'C' + (i + 1));
const wideX = E.buildXLSX([{ name: 'Wide', headers: wideHeaders, rows: [Array.from({ length: 30 }, (_, i) => 'v' + i)] }]);
const wideBuf = Buffer.from(wideX);
assert.ok(wideBuf.includes(Buffer.from('r="AA1"')), 'column AA referenced');
assert.ok(wideBuf.includes(Buffer.from('r="AD1"')), 'column AD referenced');
fs.writeFileSync(path.join(outDir, 'wide.xlsx'), wideX);

// --- DOCX storybook: KSFlow.storyBlocks over the fixture + a hostile user message + an OOC message
const CHAT_ID = msgs[0]._chatId;
const usr = (id, createdAt, content) => ({ _id: id, _chatId: CHAT_ID, role: 'user', type: 'normal', createdAt,
  choices: [{ _id: id + 'c', content, characterName: 'Mira' }] });
const hostile = usr('hostile-1', '2099-01-01T00:00:00.000Z', 'evil <&> "quotes" *x*\nsecond line\n\nfourth after blank');
const ooc = { ...usr('ooc-1', '2099-01-01T00:00:01.000Z', 'OOC-SECRET'), type: 'ooc' };
const PLOT = 'A made-up plot summary & more.';
const story = F.storyBlocks(msgs.concat([hostile, ooc]), { [CHAT_ID]: { name: 'Test <Story>', site: 'isekaizero', plotSummary: PLOT } });
const docx = E.buildDOCX(story);
fs.writeFileSync(path.join(outDir, 'transcript.docx'), docx);
assert.ok(docx[0] === 0x50 && docx[1] === 0x4b, 'docx zip magic');
const dbuf = Buffer.from(docx);
assert.ok(dbuf.includes(Buffer.from('word/document.xml')), 'document part present');
const docXml = (buf) => {
  const b = Buffer.from(buf).toString('utf8');
  return b.slice(b.indexOf('<w:document'), b.indexOf('</w:document>'));
};
const wt = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
  .map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')).join('|');
const xml = docXml(docx);
const text = wt(xml);
assert.ok(xml.includes('<w:br/>'), 'internal newlines become line breaks');
assert.ok(text.startsWith('Test <Story>|A story played on isekaizero.ai|' + PLOT + '|'), 'title block first: ' + text.slice(0, 120));
assert.ok(/\d+ messages · exported \d{4}-\d{2}-\d{2}/.test(text), 'count line with date');
assert.ok(text.includes('Mira:'), 'persona name before user text');
assert.ok(!/< ?\/? ?t ?>/.test(text), 'no scene header tag left');
assert.ok(text.includes('evil <&> "quotes" |x'), 'hostile text unescaped in the text, asterisks gone');
assert.ok(xml.includes('evil &lt;&amp;&gt; &quot;quotes&quot;') && xml.includes('Test &lt;Story&gt;'), 'and escaped in the XML');
assert.ok(!text.includes('OOC-SECRET'), 'OOC message left out');
assert.ok(xml.includes('<w:i/>'), 'italic runs');
assert.strictEqual((Buffer.from(docx).toString('latin1').match(/PK\x03\x04/g) || []).length, 3, 'still 3 zip parts');

// shared pattern with tests/validate_docx.py: the cases the design names
const italics = (line) => [...line.matchAll(new RegExp(E.ITALIC_SRC, 'g'))].map((m) => m[1]);
assert.deepStrictEqual(italics('*a*'), ['a']);
assert.deepStrictEqual(italics('*a* b *c*'), ['a', 'c']);
assert.deepStrictEqual(italics('**bold** and * lone * and 2*3*4'), []);
assert.deepStrictEqual(italics('he *waits, quietly.* ok'), ['waits, quietly.']);
// without a plot summary: only the other title block lines
const noPlot = wt(docXml(E.buildDOCX({ chats: [{ title: 'T', site: '', plotSummary: '', count: 0, items: [] }] })));
assert.ok(/^T\|0 messages · exported /.test(noPlot), noPlot);
// two chats: a page break between them, none before the first
const two = docXml(E.buildDOCX({ chats: [1, 2].map((n) => ({ title: 'C' + n, site: '', plotSummary: '', count: 0, items: [] })) }));
assert.strictEqual((two.match(/w:type="page"/g) || []).length, 1);
// empty story: a valid document with an empty body
const empty = E.buildDOCX({ chats: [] });
assert.ok(!Buffer.from(empty).toString('utf8').includes('<w:t'), 'empty story has no text');

// --- download(): 'ok' / 'cancelled' / 'failed'
(async () => {
  const warn = console.warn;
  console.warn = () => {}; // the 'failed' case logs on purpose
  const result = (impl) => {
    globalThis.chrome = { downloads: { download: impl } };
    return E.download('x.csv', 'text/csv', 'a,b');
  };
  assert.strictEqual(await result(async () => 1), 'ok');
  assert.strictEqual(await result(async () => { throw new Error('Download canceled by the user'); }), 'cancelled');
  assert.strictEqual(await result(async () => { throw new Error('Invalid filename'); }), 'failed');
  console.warn = warn;
  console.log('PASS export: csv rows=%d xlsx bytes=%d wide=%d docx=%d (written to tests/out for unzip/xml checks)', parsed.length - 1, xlsx.length, wideX.length, docx.length);
})().catch((err) => { console.error(err); process.exit(1); });
