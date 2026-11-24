/* zip.js — قراءة وكتابة ملفات Excel بدون أي مكتبة خارجية (يشتغل بدون إنترنت) */
(function (G) {
  'use strict';
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function pipe(u8, stream) { const s = new Blob([u8]).stream().pipeThrough(stream); return new Uint8Array(await new Response(s).arrayBuffer()); }
  const inflate = u8 => pipe(u8, new DecompressionStream('deflate-raw'));
  const deflate = u8 => pipe(u8, new CompressionStream('deflate-raw'));
  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22; while (dv.getUint32(e, true) !== 0x06054b50) e--;
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fl));
      const lfl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
      out.push({ name, method, crc, csize, usize, data: u8.subarray(lo + 30 + lfl + lxl, lo + 30 + lfl + lxl + csize) });
      p += 46 + fl + xl + cl;
    }
    return out;
  }
  function writeZip(entries) {
    const parts = [], cen = []; let off = 0; const enc = new TextEncoder();
    for (const e of entries) {
      const nm = enc.encode(e.name), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, e.method, true);
      h.setUint16(12, 0x21, true); h.setUint32(14, e.crc, true); h.setUint32(18, e.csize, true); h.setUint32(22, e.usize, true); h.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(h.buffer), nm, e.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, e.method, true);
      c.setUint16(14, 0x21, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.csize, true); c.setUint32(24, e.usize, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + e.data.length;
    }
    const cs = cen.reduce((s, a) => s + a.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cs, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...cen, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  async function packed(name, text) { const u8 = new TextEncoder().encode(text), d = await deflate(u8); return { name, method: 8, crc: crc32(u8), csize: d.length, usize: u8.length, data: d }; }

  /* بديل صغير لـ JSZip بنفس الدوال اللي يستخدمها تطبيق العسل */
  const JSZip = {
    async loadAsync(data, opt) {
      const u8 = opt && opt.base64 ? Uint8Array.from(atob(data), c => c.charCodeAt(0)) : new Uint8Array(data);
      const entries = readZip(u8), over = {};
      return {
        file(name, content) {
          if (content !== undefined) { over[name] = String(content); return this; }
          const e = entries.find(x => x.name === name); if (!e && over[name] == null) return null;
          return { async: async () => over[name] != null ? over[name] : new TextDecoder().decode(e.method === 8 ? await inflate(e.data) : e.data) };
        },
        async generateAsync() {
          const out = [];
          for (const e of entries) out.push(over[e.name] != null ? await packed(e.name, over[e.name]) : e);
          for (const n in over) if (!entries.some(e => e.name === n)) out.push(await packed(n, over[n]));
          return writeZip(out);
        }
      };
    }
  };

  /* ملف Excel بسيط من جداول: [{name, rows:[[...]], widths:[...]}] */
  const xe = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colL = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  async function makeXlsx(sheets) {
    const files = [];
    files.push(await packed('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'));
    files.push(await packed('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
    files.push(await packed('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${xe(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'));
    files.push(await packed('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
    files.push(await packed('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>'));
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      const cols = s.widths ? '<cols>' + s.widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
      const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
        const ref = colL(ci) + (ri + 1);
        if (v == null || v === '') return '';
        if (ri === 0) return `<c r="${ref}" s="1" t="inlineStr"><is><t>${xe(v)}</t></is></c>`;
        if (typeof v === 'number') return `<c r="${ref}" s="3"><v>${v}</v></c>`;
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return `<c r="${ref}" s="2"><v>${(Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5}</v></c>`; }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
      }).join('') + '</row>').join('');
      files.push(await packed(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`));
    }
    return writeZip(files);
  }
  G.HZip = { readZip, writeZip, inflate, deflate, crc32, makeXlsx };
  if (!G.JSZip) G.JSZip = JSZip;
})(window);
