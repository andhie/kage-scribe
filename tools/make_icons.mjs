#!/usr/bin/env node
// Generate extension icons (16/48/128 px) with no external deps: the Kage Scribe
// 'shadow quill': a white quill with a violet shadow and a cyan ink line on an
// indigo rounded square.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tag, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(tag, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function writePng(path, size, pixelFn) {
  const rows = Buffer.alloc(size * (1 + size * 4)); // each row: filter byte 0 (none) + RGBA
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x++) Buffer.from(pixelFn(x, y)).copy(rows, row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const INDIGO = [30, 27, 75], VIOLET = [124, 92, 255], WHITE = [255, 255, 255], CYAN = [34, 211, 238];

function bezier(p0, p1, p2, p3, n = 24) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([0, 1].map(k => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]));
  }
  return pts;
}

// Quill body on a 128-unit grid: two curves from the tip (98,18) to the nib (34,90).
const QUILL = [[98, 18], ...bezier([98, 18], [66, 22], [42, 48], [34, 90]), ...bezier([34, 90], [52, 86], [76, 66], [98, 18])];

function inPoly(x, y, poly) {
  let hit = false;
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) hit = !hit;
  });
  return hit;
}

function nearSeg(x, y, [ax, ay], [bx, by], width) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const ex = x - ax - t * dx, ey = y - ay - t * dy;
  return ex * ex + ey * ey <= (width / 2) ** 2;
}

// Concept A 'shadow quill' at one point of the 128-unit grid, or null outside the tile.
function colour(x, y, small) {
  const rad = 30;
  const cx = Math.min(Math.max(x, rad), 128 - rad), cy = Math.min(Math.max(y, rad), 128 - rad);
  if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) return null;
  if (nearSeg(x, y, [54, 102], [98, 102], 8)) return CYAN;
  if (nearSeg(x, y, [34, 90], [26, 104], 7)) return WHITE;
  if (inPoly(x, y, QUILL)) {
    // the vein is under a pixel wide at 16 px, so it only smudges there
    return !small && nearSeg(x, y, [90, 28], [40, 84], 4) ? INDIGO : WHITE;
  }
  if (inPoly(x - 7, y - 7, QUILL)) return VIOLET;
  return INDIGO;
}

// Python's round() is half-to-even; keep it so the alpha edges match the old script.
function roundHalfEven(v) {
  const f = Math.floor(v), d = v - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f + (f % 2);
}

function make(size, ss = 4) {
  const k = 128 / size;
  return (px, py) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < ss; i++) {
      for (let j = 0; j < ss; j++) {
        const c = colour((px + (i + 0.5) / ss) * k, (py + (j + 0.5) / ss) * k, size < 32);
        if (c) { a++; r += c[0]; g += c[1]; b += c[2]; }
      }
    }
    if (!a) return [0, 0, 0, 0];
    return [Math.floor(r / a), Math.floor(g / a), Math.floor(b / a), roundHalfEven(255 * a / (ss * ss))];
  };
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 48, 128]) {
  const path = join(OUT, `icon${s}.png`);
  writePng(path, s, make(s));
  console.log('wrote', path);
}
