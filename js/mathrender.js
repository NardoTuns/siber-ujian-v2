/**
 * SIBER-UJIAN — mathrender.js
 * Menampilkan rumus matematika (LaTeX) di teks soal dan pilihan jawaban.
 *
 * Penulisan rumus di Google Sheets:
 *   $x^2 + 3x$            rumus di dalam kalimat
 *   $$\frac{a}{b}$$       rumus di baris sendiri (tengah)
 *   \( ... \)  dan  \[ ... \]   juga didukung
 *   \$                    tanda dolar biasa (bukan rumus)
 *
 * Catatan teknis:
 *  - Memakai KaTeX yang disimpan lokal di vendor/katex (tanpa CDN), sehingga tetap jalan OFFLINE
 *    dan sesuai Content-Security-Policy (script-src 'self'; style-src 'self').
 *  - KaTeX menghasilkan atribut style="..." di HTML-nya. CSP memblokir atribut itu,
 *    jadi setelah dirender, gaya dipindahkan ke CSSOM (element.style.setProperty) yang diizinkan.
 *  - Teks biasa selalu dimasukkan sebagai text node (bukan innerHTML), jadi aman dari injeksi HTML.
 *  - Jika KaTeX gagal dimuat, teks ditampilkan apa adanya (soal tetap bisa dikerjakan).
 */
const MathRender = (function () {
  'use strict';

  /* ---------- 1. Memecah teks menjadi bagian biasa dan bagian rumus ---------- */

  function findClose(text, from, closer) {
    for (let j = from; j < text.length; j++) {
      const c = text.charAt(j);
      if (c === '\\') { // lewati karakter yang di-escape, mis. \$ atau \\
        if (closer === '\\)' || closer === '\\]') {
          if (text.charAt(j + 1) === closer.charAt(1)) return j;
        }
        j++;
        continue;
      }
      if (closer === '$$' && c === '$' && text.charAt(j + 1) === '$') return j;
      if (closer === '$' && c === '$') {
        if (text.charAt(j + 1) === '$') { j++; continue; }
        return j;
      }
      if (closer === '$' && c === '\n' && text.charAt(j + 1) === '\n') return -1; // tidak lintas paragraf
    }
    return -1;
  }

  function tokenize(text) {
    const out = [];
    let buf = '';
    let i = 0;

    function flush() {
      if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
    }

    while (i < text.length) {
      const c = text.charAt(i);
      const n = text.charAt(i + 1);

      if (c === '\\' && n === '$') { buf += '$'; i += 2; continue; }

      if (c === '\\' && (n === '(' || n === '[')) {
        const closer = n === '(' ? '\\)' : '\\]';
        const end = findClose(text, i + 2, closer);
        if (end > i + 2) {
          flush();
          out.push({ type: 'math', value: text.slice(i + 2, end), display: n === '[' });
          i = end + 2;
          continue;
        }
      }

      if (c === '$') {
        if (n === '$') {
          const end = findClose(text, i + 2, '$$');
          if (end > i + 2) {
            flush();
            out.push({ type: 'math', value: text.slice(i + 2, end), display: true });
            i = end + 2;
            continue;
          }
          buf += '$$'; i += 2; continue;
        }
        // $...$ : tanda buka tidak diikuti spasi; tanda tutup tidak didahului spasi dan tidak diikuti angka
        // (supaya "harga $5 dan $10" tidak dianggap rumus)
        if (n && !/\s/.test(n)) {
          const end = findClose(text, i + 1, '$');
          if (end > i + 1 && !/\s/.test(text.charAt(end - 1)) && !/[0-9]/.test(text.charAt(end + 1))) {
            flush();
            out.push({ type: 'math', value: text.slice(i + 1, end), display: false });
            i = end + 1;
            continue;
          }
        }
      }

      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /* ---------- 2. Merender satu rumus menjadi node DOM yang patuh CSP ---------- */

  function applyInlineStyle(node, cssText) {
    cssText.split(';').forEach(function (decl) {
      const k = decl.indexOf(':');
      if (k < 1) return;
      const name = decl.slice(0, k).trim();
      const value = decl.slice(k + 1).trim();
      if (name && value) node.style.setProperty(name, value);
    });
  }

  function renderMathNode(tex, display) {
    const html = window.katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml'
    });

    // Urai di dokumen "mati", cabut semua atribut style, lalu pindahkan ke DOM asli.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const styles = [];
    parsed.body.querySelectorAll('*').forEach(function (n, idx) {
      const s = n.getAttribute('style');
      if (s) { styles[idx] = s; n.removeAttribute('style'); }
    });

    const frag = document.createDocumentFragment();
    Array.prototype.forEach.call(parsed.body.childNodes, function (n) {
      frag.appendChild(document.importNode(n, true));
    });
    const live = frag.querySelectorAll('*');
    styles.forEach(function (s, idx) {
      if (live[idx]) applyInlineStyle(live[idx], s);
    });
    return frag;
  }

  /* ---------- 3. Fungsi utama ---------- */

  /** Mengisi elemen dengan teks; bagian rumus dirender, sisanya tetap teks biasa. */
  function render(target, text) {
    const str = text == null ? '' : String(text);
    const kids = [];

    if (!window.katex || str.indexOf('$') === -1 && str.indexOf('\\(') === -1 && str.indexOf('\\[') === -1) {
      target.textContent = str.replace(/\\\$/g, '$');
      return;
    }

    tokenize(str).forEach(function (t) {
      if (t.type === 'text') {
        kids.push(document.createTextNode(t.value));
        return;
      }
      try {
        kids.push(renderMathNode(t.value, t.display));
      } catch (e) {
        const raw = t.display ? '$$' + t.value + '$$' : '$' + t.value + '$';
        kids.push(document.createTextNode(raw));
      }
    });
    target.replaceChildren.apply(target, kids);
  }

  return { render: render, tokenize: tokenize };
})();
