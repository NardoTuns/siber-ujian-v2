/**
 * SIBER-UJIAN — app.js
 * Mengatur login, beranda, daftar ujian, unduh soal, pengiriman hasil, dan penyimpanan.
 * Layar ujian diatur oleh exam.js. Pengiriman hasil diatur oleh submit.js.
 */
(function () {
  'use strict';

  const $ = UI.$;
  const el = UI.el;
  let busy = false;

  function setBusyAll(on) {
    busy = on;
    ['btn-load-exams', 'btn-download-all', 'btn-logout'].forEach(function (id) { $(id).disabled = on; });
    document.querySelectorAll('#exam-list button').forEach(function (b) { b.disabled = on; });
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    const s = $('net-status');
    s.textContent = online ? 'ONLINE' : 'OFFLINE';
    s.className = 'net-status ' + (online ? 'is-online' : 'is-offline');
  }

  function refreshDebug() {
    const x = Api.getLastExchange();
    $('debug-output').textContent = x
      ? JSON.stringify(x, function (k, v) {
          return (typeof v === 'string' && v.length > 300) ? v.substring(0, 60) + '... (' + v.length + ' karakter)' : v;
        }, 2)
      : 'Belum ada request ke server.';
  }

  function describeClockOffset(ms) {
    if (ms === null || ms === undefined) return 'Tidak diketahui';
    const sec = Math.round(Math.abs(ms) / 1000);
    if (sec <= 60) return 'Normal (selisih ' + sec + ' detik)';
    const arah = ms > 0 ? 'terlambat' : 'terlalu cepat';
    return 'PERIKSA: jam perangkat ' + arah + ' sekitar ' + Math.round(sec / 60) + ' menit';
  }

  function isHomeVisible() { return !$('screen-home').hidden; }

  /* ---------- Nama sekolah ---------- */

  async function loadSchoolName() {
    try {
      const cached = await DB.getSetting('app_config');
      if (cached) $('school-name').textContent = cached.school_name || '';
      if (!navigator.onLine) return;
      const res = await Api.call('getAppConfig', {});
      refreshDebug();
      if (res.success) {
        $('school-name').textContent = res.data.school_name || '';
        await DB.setSetting('app_config', res.data);
      }
    } catch (e) {
      console.error('Gagal memuat nama sekolah:', e);
    }
  }

  /* ---------- Melanjutkan ujian yang sedang berjalan ---------- */

  async function tryResume() {
    const s = Auth.getState();
    if (!s) return false;
    try {
      return await Exam.resumeIfAny(s.user);
    } catch (e) {
      await renderHome();
      UI.showScreen('home');
      UI.showMsg('home-message', 'error', 'Gagal melanjutkan ujian: ' + e.message);
      return true;
    }
  }

  /* ---------- Login ---------- */

  async function onLogin(event) {
    event.preventDefault();
    UI.hideMsg('login-message');
    const btn = $('btn-login');
    const pw = $('login-password');

    UI.setBusy(btn, true, 'Memeriksa...');
    let res;
    try {
      res = await Auth.login($('login-username').value, pw.value);
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    UI.setBusy(btn, false);
    pw.value = '';
    refreshDebug();

    if (!res.success) {
      UI.showMsg('login-message', 'error', UI.errorText(res));
      pw.focus();
      return;
    }

    // Login online memperbarui sesi -> hasil yang menunggu bisa langsung dikirim
    if (res.data.mode === 'ONLINE') Submit.run({ manual: true });

    if (await tryResume()) return;

    await renderHome();
    UI.showScreen('home');
    if (res.data.warning) UI.showMsg('session-message', 'warn', res.data.warning);
    else if (res.data.note) UI.showMsg('session-message', 'info', res.data.note);
  }

  function onTogglePassword() {
    const input = $('login-password');
    const btn = $('btn-toggle-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Sembunyi' : 'Lihat';
  }

  async function onPing() {
    const btn = $('btn-ping');
    UI.hideMsg('ping-message');
    UI.setBusy(btn, true, 'Menghubungi server...');
    const t0 = Date.now();
    const res = await Api.call('ping', {});
    UI.setBusy(btn, false);
    refreshDebug();
    if (res.success) UI.showMsg('ping-message', 'ok', 'Server aktif. Waktu respons ' + (Date.now() - t0) + ' ms.');
    else UI.showMsg('ping-message', 'error', UI.errorText(res));
  }

  /* ---------- Beranda ---------- */

  function renderAccount() {
    const s = Auth.getState();
    if (!s) return;
    const u = s.user;
    $('home-name').textContent = 'Halo, ' + u.name;
    const badge = $('home-mode');
    badge.textContent = s.mode === 'ONLINE' ? 'Masuk ONLINE' : 'Masuk OFFLINE (data perangkat)';
    badge.className = 'mode-badge ' + (s.mode === 'ONLINE' ? 'mode-online' : 'mode-offline');

    UI.setRows('home-info', [
      ['User ID', u.user_id],
      ['Username', u.username],
      ['Kelas', u.class],
      ['Role', u.role],
      ['Masuk pada', UI.formatDateTime(s.logged_in_at)],
      ['Sesi server', s.session_valid
        ? 'Berlaku sampai ' + UI.formatDateTime(s.session_expires_at)
        : 'HABIS (perlu login online untuk mengunduh/mengirim)'],
      ['Login online terakhir', UI.formatDateTime(s.last_online_login_at)],
      ['Login offline berlaku sampai', UI.formatDateTime(s.offline_valid_until)],
      ['Jam perangkat', describeClockOffset(s.clock_offset_ms) + ' (diukur saat login online terakhir)']
    ]);

    if (!s.session_valid) {
      UI.showMsg('session-message', 'warn',
        'Sesi server sudah habis. Anda tetap bisa memakai data di perangkat. ' +
        'Untuk mengunduh soal atau mengirim hasil, tekan Keluar lalu login lagi saat ada internet.');
    } else {
      UI.hideMsg('session-message');
    }
  }

  async function renderHome() {
    const s = Auth.getState();
    if (!s) { UI.showScreen('login'); return; }
    renderAccount();
    UI.hideMsg('home-message');
    await renderResults();
    await showLocalExams();
    await renderStorage();
  }

  /* ---------- Hasil ujian (kirim ke server) ---------- */

  function badge(text, cls) { return el('span', { className: 'badge ' + (cls || ''), text: text }); }

  function resultStatusView(a, item) {
    if (a.sync_status === 'SYNCED') {
      let text = 'Terkirim ke server pada ' + UI.formatDateTime(a.synced_at) + '.';
      if (a.server_score !== undefined && a.server_score !== null) {
        text += ' Nilai: ' + a.server_score + ' (benar ' + a.server_correct + ', salah ' + a.server_wrong + ').';
      }
      return { badge: badge('TERKIRIM', 'badge-done'), text: text, type: 'ok' };
    }
    const st = item ? item.status : 'PENDING';
    if (st === 'SENDING') {
      return { badge: badge('SEDANG DIKIRIM', 'badge-warn'), text: 'Sedang dikirim ke server...', type: 'info' };
    }
    if (st === 'NEED_LOGIN') {
      return { badge: badge('PERLU LOGIN ONLINE', 'badge-warn'), text: item.last_error || 'Login online untuk mengirim.', type: 'warn' };
    }
    if (st === 'FAILED') {
      return {
        badge: badge('GAGAL - HUBUNGI GURU', 'badge-warn'),
        text: (item.last_error || 'Ditolak server.') +
              ' Data tetap aman di perangkat. Setelah guru memperbaiki, tekan "Kirim hasil sekarang".',
        type: 'error'
      };
    }
    let text = 'Menunggu dikirim. Akan dikirim otomatis saat ada internet.';
    if (item && item.last_error) {
      text += ' Percobaan terakhir: ' + item.last_error;
      if (item.next_try_at) text += ' Dicoba lagi sekitar pukul ' + UI.formatClock(new Date(item.next_try_at).toISOString()) + '.';
    }
    return { badge: badge('MENUNGGU DIKIRIM', 'badge-warn'), text: text, type: 'warn' };
  }

  async function renderResults() {
    const s = Auth.getState();
    if (!s) return;
    let data;
    try {
      data = await Submit.listForUser(s.user.user_id);
    } catch (e) {
      UI.showMsg('results-message', 'error', 'Gagal membaca hasil di perangkat: ' + e.message);
      return;
    }
    const list = $('results-list');
    list.replaceChildren();

    if (!data.mine.length) {
      list.appendChild(el('p', { className: 'small', text: 'Belum ada hasil ujian milik akun ini di perangkat.' }));
    }
    data.mine.forEach(function (row) {
      const a = row.attempt;
      const v = resultStatusView(a, row.item);
      list.appendChild(el('div', { className: 'exam-card' }, [
        el('h4', { text: a.exam_name }),
        el('div', { className: 'exam-meta', text: 'Selesai ' + UI.formatDateTime(a.completed_at) +
          ' | Terjawab ' + a.answered_count + ' dari ' + (a.question_order || []).length }),
        el('div', null, [v.badge]),
        el('div', { className: 'msg msg-' + v.type, text: v.text }),
        el('div', { className: 'exam-meta', text: 'Kode attempt: ' + a.attempt_id })
      ]));
    });

    if (data.othersPending > 0) {
      list.appendChild(el('div', { className: 'msg msg-info',
        text: 'Ada ' + data.othersPending + ' hasil milik akun lain di perangkat ini yang belum terkirim. ' +
              'Hasil tersebut dikirim otomatis selama sesi akun pemiliknya masih berlaku.' }));
    }

    const btn = $('btn-sync-now');
    if (Submit.isRunning()) {
      btn.disabled = true;
      btn.textContent = 'Sedang mengirim...';
    } else {
      btn.disabled = false;
      btn.textContent = 'Kirim hasil sekarang';
    }
  }

  async function onSyncNow() {
    UI.hideMsg('results-message');
    if (!navigator.onLine) {
      UI.showMsg('results-message', 'warn', 'Perangkat offline. Hasil akan dikirim otomatis saat ada internet.');
      return;
    }
    const r = await Submit.run({ manual: true });
    refreshDebug();
    if (r && r.busy) {
      UI.showMsg('results-message', 'info', 'Pengiriman sedang berjalan (mungkin di tab lain).');
    } else if (r && r.error) {
      UI.showMsg('results-message', 'error', 'Terjadi kesalahan: ' + r.error);
    } else if (r) {
      const parts = [];
      if (r.sent) parts.push(r.sent + ' terkirim');
      if (r.retry) parts.push(r.retry + ' akan dicoba lagi');
      if (r.need_login) parts.push(r.need_login + ' perlu login online');
      if (r.failed) parts.push(r.failed + ' gagal');
      UI.showMsg('results-message', (r.failed || r.need_login || r.retry) ? 'warn' : 'ok',
        parts.length ? parts.join(', ') + '.' : 'Tidak ada hasil yang perlu dikirim.');
    }
    await renderResults();
    await showLocalExams();
  }

  /* ---------- Daftar ujian ---------- */

  function modeText(e) {
    if (e.mode === 'TOTAL') return 'Mode TOTAL: ' + Math.round(e.duration_seconds / 60) + ' menit untuk seluruh soal';
    if (e.mode === 'PER_SOAL') return 'Mode PER SOAL: ' + e.duration_seconds + ' detik per soal';
    return 'Mode tidak dikenal: ' + e.mode;
  }

  function readinessInfo(e) {
    if (Sync.isReady(e)) {
      return {
        ready: true,
        text: 'Paket versi ' + e.package_version + ': ' + e.question_count_local + ' soal, ' +
              e.image_count + ' gambar (' + UI.formatBytes(e.image_bytes) + '). Diunduh ' +
              UI.formatDateTime(e.downloaded_at) + '.'
      };
    }
    if (!e.package_version) return { ready: false, text: 'Soal belum diunduh ke perangkat ini.' };
    if (String(e.package_version) !== String(e.version)) {
      return { ready: false, text: 'Versi baru tersedia (versi ' + e.version + '). Perlu unduh ulang.' };
    }
    if (e.local_status === 'VERIFYING') {
      return { ready: false, text: 'Unduhan sebelumnya terhenti sebelum selesai diverifikasi. Perlu unduh ulang.' };
    }
    return { ready: false, text: e.last_error ? ('Belum siap: ' + e.last_error) : 'Belum siap. Perlu unduh ulang.' };
  }

  function actionButton(action, label, cls, examId) {
    return el('button', {
      className: 'btn ' + cls,
      type: 'button',
      text: label,
      data: { action: action, examId: examId },
      disabled: busy
    });
  }

  function renderExamCard(e, submitted, attempt, isStudent) {
    const info = readinessInfo(e);
    const badges = [];
    const actions = [];
    let statusText = info.text;

    if (attempt && attempt.status === 'IN_PROGRESS') {
      badges.push(badge('SEDANG DIKERJAKAN', 'badge-warn'));
      statusText = 'Ujian sedang berjalan. Waktu terus berjalan.';
      actions.push(actionButton('start', 'Lanjutkan ujian', 'btn-primary', e.exam_id));
    } else if (attempt) {
      const synced = attempt.sync_status === 'SYNCED';
      badges.push(badge(synced ? 'SELESAI - TERKIRIM' : 'SELESAI - BELUM TERKIRIM', synced ? 'badge-done' : 'badge-warn'));
      statusText = 'Selesai ' + UI.formatDateTime(attempt.completed_at) + '. Terjawab ' +
        attempt.answered_count + ' dari ' + (attempt.question_order || []).length + '.' +
        (synced ? ' Hasil sudah diterima server.' : ' Lihat status pengiriman di bagian "Hasil ujian".');
    } else {
      badges.push(info.ready ? badge('READY', 'badge-done') : badge('BELUM SIAP', 'badge-warn'));
      if (info.ready) {
        if (isStudent) actions.push(actionButton('start', 'Mulai ujian', 'btn-primary', e.exam_id));
        actions.push(actionButton('verify', 'Periksa data', 'btn-light', e.exam_id));
        actions.push(actionButton('download', 'Unduh ulang', 'btn-light', e.exam_id));
      } else {
        actions.push(actionButton('download', 'Unduh soal', 'btn-primary', e.exam_id));
      }
    }

    if (submitted === true && !attempt) badges.push(badge('Sudah ada hasil di server', 'badge-done'));
    if (e.random_question) badges.push(badge('Soal diacak'));
    if (e.random_option) badges.push(badge('Pilihan diacak'));
    if (e.token_required) badges.push(badge('Perlu token'));

    return el('div', { className: 'exam-card' }, [
      el('h4', { text: e.exam_name }),
      el('div', { className: 'exam-meta', text: 'ID: ' + e.exam_id + ' | ' + e.subject + ' kelas ' + e.grade }),
      el('div', { className: 'exam-meta', text: modeText(e) }),
      el('div', { className: 'exam-meta', text: e.question_count + ' soal | Periode ' + e.start_date + ' s/d ' + e.end_date }),
      el('div', { className: 'exam-meta', text: statusText }),
      el('div', null, badges),
      actions.length ? el('div', { className: 'btn-row' }, actions) : null
    ]);
  }

  async function showLocalExams(message, type, submittedMap) {
    const s = Auth.getState();
    if (!s) return;
    const isStudent = s.user.role === 'STUDENT';
    let exams;
    let attempts = {};
    try {
      exams = await Sync.getLocalExams(s.user);
      if (isStudent) attempts = await Exam.getUserAttempts(s.user.user_id);
    } catch (e) {
      UI.showMsg('home-message', 'error', 'Gagal membaca daftar ujian di perangkat: ' + e.message);
      return;
    }
    const list = $('exam-list');
    list.replaceChildren();
    exams.forEach(function (e) {
      list.appendChild(renderExamCard(e, submittedMap ? submittedMap[e.exam_id] : undefined,
                                      attempts[e.exam_id], isStudent));
    });
    if (message) {
      UI.showMsg('home-message', type || 'info', message);
    } else if (!exams.length) {
      UI.showMsg('home-message', 'info', 'Belum ada daftar ujian di perangkat ini. Tekan "Perbarui daftar ujian" saat ada internet.');
    }
  }

  async function refreshExamList(showResult) {
    const res = await Auth.authedCall('getExamList', {});
    refreshDebug();
    if (!res.success) {
      renderAccount();
      await showLocalExams('Gagal memperbarui dari server: ' + UI.errorText(res) +
        ' Menampilkan data yang tersimpan di perangkat.', 'error');
      return false;
    }
    const exams = res.data.exams || [];
    const submitted = {};
    exams.forEach(function (e) { submitted[e.exam_id] = !!e.already_submitted; });
    try {
      await Sync.saveExamList(exams);
    } catch (e) {
      UI.showMsg('home-message', 'error', 'Daftar diterima dari server tetapi GAGAL disimpan ke perangkat: ' + e.message);
      return false;
    }
    await showLocalExams(showResult ? exams.length + ' ujian diperbarui dari server dan disimpan di perangkat.' : null,
                         'ok', submitted);
    return true;
  }

  async function onLoadExams() {
    if (busy) return;
    UI.hideMsg('home-message');
    if (!navigator.onLine) {
      await showLocalExams('Perangkat offline. Menampilkan daftar ujian yang tersimpan di perangkat.', 'warn');
      return;
    }
    setBusyAll(true);
    try {
      await refreshExamList(true);
    } catch (e) {
      UI.showMsg('home-message', 'error', 'Terjadi kesalahan: ' + e.message);
    }
    setBusyAll(false);
    await renderStorage();
  }

  /* ---------- PRE-SYNC ---------- */

  async function runPreSync(examId) {
    if (!navigator.onLine) {
      UI.showMsg('home-message', 'warn', 'Perlu internet untuk mengunduh soal.');
      return { success: false, error: { code: 'OFFLINE', message: 'Offline' } };
    }
    DB.requestPersistence();
    setBusyAll(true);
    let res;
    try {
      res = await Sync.preSync(examId, function (text) { UI.showMsg('home-message', 'info', examId + ': ' + text); });
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    setBusyAll(false);
    refreshDebug();
    renderAccount();
    await showLocalExams();

    if (res.success) {
      const d = res.data;
      const text = d.status === 'ALREADY_READY'
        ? d.message
        : 'READY. ' + d.question_count + ' soal dan ' + d.image_count + ' gambar (' +
          UI.formatBytes(d.image_bytes) + ') tersimpan dan terverifikasi' + (d.encrypted ? ' (soal terkunci token).' : '.');
      UI.showMsg('home-message', 'ok', examId + ': ' + text);
    } else {
      UI.showMsg('home-message', 'error', examId + ': ' + UI.errorText(res));
    }
    await renderStorage();
    return res;
  }

  async function runVerify(examId) {
    setBusyAll(true);
    UI.showMsg('home-message', 'info', examId + ': memeriksa data yang tersimpan...');
    let r;
    try {
      r = await Sync.checkStored(examId);
    } catch (e) {
      r = { ok: false, errors: [e.message] };
    }
    setBusyAll(false);
    await showLocalExams();
    if (r.ok) UI.showMsg('home-message', 'ok', examId + ': data di perangkat lengkap dan utuh.');
    else UI.showMsg('home-message', 'error', examId + ': data bermasalah, perlu unduh ulang. ' + r.errors.join('; '));
  }

  async function onStartExam(examId) {
    const s = Auth.getState();
    if (!s) return;
    UI.hideMsg('home-message');
    setBusyAll(true);
    let r;
    try {
      r = await Exam.openIntro(s.user, examId);
    } catch (e) {
      r = { ok: false, code: 'CLIENT_ERROR', message: e.message };
    }
    setBusyAll(false);
    if (!r.ok) UI.showMsg('home-message', 'error', r.message + ' [' + r.code + ']');
  }

  async function onExamListClick(event) {
    const btn = event.target.closest('button[data-action]');
    if (!btn || busy) return;
    const examId = btn.dataset.examId;
    if (btn.dataset.action === 'download') await runPreSync(examId);
    else if (btn.dataset.action === 'verify') await runVerify(examId);
    else if (btn.dataset.action === 'start') await onStartExam(examId);
  }

  async function onDownloadAll() {
    if (busy) return;
    UI.hideMsg('home-message');
    if (!navigator.onLine) {
      UI.showMsg('home-message', 'warn', 'Perlu internet untuk mengunduh soal.');
      return;
    }
    setBusyAll(true);
    UI.showMsg('home-message', 'info', 'Memperbarui daftar ujian...');
    let listOk = false;
    try {
      listOk = await refreshExamList(false);
    } catch (e) {
      UI.showMsg('home-message', 'error', 'Terjadi kesalahan: ' + e.message);
    }
    setBusyAll(false);
    if (!listOk) return;

    const s = Auth.getState();
    const exams = await Sync.getLocalExams(s.user);
    const attempts = s.user.role === 'STUDENT' ? await Exam.getUserAttempts(s.user.user_id) : {};
    const targets = exams.filter(function (e) {
      return e.status === 'ACTIVE' && !Sync.isReady(e) && !attempts[e.exam_id];
    });
    if (!targets.length) {
      UI.showMsg('home-message', 'ok', 'Semua ujian aktif sudah READY di perangkat ini.');
      return;
    }

    const summary = [];
    let allOk = true;
    for (let i = 0; i < targets.length; i++) {
      const r = await runPreSync(targets[i].exam_id);
      if (r && r.success) {
        summary.push(targets[i].exam_id + ': READY');
      } else {
        allOk = false;
        summary.push(targets[i].exam_id + ': GAGAL (' + (r && r.error ? r.error.message : '?') + ')');
      }
    }
    UI.showMsg('home-message', allOk ? 'ok' : 'warn', summary.join(' | '));
  }

  /* ---------- Penyimpanan perangkat ---------- */

  async function renderStorage() {
    try {
      const info = await DB.storageInfo();
      const counts = await DB.stats();
      const test = await DB.getSetting('storage_test');

      let persistText = 'Tidak diketahui (browser tidak mendukung)';
      if (info.persisted === true) persistText = 'YA (data tidak dihapus otomatis)';
      else if (info.persisted === false) persistText = 'BELUM (bisa terhapus jika memori sangat penuh)';

      const rows = [
        ['Database', DB.NAME + ' versi ' + DB.VERSION],
        ['Penyimpanan permanen', persistText],
        ['Terpakai', UI.formatBytes(info.usage) + ' dari kuota ' + UI.formatBytes(info.quota)],
        ['Tes simpan terakhir', test ? ('Kode ' + test.code + ' pada ' + UI.formatDateTime(test.written_at)) : 'Belum pernah']
      ];
      DB.STORES.forEach(function (name) { rows.push(['Jumlah data: ' + name, counts[name]]); });
      UI.setRows('storage-info', rows);
    } catch (e) {
      UI.showMsg('storage-message', 'error', 'Gagal membaca info penyimpanan: ' + e.message);
    }
  }

  async function onStorageTest() {
    UI.hideMsg('storage-message');
    try {
      const value = {
        written_at: new Date().toISOString(),
        code: Math.random().toString(36).slice(2, 8).toUpperCase()
      };
      await DB.setSetting('storage_test', value);
      const back = await DB.getSetting('storage_test');
      if (back && back.code === value.code) {
        UI.showMsg('storage-message', 'ok',
          'Data tersimpan dan terbaca kembali. Kode: ' + value.code +
          '. Tutup browser (atau matikan-nyalakan HP), buka lagi, dan pastikan kode ini masih ada.');
      } else {
        UI.showMsg('storage-message', 'error', 'Data tertulis tetapi tidak terbaca kembali dengan benar.');
      }
    } catch (e) {
      UI.showMsg('storage-message', 'error', 'Gagal menyimpan: ' + e.message);
    }
    await renderStorage();
  }

  async function onWipe() {
    if (busy) return;
    let unsynced = 0;
    try { unsynced = await Exam.countUnsyncedAttempts(); } catch (e) { unsynced = 0; }

    let phrase = 'HAPUS';
    let warning = 'PERINGATAN: semua data aplikasi di perangkat ini akan dihapus.\n';
    if (unsynced > 0) {
      phrase = 'HAPUS DATA UJIAN';
      warning += 'BAHAYA: ada ' + unsynced + ' hasil ujian yang BELUM TERKIRIM ke server. ' +
                 'Jika dihapus, hasil tersebut HILANG PERMANEN.\n';
    }
    const answer = prompt(warning + 'Ketik ' + phrase + ' (huruf besar) untuk melanjutkan.');
    if (answer !== phrase) { alert('Dibatalkan. Tidak ada data yang dihapus.'); return; }
    try {
      await DB.deleteDatabase();
      alert('Semua data lokal sudah dihapus. Halaman akan dimuat ulang.');
      location.reload();
    } catch (e) {
      alert('Gagal menghapus: ' + e.message);
    }
  }

  async function onLogout() {
    if (busy) return;
    try {
      await Auth.logout();
    } catch (e) {
      console.error(e);
    }
    $('login-username').value = '';
    UI.hideMsg('login-message');
    UI.showScreen('login');
  }

  /* ---------- Kembali dari layar ujian ---------- */

  async function backToHome(message) {
    await renderHome();
    UI.showScreen('home');
    if (message) UI.showMsg('home-message', 'warn', message);
    if (navigator.onLine) Submit.run();
  }

  /* ---------- Mulai ---------- */

  async function init() {
    $('footer-version').textContent = 'Versi klien ' + SIBER_CONFIG.CLIENT_VERSION;
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    $('login-form').addEventListener('submit', onLogin);
    $('btn-toggle-password').addEventListener('click', onTogglePassword);
    $('btn-ping').addEventListener('click', onPing);
    $('btn-sync-now').addEventListener('click', onSyncNow);
    $('btn-load-exams').addEventListener('click', onLoadExams);
    $('btn-download-all').addEventListener('click', onDownloadAll);
    $('exam-list').addEventListener('click', onExamListClick);
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-storage-test').addEventListener('click', onStorageTest);
    $('btn-storage-refresh').addEventListener('click', renderStorage);
    $('btn-wipe').addEventListener('click', onWipe);

    Exam.init({ onExit: backToHome });

    if (!Api.isConfigured()) {
      UI.showScreen('setup');
      return;
    }
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      $('fatal-message').textContent = 'Halaman harus dibuka lewat alamat https (GitHub Pages). Fitur keamanan browser tidak tersedia.';
      UI.showScreen('fatal');
      return;
    }
    try {
      await DB.open();
    } catch (e) {
      $('fatal-message').textContent = 'Penyimpanan lokal (IndexedDB) tidak bisa dibuka: ' + e.message;
      UI.showScreen('fatal');
      return;
    }

    DB.requestPersistence();
    loadSchoolName();

    // Pengiriman otomatis: saat dibuka, saat internet kembali, dan setiap 1 menit
    Submit.onChange(function () {
      if (isHomeVisible()) {
        renderResults();
        showLocalExams();
      }
    });
    Submit.init();

    let restored = null;
    try {
      restored = await Auth.restore();
    } catch (e) {
      console.error('Gagal memulihkan login:', e);
    }

    if (restored) {
      if (await tryResume()) return;
      await renderHome();
      UI.showScreen('home');
    } else {
      UI.showScreen('login');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
