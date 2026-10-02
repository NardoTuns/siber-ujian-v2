# SIBER-UJIAN

Sistem ujian sekolah yang **tetap berjalan tanpa internet** saat ujian berlangsung.

- Frontend: GitHub Pages (HTML, CSS, JavaScript murni) + PWA (Service Worker)
- Penyimpanan di HP siswa: IndexedDB
- Backend: Google Apps Script Web App
- Database: Google Sheets

## Alur singkat

1. **Di rumah (online):** siswa login → Unduh soal (paket soal terkunci) → status READY.
2. **Di sekolah (offline):** buka aplikasi → login offline → masukkan token dari guru → kerjakan.
3. **Setelah ujian:** hasil tersimpan di HP → dikirim otomatis saat ada internet → dinilai server.

## Prinsip keamanan

- Kunci jawaban **tidak pernah** dikirim ke perangkat siswa. Nilai dihitung server.
- Teks soal tersimpan **terkunci**; hanya terbuka dengan token dari guru.
- Setiap jawaban langsung disimpan di perangkat. Timer berbasis waktu tersimpan, tahan restart.
- ATTEMPT_ID mencegah hasil ganda.

## Struktur

| Lokasi | Isi |
|---|---|
| `index.html` | Aplikasi ujian siswa |
| `dashboard.html` | Dashboard guru (hasil, analisis soal, export Excel/CSV/PDF) |
| `service-worker.js`, `manifest.json` | Mode offline & instalasi aplikasi |
| `js/` | Logika aplikasi (`mathrender.js` = tampilan rumus) |
| `vendor/katex/` | KaTeX lokal untuk rumus matematika (tanpa CDN, tetap jalan offline) |
| `css/` | Tampilan |
| `assets/icons/` | Ikon aplikasi |

## Aturan pemeliharaan

1. Setiap mengubah file apa pun, **naikkan `CLIENT_VERSION`** di `js/config.js`.
2. Setiap mengubah soal/kunci/gambar di Google Sheets, **naikkan `VERSION`** ujian di sheet EXAMS.
3. Buat token **sebelum** siswa mengunduh soal.
4. Jangan pernah mengunggah kunci jawaban, password, atau file spreadsheet ke repository ini.
5. Setelah mengubah kode Apps Script: **Terapkan → Kelola deployment → Versi baru**.

## Menulis rumus matematika di soal

Tulis rumus dengan sintaks LaTeX langsung di kolom soal/pilihan pada Google Sheets:

| Tulisan | Hasil |
|---|---|
| `$x^2 + 3x - 4 = 0$` | rumus di dalam kalimat |
| `$$\frac{-b \pm \sqrt{b^2-4ac}}{2a}$$` | rumus di baris sendiri |
| `\$5` | tanda dolar biasa |

Teks seperti "harga $5 dan $10" tidak dianggap rumus. Setelah mengubah soal, naikkan `VERSION` ujian di sheet EXAMS.
