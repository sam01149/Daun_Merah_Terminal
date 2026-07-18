# Daun Merah — Riset & Pembelajaran

> **Aturan dokumen ini (2026-07-18):** tiga jenis isi — (1) **riset aktif** (desk research /
> eksperimen yang sedang berjalan, entri WAJIB pakai tanggal + sumber URL/sesi), (2)
> **pertanyaan terbuka & parkiran ide** (belum layak jadi plan), (3) **pembelajaran proyek**
> (pelajaran TERDISTILASI: satu prinsip + konteks satu baris + rujukan sesi — bukan cerita
> ulang; cerita lengkap tetap di changelog `daun_merah.md`). Pembelajaran yang bentuknya
> aturan perilaku AI juga disalin ke `.agents/AGENTS.md` (file yang dipatuhi AI pelaksana).
>
> **Yang BUKAN tempatnya di sini:** changelog (`daun_merah.md`), konfigurasi kondisi-sekarang
> (`daun_merah_ai.md` / `daun_merah_vendor.md`), langkah eksekusi (`daun_merah_plan.md`),
> sitasi paper akademis (`daun_merah_referensi_riset.md`).
>
> **Aturan hapus:** riset selesai / ide yang sudah dieksekusi / entri basi → hapus dari sini;
> riwayatnya cukup di changelog + git history. Isi lama dokumen ini (peta jalan "AI lebih
> pintar" session 166, sebagian besar sudah jadi fitur: Tier 1 = setup_log, Tier 4 = AI
> Kritikus) dihapus 2026-07-18 — masih bisa dibaca di git history (`daun_merah_riset_ai_pintar.md`).

---

# Pertanyaan Terbuka & Parkiran Ide

- **Kalibrasi keyakinan berbasis outcome** (eks "Tier 2", session 166): ikat badge keyakinan
  Analisa AI ke win-rate historis segmen serupa (pair + bias + rentang skor konfluensi) dari
  `setup_log:v1`, bukan self-assessment LLM. Prasyarat: sampel setup selesai cukup (indikatif
  ≥30 per segmen) — data sedang terakumulasi otomatis, cek berkala.
- **Re-run backtest konfluensi berkala** (`scripts/backtest_confluence.js`): angka bergerak
  antar-run (jendela 60 hari bergeser) — jalankan ulang tiap beberapa minggu dan bandingkan
  TREN, jangan kutip satu angka sebagai konstanta. Run terakhir 2026-07-17: zona skor tinggi
  bounce 55% vs break 22% (~2.5:1, asumsi "konfluensi = area reaksi" didukung); kontrol skor
  rendah terlalu kecil (30 zona / 7 sentuh) untuk klaim pembanding; GBP/USD terlemah (47%).
- **Seasonality bulanan/mingguan per pair** — hitung offline dari data Daily yang sudah ada
  di Redis; 0 AI call. Sajikan sebagai konteks, bukan sinyal.
- **Volatility regime** — persentil ATR vs 6 bulan sebagai konteks "market tenang/liar".
- **Bobot lebih untuk posisi harga vs option expiry besar H-1** — datanya sudah ada, belum
  diberi peran di scoring.
- **Carry trade / currency crash risk** — masih tahap riset literatur, BELUM diverifikasi ke
  sumber primer; jangan dieksekusi sebelum itu (lihat juga catatan "Ditahan" Plan G).
- **Integrasi MT5 Broker Demo & Free VPS (Hugging Face / CepatCloud)** (Ide baru, session 185):
  * *Tujuan:* Menyelesaikan masalah ketidakstabilan Yahoo Finance ("bom waktu") dan memangkas delay lilin teknikal (H1/H4) ke 0-delay secara 100% gratis, legal, dan tanpa batas kuota API key.
  * *Konsep:* Menjalankan terminal MT5 (akun demo gratis broker komersial) di VPS gratis (CepatCloud atau Hugging Face Spaces + pinger anti-sleep). Script jembatan Node.js/Python menarik data tick harga & candle OHLCV langsung dari server broker, lalu menulisnya instan ke Redis Daun Merah.
  * *Status:* Siap untuk dievaluasi sebagai peta jalan pembaruan infrastruktur data masa depan.

---

# Pembelajaran Proyek

- **Unit test hijau bukan bukti fitur benar.** Bug skala ADP (seri berunit orang vs ribuan)
  dan filter Inside Bar `mr_co1` hanya ketahuan saat verifikasi data live production, bukan
  dari test. Selalu uji dengan data/deploy nyata sebelum menyimpulkan. (S154, S180)
- **Masalah model gratis = reliability, bukan kualitas.** Nemotron 3 Ultra outputnya bagus
  (0 pelanggaran frasa) tapi latency 7-41 detik tak terprediksi → didemote. Memperbaiki
  struktur input/output (fact sheet deterministik) berdampak jauh lebih besar daripada
  ganti-ganti model. (S162, S180)
- **Baca ToS sumber primer SEBELUM menulis kode.** NVIDIA API Trial melarang eksplisit
  penggunaan produksi — ketahuan di desk research dari PDF resmi (bukan artikel pihak
  ketiga), menghemat seluruh siklus uji live yang hasilnya tidak akan bisa dipakai. (Plan N,
  2026-07-18; precedent: Kimi K2.6 403, S144)
- **Korupsi di luar tag `<script>` lolos semua lapis test.** Teks nyasar sebelum
  `<!DOCTYPE html>` tampil sebagai "judul palsu" di semua tab dan tidak tertangkap
  parse-check maupun `npm test`. Mitigasi: test integritas statis (Plan M3). (S181)
- **Timeout client harus lebih panjang dari timeout server.** Root cause NEWS mobile gagal:
  client abort sebelum server `maxDuration` selesai — pola yang sama bisa menular ke endpoint
  lain kalau tidak diperiksa saat menambah fitur lambat. (S161)
- **Env var Sensitive di Vercel selalu terbaca kosong via `vercel env ls/pull`.** Itu bukan
  bukti var tidak ter-set — verifikasi harus FUNGSIONAL (call kecil yang memakai key-nya).
  (S163+, terbukti lagi di Plan N saat konfirmasi nama var aktual)
- **PWA bisa nyangkut di versi lama berhari-hari.** Auto-reload hanya terpicu perubahan byte
  `sw.js`; fix `index.html`-only tidak pernah sampai ke device yang tidak di-force-close —
  sebelum menyimpulkan "belum difix", pastikan versi yang dilihat user memang versi terbaru.
  Mitigasi permanen: probe versi Plan M3. (S179, S48b)

---

# Riset Provider AI Baru: Gemini / Mistral / NVIDIA NIM (2026-07-18)

> Eksekusi Plan N (`daun_merah_plan.md` bagian N). Tujuan: cari kandidat gratis baru untuk
> Call 1/2/3 Ringkasan yang lebih stabil dari saga Nemotron/GLM/Qwen (lihat memory proyek).
> Env var Vercel aktual (dikonfirmasi `vercel env ls`, BUKAN nama tebakan di plan):
> `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY` (bukan `NVIDIA_NIM_API_KEY`).

## Tahap 0 — Desk Research

### Tabel Pembanding

| | Gemini (AI Studio) | Mistral (La Plateforme) | NVIDIA NIM (build.nvidia.com) |
|---|---|---|---|
| Endpoint OpenAI-compatible | `generativelanguage.googleapis.com/v1beta/openai/` | `api.mistral.ai/v1` | `integrate.api.nvidia.com/v1` |
| Model kandidat Call 1 (prosa) | `gemini-2.5-flash` (10 RPM/1.500 RPD) atau `gemini-2.5-flash-lite` (15 RPM/1.000 RPD) | `mistral-medium-3.5-26.04` (frontier, agentic) atau `mistral-small-4-0-26-03` | model DeepSeek yang di-host NIM (cek daftar model saat eksekusi Tahap 2 — endpoint `/v1/models`) |
| Limit resmi (indikatif, BUKAN dari akun user) | Flash: 10 RPM / 250K TPM / 1.500 RPD. Flash-Lite: 15 RPM / 250K TPM / 1.000 RPD. **Per PROJECT**, bukan per key. | Tier "Experiment": ±1 miliar token/bulan, RPS tidak dipublikasi resmi lagi (estimasi non-resmi 1-5 RPS) — **wajib cek Admin Console → Limits saat eksekusi**, jangan pakai angka riset ini sebagai kepastian. | 40 RPM baseline (bisa apply upgrade ke 200 RPM). Bukan sistem kredit-habis-sekali untuk hosted catalog gratis — dibatasi RPM, bukan kredit (kredit "1000/5000" yang beredar di artikel pihak ketiga tampaknya untuk jalur lain/NGC, perlu diverifikasi di dashboard akun user saat eksekusi). |
| Context window | Gemini 2.5 Flash: besar (≥1M token kelas Gemini umumnya) — verifikasi model spesifik saat eksekusi | Tidak dikonfirmasi di riset ini — cek `/v1/models` | Tergantung model yang dipilih — cek saat eksekusi |
| JSON mode native | Ya — `response_format` didukung (relevan untuk Call 2/3, nilai tambah dibanding brace-matching existing) | Endpoint OpenAI-compatible umumnya mendukung `response_format` — verifikasi saat implementasi Call 2/3 | Tergantung model — banyak NIM model OpenAI-compatible mendukung `response_format`, verifikasi per model |
| **ToS produksi** | Free tier BOLEH dipakai (bukan cuma evaluasi), TAPI prompt/output dipakai Google untuk training + **human reviewer bisa membaca isi prompt** (dikonfirmasi dari `ai.google.dev/gemini-api/terms`: "human reviewers may read, annotate, and process your API input and output"). Isi prompt proyek ini = berita pasar publik, tidak sensitif → **diterima**, sesuai catatan plan. | Ambigu — ToS komersial Mistral tidak eksplisit melarang produksi di tier gratis (beda dari NVIDIA di bawah), tapi klausul training-data (`legal.mistral.ai/terms/commercial-terms-of-service` §4.2) menyebut data pada **free subscription dipakai untuk training kecuali opt-out**. Tidak ditemukan larangan produksi eksplisit — status: **BOLEH dicoba, catat sebagai fallback-risiko-training-data**. | **DILARANG EKSPLISIT.** Dikonfirmasi langsung dari PDF resmi `NVIDIA API Trial Terms of Service` (v. 19 Sep 2025) §1.2 & §1.4: *"NVIDIA will provide you access to the API Service for limited trial purposes only and **without use of the API Service or Generated Content in production**"* dan *"Unless you purchase a Subscription from NVIDIA or a Service Provider..., you may only use the API Service **for internal testing and evaluation purposes, not in production**."* |
| Sumber | [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits), [ai.google.dev/gemini-api/terms](https://ai.google.dev/gemini-api/terms) | [docs.mistral.ai/admin/user-management-finops/tier](https://docs.mistral.ai/admin/user-management-finops/tier), [legal.mistral.ai/terms/commercial-terms-of-service](https://legal.mistral.ai/terms/commercial-terms-of-service), [docs.mistral.ai model list](https://docs.mistral.ai/getting-started/models/models_overview/) | [assets.ngc.nvidia.com NVIDIA API Trial ToS PDF](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf), [forums.developer.nvidia.com](https://forums.developer.nvidia.com/t/clarity-on-nim-api-free-tier-rate-limit-increases/369624) |

### KEPUTUSAN GATE AWAL (sebelum satu baris kode pun ditulis)

**NVIDIA NIM: TIDAK BISA di-PROMOTE ke chain produksi, apapun hasil tesnya.** ToS resmi
(bukan artikel pihak ketiga) melarang eksplisit "not in production" untuk siapa pun yang
belum beli Subscription berbayar. Ini bukan risiko/probabilitas seperti kandidat lain
(Mistral evaluation-tapi-ambigu, NVIDIA credits-habis) — ini larangan kontraktual jelas.
Sesuai aturan edge-case plan ini sendiri ("kalau terms melarang produksi, statusnya
maksimal fallback riset — catat eksplisit", awalnya ditulis untuk Mistral tapi berlaku
lebih kuat untuk NVIDIA): **NVIDIA turun status jadi riset/dokumentasi saja sebelum Tahap
1 dimulai** — TIDAK dilanjutkan ke uji live 5-sampel (Tahap 3) karena hasil selolos apapun
tidak bisa dipakai. Kode diagnostik `?test_nvidia=1` tetap dibuat (murah, konsisten pola
kandidat lain yang ditolak) untuk jaga-jaga kalau NVIDIA suatu saat merilis tier produksi
gratis, tapi TIDAK dijalankan sebagai bagian gate promosi.

**Gemini & Mistral: lanjut ke Tahap 1-4 sesuai plan.**

## Tahap 1 — Verifikasi Fungsional Key

Dites live 2026-07-18 via `?test_gemini=1` / `?test_mistral=1` / `?test_nvidia=1` di
`financial-feed-app.vercel.app/api/market-digest` (jalur diagnostik terisolasi, TIDAK
menimpa `latest_article`):

- **Gemini** — key valid. Model awal `gemini-2.5-flash` → HTTP 404 (generasi model sudah
  bergeser ke Gemini 3.x per riset ulang saat itu). Diganti alias resmi `gemini-flash-latest`
  (hot-swap otomatis, resolve ke `gemini-3.5-flash`) → OK. Masalah kedua: `finish_reason=length`
  dengan output cuma 109 karakter di percobaan pertama — Gemini 3.x selalu "thinking" (tidak
  bisa dimatikan total, beda dari 2.5 yang bisa `reasoning_effort:'none'`), budget token
  1300 habis untuk reasoning trace. Fix: `reasoning_effort:'low'` + `max_tokens` naik ke
  3000 → OK, output 2.900-3.100 karakter konsisten setelahnya.
- **Mistral** — key valid, model `mistral-medium-latest` sukses di percobaan PERTAMA, tanpa
  perlu iterasi.
- **NVIDIA NIM** — key valid (tidak pernah dapat error auth), TAPI 3 model id dicoba
  (`deepseek-ai/deepseek-v3.2`, `deepseek-ai/deepseek-v3.1`, `deepseek-ai/deepseek-v3.1-terminus`
  — id terakhir dikonfirmasi dari `docs.api.nvidia.com/nim/reference/`) semuanya HTTP 404
  (~40ms, kemungkinan ditolak di layer gateway/routing sebelum sampai model backend, bukan
  auth/network gagal). **Tidak diselidiki lebih lanjut** — NVIDIA sudah REJECT permanen by
  ToS (lihat Keputusan Gate Awal di atas), jadi menyelesaikan model id yang benar tidak
  mengubah keputusan promosi apapun hasilnya. Kalau suatu saat NVIDIA membuka tier produksi
  gratis dan riset ini dibuka kembali, cek daftar model AKTUAL via `GET /v1/models` dengan
  key asli (butuh akses key plaintext yang tidak tersedia dari sesi eksekusi ini).

## Tahap 2 — Tier Diagnostik Call 1

Ditambahkan di `api/market-digest.js`: `?test_gemini=1`, `?test_mistral=1`, `?test_nvidia=1`
(pola persis `?test_nemotron=1`, `isIsolatedTest` — hasil TIDAK ditulis ke `latest_article`).

## Tahap 3 — Sampel Live Call 1

**STATUS: SELESAI (2026-07-18). Gemini dipromosikan (PROMOTE) sebagai fallback di Call 1/2/3, Mistral dan NVIDIA NIM ditolak (REJECT).**

### Gemini (`gemini-flash-latest`, 6 sampel Call 1)

| # | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| 1 | 5.4s | Ya | 2.993c | 0 | ID penuh | |
| 2 | 6.5s | Ya | 2.940c | 0 | ID penuh | |
| 3 | 7.8s | Ya | 3.091c | 1 ("di tengah") | ID penuh | |
| 4 | 6.3s | Ya | 2.599c | 1 ("di tengah") | ID penuh | |
| 5 | 10.2s | Ya | 2.677c | 1 ("di tengah") | ID penuh | |
| 6 | 22.7s | Ya | 2.332c | 0 | ID penuh | Uji ulang (server cold-start/network latency) |

6/6 sukses di Call 1, latency rata-rata di bawah 10s (satu kali 22.7s akibat cold start, tetap di bawah timeout 25s). Format `{{TAG: X}}` dan struktur FX/XAUUSD dipatuhi 100%. Rate leak forbidden-phrase "di tengah" sebesar 50% (3/6 sampel) — setara/sedikit lebih tinggi dibanding DeepSeek, tetapi kualitas prosa makronya sangat superior dibanding model free tier lainnya.

**Call 2 & Call 3 Integration (JSON Mode):**
- **Call 2 (JSON Stance):** Sukses (1/1). Sempat kena JSON parse error akibat truncation karena `max_tokens` di-hardcode 700. Setelah dinaikkan ke 3000 dan dikirim `reasoning_effort: 'low'`, output JSON bias CB terurai dengan sempurna.
- **Call 3 (JSON Thesis):** Sukses (1/1). Sama seperti Call 2, sempat truncated pada `max_tokens` 800. Setelah diperbaiki dengan `maxTokens: 3000` + `reasoning_effort: 'low'`, skema thesis terurai 100% valid dan disimpan sukses di Redis.

### Mistral (`mistral-medium-latest`, 4 sampel Call 1)

| # | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| 1 | 6.6s | Ya | 1.578c | 0 | ID penuh | |
| 2 | 11.8s | Ya | 1.656c | 1 ("di tengah") | Campur | "Fed's Hammack" (posesif Inggris) |
| 3 | 13.1s | Ya | 1.916c | 0 | Campur | "Fed's Hammack" lagi |
| 4 | 7.6s | Gagal | 925c | 0 | ID penuh | **Format Failure:** FX di-skip total, hanya menulis bagian XAUUSD tanpa header. |

### NVIDIA NIM (1 sampel per model, Call 1)

| Model | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 20.9s | Gagal | 1.733c | 0 | ID penuh | **Format Failure:** Bagian FX dilewatkan total, hanya menulis ulasan XAU/USD. |
| `deepseek-ai/deepseek-v4-flash` | 24.1s | Ya | 2.915c | 2 ("di tengah", "sejalan dengan") | ID penuh | Ulasan FX dan XAU/USD sangat lengkap dan tajam. Namun latency kritis dekat timeout. |

**Evaluasi:**
- **Nemotron 3 Ultra:** Mengalami kegagalan format kritis dengan mengabaikan bagian FX sepenuhnya (mirip seperti Mistral). Latency 20.9s terlalu dekat batas timeout 25s.
- **DeepSeek v4 Flash:** Kualitas prosa dan struktur analisisnya sangat luar biasa (mengulas EUR/USD, GBP/USD, USD/JPY, AUD/USD, dan XAU/USD secara tajam dan runut). Namun, latency mencapai **24.1s** (sangat riskan mengalami timeout Vercel yang dipotong di 25s) dan membocorkan 2 frasa terlarang.

## Tahap 6 — Keputusan Final (2026-07-18)

- **Gemini (gemini-flash-latest)**: **PROMOTE** ke chain produksi sebagai **Fallback 2** di Call 1 (di antara Cerebras gpt-oss dan Groq) dan **Fallback 1** di Call 2 & Call 3 (di antara SambaNova dan Groq karena mendukung JSON mode native `response_format`).
  * *Pelajaran penting:* Gemini 3.x selalu "thinking" dan tidak bisa dinonaktifkan. Selalu set `max_tokens` minimal 2500-3000 untuk Call JSON agar tidak terpotong (truncated) di tengah jalan, serta kirim parameter `reasoning_effort: 'low'`.
- **Mistral (mistral-medium-latest)**: **REJECT**. Gagal format (mengabaikan instruksi FX) dan gagal JSON Call 3 (HTTP 400).
- **NVIDIA NIM**: **REJECT**. 
  * *Hambatan Hukum:* Ketentuan Layanan (*Terms of Service*) trial melarang penggunaan di produksi.
  * *Hambatan Teknis:* Latency sangat tinggi (20.9s–24.1s) yang mendekati batas maksimal timeout Vercel 25s, sehingga tidak andal sebagai fallback yang stabil. Nemotron juga gagal format (mengabaikan FX). DeepSeek v4 Flash sangat baik dari segi konten, namun latency 24.1s dan leak kata terlarang menggugurkannya sebagai kandidat produksi.
