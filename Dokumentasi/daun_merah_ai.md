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

## 2. Peta 4 Fitur AI

| # | Fitur | Tombol di UI | Dipicu otomatis? | Cache | Rate limit server |
|---|-------|--------------|-------------------|-------|--------------------|
| 1 | **Ringkasan Berita** (briefing FX + bias bank sentral + thesis + alert) | "Ringkas Berita" / "Ringkas Ulang" | Ya — 3×/hari (cron) | Tidak ada cache untuk generate baru (selalu fresh); hasil terakhir disimpan untuk mode baca cepat | 4 request/menit/IP |
| 2 | **Analisa AI per Pair** (komentar + level entry/SL/TP teknikal per pasangan mata uang) | "Analisa AI" (per pair, termasuk XAU/USD) | Ya — XAU/USD saja, 3×/hari (nempel di cron #1) | Tidak ada cache sebelum generate (selalu fresh tiap klik); hasil disimpan 6 jam untuk auto-tampil | 5 request/menit/IP |
| 3 | **Analisa Fundamental** (ringasan kondisi fundamental semua mata uang) | "Analisa Fundamental" | Tidak | **6 jam, GLOBAL** (satu cache untuk semua orang — lihat §4.3) | 5 request/menit/IP |
| 4 | **AI Coach Jurnal** (analisis pola menang/kalah dari trade yang sudah closed) | "Analisis AI" di tab Jurnal | Tidak | 1 jam per device, ada tombol "paksa ulang" | 30 request/menit/IP (endpoint jurnal secara umum) |

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
- **Otomatis (cron):** 3×/hari via GitHub Actions — 07:00, 14:00, 19:30 WIB (jam buka sesi Asia/Eropa/New York). Cron ini TIDAK kena rate limit apapun (diautentikasi lewat secret).
- **Manual:** tombol "Ringkas Berita"/"Ringkas Ulang" — siapa pun bisa klik kapan saja, dibatasi cooldown 90 detik/device + rate limit server 4x/menit/IP.

**Rantai fallback provider yang benar-benar jalan di produksi saat ini:**
```
Call 1 (prosa):       SambaNova akun-2 (DeepSeek-V3.2) → OpenRouter (gpt-oss-120b:free) → Groq (llama-3.3-70b)
Call 2 (bias JSON):   SambaNova akun-1 (DeepSeek-V3.2) → Groq (llama-3.3-70b)
Call 3 (thesis JSON): SambaNova akun-1 (DeepSeek-V3.2) → Groq (llama-3.3-70b)
Call 4 (monitor):     SambaNova akun-1 (DeepSeek-V3.2) → Groq (llama-3.3-70b)
```
Kalau primary gagal (limit habis / error / timeout), otomatis lompat ke berikutnya — user tidak akan lihat error kecuali **semua** tingkat di rantai itu gagal sekaligus.

> **Catatan penting — Nemotron 3 Ultra/Super via OpenRouter atau Ollama Cloud SAAT INI TIDAK dipakai di jalur produksi.** Model ini sempat dijadikan primary (session 145) tapi **didemote** setelah 4 dari 4 percobaan live gagal di 2 sumber berbeda (OpenRouter & Ollama Cloud) — polanya konsisten resource-contention (model 550B baru rilis, kemungkinan diprioritaskan rendah di tier gratis), bukan bug di kode kita. SambaNova dikembalikan jadi primary asli karena terbukti reliable berbulan-bulan. Nemotron masih bisa dites ulang kapan pun lewat parameter diagnostik `?test_nemotron=1` / `?test_nemotron_super=1`, tapi **tidak** dipanggil otomatis oleh cron maupun tombol "Ringkas Berita" biasa. Praktis artinya: **jatah harian OpenRouter (45/hari) dan Ollama (150/hari) nyaris tidak terpakai sehari-hari** — dua pool ini sedang "menganggur", disiapkan untuk pengujian ulang Nemotron di masa depan, bukan bagian dari kapasitas harian yang aktif dipakai.

### 3.2 Analisa AI per Pair — `api/admin.js` (`action=ohlcv_analyze`)

15 pasangan yang dilacak: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, EUR/JPY, GBP/JPY, EUR/GBP, AUD/JPY, EUR/AUD, GBP/AUD, GBP/CAD, XAU/USD.

**Penting:** tombol "Analisa AI" **selalu memanggil AI baru setiap diklik** — tidak dicek dulu apakah sudah ada hasil baru-baru ini (beda dengan Analisa Fundamental di §3.3 yang pakai cache global). Yang menahan laju supaya tidak boros adalah:
- Cooldown 90 detik/device di UI
- Rate limit server 5 request/menit/IP
- Jatah harian provider bersama (lihat §4)

Hasil tiap analisa disimpan 6 jam supaya kalau tab ditutup-buka lagi, versi terakhir bisa langsung tampil tanpa panggil AI ulang (mode baca cepat, `mode=cached`).

**Otomatis:** hanya XAU/USD, 3×/hari, nempel di jadwal cron Ringkasan Berita (workflow yang sama, langkah kedua).

**Rantai fallback:** SambaNova akun-1 (DeepSeek-V3.2) → SambaNova akun-2 → Groq (llama-3.3-70b).

### 3.3 Analisa Fundamental — `api/admin.js` (`action=fundamental_analysis`)

Ini fitur AI yang **paling hemat** secara desain: hasilnya di-cache **6 jam untuk SEMUA orang** (satu key Redis global, bukan per-user/per-device), dan frontend tidak pernah minta "paksa refresh". Artinya:

> **Berapa pun banyak orang yang klik tombol ini, AI-nya paling banyak benar-benar jalan 4 kali sehari** (24 jam ÷ 6 jam cache) — sisanya semua orang cuma baca hasil yang sama dari cache.

**Rantai fallback:** Cerebras (`gpt-oss-120b`) → SambaNova akun-2 (DeepSeek-V3.2) → Groq (llama-3.3-70b).

### 3.4 AI Coach Jurnal — `api/journal.js` (`action=analyze`)

Menganalisis pola menang/kalah dari trade yang sudah ditutup (butuh minimal 3 trade closed). Cache 1 jam **per device** (device lain / hari lain dapat cache masing-masing), dan ada tombol "paksa ulang" yang melewati cache.

**Rantai fallback:** Cerebras (`gpt-oss-120b`) → SambaNova akun-2 (DeepSeek-V3.2) → Groq (llama-3.3-70b).

---

## 4. Jatah Harian (Budget Guard) — `api/_ai_guard.js`

Ini lapisan pembatas paling penting untuk dipahami. **Jatah ini dibagi rata ke semua fitur yang pakai provider yang sama** — bukan per-fitur. Kalau salah satu fitur boros, fitur lain yang berbagi provider ikut kena dampak (fallback ke tingkat berikutnya, bukan error — lihat §5).

| Provider (pool) | Jatah harian kita | Limit asli provider (referensi) | Dipakai oleh |
|---|---|---|---|
| **SambaNova akun-1** (`sambanova_main`) | 200 request/hari | ~10-20 request/menit, truly free persisten | Ringkasan Berita Call 2, Call 3, Call 4 (**primary**, ketiganya), Analisa AI per Pair (**primary**) — pool paling ramai, dipakai bareng 2 fitur sekaligus |
| **SambaNova akun-2** (`sambanova_c1`) | 200 request/hari | Sama seperti akun-1, tapi akun terpisah (kuota terpisah) | Ringkasan Berita Call 1 (**primary**), Analisa Fundamental (fallback), AI Coach Jurnal (fallback), Analisa AI per Pair (fallback) |
| **Cerebras** | 200 request/hari | ~30 request/menit, 1 juta token/hari (jauh lebih longgar — kita sengaja konservatif dari sisi jumlah request) | Analisa Fundamental (**primary**), AI Coach Jurnal (**primary**) |
| **Groq** | 500 request/hari | 30 request/menit, ribuan/hari tergantung model | Fallback terakhir SEMUA fitur AI (jaring pengaman, selalu dicoba tanpa circuit breaker) |
| **OpenRouter** (Nemotron, saat ini idle) | 45 request/hari | 50/hari (akun belum top-up) atau 1.000/hari (sudah top-up $10+) | Ringkasan Berita Call 1 fallback-2 (`gpt-oss-120b:free`) — kepakai hanya kalau SambaNova akun-2 gagal. Nemotron Ultra/Super cuma lewat sini kalau dites manual (`?test_nemotron=1`) |
| **Ollama Cloud** (saat ini idle) | 150 request/hari | Tidak dipublikasikan resmi (konservatif) | Tidak dipakai di jalur produksi mana pun saat ini — disiapkan untuk pengujian ulang Nemotron |

**Pool yang paling perlu diawasi: SambaNova akun-1.** Ini satu-satunya pool yang dipakai sebagai *primary* oleh 2 fitur berbeda sekaligus (Ringkasan Berita Call 2/3/4 DAN Analisa AI per Pair) — kalau traffic naik di kedua fitur bersamaan, ini yang pertama kali mendekati jatah 200/hari, bukan OpenRouter seperti dugaan awal.

**Kenapa angkanya sengaja lebih rendah dari limit resmi provider?** Supaya selalu ada headroom untuk retry otomatis dan supaya 1 hari yang tiba-tiba ramai tidak langsung mentok di detik-detik terakhir kuota resmi. Override manual bisa lewat env var `AI_DAILY_LIMIT_{PROVIDER}` kalau suatu saat perlu dinaikkan (misal setelah top-up OpenRouter $10+).

---

## 5. "Paling Banyak Dipakai Berapa Kali?" — Estimasi dalam Bahasa Sederhana

Ini jawaban langsung untuk pertanyaan "penggunaan paling banyak fitur AI itu berapa kali", dipecah per fitur:

### Ringkasan Berita
- **Otomatis:** pasti 3× sehari, tidak bisa lebih, tidak bisa kurang (jadwal tetap). Tiap generate = 1 request ke SambaNova akun-2 (Call 1) + 2 request ke SambaNova akun-1 (Call 2 & Call 3) — jadi 3 cron/hari = 3 request akun-2 + 6 request akun-1.
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

Setiap fitur AI punya jaring pengaman terakhir (biasanya Groq) yang **selalu dicoba tanpa circuit breaker** — jadi kegagalan sementara di provider lain tidak pernah membuat fitur benar-benar mati total, kecuali:
1. Semua provider di rantai itu gagal di hari yang sama (sangat jarang, karena tiap provider beda infrastruktur), atau
2. Jatah harian kita sendiri (§4) sudah habis di SEMUA provider dalam rantai tersebut.

Kalau itu terjadi, user akan melihat pesan "AI tidak tersedia — coba beberapa saat lagi" di UI, bukan error yang membingungkan. Redis juga fail-open (kalau Redis down, guard `_ai_guard.js` otomatis mengizinkan panggilan lewat, bukan memblokir) — jadi masalah infrastruktur cache tidak pernah jadi alasan AI mati.

---

## 7. Model & Endpoint — Referensi Cepat

| Provider | Endpoint | Model ID yang dipakai | Peran saat ini | Env var |
|---|---|---|---|---|
| SambaNova (akun-1) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | **Primary** — Ringkasan Berita Call 2/3/4, Analisa AI per Pair | `SAMBANOVA_API_KEY` |
| SambaNova (akun-2) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | **Primary** — Ringkasan Berita Call 1; fallback fitur lain | `SAMBANOVA_API_KEY_CALL1` |
| Cerebras | `api.cerebras.ai/v1/chat/completions` | `gpt-oss-120b` | **Primary** — Analisa Fundamental, AI Coach Jurnal | `CEREBRAS_API_KEY` |
| Groq | `api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | Fallback terakhir — semua fitur | `GROQ_API_KEY` |
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | `openai/gpt-oss-120b:free` (fallback aktif); `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free` (diagnostik saja) | Fallback-2 Ringkasan Berita Call 1; Nemotron **idle** (lihat §3.1) | `OPENROUTER_API_KEY` |
| Ollama Cloud | `ollama.com/api/chat` (native, bukan `/v1/chat/completions`) | `nemotron-3-ultra` | **Idle** — hanya lewat `?test_nemotron=1` | `OLLAMA_API_KEY` |

---

## 8. Catatan Perawatan

- Kalau mau menaikkan jatah harian salah satu provider (misal setelah top-up OpenRouter), set env var `AI_DAILY_LIMIT_{PROVIDER}` di Vercel — jangan ubah `DEFAULT_LIMITS` di kode tanpa konfirmasi status akun aslinya dulu.
- Cek pemakaian real-time tanpa nambah counter: `getUsage(provider)` di `_ai_guard.js`, biasanya diekspos lewat `admin?action=health`.
- Kalau ada model baru mau dicoba (pola yang sudah beberapa kali dipakai project ini: `?test_nemotron=1`, `?test_nemotron_super=1`), selalu tes dulu via query param diagnostik sebelum jadi primary permanen — pelajaran dari beberapa model yang "katanya gratis" ternyata 403/subscription-required saat dites nyata (lihat riwayat di [daun_merah.md](daun_merah.md), Session 144-145).
