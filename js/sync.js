/**
 * SIBER-UJIAN — sync.js
 * PRE-SYNC: unduh paket ujian, verifikasi, simpan, verifikasi ulang, lalu READY.
 * ATURAN:
 *  - READY hanya jika SEMUA soal + gambar tersimpan dan lolos verifikasi.
 *  - Soal + data ujian disimpan dalam SATU transaksi (semua atau tidak sama sekali).
 *  - Paket tidak boleh diganti jika ada ujian yang belum terkirim untuk exam tersebut.
 *  - Jika server mengirim kunci jawaban (seharusnya tidak pernah), paket DITOLAK.
 *  - Ujian bertoken: teks soal disimpan dalam keadaan TERKUNCI.
 */
const Sync = (function () {
  'use strict';

  const SERVER_FIELDS = ['exam_id', 'exam_name', 'subject', 'grade', 'mode', 'duration_value',
    'duration_unit', 'duration_seconds', 'navigation', 'question_count', 'random_question',
    'random_option', 'token_required', 'start_date', 'end_date', 'status', 'version'];
  const ALLOWED_QUESTION_KEYS = ['question_id', 'number', 'question', 'options', 'has_image', 'version'];
  const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
  const ACTIVE_ATTEMPT_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'PENDING_SYNC'];
  const RETRYABLE_CODES = ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_BUSY', 'BAD_RESPONSE'];
  const IMAGE_RETRIES = 2;

  function fail(code, message) { return { success: false, error: { code: code, message: message } }; }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function sha256Hex(data) {
    const buf = (typeof data === 'string') ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Checksum paket. Urutan field HARUS sama dengan server. */
  function packageJson(exam, questions, secure, keySlots) {
    return JSON.stringify({ exam: exam, questions: questions, secure: secure, key_slots: keySlots });
  }

  function isReady(rec) {
    return !!rec && rec.local_status === 'READY' && rec.package_version !== null &&
      rec.package_version !== undefined && String(rec.package_version) === String(rec.version);
  }

  /* ---------- Daftar ujian ---------- */

  async function saveExamList(serverExams) {
    if (!Array.isArray(serverExams)) throw new Error('Data daftar ujian tidak valid.');
    const now = new Date().toISOString();
    const records = [];

    for (let i = 0; i < serverExams.length; i++) {
      const e = serverExams[i];
      if (!e || !e.exam_id) continue;
      const old = await DB.get('exams', e.exam_id);
      const rec = Object.assign({}, old || {});
      SERVER_FIELDS.forEach(function (f) { rec[f] = e[f]; });

      if (!old) {
        rec.local_status = 'NOT_READY';
        rec.package_version = null;
      } else if (old.local_status === 'READY' && String(old.package_version) !== String(e.version)) {
        rec.local_status = 'NOT_READY';
      }
      rec.list_updated_at = now;
      records.push(rec);
    }
    await DB.putMany('exams', records);
    return records;
  }

  async function getLocalExams(user) {
    const all = await DB.getAll('exams');
    return all
      .filter(function (e) { return user.role !== 'STUDENT' || e.grade === user.grade; })
      .sort(function (a, b) { return String(a.exam_id).localeCompare(String(b.exam_id)); });
  }

  async function getActiveAttempts(examId) {
    const list = await DB.getAllByIndex('attempts', 'exam_id', examId);
    return list.filter(function (a) {
      if (a.status === 'IN_PROGRESS') return true;
      return a.sync_status !== 'SYNCED' && ACTIVE_ATTEMPT_STATUSES.indexOf(a.status) !== -1;
    });
  }

  /* ---------- Verifikasi paket dari server ---------- */

  function verifyPackage(data, examId) {
    const errs = [];
    if (!data || typeof data !== 'object') return ['Paket kosong'];

    if (/answer_key|kunci_jawaban/i.test(JSON.stringify(data))) {
      return ['BAHAYA: paket berisi data kunci jawaban. Paket ditolak. Laporkan ke admin.'];
    }

    const e = data.exam;
    if (!e || e.exam_id !== examId) { errs.push('exam_id paket tidak sesuai'); return errs; }
    if (['TOTAL', 'PER_SOAL'].indexOf(e.mode) === -1) errs.push('MODE tidak valid');
    if (!(e.duration_seconds > 0)) errs.push('Durasi tidak valid');
    if (['FREE', 'SEQUENTIAL'].indexOf(e.navigation) === -1) errs.push('NAVIGATION tidak valid');
    if (e.mode === 'PER_SOAL' && e.navigation !== 'SEQUENTIAL') errs.push('PER_SOAL wajib SEQUENTIAL');
    if (!(e.question_count > 0)) errs.push('QUESTION_COUNT tidak valid');
    if (e.version === undefined || e.version === null || e.version === '') errs.push('VERSION kosong');

    const encrypted = !!data.secure;
    if (e.token_required && !encrypted) errs.push('Ujian memerlukan token tetapi paket tidak terkunci');
    if (encrypted) {
      const s = data.secure;
      if (typeof s.nonce !== 'string' || typeof s.ct !== 'string' || typeof s.mac !== 'string') {
        errs.push('Paket terkunci tidak lengkap');
      }
      if (!Array.isArray(data.key_slots) || !data.key_slots.length) {
        errs.push('Data token tidak ada');
      } else {
        data.key_slots.forEach(function (k, i) {
          if (!k || !k.token_id || typeof k.meta_json !== 'string' || !k.salt || !(k.iterations > 0) ||
              !k.nonce || !k.ct || !k.mac) {
            errs.push('Data token ke-' + (i + 1) + ' rusak');
          }
        });
      }
    }

    if (!Array.isArray(data.questions)) { errs.push('Daftar soal tidak ada'); return errs; }
    if (data.questions.length !== e.question_count) {
      errs.push('Jumlah soal ' + data.questions.length + ', seharusnya ' + e.question_count);
    }
    if (data.question_count !== data.questions.length) errs.push('question_count tidak cocok');

    const ids = {};
    const nums = {};
    data.questions.forEach(function (q, i) {
      const label = 'Soal ke-' + (i + 1);
      if (!q || typeof q !== 'object') { errs.push(label + ' rusak'); return; }
      Object.keys(q).forEach(function (k) {
        if (ALLOWED_QUESTION_KEYS.indexOf(k) === -1) errs.push(label + ' berisi field tidak dikenal: ' + k);
      });
      if (!q.question_id || ids[q.question_id]) errs.push(label + ': QUESTION_ID kosong/ganda');
      ids[q.question_id] = true;
      if (!(q.number > 0) || nums[q.number]) errs.push(label + ': nomor kosong/ganda');
      nums[q.number] = true;

      if (encrypted) {
        if (q.question !== undefined || q.options !== undefined) errs.push(label + ': teks soal seharusnya terkunci');
      } else {
        if (!q.question) errs.push(label + ': teks soal kosong');
        if (!q.options || typeof q.options !== 'object') {
          errs.push(label + ': pilihan jawaban tidak ada');
        } else {
          OPTION_LETTERS.forEach(function (L) {
            if (typeof q.options[L] !== 'string' || !q.options[L]) errs.push(label + ': pilihan ' + L + ' kosong');
          });
        }
      }
    });
    return errs;
  }

  /* ---------- Gambar ---------- */

  async function downloadImage(examId, q) {
    let last = null;
    for (let attempt = 0; attempt <= IMAGE_RETRIES; attempt++) {
      const res = await Auth.authedCall('getQuestionImage', { exam_id: examId, question_id: q.question_id });
      if (res.success) {
        const d = res.data;
        if (!d || d.question_id !== q.question_id) throw new Error('Gambar soal nomor ' + q.number + ' tertukar.');
        if (typeof d.mime_type !== 'string' || d.mime_type.indexOf('image/') !== 0) {
          throw new Error('Tipe file gambar soal nomor ' + q.number + ' tidak valid.');
        }
        const bytes = base64ToBytes(d.data_base64 || '');
        if (bytes.length !== d.size) throw new Error('Ukuran gambar soal nomor ' + q.number + ' tidak cocok.');
        if ((await sha256Hex(bytes)) !== d.sha256) {
          throw new Error('Gambar soal nomor ' + q.number + ' rusak saat diunduh.');
        }
        return { mime_type: d.mime_type, size: d.size, sha256: d.sha256, blob: new Blob([bytes], { type: d.mime_type }) };
      }
      last = res;
      if (RETRYABLE_CODES.indexOf(res.error.code) === -1) break;
      await sleep(1500 * (attempt + 1));
    }
    throw new Error('Gambar soal nomor ' + q.number + ' gagal diunduh: ' +
      last.error.message + ' [' + last.error.code + ']');
  }

  /* ---------- Penyimpanan atomik ---------- */

  async function writePackage(examId, examRecord, questionRecords) {
    const db = await DB.open();
    return new Promise(function (resolve, reject) {
      let t;
      try {
        t = db.transaction(['exams', 'questions'], 'readwrite', { durability: 'strict' });
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = function () { resolve(true); };
      t.onerror = function () { reject(t.error || new Error('Gagal menyimpan paket soal.')); };
      t.onabort = function () { reject(t.error || new Error('Penyimpanan dibatalkan. Kemungkinan memori perangkat penuh.')); };
      try {
        const qs = t.objectStore('questions');
        qs.delete(IDBKeyRange.bound([examId], [examId, []]));
        questionRecords.forEach(function (r) { qs.put(r); });
        t.objectStore('exams').put(examRecord);
      } catch (e) {
        try { t.abort(); } catch (ignore) { /* sudah dibatalkan */ }
        reject(e);
      }
    });
  }

  async function setStatus(examId, status, errorText, verifiedAt) {
    const rec = await DB.get('exams', examId);
    if (!rec) return;
    rec.local_status = status;
    rec.last_error = errorText || null;
    if (verifiedAt) rec.verified_at = verifiedAt;
    await DB.put('exams', rec);
  }

  /* ---------- Verifikasi data yang tersimpan di perangkat ---------- */

  async function verifyStoredPackage(examId) {
    const errs = [];
    const rec = await DB.get('exams', examId);
    if (!rec || !rec.exam_raw || !rec.checksum) return ['Data ujian belum ada di perangkat'];

    const qs = (await DB.getAllByIndex('questions', 'exam_id', examId))
      .sort(function (a, b) { return a.number - b.number; });
    if (qs.length !== rec.question_count_local) {
      errs.push('Jumlah soal tersimpan ' + qs.length + ', seharusnya ' + rec.question_count_local);
    }

    const cs = await sha256Hex(packageJson(rec.exam_raw, qs.map(function (q) { return q.raw; }),
                                           rec.secure_raw, rec.key_slots));
    if (cs !== rec.checksum) errs.push('Checksum soal tersimpan tidak cocok');

    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q.has_image) continue;
      if (!q.image || !(q.image.blob instanceof Blob)) { errs.push('Gambar soal nomor ' + q.number + ' tidak ada'); continue; }
      if (q.image.blob.size !== q.image.size) { errs.push('Ukuran gambar soal nomor ' + q.number + ' berubah'); continue; }
      const h = await sha256Hex(await q.image.blob.arrayBuffer());
      if (h !== q.image.sha256) errs.push('Gambar soal nomor ' + q.number + ' rusak');
    }
    return errs;
  }

  async function checkStored(examId) {
    const errs = await verifyStoredPackage(examId);
    const rec = await DB.get('exams', examId);
    if (errs.length) {
      if (rec && rec.local_status === 'READY') await setStatus(examId, 'NOT_READY', errs.join('; '));
      return { ok: false, errors: errs };
    }
    if (rec) {
      rec.verified_at = new Date().toISOString();
      await DB.put('exams', rec);
    }
    return { ok: true, errors: [] };
  }

  /* ---------- PRE-SYNC ---------- */

  async function preSync(examId, onProgress) {
    const progress = (typeof onProgress === 'function') ? onProgress : function () {};
    let written = false;

    try {
      if (!navigator.onLine) return fail('OFFLINE', 'Perlu internet untuk mengunduh soal.');

      const old = await DB.get('exams', examId);
      const active = await getActiveAttempts(examId);

      progress('Meminta paket soal dari server...');
      const res = await Auth.authedCall('syncExam', { exam_id: examId });
      if (!res.success) return res;
      const data = res.data;
      if (data.secure === undefined) data.secure = null;
      if (data.key_slots === undefined) data.key_slots = [];

      progress('Memeriksa kelengkapan paket...');
      const errs = verifyPackage(data, examId);
      if (errs.length) return fail('PACKAGE_INVALID', 'Paket soal tidak valid: ' + errs.join('; '));

      const checksum = await sha256Hex(packageJson(data.exam, data.questions, data.secure, data.key_slots));
      if (checksum !== data.checksum) {
        return fail('CHECKSUM_MISMATCH', 'Paket soal rusak saat diunduh (checksum berbeda). Coba lagi.');
      }

      if (active.length) {
        if (old && old.checksum === checksum && old.local_status === 'READY') {
          return { success: true, data: { status: 'ALREADY_READY', message: 'Paket di perangkat sudah sama dengan server.' } };
        }
        return fail('ATTEMPT_ACTIVE',
          'Ujian ini sedang/sudah dikerjakan di perangkat ini dan hasilnya belum terkirim. ' +
          'Paket soal tidak boleh diganti sebelum hasil terkirim.');
      }

      const withImage = data.questions.filter(function (q) { return q.has_image; });
      const images = {};
      let imageBytes = 0;
      for (let i = 0; i < withImage.length; i++) {
        progress('Mengunduh gambar ' + (i + 1) + ' dari ' + withImage.length + '...');
        const img = await downloadImage(examId, withImage[i]);
        images[withImage[i].question_id] = img;
        imageBytes += img.size;
      }

      progress('Menyimpan ke perangkat...');
      const encrypted = !!data.secure;
      const now = new Date().toISOString();
      const examRecord = {};
      SERVER_FIELDS.forEach(function (f) { examRecord[f] = data.exam[f]; });
      Object.assign(examRecord, {
        local_status: 'VERIFYING',
        package_version: String(data.exam.version),
        checksum: checksum,
        exam_raw: data.exam,
        secure_raw: data.secure,
        key_slots: data.key_slots,
        encrypted: encrypted,
        token_count: data.key_slots.length,
        question_count_local: data.questions.length,
        image_count: withImage.length,
        image_bytes: imageBytes,
        downloaded_at: now,
        verified_at: null,
        list_updated_at: (old && old.list_updated_at) ? old.list_updated_at : now,
        last_error: null
      });

      const questionRecords = data.questions.map(function (q) {
        return {
          exam_id: examId,
          question_id: q.question_id,
          number: q.number,
          question: encrypted ? null : q.question,
          options: encrypted ? null : q.options,
          encrypted: encrypted,
          has_image: !!q.has_image,
          image: images[q.question_id] || null,
          version: q.version,
          raw: q
        };
      });

      written = true;
      await writePackage(examId, examRecord, questionRecords);

      progress('Memverifikasi data yang tersimpan...');
      const storedErrs = await verifyStoredPackage(examId);
      if (storedErrs.length) {
        await setStatus(examId, 'NOT_READY', storedErrs.join('; '));
        return fail('VERIFY_FAILED', 'Data tersimpan tidak lolos verifikasi: ' + storedErrs.join('; '));
      }

      await setStatus(examId, 'READY', null, new Date().toISOString());
      return {
        success: true,
        data: {
          status: 'READY',
          exam_id: examId,
          question_count: data.questions.length,
          image_count: withImage.length,
          image_bytes: imageBytes,
          encrypted: encrypted
        }
      };
    } catch (e) {
      if (written) {
        try { await setStatus(examId, 'NOT_READY', e.message); } catch (ignore) { /* abaikan */ }
      }
      return fail('PRESYNC_FAILED', e.message);
    }
  }

  return {
    isReady: isReady,
    saveExamList: saveExamList,
    getLocalExams: getLocalExams,
    getActiveAttempts: getActiveAttempts,
    preSync: preSync,
    verifyStoredPackage: verifyStoredPackage,
    checkStored: checkStored
  };
})();
