/**
 * SIBER-UJIAN — submit.js
 * SUBMIT LATER + SYNC QUEUE.
 *
 * ATURAN:
 *  - Hasil ujian SELALU tersimpan dulu di perangkat (Phase 5-7). File ini hanya MENGIRIM.
 *  - Setiap hasil dikirim memakai sesi milik siswa pemilik hasil itu (bukan siswa yang sedang login).
 *  - ATTEMPT_ID membuat pengiriman ulang aman: server menjawab ALREADY_SYNCED tanpa hasil ganda.
 *  - Data di perangkat TIDAK PERNAH dihapus oleh proses kirim, termasuk saat gagal.
 *
 * Status antrean (sync_queue.status):
 *  PENDING     menunggu dikirim / akan dicoba lagi
 *  SENDING     sedang dikirim
 *  NEED_LOGIN  sesi server habis; siswa harus login online
 *  FAILED      ditolak server; perlu bantuan guru (bisa dikirim ulang manual)
 *  DONE        sudah diterima server
 */
const Submit = (function () {
  'use strict';

  const PERIOD_MS = 60000;
  const LOCK_NAME = 'siber-ujian-sync';
  const RETRYABLE = ['OFFLINE', 'NETWORK_ERROR', 'TIMEOUT', 'SERVER_BUSY', 'BAD_RESPONSE', 'SERVER_ERROR'];
  const NEED_LOGIN = ['SESSION_EXPIRED', 'UNAUTHORIZED', 'NOT_LOGGED_IN'];

  let running = false;
  const listeners = [];

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { console.warn('Listener kirim gagal:', e); }
    });
  }

  function onChange(fn) { listeners.push(fn); }
  function isRunning() { return running; }

  /** Jeda sebelum mencoba lagi: 30 detik, 1, 2, 4, 8, 16, maksimal 30 menit. */
  function backoffMs(tries) {
    return Math.min(30 * 60000, 30000 * Math.pow(2, Math.max(0, tries - 1)));
  }

  function sessionValid(rec) {
    if (!rec || !rec.session) return false;
    const exp = Date.parse(rec.session_expires_at);
    return !isNaN(exp) && exp > Date.now();
  }

  async function updateItem(queueId, changes) {
    const item = await DB.get('sync_queue', queueId);
    if (!item) return;
    Object.assign(item, changes, { updated_at: new Date().toISOString() });
    await DB.put('sync_queue', item);
  }

  async function buildPayload(a) {
    const answers = await DB.getAllByIndex('answers', 'attempt_id', a.attempt_id);
    return {
      attempt_id: a.attempt_id,
      exam_id: a.exam_id,
      mode: a.mode,
      started_at: a.started_at,
      completed_at: a.completed_at,
      finish_reason: a.finish_reason,
      answers: answers.map(function (x) {
        return { question_id: x.question_id, answer: x.answer || '', answered_at: x.answered_at };
      }),
      answered_count: a.answered_count,
      token_id: a.token_id || '',
      package_version: a.package_version || '',
      client_version: SIBER_CONFIG.CLIENT_VERSION,
      clock_events: (a.clock_events || []).slice(0, 100)
    };
  }

  /** Menandai SYNCED di attempt dan DONE di antrean dalam SATU transaksi. */
  function markSynced(attemptId, data) {
    return DB.transaction(['attempts', 'sync_queue'], 'readwrite', function (t, set) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        const nowIso = new Date().toISOString();
        if (a) {
          a.sync_status = 'SYNCED';
          a.synced_at = data.synced_at || nowIso;
          a.server_status = data.status;
          a.server_result_id = data.result_id || null;
          a.server_warning_count = Array.isArray(data.warnings) ? data.warnings.length : 0;
          if (data.score !== undefined) {
            a.server_score = data.score;
            a.server_correct = data.correct;
            a.server_wrong = data.wrong;
          }
          a.updated_at = nowIso;
          t.objectStore('attempts').put(a);
        }
        const q = t.objectStore('sync_queue').get(attemptId);
        q.onsuccess = function () {
          const item = q.result;
          if (item) {
            item.status = 'DONE';
            item.done_at = nowIso;
            item.last_error = null;
            item.updated_at = nowIso;
            t.objectStore('sync_queue').put(item);
          }
          set(true);
        };
      };
    });
  }

  /** Mengirim satu hasil. Mengembalikan: sent | retry | need_login | failed | skip */
  async function sendOne(item) {
    const a = await DB.get('attempts', item.attempt_id);
    if (!a) {
      await updateItem(item.queue_id, { status: 'FAILED', last_error: 'Data ujian tidak ditemukan di perangkat.' });
      return 'failed';
    }
    if (a.sync_status === 'SYNCED') {
      await updateItem(item.queue_id, { status: 'DONE' });
      return 'skip';
    }
    if (a.status !== 'COMPLETED') return 'skip';

    const user = await DB.get('users', a.user_id);
    if (!sessionValid(user)) {
      await updateItem(item.queue_id, {
        status: 'NEED_LOGIN',
        last_error: 'Sesi server habis. Login online sebagai ' + (user ? user.username : a.user_id) + ' untuk mengirim.'
      });
      return 'need_login';
    }

    await updateItem(item.queue_id, { status: 'SENDING', last_try_at: new Date().toISOString() });
    notify();

    const payload = await buildPayload(a);
    const res = await Api.call('submitAttempt', payload, user.session);

    if (res.success && res.data && (res.data.status === 'SYNCED' || res.data.status === 'ALREADY_SYNCED')) {
      await markSynced(a.attempt_id, res.data);
      return 'sent';
    }

    const code = res.success ? 'BAD_RESPONSE' : res.error.code;
    const msg = res.success ? 'Respons server tidak dikenal.' : res.error.message;
    const tries = (item.tries || 0) + 1;

    if (NEED_LOGIN.indexOf(code) !== -1) {
      user.session = null;
      user.updated_at = new Date().toISOString();
      await DB.put('users', user);
      await updateItem(item.queue_id, {
        status: 'NEED_LOGIN',
        tries: tries,
        last_error: msg + ' Login online sebagai ' + user.username + ' untuk mengirim.'
      });
      return 'need_login';
    }
    if (RETRYABLE.indexOf(code) !== -1) {
      await updateItem(item.queue_id, {
        status: 'PENDING',
        tries: tries,
        last_error: msg + ' [' + code + ']',
        next_try_at: Date.now() + backoffMs(tries)
      });
      return 'retry';
    }
    await updateItem(item.queue_id, { status: 'FAILED', tries: tries, last_error: msg + ' [' + code + ']' });
    return 'failed';
  }

  /** Hanya satu tab yang boleh mengirim pada saat yang sama. */
  function withLock(fn) {
    if (!navigator.locks || !navigator.locks.request) return fn();
    return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, function (lock) {
      if (!lock) return { busy: true };
      return fn();
    });
  }

  /**
   * Memproses antrean.
   * opts.manual = true: abaikan jeda tunggu dan coba juga hasil yang berstatus GAGAL.
   */
  async function run(opts) {
    const manual = !!(opts && opts.manual);
    if (running) return { busy: true };
    if (!navigator.onLine) return { offline: true };

    running = true;
    notify();
    try {
      return await withLock(async function () {
        const items = (await DB.getAll('sync_queue')).sort(function (x, y) {
          return String(x.created_at).localeCompare(String(y.created_at));
        });
        const summary = { sent: 0, retry: 0, need_login: 0, failed: 0 };
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.status === 'DONE') continue;
          if (item.status === 'FAILED' && !manual) continue;
          if (item.status === 'PENDING' && !manual && item.next_try_at && Date.now() < item.next_try_at) continue;
          if (!navigator.onLine) break;
          let r;
          try {
            r = await sendOne(item);
          } catch (e) {
            await updateItem(item.queue_id, { status: 'PENDING', last_error: 'Kesalahan aplikasi: ' + e.message });
            r = 'retry';
          }
          if (summary[r] !== undefined) summary[r]++;
          notify();
        }
        return summary;
      });
    } catch (e) {
      console.warn('Proses kirim gagal:', e);
      return { error: e.message };
    } finally {
      running = false;
      notify();
    }
  }

  /** Daftar hasil milik user (untuk ditampilkan) + jumlah hasil akun lain yang belum terkirim. */
  async function listForUser(userId) {
    const attempts = (await DB.getAll('attempts')).filter(function (a) { return a.status === 'COMPLETED'; });
    const queue = await DB.getAll('sync_queue');
    const qmap = {};
    queue.forEach(function (q) { qmap[q.attempt_id] = q; });

    const mine = attempts
      .filter(function (a) { return a.user_id === userId; })
      .sort(function (x, y) { return String(y.completed_at).localeCompare(String(x.completed_at)); })
      .map(function (a) { return { attempt: a, item: qmap[a.attempt_id] || null }; });

    const othersPending = attempts.filter(function (a) {
      return a.user_id !== userId && a.sync_status !== 'SYNCED';
    }).length;

    return { mine: mine, othersPending: othersPending };
  }

  function init() {
    window.addEventListener('online', function () { setTimeout(run, 2000); });
    setInterval(function () { if (navigator.onLine) run(); }, PERIOD_MS);
    setTimeout(function () { if (navigator.onLine) run(); }, 3000);
  }

  return {
    init: init,
    run: run,
    onChange: onChange,
    isRunning: isRunning,
    listForUser: listForUser
  };
})();
