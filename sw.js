// LinkBox Pro – minimal service worker.
// Goal: make the app installable, and let the shell (this page) still open when offline.
// The app itself needs a live network for Firestore and link previews either way,
// so this deliberately does NOT try to cache or serve those.

const CACHE = 'linkbox-shell-v1';
const SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch POST/etc.
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // only handle our own origin
  if (url.pathname.startsWith('/.netlify/')) return;  // never cache the preview function or its errors

  // Network-first for the page itself, so updates are picked up immediately; cached shell is just the offline fallback.
  if (req.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(req).then((res) => {
        caches.open(CACHE).then((c) => c.put('/', res.clone()));
        return res;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(fetch(req).catch(() => caches.match('/manifest.webmanifest')));
  }
});
