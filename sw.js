// Offline shell for היומן. Caches only the app's own files. User data never passes through here
// (it lives in IndexedDB, encrypted). Bump CACHE on every deploy so phones pick up the new version.
const CACHE = 'yoman-v1.6.4';
const VERSION = CACHE.slice('yoman-v'.length);
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'fonts/fonts.css',
  'fonts/secular-hebrew-400.woff2', 'fonts/secular-latin-400.woff2',
  'fonts/varela-hebrew-400.woff2', 'fonts/varela-latin-400.woff2',
  'js/app.js', 'js/crypto.js', 'js/db.js', 'js/digest.js', 'js/exif.js', 'js/koru.js', 'js/platform.js', 'js/speech.js',
  'js/summaries.js', 'js/tidy.js', 'js/updater.js', 'js/vault.js', 'js/voice.js', 'js/wake.js', 'js/webauthn.js', 'js/wipe.js',
  // Icons are referenced with ?v=1.6.3; the fetch handler matches with ignoreSearch, so these entries serve them.
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];
// From 1.6.1 on, a new version waits until the owner taps "עדכן עכשיו" (the page sends SKIP_WAITING).
const FIRST_WAITING_VERSION = '1.6.1';
const older = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
};

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' — never fill the new version's cache from the browser's HTTP cache (GitHub Pages sends max-age=600),
    // or a new service worker could carry the previous version's files.
    await c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // Pages of versions before 1.6.1 have no update bar and would never send SKIP_WAITING: for them, and on a
    // first install, switch over right away as before.
    const keys = await caches.keys();
    const legacy = keys.some((k) => k.startsWith('yoman-v') && k !== CACHE && older(k.slice(7), FIRST_WAITING_VERSION));
    if (legacy || !self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'SKIP_WAITING') self.skipWaiting();
  else if (m.type === 'GET_VERSION' && e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yoman-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // Only this version's cache: while a newer version waits, its cache must not leak into the running page.
    caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.open(CACHE).then((c) => c.match('index.html')) : Response.error())))
  );
});
