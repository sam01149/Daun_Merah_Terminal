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
> **Update besar terakhir:** 2026-07-25 — OpenRouter, Cerebras, Groq, Ollama Cloud diputus kontraknya (user), semua kode chain-nya dihapus. Chain sekarang murni DeepSeek (berbayar, saldo top-up) → SambaNova (2 akun, gratis) → Gemini (gratis) tergantung fitur.
> **Tujuan dokumen:** satu tempat untuk menjawab "fitur AI apa saja yang ada, dipanggil pakai model/provider apa, dan paling banyak dipakai berapa kali sehari" — supaya kalau ada laporan "AI error/limit habis", tinggal buka file ini dulu sebelum ngoprek kode.
> **Vendor & non-AI infra:** lihat [daun_merah_vendor.md](daun_merah_vendor.md).
> **Riset perbandingan provider (kenapa provider ini yang dipilih):** lihat [daun_merah.md § Research: Free AI Inference API Providers](daun_merah.md#research-free-ai-inference-api-providers-2026-05-28).

---

## 1. Cara baca dokumen ini (ringkas dulu, baru detail)

Aplikasi ini punya **4 fitur yang memanggil AI**. DeepSeek berbayar dari saldo top-up user (bukan free tier); SambaNova dan Gemini gratis. "Gratis" tetap ada plafonnya — baik dari provider aslinya maupun dari **jatah harian buatan sendiri** (`api/_ai_guard.js`) yang dipasang supaya satu fitur nakal (loop bug, di-spam) tidak menghabiskan kuota gratis punya fitur lain.

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

**Rantai fallback provider (2026-07-25 — OpenRouter/Cerebras/Groq/Ollama sudah dihapus total dari kode):**

```
Call 1 (prosa):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (Plan O-3, 2026-07-18, timeout 30s)
  2. SambaNova akun-2 (DeepSeek-V3.2)     — fallback 1 (primary lama sejak session 165, sekarang digeser)
  3. Google AI Studio (Gemini-Flash)      — fallback 2
  4. Template deterministik non-AI (berdasarkan kategori berita) — fallback absolut, tidak pernah kosong

Call 2 (bias bank sentral, JSON):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (response_format json_object native)
  2. SambaNova akun-1 (DeepSeek-V3.2)     — fallback 1
  3. Google AI Studio (Gemini-Flash)      — fallback 2 (response_format native)
  (kalau semua gagal: bias bank sentral TIDAK diupdate siklus itu — data lama di Redis tetap dipakai, bukan kosong/error)

Call 3 (trade thesis, JSON):
  1. DeepSeek v4-flash (API resmi)        — PRIMARY produksi (maxTokens 1200, cegah truncation JSON thesis skema 13 field)
  2. SambaNova akun-1 (DeepSeek-V3.2)     — fallback 1
  (kalau semua gagal: tidak ada trade thesis baru ditampilkan siklus itu, bukan error)

Call 4 (cek kontradiksi thesis terbuka):
  1. SambaNova akun-1 (DeepSeek-V3.2)     — PRIMARY produksi (SENGAJA TETAP SambaNova, bukan DeepSeek flash — jarang terpanggil, hemat saldo top-up)
  (kalau gagal: tidak ada thesis alert siklus itu, bukan error)
```

**Saldo habis (HTTP 402) di tengah bulan (Plan O-4):** aiCall() melempar 402 sebagai error status biasa (tidak beda dari 429/500) — ditangkap catch di tiap tingkat, ditandai eksplisit `deepseek:HTTP402_insufficient_balance` di log/providerLog, lalu fallback lanjut otomatis ke SambaNova. TIDAK hang, TIDAK butuh perubahan kode setelah user top-up lagi — begitu saldo terisi, request berikutnya otomatis balik pakai DeepSeek (tidak ada circuit breaker permanen untuk 402, hanya threshold kegagalan beruntun yang sama seperti error lain).

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

**Rantai fallback (Plan O-6, 2026-07-18):** DeepSeek v4-flash → SambaNova akun-1 (DeepSeek-V3.2) → SambaNova akun-2 (DeepSeek-V3.2) — 3 tingkat, tanpa Groq/Cerebras (sudah tidak ada sejak dulu di rantai ini, dan sekarang benar-benar terhapus dari kode). DeepSeek dipromosikan jadi primary setelah gate diagnostik `?test_deepseek=1` lolos 3/3 sampel live (XAU/USD, EUR/USD, GBP/JPY): JSON valid, entry/SL/TP konsisten arah & RR positif, tidak ada kontaminasi angka antar-pair (kekhawatiran utama sebelum promosi). Timeout SambaNova akun-1/akun-2 dibuat ADAPTIF terhadap sisa budget (bukan fixed 30s/25s lagi) supaya cascade 3-tier tetap di bawah 60s Vercel. Kalau ketiga tier gagal sekaligus, fitur ini **langsung menampilkan "AI tidak tersedia"**, tidak ada jaring pengaman lain.

### 3.3 Analisa Fundamental — `api/admin.js` (`action=fundamental_analysis`)

Ini fitur AI yang **paling hemat** secara desain: hasilnya di-cache **6 jam untuk SEMUA orang** (satu key Redis global, bukan per-user/per-device), dan frontend tidak pernah minta "paksa refresh".

> **Berapa pun banyak orang yang klik tombol ini, AI-nya paling banyak benar-benar jalan 4 kali sehari** (24 jam ÷ 6 jam cache) — sisanya semua orang cuma baca hasil yang sama dari cache.

**Provider (2026-08-11, keputusan eksplisit user — Gemini dianggap model lemah/kurang worth walau gratis):** SambaNova akun-2 (`DeepSeek-V3.2`) **primary** → Gemini flash **fallback**. Sempat 1 hari (2026-08-10) jadi Gemini-only tanpa fallback sama sekali — dibalik keesokan harinya setelah laporan user HTTP 500 di produksi (Gemini free tier terbukti sesekali balas 503 "overloaded" transient, lihat `daun_merah.md` Session 307). Primary (SambaNova akun-2) retry 1x kalau gagal sebelum jatuh ke fallback Gemini — circuit breaker/budget guard cuma dicatat gagal kalau kedua percobaan primary gagal.

**Prompt dirombak (2026-08-10)** dari sekadar "ranking terkuat→terlemah + divergensi" jadi sintesa penuh: tema makro lintas-currency, outlook per currency (rezim pertumbuhan-inflasi + arah kebijakan moneter + tenaga kerja + confidence data), ranking, setup fundamental paling searah, dan bagian "Perlu Diwaspadai" (flag currency berdata tipis/basi atau momentum baru berbalik). `max_tokens` dinaikkan 1500→2200→**3500** (2200 terbukti masih memotong output di tengah kalimat pada test live — lihat changelog `daun_merah.md` Session 298). Output juga di-pasang backstop `_stripMarkdown()` server-side karena instruksi prompt "jangan pakai markdown" saja terbukti tidak cukup dipatuhi provider manapun.

**Pergerakan ranking vs update sebelumnya (2026-08-11):** sesudah AI generate, server parse deterministik section "RANKING KEKUATAN FUNDAMENTAL:" (regex, BUKAN diminta AI menghitung sendiri — rawan salah hitung), simpan urutan 8 currency ke field `ranking` di cache Redis, lalu bandingkan dengan `ranking` dari cache generasi sebelumnya. Kalau ada data lama untuk dibandingkan, blok "PERGERAKAN RANKING VS UPDATE SEBELUMNYA (~X jam lalu): USD naik ke #2 (dari #4). ..." ditempel ke akhir teks `analysis` — murni hasil hitungan kode, bukan narasi AI, jadi tidak bisa hallucinate. Generasi pertama (belum ada cache lama, atau format ranking AI menyimpang dari 8 currency) melewati blok ini secara diam-diam (fail-open), bukan error.

### 3.4 AI Coach Jurnal — `api/journal.js` (`action=analyze`)

Menganalisis pola menang/kalah dari trade yang sudah ditutup (butuh minimal 3 trade closed). Cache 1 jam **per device** (device lain / hari lain dapat cache masing-masing), dan ada tombol "paksa ulang" yang melewati cache.

**Rantai fallback (2026-07-25, setelah Cerebras/Groq dihapus):** SambaNova akun-2 (DeepSeek-V3.2) → Gemini flash.

### 3.5 Pre-Entry Check — `api/admin.js` (`action=pre_entry_check`, Plan R 2026-07-18)

Berbeda dari 4 fitur di atas: **fact sheet dibangun 100% client-side** (checklist state cuma hidup di localStorage per-device, tidak ada di Redis), bukan fetch server dari cache. Kode client (`ckAutoTick`/`ckAutoBlock`/`ckAutoTickFromAnalisa` di `index.html`) sudah men-auto-tick semua item yang datanya tersedia (CB bias, COT, real yield, retail sentiment, kalender, OHLCV/pola candle, sizing calculator) SEBELUM tombol ditekan — endpoint ini menerima daftar item lengkap (status FAKTA-tick/FAKTA-block/manual-checked/manual-unchecked + evidence tiap item auto), lalu **satu call AI** menilai HANYA item manual yang masih kosong + mencari kontradiksi logis antar item FAKTA. Server TIDAK fetch Redis apa pun untuk fitur ini — payload dari client sudah cukup.

**Rantai fallback:** DeepSeek v4-flash (primary, sama seperti Ringkasan Berita) → SambaNova akun-1 (DeepSeek-V3.2). Kalau keduanya gagal: `error: 'ai_unavailable'`, client tampilkan skor deterministik saja dengan label "penilaian AI tidak tersedia" — fitur tetap berguna tanpa AI, bukan mati total.

**Garis keras (desain, bukan implementasi teknis):** verdict LAYAK/TIDAK LAYAK adalah **konteks keputusan, bukan sinyal eksekusi** — tidak ada auto-entry di jalur mana pun, user tetap yang menekan tombol entry MT5/manual sendiri.

### 3.6 Auto-Entry Virtual + Uji Konsistensi LLM — `vps/daemon.js` → `api/admin.js` (`action=ohlcv_analyze&auto=1`, Plan U-3)

**DILARANG provider AI baru untuk fitur ini (aturan plan sendiri)** — memakai rantai fallback yang PERSIS SAMA dengan Analisa AI per Pair §3.2 (`DeepSeek v4-flash → SambaNova akun-1 → SambaNova akun-2`), jadi berbagi jatah harian yang sama, bukan pool terpisah. Bedanya murni di sisi penulisan data (lihat §2 baris #7/#8 dan `Dokumentasi/daun_merah.md` Session 201 §U-7): call `auto=1` TIDAK menulis cache `ohlcv_analysis:<symbol>` (publik tidak pernah melihat hasilnya) dan setup masuk `setup_log_auto:v1` (bukan log manual publik).

**Volume tambahan ke pool DeepSeek/SambaNova akun-1:** +2 call/hari (auto-entry, 2 slot) + 1 call/hari (uji konsistensi ×3 panggilan = +3 request) = **+5 request/hari**. Kecil dibanding pool 200/hari SambaNova, tapi tetap masuk hitungan headroom §5 kalau Analisa AI per Pair manual sedang ramai.

**[2026-08-04, Track 2a "Road to Professional LLM Trader"] +1 call/hari khusus AUD/NZD:** slot ke-3 (`AUTO_ENTRY_HOURS_UTC_AUDNZD`, default 00:00 UTC/07:00 WIB, sesi Sydney-Tokyo) menambah **+1 request/hari** ke pool yang sama, HANYA untuk pair `frxAUDNZD` — 3 pair lain (XAU/EUR/GBP) tidak bertambah call. Rantai fallback & pool provider TIDAK berubah (masih DeepSeek v4-flash → SambaNova akun-1 → akun-2).

**[2026-07-28] Gate A "AI Kritikus" otomatis (audit celah kesalahan trader, `daun_merah.md` Session 250):** setiap kandidat setup auto-entry yang lolos 3 gate murah (regime-confidence/correlation-cap/drawdown, `_auto_entry_guard.js`, murni kode — 0 AI call) sekarang direview 1x lagi oleh AI Kritikus (verdict "batalkan" → setup tidak disimpan) sebelum masuk `setup_log_auto:v1`.

- **Pool TERPISAH** dari §3.6 di atas — `ai:sambanova:main:experimental` / `sambanova_main_experimental` (limit 30/hari), BUKAN `ai:sambanova:main`/`sambanova_main` yang dipakai tombol manual "UJI KELEMAHAN" publik (isolasi U-7 tetap terjaga — tidak rebutan kuota).
- SambaNova-only, tanpa fallback provider lain (sama seperti tombol manualnya).
- Volume: maksimal +2 call/hari (1 per slot auto-entry berhasil, hanya kalau setup itu genuinely baru — tidak jalan untuk kandidat yang sudah ditahan gate lain atau dup/blocked existing).

### 3.7 Review Posisi Virtual — `api/admin.js` (`action=position_review`, Plan U-5a/U-5b)

Trigger event-driven dari daemon (headline market-moving/geopolitical yang match currency setup eksperimen `open`), **bukan jadwal tetap**. Rantai fallback: SambaNova akun-1 saja (Groq dulu jadi fallback terakhir, dihapus 2026-07-25 — kalau SambaNova gagal, langsung downgrade ke HOLD, fail-safe kode). Dibatasi cooldown 6 jam/posisi + cap 3 review/hari (kode, bukan AI) — **maksimal +3 call/hari** ke pool yang sama.

### 3.8 Tighten Preventif Weekend Gap — `api/admin.js` (`action=friday_tighten`, Plan U-3 lanjutan, 2026-07-24)

**0 call AI — murni kode.** Beda dari §3.7 di atas: itu reaktif (LLM menilai berita), ini jadwal buta 1x/minggu (Jumat, `FRIDAY_TIGHTEN_HOUR_UTC`) yang menggeser SL semua posisi eksperimen `open` ke titik tengah SL-lama/harga-sekarang (`computePreventiveTightenSl`), TANPA menilai konteks apa pun — alasannya "market tutup 2 hari, tidak bisa react apa-apa selama itu", bukan sinyal risiko spesifik. Dicatat di sini murni supaya tidak disangka ikut menambah beban pool AI manapun.

---

## 4. Jatah Harian (Budget Guard) — `api/_ai_guard.js`

Ini lapisan pembatas paling penting untuk dipahami. **Jatah ini dibagi rata ke semua fitur yang pakai provider yang sama** — bukan per-fitur. Kalau salah satu fitur boros, fitur lain yang berbagi provider ikut kena dampak (fallback ke tingkat berikutnya, bukan error — lihat §5).

| Provider | Jatah harian (buatan sendiri) | Limit resmi provider | Dipakai untuk |
|---|---|---|---|
| SambaNova (akun-1 & akun-2) | 200 request/hari masing-masing | ~10-20 RPM, free persisten | Fallback di semua Call 1/2/3/4, Analisa AI primary |
| Google AI Studio (Gemini) | 200 request/hari (buatan sendiri) — **⚠️ TIDAK LAGI VALID, lihat catatan di bawah** | ~~10 RPM, 1.500 RPD~~ **TERBUKTI SALAH 2026-08-02**: alias `gemini-flash-latest` resolve ke `gemini-3.6-flash`, limit REAL cuma **20 request/HARI** (429 `RESOURCE_EXHAUSTED` terverifikasi live, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) | Fallback Call 1/2, Analisa Fundamental, AI Coach — SEMUA fitur ini rawan diam-diam kena limit 20/hari kalau fallback ke Gemini keseringan terpakai hari yang sama (jarang ketahuan karena Gemini biasanya fallback TERAKHIR, jarang aktif) |
| DeepSeek API resmi | 50 request/hari (PAGAR BIAYA — provider berbayar dari saldo top-up user, bukan free tier) | Tidak ada limit request; yang membatasi saldo (top-up $2, 2026-07-18, burn rate live ±$0.0033/generate) | **PRIMARY Call 1/2/3 Ringkasan Berita** (Plan O-3) + **PRIMARY Analisa AI per Pair** (Plan O-6) + Pre-Entry Check (Plan R-2) |
| Mistral — bucket `mistral_newstranslate` | 1000 request/hari (= 1000 PANGGILAN, bukan 1000 headline — 1 panggilan berisi batch sampai 20 headline), **TERPISAH** dari bucket `mistral` (200/hari, diagnostik manual) di atas | ±1M token/bulan (jauh lebih longgar per-request daripada provider lain, konservatif) | **HANYA** Translate NEWS (#10) — provider FINAL setelah 3 percobaan gagal (SambaNova akun 2 2x, Gemini 1x — lihat catatan di baris #10 §2 & temuan Gemini di bawah). Satu-satunya provider translate yang TIDAK dipakai fitur produksi lain sama sekali, jadi nol risiko rebutan kuota |

**⚠️ TEMUAN PENTING (2026-08-02, ditemukan saat debug translate NEWS, berlaku untuk SEMUA fitur yang fallback ke Gemini, bukan cuma translate):** limit resmi Gemini free tier BUKAN 1.500 RPD seperti dokumentasi lama — provider mengembalikan HTTP 429 `RESOURCE_EXHAUSTED` dengan pesan eksplisit "limit: 20, model: gemini-3.6-flash" saat dites live. Google tidak lagi publikasikan angka statis di dokumentasi rate-limit (harus cek dashboard AI Studio live), dan alias `gemini-flash-latest` sudah bergeser generasi model 3x (2.5→3.5→3.6) tanpa mengubah kode kita — tiap pergeseran berpotensi mengubah kuota gratis secara diam-diam. Kalau ada fitur fallback Gemini tiba-tiba gagal terus, JANGAN asumsikan 1.500 RPD sebagai batas aman — cek dulu error message aslinya.

**⚠️ TEMUAN KEDUA (2026-08-02, sama sesi):** SambaNova akun 2 (`SAMBANOVA_API_KEY_CALL1`) terbukti punya latensi SANGAT TIDAK KONSISTEN terlepas dari volume panggilan kita — tes isolasi langsung (bukan lewat fitur apa pun) pernah sukses 2 detik untuk 1 headline dan 8,8 detik untuk batch 10 headline, tapi di lain waktu TIMEOUT 20+ detik bahkan untuk batch 3 headline. Ini bukan soal desain kode (concurrency/batching) — akun itu sendiri memang tidak stabil. Kalau ada fitur yang pakai akun ini (`sambanova_c1`: Journal primary, Call1 Ringkasan fallback, **Analisa Fundamental primary sejak 2026-08-11** — lihat §3.3) tiba-tiba lambat/gagal tanpa sebab jelas, curigai akun ini duluan sebelum audit kode. Keputusan 2026-08-11 memindahkan Fundamental ke akun ini TETAP dibuat sadar akan temuan ini (permintaan eksplisit user, Gemini dianggap kualitas lebih buruk daripada risiko latensi akun ini) — retry 1x di primary sengaja dipasang sebagai mitigasi parsial.

**OpenRouter, Cerebras, Groq, Ollama Cloud — kontrak diputus user 2026-07-25.** Semua kode chain-nya (fallback produksi maupun jalur diagnostik `?test_nemotron=1` dkk) sudah dihapus dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`; env var-nya dihapus dari Vercel. Kalau ada laporan salah satu fitur AI gagal dan providernya masih disebut Cerebras/Groq/OpenRouter/Ollama di log lama — itu log basi dari sebelum tanggal ini, bukan indikasi provider itu masih dipakai.

**Pool yang paling perlu diawasi: SambaNova akun-1 dan Google AI Studio (Gemini).** SambaNova 1 masih fallback di banyak tempat, sedangkan Gemini adalah fallback terakhir JSON yang jika SambaNova error akan memikul beban JSON parse. **Kuota Gemini gratis TERNYATA cuma 20/hari (lihat temuan di atas), BUKAN 1.500/hari — headroom-nya jauh lebih tipis dari yang diasumsikan.**

**Kenapa angkanya sengaja lebih rendah dari limit resmi provider?** Supaya selalu ada headroom untuk retry otomatis dan supaya 1 hari yang tiba-tiba ramai tidak langsung mentok di detik-detik terakhir kuota resmi. Override manual bisa lewat env var `AI_DAILY_LIMIT_{PROVIDER}` kalau suatu saat perlu dinaikkan.

---

## 5. "Paling Banyak Dipakai Berapa Kali?" — Estimasi dalam Bahasa Sederhana

Ini jawaban langsung untuk pertanyaan "penggunaan paling banyak fitur AI itu berapa kali", dipecah per fitur:

### Ringkasan Berita

- **Otomatis:** pasti 3× sehari, tidak bisa lebih, tidak bisa kurang (jadwal tetap). Tiap generate normal = 1 request akun-2 (Call 1, fallback saat DeepSeek gagal) + 2 request ke SambaNova akun-1 (Call 2 & Call 3, fallback) — dalam skenario normal (DeepSeek sehat) request SambaNova malah nol.
- **Manual:** setiap 1× klik "Ringkas Ulang" bisa menambah beban SambaNova/Gemini KALAU DeepSeek gagal — dalam kondisi normal, DeepSeek primary yang menyerap sebagian besar beban (dibatasi pagar biaya 50/hari).
- **Kesimpulan sederhana:** DeepSeek (pagar 50/hari BERBAYAR) sekarang jadi bottleneck utama, bukan SambaNova — begitu DeepSeek habis/gagal, otomatis pindah ke SambaNova akun-1/akun-2 (200/hari masing-masing, jauh lebih longgar).

### Analisa AI per Pair

- **Otomatis:** 3× sehari, khusus XAU/USD saja (juga lewat DeepSeek/SambaNova akun-1, ikut cron Ringkasan Berita).
- **Manual:** dibatasi 5 klik/menit/IP oleh server dan 90 detik cooldown/device oleh UI. **Setiap klik = 1 request** (DeepSeek primary, fallback ke SambaNova akun-1 lalu akun-2). Tidak ada cache-gate sebelum generate (beda dari Analisa Fundamental), jadi tiap klik selalu makan jatah.

### Analisa Fundamental

- **Maksimal mutlak: 4 generate sehari**, apapun yang terjadi (cache global 6 jam, tidak ada tombol paksa refresh di UI). Fitur paling "aman" dari sisi jatah AI. Per generate bisa sampai 2 request SambaNova akun-2 (retry 1x kalau percobaan pertama gagal) + 1 request Gemini kalau primary tetap gagal setelah retry — worst case realistis tetap jauh di bawah pool 200/hari akun-2.

### AI Coach Jurnal

- Terikat pada aktivitas trading nyata user (butuh ≥3 trade closed) — secara alami jarang dipanggil. Ada tombol paksa ulang, jadi 1 device yang aktif bisa memicu beberapa kali sehari kalau memang lagi banyak menutup/mengevaluasi trade, tapi cache 1 jam/device tetap membatasi ini secara wajar.

### Total gabungan (skenario ramai realistis dalam 1 hari)

| Fitur | Perkiraan maksimal wajar/hari | Pool yang dipakai |
|---|---|---|
| Ringkasan Berita (otomatis, 3× cron) | 3 request DeepSeek (fallback: SambaNova akun-1/akun-2) | DeepSeek → SambaNova |
| Ringkasan Berita (manual, ~15-20× klik/hari wajar) | ±15-20 request DeepSeek | DeepSeek → SambaNova → Gemini |
| Analisa AI per Pair (otomatis + manual) | ±63-78 request | DeepSeek → SambaNova akun-1 (+akun-2 fallback) |
| Analisa Fundamental | maksimal 4 request | SambaNova akun-2 → Gemini |
| AI Coach Jurnal | ±5-10 request | SambaNova akun-2 → Gemini |
| Auto-Entry Virtual + Uji Konsistensi LLM (Plan U-3, §3.6) | +5 request (2 auto-entry + 3 konsistensi) | DeepSeek → SambaNova akun-1 (chain sama Analisa AI per Pair) |
| Review Posisi Virtual (Plan U-5a/b, §3.7) | maksimal +3 request (event-driven, cap harian kode) | SambaNova akun-1 |

**Bottleneck utama sekarang DeepSeek (50/hari, berbayar)** — begitu habis/gagal, otomatis turun ke SambaNova (200/hari masing-masing akun, jauh dari mentok di traffic wajar).

---

## 6. Kalau Semua Fallback di Satu Rantai Habis/Gagal

Sejak Cerebras/Groq/OpenRouter/Ollama dihapus (2026-07-25), rantai fallback jadi lebih pendek (2-4 tingkat tergantung fitur, lihat §3). Kalau semua tingkat di satu rantai gagal, itu berarti salah satu dari dua hal:

1. Semua provider di rantai itu gagal di hari yang sama (jarang, beda infrastruktur), atau
2. Jatah harian kita sendiri (§4) sudah habis di SEMUA provider dalam rantai tersebut.

**Analisa AI per Pair dan Review Posisi Virtual** rantainya paling pendek (2 dan 1 tingkat) — paling rentan kalau SambaNova bermasalah.

Ringkasan Berita Call 1 (prosa) punya pengaman ekstra di luar AI: kalau semua provider AI gagal, ada template non-AI berbasis kategori berita (lihat §3.1) — jadi khusus Call 1, "AI tidak tersedia" tidak pernah benar-benar terjadi di UI, cuma kualitasnya turun.

Kalau gagal total terjadi, user akan melihat pesan "AI tidak tersedia — coba beberapa saat lagi" di UI, bukan error yang membingungkan. Redis juga fail-open (kalau Redis down, guard `_ai_guard.js` otomatis mengizinkan panggilan lewat, bukan memblokir) — jadi masalah infrastruktur cache tidak pernah jadi alasan AI mati.

---

## 7. Model & Endpoint — Referensi Cepat

| Provider | Endpoint | Model ID yang dipakai | Peran saat ini | Env var |
|---|---|---|---|---|
| DeepSeek (API resmi, BERBAYAR) | `api.deepseek.com/chat/completions` | `deepseek-v4-flash` (thinking disabled) | **PRIMARY** — Ringkasan Berita Call 1/2/3, Analisa AI per Pair, Pre-Entry Check | `DEEPSEEK_API_KEY` |
| SambaNova (akun-1) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | Fallback — Ringkasan Berita Call 2/3/4, Analisa AI per Pair | `SAMBANOVA_API_KEY` |
| SambaNova (akun-2) | `api.sambanova.ai/v1/chat/completions` | `DeepSeek-V3.2` | Fallback — Ringkasan Berita Call 1, Analisa Fundamental, AI Coach | `SAMBANOVA_API_KEY_CALL1` |
| Google AI Studio | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-flash-latest` | Fallback terakhir — Ringkasan Berita Call 1/2, Analisa Fundamental, AI Coach | `GEMINI_API_KEY` |

**Dihapus 2026-07-25 (kontrak diputus user):** OpenRouter (`OPENROUTER_API_KEY`), Cerebras (`CEREBRAS_API_KEY`), Groq (`GROQ_API_KEY`), Ollama Cloud (`OLLAMA_API_KEY`) — env var dihapus dari Vercel, semua kode chain/diagnostik-nya dihapus dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`.

---

## 8. Catatan Perawatan

- Kalau mau menaikkan jatah harian salah satu provider, set env var `AI_DAILY_LIMIT_{PROVIDER}` di Vercel — jangan ubah `DEFAULT_LIMITS` di kode tanpa konfirmasi status akun aslinya dulu.
- Cek pemakaian real-time tanpa nambah counter: `getUsage(provider)` di `_ai_guard.js`, biasanya diekspos lewat `admin?action=health`.
- Kalau ada model/provider baru mau dicoba, selalu tes dulu via query param diagnostik terisolasi (pola `?test_gemini=1`/`?test_mistral=1`/`?test_nvidia=1`/`?test_deepseek=1` yang masih ada) sebelum jadi primary permanen — pelajaran dari beberapa model yang "katanya gratis" ternyata 403/subscription-required saat dites nyata (lihat riwayat di [daun_merah.md](daun_merah.md)).
