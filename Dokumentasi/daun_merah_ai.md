# Daun Merah — Pemakaian AI (Referensi Lengkap)

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Referensi KONDISI-SEKARANG pemakaian AI: fitur mana pakai provider/model apa,
           chain fallback, limit provider + jatah harian buatan sendiri (_ai_guard.js).
BOLEH    : Peta fitur AI, chain primary→fallback per fitur, limit & cache & rate limit,
           status provider (aktif/demote/ditolak + alasan satu baris).
DILARANG : Vendor non-AI (-> daun_merah_vendor.md), cerita kronologis tes model
           (-> changelog daun_merah.md), ide/eksperimen model masa depan (-> daun_merah_riset.md).
FORMAT   : Update IN PLACE (bukan append changelog) — setiap ganti chain/limit, ubah langsung
           tabel terkait + catat tanggal; file ini harus selalu = kondisi produksi terkini.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-07-11 (session 157)
> **Update besar terakhir:** 2026-08-12 — SambaNova (2 akun) diputus kontrak total (akun diblokir billing SambaNova sendiri, ganti API key tidak memperbaikinya), semua kode chain-nya dihapus. Chain sekarang murni DeepSeek (berbayar, saldo top-up) ↔ Gemini (gratis) tergantung fitur. Sebelumnya (2026-07-25): OpenRouter, Cerebras, Groq, Ollama Cloud diputus kontraknya.
> **Tujuan dokumen:** satu tempat untuk menjawab "fitur AI apa saja yang ada, dipanggil pakai model/provider apa, dan paling banyak dipakai berapa kali sehari" — supaya kalau ada laporan "AI error/limit habis", tinggal buka file ini dulu sebelum ngoprek kode.
> **Vendor & non-AI infra:** lihat [daun_merah_vendor.md](daun_merah_vendor.md).
> **Riset perbandingan provider (kenapa provider ini yang dipilih):** lihat [daun_merah.md § Research: Free AI Inference API Providers](daun_merah.md#research-free-ai-inference-api-providers-2026-05-28).

---

## 1. Cara baca dokumen ini (ringkas dulu, baru detail)

Aplikasi ini punya **4 fitur yang memanggil AI**. DeepSeek berbayar dari saldo top-up user (bukan free tier); Gemini gratis. "Gratis" tetap ada plafonnya — baik dari provider aslinya maupun dari **jatah harian buatan sendiri** (`api/_ai_guard.js`) yang dipasang supaya satu fitur nakal (loop bug, di-spam) tidak menghabiskan kuota gratis punya fitur lain.

Ada 2 lapis pembatas yang perlu dibedakan:

1. **Pembatas provider asli** (di luar kontrol kita) — hard limit, kalau kelewat provider menolak (HTTP 429).
2. **Pembatas buatan sendiri** (`_ai_guard.js` + rate limit per-IP + cooldown tombol) — sengaja dipasang **di bawah** limit resmi provider, supaya selalu ada jarak aman. Ini yang paling sering jadi penyebab "AI tidak tersedia" kalau kepakai berlebihan, BUKAN provider aslinya yang menolak.

---

## 2. Peta Fitur AI

| # | Fitur | Tombol di UI | Dipicu otomatis? | Cache | Rate limit server |
|---|-------|--------------|-------------------|-------|--------------------|
| 1 | **Ringkasan Berita** (briefing FX + bias bank sentral + thesis + alert) | "Ringkas Berita" / "Ringkas Ulang" | Ya — 3×/hari (cron) | Tidak ada cache untuk generate baru; hasil terakhir disimpan untuk mode baca cepat | 4 request/menit/IP + single-flight lock global 55 detik (lihat §3.1) |
| 2 | **Analisa AI per Pair** (komentar + level entry/SL/TP teknikal per pasangan mata uang) | "Analisa Pair Ini" (per pair, termasuk XAU/USD) | Ya — XAU/USD saja, 3×/hari (nempel di cron #1) | Tidak ada cache sebelum generate (selalu fresh tiap klik); hasil disimpan 6 jam untuk auto-tampil | 5 request/menit/IP |
| 3 | **Analisa Fundamental** (sintesa makro per currency: rezim pertumbuhan-inflasi, kebijakan moneter, ranking, setup paling searah, flag data lemah — bukan cuma ranking terkuat/terlemah) | "Buat Analisis Fundamental" | Tidak | **6 jam, GLOBAL** (satu cache untuk semua orang — lihat §4.3) | 5 request/menit/IP |
| 4 | **AI Coach Jurnal** (analisis pola menang/kalah dari trade yang sudah closed) | "Ringkas Jurnal Saya" di tab Jurnal | Tidak | 1 jam per device, ada tombol "Refresh" | 30 request/menit/IP (endpoint jurnal secara umum) |
| 5 | **Pre-Entry Check** (Plan R, 2026-07-18 — verdict LAYAK/TIDAK LAYAK dari checklist: auto-tick deterministik client-side + 1 call AI menilai sisa item discretionary & kontradiksi) | "Periksa Sebelum Entry" di tab CHECKLIST | Tidak | 45 menit per pair, key = fingerprint state checklist (invalid begitu ada item ditoggle) | 3 request/menit/IP |
| 6 | **Diagnosa Perilaku Jurnal** (Plan I item 5 — disposition effect, overtrading, distribusi sesi/playbook dari trade closed) | "Diagnosa Perilaku" di tab Jurnal | Tidak | Selama sampel checklist tidak berubah, ada link "refresh" | 30 request/menit/IP (endpoint jurnal secara umum) |
| 7 | **Auto-Entry Virtual** (Plan U-3, 2026-07-20 — eksperimen **developer-only**, TIDAK ADA di UI publik: daemon Railway memanggil `ohlcv_analyze&auto=1` untuk XAU/USD, sama modelnya dengan fitur #2 tapi TIDAK menulis cache `ohlcv_analysis:<symbol>` & masuk log terpisah `setup_log_auto:v1`) | Tidak ada tombol — murni scheduler daemon | Ya — 2 slot/hari (buka London & NY, hanya saat FX buka), skip kalau ada event high-impact <4 jam | Tidak relevan (selalu fresh, tidak pernah baca cache) | Proteksi `x-cron-secret`===`CRON_SECRET`, publik tidak bisa spoof `source:'auto'` |
| 8 | **Uji Konsistensi LLM** (Plan U-3 — 3x panggilan berturut ke pair yang sama, jalur diagnostik, TIDAK menulis cache/setup produksi) | Tidak ada tombol — daemon | Ya — 1 slot/hari | Hasil ke `consistency_log:v1` (cap 60), bukan cache analisa | Sama seperti #7 |
| 9 | **Review Posisi Virtual** (Plan U-5a/U-5b, 2026-07-20 — developer-only: daemon deteksi headline market-moving/geopolitical yang match currency setup eksperimen `open`, trigger 1 call AI menilai HOLD/TIGHTEN_SL/CLOSE_EARLY, validasi kode fail-safe → downgrade HOLD kalau tak patuh skema) | Tidak ada tombol — event-driven dari `pollNews` daemon | Ya — event-driven (headline masuk), dibatasi cooldown 6 jam/posisi + cap 3/hari | Tidak relevan | Sama seperti #7; HANYA melayani id dari `setup_log_auto:v1` (id manual → skip tanpa call AI) |
| 10 | **Translate NEWS ke Bahasa Indonesia** (S272, 2026-08-02 — toggle 🇮🇩/🇬🇧 di tab NEWS, field tambahan `title_id`/`desc_id`, teks Inggris asli TETAP dipertahankan utuh untuk `newscat.js`/filter TEK/push notif. Riwayat provider hari yang sama, 3 percobaan gagal terverifikasi live sebelum settle: (1) Gemini→SambaNova akun 2 murni ganti provider — circuit breaker trip berulang (22x), akun dipakai bersama 3 fitur lain; (2) balik Gemini + desain **BATCH** (1 panggilan API sampai 20 headline sekaligus, bukan 1/headline) — 429 `RESOURCE_EXHAUSTED`, kuota Gemini cuma 20 request/HARI (bukan 1.500 RPD seperti asumsi lama); (3) balik SambaNova akun 2 + batch + fix `AbortSignal` (panggilan lambat dibatalkan tegas, bukan orphaned di background) — TETAP trip lagi (72x ~1 jam pasca-deploy), akun itu sendiri terbukti tidak stabil (tes isolasi timeout 20+ detik bahkan untuk 3 headline). **Final: Mistral** (`mistral-small-latest`) — satu-satunya kandidat dari 3 yang dites ulang (SambaNova akun 1, Gemini flash-lite, Mistral) TANPA kontensi fitur produksi lain sama sekali, 3/3 ronde tes konsisten ~5,5 detik, akurasi terjemahan setara/lebih baik (konversi format angka EN→ID lebih presisi)). **Safeguard tambahan (2026-08-05, insiden translate macet total — lihat daun_merah.md):** deskripsi per headline dalam batch prompt dipotong maks 1200 char (item outlier seperti "MUFG FX Daily Snapshot" bisa >5000 char, bikin satu batch selalu timeout); item yang gagal >5x beruntun (`news_tr_fail:<guid>`) MENYERAH permanen (biarkan bahasa Inggris) alih-alih terus jadi kepala antrean FIFO yang memblokir headline baru di belakangnya. | Toggle bahasa (bukan tombol generate — otomatis di background) | Ya — tiap cache RSS di-refill (~50-60 detik, jendela live) DAN cron `news_translate_backfill` tiap 5 menit (arsip 36 jam PENUH, proaktif — bukan cuma pas "Muat Berita Lebih Lama" diklik) & tiap "Muat Berita Lebih Lama", batch sampai 20 headline/panggilan, hasil dishare semua user | 36 jam per guid (`news_tr:<guid>`, samakan retensi `news_history`) — 1x translate seumur cache, tidak diulang | Tidak ada rate limit per-IP khusus (bukan endpoint user-triggered); dibatasi jatah harian `mistral_newstranslate` (lihat §4) |

Semua 6 tombol AI di atas sekarang punya **cooldown 90 detik di browser** (disimpan in-memory, reset saat reload — pola sama Uji Kelemahan/Pre-Entry Check) — jadi secara wajar 1 orang tidak bisa klik lebih dari sekali per 90 detik meski server sendiri masih izinkan lebih cepat dari itu.

---

## 3. Detail per Fitur

### 3.1 Ringkasan Berita — `api/market-digest.js`

**[2026-08-31, Session 337] Cakupan fitur ini dipersempit jadi MAKRO MURNI.** Keputusan user: *"RINGKASAN UNTUK MAKRO, ANALISA UNTUK TEKNIKAL"*. Data yang **TIDAK LAGI** dikirim ke Call 1 maupun Call 3: price action multi-timeframe (XAU & pair FX), TA harian (RSI/SMA), skew opsi 25-delta, positioning COT, dan korelasi cross-asset. Semuanya sudah ditangani tab Analisa per Pair (`_formatFundamentalBlock` + Step 8 di `admin.js`), jadi tidak ada informasi yang hilang dari sistem. Yang tersisa sebagai input: headline (36 jam), kalender ekonomi, real yield + likuiditas + kurva imbal hasil, risk regime (VIX/MOVE/HY), rate path Fed Funds, status keputusan CB terdekat, Polymarket, harga XAU/USD (hanya level + %perubahan), dan riwayat sesi sebelumnya. Prompt sekarang punya **GERBANG TEMA**: tema tanpa jangkar headline/kalender wajib dibuang, bukan diisi angka pasar. Alasan & audit lengkap: `daun_merah.md` §Session 337.

**Fetch cache yang tetap jalan walau datanya tidak dipakai prompt:** `cot_cache_v2`, `rr_cache_v2`, `correlations_v3` — cron Ringkasan adalah **pemanas cache** untuk tab Analisa & jalur auto-entry (POLICY_EPOCHS v35). Jangan dihapus; sudah dikunci tes regresi.

Satu kali "generate" sebenarnya adalah **3-4 panggilan AI sekaligus**, bukan 1:

| Sub-panggilan | Isinya | Kapan jalan |
|---|---|---|
| **Call 1** | Narasi briefing FX Bahasa Indonesia (paragraf) | Selalu |
| **Call 2** | Bias bank sentral per currency, format JSON terstruktur | Selalu |
| **Call 3** | Trade thesis (ide entry berbasis makro), format JSON | Selalu |
| **Call 4** | Cek headline baru vs thesis terbuka user (thesis alert) | **Hanya** kalau ada `device_id` DAN device itu punya posisi terbuka — jadi otomatis dilewati saat cron jalan (cron tidak bawa device_id) |

**Kapan generate penuh terjadi:**

- **Otomatis (cron):** 3×/hari via GitHub Actions — 07:00, 14:00, 19:30 WIB (jam buka sesi Asia/Eropa/New York). Cron ini TIDAK kena rate limit apapun (diautentikasi lewat secret) dan TIDAK kena gate di bawah — selalu generate fresh.
- **Manual:** tombol "Ringkas Berita"/"Ringkas Ulang" — siapa pun bisa klik kapan saja, dibatasi cooldown 90 detik/device + rate limit server 4x/menit/IP + single-flight lock global (session 157 lanjutan, lihat di bawah).

**Single-flight lock (`lock:market_digest_generate`, TTL 55 detik) — cegah burst request bersamaan boros AI:**

Call 1/2/3 hasilnya SAMA untuk semua orang (ditulis ke `latest_article`, satu key Redis global), jadi kalau banyak device klik "Ringkas Ulang" hampir bersamaan, generate ulang berkali-kali cuma menghasilkan kalimat beda-beda dari data yang sama — bukan informasi baru. Sekarang: request PERTAMA yang lolos rate limit mengunci `lock:market_digest_generate` lalu generate seperti biasa. Request LAIN yang datang selagi lock masih hidup (baik karena generate lagi berlangsung ATAU baru saja selesai — lock TIDAK di-release manual, TTL 55 detik dibiarkan jadi cooldown alami) langsung disajikan `latest_article` apa adanya, **tanpa** ikut generate — nol tambahan panggilan AI. Pengecualian: kalau `latest_article` benar-benar kosong (cold start, belum pernah ada cache sama sekali), request tetap lanjut generate walau lock dipegang, supaya user tidak dapat respons kosong. `thesis_alerts` di-null-kan pada respons short-circuit ini karena itu data personal (Call 4) — device yang "kalah" lock tidak ikut menampilkan alert milik device lain.

**Rantai fallback provider (2026-08-12 — SambaNova akun-1/akun-2 diputus kontrak total, dihapus dari semua Call 1-4; sebelumnya 2026-07-25 OpenRouter/Cerebras/Groq/Ollama sudah dihapus total dari kode):**

```
Call 1 (prosa):
  1. DeepSeek v4-pro (API resmi)          — PRIMARY produksi (promosi 2026-08-17 dari v4-flash, lihat daun_merah.md Session 317 lanjutan 2; max_tokens 1600, timeout 40s — v4-pro ~2x lebih lambat & lebih verbose dari flash)
  2. Google AI Studio (Gemini-Flash)      — fallback
  3. Template deterministik non-AI (berdasarkan kategori berita) — fallback absolut, tidak pernah kosong

Call 2 (bias bank sentral, JSON):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (response_format json_object native)
  2. Google AI Studio (Gemini-Flash)      — fallback (response_format native)
  (kalau semua gagal: bias bank sentral TIDAK diupdate siklus itu — data lama di Redis tetap dipakai, bukan kosong/error)

Call 3 (trade thesis, JSON):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY/SATU-SATUNYA (maxTokens 1500 — dokumen ini sempat tertulis 1200, dikoreksi 2026-08-18 setelah dicek ke kode; truncation JSON thesis 13 field tetap jadi alasan angkanya dipatok, dan sejak 2026-08-18 kejadian kepotong dideteksi lewat finish_reason=length di log)
  (kalau gagal: tidak ada trade thesis baru ditampilkan siklus itu, bukan error)

Call 4 (cek kontradiksi thesis terbuka):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY/SATU-SATUNYA (2026-08-12, sebelumnya SambaNova akun-1 primary/satu-satunya di sini — diputus kontrak, DeepSeek langsung menggantikan slot ini supaya fitur Thesis Alert tidak mati total)
  (kalau gagal: tidak ada thesis alert siklus itu, bukan error)
```

**Saldo habis (HTTP 402) di tengah bulan (Plan O-4):** aiCall() melempar 402 sebagai error status biasa (tidak beda dari 429/500) — ditangkap catch di tiap tingkat, ditandai eksplisit `deepseek:HTTP402_insufficient_balance` di log/providerLog, lalu fallback lanjut otomatis ke Gemini (Call 1/2) atau gagal total tanpa jaring pengaman lain (Call 3/4, sekarang DeepSeek-only). TIDAK hang, TIDAK butuh perubahan kode setelah user top-up lagi — begitu saldo terisi, request berikutnya otomatis balik pakai DeepSeek (tidak ada circuit breaker permanen untuk 402, hanya threshold kegagalan beruntun yang sama seperti error lain).

**Riwayat Nemotron/Hermes/GLM (OpenRouter/Ollama/Cerebras) — DIHAPUS 2026-07-25:** sempat jadi kandidat primary Call 1 (session 162-163, kualitas bagus tapi latency 100% tidak terprediksi 7-41s), lalu didemote ke fallback cron-only, akhirnya dihapus total bersama kontrak vendornya (OpenRouter, Cerebras, Ollama Cloud diputus user). Riwayat lengkap eksperimen ada di git history / `daun_merah.md` kalau perlu rujukan — jangan diusulkan lagi tanpa alasan baru.

### 3.2 Analisa AI per Pair — `api/admin.js` (`action=ohlcv_analyze`)

15 pasangan yang dilacak: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, EUR/JPY, GBP/JPY, EUR/GBP, AUD/JPY, EUR/AUD, GBP/AUD, GBP/CAD, XAU/USD.

**Penting:** tombol "Analisa Pair Ini" **selalu memanggil AI baru setiap diklik** — tidak dicek dulu apakah sudah ada hasil baru-baru ini (beda dengan Analisa Fundamental di §3.3 yang pakai cache global). Yang menahan laju supaya tidak boros adalah:

- Cooldown 90 detik/device di UI.
- **Jendela kesegaran 10 menit (Plan T-5, Session 198 SESI-C):** `analisaFreshUntil[symbol]` — begitu satu pair berhasil dianalisa segar (manual atau via auto-chain di bawah), klik manual ulang pair yang sama dalam 10 menit **tidak mengirim request sama sekali**, cukup toast "tunggu X menit lagi". Reset per-symbol (in-memory, hilang saat reload), tidak berlaku kalau respons `market_closed` (lihat gate di bawah).
- **Gate pasar tutup (Plan T-1, Session 198 SESI-A):** di luar jam FX buka, endpoint tidak memanggil AI sama sekali — menyajikan `ohlcv_analysis:<symbol>` apa adanya (`market_closed:true`, nol AI call) atau pesan error kalau belum pernah ada cache untuk pair itu.
- **Auto-chain (Plan T-5, Session 198 SESI-C):** setiap klik manual "Ringkas Berita"/"Ringkas Ulang" yang sukses otomatis memicu **satu** panggilan tambahan ke fitur ini untuk pair yang sedang aktif di tab Analisa (default XAU/USD kalau tab belum pernah dibuka) — chain ini menembus cooldown 90 detik & jendela kesegaran (input baru = analisa baru), tapi tetap dibatasi oleh lock generate Ringkasan sendiri (§3.1) jadi tidak bisa spam. Kalau sedang gate pasar tutup, chain otomatis dilayani cache tanpa AI call (sama seperti klik manual).
- Rate limit server 5 request/menit/IP.
- Jatah harian provider bersama (lihat §4).

Hasil tiap analisa disimpan 6 jam supaya kalau tab ditutup-buka lagi, versi terakhir bisa langsung tampil tanpa panggil AI ulang (mode baca cepat, `mode=cached`).

**Otomatis:** hanya XAU/USD, 3×/hari, nempel di jadwal cron Ringkasan Berita (workflow yang sama, langkah kedua).

**Rantai (Plan O-6, 2026-07-18; 2026-08-12: SambaNova akun-1/akun-2, dulu fallback berurutan di sini, diputus kontrak total):** DeepSeek v4-flash — PRIMARY/SATU-SATUNYA, tanpa Groq/Cerebras (sudah tidak ada sejak dulu di rantai ini) dan tanpa SambaNova lagi. DeepSeek dipromosikan jadi primary setelah gate diagnostik `?test_deepseek=1` lolos 3/3 sampel live (XAU/USD, EUR/USD, GBP/JPY): JSON valid, entry/SL/TP konsisten arah & RR positif, tidak ada kontaminasi angka antar-pair (kekhawatiran utama sebelum promosi). Kalau DeepSeek gagal, fitur ini **langsung menampilkan "AI tidak tersedia"**, tidak ada jaring pengaman lain — data teknikal deterministik (candle, level S/R, dsb) tetap tampil apa adanya, cuma commentary/setup AI-nya kosong.

### 3.3 Analisa Fundamental — `api/admin.js` (`action=fundamental_analysis`)

Ini fitur AI yang **paling hemat** secara desain: hasilnya di-cache **6 jam untuk SEMUA orang** (satu key Redis global, bukan per-user/per-device), dan frontend tidak pernah minta "paksa refresh".

> **Berapa pun banyak orang yang klik tombol ini, AI-nya paling banyak benar-benar jalan 4 kali sehari** (24 jam ÷ 6 jam cache) — sisanya semua orang cuma baca hasil yang sama dari cache.

**Provider (2026-08-12): Gemini flash — PRIMARY/SATU-SATUNYA, retry 1x + jeda 2s.** Riwayat: 2026-08-10 sempat Gemini-only (503 transient bikin HTTP 500 di produksi, lihat `daun_merah.md` Session 307) → 2026-08-11 didemote jadi fallback di belakang SambaNova akun-2 (permintaan eksplisit user saat itu, Gemini dianggap kualitas lebih lemah) → 2026-08-12 SambaNova akun-2 diputus kontrak total (akun diblokir billing SambaNova sendiri, "A payment method is required", ganti API key tidak memperbaikinya — lihat `daun_merah_vendor.md`) sehingga Gemini dipromosikan BALIK jadi primary/satu-satunya. Retry 1x tetap dipasang (Gemini free tier sesekali balas 503 "overloaded" transient, percobaan ulang identik langsung sukses) — circuit breaker/budget guard cuma dicatat gagal kalau kedua percobaan gagal.

**[2026-08-25, Session 328] Circuit breaker dipisah dari fitur lain** (sebelumnya key `'ai:gemini'` dipakai bersama Ringkasan Berita & AI Coach Jurnal, burst kegagalan di satu fitur bisa memblokir fitur ini juga selama 5 menit — lihat detail di §3.4 AI Coach Jurnal atau `daun_merah.md` Session 328). Key sekarang: `ai:gemini:fundamental`.

**Prompt dirombak (2026-08-10)** dari sekadar "ranking terkuat→terlemah + divergensi" jadi sintesa penuh: tema makro lintas-currency, outlook per currency (rezim pertumbuhan-inflasi + arah kebijakan moneter + tenaga kerja + confidence data), ranking, setup fundamental paling searah, dan bagian "Perlu Diwaspadai" (flag currency berdata tipis/basi atau momentum baru berbalik). `max_tokens` dinaikkan 1500→2200→**3500** (2200 terbukti masih memotong output di tengah kalimat pada test live — lihat changelog `daun_merah.md` Session 298). Output juga di-pasang backstop `_stripMarkdown()` server-side karena instruksi prompt "jangan pakai markdown" saja terbukti tidak cukup dipatuhi provider manapun.

**Pergerakan ranking vs update sebelumnya (2026-08-11):** sesudah AI generate, server parse deterministik section "RANKING KEKUATAN FUNDAMENTAL:" (regex, BUKAN diminta AI menghitung sendiri — rawan salah hitung), simpan urutan 8 currency ke field `ranking` di cache Redis, lalu bandingkan dengan `ranking` dari cache generasi sebelumnya. Kalau ada data lama untuk dibandingkan, blok "PERGERAKAN RANKING VS UPDATE SEBELUMNYA (~X jam lalu): USD naik ke #2 (dari #4). ..." ditempel ke akhir teks `analysis` — murni hasil hitungan kode, bukan narasi AI, jadi tidak bisa hallucinate. Generasi pertama (belum ada cache lama, atau format ranking AI menyimpang dari 8 currency) melewati blok ini secara diam-diam (fail-open), bukan error.

### 3.4 AI Coach Jurnal — `api/journal.js` (`action=analyze`)

Menganalisis pola menang/kalah dari trade yang sudah ditutup (butuh minimal 3 trade closed). Cache 1 jam **per device** (device lain / hari lain dapat cache masing-masing), dan ada tombol "paksa ulang" yang melewati cache.

**Provider (2026-08-12): Gemini flash — PRIMARY/SATU-SATUNYA.** SambaNova akun-2 (dulu primary di sini, Cerebras/Groq sudah dihapus lebih dulu 2026-07-25) diputus kontrak total — lihat `daun_merah_vendor.md`. Retry 2x + jeda 2s antar percobaan (2026-08-25, sebelumnya sekali gagal langsung mati total — Gemini free tier sesekali balas 503 "high demand" transient, tapi retry beruntun tanpa jeda sering kena kondisi overload identik; timeout per percobaan 20s).

**[2026-08-25, Session 328] Circuit breaker dipisah dari fitur lain.** Sampai sesi ini, key circuit breaker Redis (`'ai:gemini'`) dipakai BERSAMA Ringkasan Berita (`market-digest.js`) dan Analisa Fundamental (`admin.js`) — burst 503 di Ringkasan Berita (fitur paling sering panggil Gemini) bisa men-trip circuit dan ikut memblokir fitur ini selama 5 menit walau AI Coach Jurnal sendiri tidak pernah gagal, dengan pesan error yang membingungkan (menyebut literal "GEMINI_API_KEY" walau bukan soal key). Sekarang key-nya sendiri: `ai:gemini:journal`. Detail lengkap: `daun_merah.md` Session 328.

**[2026-08-25] Nemotron 3 Ultra (OpenCode Zen, gratis) SEMPAT dicoba sebagai primary di sini, DIBATALKAN hari yang sama.** Awalnya terlihat menjanjikan — dikalibrasi khusus untuk tugas ini (4 trade, 6 section, ≤500 kata): selesai natural (`finish_reason=stop`) di ~16 detik. Tapi dokumentasi resmi OpenCode Zen sendiri ternyata menyatakan Nemotron Free **"Trial use only — do not submit personal or confidential data"** + wajib setuju **NVIDIA API Trial Terms of Service** — PERSIS blocker yang sama sudah bikin Nemotron ditolak 2026-08-11 lewat jalur lain (NVIDIA NIM/OpenRouter, lihat `daun_merah_vendor.md` §2), dan data jurnal trading (thesis, catatan personal trader) termasuk kategori data yang eksplisit dilarang dikirim. Jangan diusulkan ulang untuk fitur produksi manapun tanpa ToS berubah. (Untuk Analisa Fundamental §3.3, Nemotron juga TERBUKTI secara terpisah tidak muat di batas waktu Vercel manapun untuk prompt sebesar itu — >150 detik, tidak pernah selesai — jadi dua alasan independen sama-sama mengeliminasi Nemotron dari kedua fitur ini.)

### 3.5 Pre-Entry Check — `api/admin.js` (`action=pre_entry_check`, Plan R 2026-07-18)

Berbeda dari 4 fitur di atas: **fact sheet dibangun 100% client-side** (checklist state cuma hidup di localStorage per-device, tidak ada di Redis), bukan fetch server dari cache. Kode client (`ckAutoTick`/`ckAutoBlock`/`ckAutoTickFromAnalisa` di `index.html`) sudah men-auto-tick semua item yang datanya tersedia (CB bias, COT, real yield, retail sentiment, kalender, OHLCV/pola candle, sizing calculator) SEBELUM tombol ditekan — endpoint ini menerima daftar item lengkap (status FAKTA-tick/FAKTA-block/manual-checked/manual-unchecked + evidence tiap item auto), lalu **satu call AI** menilai HANYA item manual yang masih kosong + mencari kontradiksi logis antar item FAKTA. Server TIDAK fetch Redis apa pun untuk fitur ini — payload dari client sudah cukup.

**Provider:** DeepSeek v4-flash — PRIMARY/SATU-SATUNYA (sama seperti Ringkasan Berita; SambaNova akun-1, dulu fallback di sini, diputus kontrak total 2026-08-12). Kalau gagal: `error: 'ai_unavailable'`, client tampilkan skor deterministik saja dengan label "penilaian AI tidak tersedia" — fitur tetap berguna tanpa AI, bukan mati total.

**Garis keras (desain, bukan implementasi teknis):** verdict LAYAK/TIDAK LAYAK adalah **konteks keputusan, bukan sinyal eksekusi** — tidak ada auto-entry di jalur mana pun, user tetap yang menekan tombol entry MT5/manual sendiri.

### 3.6 Auto-Entry Virtual + Uji Konsistensi LLM — `vps/daemon.js` → `api/admin.js` (`action=ohlcv_analyze&auto=1`, Plan U-3)

**Analisa teknikal (setup entry/SL/TP) untuk call `auto=1` ini memakai provider PERSIS SAMA dengan Analisa AI per Pair §3.2** — DeepSeek v4-flash (primary/satu-satunya sejak 2026-08-12), berbagi jatah harian yang sama, bukan pool terpisah. Bedanya murni di sisi penulisan data (lihat §2 baris #7/#8 dan `Dokumentasi/daun_merah.md` Session 201 §U-7): call `auto=1` TIDAK menulis cache `ohlcv_analysis:<symbol>` (publik tidak pernah melihat hasilnya) dan setup masuk `setup_log_auto:v1` (bukan log manual publik).

**Volume tambahan ke pool DeepSeek (DIPERBARUI 2026-08-25, AATAS v2):** satu evaluasi kandidat auto sekarang **2 panggilan** (Call 1 makro + Call 2 teknikal), bukan 1 — kecuali kalau Gate 1 gagal, yang menghentikannya di 1 panggilan. Uji konsistensi (×3) ikut jadi 2 panggilan per probe karena memakai prompt auto yang sama. Beban harian tipikal: 5 pair × 2 slot = 10 kandidat; kalau separuh lolos Gate 1 → 10 + 5×2 = 20, plus probe 3×2 = 6, ditambah Gate A (maksimal +2) → **±26-28 request/hari** (dulu ±5-9). Pool `deepseek_experimental` dinaikkan 15 → 35 mengikuti (`api/_ai_guard.js`). Biaya per call JUSTRU TURUN — Call 1 tidak membawa candle/indikator, Call 2 tidak membawa blok makro — jadi kenaikan jumlah request tidak berarti kenaikan biaya sebanding.

**[2026-08-25, AATAS v2] Satu panggilan `auto=1` dipecah jadi DUA panggilan terpisah.** Call 1 hanya menerima blok makro (Ringkasan, fundamental terstruktur, rate path, sentimen options CME, kalender) — **nol data teknikal/candle/indikator** — dan menentukan arah; Call 2 hanya menerima blok teknikal (struktur, S/R, fibonacci, zona konfluensi, kandidat SL/TP, track record, rezim volatilitas, kalender) dengan arah Call 1 sebagai fakta terkunci, dan menentukan lokasi/waktu/risiko. Pembacaan momentum (`[INDIKATOR Daily]` yang memuat RSI, `[MACD H4]`, `[RSI-14 H4]`) TIDAK dikirim ke Call 2. Alasannya bukan penghematan: 2 dari 4 setup live pertama AATAS v1 melanggar larangan RSI/arah-pinjaman yang cuma berupa imbauan teks, jadi datanya sekarang memang tidak sampai ke panggilan penentu arah. Gate Step 1-2 juga tidak lagi laporan bebas AI — ditegakkan ulang kode. Jalur manual publik §3.2 tetap NOL perubahan (byte-identik, diverifikasi terhadap commit sebelumnya). Detail: `Dokumentasi/professional_llm_trader/changelog.md` §Session 329.

**[2026-08-22, AATAS v1] PROMPT jalur `auto=1` mulai BERBEDA dari §3.2 (provider & volume waktu itu belum berubah).** Sebelumnya dua jalur berbagi prompt yang sama persis; sejak AATAS, call `auto=1` mendapat blok `[CHECKLIST AATAS]` (urutan keputusan Step 0-9, makro dulu baru teknikal) dan skema field JSON yang berbeda: `makro_alignment`/`confidence` DIGANTI `regime_check`/`fundamental_bias`/`technical`/`gate_*`/`checklist_pct`/`verdict`/`reasoning_note`. Jalur manual publik §3.2 TIDAK berubah sama sekali (prompt-nya diverifikasi byte-per-byte identik dengan versi sebelumnya). Ukuran prompt jalur auto bertambah sekitar 4-5 KB (blok checklist + definisi field), jawaban model juga lebih panjang karena field terstruktur bertambah — masih jauh di bawah batas token, tapi ikut dicatat di sini karena memengaruhi biaya per call. Versi teks checklist distempel per setup (`aatas_v`) — naikkan `AATAS_PROMPT_VERSION` di `api/admin.js` setiap kali teksnya direvisi. Detail: `Dokumentasi/professional_llm_trader/changelog.md` §Session 326.

**[2026-08-04, Track 2a "Road to Professional LLM Trader"] +1 call/hari khusus AUD/NZD:** slot ke-3 (`AUTO_ENTRY_HOURS_UTC_AUDNZD`, default 00:00 UTC/07:00 WIB, sesi Sydney-Tokyo) menambah **+1 request/hari** ke pool yang sama, HANYA untuk pair `frxAUDNZD` — 3 pair lain (XAU/EUR/GBP) tidak bertambah call. Provider (DeepSeek v4-flash, primary/satu-satunya sejak 2026-08-12) TIDAK berubah untuk slot ini.

**[2026-07-28] Gate A "AI Kritikus" ("Sistem Hakim") otomatis (audit celah kesalahan trader, `daun_merah.md` Session 250):** setiap kandidat setup auto-entry yang lolos 3 gate murah (regime-confidence/correlation-cap/drawdown, `_auto_entry_guard.js`, murni kode — 0 AI call) sekarang direview 1x lagi oleh AI Kritikus (verdict "batalkan" → setup tidak disimpan) sebelum masuk `setup_log_auto:v1`.

**[2026-08-22, AATAS] Fact sheet Gate A untuk jalur auto berubah isinya** (bukan providernya): baris "Makro alignment: ..." diganti ringkasan checklist per-step (skor, verdict, status regime check, fundamental bias, teknikal, validasi akhir, catatan penalaran). Tombol manual publik "UJI KELEMAHAN" (§3.7) TIDAK berubah.

**Provider Kritikus Gate A:** DeepSeek v4-flash, pool eksperimen `ai:deepseek:experimental`/`deepseek_experimental` (SambaNova akun 1, primary lama di sini, diputus kontrak total 2026-08-12) — SAMA pool yang dipakai fallback Call 4/Analisa AI per Pair jalur auto-entry di atas. Tombol manual publik "UJI KELEMAHAN" (§3.7, handler `ohlcv_critic`) tetap DeepSeek juga tapi pool PRODUKSI terpisah (`ai:deepseek`/`deepseek`) supaya isolasi U-7 tetap terjaga (tidak rebutan kuota dengan traffic publik).

- Volume: maksimal +2 call/hari (1 per slot auto-entry berhasil, hanya kalau setup itu genuinely baru — tidak jalan untuk kandidat yang sudah ditahan gate lain atau dup/blocked existing).

### 3.7 Review Posisi Virtual — `api/admin.js` (`action=position_review`, Plan U-5a/U-5b)

Trigger event-driven dari daemon (headline market-moving/geopolitical yang match currency setup eksperimen `open`), **bukan jadwal tetap**. Provider: DeepSeek v4-flash saja, pool eksperimen `ai:deepseek:experimental`/`deepseek_experimental` (SambaNova akun-1, primary lama di sini, diputus kontrak total 2026-08-12; Groq dulu jadi fallback terakhir, dihapus 2026-07-25 — kalau DeepSeek gagal, langsung downgrade ke HOLD, fail-safe kode). Dibatasi cooldown 6 jam/posisi + cap 3 review/hari (kode, bukan AI) — **maksimal +3 call/hari** ke pool yang sama.

### 3.8 Tighten Preventif Weekend Gap — `api/admin.js` (`action=friday_tighten`, Plan U-3 lanjutan, 2026-07-24)

**0 call AI — murni kode.** Beda dari §3.7 di atas: itu reaktif (LLM menilai berita), ini jadwal buta 1x/minggu (Jumat, `FRIDAY_TIGHTEN_HOUR_UTC`) yang menggeser SL semua posisi eksperimen `open` ke titik tengah SL-lama/harga-sekarang (`computePreventiveTightenSl`), TANPA menilai konteks apa pun — alasannya "market tutup 2 hari, tidak bisa react apa-apa selama itu", bukan sinyal risiko spesifik. Dicatat di sini murni supaya tidak disangka ikut menambah beban pool AI manapun.

---

## 4. Jatah Harian (Budget Guard) — `api/_ai_guard.js`

Ini lapisan pembatas paling penting untuk dipahami. **Jatah ini dibagi rata ke semua fitur yang pakai provider yang sama** — bukan per-fitur. Kalau salah satu fitur boros, fitur lain yang berbagi provider ikut kena dampak (fallback ke tingkat berikutnya, bukan error — lihat §5).

| Provider | Jatah harian (buatan sendiri) | Limit resmi provider | Dipakai untuk |
|---|---|---|---|
| Google AI Studio (Gemini) | **16 request/hari (buatan sendiri, DIFIX 2026-08-27** — sebelumnya 200, sama sekali tidak melindungi karena Google sudah menolak duluan di request ke-21) | ~~10 RPM, 1.500 RPD~~ **TERBUKTI SALAH 2026-08-02**: alias `gemini-flash-latest` resolve ke `gemini-3.6-flash`, limit REAL cuma **20 request/HARI** (429 `RESOURCE_EXHAUSTED` terverifikasi live, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) | **PRIMARY/SATU-SATUNYA Analisa Fundamental & AI Coach Jurnal** (sejak 2026-08-12) + fallback Call 1/2 Ringkasan Berita — 2 fitur primary BERBAGI kuota 20/hari yang sama Google, worst-case gabungan (Fundamental 8 + Jurnal ±5-10, keduanya termasuk retry) bisa dekat sekali ke 20. **Opsi API key Gemini KEDUA (pola sama split Upstash Redis) DITUNDA 2026-08-27** — user cek pemakaian real, masih sedikit/jauh di bawah 16/hari, jadi belum perlu. Revisit kalau `ai_budget.gemini` (`admin?action=health`) sering mendekati 16 |
| DeepSeek API resmi | 50 request/hari (PAGAR BIAYA — provider berbayar dari saldo top-up user, bukan free tier) | Tidak ada limit request; yang membatasi saldo (top-up $2, 2026-07-18, burn rate live ±$0.0033/generate) | **PRIMARY/SATU-SATUNYA** Call 1/2/3/4 Ringkasan Berita, Analisa AI per Pair, Pre-Entry Check, Review Posisi Virtual (sejak 2026-08-12, setelah SambaNova diputus kontrak) |
| Mistral — bucket `mistral_newstranslate` | 1000 request/hari (= 1000 PANGGILAN, bukan 1000 headline — 1 panggilan berisi batch sampai 20 headline), **TERPISAH** dari bucket `mistral` (200/hari, diagnostik manual) di atas | ±1M token/bulan (jauh lebih longgar per-request daripada provider lain, konservatif) | **HANYA** Translate NEWS (#10) — provider FINAL setelah beberapa percobaan gagal (riwayat lengkap di baris #10 §2). Satu-satunya provider translate yang TIDAK dipakai fitur produksi lain sama sekali, jadi nol risiko rebutan kuota |

**⚠️ TEMUAN PENTING (2026-08-02, ditemukan saat debug translate NEWS; makin krusial sejak 2026-08-12 karena Gemini jadi PRIMARY 2 fitur, bukan cuma fallback):** limit resmi Gemini free tier BUKAN 1.500 RPD seperti dokumentasi lama — provider mengembalikan HTTP 429 `RESOURCE_EXHAUSTED` dengan pesan eksplisit "limit: 20, model: gemini-3.6-flash" saat dites live. Google tidak lagi publikasikan angka statis di dokumentasi rate-limit (harus cek dashboard AI Studio live), dan alias `gemini-flash-latest` sudah bergeser generasi model 3x (2.5→3.5→3.6) tanpa mengubah kode kita — tiap pergeseran berpotensi mengubah kuota gratis secara diam-diam. Kalau Analisa Fundamental atau AI Coach Jurnal tiba-tiba gagal terus, JANGAN asumsikan 1.500 RPD sebagai batas aman — cek dulu error message aslinya, curigai limit 20/hari ini duluan.

**SambaNova (akun-1 & akun-2) — DIPUTUS KONTRAK TOTAL 2026-08-12.** Root cause: akun diblokir billing SambaNova sendiri ("A payment method is required"), ganti API key tidak memperbaiki. Sebelum diputus, akun 2 juga terbukti (2026-08-02) punya latensi SANGAT TIDAK KONSISTEN terlepas dari volume panggilan (2 detik kadang, timeout 20+ detik lain waktu) — akun itu sendiri memang tidak stabil, bukan soal desain kode. Detail lengkap kronologi & penggantinya per fitur di `daun_merah_vendor.md`.

**OpenRouter, Cerebras, Groq, Ollama Cloud — kontrak diputus user 2026-07-25.** Semua kode chain-nya (fallback produksi maupun jalur diagnostik `?test_nemotron=1` dkk) sudah dihapus dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`; env var-nya dihapus dari Vercel. Kalau ada laporan salah satu fitur AI gagal dan providernya masih disebut Cerebras/Groq/OpenRouter/Ollama/SambaNova di log lama — itu log basi dari sebelum tanggal cutover masing-masing, bukan indikasi provider itu masih dipakai.

**Pool yang paling perlu diawasi: Google AI Studio (Gemini).** Sekarang PRIMARY (bukan cuma fallback) untuk 2 fitur publik dengan kuota resmi cuma 20/hari — headroom-nya tipis. Guard buatan sendiri sudah diselaraskan ke 16/hari (2026-08-27, lihat §4) supaya benar-benar memproteksi, bukan cuma angka besar yang tidak pernah trip.

**Kenapa angkanya sengaja lebih rendah dari limit resmi provider?** Supaya selalu ada headroom untuk retry otomatis dan supaya 1 hari yang tiba-tiba ramai tidak langsung mentok di detik-detik terakhir kuota resmi. Override manual bisa lewat env var `AI_DAILY_LIMIT_{PROVIDER}` kalau suatu saat perlu dinaikkan.

---

## 5. "Paling Banyak Dipakai Berapa Kali?" — Estimasi dalam Bahasa Sederhana

Ini jawaban langsung untuk pertanyaan "penggunaan paling banyak fitur AI itu berapa kali", dipecah per fitur:

### Ringkasan Berita

- **Otomatis:** pasti 3× sehari, tidak bisa lebih, tidak bisa kurang (jadwal tetap). Tiap generate normal = 4 request DeepSeek (Call 1-4) dalam skenario normal (DeepSeek sehat); Gemini (Call 1/2 fallback) request-nya nol.
- **Manual:** setiap 1× klik "Ringkas Ulang" bisa menambah beban Gemini KALAU DeepSeek gagal — dalam kondisi normal, DeepSeek primary yang menyerap sebagian besar beban (dibatasi pagar biaya 50/hari).
- **Kesimpulan sederhana:** DeepSeek (pagar 50/hari BERBAYAR) tetap jadi bottleneck utama — begitu DeepSeek habis/gagal untuk Call 1/2, otomatis pindah ke Gemini (fallback); Call 3/4 sekarang DeepSeek-only (2026-08-12, SambaNova yang dulu jadi fallback di sini sudah tidak ada), jadi kalau DeepSeek gagal untuk Call 3/4, tidak ada jaring pengaman lain.

### Analisa AI per Pair

- **Otomatis:** 3× sehari, khusus XAU/USD saja (lewat DeepSeek, ikut cron Ringkasan Berita).
- **Manual:** dibatasi 5 klik/menit/IP oleh server dan 90 detik cooldown/device oleh UI. **Setiap klik = 1 request** (DeepSeek primary/satu-satunya sejak 2026-08-12). Tidak ada cache-gate sebelum generate (beda dari Analisa Fundamental), jadi tiap klik selalu makan jatah.

### Analisa Fundamental

- **Maksimal mutlak: 4 generate sehari**, apapun yang terjadi (cache global 6 jam, tidak ada tombol paksa refresh di UI). Fitur paling "aman" dari sisi jatah AI. Per generate bisa sampai 2 request Gemini (retry 1x, sekarang dikasih jeda 2s antar percobaan sejak 2026-08-25 — dibuktikan manual retry beruntun tanpa jeda sering kena 503 "high demand" identik) — worst case realistis (8 request/hari) masih di bawah kuota resmi Gemini 20/hari, TAPI jauh lebih mepet dibanding dulu (pool SambaNova 200/hari) — lihat catatan kuota Gemini di §4.

### AI Coach Jurnal

- Terikat pada aktivitas trading nyata user (butuh ≥3 trade closed) — secara alami jarang dipanggil. Ada tombol paksa ulang, jadi 1 device yang aktif bisa memicu beberapa kali sehari kalau memang lagi banyak menutup/mengevaluasi trade, tapi cache 1 jam/device tetap membatasi ini secara wajar. Provider Gemini sama dengan Analisa Fundamental — dua fitur ini SEKARANG berbagi kuota 20/hari yang sama, jadi hari yang ramai di salah satunya mengurangi headroom yang lain. (Nemotron 3 Ultra/OpenCode Zen sempat dicoba gantikan Gemini di sini 2026-08-25, dibatalkan hari yang sama karena ToS "trial use only" — lihat §3.4.)

### Total gabungan (skenario ramai realistis dalam 1 hari)

| Fitur | Perkiraan maksimal wajar/hari | Pool yang dipakai |
|---|---|---|
| Ringkasan Berita (otomatis, 3× cron) | 3-12 request DeepSeek (Call 1-4, fallback Call 1/2: Gemini) | DeepSeek → Gemini (Call 1/2 saja) |
| Ringkasan Berita (manual, ~15-20× klik/hari wajar) | ±15-20 request DeepSeek | DeepSeek → Gemini (Call 1/2 saja) |
| Analisa AI per Pair (otomatis + manual) | ±63-78 request | DeepSeek (primary/satu-satunya) |
| Analisa Fundamental | maksimal 8 request | Gemini (primary/satu-satunya, retry 1x + jeda 2s) |
| AI Coach Jurnal | ±5-10 request | Gemini (primary/satu-satunya, retry 1x + jeda 2s) |
| Auto-Entry Virtual + Uji Konsistensi LLM (Plan U-3, §3.6) | ±20-26 request (AATAS v2, 2026-08-25: tiap kandidat 2 panggilan — Call 1 makro + Call 2 teknikal; Gate 1 gagal berhenti di 1. Probe konsistensi 3×2) | DeepSeek eksperimen (pool `deepseek_experimental`, 35/hari) |
| Sistem Hakim Gate A (bagian dari auto-entry di atas) | maksimal +2 request/hari | DeepSeek eksperimen |
| Review Posisi Virtual (Plan U-5a/b, §3.7) | maksimal +3 request (event-driven, cap harian kode) | DeepSeek eksperimen |

**Bottleneck utama sekarang DeepSeek (50/hari, berbayar)** untuk hampir semua fitur — SambaNova yang dulu jadi jaring pengaman 200/hari sudah tidak ada lagi (diputus kontrak 2026-08-12), jadi begitu DeepSeek habis/gagal, sebagian besar fitur (Call 3/4 Ringkasan, Analisa AI per Pair, Pre-Entry Check) langsung tanpa fallback AI sama sekali.

---

## 6. Kalau Semua Fallback di Satu Rantai Habis/Gagal

Sejak SambaNova diputus (2026-08-12) — Cerebras/Groq/OpenRouter/Ollama lebih dulu (2026-07-25) — rantai fallback jadi lebih pendek lagi (1-2 tingkat untuk sebagian besar fitur, lihat §3). Kalau semua tingkat di satu rantai gagal, itu berarti salah satu dari dua hal:

1. Semua provider di rantai itu gagal di hari yang sama (jarang, beda infrastruktur), atau
2. Jatah harian kita sendiri (§4) sudah habis di SEMUA provider dalam rantai tersebut.

**Analisa AI per Pair, Pre-Entry Check, Call 3/4 Ringkasan Berita, dan Review Posisi Virtual** sekarang DeepSeek-only (1 tingkat, tanpa fallback sama sekali) — paling rentan kalau DeepSeek bermasalah/saldo habis, karena tidak ada lagi SambaNova sebagai jaring pengaman kedua.

Ringkasan Berita Call 1 (prosa) punya pengaman ekstra di luar AI: kalau semua provider AI gagal, ada template non-AI berbasis kategori berita (lihat §3.1) — jadi khusus Call 1, "AI tidak tersedia" tidak pernah benar-benar terjadi di UI, cuma kualitasnya turun.

Kalau gagal total terjadi, user akan melihat pesan "AI tidak tersedia — coba beberapa saat lagi" di UI, bukan error yang membingungkan. Redis juga fail-open (kalau Redis down, guard `_ai_guard.js` otomatis mengizinkan panggilan lewat, bukan memblokir) — jadi masalah infrastruktur cache tidak pernah jadi alasan AI mati.

---

## 7. Model & Endpoint — Referensi Cepat

| Provider | Endpoint | Model ID yang dipakai | Peran saat ini | Env var |
|---|---|---|---|---|
| DeepSeek (API resmi, BERBAYAR) | `api.deepseek.com/chat/completions` | **Call 1 Ringkasan: `deepseek-v4-pro`** (2026-08-17, promosi — lihat `daun_merah.md` Session 317 lanjutan 2); **Call 2/3/4 + semua fitur lain: `deepseek-v4-flash`** (thinking disabled) | **PRIMARY/SATU-SATUNYA** — Ringkasan Berita Call 1-4, Analisa AI per Pair, Pre-Entry Check, Review Posisi Virtual, Sistem Hakim Gate A | `DEEPSEEK_API_KEY` |
| Google AI Studio | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-flash-latest` | **PRIMARY/SATU-SATUNYA** — Analisa Fundamental, AI Coach Jurnal; fallback Ringkasan Berita Call 1/2 | `GEMINI_API_KEY` |

**Dihapus 2026-08-12 (kontrak diputus user, billing lapse):** SambaNova akun-1 & akun-2 (`SAMBANOVA_API_KEY`, `SAMBANOVA_API_KEY_CALL1`) — env var dihapus dari Vercel (Production & Preview), semua kode chain/circuit/budget-nya dihapus dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`. Detail root cause di `daun_merah_vendor.md`.

**Dihapus 2026-07-25 (kontrak diputus user):** OpenRouter (`OPENROUTER_API_KEY`), Cerebras (`CEREBRAS_API_KEY`), Groq (`GROQ_API_KEY`), Ollama Cloud (`OLLAMA_API_KEY`) — env var dihapus dari Vercel, semua kode chain/diagnostik-nya dihapus dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`.

---

## 8. Catatan Perawatan

- Kalau mau menaikkan jatah harian salah satu provider, set env var `AI_DAILY_LIMIT_{PROVIDER}` di Vercel — jangan ubah `DEFAULT_LIMITS` di kode tanpa konfirmasi status akun aslinya dulu.
- Cek pemakaian real-time tanpa nambah counter: `getUsage(provider)` di `_ai_guard.js`, biasanya diekspos lewat `admin?action=health`.
- Kalau ada model/provider baru mau dicoba, selalu tes dulu via query param diagnostik terisolasi (pola `?test_gemini=1`/`?test_mistral=1`/`?test_nvidia=1`/`?test_deepseek=1`/`?test_deepseek_pro=1` yang masih ada) sebelum jadi primary permanen — pelajaran dari beberapa model yang "katanya gratis" ternyata 403/subscription-required saat dites nyata (lihat riwayat di [daun_merah.md](daun_merah.md)).
- `?test_deepseek_pro=1` (2026-08-17, ada di Call 1 `market-digest.js` DAN `ohlcv_analyze` `admin.js`) — bandingkan `deepseek-v4-pro` (3x harga per token vs `deepseek-v4-flash`) di data live identik. Hasil: di Call 1, pro lebih patuh aturan prompt & menangkap 1 tema tambahan (tapi 2,2x lebih lambat) — **model produksi DIGANTI ke pro untuk Call 1** (2026-08-17, lihat §7); di `ohlcv_analyze`, hasilnya nyaris identik (pro TIDAK memberi manfaat berarti di titik ini) — **model produksi TETAP flash** di sini. Kedua response diagnostik juga menyertakan field `debug_prompt` (system+user message persis yang dikirim ke model) untuk uji manual independen di web resmi DeepSeek. Detail lengkap di [daun_merah.md](daun_merah.md) Session 317 lanjutan 2.
