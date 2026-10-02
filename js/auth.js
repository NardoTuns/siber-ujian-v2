/**
 * SIBER-UJIAN — auth.js
 * Login ONLINE (ke server) dan OFFLINE (memakai data di perangkat).
 * Password TIDAK PERNAH disimpan. Yang disimpan hanya "sidik jari" PBKDF2.
 */
const Auth = (function () {
  'use strict';

  // Kode error yang berarti "server tidak bisa dihubungi" -> boleh coba login offline
  const NETWORK_CODES = ['OFFLINE', 'NETWORK_ERROR', 'TIMEOUT', 'BAD_RESPONSE'];
  const OFFLINE_MAX_FAIL = 5;
  const OFFLINE_LOCK_MS = 5 * 60 * 1000;

  let state = null;

  function fail(code, message) { return { success: false, error: { code: code, message: message } }; }
  function ok(data) { return { success: true, data: data }; }

  /* ---------- Sidik jari password (PBKDF2) ---------- */

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function deriveHash(password, saltHex, iterations) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iterations, hash: 'SHA-256' },
      keyMaterial, 256);
    return bufToHex(bits);
  }

  async function makeVerifier(password) {
    const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = SIBER_CONFIG.LOCAL_PBKDF2_ITERATIONS;
    return {
      algo: 'PBKDF2-SHA256',
      iterations: iterations,
      salt: salt,
      hash: await deriveHash(password, salt, iterations)
    };
  }

  async function checkVerifier(password, v) {
    if (!v || v.algo !== 'PBKDF2-SHA256' || !v.salt || !v.hash) return false;
    return safeEqual(await deriveHash(password, v.salt, v.iterations), v.hash);
  }

  /* ---------- Data user ---------- */

  function publicUser(rec) {
    return {
      user_id: rec.user_id,
      username: rec.username,
      name: rec.name,
      class: rec.class,
      grade: rec.grade,
      role: rec.role
    };
  }

  function sessionValid(rec) {
    if (!rec || !rec.session) return false;
    const exp = Date.parse(rec.session_expires_at);
    return !isNaN(exp) && exp > Date.now();
  }

  function offlineValidUntil(rec) {
    const t = Date.parse(rec.last_online_login_at);
    if (isNaN(t)) return null;
    return new Date(t + SIBER_CONFIG.OFFLINE_LOGIN_MAX_DAYS * 86400000).toISOString();
  }

  function buildState(rec, mode, loggedInAt) {
    return {
      user: publicUser(rec),
      mode: mode,
      logged_in_at: loggedInAt,
      session_valid: sessionValid(rec),
      session_expires_at: rec.session_expires_at || null,
      last_online_login_at: rec.last_online_login_at || null,
      offline_valid_until: offlineValidUntil(rec),
      clock_offset_ms: (rec.clock_offset_ms === undefined) ? null : rec.clock_offset_ms
    };
  }

  function findLocalUser(username) {
    return DB.getOneByIndex('users', 'username', username);
  }

  /* ---------- Pembatas salah password offline ---------- */

  async function isOfflineLocked(username) {
    const f = await DB.getSetting('offline_fail:' + username);
    if (!f || f.count < OFFLINE_MAX_FAIL) return false;
    if (Date.now() - f.last_at > OFFLINE_LOCK_MS) {
      await DB.delSetting('offline_fail:' + username);
      return false;
    }
    return true;
  }

  async function recordOfflineFail(username) {
    const f = (await DB.getSetting('offline_fail:' + username)) || { count: 0, last_at: 0 };
    await DB.setSetting('offline_fail:' + username, { count: f.count + 1, last_at: Date.now() });
  }

  async function clearOfflineFail(username) {
    await DB.delSetting('offline_fail:' + username);
  }

  /* ---------- Login ---------- */

  async function login(username, password) {
    username = String(username || '').trim().toLowerCase();
    password = String(password || '');
    if (!username || !password) return fail('INVALID_INPUT', 'Username dan password wajib diisi.');

    if (!navigator.onLine) return offlineLogin(username, password);

    const res = await Api.call('login', { username: username, password: password });
    if (res.success) return finishOnlineLogin(res.data, username, password);

    if (res.error.code === 'ACCOUNT_INACTIVE') {
      await markLocalInactive(username);
      return res;
    }
    // INVALID_LOGIN, LOGIN_LOCKED, dll adalah keputusan server: jangan coba offline
    if (NETWORK_CODES.indexOf(res.error.code) === -1) return res;

    // Server tidak bisa dihubungi -> coba login offline
    const off = await offlineLogin(username, password);
    if (off.success) {
      off.data.note = 'Server tidak dapat dihubungi (' + res.error.code + '). Anda masuk memakai data di perangkat.';
    }
    return off;
  }

  async function finishOnlineLogin(d, username, password) {
    if (!d || typeof d.session !== 'string' || !d.user || !d.user.user_id) {
      return fail('BAD_RESPONSE', 'Data login dari server tidak lengkap.');
    }
    const now = new Date().toISOString();
    const serverMs = Date.parse(d.server_time);
    const rec = {
      user_id: d.user.user_id,
      username: String(d.user.username || username).toLowerCase(),
      name: d.user.name,
      class: d.user.class,
      grade: d.user.grade,
      role: d.user.role,
      status: 'ACTIVE',
      verifier: null,
      session: d.session,
      session_expires_at: d.session_expires_at,
      last_online_login_at: now,
      clock_offset_ms: isNaN(serverMs) ? null : serverMs - Date.now(),
      created_local_at: now,
      updated_at: now
    };

    let warning = null;
    try {
      rec.verifier = await makeVerifier(password);
      // Jika ada akun lama dengan username sama tetapi USER_ID berbeda, hapus akun lama tersebut
      const other = await findLocalUser(rec.username);
      if (other && other.user_id !== rec.user_id) await DB.del('users', other.user_id);
      const old = await DB.get('users', rec.user_id);
      if (old && old.created_local_at) rec.created_local_at = old.created_local_at;

      await DB.put('users', rec);
      await DB.setSetting('current_login', { user_id: rec.user_id, mode: 'ONLINE', logged_in_at: now });
      await clearOfflineFail(rec.username);
    } catch (e) {
      warning = 'Login berhasil, tetapi gagal menyimpan ke perangkat (' + e.message +
                '). Login tanpa internet belum bisa dipakai di perangkat ini.';
    }

    state = buildState(rec, 'ONLINE', now);
    return ok({ mode: 'ONLINE', user: publicUser(rec), warning: warning });
  }

  async function offlineLogin(username, password) {
    if (await isOfflineLocked(username)) {
      return fail('OFFLINE_LOGIN_LOCKED', 'Terlalu banyak salah password. Coba lagi 5 menit lagi.');
    }

    const rec = await findLocalUser(username);
    if (!rec || !rec.verifier) {
      return fail('NO_LOCAL_ACCOUNT',
        'Akun ini belum pernah login online di perangkat ini. Login sekali saat ada internet.');
    }
    if (rec.status !== 'ACTIVE') {
      return fail('ACCOUNT_INACTIVE', 'Akun tidak aktif. Hubungi admin.');
    }

    if (!(await checkVerifier(password, rec.verifier))) {
      await recordOfflineFail(username);
      return fail('INVALID_LOGIN', 'Username atau password salah');
    }

    const lastOnline = Date.parse(rec.last_online_login_at);
    if (isNaN(lastOnline) || Date.now() - lastOnline > SIBER_CONFIG.OFFLINE_LOGIN_MAX_DAYS * 86400000) {
      return fail('OFFLINE_LOGIN_EXPIRED',
        'Sudah lebih dari ' + SIBER_CONFIG.OFFLINE_LOGIN_MAX_DAYS +
        ' hari tidak login online. Login sekali saat ada internet.');
    }

    await clearOfflineFail(username);
    const now = new Date().toISOString();
    await DB.setSetting('current_login', { user_id: rec.user_id, mode: 'OFFLINE', logged_in_at: now });
    state = buildState(rec, 'OFFLINE', now);
    return ok({ mode: 'OFFLINE', user: publicUser(rec), warning: null });
  }

  async function markLocalInactive(username) {
    const rec = await findLocalUser(username);
    if (rec) {
      rec.status = 'INACTIVE';
      rec.session = null;
      rec.updated_at = new Date().toISOString();
      await DB.put('users', rec);
    }
  }

  /** Memulihkan login setelah halaman di-refresh atau HP dinyalakan ulang. */
  async function restore() {
    const current = await DB.getSetting('current_login');
    if (!current || !current.user_id) return null;
    const rec = await DB.get('users', current.user_id);
    if (!rec || rec.status !== 'ACTIVE') {
      await DB.delSetting('current_login');
      return null;
    }
    state = buildState(rec, current.mode, current.logged_in_at);
    return getState();
  }

  /** Keluar. Data akun di perangkat TIDAK dihapus agar login offline tetap bisa. */
  async function logout() {
    state = null;
    await DB.delSetting('current_login');
  }

  function getState() { return state ? JSON.parse(JSON.stringify(state)) : null; }

  function isLoggedIn() { return !!state; }

  /**
   * Memanggil action yang butuh session server.
   * Jika session ditolak, user TIDAK dikeluarkan (bisa saja sedang ujian offline);
   * hanya ditandai bahwa perlu login online ulang.
   */
  async function authedCall(action, payload) {
    if (!state) return fail('NOT_LOGGED_IN', 'Anda belum login.');
    const rec = await DB.get('users', state.user.user_id);
    if (!rec || !sessionValid(rec)) {
      state.session_valid = false;
      return fail('SESSION_EXPIRED',
        'Sesi server habis. Keluar lalu login ulang saat ada internet. Data di perangkat tetap aman.');
    }

    const res = await Api.call(action, payload, rec.session);
    if (!res.success) {
      const code = res.error.code;
      if (code === 'SESSION_EXPIRED' || code === 'UNAUTHORIZED' || code === 'ACCOUNT_INACTIVE') {
        rec.session = null;
        if (code === 'ACCOUNT_INACTIVE') rec.status = 'INACTIVE';
        rec.updated_at = new Date().toISOString();
        await DB.put('users', rec);
        state.session_valid = false;
      }
    }
    return res;
  }

  return {
    login: login,
    logout: logout,
    restore: restore,
    isLoggedIn: isLoggedIn,
    getState: getState,
    authedCall: authedCall
  };
})();
