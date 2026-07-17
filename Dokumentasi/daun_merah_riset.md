# Riset: Membuat AI Analisa "Lebih Pintar Baca Pasar" — Peta Jalan Sampai Mentok

> Ditulis session 166 (2026-07-14) atas permintaan user: "cari tau lagi potensi yang bisa
> bikin AI pintar lagi sampai mentok". Dokumen keputusan/rujukan — bukan plan eksekusi.
> Kalau salah satu tier mau dikerjakan, buat plan terpisah di `daun_merah_plan.md`.

## Batas fundamental yang tidak bisa ditembus (baca dulu)

1. **LLM (DeepSeek-V3.2 dkk) adalah model bahasa, bukan model prediksi harga.** Dia pintar
   mengaitkan dan menarasikan angka yang DIBERIKAN, tapi tidak pernah belajar dari histori
   pergerakan harga sungguhan. Ganti model sekuat apapun tidak mengubah sifat ini.
2. **Market itu probabilistik.** Sinyal apapun (AI atau analis manusia) pasti salah sebagian
   waktu. Target yang realistis: edge kecil yang konsisten + risk management ketat (sudah
   ada di app: sizing, checklist, RR gate) — bukan "tidak pernah keliru".
3. **Referensi historis proyek ini sendiri:** riset NFP causal (Fase 1, session 153) gagal
   0/25 — bukti internal bahwa "menebak arah dari data publik" itu memang sulit. Jangan
   ulangi ekspektasi yang sama di fitur Analisa.

Dengan plafon itu, di bawah ini yang MASIH BISA diusahakan, diurutkan dari ROI tertinggi.

## Tier 1 — Track record / outcome logging (ROI paling tinggi, belum ada sama sekali)

**Masalah:** setiap hasil Analisa AI hilang begitu saja. Tidak ada yang tahu — termasuk kita —
apakah rekomendasinya lebih sering benar atau salah. Label "keyakinan tinggi" murni
self-assessment LLM tanpa dasar historis.

**Yang dibangun:**
- Setiap `ohlcv_analyze` yang menghasilkan setup lengkap (entry/sl/tp) → tulis snapshot ke
  Redis list/stream: `{symbol, bias, entry, sl, tp, rr, confluence_score, ts}`.
- Cron harian (GitHub Actions, tanpa AI call — murni baca harga Yahoo yang sudah di-sync)
  mengecek tiap setup terbuka: harga menyentuh TP duluan, SL duluan, atau expired
  (lewat `time_horizon_days` tanpa kena keduanya).
- Agregasi win-rate per pair / per bias / per skor konfluensi → tampilkan di UI.

**Biaya:** 0 AI call tambahan. Hanya storage Redis kecil + 1 cron ringan.
**Hasil:** angka akurasi NYATA ("dari 100 saran XAU/USD, 54 kena TP") — fondasi semua tier lain.

## Tier 2 — Kalibrasi keyakinan & gate kualitas

Bergantung pada Tier 1 (butuh data outcome).
- Badge keyakinan diikat ke win-rate historis segmen serupa (pair + bias + rentang skor
  konfluensi), bukan klaim LLM.
- Gate: sembunyikan setup kalau skor konfluensi < ambang ATAU RR < 1.5 (sekarang baru RR ≥ 1
  di sanity-check server) — `entry_zone: null` + alasan, lebih jujur daripada setup lemah.
- Kalau win-rate segmen tertentu terbukti < ~45% dalam jangka panjang → tampilkan peringatan
  eksplisit di UI untuk segmen itu (atau matikan setup otomatisnya).

**Biaya:** 0 AI call tambahan.

## Tier 3 — Backtest zona konfluensi (bisa jalan duluan, offline)

Data 6 bulan Daily + 10 hari 4H + 5 hari 1H per pair sudah ada di Redis (`ohlcv_sync`).
- Replay historis: untuk tiap titik waktu t di masa lalu, hitung `_confluenceZones` dari data
  sampai t, lalu ukur: seberapa sering harga BEREAKSI (memantul/menembus lalu retest) di zona
  skor tinggi vs level acak?
- Murni komputasi lokal / script Node — **0 AI call, 0 biaya**, bisa dites di test runner.
- Hasilnya memvalidasi (atau membantah) asumsi inti fitur Analisa: "konfluensi = area reaksi".
  Kalau terbukti tidak prediktif, semua tier lain perlu dipikir ulang — makanya ini layak
  dikerjakan awal.

### HASIL (dijalankan via `scripts/backtest_confluence.js`)

**Run 2026-07-17** (4 pair, 60 hari 1H, 177 titik evaluasi, jendela sentuh 48 jam,
jendela reaksi 12 jam, ambang gerak 0.3x ATR Daily):

| Bucket | Zona | Tersentuh | Bounce | Break | Chop |
|---|---|---|---|---|---|
| Skor TINGGI (≥3) | 927 | 376 (41%) | **55%** | 22% | 24% |
| Skor RENDAH (≤1.5) | 30 | 7 (23%) | 57% | 29% | 14% |

Per pair (bounce-rate zona tinggi): XAU/USD 59% (91 sentuh), EUR/USD 59% (95),
USD/JPY 53% (86), GBP/USD 47% (104).

**Interpretasi jujur:**
1. **Yang valid:** di zona skor tinggi, bounce (55%) mengalahkan break (22%) ~2.5:1 —
   zona konfluensi memang lebih sering jadi area pantulan daripada tembusan. Asumsi
   "konfluensi = area reaksi" DIDUKUNG dalam arti ini.
2. **Yang TIDAK bisa diklaim:** perbandingan "skor tinggi vs rendah" tidak konklusif —
   kontrol skor rendah cuma 30 zona / 7 sentuhan (ranking top-3 by skor memang jarang
   meloloskan zona lemah, cacat desain kontrol). Klaim changelog session 167 ("68% vs
   50%, sangat positif") berasal dari run jendela sebelumnya dan TERLALU OPTIMIS —
   angka run terbaru lebih rendah (55%) dan kontrolnya terlalu kecil untuk dibandingkan.
3. **Catatan GBP/USD** paling lemah (47%) — kalau nanti track record live (Tier 1)
   juga konsisten lemah di pair ini, pertimbangkan peringatan khusus di UI.
4. **Angka bergerak antar-run** karena jendela 60 hari bergeser — jangan kutip satu
   angka sebagai konstanta; jalankan ulang berkala (gratis) dan bandingkan tren.

## Tier 4 — Ensemble / cross-check dua model (selektif, bukan tiap request)

- Jalankan model kedua (mis. Cerebras gpt-oss-120b yang sudah terpasang sebagai fallback)
  HANYA saat momen penting (menjelang entry riil, bukan tiap klik).
- Sepakat (bias & zona sama) → sinyal lebih kuat; beda jauh → pasar ambigu, itu sendiri
  informasi ("jangan entry").
- **Biaya:** +1 AI call per pemakaian — jadikan tombol manual terpisah ("second opinion"),
  bukan otomatis, supaya hemat kuota.

## Tier 5 — Data baru yang benar-benar menambah informasi (marginal, paling akhir)

Sudah dipakai: OHLCV multi-TF, indikator, struktur/swing/BOS, S/R cluster, fib, pivot,
option expiry, CB bias, COT, risk regime, retail sentiment, options RR/CVOL, konteks makro
artikel. Yang tersisa dan realistis gratis:
- **Seasonality bulanan/mingguan** per pair (hitung sendiri dari data Daily historis — offline).
- **Volatility regime** (percentile ATR vs 6 bulan) sebagai konteks "market lagi tenang/liar".
- **Posisi harga vs option expiry besar H-1** (sudah ada datanya, bisa diberi bobot lebih).
Yang TIDAK realistis di stack gratis: order flow/depth sungguhan, positioning bank, data tick.

## Yang secara sadar TIDAK direkomendasikan

- **Fine-tuning / training model sendiri** — butuh data label outcome bertahun-tahun,
  infra GPU, dan hasilnya belum tentu mengalahkan confluence-scorer sederhana. Jauh melebihi
  skala proyek ini.
- **Menambah lagi jumlah indikator ke prompt** — prompt sudah padat; masalahnya bukan
  kurang data, tapi belum ada feedback loop (Tier 1). Data berlebih = noise (kekhawatiran
  user soal "catatan kebanyakan" valid di sini).
- **Model "lebih besar" sebagai solusi tunggal** — sudah dibuktikan berkali-kali di proyek
  ini (saga Nemotron, GLM, Qwen): ganti model efeknya kecil dibanding memperbaiki struktur
  input/output.

## Urutan eksekusi yang disarankan

1. Tier 3 (backtest offline — validasi asumsi, gratis, tanpa risiko produksi)
2. Tier 1 (outcome logging — mulai kumpulkan data secepatnya, makin lama makin berharga)
3. Tier 2 (kalibrasi — setelah data Tier 1 terkumpul minimal ~1-2 bulan)
4. Tier 4 (second opinion manual — kapan saja, murah)
5. Tier 5 (data tambahan — hanya kalau Tier 3 membuktikan konfluensi memang prediktif)

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

(diisi saat eksekusi — lihat hasil di bawah)

## Tahap 2 — Tier Diagnostik Call 1

Ditambahkan di `api/market-digest.js`: `?test_gemini=1`, `?test_mistral=1`, `?test_nvidia=1`
(pola persis `?test_nemotron=1`, `isIsolatedTest` — hasil TIDAK ditulis ke `latest_article`).

## Tahap 3 — Sampel Live Call 1

(diisi progresif — lihat tabel di bawah per provider)

## Tahap 6 — Keputusan Final

(diisi setelah gate Tahap 3/4/5 cukup sampel)
