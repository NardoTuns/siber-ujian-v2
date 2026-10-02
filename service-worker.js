/**
 * SIBER-UJIAN — service-worker.js
 * Menyimpan semua file aplikasi agar bisa dibuka TANPA internet.
 *
 * ATURAN:
 *  - Nama gudang = 'siber-ujian-' + CLIENT_VERSION (dari js/config.js).
 *    Setiap mengubah file apa pun, NAIKKAN CLIENT_VERSION.
 *  - Request ke server Google Apps Script TIDAK disentuh (tidak pernah di-cache).
 *  - Versi baru TIDAK langsung aktif: menunggu pengguna menekan "Perbarui"
 *    (tombol tidak muncul saat ujian berjalan), atau semua tab ditutup.
 *  - Data ujian ada di IndexedDB, bukan di sini, sehingga pembaruan tidak menghapusnya.
 */
importScripts('js/config.js');

const CACHE_PREFIX = 'siber-ujian-';
const CACHE_NAME = CACHE_PREFIX + SIBER_CONFIG.CLIENT_VERSION;

const APP_SHELL = [
  './',
  'index.html',
  'dashboard.html',
  'manifest.json',
  'css/style.css',
  'css/login.css',
  'css/exam.css',
  'css/dashboard.css',
  'js/config.js',
  'js/ui.js',
  'js/db.js',
  'js/api.js',
  'js/auth.js',
  'js/sync.js',
  'js/token.js',
  'js/timer.js',
  'js/questions.js',
  'js/exam.js',
  'js/submit.js',
  'js/app.js',
  'js/dashboard.js',
  'js/pwa.js',
  'js/reports.js',
  'vendor/katex/katex.min.css',
  'vendor/katex/katex.min.js',
  'js/mathrender.js',
  'vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  'vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  'vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  'vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  'vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  'vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Script-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
  'vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon.png'
];

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

/* Pasang: simpan SEMUA file. Jika satu saja gagal, pemasangan dibatalkan (tidak setengah-setengah). */
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map(function (u) {
      return new Request(scopeUrl(u), { cache: 'reload' });
    }));
  })());
});

/* Aktif: hapus gudang versi lama, lalu kendalikan halaman yang terbuka. */
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.map(function (n) {
      if (n.indexOf(CACHE_PREFIX) === 0 && n !== CACHE_NAME) return caches.delete(n);
      return null;
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', function (event) {
  const d = event.data || {};
  if (d.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (d.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SIBER_CONFIG.CLIENT_VERSION, cache: CACHE_NAME });
  }
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API Google & situs lain: tidak disentuh

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req, url));
  } else {
    event.respondWith(handleAsset(req));
  }
});

/** Membuka halaman: dari gudang dulu (offline aman), baru ke internet. */
async function handleNavigate(req, url) {
  const cache = await caches.open(CACHE_NAME);
  let match = await cache.match(req, { ignoreSearch: true });
  if (!match && url.pathname.endsWith('/')) match = await cache.match(scopeUrl('index.html'));
  if (match) return match;
  try {
    return await fetch(req);
  } catch (e) {
    const fallback = await cache.match(scopeUrl('index.html'));
    if (fallback) return fallback;
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<h2>SIBER-UJIAN belum siap offline</h2>' +
      '<p>Buka aplikasi ini sekali saat ada internet agar bisa dipakai tanpa internet.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

/** File CSS/JS/ikon: dari gudang dulu, baru ke internet. */
async function handleAsset(req) {
  const cache = await caches.open(CACHE_NAME);
  const match = await cache.match(req, { ignoreSearch: true });
  if (match) return match;
  try {
    return await fetch(req);
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}
