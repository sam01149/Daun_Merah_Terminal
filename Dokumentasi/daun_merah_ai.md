# Daun Merah — Pemakaian AI (Referensi Lengkap)

> **Dibuat:** 2026-07-11 (session 157)
> **Tujuan dokumen:** satu tempat untuk menjawab "fitur AI apa saja yang ada, dipanggil pakai model/provider apa, dan paling banyak dipakai berapa kali sehari" — supaya kalau ada laporan "AI error/limit habis", tinggal buka file ini dulu sebelum ngoprek kode.
> **Vendor & non-AI infra:** lihat [daun_merah_vendor.md](daun_merah_vendor.md).
> **Riset perbandingan provider (kenapa provider ini yang dipilih):** lihat [daun_merah.md § Research: Free AI Inference API Providers](daun_merah.md#research-free-ai-inference-api-providers-2026-05-28).

---

## 1. Cara baca dokumen ini (ringkas dulu, baru detail)

Aplikasi ini punya **4 fitur yang memanggil AI**. Semuanya pakai model gratis (tidak ada provider berbayar per-token), tapi "gratis" itu tetap ada plafonnya — baik dari provider aslinya (Groq, Cerebras, dst) maupun dari **jatah harian buatan sendiri** (`api/_ai_guard.js`) yang dipasang supaya satu fitur nakal (loop bug, di-spam) tidak menghabiskan kuota gratis punya fitur lain.

Ada 2 lapis pembatas yang perlu dibedakan:

1. **Pembatas provider asli** (di luar kontrol kita) — misal Groq cuma kasih sekian request per menit. Ini hard limit, kalau kelewat provider yang menolak (HTTP 429).
2. **Pembatas buatan sendiri** (`_ai_guard.js` + rate limit per-IP + cooldown tombol) — sengaja dipasang **di bawah** limit resmi provider, supaya selalu ada jarak aman. Ini yang paling sering jadi penyebab "AI tidak tersedia" kalau kepakai berlebihan, BUKAN provider aslinya yang menolak.

---

## 2. Peta 5 Fitur AI

| # | Fitur | Tombol di UI | Dipicu otomatis? | Cache | Rate limit server |
|---|-------|--------------|-------------------|-------|--------------------|
| 1 | **Ringkasan Berita** (briefing FX + bias bank sentral + thesis + alert) | "Ringkas Berita" / "Ringkas Ulang" | Ya — 3×/hari (cron) | Tidak ada cache untuk generate baru; hasil terakhir disimpan untuk mode baca cepat | 4 request/menit/IP + single-flight lock global 55 detik (lihat §3.1) |
| 2 | **Analisa AI per Pair** (komentar + level entry/SL/TP teknikal per pasangan mata uang) | "Analisa AI" (per pair, termasuk XAU/USD) | Ya — XAU/USD saja, 3×/hari (nempel di cron #1) | Tidak ada cache sebelum generate (selalu fresh tiap klik); hasil disimpan 6 jam untuk auto-tampil | 5 request/menit/IP |
| 3 | **Analisa Fundamental** (ringasan kondisi fundamental semua mata uang) | "Analisa Fundamental" | Tidak | **6 jam, GLOBAL** (satu cache untuk semua orang — lihat §4.3) | 5 request/menit/IP |
| 4 | **AI Coach Jurnal** (analisis pola menang/kalah dari trade yang sudah closed) | "Analisis AI" di tab Jurnal | Tidak | 1 jam per device, ada tombol "paksa ulang" | 30 request/menit/IP (endpoint jurnal secara umum) |
| 5 | **Pre-Entry Check** (Plan R, 2026-07-18 — verdict LAYAK/TIDAK LAYAK dari checklist: auto-tick deterministik client-side + 1 call AI menilai sisa item discretionary & kontradiksi) | "Pre-Entry Check" di tab CHECKLIST | Tidak | 45 menit per pair, key = fingerprint state checklist (invalid begitu ada item ditoggle) | 3 request/menit/IP |

Semua tombol AI di atas (kecuali Coach Jurnal) juga punya **cooldown 90 detik di browser** (disimpan di localStorage) — jadi secara wajar 1 orang tidak bisa klik lebih dari sekali per 90 detik meski server sendiri masih izinkan lebih cepat dari itu.

---

## 3. Detail per Fitur

### 3.1 Ringkasan Berita — `api/market-digest.js`

Satu kali "generate" sebenarnya adalah **3-4 panggilan AI sekaligus**, bukan 1:

| Sub-panggilan | Isinya | Kapan jalan |
|---|---|---|
| **Call 1** | Narasi briefing FX Bahasa Indonesia (paragraf) | Selalu |
| **Call 2** | Bias bank sentral per currency, format JSON terstruktur | Selalu |
| **Call 3** | Trade thesis (ide entry berbasis makro), format JSON | Selalu |
| **Call 4** | Cek headline baru vs thesis terbuka user (thesis alert) | **Hanya** kalau ada `device_id` DAN device itu punya posisi terbuka — jadi otomatis dilewati saat cron jalan (cron tidak bawa device_id) |

**Kapan generate penuh terjadi:**
- **Otomatis (cron):** 3×/hari via GitHub Actions — 07:00, 14:00, 19:30 WIB (jam buka sesi Asia/Eropa/New York). Cron ini TIDAK kena rate limit apapun (diautentikasi lewat secret) dan TIDAK kena gate di bawah — selalu generate fresh.
- **Manual:** tombol "Ringkas Berita"/"Ringkas Ulang" — siapa pun bisa klik kapan saja, dibatasi cooldown 90 detik/device + rate limit server 4x/menit/IP + **single-flight lock global (session 157 lanjutan)**.

**Single-flight lock (`lock:market_digest_generate`, TTL 55 detik) — cegah burst request bersamaan boros AI:** Call 1/2/3 hasilnya SAMA untuk semua orang (ditulis ke `latest_article`, satu key Redis global), jadi kalau banyak device klik "Ringkas Ulang" hampir bersamaan, generate ulang berkali-kali cuma menghasilkan kalimat beda-beda dari data yang sama — bukan informasi baru. Sekarang: request PERTAMA yang lolos rate limit mengunci `lock:market_digest_generate` lalu generate seperti biasa. Request LAIN yang datang selagi lock masih hidup (baik karena generate lagi berlangsung ATAU baru saja selesai — lock TIDAK di-release manual, TTL 55 detik dibiarkan jadi cooldown alami) langsung disajikan `latest_article` apa adanya, **tanpa** ikut generate — nol tambahan panggilan AI. Pengecualian: kalau `latest_article` benar-benar kosong (cold start, belum pernah ada cache sama sekali), request tetap lanjut generate walau lock dipegang, supaya user tidak dapat respons kosong. `thesis_alerts` di-null-kan pada respons short-circuit ini karena itu data personal (Call 4) — device yang "kalah" lock tidak ikut menampilkan alert milik device lain.

**Rantai fallback provider LENGKAP** (termasuk tingkat yang sedang non-aktif, supaya diagram ini jadi satu-satunya sumber kebenaran — tidak perlu baca potongan kode untuk tahu urutan pastinya):

```
Call 1 (prosa):
  [NON-AKTIF, hanya via ?test_nemotron=1]      Ollama Nemotron 3 Ultra → OpenRouter Nemotron 3 Ultra
  [NON-AKTIF, hanya via ?test_nemotron_super=1] OpenRouter Nemotron 3 Super
  [NON-AKTIF, hanya via ?test_hermes=1]         Hermes 3 405B (OpenRouter)
  [NON-AKTIF, hanya via ?test_glm=1]            Z.ai GLM 4.7 (Cerebras) — DITOLAK, context 8192 token < prompt ~13K
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (Plan O-3, 2026-07-18 — promosi dari diagnostik setelah tes live flash unggul vs V3.2, timeout 30s)
     [khusus jadwal cron session-open] fallback tambahan: Ollama Nemotron 3 Ultra, timeout ADAPTIF (sisa budget − 3s, floor 15s, mencegah dobel-timeout dgn DeepSeek — Plan O-2)
  2. SambaNova akun-2 (DeepSeek-V3.2)     — fallback 1 (primary lama sejak session 165, sekarang digeser)
  3. Cerebras (gpt-oss-120b)              — fallback 2
  4. Google AI Studio (Gemini-Flash)      — fallback 3
  5. Groq (llama-3.3-70b-versatile)       — fallback 4 (AI)
  6. Template deterministik non-AI (berdasarkan kategori berita) — fallback absolut, tidak pernah kosong

Call 2 (bias bank sentral, JSON):
  [NON-AKTIF, hanya via ?test_nemotron=1] Ollama Nemotron 3 Ultra → OpenRouter Nemotron 3 Ultra
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (Plan O-3, response_format json_object native)
  2. SambaNova akun-1 (DeepSeek-V3.2)     — fallback 1 (primary lama sejak session 165, sekarang digeser)
  3. Google AI Studio (Gemini-Flash)      — fallback 2 (response_format native)
  4. Groq (llama-3.3-70b-versatile)       — fallback terakhir
  (Z.ai GLM 4.7 via Cerebras sempat jadi primary session 164, digeser lagi session 165 — tidak ada lagi di rantai produksi Call 2)
  (kalau semua gagal: bias bank sentral TIDAK diupdate siklus itu — data lama di Redis tetap dipakai, bukan kosong/error)

Call 3 (trade thesis, JSON):
  [NON-AKTIF, hanya via ?test_nemotron=1] Ollama Nemotron 3 Ultra → OpenRouter Nemotron 3 Ultra
  (Nemotron 3 Super SENGAJA tidak disertakan di Call 3 — dibatasi ke Call 1 saja, lihat catatan di bawah)
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (Plan O-3; maxTokens 800→1200 — Plan O-1, cegah truncation JSON thesis skema 13 field)
  2. SambaNova akun-1 (DeepSeek-V3.2)     — fallback 1 (primary lama sejak session 165, sekarang digeser)
  3. Google AI Studio (Gemini-Flash)      — fallback 2 (response_format native)
  4. Groq (llama-3.3-70b-versatile)       — fallback terakhir
  (Z.ai GLM 4.7 via Cerebras sempat jadi primary session 164, digeser lagi session 165 — tidak ada lagi di rantai produksi Call 3)
  (kalau semua gagal: tidak ada trade thesis baru ditampilkan siklus itu, bukan error)

Call 4 (cek kontradiksi thesis terbuka):
  1. SambaNova akun-1 (DeepSeek-V3.2)     — PRIMARY produksi (SENGAJA TETAP SambaNova, bukan DeepSeek flash — jarang terpanggil, hemat saldo top-up, belum diuji flash untuk Call 4)
  2. Groq (llama-3.3-70b-versatile)       — fallback terakhir
  (tidak ada jalur diagnostik Nemotron untuk Call 4; kalau keduanya gagal: tidak ada thesis alert siklus itu, bukan error)
```

**Saldo habis (HTTP 402) di tengah bulan (Plan O-4):** aiCall() melempar 402 sebagai error status biasa (tidak beda dari 429/500) — ditangkap catch di tiap tingkat, ditandai eksplisit `deepseek:HTTP402_insufficient_balance` di log/providerLog, lalu fallback lanjut otomatis ke SambaNova. TIDAK hang, TIDAK butuh perubahan kode setelah user top-up lagi — begitu saldo terisi, request berikutnya otomatis balik pakai DeepSeek (tidak ada circuit breaker permanen untuk 402, hanya threshold kegagalan beruntun yang sama seperti error lain).

**Kenapa tingkat Nemotron ditandai NON-AKTIF (lagi):** session 162 lanjutan 3 sempat menaikkan Nemotron 3 Ultra jadi primary Call 1 setelah `think:false` native terbukti berhasil di diagnostik (1 sampel, 7 detik). Lanjutan 4 menemukan output kadang rusak (format nyatu/bahasa campur/kepotong) — sudah difix (validasi format + circuit breaker akurat). Lanjutan 5-6 menemukan akar masalah sebenarnya: 5 sampel completion time nyata di production (7s/17.5s/23.9s/29.5s/41.2s) membuktikan latency-nya 100% tidak terprediksi (resource contention tier gratis model 550B) — timeout 20s maupun 35s sama-sama tidak cukup karena variannya sendiri yang liar, bukan soal kurang longgar. Eksperimen `think:true` (reasoning dinyalakan) malah lebih buruk — 1 dari beberapa percobaan gagal TOTAL (Empty response, seluruh token budget habis di reasoning tanpa pernah sampai jawaban). Kualitas Nemotron sebenarnya BAGUS (0 pelanggaran frasa terlarang di semua sampel, malah lebih patuh prompt daripada SambaNova yang kedapatan leak 2×) — masalahnya murni reliability, bukan output. Lanjutan 7: didemote lagi ke non-aktif, SambaNova akun-2 kembali jadi primary asli. Nemotron TIDAK dihapus — tetap bisa dites ulang kapan pun via `?test_nemotron=1` / `?test_nemotron_super=1`, riset kandidat Ollama Cloud lain masih berlanjut.

Kalau primary gagal (limit habis / error / timeout), otomatis lompat ke tingkat berikutnya — user tidak akan lihat error kecuali **semua** tingkat produksi (bukan yang non-aktif) gagal sekaligus.

**Riwayat singkat primary Call 1/2/3 (session 163-165):** session 163 SambaNova akun-2 (Call 1) kena limit harian → OpenRouter `gpt-oss-120b:free` naik jadi primary Call 1. Session 164: OpenRouter diganti Cerebras native (`gpt-oss-120b`, lebih cepat & tidak timeout) tetap primary Call 1; Z.ai GLM 4.7 (Cerebras) jadi primary Call 2 & Call 3 (prompt lebih pendek, risiko context-limit lebih kecil dari Call 1) — live test sukses tapi gpt-oss-120b kedapatan over-tagging `{{TAG:}}` tiap kalimat (diterima sebagai tradeoff, tidak di-fix). Session 165 (2026-07-13): user memperbarui API key SambaNova → SambaNova dikembalikan jadi primary Call 1/2/3, Cerebras gpt-oss-120b digeser jadi fallback 1 Call 1, GLM 4.7 dilepas dari rantai Call 2/3 (tetap ada sebagai diagnostik `?test_glm=1` di Call 1).

### 3.2 Analisa AI per Pair — `api/admin.js` (`action=ohlcv_analyze`)

15 pasangan yang dilacak: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, EUR/JPY, GBP/JPY, EUR/GBP, AUD/JPY, EUR/AUD, GBP/AUD, GBP/CAD, XAU/USD.

**Penting:** tombol "Analisa AI" **selalu memanggil AI baru setiap diklik** — tidak dicek dulu apakah sudah ada hasil baru-baru ini (beda dengan Analisa Fundamental di §3.3 yang pakai cache global). Yang menahan laju supaya tidak boros adalah:
- Cooldown 90 detik/device di UI
- Rate limit server 5 request/menit/IP
- Jatah harian provider bersama (lihat §4)

Hasil tiap analisa disimpan 6 jam supaya kalau tab ditutup-buka lagi, versi terakhir bisa langsung tampil tanpa panggil AI ulang (mode baca cepat, `mode=cached`).

**Otomatis:** hanya XAU/USD, 3×/hari, nempel di jadwal cron Ringkasan Berita (workflow yang sama, langkah kedua).

**Rantai fallback: SambaNova akun-1 (DeepSeek-V3.2) → SambaNova akun-2 (DeepSeek-V3.2) — HANYA 2 tingkat, TIDAK ada Groq.** Groq dan Ollama Cloud pernah ada di rantai ini tapi **sengaja dicoret** (2026-07-10): live test membuktikan Ollama timeout konsisten 15 detik sampai circuit breaker terbuka, dan kualitas Groq/llama-3.3 dinilai paling rendah dibanding DeepSeek-V3.2 akun-2 sebagai fallback tunggal — jadi kalau kedua akun SambaNova gagal sekaligus, fitur ini **langsung menampilkan "AI tidak tersedia"**, tidak sempat coba provider lain. Ini beda dari 3 fitur AI lainnya yang semuanya masih punya Groq sebagai jaring pengaman terakhir.

**DeepSeek v4-flash — jalur diagnostik `?test_deepseek=1` (Plan O-6, 2026-07-18), BELUM promosi jadi primary.** Beda dari Ringkasan Berita (§3.1) yang sudah dipromosikan langsung, kualitas flash untuk tugas numerik Entry/SL/TP di sini belum divalidasi live — jalur diagnostik TERISOLASI total (skip 2 tingkat SambaNova, hasil TIDAK ditulis ke cache `ohlcv_analysis:{symbol}` 6 jam). Promosi jadi primary MENUNGGU hasil tes 2-3 pair (termasuk XAU/USD) dibandingkan kualitas vs SambaNova V3.2 — lihat `daun_merah.md` untuk hasil & keputusan gate.

### 3.3 Analisa Fundamental — `api/admin.js` (`action=fundamental_analysis`)

Ini fitur AI yang **paling hemat** secara desain: hasilnya di-cache **6 jam untuk SEMUA orang** (satu key Redis global, bukan per-user/per-device), dan frontend tidak pernah minta "paksa refresh". Artinya:

> **Berapa pun banyak orang yang klik tombol ini, AI-nya paling banyak benar-benar jalan 4 kali sehari** (24 jam ÷ 6 jam cache) — sisanya semua orang cuma baca hasil yang sama dari cache.

**Rantai fallback:** Cerebras (`gpt-oss-120b`) → SambaNova akun-2 (DeepSeek-V3.2) → Groq (llama-3.3-70b).

### 3.4 AI Coach Jurnal — `api/journal.js` (`action=analyze`)

Menganalisis pola menang/kalah dari trade yang sudah ditutup (butuh minimal 3 trade closed). Cache 1 jam **per device** (device lain / hari lain dapat cache masing-masing), dan ada tombol "paksa ulang" yang melewati cache.

**Rantai fallback:** Cerebras (`gpt-oss-120b`) → SambaNova akun-2 (DeepSeek-V3.2) → Groq (llama-3.3-70b).

### 3.5 Pre-Entry Check — `api/admin.js` (`action=pre_entry_check`, Plan R 2026-07-18)

Berbeda dari 4 fitur di atas: **fact sheet dibangun 100% client-side** (checklist state cuma hidup di localStorage per-device, tidak ada di Redis), bukan fetch server dari cache. Kode client (`ckAutoTick`/`ckAutoBlock`/`ckAutoTickFromAnalisa` di `index.html`) sudah men-auto-tick semua item yang datanya tersedia (CB bias, COT, real yield, retail sentiment, kalender, OHLCV/pola candle, sizing calculator) SEBELUM tombol ditekan — endpoint ini menerima daftar item lengkap (status FAKTA-tick/FAKTA-block/manual-checked/manual-unchecked + evidence tiap item auto), lalu **satu call AI** menilai HANYA item manual yang masih kosong + mencari kontradiksi logis antar item FAKTA. Server TIDAK fetch Redis apa pun untuk fitur ini — payload dari client sudah cukup.

**Rantai fallback:** DeepSeek v4-flash (primary, sama seperti Ringkasan Berita) → SambaNova akun-1 (DeepSeek-V3.2). Kalau keduanya gagal: `error: 'ai_unavailable'`, client tampilkan skor deterministik saja dengan label "penilaian AI tidak tersedia" — fitur tetap berguna tanpa AI, bukan mati total.

**Garis keras (desain, bukan implementasi teknis):** verdict LAYAK/TIDAK LAYAK adalah **konteks keputusan, bukan sinyal eksekusi** — tidak ada auto-entry di jalur mana pun, user tetap yang menekan tombol entry MT5/manual sendiri.

---

## 4. Jatah Harian (Budget Guard) — `api/_ai_guard.js`

Ini lapisan pembatas paling penting untuk dipahami. **Jatah ini dibagi rata ke semua fitur yang pakai provider yang sama** — bukan per-fitur. Kalau salah satu fitur boros, fitur lain yang berbagi provider ikut kena dampak (fallback ke tingkat berikutnya, bukan error — lihat §5).

| SambaNova (akun-1 & akun-2) | 200 request/hari masing-masing | ~10-20 RPM, free persisten | Fallback 1 di semua Call 1/2/3 (digeser dari primary — Plan O-3), Analisa AI primary |
| **Google AI Studio (Gemini)** | 200 request/hari | 10 RPM, 1.500 RPD | Fallback 3 Call 1, Fallback 2 Call 2/3 (JSON native) |
| **Cerebras** | 200 request/hari | ~30 RPM, 1M token/hari | Analisa Fundamental primary, AI Coach primary, Fallback 2 Call 1 |
| **Groq** | 500 request/hari | 30 RPM | Fallback terakhir untuk Call 1/2/3, Analisa Fundamental, AI Coach |
| **OpenRouter** (Nemotron/Hermes) | 45 request/hari | 50/hari (gratis) | Idle di produksi, hanya via ?test_nemotron dsb |
| **Ollama Cloud** (Nemotron) | 150 request/hari | - | Fallback cron-only Call 1 (timeout adaptif — Plan O-2); idle untuk live/on-demand, hanya via ?test_nemotron dsb |
| **DeepSeek API resmi** | 50 request/hari (PAGAR BIAYA — provider berbayar dari saldo top-up user, bukan free tier) | Tidak ada limit request; yang membatasi saldo (top-up $2, 2026-07-18, burn rate live ±$0.0033/generate) | **PRIMARY Call 1/2/3 Ringkasan Berita** (Plan O-3, 2026-07-18) + Pre-Entry Check (Plan R-2). Diagnostik `?test_deepseek=1` di Analisa AI per Pair (Plan O-6, belum promosi) |

**Pool yang paling perlu diawasi: SambaNova akun-1 dan Google AI Studio (Gemini).** SambaNova 1 masih primary di banyak tempat, sedangkan Gemini adalah fallback pertama JSON yang jika SambaNova error akan memikul beban JSON parse. Kuota Gemini gratis (1500 RPD) sangat cukup untuk headroom.

**Kenapa angkanya sengaja lebih rendah dari limit resmi provider?** Supaya selalu ada headroom untuk retry otomatis dan supaya 1 hari yang tiba-tiba ramai tidak langsung mentok di detik-detik terakhir kuota resmi. Override manual bisa lewat env var `AI_DAILY_LIMIT_{PROVIDER}` kalau suatu saat perlu dinaikkan (misal setelah top-up OpenRouter $10+).

---

## 5. "Paling Banyak Dipakai Berapa Kali?" — Estimasi dalam Bahasa Sederhana

Ini jawaban langsung untuk pertanyaan "penggunaan paling banyak fitur AI itu berapa kali", dipecah per fitur:

### Ringkasan Berita
- **Otomatis:** pasti 3× sehari, tidak bisa lebih, tidak bisa kurang (jadwal tetap). Tiap generate normal = 1 request akun-2 (Call 1) + 2 request ke SambaNova akun-1 (Call 2 & Call 3) — jadi 3 cron/hari = 3 request akun-2 + 6 request akun-1.
- **Manual:** setiap 1× klik "Ringkas Ulang" menambah **1 request akun-2 + 2 request akun-1** (+1 request akun-1 lagi kalau device itu punya posisi terbuka di jurnal, karena Call 4 ikut jalan). Pool akun-2 (200/hari) longgar untuk fitur ini sendirian — bottleneck sebenarnya ada di **akun-1**, yang dipakai bareng-bareng dengan Analisa AI per Pair (lihat di bawah).
- **Kesimpulan sederhana:** kalau cuma fitur ini saja yang dipakai (tanpa Analisa AI per Pair), jatah akun-1 (200/hari, dikurangi 6 dari cron) cukup untuk **±97 kali klik manual "Ringkas Ulang"** sehari sebelum SambaNova akun-1 habis dan Call 2/3 otomatis pindah ke Groq (kualitas JSON sedikit lebih rendah, tapi tetap jalan).

### Analisa AI per Pair
- **Otomatis:** 3× sehari, khusus XAU/USD saja (juga lewat SambaNova akun-1, ikut cron Ringkasan Berita).
- **Manual:** dibatasi 5 klik/menit/IP oleh server dan 90 detik cooldown/device oleh UI. **Setiap klik = 1 request akun-1** (fallback ke akun-2 kalau akun-1 lagi bermasalah). Tidak ada cache-gate sebelum generate (beda dari Analisa Fundamental), jadi tiap klik selalu makan jatah.
- **Perkiraan realistis:** kalau tiap 1 dari 15 pair di-klik ulang rata-rata 4-5 kali sehari oleh berbagai user, itu sekitar **60-75 request/hari** ke akun-1 yang sama.

### Kombinasi Ringkasan Berita + Analisa AI per Pair (pool akun-1 bersama)
Karena keduanya berebut jatah 200/hari yang sama, totalnya harus dijumlah: 6 (cron digest) + 60-75 (analisa pair) + 2× jumlah klik manual "Ringkas Ulang". Dengan jatah 200/hari, **kalau Analisa AI per Pair sedang ramai (75 request), sisa jatah untuk Ringkasan Berita manual tinggal ±(200-6-75)/2 ≈ 60 kali klik/hari** — masih sangat longgar untuk pemakaian wajar, tapi ini angka yang akan mengecil kalau salah satu fitur tiba-tiba jadi jauh lebih populer dari yang lain.

### Analisa Fundamental
- **Maksimal mutlak: 4 kali sehari**, apapun yang terjadi (cache global 6 jam, tidak ada tombol paksa refresh di UI). Fitur paling "aman" dari sisi jatah AI, dan providernya (Cerebras primary) bahkan tidak berbagi pool dengan 2 fitur di atas.

### AI Coach Jurnal
- Terikat pada aktivitas trading nyata user (butuh ≥3 trade closed) — secara alami jarang dipanggil. Ada tombol paksa ulang, jadi 1 device yang aktif bisa memicu beberapa kali sehari kalau memang lagi banyak menutup/mengevaluasi trade, tapi cache 1 jam/device tetap membatasi ini secara wajar.

### Total gabungan (skenario ramai realistis dalam 1 hari)
| Fitur | Perkiraan maksimal wajar/hari | Pool yang dipakai |
|---|---|---|
| Ringkasan Berita (otomatis, 3× cron) | 3 request akun-2 + 6 request akun-1 | SambaNova akun-1 & akun-2 |
| Ringkasan Berita (manual, ~15-20× klik/hari wajar) | ±15-20 request akun-2 + ±30-40 request akun-1 | SambaNova akun-1 & akun-2 |
| Analisa AI per Pair (otomatis + manual) | ±63-78 request akun-1 | SambaNova akun-1 (+akun-2 kalau fallback) |
| Analisa Fundamental | maksimal 4 request | Cerebras |
| AI Coach Jurnal | ±5-10 request | Cerebras |

**Total kasar akun-1 di hari ramai: sekitar 100-125 dari jatah 200/hari** — masih ada headroom, tapi ini pool yang paling realistis mendekati limit kalau traffic naik signifikan. Pool lain (Cerebras, Groq, dan OpenRouter/Ollama yang memang idle) jauh dari mentok. Yang bisa membuat kena limit di luar skenario wajar: bug loop, endpoint di-spam otomatis (bot), atau semua fallback sekaligus down di provider aslinya (bukan soal kuota).

---

## 6. Kalau Semua Fallback di Satu Rantai Habis/Gagal

3 dari 4 fitur AI (Ringkasan Berita, Analisa Fundamental, AI Coach Jurnal) punya **Groq sebagai jaring pengaman terakhir** yang selalu dicoba tanpa circuit breaker — jadi kegagalan sementara di provider lain tidak pernah membuat fitur itu benar-benar mati total, kecuali:
1. Semua provider di rantai itu gagal di hari yang sama (sangat jarang, karena tiap provider beda infrastruktur), atau
2. Jatah harian kita sendiri (§4) sudah habis di SEMUA provider dalam rantai tersebut.

**Analisa AI per Pair adalah pengecualian** (lihat §3.2) — rantainya cuma 2 tingkat (SambaNova akun-1 → akun-2), tidak ada Groq. Kalau kedua akun SambaNova bermasalah bersamaan, fitur ini langsung gagal tanpa jaring pengaman tambahan.

Ringkasan Berita Call 1 (prosa) punya pengaman ekstra di luar AI: kalau semua provider AI gagal, ada template non-AI berbasis kategori berita (lihat §3.1) — jadi khusus Call 1, "AI tidak tersedia" tidak pernah benar-benar terjadi di UI, cuma kualitasnya turun.

Kalau gagal total terjadi, user akan melihat pesan "AI tidak tersedia — coba beberapa saat lagi" di UI, bukan error yang membingungkan. Redis juga fail-open (kalau Redis down, guard `_ai_guard.js` otomatis mengizinkan panggilan lewat, bukan memblokir) — jadi masalah infrastruktur cache tidak pernah jadi alasan AI mati.

---

## 7. Model & Endpoint — Referensi Cepat

| Provider | Endpoint | Model ID yang dipakai | Peran saat ini | Env var |
|---|---|---|---|---|
| SambaNova (akun-1) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | **Primary** — Ringkasan Berita Call 2/3/4, Analisa AI per Pair | `SAMBANOVA_API_KEY` |
| SambaNova (akun-2) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | **Primary** — Ringkasan Berita Call 1 (kembali sejak session 165); fallback fitur lain | `SAMBANOVA_API_KEY_CALL1` |
| Google AI Studio | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-flash-latest` | Fallback 2 Call 1, Fallback 1 Call 2/3 (JSON native) — dipromosikan Plan N (2026-07-18) | `GEMINI_API_KEY` |
| Cerebras | `api.cerebras.ai/v1/chat/completions` | `gpt-oss-120b` (aktif) | **Primary** — Analisa Fundamental, AI Coach Jurnal; fallback-1 Ringkasan Berita Call 1 | `CEREBRAS_API_KEY` |
| Groq | `api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | Fallback terakhir — Ringkasan Berita, Analisa Fundamental, AI Coach Jurnal | `GROQ_API_KEY` |
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | `nvidia/nemotron-3-ultra-550b-a55b:free` dkk | **Idle** di jalur produksi — Nemotron/Hermes cuma lewat query param diagnostik (lihat §3.1) | `OPENROUTER_API_KEY` |
| Ollama Cloud | `ollama.com/api/chat` (native) | `nemotron-3-ultra` | **Idle** | `OLLAMA_API_KEY` |
| DeepSeek (API resmi, BERBAYAR) | `api.deepseek.com/chat/completions` | `deepseek-v4-flash` (thinking disabled) | **Idle** — diagnostik `?test_deepseek=1` Call 1/2/3 (Session 186); kandidat primary tunggal, belum dipromosikan | `DEEPSEEK_API_KEY` |

---

## 8. Catatan Perawatan

- Kalau mau menaikkan jatah harian salah satu provider (misal setelah top-up OpenRouter), set env var `AI_DAILY_LIMIT_{PROVIDER}` di Vercel — jangan ubah `DEFAULT_LIMITS` di kode tanpa konfirmasi status akun aslinya dulu.
- Cek pemakaian real-time tanpa nambah counter: `getUsage(provider)` di `_ai_guard.js`, biasanya diekspos lewat `admin?action=health`.
- Kalau ada model baru mau dicoba (pola yang sudah beberapa kali dipakai project ini: `?test_nemotron=1`, `?test_nemotron_super=1`, `?test_hermes=1`, `?test_ollama=1`), selalu tes dulu via query param diagnostik sebelum jadi primary permanen — pelajaran dari beberapa model yang "katanya gratis" ternyata 403/subscription-required saat dites nyata (lihat riwayat di [daun_merah.md](daun_merah.md), Session 144-145).
