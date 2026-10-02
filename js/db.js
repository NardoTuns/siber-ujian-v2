/**
 * SIBER-UJIAN — db.js
 * Lapisan database lokal (IndexedDB).
 * ATURAN: sebuah data dianggap TERSIMPAN hanya setelah transaksi selesai (oncomplete),
 * bukan saat perintah simpan dikirim.
 */
const DB = (function () {
  'use strict';

  const NAME = 'SIBER_UJIAN_DB';
  const VERSION = 1;
  const STORES = ['users', 'exams', 'questions', 'attempts', 'answers', 'timer_state', 'sync_queue', 'settings'];

  let dbPromise = null;
  let dbInstance = null;

  /** Membuat struktur database. Dijalankan otomatis saat database pertama kali dibuat. */
  function upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const users = db.createObjectStore('users', { keyPath: 'user_id' });
      users.createIndex('username', 'username', { unique: true });

      db.createObjectStore('exams', { keyPath: 'exam_id' });

      const questions = db.createObjectStore('questions', { keyPath: ['exam_id', 'question_id'] });
      questions.createIndex('exam_id', 'exam_id', { unique: false });

      const attempts = db.createObjectStore('attempts', { keyPath: 'attempt_id' });
      attempts.createIndex('user_id', 'user_id', { unique: false });
      attempts.createIndex('exam_id', 'exam_id', { unique: false });
      attempts.createIndex('status', 'status', { unique: false });
      attempts.createIndex('user_exam', ['user_id', 'exam_id'], { unique: false });

      const answers = db.createObjectStore('answers', { keyPath: ['attempt_id', 'question_id'] });
      answers.createIndex('attempt_id', 'attempt_id', { unique: false });

      db.createObjectStore('timer_state', { keyPath: 'attempt_id' });

      const queue = db.createObjectStore('sync_queue', { keyPath: 'queue_id' });
      queue.createIndex('status', 'status', { unique: false });
      queue.createIndex('attempt_id', 'attempt_id', { unique: false });

      db.createObjectStore('settings', { keyPath: 'key' });
    }
    // Versi berikutnya ditambahkan di sini dengan: if (oldVersion < 2) { ... }
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window) || !window.indexedDB) {
        reject(new Error('Browser ini tidak mendukung IndexedDB.'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(NAME, VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function (event) {
        upgrade(req.result, event.oldVersion);
      };
      req.onsuccess = function () {
        dbInstance = req.result;
        dbInstance.onversionchange = function () {
          dbInstance.close();
          alert('Aplikasi diperbarui atau datanya dihapus di tab lain. Halaman akan dimuat ulang.');
          location.reload();
        };
        resolve(dbInstance);
      };
      req.onerror = function () {
        reject(req.error || new Error('Gagal membuka database lokal.'));
      };
      req.onblocked = function () {
        reject(new Error('Database lokal sedang dipakai tab lain. Tutup tab SIBER-UJIAN lain lalu muat ulang.'));
      };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  /**
   * Menjalankan satu transaksi. Promise selesai SETELAH data benar-benar tertulis.
   * work(transaksi, setResult, failTx)
   *   - setResult(nilai): nilai yang dikembalikan jika transaksi berhasil
   *   - failTx(kode, pesan): batalkan transaksi dengan error yang jelas
   */
  function run(storeNames, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        let t;
        try {
          t = (mode === 'readwrite')
            ? db.transaction(storeNames, 'readwrite', { durability: 'strict' })
            : db.transaction(storeNames, 'readonly');
        } catch (e) {
          reject(e);
          return;
        }
        let result;
        let customError = null;

        function failTx(code, message) {
          customError = new Error(message);
          customError.code = code;
          try { t.abort(); } catch (ignore) { /* sudah selesai */ }
        }

        t.oncomplete = function () { resolve(result); };
        t.onabort = function () {
          reject(customError || t.error || new Error('Transaksi dibatalkan. Kemungkinan memori perangkat penuh.'));
        };

        try {
          work(t, function (v) { result = v; }, failTx);
        } catch (e) {
          customError = customError || e;
          try {
            t.abort();
          } catch (ignore) {
            reject(customError);
          }
        }
      });
    });
  }

  function get(store, key) {
    return run(store, 'readonly', function (t, set) {
      const r = t.objectStore(store).get(key);
      r.onsuccess = function () { set(r.result === undefined ? null : r.result); };
    });
  }

  function put(store, value) {
    return run(store, 'readwrite', function (t, set) {
      t.objectStore(store).put(value);
      set(value);
    });
  }

  function putMany(store, values) {
    return run(store, 'readwrite', function (t, set) {
      const s = t.objectStore(store);
      values.forEach(function (v) { s.put(v); });
      set(values.length);
    });
  }

  function del(store, key) {
    return run(store, 'readwrite', function (t, set) {
      t.objectStore(store).delete(key);
      set(true);
    });
  }

  function getAll(store) {
    return run(store, 'readonly', function (t, set) {
      const r = t.objectStore(store).getAll();
      r.onsuccess = function () { set(r.result || []); };
    });
  }

  function getAllByIndex(store, indexName, value) {
    return run(store, 'readonly', function (t, set) {
      const r = t.objectStore(store).index(indexName).getAll(value);
      r.onsuccess = function () { set(r.result || []); };
    });
  }

  function getOneByIndex(store, indexName, value) {
    return run(store, 'readonly', function (t, set) {
      const r = t.objectStore(store).index(indexName).get(value);
      r.onsuccess = function () { set(r.result === undefined ? null : r.result); };
    });
  }

  function count(store) {
    return run(store, 'readonly', function (t, set) {
      const r = t.objectStore(store).count();
      r.onsuccess = function () { set(r.result); };
    });
  }

  async function stats() {
    const out = {};
    for (let i = 0; i < STORES.length; i++) out[STORES[i]] = await count(STORES[i]);
    return out;
  }

  /* ---------- Settings (key-value) ---------- */

  async function getSetting(key) {
    const r = await get('settings', key);
    return r ? r.value : null;
  }

  function setSetting(key, value) {
    return put('settings', { key: key, value: value, updated_at: new Date().toISOString() });
  }

  function delSetting(key) { return del('settings', key); }

  /* ---------- Penyimpanan permanen ---------- */

  async function requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return null;
    try {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch (e) {
      return null;
    }
  }

  async function storageInfo() {
    const info = { persisted: null, usage: null, quota: null };
    try {
      if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        info.usage = e.usage;
        info.quota = e.quota;
      }
    } catch (e) { /* tidak didukung */ }
    return info;
  }

  /** KHUSUS PENGUJIAN: menghapus seluruh database lokal. */
  function deleteDatabase() {
    return new Promise(function (resolve, reject) {
      if (dbInstance) { dbInstance.close(); dbInstance = null; }
      dbPromise = null;
      const req = indexedDB.deleteDatabase(NAME);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error || new Error('Gagal menghapus database.')); };
      req.onblocked = function () { reject(new Error('Tutup tab SIBER-UJIAN lain lalu coba lagi.')); };
    });
  }

  return {
    NAME: NAME,
    VERSION: VERSION,
    STORES: STORES,
    open: open,
    transaction: run,
    get: get,
    put: put,
    putMany: putMany,
    del: del,
    getAll: getAll,
    getAllByIndex: getAllByIndex,
    getOneByIndex: getOneByIndex,
    count: count,
    stats: stats,
    getSetting: getSetting,
    setSetting: setSetting,
    delSetting: delSetting,
    requestPersistence: requestPersistence,
    storageInfo: storageInfo,
    deleteDatabase: deleteDatabase
  };
})();
