/**
 * SIBER-UJIAN — ui.js
 * Fungsi tampilan yang dipakai bersama oleh app.js dan exam.js.
 * Semua teks ditulis dengan textContent (aman dari sisipan kode).
 */
const UI = (function () {
  'use strict';

  const SCREENS = ['loading', 'fatal', 'setup', 'login', 'home',
                   'exam-intro', 'exam', 'exam-confirm', 'exam-done'];

  function $(id) { return document.getElementById(id); }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      if (props.text !== undefined) node.textContent = props.text;
      if (props.className) node.className = props.className;
      if (props.type) node.type = props.type;
      if (props.data) {
        Object.keys(props.data).forEach(function (k) { node.dataset[k] = props.data[k]; });
      }
      if (props.disabled) node.disabled = true;
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function showScreen(name) {
    SCREENS.forEach(function (n) {
      const s = $('screen-' + n);
      if (s) s.hidden = (n !== name);
    });
    window.scrollTo(0, 0);
  }

  function showMsg(boxId, type, text) {
    const box = $(boxId);
    if (!box) return;
    box.hidden = false;
    box.className = 'msg msg-' + type;
    box.textContent = text;
  }

  function hideMsg(boxId) {
    const box = $(boxId);
    if (box) box.hidden = true;
  }

  function errorText(res) {
    const e = res && res.error ? res.error : {};
    return (e.message || 'Terjadi kesalahan.') + ' [' + (e.code || '?') + ']';
  }

  function setBusy(btn, on, busyText) {
    if (!btn) return;
    if (on) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = busyText || 'Memproses...';
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
      btn.disabled = false;
    }
  }

  function setRows(tbodyId, rows) {
    const tb = $(tbodyId);
    tb.replaceChildren();
    rows.forEach(function (r) {
      const v = (r[1] === null || r[1] === undefined || r[1] === '') ? '-' : String(r[1]);
      tb.appendChild(el('tr', null, [el('th', { text: r[0] }), el('td', { text: v })]));
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatClock(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** Milidetik -> "MM:SS" atau "J:MM:SS" (dibulatkan ke atas per detik). */
  function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
  }

  function formatBytes(n) {
    if (n === null || n === undefined) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /** Tanggal hari ini menurut jam perangkat, format YYYY-MM-DD. */
  function todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  return {
    $: $,
    el: el,
    showScreen: showScreen,
    showMsg: showMsg,
    hideMsg: hideMsg,
    errorText: errorText,
    setBusy: setBusy,
    setRows: setRows,
    formatDateTime: formatDateTime,
    formatClock: formatClock,
    formatDuration: formatDuration,
    formatBytes: formatBytes,
    todayLocal: todayLocal
  };
})();

/* Phase 13: sembunyikan alat pengujian di versi produksi (atur di config.js). */
document.addEventListener('DOMContentLoaded', function () {
  if (typeof SIBER_CONFIG === 'undefined') return;
  if (!SIBER_CONFIG.DEBUG) {
    document.querySelectorAll('.debug').forEach(function (n) { n.hidden = true; });
  }
  if (!SIBER_CONFIG.ALLOW_LOCAL_WIPE) {
    document.querySelectorAll('.danger-zone').forEach(function (n) { n.hidden = true; });
  }
});
