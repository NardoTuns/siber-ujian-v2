/**
 * SIBER-UJIAN — api.js
 * Satu pintu untuk semua komunikasi dengan server Google Apps Script.
 * Fungsi Api.call() TIDAK PERNAH melempar error: selalu mengembalikan
 * { success: true, data } atau { success: false, error: { code, message } }.
 */
const Api = (function () {
  'use strict';

  let lastExchange = null;

  function fail(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function isConfigured() {
    const url = String(SIBER_CONFIG.API_URL || '').trim();
    return url.indexOf('https://script.google.com/') === 0 && /\/exec$/.test(url);
  }

  /** Salinan request untuk panel debug: password dan session disamarkan. */
  function maskRequest(body) {
    const copy = JSON.parse(JSON.stringify(body));
    if (copy.payload && copy.payload.password !== undefined) copy.payload.password = '***';
    if (copy.session) copy.session = copy.session.substring(0, 12) + '...';
    return copy;
  }

  function maskResponse(res) {
    const copy = JSON.parse(JSON.stringify(res));
    if (copy && copy.data && typeof copy.data.session === 'string') {
      copy.data.session = copy.data.session.substring(0, 12) + '...';
    }
    return copy;
  }

  /**
   * Memanggil API.
   * @param {string} action  nama action, misalnya 'login'
   * @param {object} payload data yang dikirim
   * @param {string} session session token (boleh kosong)
   */
  async function call(action, payload, session) {
    if (!isConfigured()) {
      return fail('API_NOT_CONFIGURED', 'URL API belum diisi dengan benar di js/config.js');
    }
    if (!navigator.onLine) {
      return fail('OFFLINE', 'Perangkat sedang offline. Sambungkan internet lalu coba lagi.');
    }

    const body = { action: action, payload: payload || {} };
    if (session) body.session = session;

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, SIBER_CONFIG.REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let result;

    try {
      const res = await fetch(SIBER_CONFIG.API_URL.trim(), {
        method: 'POST',
        // text/plain dipakai agar browser tidak mengirim "preflight" CORS
        // yang tidak didukung Google Apps Script. Isinya tetap JSON.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      });
      const text = await res.text();
      try {
        result = JSON.parse(text);
      } catch (e) {
        result = fail('BAD_RESPONSE',
          'Server tidak mengirim JSON. Periksa: akses Web App = "Siapa saja" dan URL berakhiran /exec.');
      }
      if (!result || typeof result.success !== 'boolean') {
        result = fail('BAD_RESPONSE', 'Format respons server tidak dikenal.');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        result = fail('TIMEOUT', 'Server terlalu lama merespons. Coba lagi beberapa saat.');
      } else {
        result = fail('NETWORK_ERROR', 'Gagal menghubungi server: ' + (err && err.message ? err.message : err));
      }
    } finally {
      clearTimeout(timer);
    }

    lastExchange = {
      waktu: new Date().toISOString(),
      action: action,
      durasi_ms: Date.now() - startedAt,
      request: maskRequest(body),
      response: maskResponse(result)
    };
    return result;
  }

  function getLastExchange() { return lastExchange; }

  return { call: call, isConfigured: isConfigured, getLastExchange: getLastExchange };
})();
