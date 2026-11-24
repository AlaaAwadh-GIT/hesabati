/* core.js — حسابات + تصدير Excel. يعمل في المتصفح وفي node للاختبار */
(function (G) {
  const T = { TR: 'تحويل', PC: 'تسديد عميل', PX: 'تسديد صراف' };
  const isNum = v => typeof v === 'number' && isFinite(v);
  const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

  function mineVal(t) {
    if (isNum(t.mine)) return t.mine;
    if (t.type === T.TR && isNum(t.amt) && isNum(t.pct)) return t.amt * t.pct;
    return null;
  }
  // نفس منطق العمود O: تاريخ صحيح (2020+) وإلا تاريخ الصف السابق
  function withEff(txs) {
    const s = [...txs].sort((a, b) => a.seq - b.seq);
    let prev = '';
    for (const t of s) {
      if (t.date && +t.date.slice(0, 4) >= 2020) prev = t.date;
      t._eff = prev;
      t._mine = mineVal(t);
    }
    return s;
  }
  function sum(txs, pred, f) { let s = 0; for (const t of txs) if (pred(t)) { const v = f(t); if (isNum(v)) s += v; } return s; }

  function clientBal(txs, cfg, i) {
    const n = cfg.clients[i]; if (!n) return null;
    return cfg.currencies.map((c, k) => {
      const owed = sum(txs, t => eq(t.client, n) && t.type === T.TR && eq(t.cur, c), t => t.amt)
        + sum(txs, t => eq(t.client, n) && t.type === T.TR && eq(t.cur, c), t => t._mine)
        + sum(txs, t => eq(t.client, n) && t.type === T.TR && eq(t.excCur, c) && t.charge !== 'لا', t => t.exc);
      const paid = sum(txs, t => eq(t.client, n) && t.type === T.PC && eq(t.cur, c), t => t.amt);
      const open = +(cfg.openClients[i] || [])[k] || 0;
      const comm = sum(txs, t => eq(t.client, n) && eq(t.cur, c), t => t._mine);
      return { owed, paid, open, bal: owed - paid + open, comm };
    });
  }
  function exBal(txs, cfg, i) {
    const n = cfg.exchangers[i]; if (!n) return null;
    return cfg.currencies.map((c, k) => {
      const owe = sum(txs, t => eq(t.ex, n) && t.type === T.TR && eq(t.cur, c), t => t.amt)
        + sum(txs, t => eq(t.ex, n) && t.type === T.TR && eq(t.excCur, c), t => t.exc);
      const paid = sum(txs, t => eq(t.ex, n) && t.type === T.PX && eq(t.cur, c), t => t.amt);
      const open = +(cfg.openEx[i] || [])[k] || 0;
      return { owe, paid, open, bal: paid - owe + open };
    });
  }
  function overview(txsRaw, cfg) {
    const txs = withEff(txsRaw);
    const clients = cfg.clients.map((_, i) => clientBal(txs, cfg, i));
    const exch = cfg.exchangers.map((_, i) => exBal(txs, cfg, i));
    const cur = cfg.currencies.map((c, k) => {
      const mine = sum(txs, t => eq(t.cur, c), t => t._mine);
      const exc = sum(txs, t => eq(t.excCur, c) && t.type === T.TR, t => t.exc);
      const cb = clients.reduce((s, r) => s + (r ? r[k].bal : 0), 0);
      const eb = exch.reduce((s, r) => s + (r ? r[k].bal : 0), 0);
      return { c, mine, exc, cb, eb, net: cb + eb };
    });
    return { txs, clients, exch, cur };
  }
  function monthKey(iso) { return iso ? iso.slice(0, 7) : ''; }
  function monthly(txs, cfg, months) {
    const r = cfg.rates.map(x => +x || 1);
    return months.map(m => {
      const inM = t => monthKey(t._eff) === m;
      let mine = 0, exc = 0;
      cfg.currencies.forEach((c, k) => {
        mine += sum(txs, t => inM(t) && eq(t.cur, c), t => t._mine) / r[k];
        exc += sum(txs, t => inM(t) && eq(t.excCur, c) && t.type === T.TR && t.charge !== 'نعم', t => t.exc) / r[k];
      });
      return { m, mine, exc, net: mine - exc };
    });
  }
  function monthList() { const a = []; for (let i = 0; i < 15; i++) { const y = 2026 + Math.floor((9 + i) / 12), mo = (9 + i) % 12 + 1; a.push(y + '-' + String(mo).padStart(2, '0')); } return a; }

  /* ---------------- تصدير Excel ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function pipe(u8, stream) { const s = new Blob([u8]).stream().pipeThrough(stream); return new Uint8Array(await new Response(s).arrayBuffer()); }
  const inflate = u8 => pipe(u8, new DecompressionStream('deflate-raw'));
  const deflate = u8 => pipe(u8, new CompressionStream('deflate-raw'));

  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22; while (dv.getUint32(e, true) !== 0x06054b50) e--;
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const out = [];
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fl));
      const lfl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
      const data = u8.subarray(lo + 30 + lfl + lxl, lo + 30 + lfl + lxl + csize);
      out.push({ name, method, crc, csize, usize, data });
      p += 46 + fl + xl + cl;
    }
    return out;
  }
  function writeZip(entries) {
    const parts = [], cen = []; let off = 0;
    const enc = new TextEncoder();
    for (const e of entries) {
      const nm = enc.encode(e.name);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, e.method, true);
      h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, e.crc, true); h.setUint32(18, e.csize, true); h.setUint32(22, e.usize, true);
      h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nm, e.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, e.method, true);
      c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.csize, true); c.setUint32(24, e.usize, true);
      c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nm);
      off += 30 + nm.length + e.data.length;
    }
    const cs = cen.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cs, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...cen, new Uint8Array(end.buffer)]);
  }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colNum = c => [...c].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0);
  function cellXml(ref, sAttr, v) {
    if (v == null || v === '') return `<c r="${ref}"${sAttr}/>`;
    if (v.f) return `<c r="${ref}"${sAttr}><f>${esc(v.f)}</f></c>`;
    if (typeof v === 'number') return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
    return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }
  // updates: {row: {COL: value}}
  function editSheet(xml, updates) {
    const done = new Set();
    const cre = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const fix = (rowNum, inner) => {
      const u = updates[rowNum]; const cells = [];
      inner.replace(cre, (m, col, r, attrs) => { cells.push({ col, xml: m, s: (attrs.match(/ s="\d+"/) || [''])[0] }); return m; });
      for (const col in u) {
        const ref = col + rowNum; let c = cells.find(x => x.col === col);
        if (!c) { c = { col, s: '' }; cells.push(c); }
        c.xml = cellXml(ref, c.s, u[col]);
      }
      cells.sort((a, b) => colNum(a.col) - colNum(b.col));
      return cells.map(c => c.xml).join('');
    };
    xml = xml.replace(/<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (m, r, attrs, inner) => {
      if (!updates[r]) return m; done.add(r);
      return `<row r="${r}"${attrs}>${fix(r, inner || '')}</row>`;
    });
    const missing = Object.keys(updates).filter(r => !done.has(r)).sort((a, b) => a - b);
    for (const r of missing) {
      const rowXml = `<row r="${r}">${fix(r, '')}</row>`;
      let placed = false;
      xml = xml.replace(/<row r="(\d+)"/g, (m, rr) => { if (!placed && +rr > +r) { placed = true; return rowXml + m; } return m; });
      if (!placed) xml = xml.replace('</sheetData>', rowXml + '</sheetData>');
    }
    return xml;
  }
  function serial(iso) { const [y, m, d] = iso.split('-').map(Number); const s = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; return s < 61 ? s - 1 : s; }
  const numOr = v => (v === undefined || v === null || v === '') ? null : v;
  function noteVal(v) { return v == null ? null : v; }

  async function buildXlsx(template, txs, cfg) {
    const b = typeof atob === 'function' ? Uint8Array.from(atob(template.b64), c => c.charCodeAt(0)) : new Uint8Array(Buffer.from(template.b64, 'base64'));
    const entries = readZip(b);
    const L = 'ABCDEFGHIJKL';
    const bySeq = new Map(txs.map(t => [t.seq, t]));
    const main = {};
    for (let r = 5; r <= 1004; r++) {
      const t = bySeq.get(r) || {}; const u = {};
      u.A = t.date ? serial(t.date) : (t.dateRaw || null);
      u.B = numOr(t.type); u.C = numOr(t.client); u.D = numOr(t.ex); u.E = numOr(t.cur); u.F = numOr(t.amt); u.G = numOr(t.pct);
      u.H = isNum(t.mine) ? t.mine : { f: `IF(AND(B${r}="تحويل",ISNUMBER(F${r}),ISNUMBER(G${r})),F${r}*G${r},"")` };
      u.I = numOr(t.exc); u.J = numOr(t.excCur); u.K = numOr(t.charge); u.L = noteVal(t.note);
      main[r] = u;
    }
    const set = {};
    for (let i = 0; i < 20; i++) (set[4 + i] = set[4 + i] || {}).B = cfg.clients[i] || null;
    for (let i = 0; i < 8; i++) (set[4 + i] = set[4 + i] || {}).C = cfg.exchangers[i] || null;
    const op = {}; const CC = 'BCDE';
    for (let i = 0; i < 20; i++) { op[6 + i] = {}; for (let k = 0; k < 4; k++) { const v = +(cfg.openClients[i] || [])[k] || 0; op[6 + i][CC[k]] = v || null; } }
    for (let i = 0; i < 8; i++) { op[29 + i] = {}; for (let k = 0; k < 4; k++) { const v = +(cfg.openEx[i] || [])[k] || 0; op[29 + i][CC[k]] = v || null; } }
    const bal = {}; for (let k = 0; k < 4; k++) bal[4 + k] = { O: +cfg.rates[k] || 1 };
    const plan = { [template.sheets.main]: main, [template.sheets.set]: set, [template.sheets.open]: op, [template.sheets.bal]: bal };
    // أسماء صفحات العملاء والصرافين = الأسماء في الإعدادات
    const used = new Set(['الرئيسية', 'الأرصدة', 'الإعدادات', 'الأرصدة الافتتاحية']), ren = {};
    const clean = s => String(s || '').replace(/[\[\]:*?\/\\']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
    const pick = (nm, gen) => { let n = clean(nm) || gen, k = 2; while (used.has(n)) n = (clean(nm).slice(0, 28) || gen) + ' ' + k++; used.add(n); if (n !== gen) ren[gen] = n; };
    for (let i = 0; i < 20; i++) pick(cfg.clients[i], 'عميل ' + (i + 1));
    for (let i = 0; i < 8; i++) pick(cfg.exchangers[i], 'الصراف ' + (i + 1));
    const xesc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const renameAll = x => x.replace(/'((?:عميل|الصراف) \d+)'!/g, (m, g) => ren[g] ? "'" + xesc(ren[g]) + "'!" : m);
    const out = [];
    for (const e of entries) {
      if (e.name === 'xl/workbook.xml' && Object.keys(ren).length) {
        let x = new TextDecoder().decode(e.method === 8 ? await inflate(e.data) : e.data);
        x = x.replace(/(<sheet\b[^>]*\bname=")((?:عميل|الصراف) \d+)(")/g, (m, a, g, b) => ren[g] ? a + xesc(ren[g]) + b : m);
        const u8 = new TextEncoder().encode(x), d = await deflate(u8);
        out.push({ name: e.name, method: 8, crc: crc32(u8), csize: d.length, usize: u8.length, data: d });
        continue;
      }
      if (plan[e.name] || /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) {
        let raw = e.method === 8 ? await inflate(e.data) : e.data;
        let x = renameAll(new TextDecoder().decode(raw));
        if (plan[e.name]) x = editSheet(x, plan[e.name]);
        const u8 = new TextEncoder().encode(x);
        const d = await deflate(u8);
        out.push({ name: e.name, method: 8, crc: crc32(u8), csize: d.length, usize: u8.length, data: d });
      } else out.push(e);
    }
    return writeZip(out);
  }
  /* ---------------- قراءة ملف Excel ---------------- */
  const unx = s => s.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-fA-F]+);/g, (m, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
      : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const textOf = x => { let s = ''; x.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => { s += t; return m; }); x.replace(/<t\s*\/>/g, ''); return unx(s); };
  function isoOf(v) { const s = v < 60 ? v + 1 : v; const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 864e5); return d.toISOString().slice(0, 10); }
  async function zipText(entries, name) {
    const e = entries.find(x => x.name === name || x.name === '/' + name); if (!e) return null;
    return new TextDecoder().decode(e.method === 8 ? await inflate(e.data) : e.data);
  }
  async function sheetFiles(entries) {
    const wb = await zipText(entries, 'xl/workbook.xml'), rels = await zipText(entries, 'xl/_rels/workbook.xml.rels');
    const tg = {}; (rels || '').replace(/<Relationship\b[^>]*>/g, m => { const id = (m.match(/\bId="([^"]+)"/) || [])[1], t = (m.match(/\bTarget="([^"]+)"/) || [])[1]; if (id && t) tg[id] = t.replace(/^\/?xl\//, '').replace(/^\//, ''); return m; });
    const out = []; (wb || '').replace(/<sheet\b[^>]*>/g, m => { const n = (m.match(/\bname="([^"]*)"/) || [])[1], id = (m.match(/\br:id="([^"]+)"/) || [])[1]; if (n != null && tg[id]) out.push({ name: unx(n), file: 'xl/' + tg[id] }); return m; });
    return out;
  }
  // cells: {"A5": {v, f}}
  function readCells(xml, ss) {
    const cells = {};
    xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, attrs, inner) => {
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1]; if (!ref || !inner) return m;
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const hasF = /<f\b/.test(inner); const vv = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let v = null;
      if (t === 's') v = vv != null ? ss[+vv] : null;
      else if (t === 'inlineStr') v = textOf((inner.match(/<is>([\s\S]*?)<\/is>/) || ['', ''])[1]);
      else if (t === 'str' || t === 'e') v = vv != null ? unx(vv) : null;
      else if (t === 'b') v = vv === '1';
      else if (vv != null && vv !== '') v = Number(vv);
      cells[ref] = { v, f: hasF };
      return m;
    });
    return cells;
  }
  async function parseXlsx(template, u8, baseCfg) {
    const tpl = readZip(Uint8Array.from(atob(template.b64), c => c.charCodeAt(0)));
    const entries = readZip(u8);
    const tplNames = await sheetFiles(tpl), names = await sheetFiles(entries);
    const fileFor = key => {
      const tf = template.sheets[key], tn = (tplNames.find(s => s.file === tf) || {}).name;
      const hit = names.find(s => s.name === tn); return hit ? hit.file : tf;
    };
    const ssx = await zipText(entries, 'xl/sharedStrings.xml'); const ss = [];
    if (ssx) ssx.replace(/<si>([\s\S]*?)<\/si>/g, (m, x) => { ss.push(textOf(x)); return m; });
    const sheet = async key => { const x = await zipText(entries, fileFor(key)); if (!x) throw new Error('missing sheet ' + key); return readCells(x, ss); };
    const M = await sheet('main'), S = await sheet('set'), P = await sheet('open'), B = await sheet('bal');
    const val = (c, r) => { const x = c[r]; if (!x || x.f) return null; const v = x.v; return (v === '' || v === null || typeof v === 'boolean') ? null : v; };
    const str = v => v == null ? undefined : String(v);
    const num = v => typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : undefined);
    const txs = [];
    for (let r = 5; r <= 1004; r++) {
      const o = { seq: r };
      const a = val(M, 'A' + r);
      if (typeof a === 'number') o.date = isoOf(a); else if (a != null && String(a).trim() !== '') o.dateRaw = String(a);
      const sv = (k, col) => { const v = val(M, col + r); if (v != null && v !== '') o[k] = str(v); };
      const nv = (k, col) => { const v = val(M, col + r); if (v == null || v === '') return; const n = num(v); o[k] = n !== undefined ? n : String(v); };
      sv('type', 'B'); sv('client', 'C'); sv('ex', 'D'); sv('cur', 'E'); nv('amt', 'F'); nv('pct', 'G');
      const h = M['H' + r]; if (h && !h.f && typeof h.v === 'number') o.mine = h.v;
      nv('exc', 'I'); sv('excCur', 'J'); sv('charge', 'K');
      const l = val(M, 'L' + r); if (l != null && l !== '') o.note = l;
      if (Object.keys(o).length > 1) txs.push(o);
    }
    const cfg = JSON.parse(JSON.stringify(baseCfg));
    const nm = v => v == null ? '' : String(v);
    for (let i = 0; i < 20; i++) cfg.clients[i] = nm(val(S, 'B' + (4 + i)));
    for (let i = 0; i < 8; i++) cfg.exchangers[i] = nm(val(S, 'C' + (4 + i)));
    const CC = 'BCDE';
    for (let i = 0; i < 20; i++) cfg.openClients[i] = [0, 1, 2, 3].map(k => num(val(P, CC[k] + (6 + i))) || 0);
    for (let i = 0; i < 8; i++) cfg.openEx[i] = [0, 1, 2, 3].map(k => num(val(P, CC[k] + (29 + i))) || 0);
    for (let k = 0; k < 4; k++) { const v = num(val(B, 'O' + (4 + k))); if (v) cfg.rates[k] = v; }
    return { cfg, txs };
  }
  G.Core = { T, isNum, eq, mineVal, withEff, overview, monthly, monthList, buildXlsx, parseXlsx, clientBal, exBal };
})(typeof window !== 'undefined' ? window : globalThis);
