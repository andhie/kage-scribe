// External validation of a generated XLSX: zip CRC integrity, well-formed XML
// in every member, sheet/row/cell structure, truncation and numeric cells.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';
import { readZip, parseXml, all, child } from './officezip.mjs';

XLSX.set_fs(fs);

const z = readZip(process.argv[2]);
const expected = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'];
assert.deepEqual(z.names, expected, `unexpected members: ${z.names}`);

const xml = Object.fromEntries(z.names.map((n) => [n, z.get(n)])); // checks every CRC
const trees = Object.fromEntries(z.names.map((n) => [n, parseXml(xml[n].toString('utf8'))])); // must be well-formed XML

const root = trees['xl/worksheets/sheet1.xml'];
const rows = all(child(root, 'sheetData'), 'row');
assert.equal(rows.length, 13, `sheet1 rows: ${rows.length}`); // header + 10 sample + evil + long

const cellText = (c) => child(child(c, 'is') ?? { kids: [] }, 't')?.text;
const header = rows[0].kids.map(cellText);
assert.ok(header.length === 19 && header.at(-1) === 'Block (20 msgs)', `header row: ${header}`);
const af = child(root, 'autoFilter');
assert.ok(af && af.attrs.ref === 'A1:S13', 'autoFilter must cover the header and every data row');
assert.equal(root.kids.at(-1), af, 'autoFilter follows sheetData');
assert.ok(!xml['xl/worksheets/sheet2.xml'].includes('autoFilter'), 'no filter on the Chats sheet');

const cells = rows.flatMap((r) => r.kids);
const texts = cells.map(cellText);
assert.ok(texts.some((t) => t?.includes('ünïcödé')), 'unicode content present');
const trunc = texts.filter((t) => t?.includes('…[truncated]'));
assert.equal(trunc.length, 1, `45k string truncated exactly once, got ${trunc.length}`);
assert.ok(cells.some((c) => child(c, 'v')?.text === '32308'), 'numeric cell present');

const sheets = all(trees['xl/workbook.xml'], 'sheet').map((s) => s.attrs.name);
assert.deepEqual(sheets, ['Messages', 'Chats'], `sheets: ${sheets}`);

// A real spreadsheet reader must open it and see what the raw XML says.
const wb = XLSX.readFile(process.argv[2]);
assert.deepEqual(wb.SheetNames, ['Messages', 'Chats'], 'sheetjs sheet names');
const ws = wb.Sheets.Messages;
const range = XLSX.utils.decode_range(ws['!ref']);
assert.equal(range.e.r - range.s.r + 1, 13, `sheetjs rows: ${ws['!ref']}`);
assert.equal(ws.S1.v, 'Block (20 msgs)', 'sheetjs header');
assert.ok(Array.from({ length: 19 }, (_, c) => ws[XLSX.utils.encode_cell({ r: 1, c })]?.v)
  .some((v) => typeof v === 'number'), 'sheetjs reads a numeric cell as a number');
assert.equal(ws['!autofilter']?.ref, 'A1:S13', 'sheetjs autoFilter');

console.log(`XLSX VALID: zip CRC ok, ${z.names.length} well-formed members, ${rows.length} rows, sheets=[${sheets}]`);
