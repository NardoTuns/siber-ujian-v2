/**
 * SIBER-UJIAN — pwa.js
 * Mendaftarkan Service Worker, menampilkan status offline,
 * tombol "Pasang aplikasi", dan tombol "Perbarui ke versi baru".
 * Tombol pembaruan TIDAK PERNAH muncul atau dijalankan saat ujian berjalan.
 */
const PWA = (function () {
  'use strict';

  let deferredPrompt = null;
  let waitingWorker = null;
  let updateRequested = false;
  let statusText = 'Memeriksa mode offline...';
  let statusType = '';

  function $(id) { return document.getElementById(id); }

  function cacheName() { return 'siber-ujian-' + SIBER_CONFIG.CLIENT_VERSION; }

  function examActive() {
    return typeof Exam !== 'undefined' && Exam && typeof Exam.isActive === 'function' && Exam.isActive();
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setStatus(text, type) {
    statusText = text;
    statusType = type || '';
    render();
  }

  /** Bar status hanya tampil di layar beranda/login, tidak di layar ujian. */
  function render() {
    const bar = $('pwa-bar');
    if (!bar) return;
    const home = $('screen-home');
    const login = $('screen-login');
    const visible = (home && !home.hidden) || (login && !login.hidden);
    bar.hidden = !visible || examActive();

    const st = $('pwa-status');
    st.textContent = statusText;
    st.className = 'pwa-status ' + statusType;

    $('btn-pwa-install').hidden = !deferredPrompt || isStandalone();
    $('btn-pwa-update').hidden = !waitingWorker || examActive();
  }

  async function refreshStatus() {
    try {
      const controlled = !!navigator.serviceWorker.controller;
      const ready = await caches.has(cacheName());
      if (controlled && ready) {
        setStatus('Siap dipakai offline ✓ (versi ' + SIBER_CONFIG.CLIENT_VERSION + ')' +
                  (isStandalone() ? ' · terpasang' : ''), 'ok');
      } else if (ready) {
        setStatus('File offline sudah tersimpan. Muat ulang halaman sekali agar mode offline aktif.', 'warn');
      } else {
        setStatus('Mode offline sedang disiapkan... Biarkan halaman terbuka saat online.', 'warn');
      }
    } catch (e) {
      setStatus('Tidak dapat memeriksa mode offline: ' + e.message, 'error');
    }
  }

  function onWaiting(worker) {
    waitingWorker = worker;
    setStatus('Versi baru tersedia. Tekan "Perbarui" saat tidak sedang ujian.', 'warn');
  }

  function watchInstalling(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', function () {
      if (worker.state === 'installed') {
        if (navigator.serviceWorker.controller) onWaiting(worker);
        else refreshStatus();
      } else if (worker.state === 'activated') {
        refreshStatus();
      } else if (worker.state === 'redundant' && !waitingWorker) {
        setStatus('Gagal menyimpan file aplikasi untuk offline. Pastikan semua file sudah diunggah dengan nama yang benar.', 'error');
      }
    });
  }

  function applyUpdate() {
    if (examActive()) {
      alert('Pembaruan tidak dapat dilakukan saat ujian berjalan. Selesaikan ujian terlebih dahulu.');
      return;
    }
    if (!waitingWorker) return;
    updateRequested = true;
    setStatus('Memperbarui aplikasi...', 'warn');
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }

  async function onInstallClick() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) { /* abaikan */ }
    deferredPrompt = null;
    render();
  }

  async function register() {
    if (!('serviceWorker' in navigator) || !('caches' in window)) {
      setStatus('Browser ini tidak mendukung mode offline. Gunakan Google Chrome versi terbaru.', 'error');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js', { scope: './', updateViaCache: 'none' });

      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      if (reg.installing) watchInstalling(reg.installing);
      reg.addEventListener('updatefound', function () { watchInstalling(reg.installing); });

      // Halaman hanya dimuat ulang jika PENGGUNA menekan "Perbarui" (tidak pernah paksa saat ujian)
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (updateRequested) location.reload();
        else refreshStatus();
      });

      if (navigator.onLine) reg.update().catch(function () { /* abaikan */ });
      setInterval(function () {
        if (navigator.onLine && !examActive()) reg.update().catch(function () { /* abaikan */ });
      }, 30 * 60 * 1000);

      await navigator.serviceWorker.ready;
      await refreshStatus();
      if (typeof DB !== 'undefined') DB.requestPersistence();
    } catch (e) {
      setStatus('Gagal mengaktifkan mode offline: ' + e.message, 'error');
    }
  }

  function init() {
    if ($('btn-pwa-install')) $('btn-pwa-install').addEventListener('click', onInstallClick);
    if ($('btn-pwa-update')) $('btn-pwa-update').addEventListener('click', applyUpdate);

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      render();
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      setStatus('Aplikasi berhasil dipasang ✓ Buka dari layar utama.', 'ok');
      if (typeof DB !== 'undefined') DB.requestPersistence();
    });

    setInterval(render, 1000); // sembunyikan bar saat layar ujian tampil
    register();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { refreshStatus: refreshStatus };
})();
