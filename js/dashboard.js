/**
 * SIBER-UJIAN — dashboard.js
 * Dashboard guru: ringkasan, rekap kelas, peserta, detail jawaban, analisis soal.
 * Hanya untuk role TEACHER/ADMIN (server juga menolak role lain).
 * Data = hasil yang SUDAH dikirim ke server. Saat offline memakai data terakhir yang tersimpan.
 */
(function () {
  'use strict';

  const $ = UI.$;
  const el = UI.el;
  const AUTO_MS = 60000;

  let lastData = null;
  let autoHandle = null;
  let loading = false;

  /* ---------- Bantuan ---------- */

  function updateNetStatus() {
    const online = navigator.onLine;
    const s = $('net-status');
    s.textContent = online ? 'ONLINE' : 'OFFLINE';
    s.className = 'net-status ' + (online ? 'is-online' : 'is-offline');
  }

  function isTeacher(state) {
    return !!state && (state.user.role === 'TEACHER' || state.user.role === 'ADMIN');
  }

  function show(v) { return (v === null || v === undefined || v === '') ? '-' : String(v); }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
  }

  function durationText(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (isNaN(x) || isNaN(y)) return '-';
    return Math.max(0, Math.round((y - x) / 60000)) + ' mnt';
  }

  const REASON_TEXT = {
    MANUAL: 'Selesai sendiri',
    TIME_UP: 'Waktu habis',
    ALL_DONE: 'Semua soal selesai',
    DATA_ERROR: 'Data perangkat rusak'
  };

  function badge(text, cls) { return el('span', { className: 'badge ' + (cls || ''), text: text }); }

  /** cell: teks/angka, Node, atau { text, className, title } */
  function td(cell) {
    if (cell instanceof Node) return el('td', null, [cell]);
    if (cell && typeof cell === 'object') {
      const c = el('td', { text: show(cell.text), className: cell.className || '' });
      if (cell.title) c.title = cell.title;
      return c;
    }
    return el('td', { text: show(cell) });
  }

  function table(headers, rows, rowClassFn) {
    const thead = el('thead', null, [el('tr', null, headers.map(function (h) { return el('th', { text: h }); }))]);
    const tbody = el('tbody', null, rows.map(function (r, i) {
      const tr = el('tr', null, r.cells.map(td));
      if (rowClassFn) tr.className = rowClassFn(r, i) || '';
      return tr;
    }));
    return el('table', { className: 'data-table' }, [thead, tbody]);
  }

  function percentCell(pct) {
    const wrap = el('div', null, [el('div', { text: show(pct) + '%' })]);
    const bar = el('div', { className: 'bar' }, [el('span')]);
    bar.firstChild.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
    wrap.appendChild(bar);
    return wrap;
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

    if (!res.success) {
      UI.showMsg('login-message', 'error', UI.errorText(res));
      return;
    }
    const s = Auth.getState();
    if (!isTeacher(s)) {
      await Auth.logout();
      UI.showMsg('login-message', 'error', 'Halaman ini khusus guru/admin. Siswa silakan memakai aplikasi ujian.');
      return;
    }
    await openDashboard();
  }

  function onTogglePassword() {
    const input = $('login-password');
    const btn = $('btn-toggle-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Sembunyi' : 'Lihat';
  }

  async function onLogout() {
    stopAuto();
    $('chk-auto').checked = false;
    await Auth.logout();
    $('login-username').value = '';
    UI.showScreen('login');
  }

  /* ---------- Daftar ujian ---------- */

  async function loadExamList() {
    let exams = null;
    if (navigator.onLine) {
      const res = await Auth.authedCall('getDashboard', {});
      if (res.success) {
        exams = res.data.exams || [];
        await DB.setSetting('dash_exams', exams);
      } else {
        UI.showMsg('dash-message', 'error', 'Gagal memuat daftar ujian: ' + UI.errorText(res));
      }
    }
    if (!exams) exams = (await DB.getSetting('dash_exams')) || [];

    const sel = $('sel-exam');
    const keep = sel.value || (await DB.getSetting('dash_last_exam')) || '';
    sel.replaceChildren();
    if (!exams.length) {
      sel.appendChild(el('option', { text: '(belum ada ujian)' }));
      return false;
    }
    exams.forEach(function (e) {
      const o = el('option', { text: e.exam_name + ' (' + e.exam_id + ') - ' + e.synced_count + ' hasil' });
      o.value = e.exam_id;
      sel.appendChild(o);
    });
    if (keep && exams.some(function (e) { return e.exam_id === keep; })) sel.value = keep;
    return true;
  }

  /* ---------- Dashboard ---------- */

  function cacheKey(examId, cls) { return 'dash_cache:' + examId + ':' + (cls || 'ALL'); }

  async function loadDashboard(quiet) {
    const examId = $('sel-exam').value;
    if (!examId || loading) return;
    const cls = $('sel-class').value;
    loading = true;
    const btn = $('btn-refresh');
    if (!quiet) UI.setBusy(btn, true, 'Memuat...');
    await DB.setSetting('dash_last_exam', examId);

    try {
      if (navigator.onLine) {
        const res = await Auth.authedCall('getDashboard', { exam_id: examId, class: cls });
        if (res.success) {
          const fetchedAt = new Date().toISOString();
          await DB.setSetting(cacheKey(examId, cls), { data: res.data, fetched_at: fetchedAt });
          render(res.data, fetchedAt, false);
          if (!quiet) UI.hideMsg('dash-message');
          return;
        }
        UI.showMsg('dash-message', 'error', 'Gagal memuat dashboard: ' + UI.errorText(res) +
          (res.error && (res.error.code === 'SESSION_EXPIRED' || res.error.code === 'UNAUTHORIZED')
            ? ' Tekan Keluar lalu login lagi.' : ''));
      }
      const cached = await DB.getSetting(cacheKey(examId, cls));
      if (cached) {
        render(cached.data, cached.fetched_at, true);
        if (!navigator.onLine) {
          UI.showMsg('dash-message', 'warn', 'Perangkat offline. Menampilkan data terakhir yang tersimpan.');
        }
      } else if (!navigator.onLine) {
        UI.showMsg('dash-message', 'warn', 'Perangkat offline dan belum ada data tersimpan untuk pilihan ini.');
      }
    } catch (e) {
      UI.showMsg('dash-message', 'error', 'Terjadi kesalahan: ' + e.message);
    } finally {
      loading = false;
      if (!quiet) UI.setBusy(btn, false);
    }
  }

  function render(data, fetchedAt, fromCache) {
    lastData = data;
    window.SIBER_DASH = { data: data, fetched_at: fetchedAt, from_cache: fromCache, teacher: Auth.getState() ? Auth.getState().user.name : '' };
    const e = data.exam;
    $('dash-exam-info').textContent =
      e.exam_name + ' | ' + e.subject + ' kelas ' + e.grade + ' | Mode ' + e.mode +
      ' | Versi ' + e.version + (e.token_required ? ' | Bertoken' : '') +
      ' | Periode ' + e.start_date + ' s/d ' + e.end_date +
      ' | Data diambil: ' + UI.formatDateTime(fetchedAt) + (fromCache ? ' (tersimpan)' : '');
    UI.showMsg('dash-note', 'info', data.note || '');

    // Pilihan kelas
    const selC = $('sel-class');
    const keep = selC.value;
    selC.replaceChildren(el('option', { text: 'Semua kelas' }));
    selC.firstChild.value = '';
    (data.classes || []).forEach(function (c) {
      const o = el('option', { text: c });
      o.value = c;
      selC.appendChild(o);
    });
    selC.value = (data.classes || []).indexOf(keep) !== -1 ? keep : '';

    renderSummary(data.summary);
    renderByClass(data.by_class || []);
    renderParticipants();
    renderItems(data.item_analysis || []);
  }

  function renderSummary(s) {
    const items = [
      ['Peserta', s.total_participants, ''],
      ['Sudah terkirim', s.synced, 'good'],
      ['Belum terkirim', s.not_synced, s.not_synced ? 'warn' : ''],
      ['Rata-rata', s.average, ''],
      ['Median', s.median, ''],
      ['Tertinggi', s.highest, ''],
      ['Terendah', s.lowest, ''],
      ['Ada catatan', s.with_warnings, s.with_warnings ? 'warn' : '']
    ];
    $('summary-grid').replaceChildren.apply($('summary-grid'), items.map(function (it) {
      return el('div', { className: 'stat ' + it[2] }, [
        el('div', { className: 'stat-label', text: it[0] }),
        el('div', { className: 'stat-value', text: show(it[1]) })
      ]);
    }));
  }

  function renderByClass(rows) {
    const box = $('by-class');
    box.replaceChildren();
    if (!rows.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada data kelas.' })); return; }
    box.appendChild(table(
      ['Kelas', 'Peserta', 'Terkirim', 'Belum', 'Rata-rata', 'Tertinggi', 'Terendah'],
      rows.map(function (r) {
        return { cells: [r.class, { text: r.total, className: 'num' }, { text: r.synced, className: 'num' },
          { text: r.not_synced, className: 'num' }, { text: r.average, className: 'num' },
          { text: r.highest, className: 'num' }, { text: r.lowest, className: 'num' }] };
      })
    ));
  }

  function sortParticipants(list) {
    const mode = $('sel-sort').value;
    const arr = list.slice();
    const score = function (p) { return p.score === null ? -1 : p.score; };
    const hasWarn = function (p) { return !!(p.warnings || p.clock_flags || p.note); };
    arr.sort(function (a, b) {
      if (mode === 'score_desc') return score(b) - score(a);
      if (mode === 'score_asc') {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return a.score - b.score;
      }
      if (mode === 'status' && a.status !== b.status) return a.status === 'BELUM_SYNC' ? -1 : 1;
      if (mode === 'warn' && hasWarn(a) !== hasWarn(b)) return hasWarn(a) ? -1 : 1;
      return (a.class + '|' + a.name).localeCompare(b.class + '|' + b.name);
    });
    return arr;
  }

  function renderParticipants() {
    const box = $('participants');
    box.replaceChildren();
    if (!lastData) return;
    const list = sortParticipants(lastData.participants || []);
    if (!list.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada peserta.' })); return; }

    const rows = list.map(function (p, i) {
      const notes = [p.clock_flags, p.warnings, p.note].filter(Boolean).join(' | ');
      const detailBtn = p.attempt_id
        ? el('button', { className: 'btn btn-light btn-small', type: 'button', text: 'Detail', data: { attempt: p.attempt_id } })
        : el('span', { className: 'muted', text: '-' });
      return {
        p: p,
        cells: [
          { text: i + 1, className: 'num' },
          p.name,
          p.class,
          p.status === 'SYNCED' ? badge('TERKIRIM', 'badge-done') : badge('BELUM TERKIRIM', 'badge-warn'),
          { text: p.score, className: 'num' },
          { text: p.correct, className: 'num' },
          { text: p.wrong, className: 'num' },
          UI.formatDateTime(p.started_at),
          UI.formatDateTime(p.completed_at),
          { text: p.status === 'SYNCED' ? durationText(p.started_at, p.completed_at) : '-', className: 'num' },
          REASON_TEXT[p.finish_reason] || show(p.finish_reason),
          notes ? { text: '⚠ ' + truncate(notes, 70), title: notes, className: 'wrap' } : '-',
          detailBtn
        ]
      };
    });

    box.appendChild(table(
      ['No', 'Nama', 'Kelas', 'Status', 'Nilai', 'Benar', 'Salah', 'Mulai', 'Selesai', 'Durasi', 'Cara selesai', 'Catatan', ''],
      rows,
      function (r) {
        if (r.p.status !== 'SYNCED') return 'row-missing';
        if (r.p.warnings || r.p.clock_flags || r.p.note) return 'row-warn';
        return '';
      }
    ));
  }

  function renderItems(items) {
    const box = $('items');
    box.replaceChildren();
    if (!items.length) { box.appendChild(el('p', { className: 'small', text: 'Belum ada data soal.' })); return; }
    box.appendChild(table(
      ['No', 'Soal', 'Dijawab', 'Benar', 'Salah', 'Kosong', '% Benar', 'Kategori', 'Sebaran pilihan'],
      items.map(function (q) {
        const d = q.distribution || {};
        return {
          cells: [
            { text: q.number, className: 'num' },
            { text: truncate(q.question, 90), title: q.question, className: 'wrap' },
            { text: q.total_answer, className: 'num' },
            { text: q.correct, className: 'num' },
            { text: q.wrong, className: 'num' },
            { text: q.blank, className: 'num' },
            percentCell(q.percent_correct),
            q.difficulty,
            'A:' + show(d.A) + '  B:' + show(d.B) + '  C:' + show(d.C) + '  D:' + show(d.D)
          ]
        };
      })
    ));
  }

  /* ---------- Detail jawaban ---------- */

  async function openDetail(attemptId) {
    $('detail-modal').hidden = false;
    $('detail-title').textContent = 'Detail jawaban';
    $('detail-info').replaceChildren();
    $('detail-answers').replaceChildren();
    if (!navigator.onLine) {
      UI.showMsg('detail-message', 'warn', 'Detail jawaban memerlukan internet.');
      return;
    }
    UI.showMsg('detail-message', 'info', 'Memuat...');
    const res = await Auth.authedCall('getAttemptDetail', { attempt_id: attemptId });
    if (!res.success) {
      UI.showMsg('detail-message', 'error', UI.errorText(res));
      return;
    }
    UI.hideMsg('detail-message');
    const r = res.data.result;
    $('detail-title').textContent = r.name + ' (' + r.class + ')';
    UI.setRows('detail-info', [
      ['Nilai', r.score + ' (benar ' + r.correct + ', salah ' + r.wrong + ' dari ' + r.total_questions + ')'],
      ['Mulai / selesai', UI.formatDateTime(r.started_at) + ' / ' + UI.formatDateTime(r.completed_at)],
      ['Durasi', durationText(r.started_at, r.completed_at)],
      ['Cara selesai', REASON_TEXT[r.finish_reason] || show(r.finish_reason)],
      ['Terkirim', UI.formatDateTime(r.synced_at)],
      ['Token', show(r.token_id)],
      ['Versi paket / aplikasi', show(r.package_version) + ' / ' + show(r.client_version)],
      ['Catatan jam', show(r.clock_flags)],
      ['Peringatan', show(r.warnings)],
      ['Kode attempt', r.attempt_id]
    ]);
    $('detail-answers').appendChild(table(
      ['No', 'Soal', 'Jawaban', 'Hasil', 'Waktu menjawab'],
      res.data.answers.map(function (a) {
        let hasil;
        if (!a.answer) hasil = el('span', { className: 'muted', text: 'Kosong' });
        else if (a.is_correct) hasil = el('span', { className: 'ok-text', text: '✔ Benar' });
        else hasil = el('span', { className: 'bad-text', text: '✘ Salah' });
        return {
          cells: [
            { text: a.number, className: 'num' },
            { text: truncate(a.question, 90), title: a.question, className: 'wrap' },
            a.answer || '-',
            hasil,
            a.answered_at ? UI.formatClock(a.answered_at) : '-'
          ]
        };
      })
    ));
  }

  function closeDetail() { $('detail-modal').hidden = true; }

  /* ---------- Perbarui otomatis ---------- */

  function startAuto() {
    stopAuto();
    autoHandle = setInterval(function () {
      if (navigator.onLine && document.visibilityState === 'visible' && !loading) loadDashboard(true);
    }, AUTO_MS);
  }

  function stopAuto() {
    if (autoHandle) clearInterval(autoHandle);
    autoHandle = null;
  }

  /* ---------- Membuka dashboard ---------- */

  async function openDashboard() {
    const s = Auth.getState();
    $('dash-teacher').textContent = s.user.name + ' (' + s.user.role + ')';
    UI.showScreen('home');
    UI.hideMsg('dash-message');
    const hasExam = await loadExamList();
    if (hasExam) await loadDashboard(false);
  }

  async function loadSchoolName() {
    try {
      const cached = await DB.getSetting('app_config');
      if (cached) $('school-name').textContent = cached.school_name || '';
      if (!navigator.onLine) return;
      const res = await Api.call('getAppConfig', {});
      if (res.success) {
        $('school-name').textContent = res.data.school_name || '';
        await DB.setSetting('app_config', res.data);
      }
    } catch (e) { /* abaikan */ }
  }

  async function init() {
    $('footer-version').textContent = 'Versi klien ' + SIBER_CONFIG.CLIENT_VERSION;
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    $('login-form').addEventListener('submit', onLogin);
    $('btn-toggle-password').addEventListener('click', onTogglePassword);
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-refresh').addEventListener('click', function () { loadDashboard(false); });
    $('sel-exam').addEventListener('change', function () {
      $('sel-class').value = '';
      loadDashboard(false);
    });
    $('sel-class').addEventListener('change', function () { loadDashboard(false); });
    $('sel-sort').addEventListener('change', renderParticipants);
    $('chk-auto').addEventListener('change', function () {
      if ($('chk-auto').checked) startAuto(); else stopAuto();
    });
    $('participants').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-attempt]');
      if (b) openDetail(b.dataset.attempt);
    });
    $('btn-detail-close').addEventListener('click', closeDetail);
    $('detail-modal').addEventListener('click', function (e) {
      if (e.target === $('detail-modal')) closeDetail();
    });

    if (!Api.isConfigured()) { UI.showScreen('setup'); return; }
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      $('fatal-message').textContent = 'Halaman harus dibuka lewat alamat https (GitHub Pages).';
      UI.showScreen('fatal');
      return;
    }
    try {
      await DB.open();
    } catch (e) {
      $('fatal-message').textContent = 'Penyimpanan lokal tidak bisa dibuka: ' + e.message;
      UI.showScreen('fatal');
      return;
    }

    loadSchoolName();

    let restored = null;
    try { restored = await Auth.restore(); } catch (e) { restored = null; }

    if (restored && isTeacher(restored)) {
      await openDashboard();
    } else {
      UI.showScreen('login');
      if (restored) {
        UI.showMsg('login-message', 'info',
          'Perangkat ini sedang dipakai akun siswa (' + restored.user.username + '). Masuk dengan akun guru untuk membuka dashboard.');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
