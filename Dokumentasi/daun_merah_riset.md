# Daun Merah — Riset & Pembelajaran

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Riset internal proyek — 3 jenis isi: (1) riset aktif, (2) pertanyaan terbuka &
           parkiran ide (belum layak jadi plan), (3) pembelajaran proyek terdistilasi.
BOLEH    : Riset aktif WAJIB tanggal + sumber URL/sesi; pembelajaran = satu prinsip + konteks
           satu baris + rujukan sesi (bukan cerita ulang). Pembelajaran berbentuk aturan
           perilaku universal → usulkan juga masuk ATURAN.md.
DILARANG : Changelog (-> daun_merah.md), kondisi-sekarang AI/vendor (-> daun_merah_ai.md /
           daun_merah_vendor.md), langkah eksekusi (-> daun_merah_plan.md), sitasi paper
           akademis (-> daun_merah_referensi_riset.md), pekerjaan tertunda non-riset
           (-> daun_merah_progress.md).
FORMAT   : Entri bertanggal per bagian (Riset Aktif / Pertanyaan Terbuka / Pembelajaran).
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Aturan hapus:** riset selesai / ide yang sudah dieksekusi / entri basi → hapus dari sini;
> riwayatnya cukup di changelog + git history. Isi lama dokumen ini (peta jalan "AI lebih
> pintar" session 166, sebagian besar sudah jadi fitur: Tier 1 = setup_log, Tier 4 = AI
> Kritikus) dihapus 2026-07-18 — masih bisa dibaca di git history (`daun_merah_riset_ai_pintar.md`).

---

## Riset Aktif

> **Seluruh riset khusus auto-entry/Plan U/Professional LLM Trader dipindah ke `Dokumentasi/professional_llm_trader/riset.md`** (2026-08-08) — termasuk audit total Plan U, audit "professional trader", profil struktural AUD/NZD & EUR/GBP, riset HFT, riset akurasi auto-entry, caveat korelasi XAU/USD-EUR/USD, dan latensi calendar_v1 Plan U-3.

### [2026-07-23] Evaluasi & Perbandingan Biaya Model AI Kandidat (DeepSeek v4-flash vs GLM 5.2 vs Kimi K3)

Evaluasi komparatif 3 kandidat model AI berbasis kalkulasi penggunaan paling boros Daun Merah (32 call/hari = 704 call/bulan; 22 otomatis + 10 manual):

| Kandidat | Harga per 1M token | Biaya bulanan estimasi | Keunggulan | Kekurangan |
|---|---|---|---|---|
| **DeepSeek v4-flash** (Produksi Saat Ini) | Input $0.14 / Output $0.28 | **~$0.50 (± Rp 8.150/bulan)** | Kecepatan kilat (10–15s, bebas Vercel 60s timeout), presisi JSON 13-field native 100% | Narasi prosa makro terasa lebih kaku |
| **GLM 5.2** (Zhipu AI / Z.ai) | Input $0.77 / Output $2.42 (cached input $0.143) | **~$3.26 (± Rp 52.800/bulan)** | Narasi & sintesis makro Bahasa Indonesia paling kaya, luwes, dan institusional (terbaik untuk Call 1 Briefing FX) | Latensi 18–30s (lebih lambat dari DeepSeek), 6x lebih mahal |
| **Kimi K3** (Moonshot AI) | Input $3.00 / Output $15.00 | **~$15.84 (± Rp 256.600/bulan)** | Long-horizon reasoning kelas frontier (Fable 5 class) dengan kontrol `reasoning_effort: low` | Biaya paling tinggi (30x DeepSeek) |

**Skenario Hybrid dicoba (GLM 5.2 khusus Call 1 + DeepSeek v4-flash untuk Call 2,3 & Auto-Entry):**

- Call 1 (Briefing Prosa, ~132 call/bulan) via GLM 5.2 = $0.84 (± Rp 13.600).
- Non-Call 1 (Call 2,3, Analisa & Auto-Entry, ~572 call/bulan) via DeepSeek = $0.38 (± Rp 6.070).
- Total Hybrid = **~$1.22/bulan (± Rp 19.680/bulan)**.
- **Penemuan utama:** Hybrid TIDAK lebih murah secara nominal (+Rp 11.550/bulan dibanding Full DeepSeek Rp 8.130/bulan). Namun secara *value-for-money*, Hybrid adalah kandidat upgrade arsitektur paling ideal: kualitas narasi briefing terbaik dari GLM 5.2 tanpa mengorbankan kepatuhan JSON & kecepatan Auto-Entry dari DeepSeek v4-flash, dengan total biaya tetap sangat murah (< Rp 20.000/bulan).

### Kalibrasi keyakinan berbasis outcome (eks "Tier 2", session 166)

Ikat badge keyakinan Analisa AI ke win-rate historis segmen serupa (pair + bias + rentang skor konfluensi) dari `setup_log:v1`, bukan self-assessment LLM. Prasyarat: sampel setup selesai cukup (indikatif ≥30 per segmen) — data sedang terakumulasi otomatis, cek berkala.

### Re-run backtest konfluensi berkala (`scripts/backtest_confluence.js`)

Angka bergerak antar-run (jendela 60 hari bergeser) — jalankan ulang tiap beberapa minggu dan bandingkan TREN, jangan kutip satu angka sebagai konstanta.

- **Run 2026-07-20 (Session 209, dengan breakdown rezim volatilitas via `computeVolatilityRegime`):** agregat global skor tinggi 918 zona, 369 sentuh (40%) → bounce 54% | break 22% | chop 24%; skor rendah 30 zona, 7 sentuh (23%) → bounce 57%. Kontrol rendah MASIH terlalu kecil (n sentuh tunggal digit) untuk klaim pembanding apa pun, dan run kali ini bounce rendah malah SETARA/lebih tinggi dari tinggi (beda dari run 2026-07-17 yang skor tinggi menang) — JANGAN disimpulkan sebagai "confluence tidak bekerja", cuma bukti n kontrol terlalu kecil untuk stabil antar-run. **Temuan breakdown rezim:** bounce-rate skor TINGGI stabil 51-54% di tenang/normal/bergejolak (54%/54%/51%) — tidak terlihat degradasi jelas di rezim bergejolak seperti dugaan awal. Perlu run lanjutan dengan rentang data lebih panjang (>60 hari, lintas tahun) sebelum ini jadi kesimpulan robust — 60 hari saat ini kemungkinan besar didominasi satu rezim pasar yang sama untuk urutan bulan tertentu.
- **Update 2026-07-22 (rigor statistik, respons riset Scopus AI — `scripts/_stats.js`):** dugaan "n kontrol terlalu kecil" di atas sekarang punya angka formal, bukan cuma feeling. Run ulang: skor tinggi 918 zona, 369 sentuh (40%) → bounce 55% [bootstrap 95% CI: 49,9%-59,9%]; skor rendah 32 zona, 7 sentuh (22%) → bounce 57% [95% CI: 28,6%-85,7%, SANGAT lebar karena n=7]. Permutation test beda observed -2,1 poin, **p=1,000**; Wilcoxon rank-sum z=-0,097, **p=0,891** — beda bounce-rate TINGGI vs RENDAH **BELUM signifikan secara statistik** pada n saat ini (CI kedua bucket tumpang tindih total). Per rezim juga tidak ada yang p<0,05 (tenang p=0,511; normal p=0,223; bergejolak p=1,000). **Kesimpulan: confluence zone BELUM terbukti prediktif secara statistik** — bukan berarti tidak bekerja, tapi klaim "zona skor tinggi lebih reaktif" masih hipotesis, bukan temuan established. Root cause utamanya kemungkinan besar n kontrol (RENDAH) yang kronis kecil (7 sentuh dari 60 hari data) — sampel TINGGI sudah cukup besar (n=369) tapi tidak menolong kalau pembandingnya masih terlalu kecil. Sebelum lanjut Tier 5 atau menaikkan bobot confluence di manapun, perlu perbesar n kontrol (rentang data lebih panjang dan/atau perlonggar ambang LOW_SCORE) supaya test punya daya (power) memadai.

### Backtest carry/yield differential (`scripts/backtest_carry.js`, dibuat 2026-07-20, Session 209)

Signal bulanan dari differential yield 10Y nominal (proxy carry — BUKAN short rate/kebijakan asli, itu tidak tersedia gratis via FRED) EUR/GBP/AUD/JPY vs USD, dibanding kontrol Buy&Hold + Anti-Carry. **BELUM dieksekusi** — butuh `FRED_API_KEY` (tidak ada di `.env.local` lokal sesi ini). Jalankan: `FRED_API_KEY=xxx node scripts/backtest_carry.js`.

### Ide/catatan riset ringan lain (belum jadi plan)

- **Seasonality bulanan/mingguan per pair** — hitung offline dari data Daily yang sudah ada di Redis; 0 AI call. Sajikan sebagai konteks, bukan sinyal.
- **Bobot lebih untuk posisi harga vs option expiry besar H-1** — datanya sudah ada, belum diberi peran di scoring.
- **Carry trade / currency crash risk** — masih tahap riset literatur, BELUM diverifikasi ke sumber primer; jangan dieksekusi sebelum itu (lihat juga catatan "Ditahan" Plan G).

### [2026-08-19] Antisipasi Pump Meme Coin — DIPINDAH ke proyek terpisah

Riset lengkap (base rate, sinyal pre-pump akademis, arsitektur sistem deteksi) semula ditulis di sini sebagai eksplorasi lintas-domain, sekarang dipindah penuh ke proyek terpisah **Daun_Merah_Crypto** (`C:\Users\sam\Documents\kerja\Daun_Merah_Crypto\Dokumentasi\daun_merah_crypto_riset.md` + `daun_merah_crypto_referensi_riset.md`) sesuai keputusan user 2026-08-19 — asset class beda total dari FX/Gold, proyek & repo git sendiri. Baca di sana untuk detail lengkap.

### Roadmap Data Feed & Infra Always-On (hasil diskusi + verifikasi live session 186, 2026-07-18 — menggantikan ide lama "MT5 + Free VPS" session 185)

**Urutan disepakati:**
1. Promosi DeepSeek flash.
2. Fase A: candle on-demand di Vercel (sumber baru, Yahoo jadi fallback).
3. Fase B: daemon VPS event-driven (streaming harga → Redis, alert berita high-impact <1 menit, alert harga-sentuh-level saat app tertutup; semua via web-push existing).

Prinsip: VPS = penambah, bukan tulang punggung — heartbeat di Redis, UI tampilkan umur data, auto-fallback ke tarik-langsung kalau daemon diam.

**MT5: DICORET.** Terminal Windows/Wine di Linux = rapuh; dan akun demo OANDA user ternyata entitas "OANDA Global Markets" (MT5-only, login portal ditolak) → API v20 OANDA TERTUTUP untuk pendaftar Indonesia (verified live 2026-07-18, developer.oanda.com: v20 hanya untuk akun fxTrade).

**Pengganti TERVERIFIKASI LIVE (2026-07-18, tanpa akun):** Deriv API (`ws.derivws.com`, WebSocket) — `active_symbols` mengonfirmasi SEMUA 15 pair Daun Merah ada (termasuk frxGBPAUD, frxGBPCAD, frxXAUUSD "Gold/USD"), dan `ticks_history style:candles granularity:3600` mengembalikan OHLC H1 nyata tanpa autentikasi (app_id publik 1089; untuk produksi daftar app_id sendiri — gratis). Cocok untuk Fase A (WS pendek dari Vercel) DAN Fase B (streaming). Kandidat sumber kedua: Twelve Data (REST, free tier, forex+XAU — limit pastinya cek saat signup, indikatif 800 credit/hari 8/menit).

**VPS:** user sudah daftar + pesan VPS gratis CepatCloud.id (2026-07-18, menunggu aktivasi — review forum: pendaftaran kadang tidak diproses, no technical support, IPv4 private saja [cukup, daemon hanya butuh koneksi keluar]). Kalau aktif: uji heartbeat 1-2 minggu dulu TANPA token apa pun, baru daemon naik. **Plan B HF Spaces GUGUR** (2026-07-18, dicek langsung di huggingface.co/new-space): Docker/Gradio Space kini butuh plan PRO berbayar, free tier tinggal Static (tanpa compute) — info "16GB gratis" di riset Sesi 185 & Gemini SUDAH BASI. Plan B baru: Render free (Docker, tanpa kartu) + pinger cron-job.org 10 menit vs spin-down 15 menit; Cloud Run DITOLAK (butuh kartu + serverless membekukan koneksi WS antar-request, ping tidak menolong), Koyeb perlu verifikasi (kartu? kuota bulanan habis = mati sisa bulan). Alternatif lain: Oracle Always Free (butuh kartu) / VPS murah / tunda Fase B.

**GH Actions:** repo PRIVATE = menit terbatas & cron sering telat (bukti 2026-07-18: run digest terjadwal 00:00 UTC jalan 03:16 dan gagal) — JANGAN tambah frekuensi cron (saran Gemini ditolak); arah justru pensiunkan ohlcv-sync/ta-warm setelah Fase B jalan.

---

## Pembelajaran Proyek

- **Unit test hijau bukan bukti fitur benar.** Bug skala ADP (seri berunit orang vs ribuan) dan filter Inside Bar `mr_co1` hanya ketahuan saat verifikasi data live production, bukan dari test. Selalu uji dengan data/deploy nyata sebelum menyimpulkan. (S154, S180)
  **Varian baru (S204, 2026-07-20):** pure-function unit test bisa hijau terus-menerus padahal PEMANGGILNYA salah — `_formatTrackRecordBlock(log, symbol)` diuji dengan mock yang symbol-nya sengaja konsisten di kedua argumen, sementara kode produksi memanggilnya dengan `data.label` (bukan `symbol`), membuat filter gagal total sejak session 180. Baru ketahuan lewat test end-to-end yang benar-benar memeriksa payload prompt asli. Pure-function test WAJIB didampingi ≥1 test integrasi yang memverifikasi pemanggil pakai argumen yang benar, bukan cuma fungsinya sendiri benar.
- **Masalah model gratis = reliability, bukan kualitas.** Nemotron 3 Ultra outputnya bagus (0 pelanggaran frasa) tapi latency 7-41 detik tak terprediksi → didemote. Memperbaiki struktur input/output (fact sheet deterministik) berdampak jauh lebih besar daripada ganti-ganti model. (S162, S180)
- **Baca ToS sumber primer SEBELUM menulis kode.** NVIDIA API Trial melarang eksplisit penggunaan produksi — ketahuan di desk research dari PDF resmi (bukan artikel pihak ketiga), menghemat seluruh siklus uji live yang hasilnya tidak akan bisa dipakai. (Plan N, 2026-07-18; precedent: Kimi K2.6 403, S144)
- **Korupsi di luar tag `<script>` lolos semua lapis test.** Teks nyasar sebelum `<!DOCTYPE html>` tampil sebagai "judul palsu" di semua tab dan tidak tertangkap parse-check maupun `npm test`. Mitigasi: test integritas statis (Plan M3). (S181)
- **Timeout client harus lebih panjang dari timeout server.** Root cause NEWS mobile gagal: client abort sebelum server `maxDuration` selesai — pola yang sama bisa menular ke endpoint lain kalau tidak diperiksa saat menambah fitur lambat. (S161)
- **Env var Sensitive di Vercel selalu terbaca kosong via `vercel env ls/pull`.** Itu bukan bukti var tidak ter-set — verifikasi harus FUNGSIONAL (call kecil yang memakai key-nya). (S163+, terbukti lagi di Plan N saat konfirmasi nama var aktual)
- **File `.env*` bisa menyimpan value dengan tanda kutip literal di sekitarnya** (`KEY="isi"`) — `.trim()` saja tidak menghapus kutip itu, cuma whitespace. Kalau value dipakai sebagai header/token ke request nyata, kutip ikut terkirim dan diam-diam gagal match tanpa error jelas (bukan 401, cuma jatuh ke jalur tanpa-auth). Selalu strip kutip eksplisit saat parsing manual file env di luar dotenv. (Plan U-6, 2026-07-20 — call `auto=1` uji senyap sempat false-negative karena ini sebelum ketahuan & diperbaiki)
- **PWA bisa nyangkut di versi lama berhari-hari.** Auto-reload hanya terpicu perubahan byte `sw.js`; fix `index.html`-only tidak pernah sampai ke device yang tidak di-force-close — sebelum menyimpulkan "belum difix", pastikan versi yang dilihat user memang versi terbaru. Mitigasi permanen: probe versi Plan M3. (S179, S48b)
- **Keyword list klasifikasi berita sengaja statis, bukan adaptif.** `POSREVIEW_CURRENCY_KEYWORDS` & kategori `newscat.js` murni daftar kata kunci tetap (bukan AI/adaptif) karena gerbang pre-entry harus cepat & deterministik — konsekuensinya butuh maintenance manual tiap ada skenario makro baru yang belum tercakup (contoh nyata: linkage minyak→emas baru ditambahkan S219 dipicu kasus Iran-Gulf). Kategori generik konflik (`military`/`attack*`/dst) relatif tahan lama; `POSREVIEW_CURRENCY_KEYWORDS` (relevansi kausal berita→mata uang) jauh lebih rapuh dan perlu direview tiap ada kasus makro baru yang lolos tanpa terdeteksi. (S219, S220)
- **Tab Artikel bagian Akademik & Riset (Scopus-FX/LLM, NBER, RePEc-IFN) headline-only by design — jangan diharapkan langsung actionable.** Triase penuh 25 item batch 2026-08-17 (dipicu user kirim 1 PDF via fitur artikel, lalu minta cek seluruh kategori Akademik & Riset): 0 dari 25 menghasilkan rekomendasi kode/fitur baru. Pola kegagalannya dua macam — (1) metodologi lemah tapi topik pas (paper Aşırım dkk. LSDE/RLS klaim >60% reduksi error prediksi FX TANPA baseline random-walk, lihat `daun_merah_referensi_riset.md` §1 catatan kritis), atau (2) metodologi solid tapi domain/horizon tidak match (mis. "regime-aware portfolio LLM" ternyata portofolio 50-saham S&P bukan single-pair FX; "Exchange Rates, Structural Change, Productivity Growth" NBER ternyata horizon struktural puluhan tahun, bukan horizon setup Daun Merah). **Implikasi:** jangan asumsikan "ada di tab Akademik & Riset" = "relevan/terverifikasi" — tetap wajib baca abstrak/full-text dan cek baseline/domain match sebelum dipercaya, sama seperti sitasi manual di `daun_merah_referensi_riset.md`. Feed ini nature-nya rotating (cache 6 jam, isi ganti tiap hari), jadi item spesifik hari itu tidak dicatat permanen di sini — polanya yang dicatat.
- **Tool/model forecasting baru tidak otomatis membuka kembali proyek yang di-stop karena tidak ada sinyal.** User tanya (2026-09-02) apakah TimesFM (Google Research, foundation model transformer untuk time-series forecasting) memberi "harapan" untuk proyek NFP causal (`project_delay/machine learning/ml/NFP_PROYEK`, STOP final karena kill-gate gagal 0/25 — lihat memory `nfp-causal-research-framework`). Kesimpulan: TIDAK qualify sebagai "metode berbeda fundamental" yang jadi syarat buka-ulang. Alasan: kegagalan proyek itu adalah masalah *tidak ada sinyal prediktif* yang lolos uji permutasi (konsisten literatur Klein 2022 — konsensus pasar sudah efisien), bukan masalah *model forecasting kurang canggih*. TimesFM juga mismatch bentuk soal (autoregressive continuation vs uji hubungan sebab-akibat lintas-indikator dengan permutation test) dan mismatch skala data (pretrained data frekuensi tinggi vs panel bulanan n~342). **Implikasi:** saat mengevaluasi tool/model baru terhadap proyek yang sudah di-stop, cek dulu apakah alasan stop itu soal kapabilitas model atau soal ketiadaan sinyal di data — kalau yang kedua, model baru secanggih apa pun kemungkinan besar tidak menolong.

---

## Riset Provider AI Baru: Gemini / Mistral / NVIDIA NIM (2026-07-18)

> Eksekusi Plan N (`daun_merah_plan.md` bagian N). Tujuan: cari kandidat gratis baru untuk Call 1/2/3 Ringkasan yang lebih stabil dari saga Nemotron/GLM/Qwen (lihat memory proyek).
> Env var Vercel aktual (dikonfirmasi `vercel env ls`, BUKAN nama tebakan di plan): `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY` (bukan `NVIDIA_NIM_API_KEY`).

### Tahap 0 — Desk Research

| | Gemini (AI Studio) | Mistral (La Plateforme) | NVIDIA NIM (build.nvidia.com) |
|---|---|---|---|
| Endpoint OpenAI-compatible | `generativelanguage.googleapis.com/v1beta/openai/` | `api.mistral.ai/v1` | `integrate.api.nvidia.com/v1` |
| Model kandidat Call 1 (prosa) | `gemini-2.5-flash` (10 RPM/1.500 RPD) atau `gemini-2.5-flash-lite` (15 RPM/1.000 RPD) | `mistral-medium-3.5-26.04` (frontier, agentic) atau `mistral-small-4-0-26-03` | model DeepSeek yang di-host NIM (cek daftar model saat eksekusi Tahap 2 — endpoint `/v1/models`) |
| Limit resmi (indikatif, BUKAN dari akun user) | Flash: 10 RPM / 250K TPM / 1.500 RPD. Flash-Lite: 15 RPM / 250K TPM / 1.000 RPD. **Per PROJECT**, bukan per key | Tier "Experiment": ±1 miliar token/bulan, RPS tidak dipublikasi resmi lagi (estimasi non-resmi 1-5 RPS) — wajib cek Admin Console → Limits saat eksekusi, jangan pakai angka riset ini sebagai kepastian | 40 RPM baseline (bisa apply upgrade ke 200 RPM). Bukan sistem kredit-habis-sekali untuk hosted catalog gratis — dibatasi RPM, bukan kredit |
| JSON mode native | Ya — `response_format` didukung | Endpoint OpenAI-compatible umumnya mendukung `response_format` — verifikasi saat implementasi | Tergantung model — banyak NIM model OpenAI-compatible mendukung `response_format` |
| **ToS produksi** | Free tier BOLEH dipakai (bukan cuma evaluasi), TAPI prompt/output dipakai Google untuk training + human reviewer bisa membaca isi prompt (dikonfirmasi `ai.google.dev/gemini-api/terms`). Isi prompt proyek ini = berita pasar publik, tidak sensitif → **diterima** | Ambigu — ToS komersial tidak eksplisit melarang produksi di tier gratis, tapi klausul training-data menyebut data pada free subscription dipakai untuk training kecuali opt-out. Tidak ditemukan larangan produksi eksplisit → **BOLEH dicoba, catat sebagai fallback-risiko-training-data** | **DILARANG EKSPLISIT.** PDF resmi *NVIDIA API Trial Terms of Service* (v. 19 Sep 2025) §1.2 & §1.4: akses hanya untuk *"limited trial purposes"*, **tanpa penggunaan produksi** kecuali beli Subscription |

**Keputusan gate awal (sebelum satu baris kode pun ditulis):** NVIDIA NIM TIDAK BISA di-PROMOTE ke chain produksi, apapun hasil tesnya — ToS resmi melarang eksplisit "not in production" untuk yang belum beli Subscription berbayar. Ini larangan kontraktual jelas, bukan risiko/probabilitas seperti kandidat lain. NVIDIA turun status jadi riset/dokumentasi saja sebelum Tahap 1 dimulai — TIDAK dilanjutkan ke uji live 5-sampel (Tahap 3). Kode diagnostik `?test_nvidia=1` tetap dibuat (murah, konsisten pola kandidat lain yang ditolak) untuk jaga-jaga kalau NVIDIA suatu saat merilis tier produksi gratis, tapi TIDAK dijalankan sebagai bagian gate promosi.

Gemini & Mistral: lanjut ke Tahap 1-4 sesuai plan.

### Tahap 1 — Verifikasi Fungsional Key

Dites live 2026-07-18 via `?test_gemini=1` / `?test_mistral=1` / `?test_nvidia=1` di `financial-feed-app.vercel.app/api/market-digest` (jalur diagnostik terisolasi, TIDAK menimpa `latest_article`):

- **Gemini** — key valid. Model awal `gemini-2.5-flash` → HTTP 404 (generasi model sudah bergeser ke Gemini 3.x per riset ulang saat itu). Diganti alias resmi `gemini-flash-latest` (hot-swap otomatis, resolve ke `gemini-3.5-flash`) → OK. Masalah kedua: `finish_reason=length` dengan output cuma 109 karakter di percobaan pertama — Gemini 3.x selalu "thinking" (tidak bisa dimatikan total, beda dari 2.5 yang bisa `reasoning_effort:'none'`), budget token 1300 habis untuk reasoning trace. Fix: `reasoning_effort:'low'` + `max_tokens` naik ke 3000 → OK, output 2.900-3.100 karakter konsisten setelahnya.
- **Mistral** — key valid, model `mistral-medium-latest` sukses di percobaan PERTAMA, tanpa perlu iterasi.
- **NVIDIA NIM** — key valid (tidak pernah dapat error auth), TAPI 3 model id dicoba (`deepseek-ai/deepseek-v3.2`, `deepseek-ai/deepseek-v3.1`, `deepseek-ai/deepseek-v3.1-terminus` — id terakhir dikonfirmasi dari `docs.api.nvidia.com/nim/reference/`) semuanya HTTP 404 (~40ms, kemungkinan ditolak di layer gateway/routing sebelum sampai model backend, bukan auth/network gagal). **Tidak diselidiki lebih lanjut** — NVIDIA sudah REJECT permanen by ToS, jadi menyelesaikan model id yang benar tidak mengubah keputusan promosi apapun hasilnya. Kalau suatu saat NVIDIA membuka tier produksi gratis dan riset ini dibuka kembali, cek daftar model AKTUAL via `GET /v1/models` dengan key asli (butuh akses key plaintext yang tidak tersedia dari sesi eksekusi ini).

### Tahap 2 — Tier Diagnostik Call 1

Ditambahkan di `api/market-digest.js`: `?test_gemini=1`, `?test_mistral=1`, `?test_nvidia=1` (pola persis `?test_nemotron=1`, `isIsolatedTest` — hasil TIDAK ditulis ke `latest_article`).

### Tahap 3 — Sampel Live Call 1

**STATUS: SELESAI (2026-07-18). Gemini dipromosikan (PROMOTE) sebagai fallback di Call 1/2/3, Mistral dan NVIDIA NIM ditolak (REJECT).**

**Gemini (`gemini-flash-latest`, 6 sampel Call 1):**

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

**Mistral (`mistral-medium-latest`, 4 sampel Call 1):**

| # | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| 1 | 6.6s | Ya | 1.578c | 0 | ID penuh | |
| 2 | 11.8s | Ya | 1.656c | 1 ("di tengah") | Campur | "Fed's Hammack" (posesif Inggris) |
| 3 | 13.1s | Ya | 1.916c | 0 | Campur | "Fed's Hammack" lagi |
| 4 | 7.6s | Gagal | 925c | 0 | ID penuh | **Format Failure:** FX di-skip total, hanya menulis bagian XAUUSD tanpa header |

**NVIDIA NIM (1 sampel per model, Call 1):**

| Model | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 20.9s | Gagal | 1.733c | 0 | ID penuh | **Format Failure:** Bagian FX dilewatkan total, hanya menulis ulasan XAU/USD |
| `deepseek-ai/deepseek-v4-flash` | 24.1s | Ya | 2.915c | 2 ("di tengah", "sejalan dengan") | ID penuh | Ulasan FX dan XAU/USD sangat lengkap dan tajam. Namun latency kritis dekat timeout |

**Evaluasi:**
- **Nemotron 3 Ultra:** Mengalami kegagalan format kritis dengan mengabaikan bagian FX sepenuhnya (mirip seperti Mistral). Latency 20.9s terlalu dekat batas timeout 25s.
- **DeepSeek v4 Flash:** Kualitas prosa dan struktur analisisnya sangat luar biasa (mengulas EUR/USD, GBP/USD, USD/JPY, AUD/USD, dan XAU/USD secara tajam dan runut). Namun, latency mencapai 24.1s (sangat riskan mengalami timeout Vercel yang dipotong di 25s) dan membocorkan 2 frasa terlarang.

### Tahap 6 — Keputusan Final (2026-07-18)

- **Gemini (gemini-flash-latest): PROMOTE** ke chain produksi sebagai Fallback 2 di Call 1 (di antara Cerebras gpt-oss dan Groq) dan Fallback 1 di Call 2 & Call 3 (di antara SambaNova dan Groq karena mendukung JSON mode native `response_format`).
  *Pelajaran penting:* Gemini 3.x selalu "thinking" dan tidak bisa dinonaktifkan. Selalu set `max_tokens` minimal 2500-3000 untuk Call JSON agar tidak terpotong (truncated) di tengah jalan, serta kirim parameter `reasoning_effort: 'low'`.
- **Mistral (mistral-medium-latest): REJECT.** Gagal format (mengabaikan instruksi FX) dan gagal JSON Call 3 (HTTP 400).
- **NVIDIA NIM: REJECT.**
  - *Hambatan Hukum:* Ketentuan Layanan (Terms of Service) trial melarang penggunaan di produksi.
  - *Hambatan Teknis:* Latency sangat tinggi (20.9s–24.1s) yang mendekati batas maksimal timeout Vercel 25s, sehingga tidak andal sebagai fallback yang stabil. Nemotron juga gagal format (mengabaikan FX). DeepSeek v4 Flash sangat baik dari segi konten, namun latency 24.1s dan leak kata terlarang menggugurkannya sebagai kandidat produksi.

---

## Riset Sesi 185 — Polishing Chain AI & VPS/Data Gratis (2026-07-18)

### 0. Hasil tes live DeepSeek v4-flash vs V3.2 (Session 186, 2026-07-18)

Follow-up langsung dari ide #1 di bawah. User top-up US$2 (saldo top-up TIDAK expire), tes via `?test_deepseek=1` (jalur terisolasi baru, pola Plan N) — 3 sampel flash + 2 sampel V3.2 (SambaNova) dari data berita yang sama. Detail penuh di changelog `daun_merah.md` Session 186.

- **Kualitas:** flash unggul — FX per-pair lengkap 3/3 sampel + lebih padat angka (skew, CFTC, level), V3.2 kedapatan menipiskan bagian FX 1/2 sampel. Leak frasa terlarang setara.
- **Latency:** setara dan sama-sama bervariasi (flash 7.5-23.1s, V3.2 6.3-21.4s).
- **Biaya nyata:** 3 generate penuh = US$0.01 (verifikasi endpoint `user/balance`). Proyeksi cron 3x/hari 3 bulan ≈ US$0.90 → saldo $2 cukup untuk flash primary market-digest 3 bulan.
- **Catatan pra-promosi:** thesis Call 3 null 1/3 sampel (perlu cek log saat terulang); outlier 23.1s dekat timeout 25s. Pagar biaya sudah dipasang: `_ai_guard.js` deepseek=50/hari.
- **Status waktu itu: belum dipromosikan — menunggu keputusan user.** Ide GLM-5.2-via-NIM sebagai copywriter (ide #1) tetap GUGUR untuk produksi (ToS NIM, lihat Keputusan Gate Awal Plan N).

### 1. Polishing Chain: DeepSeek v4 Pro + GLM-5.2

- **Ide:** Memisahkan peran AI. **DeepSeek v4 Pro** (API Resmi) sebagai *Data Analyst* (sangat cerdas logikanya untuk menghitung angka teknikal Entry/SL/TP). Hasilnya dikirim ke **GLM-5.2** (NVIDIA NIM) sebagai *Copywriter* untuk ditulis ulang menjadi Bahasa Indonesia yang luwes dan natural (karena bakat linguistik alami GLM-5.2 sangat tinggi).
- **Keuntungan:** Mendapatkan ulasan trading dengan data presisi tinggi sekaligus bahasa yang natural.
- **Hambatan Latency:** Akumulasi waktu pengerjaan 2 model berurutan mencapai 20–25+ detik (DeepSeek ~6s + GLM-5.2 ~15s). Ini pasti memicu Gateway Timeout di Vercel, sehingga wajib dijalankan secara Asinkron (Background Job di GitHub Actions) atau di-host di VPS always-on.
- **Alternatif:** Prompt Engineering pada DeepSeek v4 Pro (Few-Shot) dengan memberikan contoh teks GLM-5.2 agar ditiru secara langsung dalam satu kali panggilan (menghemat waktu & token).

### 2. Provider Data Real-time & Gratis

- **MT5 (MetaTrader 5) Broker Demo Account (Rekomendasi Utama):** Menghubungkan script backend ke terminal MT5 dengan akun demo gratis broker Forex retail. Ini menyediakan data feed harga & candle (OHLCV) yang 100% real-time milidetik, gratis selamanya, legal, bebas rate-limit, dan harganya dijamin presisi 100% sama dengan platform trading.
- **Finnhub.io:** Opsi API WebSocket gratis instan, namun rentan rate-limit jika dinyalakan 24 jam non-stop.

### 3. Layanan VPS Gratis Always-On (Tanpa Kartu Kredit)

- **CepatCloud.id:** VPS Linux murni gratis selamanya (1 vCPU, 2GB RAM) khusus untuk developer Indonesia. Hanya butuh verifikasi Email & WhatsApp.
- **Hugging Face Spaces (Docker SDK):** ~~Container virtual gratis 2 vCPU/16GB~~ **BASI — per 2026-07-18 Docker/Gradio Space butuh plan PRO berbayar (verified langsung di halaman new-space); free tier tinggal Static tanpa compute.**
