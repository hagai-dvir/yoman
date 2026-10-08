// Offline shell for היומן. Caches only the app's own files. User data never passes through here
// (it lives in IndexedDB, encrypted). Bump CACHE on every deploy so phones pick up the new version.
const CACHE = 'yoman-v1.2.0';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'fonts/fonts.css',
  'fonts/secular-hebrew-400.woff2', 'fonts/secular-latin-400.woff2',
  'fonts/varela-hebrew-400.woff2', 'fonts/varela-latin-400.woff2',
  'js/app.js', 'js/crypto.js', 'js/db.js', 'js/exif.js', 'js/koru.js', 'js/platform.js', 'js/speech.js',
  'js/summaries.js', 'js/tidy.js', 'js/vault.js', 'js/webauthn.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
