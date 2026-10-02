/**
 * SIBER-UJIAN — token.js
 * Membuka paket soal terkunci dengan token dari guru — TANPA internet.
 *
 * Paket berisi:
 *  - secure    : teks soal + pilihan yang dikunci dengan KUNCI PAKET
 *  - key_slots : satu "kotak kunci" per token. Isinya KUNCI PAKET, dikunci dengan
 *                PBKDF2-SHA256(token). Label (ujian, sekolah, tanggal, jam) disegel bersama.
 * Token TIDAK PERNAH disimpan di perangkat. Yang disimpan setelah ujian dimulai
 * hanyalah kunci paket di catatan attempt, agar ujian bisa dilanjutkan setelah restart.
 */
const Token = (function () {
  'use strict';

  const MAX_ITERATIONS = 1000000;

  function fail(code, message) { return { success: false, error: { code: code, message: message } }; }

  /** "x7k9 - 2qmt" -> "X7K92QMT" */
  function normalize(input) { return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function utf8(s) { return new TextEncoder().encode(String(s)); }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function concat() {
    let total = 0;
    for (let i = 0; i < arguments.length; i++) total += arguments[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < arguments.length; i++) {
      out.set(arguments[i], off);
      off += arguments[i].length;
    }
    return out;
  }

  function u32be(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  function importHmac(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }

  async function hmac(keyRaw, data) {
    const k = await importHmac(keyRaw);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
  }

  async function pbkdf2(password, salt, iterations) {
    const km = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, km, 256);
    return new Uint8Array(bits);
  }

  /** Membuka data terkunci. Mengembalikan null jika kunci salah atau data diubah. */
  async function open(keyBytes, sealed, aad, label) {
    const encKey = await hmac(keyBytes, utf8(label + ':enc'));
    const macKey = await hmac(keyBytes, utf8(label + ':mac'));
    const nonce = b64ToBytes(sealed.nonce);
    const ct = b64ToBytes(sealed.ct);
    const mac = b64ToBytes(sealed.mac);

    const expected = await hmac(macKey, concat(u32be(aad.length), aad, nonce, ct));
    if (!equalBytes(expected, mac)) return null;

    const k = await importHmac(encKey);
    const out = new Uint8Array(ct.length);
    for (let block = 0, off = 0; off < ct.length; block++, off += 32) {
      const ks = new Uint8Array(await crypto.subtle.sign('HMAC', k, concat(nonce, u32be(block))));
      for (let j = 0; j < 32 && off + j < ct.length; j++) out[off + j] = ct[off + j] ^ ks[j];
    }
    return out;
  }

  /** Mencoba membuka salah satu kotak kunci dengan token yang diketik. */
  async function unlock(exam, tokenInput) {
    const t = normalize(tokenInput);
    if (t.length < 6) return fail('TOKEN_INVALID', 'Token tidak lengkap. Periksa kembali token dari guru.');
    const slots = Array.isArray(exam.key_slots) ? exam.key_slots : [];
    if (!slots.length) return fail('TOKEN_NOT_SET', 'Data token tidak ada di paket. Unduh ulang saat ada internet.');

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || !(s.iterations > 0) || s.iterations > MAX_ITERATIONS) continue;
      const tokenKey = await pbkdf2(t, b64ToBytes(s.salt), s.iterations);
      const key = await open(tokenKey, { nonce: s.nonce, ct: s.ct, mac: s.mac }, utf8(s.meta_json), 'slot');
      if (key) {
        let meta;
        try { meta = JSON.parse(s.meta_json); } catch (e) { continue; }
        return { success: true, data: { key: key, meta: meta, token_id: s.token_id } };
      }
    }
    return fail('TOKEN_INVALID', 'Token salah. Periksa kembali token dari guru.');
  }

  function p2(n) { return String(n).padStart(2, '0'); }
  function localDate(ms) { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function localHm(ms) { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }

  /** Memeriksa label token: ujian, sekolah, tanggal, dan jam berlaku. */
  function checkMeta(meta, exam, nowMs, schoolCode) {
    if (!meta || meta.exam_id !== exam.exam_id) return fail('TOKEN_INVALID', 'Token ini bukan untuk ujian ini.');
    if (schoolCode && meta.school && meta.school !== schoolCode) return fail('TOKEN_INVALID', 'Token ini bukan untuk sekolah ini.');
    if (meta.valid_date && meta.valid_date !== localDate(nowMs)) {
      return fail('TOKEN_WRONG_DATE', 'Token ini hanya berlaku tanggal ' + meta.valid_date + '. Periksa juga tanggal di perangkat.');
    }
    const hm = localHm(nowMs);
    if (meta.valid_from && hm < meta.valid_from) {
      return fail('TOKEN_TOO_EARLY', 'Token ini baru berlaku pukul ' + meta.valid_from + '.');
    }
    if (meta.valid_until && hm > meta.valid_until) {
      return fail('TOKEN_EXPIRED', 'Token ini sudah tidak berlaku (batas pukul ' + meta.valid_until + ').');
    }
    return { success: true };
  }

  /** Membuka teks soal. Mengembalikan peta question_id -> { question, options }. */
  async function decryptQuestions(exam, keyBytes) {
    if (!exam || !exam.secure_raw) throw new Error('Paket soal terkunci tidak ditemukan.');
    const plain = await open(keyBytes, exam.secure_raw, utf8('pkg:' + exam.exam_id), 'pkg');
    if (!plain) throw new Error('Paket soal tidak dapat dibuka (kunci salah atau data rusak).');

    let list;
    try {
      list = JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
      throw new Error('Isi paket soal rusak.');
    }
    if (!Array.isArray(list)) throw new Error('Isi paket soal tidak valid.');

    const map = {};
    list.forEach(function (q) {
      if (!q || !q.question_id || typeof q.question !== 'string' || !q.options) return;
      const ok = ['A', 'B', 'C', 'D'].every(function (L) { return typeof q.options[L] === 'string' && q.options[L]; });
      if (ok) map[q.question_id] = { question: q.question, options: q.options };
    });
    return map;
  }

  return {
    normalize: normalize,
    b64ToBytes: b64ToBytes,
    bytesToB64: bytesToB64,
    unlock: unlock,
    checkMeta: checkMeta,
    decryptQuestions: decryptQuestions
  };
})();
