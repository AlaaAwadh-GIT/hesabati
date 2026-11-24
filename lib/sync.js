/* sync.js — حفظ محلي بدون إنترنت + مزامنة مع Google Sheets
   يوفّر نفس واجهة قاعدة البيانات اللي تستخدمها التطبيقات (collection/doc/set/delete/onSnapshot)
   البيانات تنحفظ أولاً في IndexedDB على الجهاز، وترتفع لـ Google لما يتوفر الإنترنت. */
(function () {
  'use strict';
  const APP = document.documentElement.dataset.app;
  const LINK_KEY = 'hesabati-link';
  const IDB_NAME = 'hesabati', STORE = 'docs', META = 'meta';
  const BASE = new URL(document.currentScript.src.replace(/lib\/sync\.js.*$/, ''), location.href).href;

  /* ---------- الربط ---------- */
  const b64u = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function getLink() { try { const l = JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); return l && l.u ? l : null; } catch (e) { return null; } }
  function setLink(u) { localStorage.setItem(LINK_KEY, JSON.stringify({ u })); }
  function linkUrl() { const l = getLink(); return l ? BASE + '#link=' + b64u(JSON.stringify({ u: l.u })) : ''; }
  const validExec = u => /^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(String(u).trim());
  // رابط الربط في العنوان: #link=...
  (function takeLinkFromHash() {
    const m = location.hash.match(/#link=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try { const o = JSON.parse(unb64u(m[1])); if (o && validExec(o.u)) { setLink(o.u); sessionStorage.setItem('hesabati-linked', '1'); } } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  })();

  /* ---------- IndexedDB ---------- */
  let idb = null;
  const openIdb = () => new Promise((ok, bad) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'k' }); if (!d.objectStoreNames.contains(META)) d.createObjectStore(META); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  const tx = (stores, mode, fn) => new Promise((ok, bad) => {
    const t = idb.transaction(stores, mode); const out = fn(t); t.oncomplete = () => ok(out); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error);
  });
  const putRecs = recs => tx([STORE], 'readwrite', t => { const s = t.objectStore(STORE); recs.forEach(r => s.put(r)); });
  const setMeta = (k, v) => tx([META], 'readwrite', t => t.objectStore(META).put(v, APP + '|' + k));
  const getMeta = k => new Promise(ok => { const r = idb.transaction([META]).objectStore(META).get(APP + '|' + k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(undefined); });

  /* ---------- الذاكرة ---------- */
  const recs = new Map(); // key col|id -> {k, app, col, id, data, del, ts, dirty}
  const subs = new Map(); // col -> Set(cb)
  const docSubs = new Map(); // col|id -> Set(cb)
  let lastTs = 0;
  const nowTs = () => { const t = Math.max(Date.now(), lastTs + 1); lastTs = t; return t; };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const key = (col, id) => col + '|' + id;

  const ready = (async () => {
    try { idb = await openIdb(); } catch (e) { idb = null; }
    if (idb) {
      await new Promise(ok => {
        const r = idb.transaction([STORE]).objectStore(STORE).openCursor();
        r.onsuccess = () => { const c = r.result; if (!c) return ok(); const v = c.value; if (v.app === APP) { recs.set(key(v.col, v.id), v); lastTs = Math.max(lastTs, v.ts || 0); } c.continue(); };
        r.onerror = () => ok();
      });
    }
  })();

  function colSnap(col) {
    const docs = [...recs.values()].filter(r => r.col === col && !r.del).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(r => ({ id: r.id, data: () => clone(r.data), exists: true }));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } };
  }
  function docSnap(col, id) {
    const r = recs.get(key(col, id)); const ex = !!(r && !r.del);
    return { id, exists: ex, data: () => ex ? clone(r.data) : undefined, metadata: { fromCache: false } };
  }
  const notifyQ = new Set(); let notifyT = null;
  function notify(col, id) {
    notifyQ.add(col + '\u0000' + id);
    if (notifyT) return;
    notifyT = setTimeout(() => {
      const q = [...notifyQ]; notifyQ.clear(); notifyT = null;
      const cols = new Set();
      for (const s of q) { const [c, i] = s.split('\u0000'); cols.add(c); (docSubs.get(key(c, i)) || []).forEach(cb => safe(cb, docSnap(c, i))); }
      cols.forEach(c => (subs.get(c) || []).forEach(cb => safe(cb, colSnap(c))));
    }, 0);
  }
  const safe = (cb, v) => { try { cb(v); } catch (e) { console.error(e); } };

  async function write(col, id, data, del) {
    await ready;
    const r = { k: APP + '|' + col + '|' + id, app: APP, col, id: String(id), data: del ? null : clone(data), del: del ? 1 : 0, ts: nowTs(), dirty: 1 };
    recs.set(key(col, r.id), r);
    if (idb) await putRecs([r]);
    notify(col, r.id); schedule(800); status();
  }

  function docRef(col, id) {
    id = String(id);
    return {
      id,
      set: v => write(col, id, v, false),
      update: v => { const r = recs.get(key(col, id)); return write(col, id, Object.assign({}, r && !r.del ? r.data : {}, v), false); },
      delete: () => write(col, id, null, true),
      get: async () => { await ready; return docSnap(col, id); },
      onSnapshot(cb) {
        const k = key(col, id); if (!docSubs.has(k)) docSubs.set(k, new Set()); docSubs.get(k).add(cb);
        ready.then(() => safe(cb, docSnap(col, id)));
        return () => docSubs.get(k).delete(cb);
      }
    };
  }
  function colRef(col) {
    const self = {
      doc: id => docRef(col, id == null ? Date.now().toString(36) + Math.random().toString(36).slice(2, 7) : id),
      limit: () => self, orderBy: () => self, where: () => self,
      get: async () => { await ready; return colSnap(col); },
      onSnapshot(cb) {
        if (!subs.has(col)) subs.set(col, new Set()); subs.get(col).add(cb);
        ready.then(() => safe(cb, colSnap(col)));
        return () => subs.get(col).delete(cb);
      }
    };
    return self;
  }
  const db = {
    collection: colRef,
    doc: path => { const [c, i] = path.split('/'); return docRef(c, i); },
    // كتابة عدد كبير دفعة واحدة (للاستيراد)
    async bulk(list) { // [{col,id,data,del}]
      await ready; const out = [];
      for (const x of list) { const r = { k: APP + '|' + x.col + '|' + x.id, app: APP, col: x.col, id: String(x.id), data: x.del ? null : clone(x.data), del: x.del ? 1 : 0, ts: nowTs(), dirty: 1 }; recs.set(key(r.col, r.id), r); out.push(r); }
      if (idb) await putRecs(out);
      out.forEach(r => notify(r.col, r.id)); schedule(300); status();
    },
    all: col => [...recs.values()].filter(r => r.col === col && !r.del).map(r => ({ id: r.id, ...clone(r.data) }))
  };

  /* ---------- المزامنة ---------- */
  let syncing = false, again = false, timer = null, lastOk = 0, lastErr = '', excelBuilder = null, excelBusy = false;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(sync, ms); }
  const pending = () => [...recs.values()].filter(r => r.dirty).length;

  async function post(body) {
    const l = getLink(); if (!l) throw new Error('nolink');
    const res = await fetch(l.u, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json(); if (!j.ok) throw new Error(j.error || 'server');
    return j;
  }

  async function sync() {
    await ready;
    if (!getLink() || APP === 'launcher') { status(); return; }
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { status(); return; }
    syncing = true; status();
    try {
      let rounds = 0;
      do {
        const since = (await getMeta('since')) || 0;
        const dirty = [...recs.values()].filter(r => r.dirty).slice(0, 400);
        const sent = new Map(dirty.map(r => [r.k, r.ts]));
        const j = await post({ op: 'sync', app: APP, since, changes: dirty.map(r => ({ col: r.col, id: r.id, data: r.data, del: r.del, ts: r.ts })) });
        const changed = [];
        for (const r of dirty) { const cur = recs.get(key(r.col, r.id)); if (cur && cur.dirty && sent.get(cur.k) === cur.ts) { cur.dirty = 0; changed.push(cur); } }
        for (const d of j.docs || []) {
          const k = key(d.col, d.id), cur = recs.get(k);
          if (cur && cur.dirty && cur.ts > d.ts) continue; // تعديلي المحلي أحدث وراح يرتفع
          if (cur && !cur.dirty && cur.ts === d.ts && cur.del === d.del) continue;
          const r = { k: APP + '|' + d.col + '|' + d.id, app: APP, col: d.col, id: String(d.id), data: d.del ? null : d.data, del: d.del ? 1 : 0, ts: d.ts, dirty: 0 };
          recs.set(k, r); changed.push(r); lastTs = Math.max(lastTs, d.ts); notify(d.col, r.id);
        }
        if (idb && changed.length) await putRecs(changed);
        if (j.cursor != null) await setMeta('since', j.cursor);
        lastOk = Date.now(); lastErr = '';
        if (j.excelDue && excelBuilder && !excelBusy) setTimeout(uploadExcel, 1500);
      } while (pending() && ++rounds < 20);
    } catch (e) {
      lastErr = e && e.message === 'nolink' ? '' : 'تعذّر الاتصال';
    } finally {
      syncing = false; status();
      if (again) { again = false; schedule(500); }
    }
  }

  async function blobToB64(blob) { const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  async function uploadExcel(force) {
    if (!excelBuilder || excelBusy || !getLink() || !navigator.onLine) return false;
    excelBusy = true;
    try {
      const { blob, name } = await excelBuilder();
      await post({ op: 'excel', app: APP, name, b64: await blobToB64(blob), force: !!force });
      return true;
    } catch (e) { return false; } finally { excelBusy = false; }
  }

  window.addEventListener('online', () => schedule(300));
  window.addEventListener('scroll', () => { if (pill) status(); }, { passive: true });
  window.addEventListener('offline', status);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);

  /* ---------- شارة الحالة ---------- */
  const css = `#hs-pill{position:fixed;top:max(8px,env(safe-area-inset-top));left:8px;z-index:9999;font:600 12px/1 "IBM Plex Sans Arabic",Tahoma,sans-serif;border:0;border-radius:999px;padding:8px 12px;min-height:32px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18);display:flex;align-items:center;gap:6px;direction:rtl}
#hs-pill.ok{background:#0f7a52;color:#fff}#hs-pill.wait{background:#d4a73c;color:#1b1404}#hs-pill.busy{background:#3f6ad8;color:#fff}#hs-pill.off{background:#c62828;color:#fff}
#hs-pill i{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.85}
#hs-pill.mini{padding:0;width:22px;min-height:22px;height:22px;justify-content:center;font-size:0;opacity:.9}#hs-pill.mini i{background:#fff}
#hs-pane{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:none;align-items:flex-end;justify-content:center;direction:rtl;font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif}
#hs-pane.on{display:flex}
#hs-box{background:#fff;color:#111;width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:18px 18px 0 0;padding:18px 16px 24px;font-size:15px;line-height:1.6}
@media(prefers-color-scheme:dark){#hs-box{background:#16201b;color:#eef}}
#hs-box h3{margin:0 0 8px;font-size:18px}#hs-box p{margin:6px 0}
#hs-box input,#hs-box textarea{width:100%;font:inherit;font-size:14px;padding:10px;border:1px solid #bbb;border-radius:10px;direction:ltr;background:transparent;color:inherit}
#hs-box button{font:inherit;min-height:44px;border-radius:10px;border:1px solid #bbb;background:transparent;color:inherit;padding:8px 14px;cursor:pointer;margin:4px 0 4px 6px}
#hs-box button.p{background:#0f5a43;color:#fff;border-color:#0f5a43}
#hs-box .row{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}#hs-box .m{opacity:.7;font-size:13px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  let pill = null;
  function ensurePill() {
    if (pill || !document.body) return pill;
    pill = document.createElement('button'); pill.id = 'hs-pill'; pill.type = 'button'; pill.onclick = openPane;
    document.body.appendChild(pill);
    const pane = document.createElement('div'); pane.id = 'hs-pane'; pane.innerHTML = '<div id="hs-box"></div>';
    pane.onclick = e => { if (e.target === pane) pane.classList.remove('on'); };
    document.body.appendChild(pane);
    return pill;
  }
  function status() {
    if (!ensurePill()) return;
    const n = pending(), l = getLink();
    let cls, txt;
    if (!l) { cls = 'off'; txt = 'غير مربوط بـ Google'; }
    else if (APP === 'launcher') { cls = navigator.onLine ? 'ok' : 'wait'; txt = navigator.onLine ? 'مربوط بـ Google ✓' : 'بدون إنترنت · كل شي محفوظ'; }
    else if (syncing) { cls = 'busy'; txt = 'جاري المزامنة…'; }
    else if (n && !navigator.onLine) { cls = 'wait'; txt = n + ' تعديل ينتظر الإنترنت'; }
    else if (n) { cls = 'wait'; txt = n + ' تعديل ينتظر الرفع'; }
    else if (!navigator.onLine) { cls = 'wait'; txt = 'بدون إنترنت · محفوظ على الجهاز'; }
    else if (lastErr) { cls = 'wait'; txt = lastErr; }
    else if (lastOk) { cls = 'ok'; txt = 'متزامن ✓'; }
    else { cls = 'busy'; txt = 'جاري الاتصال…'; }
    pill.className = cls + (cls === 'ok' && window.scrollY > 60 ? ' mini' : ''); pill.innerHTML = '<i></i>' + txt; pill.title = txt;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function openPane() {
    const pane = document.getElementById('hs-pane'), box = document.getElementById('hs-box'); const l = getLink();
    const when = lastOk ? new Date(lastOk).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }) : '—';
    box.innerHTML = l ? `<h3>المزامنة مع Google</h3>
      <p>تعديلات تنتظر الرفع: <b>${pending()}</b> · آخر مزامنة: <b>${when}</b></p>
      <p class="m">كل تعديل ينحفظ على هذا الجهاز فوراً، حتى بدون إنترنت، ويرتفع لحاله لما يرجع الاتصال.</p>
      <div class="row"><button class="p" id="hs-now">زامن الآن</button><button id="hs-xl">احفظ نسخة Excel في Drive الآن</button><a href="${BASE}"><button>كل التطبيقات</button></a></div>
      <h3 style="margin-top:16px">ربط جهاز ثاني</h3>
      <p class="m">افتح هذا الرابط على الجوال (أرسله لنفسك واتساب) وبيرتبط لحاله:</p>
      <input readonly id="hs-l" value="${esc(linkUrl())}"><div class="row"><button id="hs-cp">نسخ الرابط</button><button id="hs-x">إغلاق</button></div>`
      : setupHtml();
    pane.classList.add('on'); bindPane(box, pane);
  }
  function setupHtml() {
    return `<h3>ربط التطبيق بحسابك في Google</h3>
      <p>الصق هنا رابط Google Apps Script (ينتهي بـ <b dir="ltr">/exec</b>):</p>
      <input id="hs-u" placeholder="https://script.google.com/macros/s/.../exec">
      <div class="row"><button class="p" id="hs-save">ربط</button><button id="hs-x">لاحقاً</button></div>
      <p class="m">بدون ربط، التطبيق يشتغل ويحفظ على هذا الجهاز فقط.</p>`;
  }
  function bindPane(box, pane) {
    const q = id => box.querySelector('#' + id);
    if (q('hs-x')) q('hs-x').onclick = () => pane.classList.remove('on');
    if (q('hs-now')) q('hs-now').onclick = () => { sync(); pane.classList.remove('on'); };
    if (q('hs-xl')) q('hs-xl').onclick = async e => { e.target.disabled = true; e.target.textContent = 'جاري الحفظ…'; const ok = await uploadExcel(true); e.target.textContent = ok ? 'تم الحفظ في Drive ✓' : (excelBuilder ? 'تعذّر — تأكد من الإنترنت' : 'غير متاح لهذا التطبيق'); };
    if (q('hs-cp')) q('hs-cp').onclick = async e => { try { await navigator.clipboard.writeText(q('hs-l').value); e.target.textContent = 'تم النسخ ✓'; } catch (x) { q('hs-l').select(); } };
    if (q('hs-save')) q('hs-save').onclick = async e => {
      const u = q('hs-u').value.trim();
      if (!validExec(u)) { q('hs-u').style.borderColor = '#c62828'; return; }
      e.target.disabled = true; e.target.textContent = 'جاري الفحص…';
      try { setLink(u); await post({ op: 'ping' }); pane.classList.remove('on'); sync(); }
      catch (x) { localStorage.removeItem(LINK_KEY); e.target.disabled = false; e.target.textContent = 'ربط'; q('hs-u').style.borderColor = '#c62828'; alert_('ما قدرت أتصل بالرابط. تأكد إنك نسخته كامل وإن النشر «Anyone».', box); }
      status();
    };
  }
  function alert_(t, box) { const p = document.createElement('p'); p.style.color = '#c62828'; p.textContent = t; box.appendChild(p); }

  /* ---------- تنزيل ملف (بدل claude downloads) ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    }
  };

  /* ---------- واجهة للتطبيقات ---------- */
  window.Hesabati = {
    db, ready, sync, status, getLink, linkUrl, downloads,
    dailyExcel(fn) { excelBuilder = fn; },
    pending
  };
  // نفس واجهة claude.use اللي كانت تستخدمها التطبيقات
  window.claude = { use: async n => (n === 'db' ? db : n === 'downloads' ? downloads : null) };

  document.addEventListener('DOMContentLoaded', () => {
    status();
    if (sessionStorage.getItem('hesabati-linked')) { sessionStorage.removeItem('hesabati-linked'); const t = document.createElement('div'); t.textContent = 'تم ربط هذا الجهاز بحسابك ✓'; t.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);background:#0f7a52;color:#fff;padding:10px 18px;border-radius:999px;z-index:9999;font-family:Tahoma'; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }
  });
  if (document.readyState !== 'loading') status();
  ready.then(() => { status(); sync(); });

  /* ---------- العمل بدون إنترنت ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }).catch(() => {});
})();
