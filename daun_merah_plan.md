# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 126):** Seluruh tugas Blok D (A2.3 Fase 2, B2 4.0c, B3 COR-G, QUAL-11, QUAL-17) **sudah selesai dikerjakan** di session ini. Lihat "Changelog Session 126" di `daun_merah.md` untuk detailnya.
>
> **Status (2026-07-01, Session 134):** Section G (Session Strip di REGIME bar) dan penambahan Retail Sentiment mini-strip di dashboard **sudah selesai dikerjakan** — lihat "Changelog Session 134" di `daun_merah.md` untuk detailnya. Bagian yang sudah selesai dihapus dari dokumen ini. Sisanya (F, E) tetap **sisa backlog opsional** — bukan prioritas, diabaikan kecuali diminta user.
>
> **Status (2026-07-01, Session 135):** Fix kategorisasi berita `econ-data` vs `market-moving`/`indexes`/`macro`/`bonds` **sudah selesai dikerjakan & terverifikasi** — lihat "Changelog Session 135" di `daun_merah.md` untuk detailnya.
>
> **Status (2026-07-03, Session 140):** Thesis alert (headline kontra buy/sell limit di JURNAL/CHECKLIST/SIZING) yang sempat **ditunda** karena reliability sudah di-hardening dan **diaktifkan kembali** — lihat "Changelog Session 140" di `daun_merah.md` untuk detailnya. Bagian scenario/progress-nya dihapus dari dokumen ini.
>
> **Update workflow (`CLAUDE.md`):** Plan-first di dokumen ini sekarang HANYA dipakai kalau user eksplisit minta "buatkan plan" atau perintahnya ditujukan untuk AI lain (bukan eksekusi langsung). Untuk perintah eksekusi langsung, kerjakan → evaluasi mandiri → uji → update `daun_merah.md` → push, tanpa gate plan terpisah.
>
> **Status (2026-07-07, Session 145):** Plan "Re-arsitektur Distribusi Model AI per Fitur (Nemotron 3 Ultra + realokasi existing)" **sudah dieksekusi & dideploy** (gpt-oss:120b untuk journal/fundamental disumber dari Cerebras, bukan OpenRouter, per keputusan user saat eksekusi) — lihat "Changelog Session 145" di `daun_merah.md` untuk detail lengkap termasuk hasil tes live Nemotron 3 Ultra (belum 100% reliable, user pilih tetap primary + terus dipantau) dan follow-up investigasi NVIDIA NIM direct sebagai kandidat sumber alternatif. Bagian plan-nya dihapus dari dokumen ini.
>
> **Status (2026-07-07, Session 150):** Section G "Riset NFP — Framework Kausal Fase 1" **sudah dieksekusi penuh dalam satu sesi** di `project_delay/machine learning/ml/NFP_PROYEK/`. **Hasil: kill-gate TIDAK lolos (0/25 hubungan memenuhi kriteria; syarat ≥3) → proyek STOP, tidak lanjut Fase 2, tidak ada integrasi ke app.** Hasil negatif dilaporkan jujur — detail di `NFP_PROYEK/results/REPORT.md`, working notes & kendala akses di `NFP_PROYEK/STATUS.md`, ringkasan di "Changelog Session 150" `daun_merah.md`. Satu action item opsional tersisa untuk user: dataset Cleveland Fed WARN factor butuh akun ICPSR gratis (kalau suatu saat mau menambah indikator itu). Bagian plan-nya dihapus dari dokumen ini.
>
> **Status (2026-07-07, Session 151):** Section G revisi "Riset NFP — 3 Celah Lanjutan Pasca Kill-Gate" **sudah dieksekusi** — lihat "Changelog Session 151" di `daun_merah.md` + `NFP_PROYEK/results/REPORT.md` §8. Hasil: **Celah 1 (SPF skill-weighting) GAGAL 0/6 varian** (main spec p=0,778; hit-rate nominal 64% terbukti produk skew searah, bukan sinyal); **Celah 2 (Kalshi) TIDAK BISA DIUJI** dari jaringan user — seluruh domain kalshi.com diblokir Kominfo (DNS hijack `internetpositif.id`); `fetch_kalshi.py` siap-pakai, **action item user: jalankan `--probe` via VPN/jaringan lain**; **Celah 3 (live validation model dua-sisi) AKTIF** — spec beku v1, `predict_live.py` teruji end-to-end, prediksi pertama pada H-1 rilis NFP 2026-08-07, **action item user: daftarkan Task Scheduler** (perintah satu baris di `NFP_PROYEK/STATUS.md`; pembuatan otomatis ditolak permission classifier sesi). Kriteria gabungan tetap 0 lolos dari syarat ≥3 → STOP proyek utama tetap berlaku. Bagian plan-nya dihapus dari dokumen ini.

berpikiran untuk melakukan efisiensi code, mulai membuat kode yang tidak relevan dan membuat kode alternatif yang lebih singkat tanpa menghilangkan kualitas dari code

mulai kepikiran juga untuk membagi bagi fitur berdasarkan branch, dan membuat sebuah perlindungan agar orang tidak bisa melakukan copy pada aplikasi saya(karena html kan bisa di inspect trus ctrl+a dan buat aplikasinya sendiri)

**[FIXED — Session 152]** Bug menu HP tumpang tindih klik dengan VIX/REGIME: root cause `.header` punya `z-index:100` tanpa `position` (jadi tidak berlaku) + `backdrop-filter` bikin stacking context terisolasi → tap di item dropdown menu (Notifikasi/Kategori Push) di rentang tinggi tertentu malah kena `.regime-banner` di baliknya. Fix: tambah `position: relative;` di `.header` (index.html). Diverifikasi end-to-end via browser test otomatis (Puppeteer) — reproduce bug dulu (terbukti), lalu konfirmasi fix (semua koordinat dropdown resolve ke item yang benar, regime banner langsung tetap normal). Detail di "Changelog Session 152" `daun_merah.md`.

aku berpikiran untuk membuat grafik dari cross asset correlation dan anomali korelasi dari semua kombinasi pair. ingin melihat apakah efisien atau maksa

**[FIXED — Session 152]** Bug Thesis Alert: headline "Currency Strength Chart: Strongest: NZD, CHF, CAD, AUD, EUR, GBP, USD, JPY - Weakest" salah dibaca AI sebagai "USD salah satu mata uang terkuat" (padahal USD posisi ke-7/8, nyaris paling lemah) → jadi alasan palsu kontra thesis LONG XAU/USD, padahal posisi asli USD itu justru MENDUKUNG thesis. Fix: prompt Call 4 (`checkThesisContradictions()` di `api/market-digest.js`) diperkuat — instruksi eksplisit abaikan headline ranking "Currency Strength Chart" sebagai bukti kontradiksi. Detail di "Changelog Session 152" `daun_merah.md`. Verifikasi live behavior tertunda (perlu API key provider yang tidak tersedia lokal) — pantau output sesi berikutnya.

**[FIXED — Session 152]** Cek keaslian & realtime retail position: dikonfirmasi sumber inti memang myfxbook (via wrapper forexbenchmark.com — tiap baris tabelnya link ke `myfxbook.com/community/outlook/{PAIR}`). Cadence 2 jam adalah desain resmi (bukan bug). Tapi ditemukan bug lebih serius saat investigasi: **parser `parseRetailPositions()` di `api/feeds.js` salah ambil kolom** — mengira kolom "Currency difference" sebagai "Percentage long" sejak fitur ini dibuat (session 134), menyebabkan sinyal kontrarian salah arah/salah trigger di Journal/Sizing/Scenario (contoh: AUDUSD tampil 61.1% long padahal sebenarnya 5.2%). Sudah di-fix + 4 test regresi baru (`test/feeds_retail.test.js`). Detail di "Changelog Session 152" `daun_merah.md`.

aku sudah cek sertifikat ssl dari myfxbook dan mengatakan bahwa sertifikat masih kurang bisa

Detail hasil cek (DNS myfxbook.com → 104.20.32.110, server header cloudflare):
- Issuer: WE1 (Google Trust Services), chain WE1 → GTS Root R4 → GlobalSign Root CA
- CN: myfxbook.com, SAN: myfxbook.com, *.myfxbook.com
- Valid 29/Jun/2026 – 27/Sep/2026
- Verdict tool: "TLS Certificate is correctly installed — Congratulations!"

**Kesimpulan: tidak masalah.** "Not issued by DigiCert/GeoTrust/Thawte/RapidSSL" cuma disclaimer promosi tool checker (bukan warning keamanan) — situs di-proxy Cloudflare dengan sertifikat sah dari Google Trust Services, rantai CA valid & dipercaya luas, masa berlaku pendek adalah hal normal untuk cert auto-issued. Tidak ada indikasi situs palsu/MITM. Item ini selesai/tidak perlu tindak lanjut.

# F. INFRASTRUKTUR

- **[INFRA-1] cron-job.org sebagai backup OHLCV sync**
  - **Masalah:** Vercel cron hourly (`30 * * * *`) tidak diizinkan di Hobby plan → dihapus session 130. Kalau GitHub Actions gagal 2-3 run berturut, data OHLCV bisa stale 2+ jam (penyebab "⚠ 2.8 jam lalu" di session 128).
  - **Solusi:** Daftarkan akun di [cron-job.org](https://cron-job.org) (gratis), buat job yang hit `https://financial-feed-app.vercel.app/api/admin?action=ohlcv_sync` tiap 30 menit. Request datang dari luar Vercel → tidak kena batasan Hobby plan.
  - **Cara setup:** Buat akun → New cronjob → URL endpoint → schedule `*/30 * * * *` → Save. Tidak perlu perubahan kode.

---

# E. SISA BACKLOG OPSIONAL

- **[QUAL-2]** FRASA TERLARANG mungkin terlalu agresif (konektor normal ikut dilarang) → prosa bisa kaku. **Pantau dulu via `quality_flags` dari C8, jangan ubah tanpa keluhan nyata.**
- **[C5 DRAFT]** Bagian teks prompt di C5 (headline mentah ke thesisPrompt) masih berstatus **DRAFT, menunggu review user** sebelum dianggap final. Kode sudah di-push, tapi kualitas output perlu divalidasi live.
- **[C8 Tahap 2 — OPSIONAL]** Kalau `phraseHits.length` sering melewati ambang via log produksi, pertimbangkan satu AI call kecil "tulis ulang kalimat ini tanpa frasa berikut". Tunggu bukti severity nyata dari `provider_log` dulu.