// Independent zip + XML readers for the XLSX/DOCX validators. Deliberately not
// extension code: they must not share bugs with the writers in lib/exporter.js.
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (buf) => (buf.reduce((c, b) => CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

/** Read a zip: member names in central-directory order, and a get(name) that checks the CRC. */
export function readZip(path) {
  const buf = readFileSync(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const files = new Map();
  for (let p = buf.readUInt32LE(eocd + 16), i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, { method, crc, raw: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...files.keys()],
    get(name) {
      const f = files.get(name);
      if (!f) throw new Error(`no zip member ${name}`);
      const data = f.method === 0 ? f.raw : f.method === 8 ? inflateRawSync(f.raw) : null;
      if (!data) throw new Error(`${name}: unsupported compression ${f.method}`);
      if (crc32(data) !== f.crc) throw new Error(`CRC failure in ${name}`);
      return data;
    },
  };
}

const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const decode = (s) => {
  if (s.replace(ENTITY, '').includes('&')) throw new Error(`bad entity in ${JSON.stringify(s.slice(0, 40))}`);
  return s.replace(ENTITY, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[e]
    ?? String.fromCodePoint(e[2] === 'x' ? parseInt(e.slice(3, -1), 16) : +e.slice(2, -1)));
};
const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;

/** Strict-enough XML parser: throws unless tags nest and close, entities are valid and there is one root.
 *  Names are local (prefix stripped); node = { name, attrs, kids, text } (text = own text only). */
export function parseXml(xml) {
  const top = { name: '#doc', attrs: {}, kids: [], text: '' };
  const stack = [top];
  for (const m of xml.matchAll(TOKEN)) {
    const cur = stack.at(-1);
    if (m[7]) throw new Error('stray "<"');
    if (m[6] !== undefined) {
      if (stack.length === 1) { if (m[6].trim()) throw new Error('text outside the root'); continue; }
      cur.text += decode(m[6]);
    } else if (m[1] !== undefined) {
      cur.text += m[1];
    } else if (m[3]) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2]) {
        if (stack.length === 1 || cur.name !== name) throw new Error(`</${m[3]}> closes <${cur.name}>`);
        stack.pop();
      } else {
        const attrs = {};
        for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '')] = decode(a[2] ?? a[3]);
        const node = { name, attrs, kids: [], text: '' };
        cur.kids.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1).name}> never closed`);
  if (top.kids.length !== 1) throw new Error(`${top.kids.length} root elements`);
  return top.kids[0];
}

/** All descendants of node (depth-first), optionally only those with this local name. */
export const all = (node, name) => node.kids.flatMap((k) => [...(!name || k.name === name ? [k] : []), ...all(k, name)]);
export const child = (node, name) => node.kids.find((k) => k.name === name);
