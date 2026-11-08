/*
 * Kage Scribe — export library (CSV / JSON / XLSX).
 * Loaded by the dashboard panel as a plain <script>. The XLSX writer is
 * fully self-contained (store-only ZIP + SpreadsheetML with inline strings),
 * so the extension needs no bundled third-party code.
 */
(function (g) {
  'use strict';

  /* ================= CSV ================= */

  function csvCell(v) {
    if (v == null) return '""';
    let s = String(v);
    // Captured text that starts like a formula would run in Excel (CSV
    // injection): a leading apostrophe makes it plain text. Numbers stay as is.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** headers: string[]; rows: (string|number|boolean|null)[][] — returns CSV text (UTF-8 BOM included). */
  function toCSV(headers, rows) {
    const lines = [headers.map(csvCell).join(',')];
    for (const row of rows) lines.push(row.map(csvCell).join(','));
    return '\ufeff' + lines.join('\r\n');
  }

  /* ================= XLSX (store-only zip) ================= */

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const XLSX_CELL_LIMIT = 32000; // Excel hard cell limit is 32767 chars

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** files: [{name, data:Uint8Array}] -> zip bytes (all entries stored, not compressed). */
  function buildZip(files) {
    const enc = new TextEncoder();
    const parts = files.map((f) => {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      return { name, data, crc };
    });

    const localSize = parts.reduce((s, p) => s + 30 + p.name.length + p.data.length, 0);
    const centralSize = parts.reduce((s, p) => s + 46 + p.name.length, 0);
    const buf = new Uint8Array(localSize + centralSize + 22);
    const dv = new DataView(buf.buffer);
    let off = 0;

    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    const central = [];
    for (const p of parts) {
      dv.setUint32(off, 0x04034b50, true); off += 4;   // local file header signature
      dv.setUint16(off, 20, true); off += 2;           // version needed
      dv.setUint16(off, 0x0800, true); off += 2;       // flags: UTF-8 names
      dv.setUint16(off, 0, true); off += 2;            // method: store
      dv.setUint16(off, dosTime, true); off += 2;
      dv.setUint16(off, dosDate, true); off += 2;
      dv.setUint32(off, p.crc, true); off += 4;
      dv.setUint32(off, p.data.length, true); off += 4;
      dv.setUint32(off, p.data.length, true); off += 4;
      dv.setUint16(off, p.name.length, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;            // extra length
      buf.set(p.name, off); off += p.name.length;
      buf.set(p.data, off); off += p.data.length;
      central.push({ p, offset: off - p.data.length - 30 - p.name.length });
    }

    const cdStart = off;
    for (const { p, offset } of central) {
      dv.setUint32(off, 0x02014b50, true); off += 4;   // central directory signature
      dv.setUint16(off, 20, true); off += 2;           // version made by
      dv.setUint16(off, 20, true); off += 2;           // version needed
      dv.setUint16(off, 0x0800, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;            // method: store
      dv.setUint16(off, dosTime, true); off += 2;
      dv.setUint16(off, dosDate, true); off += 2;
      dv.setUint32(off, p.crc, true); off += 4;
      dv.setUint32(off, p.data.length, true); off += 4;
      dv.setUint32(off, p.data.length, true); off += 4;
      dv.setUint16(off, p.name.length, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;            // extra
      dv.setUint16(off, 0, true); off += 2;            // comment
      dv.setUint16(off, 0, true); off += 2;            // disk number
      dv.setUint16(off, 0, true); off += 2;            // internal attrs
      dv.setUint32(off, 0, true); off += 4;            // external attrs
      dv.setUint32(off, offset, true); off += 4;       // local header offset
      buf.set(p.name, off); off += p.name.length;
    }

    dv.setUint32(off, 0x06054b50, true); off += 4;     // EOCD
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, parts.length, true); off += 2;
    dv.setUint16(off, parts.length, true); off += 2;
    dv.setUint32(off, off - cdStart - 12, true); off += 4; // central dir size (off sits 12 bytes into EOCD)
    dv.setUint32(off, cdStart, true); off += 4;
    dv.setUint16(off, 0, true); off += 2;
    return buf;
  }

  function xmlEsc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function cellText(v) {
    let s = v == null ? '' : String(v);
    if (s.length > XLSX_CELL_LIMIT) s = s.slice(0, XLSX_CELL_LIMIT - 14) + ' …[truncated]';
    return s;
  }

  function sheetXml(headers, rows, opts) {
    const widths = headers.map((h, i) => {
      let max = String(h == null ? '' : h).length;
      const cap = Math.min(rows.length, 200);
      for (let r = 0; r < cap; r++) {
        const len = cellText(rows[r][i]).length;
        if (len > max) max = len;
      }
      return Math.max(8, Math.min(80, Math.ceil(max * 1.1)));
    });
    const colsXml = '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';

    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + colsXml + '<sheetData>';
    xml += '<row r="1">' + headers.map((h, c) =>
      '<c r="' + colName(c) + '1" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cellText(h)) + '</t></is></c>'
    ).join('') + '</row>';
    rows.forEach((row, r) => {
      const rn = r + 2;
      const cells = [];
      for (let c = 0; c < headers.length; c++) {
        const v = row[c];
        const ref = colName(c) + rn;
        if (typeof v === 'number' && isFinite(v)) {
          cells.push('<c r="' + ref + '"><v>' + v + '</v></c>');
        } else {
          cells.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cellText(v)) + '</t></is></c>');
        }
      }
      xml += '<row r="' + rn + '">' + cells.join('') + '</row>';
    });
    xml += '</sheetData>';
    if (opts && opts.autoFilter) xml += '<autoFilter ref="A1:' + colName(headers.length - 1) + (rows.length + 1) + '"/>';
    xml += '</worksheet>';
    return xml;
  }

  /**
   * sheets: [{name, headers: string[], rows: any[][], autoFilter?: boolean}] -> XLSX file bytes.
   */
  function buildXLSX(sheets) {
    const enc = new TextEncoder();
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name).slice(0, 31) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) }
    ];
    sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(sheetXml(s.headers, s.rows, s)) }));
    return buildZip(files);
  }

  /* ================= DOCX (wordprocessingml, store-only zip) ================= */

  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  // *action* → italic, asterisks dropped. `**` and a lone `*` stay text.
  // tests/validate_docx.py holds the same pattern: keep them identical.
  const ITALIC_SRC = '(?<![*\\w])\\*(?![\\s*])([^*\\n]*?[^\\s*])?\\*(?![*\\w])';
  // **strong** → bold, asterisks dropped; same lookaround contract as ITALIC_SRC.
  const BOLD_SRC = '(?<![*\\w])\\*\\*(?![\\s*])([^*\\n]*?[^\\s*])?\\*\\*(?![*\\w])';
  // A spoken span: straight or curly double quotes, never crossing a line.
  const DIALOGUE_SRC = '(?:"[^"\\n]+")|(?:“[^”\\n]+”)';

  // Leftmost span wins, nesting stays literal (as before). Capture layout:
  // STORY 1 bold, 2 bold text, 3 dialogue, 4 italic, 5 italic text.
  // PLAIN 1 bold, 2 bold text, 3 italic, 4 italic text.
  const STORY_MARKUP = new RegExp('(' + BOLD_SRC + ')|(' + DIALOGUE_SRC + ')|(' + ITALIC_SRC + ')', 'g');
  const PLAIN_MARKUP = new RegExp('(' + BOLD_SRC + ')|(' + ITALIC_SRC + ')', 'g');

  const BLUE = '1F4E79';
  const PURPLE = '7B5EA7';
  const GREY = '808080';

  /** One run. fmt: { b, i, sz (half-points), color }. */
  function run(text, fmt) {
    const f = fmt || {};
    const pr = (f.b ? '<w:b/>' : '') + (f.i ? '<w:i/>' : '') +
      (f.color ? '<w:color w:val="' + f.color + '"/>' : '') + (f.sz ? '<w:sz w:val="' + f.sz + '"/>' : '');
    return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>';
  }

  function para(runs, center) {
    return '<w:p><w:pPr><w:spacing w:after="120"/>' + (center ? '<w:jc w:val="center"/>' : '') + '</w:pPr>' + runs + '</w:p>';
  }

  const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  /** One line as runs: `**bold**`, quoted dialogue spans and `*…*` thoughts.
   *  The dialogue and thoughts colors tint story text only — a user turn
   *  keeps the persona color ('' inherits the base color). */
  function markupRuns(line, base, c, story) {
    const re = story ? STORY_MARKUP : PLAIN_MARKUP;
    const iText = story ? 5 : 4; // capture index of the italic span's text
    let out = '';
    let last = 0;
    for (const m of line.matchAll(re)) {
      if (m.index > last) out += run(line.slice(last, m.index), base);
      if (m[1] !== undefined) out += run(m[2] || '', { ...base, b: true, color: c.bold || base.color });
      else if (story && m[3] !== undefined) out += run(m[0], { ...base, color: c.dialogue || base.color });
      else out += run(m[iText] || '', { ...base, i: true, color: (story ? c.thoughts : '') || base.color });
      last = m.index + m[0].length;
    }
    return out + (last < line.length ? run(line.slice(last), base) : '');
  }

  /** Text as paragraphs on blank lines; a single "\n" stays <w:br/>.
   *  `lead` (runs) opens the first paragraph. */
  function textParas(text, fmt, lead, c, story) {
    const out = [];
    for (const block of String(text).split(/\n[ \t]*\n/)) {
      if (!block.trim()) continue;
      const runs = block.split('\n').map((l) => markupRuns(l, fmt, c, story)).join('<w:r><w:br/></w:r>');
      out.push(para((out.length ? '' : lead || '') + runs));
    }
    if (!out.length && lead) out.push(para(lead));
    return out;
  }

  /** Centered inline PNG, scaled to fit a storybook cover page. */
  function coverPara(relId, docId, width, height) {
    const w = width > 0 ? width : 3;
    const h = height > 0 ? height : 4;
    const maxCx = 3657600; // 4 in
    const maxCy = 4876800; // 5 1/3 in
    const scale = Math.min(maxCx / w, maxCy / h);
    const cx = Math.round(w * scale);
    const cy = Math.round(h * scale);
    return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:docPr id="' + docId + '" name="Story cover"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      '<pic:nvPicPr><pic:cNvPr id="0" name="cover.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }

  /**
   * Storybook from KSFlow.storyBlocks(): per chat a title block (title, site,
   * plot summary, message count), then the messages. A supplied PNG cover is
   * embedded as a media part; a page tint adds word/settings.xml. Word shows
   * the tint on screen, not in print. Chats after the first start on a new page. User turns: a ✦ break,
   * then the bold persona name. A scene header is a small italic line.
   * `colors` (optional, from KSFlow.resolveDocxColors): narration, dialogue,
   * thoughts, bold, scene, persona, background — '' inherits; the defaults
   * here equal KSFlow.DOCX_PRESETS.print.colors (test-export.cjs pins that).
   */
  function buildDOCX(story, colors) {
    const c = {
      narration: '', dialogue: '', thoughts: GREY, bold: '',
      scene: PURPLE, persona: BLUE, background: '',
      ...(colors || {})
    };
    const enc = new TextEncoder();
    const paragraphs = [];
    const covers = [];
    for (const chat of story.chats || []) {
      if (chat.cover && chat.cover.data instanceof Uint8Array) {
        covers.push({ chat, ...chat.cover, relId: 'rId' + ((c.background ? 2 : 1) + covers.length) });
      }
    }
    const date = timestamp().replace(/^(\d{4})(\d{2})(\d{2}).*$/, '$1-$2-$3');
    (story.chats || []).forEach((chat, ci) => {
      if (ci) paragraphs.push(pageBreak());
      paragraphs.push(para(run(chat.title, { b: true, sz: 36, color: c.narration }), true));
      const cover = covers.find((x) => x.chat === chat);
      if (cover) paragraphs.push(coverPara(cover.relId, ci + 1, cover.width, cover.height));
      if (chat.site) paragraphs.push(para(run('A story played on ' + chat.site + '.ai', { color: GREY }), true));
      if (chat.plotSummary) paragraphs.push(...textParas(chat.plotSummary, { color: c.narration }, null, c, false));
      paragraphs.push(para(run(chat.count + (chat.count === 1 ? ' message' : ' messages') + ' · exported ' + date, { sz: 18, color: GREY }), true));
      for (const it of chat.items) {
        if (it.isUser) paragraphs.push(para(run('✦', { color: c.persona }), true));
        if (it.header) paragraphs.push(para(run(it.header, { i: true, sz: 18, color: c.scene })));
        if (it.isUser) paragraphs.push(...textParas(it.text, { color: c.persona }, run(it.name + ':', { b: true, color: c.persona }) + '<w:r><w:t xml:space="preserve"> </w:t></w:r>', c, false));
        else paragraphs.push(...textParas(it.text, { color: c.narration }, null, c, true));
      }
    });
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      (c.background ? '<w:background w:color="' + c.background + '"/>' : '') +
      '<w:body>' + paragraphs.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (covers.length ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      (c.background ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : '') +
      '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) }
    ];
    if (c.background || covers.length) {
      const rels = (c.background
        ? '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
        : '') + covers.map((x, i) => '<Relationship Id="' + x.relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cover' + (i + 1) + '.png"/>').join('');
      files.push({ name: 'word/_rels/document.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>') });
    }
    if (c.background) {
      files.push({ name: 'word/settings.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:displayBackgroundShape/></w:settings>') });
    }
    covers.forEach((x, i) => files.push({ name: 'word/media/cover' + (i + 1) + '.png', data: x.data }));
    files.push({ name: 'word/document.xml', data: enc.encode(documentXml) });
    return buildZip(files);
  }

  /* ================= download ================= */

  /** Resolves to 'ok', 'cancelled' (the user closed the Save dialog) or 'failed'. */
  function download(filename, mime, data) {
    const blob = (data instanceof Uint8Array)
      ? new Blob([data], { type: mime })
      : new Blob([data], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return chrome.downloads.download(
      { url, filename, saveAs: true, conflictAction: 'uniquify' }
    ).then(
      () => {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return 'ok';
      },
      (err) => {
        URL.revokeObjectURL(url);
        if (/cancel/i.test(String((err && err.message) || err))) return 'cancelled';
        console.warn('[KageScribe] download failed:', err);
        return 'failed';
      }
    );
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  g.KSExport = { toCSV, buildXLSX, buildDOCX, download, timestamp, ITALIC_SRC, BOLD_SRC, DIALOGUE_SRC, XLSX_MIME, DOCX_MIME };
})(typeof self !== 'undefined' ? self : globalThis);
