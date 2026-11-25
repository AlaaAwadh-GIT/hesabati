/* يخلي التطبيقات تفتح بدون إنترنت */
const V = 'hesabati-v4';
const FILES = ['./', 'index.html', 'manifest.json', 'lib/sync.js', 'lib/zip.js',
  'sarafa/', 'sarafa/index.html', 'sarafa/core.js', 'sarafa/template.json', 'sarafa/manifest.json',
  'honey/', 'honey/index.html', 'honey/template.json', 'honey/manifest.json',
  'expenses/', 'expenses/index.html', 'expenses/manifest.json',
  'radar/', 'radar/index.html', 'radar/manifest.json', 'icons/radar-192.png', 'icons/radar-512.png',
  'icons/home-192.png', 'icons/sarafa-192.png', 'icons/honey-192.png', 'icons/expenses-192.png',
  'icons/home-512.png', 'icons/sarafa-512.png', 'icons/honey-512.png', 'icons/expenses-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.hostname.endsWith('google.com') || u.hostname.endsWith('googleusercontent.com')) return; // المزامنة: دائماً من الشبكة
  const font = u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
  if (u.origin !== location.origin && !font) return;
  // من النسخة المحفوظة فوراً، وتحديثها من الإنترنت في الخلفية
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net; return res || new Response('بدون إنترنت', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
