// ===================================================================
// Kargo Kilat (Lite) — Service Worker
// Strategi: network-first untuk HTML, cache-first untuk asset statis.
//
// CARA UPDATE:
// Setiap kali kamu deploy perubahan pada index.html / style.css / script.js,
// naikkan angka di CACHE_VERSION (mis. 'v1' -> 'v2'). Service worker baru
// akan otomatis menghapus cache versi lama dan mengambil ulang semua file.
// ===================================================================

const CACHE_VERSION = 'v13';
const CACHE_NAME = `kargo-kilat-lite-cache-${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './assets/kargo-kilat-logo.png',
  './assets/kargo-kilat-splash.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('kargo-kilat-lite-cache-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Jangan cache request ke Firebase (auth/firestore), LocationIQ,
  // OpenRouteService, atau tile peta — selalu ambil dari network,
  // supaya data lokasi/rute/ongkir selalu real-time.
  if (
    req.url.includes('googleapis.com') ||
    req.url.includes('firebaseio.com') ||
    req.url.includes('gstatic.com/firebasejs') ||
    req.url.includes('locationiq.com') ||
    req.url.includes('openrouteservice.org') ||
    req.url.includes('tile.openstreetmap.org')
  ) {
    return;
  }

  const isHTML = req.mode === 'navigate' || req.destination === 'document';

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      });
    })
  );
});
