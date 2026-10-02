/**
 * SIBER-UJIAN — reports.js
 * EXPORT dari Dashboard Guru: CSV, Excel (.xlsx), dan Cetak/PDF.
 *
 *  - Tanpa pustaka luar dan tanpa server tambahan: file dibuat langsung di browser,
 *    sehingga tetap bisa dipakai OFFLINE memakai data dashboard terakhir.
 *  - Excel dibuat dengan penulis .xlsx mini (XlsxMini) di bawah.
 *  - PDF memakai fitur cetak browser: pilih "Simpan sebagai PDF".
 *  - Data yang diekspor = data yang sedang tampil di dashboard (ujian + filter kelas).
 */

/* =====================================================================
 * XlsxMini: membuat file .xlsx (zip tanpa kompresi + XML SpreadsheetML)
 * ===================================================================== */
const XlsxMini = (function () {
  'use strict';

  const enc = new TextEncoder();

  /* ---------- CRC32 & ZIP ---------- */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /** files: [{ name, data: Uint8Array }] -> Uint8Array (zip, metode STORE) */
  function zip(files) {
    const now = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    files.forEach(function (f) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);      // nama file UTF-8
      lh.setUint16(8, 0, true);           // tanpa kompresi
      lh.setUint16(10, now.time, true);
      lh.setUint16(12, now.date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), name, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, now.time, true);
      ch.setUint16(14, now.date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + data.length;
    });

    let cdSize = 0;
    centrals.forEach(function (p) { cdSize += p.length; });

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);

    const parts = locals.concat(centrals, [new Uint8Array(end.buffer)]);
    let total = 0;
    parts.forEach(function (p) { total += p.length; });
    const out = new Uint8Array(total);
    let pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------- XML ---------- */

  const STYLE = { head: 1, ok: 2, bad: 3, blank: 4, bold: 5 };

  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function cellXml(cell, ref) {
    let v = cell;
    let s = 0;
    if (cell !== null && typeof cell === 'object') {
      v = cell.v;
      s = STYLE[cell.s] || 0;
    }
    const sAttr = s ? ' s="' + s + '"' : '';
    if (v === null || v === undefined || v === '') {
      return s ? '<c r="' + ref + '"' + sAttr + '/>' : '';
    }
    if (typeof v === 'number' && isFinite(v)) {
      return '<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    if (sheet.freezeRows) {
      const top = sheet.freezeRows + 1;
      xml += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + sheet.freezeRows +
        '" topLeftCell="A' + top + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    }
    if (sheet.widths && sheet.widths.length) {
      xml += '<cols>';
      sheet.widths.forEach(function (w, i) {
        xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      });
      xml += '</cols>';
    }
    xml += '<sheetData>';
    sheet.rows.forEach(function (row, r) {
      xml += '<row r="' + (r + 1) + '">';
      (row || []).forEach(function (cell, c) { xml += cellXml(cell, colName(c) + (r + 1)); });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="6">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function safeSheetName(name, used) {
    let n = String(name || 'Sheet').replace(/[\[\]\*\?\/\\:]/g, ' ').substring(0, 31).trim() || 'Sheet';
    let base = n;
    let i = 2;
    while (used[n.toLowerCase()]) {
      const suffix = ' (' + i++ + ')';
      n = base.substring(0, 31 - suffix.length) + suffix;
    }
    used[n.toLowerCase()] = true;
    return n;
  }

  /**
   * sheets: [{ name, rows: [[cell...]...], widths?: [angka], freezeRows?: angka }]
   * cell  : teks | angka | { v: teks/angka, s: 'head'|'ok'|'bad'|'blank'|'bold' }
   * Hasil : Uint8Array berisi file .xlsx
   */
  function build(sheets) {
    const used = {};
    const names = sheets.map(function (s) { return safeSheetName(s.name, used); });

    let wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    let types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';

    const files = [];
    sheets.forEach(function (s, i) {
      const n = i + 1;
      wb += '<sheet name="' + esc(names[i]) + '" sheetId="' + n + '" r:id="rId' + n + '"/>';
      rels += '<Relationship Id="rId' + n + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + n + '.xml"/>';
      types += '<Override PartName="/xl/worksheets/sheet' + n + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      files.push({ name: 'xl/worksheets/sheet' + n + '.xml', data: enc.encode(sheetXml(s)) });
    });
    wb += '</sheets></workbook>';
    rels += '<Relationship Id="rId' + (sheets.length + 1) + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    types += '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/></Relationships>';

    return zip([
      { name: '[Content_Types].xml', data: enc.encode(types) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(wb) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(rels) },
      { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) }
    ].concat(files));
  }

  return { build: build };
})();

/* =====================================================================
 * Reports: menyusun tabel dari data dashboard, lalu CSV / Excel / Cetak
 * ===================================================================== */
const Reports = (function () {
  'use strict';

  const REASON_TEXT = {
    MANUAL: 'Selesai sendiri',
    TIME_UP: 'Waktu habis',
    ALL_DONE: 'Semua soal selesai',
    DATA_ERROR: 'Data perangkat rusak'
  };

  function pad(n) { return String(n).padStart(2, '0'); }

  /** ISO -> "YYYY-MM-DD HH:MM" (jam perangkat). */
  function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function minutes(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (isNaN(x) || isNaN(y)) return '';
    return Math.max(0, Math.round((y - x) / 60000));
  }

  function num(v) { return (v === null || v === undefined || v === '') ? '' : Number(v); }

  function baseName(data) {
    const cls = data.class_filter || 'SEMUA';
    return ('SIBER-UJIAN_' + data.exam.exam_id + '_' + cls + '_' + stamp()).replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  /* ---------- Tabel ---------- */

  const PARTICIPANT_HEADERS = ['No', 'Nama', 'Kelas', 'Status', 'Nilai', 'Benar', 'Salah', 'Jumlah Soal',
    'Mulai', 'Selesai', 'Durasi (menit)', 'Cara selesai', 'Terkirim', 'Catatan'];

  function participantRows(data) {
    return (data.participants || []).map(function (p, i) {
      return [
        i + 1,
        p.name,
        p.class,
        p.status === 'SYNCED' ? 'TERKIRIM' : 'BELUM TERKIRIM',
        num(p.score),
        num(p.correct),
        num(p.wrong),
        num(p.total_questions),
        fmt(p.started_at),
        fmt(p.completed_at),
        p.status === 'SYNCED' ? minutes(p.started_at, p.completed_at) : '',
        REASON_TEXT[p.finish_reason] || p.finish_reason || '',
        fmt(p.synced_at),
        [p.clock_flags, p.warnings, p.note].filter(Boolean).join(' | ')
      ];
    });
  }

  const ITEM_HEADERS = ['No', 'Soal', 'Dijawab', 'Benar', 'Salah', 'Kosong', '% Benar', 'Kategori',
    'Pilih A', 'Pilih B', 'Pilih C', 'Pilih D'];

  function itemRows(data) {
    return (data.item_analysis || []).map(function (q) {
      const d = q.distribution || {};
      return [num(q.number), q.question, num(q.total_answer), num(q.correct), num(q.wrong), num(q.blank),
        num(q.percent_correct), q.difficulty, num(d.A), num(d.B), num(d.C), num(d.D)];
    });
  }

  const CLASS_HEADERS = ['Kelas', 'Peserta', 'Terkirim', 'Belum terkirim', 'Rata-rata', 'Tertinggi', 'Terendah'];

  function classRows(data) {
    return (data.by_class || []).map(function (c) {
      return [c.class, num(c.total), num(c.synced), num(c.not_synced), num(c.average), num(c.highest), num(c.lowest)];
    });
  }

  function infoRows(ctx, school) {
    const e = ctx.data.exam;
    const s = ctx.data.summary;
    return [
      ['Sekolah', school || ''],
      ['Ujian', e.exam_name + ' (' + e.exam_id + ')'],
      ['Mata pelajaran / kelas', e.subject + ' / ' + e.grade],
      ['Mode', e.mode],
      ['Versi soal', e.version],
      ['Filter kelas', ctx.data.class_filter || 'Semua kelas'],
      ['Data diambil', fmt(ctx.fetched_at) + (ctx.from_cache ? ' (data tersimpan)' : '')],
      ['Diekspor', fmt(new Date().toISOString())],
      ['Diekspor oleh', ctx.teacher || ''],
      [],
      ['Peserta', num(s.total_participants)],
      ['Sudah terkirim', num(s.synced)],
      ['Belum terkirim', num(s.not_synced)],
      ['Rata-rata', num(s.average)],
      ['Median', num(s.median)],
      ['Tertinggi', num(s.highest)],
      ['Terendah', num(s.lowest)],
      ['Hasil dengan catatan', num(s.with_warnings)],
      [],
      ['Keterangan', 'Data hanya mencakup hasil yang sudah dikirim ke server. ' +
        'Huruf jawaban memakai urutan pilihan ASLI di sheet QUESTIONS.']
    ];
  }

  /* ---------- Unduh file ---------- */

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* ---------- CSV ---------- */

  function csvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** CSV UTF-8 dengan BOM (huruf Indonesia tampil benar). Pemisah koma. */
  function toCsv(headers, rows) {
    const lines = [headers.map(csvField).join(',')];
    rows.forEach(function (r) { lines.push(r.map(csvField).join(',')); });
    return '\uFEFF' + lines.join('\r\n');
  }

  function exportCsv(ctx, kind) {
    const data = ctx.data;
    let csv;
    let suffix;
    if (kind === 'items') {
      csv = toCsv(ITEM_HEADERS, itemRows(data));
      suffix = '_analisis-soal.csv';
    } else {
      csv = toCsv(PARTICIPANT_HEADERS, participantRows(data));
      suffix = '_peserta.csv';
    }
    const name = baseName(data) + suffix;
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
    return name;
  }

  /* ---------- Rekap jawaban (matriks) ---------- */

  async function getMatrix(data) {
    const key = 'dash_matrix:' + data.exam.exam_id + ':' + (data.class_filter || 'ALL');
    if (navigator.onLine) {
      const res = await Auth.authedCall('getAnswerMatrix', { exam_id: data.exam.exam_id, class: data.class_filter || '' });
      if (res.success) {
        await DB.setSetting(key, res.data);
        return { matrix: res.data, cached: false };
      }
    }
    const cached = await DB.getSetting(key);
    return cached ? { matrix: cached, cached: true } : null;
  }

  function matrixSheet(matrix) {
    const qs = matrix.questions || [];
    const head = ['No', 'Nama', 'Kelas', 'Nilai', 'Benar', 'Salah'].concat(qs.map(function (q) { return 'S' + q.number; }));
    const rows = [head.map(function (h) { return { v: h, s: 'head' }; })];
    (matrix.rows || []).forEach(function (r, i) {
      const line = [i + 1, r.name, r.class, num(r.score), num(r.correct), num(r.wrong)];
      qs.forEach(function (q) {
        const a = r.answers ? r.answers[q.question_id] : null;
        if (!a || !a.a) line.push({ v: '-', s: 'blank' });
        else line.push({ v: a.a, s: a.c ? 'ok' : 'bad' });
      });
      rows.push(line);
    });
    rows.push([]);
    rows.push([{ v: 'Keterangan:', s: 'bold' }, 'Hijau = benar, merah = salah, abu-abu "-" = kosong. Huruf = pilihan ASLI di sheet QUESTIONS.']);
    const widths = [5, 28, 10, 8, 8, 8].concat(qs.map(function () { return 5; }));
    return { name: 'Rekap Jawaban', rows: rows, widths: widths, freezeRows: 1 };
  }

  function withHead(headers, rows) {
    return [headers.map(function (h) { return { v: h, s: 'head' }; })].concat(rows);
  }

  async function exportXlsx(ctx, school) {
    const data = ctx.data;
    const sheets = [
      {
        name: 'Ringkasan',
        rows: infoRows(ctx, school).map(function (r) { return r.length ? [{ v: r[0], s: 'bold' }].concat(r.slice(1)) : []; }),
        widths: [24, 70]
      },
      { name: 'Per Kelas', rows: withHead(CLASS_HEADERS, classRows(data)), widths: [12, 10, 10, 15, 11, 11, 11], freezeRows: 1 },
      {
        name: 'Peserta',
        rows: withHead(PARTICIPANT_HEADERS, participantRows(data)),
        widths: [5, 28, 10, 16, 8, 8, 8, 12, 17, 17, 14, 18, 17, 60],
        freezeRows: 1
      },
      {
        name: 'Analisis Soal',
        rows: withHead(ITEM_HEADERS, itemRows(data)),
        widths: [5, 60, 10, 8, 8, 8, 10, 11, 8, 8, 8, 8],
        freezeRows: 1
      }
    ];

    let note = '';
    try {
      const m = await getMatrix(data);
      if (m) {
        sheets.push(matrixSheet(m.matrix));
        if (m.cached) note = 'Rekap jawaban memakai data tersimpan (perangkat offline).';
      } else {
        note = 'Lembar "Rekap Jawaban" tidak disertakan karena perangkat offline dan belum ada data tersimpan.';
      }
    } catch (e) {
      note = 'Lembar "Rekap Jawaban" tidak disertakan: ' + e.message;
    }

    const bytes = XlsxMini.build(sheets);
    const name = baseName(data) + '.xlsx';
    download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    return { name: name, note: note };
  }

  /* ---------- Cetak / PDF ---------- */

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }

  function printTable(headers, rows, numericCols) {
    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    headers.forEach(function (h) { hr.appendChild(el('th', h)); });
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = el('tbody');
    rows.forEach(function (r) {
      const tr = el('tr');
      r.forEach(function (v, i) {
        tr.appendChild(el('td', (v === null || v === undefined || v === '') ? '-' : v,
          numericCols && numericCols.indexOf(i) !== -1 ? 'num' : ''));
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }

  function cut(s, n) { s = String(s || ''); return s.length > n ? s.substring(0, n - 1) + '…' : s; }

  function printReport(ctx, school) {
    const data = ctx.data;
    const e = data.exam;
    const area = document.getElementById('print-area');
    area.replaceChildren();

    area.appendChild(el('h1', 'Laporan Hasil Ujian — ' + e.exam_name));
    area.appendChild(el('div', (school ? school + ' · ' : '') + e.subject + ' kelas ' + e.grade +
      ' · Mode ' + e.mode + ' · Kelas: ' + (data.class_filter || 'Semua') +
      ' · Data per ' + fmt(ctx.fetched_at) + (ctx.from_cache ? ' (tersimpan)' : '') +
      ' · Dicetak ' + fmt(new Date().toISOString()), 'meta'));
    area.appendChild(el('div', 'Catatan: hanya mencakup hasil yang sudah dikirim ke server.', 'meta'));

    const s = data.summary;
    area.appendChild(el('h2', 'Ringkasan'));
    area.appendChild(printTable(
      ['Peserta', 'Terkirim', 'Belum terkirim', 'Rata-rata', 'Median', 'Tertinggi', 'Terendah', 'Ada catatan'],
      [[s.total_participants, s.synced, s.not_synced, s.average, s.median, s.highest, s.lowest, s.with_warnings]],
      [0, 1, 2, 3, 4, 5, 6, 7]));

    if ((data.by_class || []).length) {
      area.appendChild(el('h2', 'Rekap per kelas'));
      area.appendChild(printTable(CLASS_HEADERS, classRows(data), [1, 2, 3, 4, 5, 6]));
    }

    area.appendChild(el('h2', 'Daftar peserta'));
    area.appendChild(printTable(
      ['No', 'Nama', 'Kelas', 'Status', 'Nilai', 'Benar', 'Salah', 'Mulai', 'Selesai', 'Durasi', 'Cara selesai', 'Catatan'],
      participantRows(data).map(function (r) {
        return [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[8], r[9], r[10] === '' ? '' : r[10] + ' mnt', r[11], cut(r[13], 70)];
      }),
      [0, 4, 5, 6]));

    const items = el('div', null, 'page-break');
    items.appendChild(el('h2', 'Analisis butir soal'));
    items.appendChild(el('div', 'Kategori: MUDAH ≥ 70% benar, SEDANG 30–70%, SUKAR < 30%. Sebaran memakai huruf pilihan ASLI.', 'meta'));
    items.appendChild(printTable(ITEM_HEADERS,
      itemRows(data).map(function (r) { const x = r.slice(); x[1] = cut(x[1], 90); return x; }),
      [0, 2, 3, 4, 5, 6, 8, 9, 10, 11]));
    area.appendChild(items);

    const sign = el('div', null, 'sign');
    const box = el('div');
    box.appendChild(el('div', 'Guru Mata Pelajaran,'));
    box.appendChild(el('div', '\u00A0'));
    box.appendChild(el('div', '\u00A0'));
    box.appendChild(el('div', '\u00A0'));
    box.appendChild(el('div', '( ' + (ctx.teacher || '........................................') + ' )'));
    sign.appendChild(box);
    area.appendChild(sign);

    const oldTitle = document.title;
    document.title = baseName(data);
    window.print();
    setTimeout(function () { document.title = oldTitle; }, 1000);
  }

  /* ---------- Tombol di dashboard ---------- */

  function ctxOrNull() {
    const c = window.SIBER_DASH;
    return (c && c.data && c.data.exam) ? c : null;
  }

  async function schoolName() {
    try {
      const cfg = await DB.getSetting('app_config');
      return cfg ? cfg.school_name || '' : '';
    } catch (e) {
      return '';
    }
  }

  function msg(type, text) {
    const box = document.getElementById('export-message');
    if (!box) return;
    box.hidden = false;
    box.className = 'msg msg-' + type;
    box.textContent = text;
  }

  async function handle(kind, btn) {
    const ctx = ctxOrNull();
    if (!ctx) {
      msg('warn', 'Muat dashboard sebuah ujian terlebih dahulu.');
      return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Menyiapkan...';
    try {
      if (kind === 'csv-participants' || kind === 'csv-items') {
        const name = exportCsv(ctx, kind === 'csv-items' ? 'items' : 'participants');
        msg('ok', 'File dibuat: ' + name + '. Periksa folder Unduhan (Download).');
      } else if (kind === 'xlsx') {
        const r = await exportXlsx(ctx, await schoolName());
        msg(r.note ? 'warn' : 'ok', 'File dibuat: ' + r.name + '. Periksa folder Unduhan (Download).' + (r.note ? ' ' + r.note : ''));
      } else if (kind === 'print') {
        printReport(ctx, await schoolName());
        msg('info', 'Di jendela cetak, pilih "Simpan sebagai PDF" (Save as PDF) untuk membuat file PDF.');
      }
    } catch (e) {
      msg('error', 'Gagal membuat file: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function init() {
    const map = {
      'btn-export-csv-participants': 'csv-participants',
      'btn-export-csv-items': 'csv-items',
      'btn-export-xlsx': 'xlsx',
      'btn-export-print': 'print'
    };
    Object.keys(map).forEach(function (id) {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', function () { handle(map[id], b); });
    });
    window.addEventListener('afterprint', function () {
      const area = document.getElementById('print-area');
      if (area) area.replaceChildren();
    });
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  return { exportCsv: exportCsv, exportXlsx: exportXlsx, printReport: printReport, toCsv: toCsv };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { XlsxMini: XlsxMini, Reports: Reports };
