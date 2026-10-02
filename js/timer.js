/**
 * SIBER-UJIAN — timer.js
 *
 * JAM EFEKTIF:
 *  - Jam dinding (Date.now) bisa diubah siswa.
 *  - Stopwatch internal (performance.now) tidak terpengaruh perubahan jam,
 *    tetapi di sebagian HP berhenti saat HP tidur.
 *  - Jam efektif: memakai jam dinding saat maju normal (benar juga saat HP tidur),
 *    dan memakai stopwatch saat jam dinding MUNDUR (waktu ujian tidak bertambah).
 *
 * ATURAN: setInterval HANYA untuk memperbarui tampilan.
 * Sisa waktu SELALU dihitung dari timestamp: waktuSelesai - Timer.now().
 */
const Timer = (function () {
  'use strict';

  const BACKWARD_TOLERANCE_MS = 2000;  // mundur lebih dari ini dianggap jam diubah
  const GAP_REPORT_MS = 30000;         // jeda lebih dari ini dicatat (HP tidur / jam dimajukan)

  let effective = Date.now();
  let lastWall = Date.now();
  let lastPerf = performance.now();
  const anomalyListeners = [];

  let handle = null;
  let current = null; // { endAtMs, onTick, onExpire, expired }

  function emit(ev) {
    anomalyListeners.forEach(function (fn) {
      try { fn(ev); } catch (e) { console.warn('Listener jam gagal:', e); }
    });
  }

  /** Waktu sekarang menurut jam efektif (milidetik). Pakai ini, BUKAN Date.now(). */
  function now() {
    const wall = Date.now();
    const perf = performance.now();
    const wallDelta = wall - lastWall;
    const monoDelta = Math.max(0, perf - lastPerf);
    let delta;
    let event = null;

    if (wallDelta < 0) {
      // Jam dinding mundur: pakai stopwatch internal
      delta = monoDelta;
      if (-wallDelta > BACKWARD_TOLERANCE_MS) {
        event = { type: 'CLOCK_BACKWARD', amount_ms: Math.round(-wallDelta) };
      }
    } else {
      delta = wallDelta;
      if (wallDelta - monoDelta > GAP_REPORT_MS) {
        event = { type: 'TIME_GAP', amount_ms: Math.round(wallDelta - monoDelta) };
      }
    }

    effective += delta;
    lastWall = wall;
    lastPerf = perf;

    if (event) {
      event.effective_at = Math.round(effective);
      event.device_at = wall;
      emit(event);
    }
    return Math.round(effective);
  }

  /**
   * Memastikan jam efektif tidak lebih awal dari "ms".
   * Mengembalikan berapa milidetik jam harus dimajukan (0 jika normal).
   */
  function ensureAtLeast(ms) {
    const n = now();
    if (n < ms) {
      effective = ms;
      return ms - n;
    }
    return 0;
  }

  function onAnomaly(fn) { anomalyListeners.push(fn); }

  /** Selisih jam efektif dengan jam HP (untuk debug). */
  function deviceOffset() { return now() - Date.now(); }

  /* ---------- Hitung mundur tampilan ---------- */

  function start(endAtMs, onTick, onExpire) {
    stop();
    current = { endAtMs: endAtMs, onTick: onTick, onExpire: onExpire, expired: false };
    tickNow();
    if (current) handle = setInterval(tickNow, 500);
  }

  function tickNow() {
    if (!current) return;
    const remaining = current.endAtMs - now();
    if (!current) return; // bisa berhenti di dalam listener jam
    if (remaining <= 0) {
      current.onTick(0);
      if (!current.expired) {
        current.expired = true;
        const cb = current.onExpire;
        stop();
        cb();
      }
      return;
    }
    current.onTick(remaining);
  }

  function stop() {
    if (handle) clearInterval(handle);
    handle = null;
    current = null;
  }

  function remaining(endAtMs) { return Math.max(0, endAtMs - now()); }

  return {
    now: now,
    ensureAtLeast: ensureAtLeast,
    onAnomaly: onAnomaly,
    deviceOffset: deviceOffset,
    start: start,
    stop: stop,
    tickNow: tickNow,
    remaining: remaining
  };
})();
