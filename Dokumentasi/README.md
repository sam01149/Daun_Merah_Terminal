```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Peta masuk dokumentasi dan panduan menemukan konteks sesuai tugas.
BOLEH    : Katalog, hubungan antarfile, urutan baca, dan cara mencari bukti.
DILARANG : Aturan universal baru (-> ATURAN.md), salinan konfigurasi/status produksi,
           hasil riset (-> daun_merah_riset.md), riwayat pekerjaan (-> daun_merah.md).
FORMAT   : Update in place; tautkan sumber pemilik informasi, jangan salin isinya.
Entri yang melanggar = salah tempat, wajib dipindah.
```

# Peta Dokumentasi Daun Merah

Peta ini membantu memilih bacaan, bukan sumber aturan atau snapshot produksi.
Routing yang mengikat tetap di `ATURAN.md` §2. Mulai dari cakupan pekerjaan,
lalu pilih jenis informasi. Satu pekerjaan memiliki satu catatan utama;
file lain cukup menunjuk jika memerlukan konteksnya.

## 1. Mulai dari sini

1. Pada workspace lokal, baca `ATURAN.md`, petunjuk agent yang berlaku,
   dan `.agents/riwayat_memori_claude.md`. Memori adalah riwayat keputusan,
   bukan jaminan kondisi sekarang.
2. Pilih baris tugas di §3, lalu baca header dan bagian terkait pada file tujuan.
3. Cari riwayat terbaru dengan istilah fitur, nama fungsi, ID plan atau sesi.
   Baca juga alasan keputusan lama yang ditolak/dicabut sebelum mengusulkan ulang.
4. Cocokkan klaim dengan source code dan bukti bertanggal. Baca kondisi sekarang
   di dokumen pemiliknya; jangan memakai angka/model dari sesi lama sebagai konfigurasi aktif.
5. Catat hasil mengikuti routing `ATURAN.md`; gunakan §4 untuk membedakan statusnya.

**Clone GitHub berbeda dengan workspace lokal.** Aturan agent, plan/progress,
SOP audit dan sebagian besar dokumen Professional LLM Trader sengaja lokal
sesuai `.gitignore`. Ketiadaan file di clone bukan bukti pekerjaannya selesai
atau belum pernah dibahas. Jika tugas bergantung pada file lokal yang tidak ada,
nyatakan batas konteks tersebut sebelum menyimpulkan atau melanjutkan pekerjaan terkait.
Jangan memublikasikannya dengan force-add.

## 2. Pembagian dua cakupan

| Cakupan | Tempat | Cara menentukan |
|---|---|---|
| Aplikasi umum | File `daun_merah*.md` pada folder ini | Fitur informasi publik atau infra umum yang tidak dipicu kebutuhan auto-entry |
| Auto-entry / AATAS / Professional LLM Trader | `professional_llm_trader/` | Pekerjaan dipicu/ditujukan untuk auto-entry, termasuk kode atau infra yang dipakai bersama |

Batas lengkap dan kewajiban penunjuk perubahan publik mengikuti `ATURAN.md` §2.
Nama file kode yang diedit tidak menentukan tempat dokumentasi: perubahan
`api/admin.js` dapat termasuk salah satu cakupan, bergantung tujuan pekerjaan.
Daftar vendor dan peta pemakaian AI tetap berada di dokumen pemilik lintas fitur;
rincian pekerjaan auto-entry ditautkan ke folder khususnya.

## 3. Pilih bacaan berdasarkan tugas

| Kebutuhan | Aplikasi umum | Auto-entry |
|---|---|---|
| Riwayat perubahan, alasan keputusan, bukti tes | [daun_merah.md](daun_merah.md) | `professional_llm_trader/changelog.md` (lokal) |
| Langkah pekerjaan aktif / handoff | `daun_merah_plan.md` (lokal) | `professional_llm_trader/plan.md` (lokal) |
| Pekerjaan tertunda dan syarat lanjut | `daun_merah_progress.md` (lokal) | `professional_llm_trader/progress.md` (lokal) |
| Riset, eksperimen, pembelajaran | [daun_merah_riset.md](daun_merah_riset.md) | `professional_llm_trader/riset.md` (lokal) |
| Paper eksternal dan implikasinya | [daun_merah_referensi_riset.md](daun_merah_referensi_riset.md) | Pustaka yang sama; penerapan eksperimen di riset auto-entry |
| Provider/model, fallback, kuota dan guard AI | [daun_merah_ai.md](daun_merah_ai.md) | Peta yang sama; riwayat perubahan khusus di changelog auto-entry |
| Vendor, hosting, sumber data, status diterima/ditolak | [daun_merah_vendor.md](daun_merah_vendor.md) | Inventaris yang sama; alasan eksperimen khusus di riset auto-entry |
| Metode audit berulang | `audit_daun_merah.md` §1–2 lalu §3.x (lokal) | `professional_llm_trader/audit_workflow.md` (lokal) |
| Kelayakan dan prosedur penambahan pair | Ikuti fitur terkait | `professional_llm_trader/pair_workflow.md` (lokal) |
| Notulen CME 8 Agustus 2026 | [Penunjuk lokasi lama](ringkasan_rapat_auto_entry_cme.md) | [Snapshot historis](professional_llm_trader/rapat_auto_entry_cme_2026-08-08.md), tersedia di GitHub |

**Arsitektur dan alur kode:** cari heading `Ringkasan Proyek`, `Stack Teknis`,
`Struktur File`, atau `API Endpoints` di `daun_merah.md`, lalu cocokkan dengan
kode dan sesi terbaru. Bagian referensi di ekor file tumbuh sejak awal proyek;
judul `Current`, `Known Issues`, `Constraint Absolut` atau `Backlog` di sana
tidak membuktikan isinya masih berlaku. Aturan aktif tetap `ATURAN.md`,
pekerjaan aktif/tertunda tetap plan/progress masing-masing cakupan.

## 4. Bedakan sifat informasi

| Sifat | Arti | Cara memelihara |
|---|---|---|
| Kondisi sekarang | Konfigurasi/status yang dipakai saat ini | Perbarui bagian pemiliknya di tempat dan beri tanggal verifikasi |
| Riwayat | Apa yang berubah dan mengapa pada suatu sesi | Entri terbaru di atas; keputusan berikutnya dapat menggantikan keputusan lama |
| Riset | Pertanyaan, metode, hasil dan batas bukti | Bedakan observasi, hipotesis, keputusan, dan penerapan; temuan bukan otomatis kebijakan |
| Plan aktif | Langkah yang memang ditugaskan untuk dikerjakan | Ikuti kriteria selesai dan ketentuan konfirmasi user sebelum membersihkan plan |
| Tertunda | Pekerjaan belum dapat dilanjutkan | Simpan alasan, state terakhir dan syarat lanjut; bukan laporan selesai |
| SOP | Cara menjalankan pekerjaan berulang | Perbarui checklist di tempat; hasil satu run masuk dokumen hasil yang sesuai |
| Snapshot historis | Catatan pada tanggal tertentu | Pertahankan isi dan tanggal; tambahkan penunjuk pengganti, jangan jadikan aturan aktif |

Untuk keputusan baru, sertakan konteks/alasan, status (diterapkan, ditolak,
diganti, atau belum diputuskan), sumber/bukti dan rujukan sesi. Untuk hasil
pengujian, bedakan lokal/mock, produksi read-only, dan verifikasi fungsional nyata.
Gunakan format file tujuan; tabel ini hanya membantu membaca jenis informasinya.

## 5. Temukan konteks tanpa membaca seluruh riwayat

Jalankan dari root repo; alat ini hanya membaca file, tanpa API atau dependency baru:

```powershell
node scripts/docs-context.cjs --list
node scripts/docs-context.cjs --outline daun_merah.md
node scripts/docs-context.cjs --find "institution_views" --limit 20
node scripts/docs-context.cjs --find "AATAS" --file professional_llm_trader --limit 15
node scripts/docs-context.cjs --check
```

`--list` menampilkan ukuran dan status Git setiap dokumen yang tersedia.
`--outline` menampilkan heading tingkat 1–2 di luar blok kode beserta nomor baris.
`--find` mencari teks literal tanpa membedakan huruf besar/kecil, menampilkan
heading terdekat dan baris cocok, serta membatasi hasil. Baca paragraf di sekitar
hasil yang relevan sebelum mengambil keputusan. Hasil mengikuti urutan nama file
dan baris; bukan peringkat relevansi atau urutan waktu lintas dokumen.

`--check` memeriksa header semua Markdown yang tersedia di `Dokumentasi/` dan
tautan relatif pada peta serta penunjuk notulen. Ini pemeriksaan struktur,
bukan pembuktian kebenaran semua isi atau tautan historis. File lokal yang tidak
tersedia di clone tidak dianggap rusak. Indeks dihitung saat dijalankan sehingga
nomor baris tidak perlu dirawat manual.
