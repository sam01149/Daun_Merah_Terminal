# Daun Merah — Project Context (Full Reference)

> **Last updated:** 2026-06-25 (session 103 — lihat "Changelog Session 103" di bawah untuk detail terbaru)
> **Branch:** main — semua perubahan deployed ke production
> **Working directory:** `c:\Users\sam\Documents\kerja\Financial_Feed_App`
> **Production URL:** https://financial-feed-app.vercel.app

---

## Ringkasan Proyek

Daun Merah adalah forex news PWA (Progressive Web App) untuk trader forex Indonesia bergaya macro discretionary. Sebelumnya bernama FJFeed. Di-deploy di Vercel, single-file frontend (`index.html`) + Vercel Serverless Functions di folder `api/`.

**Deployment target:** Vercel Hobby plan (max 12 serverless functions) + Upstash Redis REST API

---

## Stack Teknis

| Layer | Teknologi |
|-------|-----------|
| Frontend | Vanilla JS + HTML/CSS, single file `index.html` (~4200+ baris) |
| Backend | Vercel Serverless Functions (Node.js, CommonJS `module.exports`) |
| AI | **Multi-provider dual-account strategy:** Call 1 prose: SambaNova `DeepSeek-V3.2` (akun 2, primary), OpenRouter `gpt-oss-120b:free` (fallback 2), Groq `qwen3-32b` (fallback 3); Call 2–3 bias+thesis: SambaNova `DeepSeek-V3.2` (akun 1, upgrade dari V3.1); Call 4–6: Groq `llama-3.3-70b-versatile` |
| Cache/DB | Upstash Redis REST API |
| Git remote (GitHub) | `https://github.com/sam01149/Daun_Merah_Terminal.git` — **repo dipindah dari `sam01149/Financial_Feed_App` (2026-06-23)**. Push masih jalan ke URL lama via GitHub redirect, tapi `origin` lokal sudah di-update ke URL baru biar nggak bergantung redirect terus-menerus. |
| RSS sumber berita (NEWS) | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) — satu-satunya sumber untuk AI digest & tab NEWS |
| Sumber tab ARTIKEL | FED, FOMC, FEDN, ECB, ECBB, BIS, **RBA, BoC, BoJ** (CB primary), **Marc to Market (MTM), ING Think (ING)** (macro research) |
| Option expiries (tab TEK) | Investinglive `/feed/forexorders/` via rss2json — difilter per-pair, 4h cache |
| ActionForex (tab TEK Berita) | Per-pair technical outlook feed, 6 pair major (tidak ada NZD/XAU), 4h cache |
| Retail Sentiment (tab COT) | ForexBenchmark scrape — contrarian indicator, 2h cache, signal di ≥65% satu arah |
| Kalender ekonomi | ForexFactory XML (`nfs.faireconomy.media`) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| Icon | `icon.svg` — dual-leaf loop design (bear merah + bull teal) |
| PWA | `manifest.json` → `icon.svg`, `sw.js` — Service Worker push |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `SAMBANOVA_API_KEY` — Call 2 & 3 (CB bias + thesis, akun 1)
- `SAMBANOVA_API_KEY_CALL1` — Call 1 prose (akun 2, opsional; jika tidak ada, langsung pakai OpenRouter)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `FRED_API_KEY`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (opsional)
- `CRON_SECRET` (auth header untuk cron + admin endpoints)

---

## Struktur File (Current)

```
Financial_Feed_App/
├── index.html              # Seluruh UI + JS frontend (~3500+ baris)
├── mt5_bridge.py           # Local Python bridge → MT5 via MetaTrader5 library (jalankan di PC)
├── start_bridge.bat        # Klik dua kali untuk jalankan bridge manual
├── start_bridge_min.vbs    # Wrapper jalankan .bat dalam kondisi minimized (dipakai shortcut startup)
├── manifest.json           # PWA manifest — icon: icon.svg
├── sw.js                   # Service Worker — push notif, icon.svg
├── icon.svg                # App icon — dual-leaf loop, viewBox="0 20 680 680"
├── vercel.json             # Security headers config
├── package.json            # name: "daun-merah", deps: web-push
├── scripts/                  # BTC data collection + feature engineering (Node, via GitHub Actions)
│   ├── btc-backfill.js       # One-off: full historical backfill semua sumber BTC
│   ├── btc-sync.js           # Incremental: append data baru saja, idempotent, jalan hourly
│   ├── feature-engineering.js # Gabung 7 dataset jadi feature matrix per timeframe (4h, 1d)
│   └── lib/
│       ├── btc-data.js       # CSV read/write/append/read helpers, fetchJson + fetchJsonPatient (429 backoff)
│       ├── btc-sources.js    # OHLCV (data-api.binance.vision) + Fear&Greed (alternative.me)
│       ├── cot-bitcoin.js    # CME Bitcoin futures COT (cftc.gov) — download via curl (lihat catatan)
│       ├── extra-sources.js  # BTC dominance, stablecoin supply (CoinGecko), hashrate (mempool.space)
│       └── indicators.js     # SMA/EMA/RSI/MACD/ATR/Bollinger %B/z-score — implementasi sendiri, tanpa dep
├── data/btc/                # Dataset historis BTC (CSV), auto-update via GitHub Actions
│   ├── ohlcv_1h.csv          # ~77k baris, sejak 2017-08-17
│   ├── ohlcv_4h.csv          # ~19k baris, sejak 2017-08-17
│   ├── ohlcv_1d.csv          # ~3.2k baris, sejak 2017-08-17
│   ├── cot_bitcoin.csv       # ~430 baris mingguan, sejak 2018-04 (open interest + positioning CME)
│   ├── fear_greed.csv        # ~3k baris harian, sejak 2018-02
│   ├── hashrate.csv          # ~6.4k baris harian, sejak 2009 (mempool.space, tanpa batasan)
│   ├── stablecoin_supply.csv # 365 baris harian (USDT+USDC market cap) — CoinGecko free tier batasi histori max 365 hari
│   ├── btc_dominance.csv     # 1 baris/hari mulai sekarang — tidak ada histori gratis (CoinGecko Pro-only), akumulasi ke depan
│   ├── features_4h.csv       # Feature matrix siap-training (Node), granularitas 4h (~19.3k baris, 31 kolom, + indikator teknikal)
│   ├── features_1d.csv       # Feature matrix siap-training (Node), granularitas 1d (~3.2k baris, 31 kolom, + indikator teknikal)
│   ├── clean_4h.csv          # Versi pandas (ml/preprocess.py) — kolom raw terpilih per sumber, tanpa indikator, 21 kolom
│   └── clean_1d.csv          # idem, granularitas 1d — divalidasi cocok 1:1 dengan features_1d.csv di kolom yang sama
├── ml/                      # Modeling BTC (Python, .venv lokal — pandas/scikit-learn/torch)
│   ├── preprocess.py        # Cleaning + integrasi transparan: pilih kolom per CSV mentah, merge_asof, -> clean_4h/1d.csv
│   ├── train_models.py      # Klasifikasi: 5 algoritma + 2 baseline, chronological split
│   ├── cross_validation.py  # Walk-forward CV (4 fold) — validasi robustness hasil train_models.py
│   ├── train_regression.py  # Regresi: prediksi besaran return (target_ret_6/18)
│   ├── requirements.txt     # pandas, scikit-learn, torch (CPU)
│   └── results/
│       ├── REPORT.md                  # Laporan lengkap 3 eksperimen + kesimpulan jujur final
│       ├── model_comparison.json      # Raw metrics klasifikasi single-split
│       ├── cross_validation.json      # Raw metrics walk-forward CV
│       └── regression_comparison.json # Raw metrics regresi
└── api/                    # TEPAT 12 serverless functions (Vercel Hobby limit)
    ├── _circuit_breaker.js # Self-healing: Redis-backed circuit breaker (CLOSED→OPEN→HALF_OPEN)
    ├── _push_keywords.js   # Keyword lists untuk detectPushCat() — edit di sini untuk update kategori
    ├── _ratelimit.js       # Shared rate limiter helper — prefix _ = bukan route publik
    ├── _retry.js           # Exponential backoff fetch wrapper — prefix _ = bukan route publik
    ├── admin.js            # Consolidated: health + redis-keys + admin-prompts + push
    ├── calendar.js         # ForexFactory calendar
    ├── cb-status.js        # CB tracker + bias dari Redis
    ├── correlations.js     # Cross-asset correlation (Yahoo Finance), rate limited 5/min
    ├── feeds.js            # Consolidated: RSS proxy + COT scraper
    ├── journal.js          # Trade journal CRUD
    ├── market-digest.js    # AI briefing (3 Groq calls), rate limited 4/min
    ├── rate-path.js        # SOFR heuristic rate path
    ├── real-yields.js      # Real yield differential
    ├── risk-regime.js      # VIX/MOVE/HY regime classifier
    ├── sizing-history.js   # Position sizing history per device
    └── subscribe.js        # Push subscription management
```

> **Penting:** `api/feeds.js` menggantikan `api/rss.js` dan `api/cot.js` yang sudah dihapus.
> `api/admin.js` menggantikan `api/health.js`, `api/redis-keys.js`, `api/admin-prompts.js`, dan `api/push.js`.
> Konsolidasi ini dilakukan untuk tetap di bawah limit 12 serverless functions Vercel Hobby.

---

## Changelog Session 103 (2026-06-25)

### Dashboard — readability fix teks ringkasan (font 10px → 13px, paragraf, warna)

**Konteks:** Setelah Session 102 bikin preview ringkasan jadi full-text (bukan dipotong), user lapor font-nya kekecilan (10px) dan capek dibaca — minta disamakan dengan kenyamanan baca di tab RINGKASAN.

**Root cause tambahan yang ketemu saat investigasi:** bukan cuma soal ukuran font — `dash-digest-text` sebelumnya di-render dengan `escHtml(preview)` langsung (satu blok teks tanpa pemecahan paragraf), beda dari tab RINGKASAN yang pakai `articleToHtml()` (pecah jadi `<p class="r-para">` per paragraf dengan margin 1.2em). Hasilnya dinding teks panjang tanpa nafas, jauh lebih melelahkan dibaca dibanding ukuran font kecilnya sendiri.

**Fix (`index.html`):**
- `.dash-digest-text`: font-size 10px → 13px, line-height 1.6 → 1.75, color `var(--text-mid)` (abu redup) → `var(--text)` (#e8e4d9, krem hangat) — identik dengan `.ringkasan-text` di tab RINGKASAN.
- `renderDashDigest()` sekarang pakai `articleToHtml(preview)` (bukan `escHtml`) supaya paragraf ter-pecah dengan benar, termasuk highlight paragraf kalender (`r-cal`) kalau ada.

**Testing:** Validasi sintaks tiap blok `<script>` (`node -e "new Function(...)"`) — lolos.

---

## Changelog Session 102 (2026-06-25)

### Dashboard — preview ringkasan satu sisi (XAU default) dengan toggle panah

**Konteks:** User minta card RINGKASAN PASAR di Dashboard cuma nampilin satu bagian (FX atau XAU) bukan dua-duanya, biar cepat dibaca. Diskusi: user trading gold jadi mau XAU sebagai default, tapi sempat ragu apakah itu objektif mengingat aplikasi ini macro-context-heavy. Konklusi: paragraf XAU di output ringkasan sudah merangkum driver makro yang relevan (real yield, Core PCE, Fed bias, risk regime) di dalam paragrafnya sendiri, jadi tidak kehilangan konteks signifikan dengan menyembunyikan bagian FX — defaultkan XAU, kasih toggle panah buat lihat FX kalau perlu.

**Implementasi (`index.html`):**
- Extract helper `splitArticleParts(article)` dari logika split `"XAUUSD:"` yang sebelumnya cuma ada di `renderArticleSections` (tab RINGKASAN) — sekarang dipakai juga di `renderDashDigest()` biar tidak duplikat logika.
- `renderDashDigest()` sekarang preview cuma satu sisi (`dashDigestSide`, persisted ke localStorage `dash_digest_side`, default `'xau'`), dengan tombol panah ‹ › (`toggleDashDigestSide()`) buat switch antar XAU/FX. Toggle cuma muncul kalau artikel benar-benar punya dua bagian (`hasBoth`); kalau cuma satu bagian, tampil langsung tanpa toggle.
- Susulan: ditampilkan **full** (tidak dipotong 500 char) karena cuma satu sisi yang tampil sekaligus — ruang yang dipakai sama dengan preview lama yang motong dua sisi. "Lihat semua" sekarang maksudnya "lihat sisi yang satunya juga" (label diubah jadi "→ Lihat semua (FX + XAU)"), muncul cuma kalau artikel punya dua bagian — bukan lagi soal truncation.

**Testing:** Validasi sintaks tiap blok `<script>` di `index.html` (`node -e "new Function(...)"`) — lolos. Verifikasi manual alur 3 skenario: artikel ada XAU+FX (toggle muncul, default XAU), artikel cuma FX/legacy tanpa marker XAUUSD (toggle disembunyikan, fallback ke FX), dan belum ada ringkasan sama sekali (tetap tampil tombol Generate seperti sebelumnya, tidak kena logic split).

---

## Changelog Session 101 (2026-06-25)

### Fix kalender: "Initial Jobless Claims" tidak pernah match "Unemployment Claims"

**Konteks:** User paste contoh headline FinancialJuice hari itu (PCE, Durable Goods, Jobless Claims, dll) dan minta kalender "disesuaikan lagi". Dicek silang dengan data live `/api/calendar` — ketemu satu mismatch nyata: headline FinancialJuice "Initial Jobless Claims Actual X (Forecast Y, Previous Z)" tidak pernah cocok dengan event ForexFactory yang namanya "Unemployment Claims", walau itu rilis mingguan yang sama. `_calWordSetsMatch` di `index.html` butuh kecocokan word-set persis, dan "initial jobless claims" vs "unemployment claims" tidak ada kata yang sama sama sekali — jadi `actual` selalu kosong tiap Kamis untuk event ini.

**Fix (`index.html`):** Tambah `initial` ke `_CAL_STOPWORDS` (filler, tidak membedakan indikator) dan mapping `jobless → unemployment` di `_CAL_SYNONYMS`, supaya kedua sisi collapse ke token yang sama. "Continued Jobless Claims" (rilis berbeda) tetap aman tidak ke-match karena kata "continued" bikin ukuran word-set beda.

### Dashboard — generate ringkasan manual + jadwal otomatis per sesi pasar

**Konteks:** Evaluasi mandiri atas keluhan user "dashboard kurang menarik" — ternyata card AI DIGEST/AI THESIS di Dashboard sering kosong karena ringkasan cuma bisa di-generate manual dari tab RINGKASAN (tidak ada cron). Sempat dicoba auto-generate tiap kali Dashboard dibuka, tapi user khawatir soal biaya token kalau dibuka tiap jam/sesi — direvisi ke pendekatan jadwal fix.

**Implementasi:**
- `index.html`: card ringkasan di Dashboard (di-rename label-nya jadi "RINGKASAN PASAR") sekarang punya tombol generate sendiri (`dashGenerateRingkasan()`) + tombol "↻ Refresh" kalau data sudah stale — murni manual tap, tidak ada auto-trigger dari aktivitas buka app.
- Ditambah caption "Terakhir diringkas HH:MM WIB (sesi Asia/London/New York)" di bawah preview (`fmtWibSession()`), label sesi cuma informatif berdasarkan jam WIB, bukan deteksi presisi.
- `api/market-digest.js`: handler sekarang terima request cron terautentikasi (header `x-vercel-cron: 1` dari Vercel, atau `x-cron-secret` cocok `CRON_SECRET` — pola yang sama dipakai `ohlcvSyncHandler` di `api/admin.js`), yang melewati rate-limit per-IP (4 req/menit) karena ini cuma 3 panggilan terautentikasi/hari, bukan trafik user. Tidak ada `device_id` di panggilan cron — sudah diverifikasi aman karena Call 4 (thesis monitor per-journal user) sudah punya gate `&& deviceId` dari awal, jadi otomatis skip; Call 1-3 (briefing, CB bias, thesis) tetap jalan dan update cache (`latest_article`) yang dibaca semua user lewat `mode=cached`.
- `vercel.json`: tambah 3 cron entry ke `/api/market-digest` — `0 0 * * *` (07:00 WIB, sesi Asia), `0 7 * * *` (14:00 WIB, sesi London), `30 12 * * *` (19:30 WIB, sesi New York).

**Testing:** Validasi sintaks (`node -e "new Function(...)"` untuk tiap blok `<script>` di `index.html`, `require()` untuk `market-digest.js`, `JSON.parse` untuk `vercel.json`) — semua lolos. Verifikasi manual logika gating Call 4 di kode (baris `(SAMBANOVA_KEY || GROQ_KEY) && deviceId`) untuk memastikan panggilan cron tanpa `device_id` tidak crash dan tidak menulis ke key Redis `thesis_alerts:undefined`. Belum bisa di-test end-to-end jam cron yang sesungguhnya karena itu baru jalan setelah deploy ke Vercel.

---

## Changelog Session 99 (2026-06-24)

### Fix: Option Expiries FinancialJuice — sumber kedua sering kosong karena live ticker window terlalu sempit

**Konteks:** Setelah Session 99 nambahin FinancialJuice sebagai sumber kedua, user lapor pasangan mata uang dari FinancialJuice belum muncul. Root cause: `RSS_URL` FinancialJuice itu live ticker semua-asset-class (~100 headline terakhir lintas forex/equity/commodity/geopolitik), bukan feed khusus forex. Post "Options Expiries" cuma sekali sehari, dan dengan volume berita FinancialJuice yang tinggi, item-nya rotasi keluar dari window itu dalam hitungan jam — jadi `fetchFinancialJuiceOptions` hampir selalu gagal nemu post-nya kecuali serverless function kebetulan fetch persis di jam postingan baru naik.

**Fix (`api/feeds.js`):**
- `fetchFinancialJuiceOptions` sekarang 2 tahap: (1) coba live ticker dulu (cepat, kena kalau baru saja diposting), (2) kalau gagal/item tidak ketemu, fallback ke Redis sorted set `news_history` (window 36 jam, sudah otomatis terisi tiap kali ada yang akses `type=rss` lewat `storeNewsHistory`) — cari item dengan title cocok pattern expiry, ambil yang `pubDate` paling baru.
- `parseRSSItems` (yang ngisi `news_history`) sekarang simpan field `description` juga, tapi *cuma* untuk item yang title-nya cocok pattern option-expiry — item berita biasa tetap tanpa description supaya ukuran history di Redis nggak boros buat data yang nggak kepake.

**Testing:** Disimulasikan skenario "live ticker sudah rotasi keluar" (live fetch return XML tanpa item expiry sama sekali) + history Redis berisi item expiry lama — hasil tetap berhasil ke-extract dari history, dengan `sources: ["FinancialJuice"]` dan level/size yang benar. Regression check: live-fetch path (skenario normal, item masih ada di ticker) tetap jalan seperti semula.

---

## Changelog Session 99 (2026-06-24)

### Feat: Option Expiries — Tambah sumber kedua (FinancialJuice), merge dengan Investinglive

**Konteks:** User kasih tahu FX option expiry ternyata juga diposting FinancialJuice (bukan cuma Investinglive yang sudah dipakai sejak Session 66/67), berupa headline harian "[Day] FX Options Expiries" di feed berita FinancialJuice yang sama dengan yang dipakai untuk RSS ticker (`RSS_URL`), formatnya `<li><strong>PAIR:</strong> level (size), level (size)</li>` per pair.

**Implementasi (`api/feeds.js`):**
- `optionsHandler` sekarang fetch Investinglive (`fetchInvestingLiveOptions`) dan FinancialJuice (`fetchFinancialJuiceOptions`) paralel via `Promise.allSettled` — kalau satu sumber down/diblokir, yang lain tetap jalan (tidak hard-fail, konsisten dengan pola degradasi sumber lain di file ini).
- `fetchFinancialJuiceOptions` cari item RSS dengan title match `/options?\s*expir/i` (longgar untuk nangkep "Option Expiries" singular dan "Options Expiries" plural FinancialJuice), ambil `<description>`, decode HTML entities, lalu reuse `parseOptionExpiries` yang sudah ada.
- Regex size di `parseExpiryEntries` diperluas: sebelumnya cuma terima prefix simbol mata uang (`€$¥£`), sekarang juga terima kode 2-4 huruf (`EU`, `AUD`, `GBP`, `NZD`, `MXN`...) — format yang dipakai FinancialJuice (`EU2.51b`, `AUD688.9m`) beda dari Investinglive yang pakai simbol.
- Hasil dari kedua sumber digabung lalu di-dedupe (`dedupeExpiries`) per `pair+level` — kalau dua sumber sama-sama lapor level yang sama, jadi satu entry dengan `sources: [...]` (menandakan dikonfirmasi 2 sumber) dan size diisi dari sumber mana pun yang punya data.
- Response sekarang punya field `sources` di top-level: `[{name, link, date}, ...]` — satu per sumber yang berhasil fetch.

**Frontend (`index.html`):** Tabel Option Expiries di TEK tab dapat kolom "Sumber" (muncul cuma kalau ada entry yang dikonfirmasi >1 sumber — abbreviation IL/FJ dengan tooltip nama lengkap), dan footer link sumber sekarang nampilin link ke kedua sumber yang berhasil fetch (bukan cuma Investinglive seperti sebelumnya).

**Testing:** Diverifikasi end-to-end pakai data live FinancialJuice RSS (capture asli "Wednesday FX Options Expiries" dengan 9 pasangan: EUR/USD, USD/JPY, AUD/USD, USD/CNY, GBP/USD, USD/BRL, NZD/USD, EUR/GBP, USD/MXN — total 23 level) — semua level+size terparse benar termasuk format `EU2.51b`/`AUD688.9m` yang sebelumnya tidak match. Dites juga skenario merge (2 sumber lapor level sama → 1 entry dengan 2 sources), filter per-pair, dan graceful degradation (1 sumber down → tetap return 200 dengan sumber yang hidup).

---

## Changelog Session 100 (2026-06-25)

### UX tweak — yield instruments di tab TEKNIKAL otomatis pindah ke timeframe 1D

**Konteks:** US10Y dan US02Y sekarang bisa dibuka sebagai chart teknikal sendiri di tab TEKNIKAL, tapi kalau user pindah ke pair yield dari pair lain, timeframe sebelumnya bisa ikut kebawa dan bikin chart yang kurang relevan.

**Fix:** Saat `selectTekPair()` atau `initTeknikal()` mendeteksi pair yield (`US10Y` / `US02Y`), state timeframe sekarang dipaksa ke `D` dan dropdown ikut disinkronkan. Saat balik ke forex atau XAU/USD, state otomatis balik ke `240` supaya tampilan teknikal kembali ke H4, yang jadi default paling masuk akal untuk pair tersebut.

**Testing:** Verifikasi wiring langsung di `index.html` memastikan helper sync dipanggil dari dua jalur utama: saat pair diganti dan saat tab TEKNIKAL diinisialisasi.

---

## Changelog Session 98 (2026-06-23)

### Bug fix — hasil Sizing Calculator (lots/SL/TP) hilang setelah refresh, padahal sudah dipakai di Checklist/MT5

**Konteks:** User lapor: hitung Sizing Calculator, lanjut ke Checklist, refresh halaman dengan pair yang sama — Lot/SL/TP yang sudah dikunci di modal Entry MT5 (Session 95) hilang total, harus ulang dari Sizing Calculator.

**Root cause:** `window._lastSizing` — objek yang jadi jembatan satu-satunya antara Sizing Calculator dan Checklist/MT5 (`ckShowMt5Modal()` baca dari sini) — cuma variabel in-memory, tidak pernah ditulis ke localStorage. Form INPUT-nya (equity, risk, entry, SL via `szPersistForm()`/`szRestoreForm()`) sudah lama persisten, tapi hasil KALKULASI-nya tidak — asimetri yang bikin form kelihatan "selamat" setelah refresh sementara nilai yang sebenarnya dipakai sistem (lots/SL/TP) hilang diam-diam.

**Fix:** `window._lastSizing` sekarang dipersist ke localStorage (`daun_merah_sz_lastsizing`) tiap kali `calcSizing()` menghasilkan nilai baru (`szPersistLastSizing()`), dan direstore lewat IIFE di top-level script saat halaman dimuat — jadi tersedia segera, tidak menunggu user buka tab Sizing dulu (penting karena skenario user: refresh lalu LANGSUNG balik ke Checklist, tanpa mampir ke Sizing tab). Sekalian diperbaiki gap kedua yang ditemukan saat investigasi: kalau user toh balik ke tab Sizing setelah refresh, panel hasil yang terlihat tetap kosong walau `_lastSizing` sudah benar di balik layar (inkonsistensi tampilan vs data). `initSizing()` sekarang panggil ulang `calcSizing()` otomatis kalau ada `_lastSizing` yang pair-nya cocok dengan form yang baru direstore — sumber tunggal data dijaga konsisten, tidak ada dua objek (form vs hasil) yang bisa drift.

**Testing:** Playwright dengan `browser.newContext()` (localStorage persist antar `page.reload()`, beda dari context baru tiap test sebelumnya). 3 skenario: (1) `_lastSizing` di-set manual lalu reload — terbukti pulih dari localStorage; (2) langsung ke Checklist setelah reload TANPA mampir Sizing tab — modal Entry MT5 langsung terisi lots/SL/TP terkunci, sama seperti sebelum refresh; (3) kalkulasi sungguhan lewat form UI (pilih pair, isi equity/risk/RR/entry/SL, klik Calculate) lalu reload lalu buka tab Sizing — panel hasil muncul kembali otomatis, bukan kosong.

---

## Changelog Session 97 (2026-06-23)

### Speed-flag untuk blind mass-check checklist — bukan mencegah, tapi memaksa berhenti + tercatat permanen

**Konteks:** Pertanyaan user setelah Session 96: "gimana kalau aku tiba-tiba centang semua biar bisa entry?" Beda kategori dari 4 celah sebelumnya — itu bug (sistem punya jalan pintas tak disengaja), ini bukan bug: tidak ada cara teknis memverifikasi user benar-benar membaca tiap kondisi vs asal klik. Sama dengan argumen demo-vs-riil di awal sesi diskusi disiplin trading — software tidak bisa membuktikan kejujuran, tapi bisa menaikkan biaya dan membuat ketahuan.

**Implementasi:** `ckToggleItem()` sekarang catat timestamp checklist pertama kali ada item dicentang dari kondisi kosong (`daunmerah_v2_firstcheck_{PAIR}` di localStorage, per-pair, dibersihkan saat reset/ganti playbook). Fungsi baru `ckChecklistSpeedInfo()` hitung rasio item-tercentang vs waktu-berlalu; ditandai "suspicious" kalau ≥50% item checklist sudah tercentang TAPI rata-rata kurang dari ~0,6 detik/item — ambang batas lega untuk skim-reading genuine, jauh di bawah yang bisa dicapai mass-click instan.

Kalau `ckPrefillJurnal()` atau `ckShowMt5Modal()` dipanggil saat flag ini aktif, keduanya dialihkan lewat `ckProceedIfNotSuspicious()` ke modal baru (`ckSpeedAckModal`) yang memaksa user mengetik kalimat nyata (pakai validator yang sama dengan override reason — `ckOverrideReasonIssue()`, minimal 15 karakter/3 kata/bukan kata pengisi) menjelaskan kondisi apa yang barusan dicek, sebelum bisa lanjut. Bukan hard block — user tetap bisa lanjut kalau memang mau — tapi alasan itu (`ckLastSpeedAck`) otomatis ditempel permanen ke teks thesis jurnal (`⚠ FLAG KECEPATAN: N/M item dicentang dalam X detik...`) lewat `ckConsumeSpeedAckNote()`, baik untuk jalur Jurnal manual maupun auto-journal dari MT5 Bridge. Catatan one-shot — dikonsumsi begitu terpakai, supaya tidak nempel ke entry lain yang temponya genuine.

**Bonus kecil:** ketemu saat refactor — `ckPrefillJurnal()` sebelumnya cuma cek `pct < 50`, tidak ikut cek `gatesOk` dari fix Session 96 (MT5 modal sudah benar, Jurnal kelewat). Disamakan sekarang.

**Testing:** Playwright — 6 skenario: (1) mass-check instan terdeteksi suspicious (44/44 item dalam 0.003s), (2) `ckPrefillJurnal()` dialihkan ke modal speed-ack bukan langsung navigasi, (3) alasan "ok" tetap menjaga tombol disabled, (4) alasan kalimat nyata mengaktifkan tombol → konfirmasi → navigasi ke Jurnal jalan + teks thesis berisi flag note + `ckLastSpeedAck` ke-clear, (5) checklist yang sama dicentang selama 5 menit (pacing genuine) TIDAK ditandai suspicious, (6) checklist genuine lolos langsung ke Jurnal tanpa modal sama sekali. Jalur MT5 diuji terpisah: modal speed-ack tampil duluan, baru setelah konfirmasi modal Entry MT5 terbuka.

**Catatan:** ini eksplisit bukan solusi penuh — kalau user benar-benar niat berbohong, dia bisa mengetik kalimat yang valid secara format tapi isinya tetap bohong ("saya sudah cek semua dengan teliti" tanpa benar-benar cek). Tidak ada perbaikan lanjutan yang realistis untuk ini di level software; batasannya didokumentasikan terbuka ke user saat fitur ini diusulkan, bukan diklaim sebagai pencegahan mutlak.

---

## Changelog Session 96 (2026-06-23)

### Tutup 4 celah checklist sisa dari audit disiplin (Session 95) — gate wajib 100%, cooldown reset, konfirmasi ganti playbook, validasi alasan override

**Konteks:** Lanjutan audit checklist Session 95. User minta semua celah yang teridentifikasi dikerjakan, bukan cuma satu (lot/SL/TP yang sudah dibereskan di Session 95).

**1. Gate section (VALIDITAS DRIVER, RISK MANAGEMENT, dst — beda per playbook) sekarang wajib 100% checked, bukan cuma 2x-weighted di skor agregat.** Sebelumnya user bisa skip seluruh gate dan tetap lolos 50% threshold dengan mencentang section lain yang lebih remeh — celah paling berbahaya karena gate justru yang paling sering dikorbankan saat emosi (FOMO/revenge). `ckGetVerdict()` sekarang hitung `gatesOk` (semua section di `CK_GATES` harus 100% item parent-nya checked, lewat fungsi baru `ckGateComplete()` — bukan reuse `ckIsComplete()` yang juga mensyaratkan sub-item, supaya konsisten dengan skor agregat yang dari awal cuma menghitung parent item, sub cuma guidance). Verdict dipaksa "NO TRADE" kalau gate belum lengkap walau pct sudah tinggi, dengan pesan eksplisit gate mana yang kurang. Tombol Jurnal/MT5 dan `ckShowMt5Modal()` ikut pakai `gatesOk`, dengan toast jelas (bukan diam) kalau diblokir karena gate.

**2. Cooldown 60 detik setelah Reset Checklist — menutup pola "reset lalu instan centang ulang yang sama" buat melepas verdict NO TRADE tanpa konsekuensi.** Lock disimpan di localStorage per-pair (`daunmerah_v2_resetlock_{PAIR}`, bukan cuma in-memory) supaya refresh halaman tidak jadi jalan pintas. `ckToggleItem()` sekarang cek lock duluan — kalau masih dalam cooldown, klik checkbox diblokir + toast "Tunggu Xs ... bukan reset-lalu-paksa-lolos". Countdown live ditumpangkan ke interval jam 1 detik yang sudah ada (`ckUpdateClock()` → `ckUpdateResetCooldownUI()`), tampil sebagai teks merah di bawah tombol Reset.

**3. Ganti playbook di tengah sesi (ada progress checklist tercentang) sekarang minta konfirmasi eksplisit sebelum reset state, bukan langsung wipe diam-diam.** Sebelumnya ganti playbook = celah belakang: skor rendah di SMC/ICT → pindah ke Macro Momentum → checklist kosong baru → lolos lebih mudah. `ckSwitchPlaybook()` sekarang cek `Object.values(ckState).some(v => v === true)` — kalau ada item tercentang, `confirm()` dulu ("Checklist pair ini yang sudah dicentang akan di-reset ke kosong"); kalau user batal, dropdown selector dikembalikan ke playbook aktif (tidak ada state ganda/visual mismatch).

**4. Alasan override sinyal auto-block (`rc4` dst) sekarang harus kalimat nyata, bukan cuma ≥5 karakter.** Validasi lama meloloskan "test", "ok ok", "udah" — kosmetik doang. Fungsi baru `ckOverrideReasonIssue()`: minimal 15 karakter, minimal 3 kata, blocklist kata pengisi umum (test/ok/aman/skip/gas/terserah/dst — case+symbol-insensitive), tolak alasan dengan diversity karakter rendah (<6 unique char — nangkep filler kayak "aaaaaaaaaaaaaaa" / "asdasdasdasdasd" yang lolos count tapi bukan kalimat). Ditambah hint teks live di bawah textarea (`#ckOverrideHint`) yang menjelaskan kenapa tombol masih disabled — sebelumnya tombol cuma mati tanpa penjelasan apa pun.

**Testing:** Playwright headless, 4 skenario terpisah per celah (lihat detail di Session 95 untuk setup server statis). Ketemu 1 bug nyata saat testing: percobaan pertama pakai `ckIsComplete()` (yang ikut mensyaratkan sub-item) untuk cek gate — hasilnya gate SELALU "incomplete" walau semua parent item dicentang, karena sub-item (mis. `g5a`-`g5d` di bawah `g5`) tidak ikut tercentang dalam skenario normal (sub murni guidance, tidak pernah dimaksudkan wajib). Diperbaiki dengan fungsi terpisah `ckGateComplete()` yang cuma cek parent item, konsisten dengan semantik skor. Setelah fix: re-test konfirmasi `gatesOk` jadi `true` begitu semua parent item gate checked (skor 100%, verdict ENTRY). 3 celah lain (cooldown, playbook-switch confirm, override validation) lolos dari percobaan pertama — verified lewat manipulasi `localStorage`/`ckState` langsung + dialog handler Playwright (`page.on('dialog')`) untuk simulasi accept/dismiss `confirm()`, plus screenshot visual untuk banner cooldown dan hint override.

**Catatan:** keempat fix ini menutup celah yang ditemukan, tapi tidak menyentuh hal di luar lingkup (mis. localStorage/console tampering — itu butuh user aktif buka DevTools saat trading, bukan pola emosi spontan yang jadi concern utama diskusi ini).

---

## Changelog Session 95 (2026-06-23)

### Lock Lot/SL/TP di modal Entry MT5 ke hasil Sizing Calculator — tutup celah entry emosional

**Konteks:** Diskusi disiplin trading dengan user — checklist di-audit untuk cari celah dimana entry bisa lolos berdasarkan emosi walau user berniat jujur ke diri sendiri (sistem harus tegas, bukan cuma andalkan niat baik). User sendiri menyadari titik paling rawan: field Lot/Stop Loss/Take Profit di modal "Entry MT5" sebelumnya bisa diedit manual di menit terakhir — sama bahayanya dengan langsung input manual di MT5, karena angka eksekusi bisa berubah dari rencana objektif (hasil Sizing Calculator) jadi tebakan saat itu.

**Implementasi (`index.html`):**
- Modal `mt5Modal`: field Lot Size/Stop Loss/Take Profit sekarang `readonly` + label 🔒 "dari Sizing Calculator". Ditambah div `mt5ModalNoSizing` (tersembunyi default) yang muncul kalau `window._lastSizing` belum ada / tidak cocok pair, dengan CTA "Buka Sizing Calculator →".
- `ckShowMt5Modal()`: `matchSz` sekarang mensyaratkan `lots`, `slPrice`, DAN `tpPrice` ada (bukan fallback ke `0.01`/kosong seperti sebelumnya). Kalau tidak match → field/section dan tombol "Konfirmasi Entry" disembunyikan, hanya warning + CTA yang tampil. Kalau match → field terisi read-only persis dari hasil Sizing Calculator.
- `ckGoToSizingFromModal()` (baru): tutup modal MT5, pindah ke tab Sizing, auto-set `szPair` ke pair yang sama, toast pengingat "isi entry/stop lalu balik ke checklist".
- `ckMt5OrderConfirm()`: guard tambahan — kalau `lots` tetap 0 (longgar terlewat lewat console/edge case), tolak submit dengan toast, bukan diam-diam kirim order.
- Fix kecil terkait (ditemukan saat audit, bukan permintaan langsung tapi searah): `ckShowMt5Modal()` sebelumnya `return` diam-diam kalau skor checklist <50% (user klik tombol, tidak ada respons apa pun). Ditambah toast `"Checklist belum cukup — Skor masih X%"` supaya gate-nya terasa tegas, bukan tombol yang kelihatan mati.

**Testing:** Playwright headless terhadap `index.html` yang disajikan statis (server backend tidak dijalankan, expected 404 di API calls — tidak relevan ke logic yang diuji). 3 skenario diverifikasi lewat manipulasi state langsung (`window._lastSizing`, `ckState`) lalu screenshot:
1. Checklist 100%, tanpa data sizing → modal terbuka tapi cuma tampilkan warning + tombol redirect, field & tombol konfirmasi tersembunyi.
2. Checklist 100%, sizing diisi (`lots:0.25, sl:1.23000, tp:1.24500`) → field lot/SL/TP terkunci read-only, nilainya persis sama dengan sizing, tombol konfirmasi muncul.
3. Checklist skor 0% → modal tidak terbuka sama sekali (toast tampil, sudah dicek lewat behavior, tidak discreenshot ulang).
Tombol redirect diverifikasi membuka tab Sizing dengan pair ter-prefill otomatis.

**Catatan:** celah lain dari audit checklist (gate section tidak wajib 100%, reset tanpa cooldown, ganti playbook = reset state, override reason tanpa validasi isi) belum disentuh — user pilih fokus ke satu celah ini dulu (lot/SL/TP) karena itu yang paling kena ke pola emosinya secara langsung. Sisanya didokumentasikan ke user sebagai opsi lanjutan, menunggu keputusan mana yang mau dikerjakan berikutnya.

---

## Changelog Session 94 (2026-06-23)

### Tombol "Mulai ke Sizing Calc" di card Thesis XAU/USD + warna disamakan ke tab Sizing

**Konteks:** Card Thesis XAU/USD (tab RINGKASAN) sebelumnya tidak punya tombol aksi sama sekali (beda dari card Thesis FX yang sudah punya `thesisGoToSizing()` dari session 93). User minta disamakan + warna tombol jangan pink (warna lama yang dipakai sebelum disadari salah) — diganti ke warna yang benar-benar dipakai tab SIZING di nav (`var(--accent)`, merah-maroon brand "Daun Merah" — dikonfirmasi dari CSS `.nvtab[data-view="sizing"] { color: var(--accent); }`, bukan biru yang dipakai drawer icon).

**Implementasi:** `thesisGoToSizing()` di-refactor jadi generik — terima parameter `(pair, direction)` langsung dari pemanggil, bukan baca `_lastThesis` di dalam fungsi (supaya bisa dipakai baik dari card FX maupun XAU yang field-nya beda bentuk: `t.direction` long/short vs `t.xau_bias` bullish/bearish/neutral/conflicting). Tombol baru di `renderXauThesisCard()` cuma muncul kalau `xau_bias` itu `bullish` atau `bearish` (mapped ke long/short) — disembunyikan total kalau `neutral`/`conflicting`, konsisten dengan card FX yang juga sembunyi tombol saat `direction === 'no_trade'`. CSS `.thesis-use-btn` diubah dari `var(--pink)` → `var(--accent)`, berlaku otomatis untuk kedua tombol (FX dan XAU) karena reuse class yang sama.

---

## Changelog Session 93 (2026-06-23)

### Auto-load Polymarket + Korelasi, thesis AI bahasa Indonesia, satukan jalur Thesis → Checklist

**1. Bug bahasa: AI Thesis field bebas (`invalidation_condition`, `catalyst_dependency`, `xau_driver_evidence`, `xau_key_trigger`) keluar Bahasa Inggris.** Root cause: Call 1 (briefing prosa) di `api/market-digest.js` punya instruksi eksplisit "Tulis Bahasa Indonesia" (`DIGEST_SYSTEM_DEFAULT`), tapi Call 2-3 (thesis JSON) sama sekali tidak punya instruksi bahasa — AI default ke Inggris walau UI label-nya sudah Indonesia ("INVALIDASI", "BUKTI", dst). Fix: tambah anotasi bahasa di skema JSON tiap field + 1 baris rule eksplisit "All free-text string fields ... must be written in Bahasa Indonesia". Catatan: hasil lama yang sudah di-cache di Redis (`latest_article`) tetap Inggris sampai user generate ulang.

**2. Auto-load Polymarket (tab RINGKASAN) + Korelasi Cross-Asset (tab TEKNIKAL) — sebelumnya wajib klik manual.** Kedua panel ini adalah satu-satunya yang masih manual-trigger di seluruh app (semua data tab lain — CAL, COT, FUNDAMENTAL, dll — sudah pakai pola staleness-check auto-fetch saat tab dibuka). Disamakan ke pola yang sama: `if (!data || (now - fetchedAt) > TTL) fetchX()` dipanggil di view-switch handler ('ringkasan') dan `initTeknikal()`. TTL klien disamakan dengan cache server: Polymarket 30 menit (`polymarket_signal_v3`), Korelasi 24 jam (`correlations_v2`) — jadi auto-fetch cuma benar-benar hit upstream kalau cache server juga sudah expired, bukan tiap kali pindah tab. Tombol manual tetap ada (diganti label "↻ Refresh ..." dari "↻ Muat ...") untuk override kapan saja. Teks placeholder statis dan instruksi di tab PETUNJUK yang menyebut "klik tombol Korelasi" / "tab RINGKASAN" (salah — Korelasi sebenarnya di tab TEKNIKAL, bug dokumentasi lama) diperbaiki sekaligus. Note "buka tab KORELASI" di widget Portfolio Risk (Jurnal) juga dikoreksi — tab itu tidak pernah ada, Korelasi adalah sub-section TEKNIKAL.

**Trade-off auto-load (didiskusikan ke user):** menambah 1 request per pembukaan tab RINGKASAN/TEKNIKAL kalau cache server expired (bukan tiap kali — Redis cache 24h/30m yang sudah ada menyerap mayoritas trafik). Risiko utamanya bukan biaya, tapi waktu render tab sedikit lebih lama saat cache benar-benar miss (network round-trip ekstra di background, non-blocking — UI lain tetap responsif). Dianggap worth it karena selama ini data ini sering kelewat dipakai (user harus ingat klik manual), padahal sama pentingnya dengan data tab lain yang sudah auto.

**3. Satukan jalur Thesis AI → Sizing Calculator → Checklist → Jurnal/MT5 (pola yang sama dengan Session 87, sekarang satu jalur resmi dari hulu ke hilir).** Tombol "Gunakan untuk mulai jurnal →" di card Thesis FX (tab RINGKASAN) sebelumnya loncat LANGSUNG ke form Jurnal, melewati gate skor Checklist DAN tahap sizing — inkonsistensi yang sama dengan yang diperbaiki di Sizing Calculator session 87. **Iterasi pertama** (revisi awal sesi ini) diganti ke `thesisGoToChecklist()` (loncat ke Checklist, skip Sizing) — tapi user koreksi: thesis adalah titik paling hulu di funnel (sebelum keputusan sizing pun dibuat), jadi seharusnya rute-nya ke Sizing dulu, bukan ke Checklist. **Diperbaiki jadi `thesisGoToSizing()`**: tombol "Mulai ke Sizing Calc →", pindah ke tab Sizing + auto-set `szPair` ke `pair_recommendation` + `szSetDir(t.direction)`. User isi stop/entry manual (tidak ada di data thesis), lalu lanjut natural via tombol `szGoToChecklist()` yang sudah ada (session 87) ke Checklist → Jurnal/MT5. Auto-tick item Checklist relevan tetap otomatis lewat `ckAutoTickRegimeCheck` yang sudah ada, begitu pair di-set di tahap Checklist. `ckPrefillJurnal()` dan `ckShowMt5Modal()` tetap override direction inferred dari CB bias dengan direction AI thesis (`_lastThesis.direction`) kalau pair cocok, dan katalis/invalidasi thesis ikut nempel ke teks jurnal final.

**Testing:** extract + `new Function()` semua inline `<script>` setelah tiap perubahan — lolos tanpa syntax error. Verifikasi manual TTL cache server vs client (`correlations.js` CACHE_TTL=86400, `admin.js` polymarket CACHE_TTL=1800) untuk pastikan guard client selaras, tidak over-fetch.

---

## Changelog Session 92 (2026-06-23)

### Bug fix — Portfolio Risk widget (Jurnal) hitung dollar-risk XAU/USD 10x lebih kecil dari Sizing Calculator

**Konteks:** User menyadari ketidakcocokan: Sizing Calculator bilang "At risk $66.80" (XAU/USD, 0.02 lots, stop 3000p), tapi widget "Portfolio Risk" di tab Jurnal cuma menampilkan "$7" untuk posisi yang sama.

**Root cause:** pip size XAU/USD didefinisikan di 3 tempat secara konsisten sebagai `0.01` (lihat `calcPipValueUSD()` baris ~7638, `szAutoComputePips()` baris ~7768, `szUpdatePipInfo()` baris ~7867 — 1 pip = $0.01 pergerakan harga, pip value = $1/lot/100oz). Tapi fungsi `PIP_SIZE()` di renderer Portfolio Risk (dalam `jnRenderVaR`, dipakai untuk hitung `stopPips` dari selisih entry/stop price) keliru pakai `0.1` untuk XAU/USD — 10x lebih besar. Karena `stopPips = priceDiff / pipSize`, pembagi yang 10x kebesaran membuat `stopPips` (dan akibatnya `dollarRisk = stopPips × pipValue × lots`) terhitung 10x lebih kecil dari realita.

**Fix:** ubah `PIP_SIZE` XAU/USD dari `0.1` → `0.01` agar konsisten dengan 3 tempat lain.

### Bug fix tambahan — note "buka tab KORELASI" muncul walau cuma 1 posisi open

**Konteks:** User nanya kenapa widget Portfolio Risk minta buka tab KORELASI padahal cuma ada 1 posisi (XAU/USD) — korelasi antar pair logikanya cuma relevan kalau ada 2+ posisi.

**Root cause:** `noCorrNote` di `jnRenderVaR` (baris ~8442) ditampilkan berdasarkan `!corrData` doang, tanpa cek jumlah posisi. Padahal `portfolioVar1d` cuma memanggil `getCorr()`/`corrData` kalau `vi.length > 1` (baris ~8401-8414) — dengan 1 posisi, `portfolioVar1d = vi[0].var1d` langsung, korelasi sama sekali tidak dipakai.

**Fix:** tambah kondisi `varItems.length > 1` ke `noCorrNote` supaya note itu cuma muncul kalau korelasi benar-benar relevan untuk kalkulasi yang sedang ditampilkan.

**Verifikasi:** `node -e` simulasi manual dengan angka kasus user (stop 3000p, 0.02 lots, pip value $1/lot) → hasil `$60.00` setelah fix, sangat dekat dengan target `$66.80` Sizing Calculator (selisih kecil murni dari pembulatan `lots` ke 2 desimal, bukan bug); sebelum fix hasilnya `$6` (cocok dengan `$7` yang dilaporkan user, beda dikit karena rounding stop price). Extract+`new Function()` semua inline `<script>` di `index.html` → tidak ada syntax error. Grep ulang memastikan tidak ada sisa pip-size `0.1` lain untuk XAU/USD di file.

---

## Changelog Session 91 (2026-06-23)

### Bug fix — status "LIVE (fallback)" tidak pernah muncul karena Redis cache-hit path lupa propagate `X-News-Source`

**Konteks:** User curiga sebuah artikel di tab NEWS ("...Asia-Pacific FX news wrap...") sebenarnya berasal dari fallback Investinglive (link mengarah ke investinglive.com, dan headline itu tidak ada di website financialjuice.com), padahal status pill di UI menunjukkan "LIVE" biasa, bukan "LIVE (fallback)". Awalnya diasumsikan itu cuma konten sister-site yang disindikasi FinancialJuice — tapi ditelusuri lebih dalam ke kode karena user tetap yakin.

**Root cause ditemukan di `api/feeds.js` `rssHandler`:** payload yang disimpan ke Redis (`rss_cache`) menyimpan field `source` (`'financialjuice'` atau `'investinglive_fallback'`), tapi dua jalur baca cache — cache-hit normal (baris ~63-69) dan stale-cache saat fetch gagal total (baris ~107-112) — keduanya **tidak pernah** men-set header `X-News-Source` dari `obj.source`, hanya men-set `X-Cache-Source`. Frontend (`index.html` `fetchRSS()`) default ke `lastNewsSource = 'financialjuice'` kalau header itu kosong, jadi setiap kali respons disajikan dari Redis cache (yang sebagian besar waktu, karena TTL 60s) — info fallback hilang dan status pill salah tampil "LIVE" walau isi feed sebenarnya dari investinglive.

**Fix:** tambah `res.setHeader('X-News-Source', obj.source || 'financialjuice')` di kedua jalur baca cache (REDIS hit dan STALE).

**Verifikasi:** `node --check api/feeds.js` lolos. Tidak ada jalur baca `RSS_CACHE_KEY` lain yang terlewat (grep konfirmasi cuma 2 baca + 1 tulis). Belum diverifikasi live end-to-end karena butuh momen FinancialJuice benar-benar down untuk memicu fallback secara natural — perbaikan ini struktural (memastikan header source selalu konsisten antara fresh-fetch dan cache-hit), bukan logic baru yang berisiko regresi.

---

## Changelog Session 90 (2026-06-22)

### Audit tab CHECKLIST untuk skenario multi-window

**Konteks:** Lanjutan session 89 (multi-window). User nanya "ada yang kepanjangan placeholdernya ga". Ketemu 2 hal nyata via Playwright + baca kode langsung (bukan cuma screenshot sekilas):

1. **Bug fungsional** — fitur hash-restore dari session 89 (`restoreViewFromHash()`) dipanggil sebagai IIFE saat script masih di-parse, SEBELUM `const SZ_PAIRS`/`PLAYBOOKS`/`CK_SECTIONS` (dideklarasikan ratusan baris di bawah dalam script yang sama) selesai diinisialisasi. Akibatnya: buka window baru langsung ke `#checklist` (atau tab lain yang depend ke const-const itu) → `ReferenceError` (temporal dead zone) di tengah `initChecklist()`, pair selector gagal terisi. Lolos dari verifikasi session 89 karena waktu itu cuma dites pakai `#jurnal` (kebetulan gak kena TDZ). **Fix:** panggilan restore dipindah ke dalam `window.addEventListener('load', ...)` yang sudah ada (jalan setelah seluruh script selesai dieksekusi, jadi semua const sudah pasti siap) — bukan lagi IIFE di tempat lama.
2. **Bug visual pre-existing** (bukan sebab multi-window, tapi kebuka jelas pas ngecek lebar sempit) — widget "Progress" di sidebar Checklist (`.ck-sp-name`) punya `width: 52px` hardcoded buat nama tiap section, jadi 8 dari 10 judul section ("VALIDITAS DRIVER", "FUNDAMENTAL BIAS", "PRE-MARKET DECISION", dst) kepotong jadi cuma ~7 karakter + "…" — **ini terjadi di SEMUA lebar window termasuk desktop 1920px penuh**, gak ada hubungan sama multi-window, cuma baru ketahuan pas ditest. Fix: lebar dinaikkan ke 78px (2 judul paling panjang — "PRE-MARKET DECISION"/"STRUKTUR TEKNIKAL" — masih kepotong dikit, sisanya sekarang utuh) + tambah native `title` attribute biar ada tooltip hover nampilin judul lengkap kalau masih kepotong.

**Hal lain yang DICEK tapi TIDAK bermasalah:** section header utama ("VALIDITAS DRIVER" dkk di body checklist, bukan sidebar) wrap 2 baris secara wajar di lebar ~800px tanpa kepotong/rusak; verdict besar "SIAP TRADE" wrap jadi 2 baris di sidebar 232px tapi tetap utuh terbaca; MT5 modal & override modal terverifikasi rapi di 480px (quarter-window). Sidebar Checklist (Quick Check + Waktu/clock + tombol Reset) memang sengaja disembunyikan total di lebar <768px (breakpoint mobile lama) — diganti versi ringkas (verdict + progress bar + tombol Jurnal/MT5 doang) di mobile bar; ini desain lama yang masih konsisten dipakai, bukan regresi dari multi-window, cuma dicatat di sini sebagai konteks kalau user pop-out Checklist ke window sempit (<768px) dan nyari tombol Reset/Quick Check nggak ketemu — naikkan lebar window dulu kalau perlu fitur itu.

**Testing:** Playwright headless, lebar 480/700/800/900/1100/1920px, pair EUR/USD, ~80% item dicentang biar semua widget (verdict ENTRY-state, tombol Jurnal/MT5, Progress list penuh) ke-render — sebelum fix: error TDZ + sidebar truncation 8/10; sesudah fix: hash-restore checklist sukses (pair selector terisi, tidak ada console error), sidebar truncation tinggal 2/10 (yang memang nggak mungkin fit di 232px tanpa redesain total), no horizontal overflow di semua lebar yang dites.

---

## Changelog Session 89 (2026-06-22)

### Multi-window support — hash routing + tombol pop-out

**Konteks:** User minta app bisa dipakai fleksibel kalau dibuka jadi 4 window terpisah di layar laptop (window manager OS, bukan split-view internal). Ditemukan 2 hal lewat audit kode: (1) `activeView` sudah variabel in-memory per-window (bukan localStorage), jadi tiap window browser yang dibuka ke app ini SUDAH otomatis independen navigasinya satu sama lain — tidak perlu di-refactor; (2) yang BENERAN belum ada: cara mendaratkan sebuah window langsung ke view tertentu (tiap window baru selalu mulai dari DASHBOARD/NEWS, user harus klik tab manual tiap kali), dan cara cepat "lempar" view yang sedang aktif ke window baru.

**Implementasi:** hash routing (`switchView`/klik tab nav sekarang `history.replaceState(null,'', '#'+view)`), restore-on-load (`restoreViewFromHash()` IIFE + `hashchange` listener baca `location.hash` lalu `.click()` tab yang sesuai), dan tombol pop-out baru (⧉, id `popoutBtn`, di header sebelah ikon lonceng) yang `window.open()` ke `location.href` + `#activeView` dengan window name `dm_<view>` (re-klik popout utk view yg sama fokus ke window yang sudah ada, bukan numpuk duplikat).

**Bug ditemukan & diperbaiki saat verifikasi:** handler `window.addEventListener('load', ...)` yang lama selalu force-klik tab DASHBOARD di desktop width, override hash routing yang baru — di-guard supaya skip default-landing itu kalau `location.hash` sudah berisi view spesifik.

**Testing:** Playwright headless (chromium, viewport desktop & 480px/quarter-screen-laptop): klik tab → hash berubah (`#sizing`/`#jurnal`/`#checklist`), reload langsung ke `#jurnal` → landing tepat di Jurnal (sebelum fix: salah landing ke Dashboard), klik pop-out → window baru ke URL yang benar, dan screenshot di 480px untuk Sizing/Checklist/Jurnal — tidak ada overflow horizontal, bottom-nav muncul, top-nav tersembunyi (breakpoint mobile lama sudah pas dipakai ulang untuk kasus quarter-window).

---

## Changelog Session 88 (2026-06-22)

### Tombol hapus di Riwayat Sizing Calculator

**Konteks:** Dipicu user nanya "history sizing calc ga perlu di hapus kah" pas lagi coba-coba hitung sizing (dikonfirmasi dulu ke user: coba-coba di Sizing 100% aman, nggak nyentuh skor Checklist/Jurnal/AI Coach — cuma numpuk di riwayat read-only yang sebelumnya nggak bisa dihapus manual, walau backend sudah auto-cap 10 entry terakhir).

**Implementasi:** `api/sizing-history.js`: tambah `DELETE` — `?timestamp=X` hapus satu entry (`ZREMRANGEBYSCORE` pakai timestamp sebagai score, sesuai cara `ZADD` nyimpennya), `?all=1` hapus semua (`DEL` key). `index.html`: tombol "×" kecil per-item (`szDeleteHistoryItem`) + "Hapus semua" di header riwayat (`szClearAllHistory`) — optimistic update (hapus dari local cache + re-render duluan, network call fire-and-forget, konsisten sama pola `szSaveHistory` yang sudah ada).

**Testing:** diuji live ke Redis production pakai device_id sintetis: POST 2 entry → DELETE 1 by timestamp (sisa 1 entry yang benar) → DELETE all (kosong) — semua sesuai ekspektasi.

---

## Changelog Session 87 (2026-06-22)

### Satukan jalur entry: Sizing Calculator → Checklist → Jurnal/MT5

**Konteks:** Dulu ada 2 jalur paralel beda ketat. User bingung liat tombol Sizing langsung "→ BUAT TRADE DI JURNAL" sementara Checklist juga punya jalur sendiri ke MT5/Jurnal — ternyata itu memang inkonsistensi nyata: `szPrefillJurnal()` lama loncat LANGSUNG ke form Jurnal, melewati gate skor Checklist, snapshot CB bias/COT, DAN friksi override yang baru dibangun session 85 — sama sekali nggak lewat pagar yang sudah dibangun di jalur lain.

**Fix:** diganti jadi `szGoToChecklist()`: pindah ke tab Checklist + auto-set `ckPairSelector` ke pair yang sama dengan hasil sizing (penting — `ckShowMt5Modal()` cuma auto-fill lot/SL/TP dari `window._lastSizing` KALAU pair-nya match persis; tanpa auto-sync ini, user tetap harus pilih pair manual ulang di Checklist, balik bingung lagi). Sekarang cuma ada SATU jalur resmi: Sizing → Checklist (gate + snapshot + override-friction) → Jurnal/MT5, lot/SL/TP nempel otomatis sepanjang jalur tanpa input ulang.

---

## Changelog Session 86 (2026-06-22)

### MFE/MAE di Jurnal + Event Risk di Sizing Calculator

**Konteks:** Dipicu kritik gaya-Gemini soal `api/journal.js` (AI Coach "buta eksekusi" — nggak tahu harga sempat bergerak favorable sebelum exit, cuma evaluasi thesis vs hasil akhir) dan `calcSizing()` (ATR cuma lihat volatilitas 14 hari ke belakang, buta terhadap event kalender besok seperti NFP/FOMC yang bisa bikin lot besar over-leveraged). User pilih 2 dari 4 saran (skip pagination AI Coach & hard-multiplier sizing yang dinilai kebablasan).

**MFE/MAE (`api/journal.js`):** Dihitung SEKALI, persis saat trade ditutup (PATCH ke status closed/archived) — bukan retroaktif saat analyze, karena cache OHLCV cuma rolling window (~5 hari di 1H, ~10 hari di 4H, ~30 hari di 1D, di-refresh terus oleh cron `ohlcv_sync`), jadi cuma saat-trade-ditutup itu satu-satunya momen data dijamin masih nutup `entry_time`. Fungsi `computeMfeMae()` coba 3 tier granularitas (1h→4h→1d), pakai yang pertama nutup penuh durasi trade; kalau ketiganya gagal (trade kelamaan held atau pair nggak ke-sync) → field `quality: 'unavailable'` eksplisit, BUKAN angka ngarang. Hasil masuk ke prompt AI (instruksi baru "Realitas Eksekusi" — AI diminta bedain LOSS karena thesis salah (MFE kecil) vs LOSS karena panic-exit (MFE besar tapi tetap exit rugi)) dan ditampilkan di card list Jurnal (cuma kalau data tersedia — disembunyikan kalau unavailable, biar nggak nge-spam "data tidak cukup" di tiap card trade lama). Diverifikasi live ke Redis production: entry 2 jam lalu kena window-gap karena cron OHLCV sedang lag ~3-4 jam (temuan sampingan, dicatat tapi nggak difix di sesi ini), entry 8 hari lalu berhasil fallback ke tier 1h (gap weekend bikin 120 candle 1H nutup >10 hari kalender), entry 40 hari lalu & pair non-sync benar2 ke-flag unavailable.

**Event Risk (`calcSizing()` di `index.html`):** Reuse `calData` (variabel global yang sudah ada) + `_ckEvTimestamp()` (helper yang sebelumnya cuma dipakai Checklist) — bukan endpoint/fetch baru. Window 24 jam (lebih lebar dari Checklist yang 6 jam, karena sizing adalah keputusan pre-trade yang diambil lebih awal dari trigger entry). Kalau ada event High-impact untuk currency base/quote pair dalam 24 jam: banner merah `#szEventRiskWarning` + saran "Lot diskon 50%" ditampilkan **di samping** hasil normal — TIDAK auto-apply/force, user tetap pilih sendiri (konsisten sama filosofi "warn don't dictate" yang sudah dipakai di seluruh app ini, ditolak ide Gemini soal hard-multiplier otomatis). Diverifikasi live ke kalender production: 10 event High-impact real hari itu (CAD CPI, AUD jobs, USD PCE) semua di luar 24 jam dari "now" jadi nggak trigger — dikonfirmasi BENAR (bukan bug) dengan event sintetis yang disisipkan manual ke response asli.

---

## Changelog Session 85 (2026-06-22)

### Smart Checklist — friksi wajib-alasan saat override item auto-blocked

**Konteks:** Dipicu kritik gaya-Gemini tentang fitur Checklist (`ckPrefillJurnal` dinilai brilian sebagai jembatan pre-trade→jurnal, tapi rawan *self-deception* kalau checklist 100% manual). Sebelum implementasi, riset kode dulu via subagent (2x) — temuan penting: auto-tick **sudah ada** (`ckAutoTickRegimeCheck`, item `rc1`-`rc5` + beberapa item per-playbook) tapi cuma kosmetik, badge hijau/merah doang — user bisa klik & flip item auto-blocked kapan saja tanpa friksi sama sekali, jadi auto-tick yang ada sekarang nggak ngefek apa-apa ke kebiasaan FOMO. Opini saya ke user: ide Gemini "user tidak bisa mengubahnya" (hard-lock total) kebablasan untuk app discretionary trading (data auto bisa lag/ambigu — sudah kebukti berulang kali sepanjang proyek ini), tapi versi "wajib ketik 1 kalimat alasan kalau override" itu level yang pas. User: "boleh buat saja".

**Implementasi:** state baru `ckAutoBlocked{}`/`ckAutoBlockHints{}` (in-memory, direkomputasi setiap `ckAutoTickRegimeCheck` jalan) + `ckOverrideReasons{}` (persisted per-pair, key `daunmerah_v2_overrides_<PAIR>`, sejalan dengan `ckState` yang sudah per-pair). `ckToggleItem(id)`: kalau user mau centang item yang sedang `ckAutoBlocked`, nggak langsung toggle — buka modal `#ckOverrideModal` (`ckRequestOverride`) yang nampilin alasan kenapa item itu di-block sistem (`ckAutoBlockHints[id]`) + textarea wajib diisi ≥5 karakter sebelum tombol konfirmasi aktif (`ckOverrideInputCheck`). Konfirmasi (`ckConfirmOverride`) baru men-set `ckState[id]=true` + simpan alasan, badge berubah jadi kuning "⚠ overridden" (beda dari hijau "✓ auto" dan merah "⚠ blocked"). Item non-blocked tetap toggle bebas tanpa friksi apapun — friksi cuma kena ke override sinyal merah, bukan ke checklist manual biasa.

**Self-cleanup logic:** uncheck item yang sudah di-override → hapus alasan tersimpan (state nggak nyangkut). Kalau sistem sendiri kemudian bilang item itu OK (`ckAutoTick` jalan lagi, kondisi sudah resolve) → alasan override lama otomatis dihapus juga, supaya teks jurnal nggak bawa catatan "override" yang sudah nggak relevan.

**`ckPrefillJurnal`/MT5-entry thesis text** (2 tempat, sama-sama dipatch): item yang dicentang via override sekarang muncul dengan anotasi `✅ [label] (⚠ override: "[alasan user]")` — supaya rekam jejak journal beneran mencatat KALAU dan KENAPA user melawan sinyal otomatis, bukan cuma checkbox polos.

**Bug lama ikut diperbaiki sambil di sini:** `ckAutoTick` sebelumnya hanya reset warna/teks badge kalau badge BARU dibuat (`if (!badge)`) — item yang pernah merah lalu sistem bilang OK lagi akan TETAP nampak merah secara visual walau `ckState` sudah `true`. Sekarang badge selalu di-reset warna/teks tiap kali `ckAutoTick`/`ckAutoBlock` jalan, nggak peduli badge baru atau lama.

**Testing:** `node --check` semua inline `<script>`, 6 skenario logic test terisolasi (toggle item blocked → minta override; konfirmasi dengan alasan valid → overridden; alasan terlalu pendek → ditolak; item manual normal → toggle bebas; uncheck item overridden → alasan terhapus; sistem auto-resolve → alasan stale ikut terhapus) — semua PASS. Live sanity check via `vercel dev` (index.html load 200, tidak ada syntax error). **Catatan jujur:** tidak ada verifikasi visual klik-modal di browser sungguhan (Playwright belum terinstall) — sebatas logic test + structural HTML review terhadap pattern modal yang sudah teruji (`mt5Modal`).

---

## Changelog Session 84 (2026-06-22)

### Auto-fill Catatan Analisa (manual trigger via tombol)

**Konteks:** User minta balik tombol auto-fill di Catatan Analisa juga ("kamu boleh tambahin juga auto di catatan analisa") — tapi kali ini cuma manual-trigger via tombol "↻ Auto" yang diklik eksplisit, TIDAK auto-jalan sendiri di pair switch/tab init (beda dari percobaan session 83 yang langsung di-reject).

**Implementasi:** `composeTekAutoNote()` + `autoFillTekNote()` ditambah balik, isinya identik dengan versi yang sempat direvert — bedanya cuma di wiring: tidak dipanggil dari `selectTekPair()`/`initTeknikal()`, hanya dari `onclick` tombol. Klik tombol akan mengganti isi catatan yang ada (bukan cuma kalau kosong) karena klik eksplisit = consent untuk replace.

---

## Changelog Session 83 (2026-06-22)

### Auto-fill dropdown MTF (D1/H4/H1) di tab TEK dari trend Makro/Swing/Entry

**Konteks:** Percobaan pertama (salah paham) auto-fill ke textarea "Catatan analisa" — user koreksi langsung: "kalau catatan analisa itu aku aja yang buat catatannya", yang dimaksud justru dropdown alignment "D1 −, H4 −, H1 −, M15 −" yang sebelumnya manual full (pilih Bull/Bear/Neut sendiri per timeframe). Revert: hapus tombol/wiring auto-fill dari Catatan Analisa, textarea itu kembali 100% manual seperti semula.

**Implementasi:** `mapTrendToMtf()` + `autoFillMtfSelectors()` — D1/H4/H1 diisi otomatis dari `d.d1.trend`/`d.h4.trend`/`d.h1.trend` (sumber data sama dengan tab ANALISA, `/api/admin?action=ohlcv_read`, reuse `analisaDataCache`), map Uptrend→bull/Downtrend→bear/Sideways→neut. M15 sengaja dibiarkan manual — tidak ada trend H15 terkomputasi di mana pun di app ini, daripada fabrikasi sinyal kualitas rendah. Non-destructive: cuma isi selector yang masih kosong (`—`), tombol "↻ Auto" di baris dropdown buat force-regenerate D1/H4/H1 kapan saja. Keterbatasan sama dengan sebelumnya: cross pair non-major kadang belum punya data MTF tersedia (limitasi `ohlcv_sync` lama) — ditangani toast pesan jelas.

---

## Changelog Session 82 (2026-06-22)

### Option Gravity Heatmap — Tab TEK

**Konteks:** Lanjutan diskusi proposal UI/UX (heatmap option expiry + macro quadrant risk/inflasi). Sebelum eksekusi, dievaluasi kritis dulu: macro quadrant ditahan (lihat alasan di catatan header atas), heatmap option dieksekusi karena murah secara teknis dan datanya nyata.

**Constraint teknis yang ditemukan:** data `size` dari option expiry (`api/feeds.js` `optionsHandler`) sering kosong sejak Investinglive pindah ke format prosa (lihat session sebelumnya soal `parseProseExpiries`) — jadi "gravitasi" nggak bisa selalu dihitung dari notional asli. Solusi: fallback ke count-based weight (tiap level yang disebut = weight 1) kalau size kosong/tidak terparse, size asli dipakai kalau ada (dinormalisasi ke skala "juta": "1.2bln" → 1200, "500mln" → 500).

**Implementasi (`index.html`):**
- `parseOptionSizeWeight(sizeStr)` — parse string size ("1.2bln", "€500m", dll) jadi angka weight; fallback 1 kalau kosong/gagal parse.
- `renderOptionGravityHeatmap(filtered)` — bukan clustering eksplisit, tapi histogram-binning: range harga (termasuk level min/max + current price kalau tersedia dari `tekTaCache`) dibagi 36 bin, tiap level expiry menambah weight ke bin terdekat + sedikit smoothing ke bin tetangga (25% spillover) supaya level berdekatan terlihat menyatu jadi satu hot-zone, bukan paku terpisah-pisah. Render sebagai strip flexbox CSS murni (tinggi bar + opacity warna oranye proporsional terhadap intensitas) — tidak ada library chart yang ditambahkan. Current price ditandai garis vertikal "NOW". Bawahnya ditampilkan teks 3 level "gravitasi terkuat" sebagai ringkasan cepat.
- Graceful degradation: kalau cuma 0-1 level numerik valid (kasus nyata — hari testing cuma ada 1 expiry GBP/USD), fungsi return string kosong dan tabel level yang sudah ada tetap tampil normal tanpa heatmap, tidak ada elemen kosong/error yang nongol.
- CSS baru: `.tek-grav-*` (wrap/strip/bin/axis/now-marker/peaks), reuse warna `--yellow`/`--muted`/font `DM Mono` yang sudah ada di tema.

**Testing:** 6 skenario logic test terisolasi (cluster realistis, size berformat, single-point skip, array kosong, format range "1.1540-1.1600", tanpa current price) — semua sesuai ekspektasi. Live wiring test ke `api/feeds?type=options` production (data real hari ini: cuma 1 expiry GBP/USD 1.3200) — konfirmasi graceful skip jalan benar, tidak ada heatmap kosong yang dipaksa render. Render HTML preview manual dengan data multi-level mock — visual hot-zone muncul tepat di level dengan size terbesar, marker NOW di posisi proporsional yang benar. **Catatan jujur:** tidak ada verifikasi screenshot browser asli (Playwright tidak terinstall di environment ini) — verifikasi sebatas logic test + HTML/CSS preview manual, bukan visual end-to-end di browser sungguhan.

---

## Changelog Session 81 (2026-06-22)

### Risk Regime "Selalu Neutral" — Investigasi yang Membalik Hipotesis Sendiri

**Konteks:** User penasaran kenapa badge Risk Regime di tab TEK sepertinya selalu nampilkan "NEUTRAL" — bertanya apakah itu kondisi pasar yang genuinely netral atau fitur yang nggak berfungsi.

**Langkah 1 (live check):** Tarik VIX & MOVE langsung dari Yahoo Finance — VIX=17.51, MOVE=65.4, keduanya valid (bukan fetch gagal). `classifyRegime()` di `api/risk-regime.js` butuh VIX<15 untuk `risk_on`, dan VIX 17.51 jatuh di celah 15-20 (bukan risk_on, bukan elevated >20) → otomatis `neutral`.

**Langkah 2 (hipotesis awal, keliru):** Cek distribusi VIX 2 tahun terakhir — VIX<15 cuma 14% hari, 15-20 (zona neutral) 61.3% hari. Simpulkan sementara: threshold `risk_on` (VIX<15) kelewat strict dibanding realisasi pasar, sehingga `neutral` jadi default state. **Disampaikan ke user sebagai temuan awal.**

**Langkah 3 (backtest 10 tahun, membalik kesimpulan):** User minta dikerjakan recalibration. Sebelum mengubah angka, backtest `classifyRegime()` versi SEKARANG terhadap histori VIX+MOVE 10 tahun penuh (bukan 2 tahun) — hasilnya: **risk_on 26.3% / neutral 28% / elevated 28.2% / risk_off 17.5%**, distribusi yang sudah sehat, tidak didominasi satu bucket. Coba 4 kandidat threshold baru berbasis persentil (p25/p50/p75/p90 dari histori 10 tahun) — semua kandidat baru TIDAK memperbaiki apapun: salah satu varian (`p25/p75/p90`) malah memperburuk jadi neutral 47.2%, dan **tidak satupun** kandidat mengubah hasil klasifikasi hari itu (VIX=17.47, MOVE=65.4) — tetap `neutral` di semua varian, karena nilai itu memang persis di persentil-53 (median) histori 10 tahun.

**Kesimpulan revisi:** threshold yang ada SEKARANG sudah cukup baik dikalibrasi terhadap siklus pasar 10 tahun. Yang membuat user merasa "selalu neutral" adalah dua hal yang bukan bug: (1) 2024-2026 secara realized memang periode vol yang lebih tinggi dari rata-rata dekade (VIX<15 cuma 14% di window ini vs 35% di 10 tahun penuh), dan (2) logika "worst-indicator-wins" multi-sinyal (VIX/MOVE/HY) secara matematis selalu membuat `risk_on` butuh SEMUA indikator calm bersamaan (AND) sementara `elevated`/`risk_off` cuma butuh SATU indikator memburuk (OR) — asimetri ini inheren di desain risk dashboard konservatif, bukan sesuatu yang "bisa diperbaiki" tanpa mengorbankan keandalan sinyal risk_off.

**Yang dieksekusi (bukan ubah threshold, tapi tambah konteks):** `api/risk-regime.js` — tambah breakpoint persentil `VIX_PCTL_10Y` / `MOVE_PCTL_10Y` (dari Yahoo 10y daily, dihitung 2026-06-22) + `percentileRank()` (interpolasi linear), field baru `vix_percentile_10y` / `move_percentile_10y` di response. `index.html` — baris VIX/MOVE di detail breakdown regime banner sekarang menampilkan persentil (mis. "· P53/10th"), plus catatan kecil menjelaskan artinya, supaya user paham bahwa "neutral" sering = median yang valid, bukan symptom kerusakan.

**Pelajaran:** jangan commit ke "fix" berdasarkan sampel waktu pendek (2 tahun) yang kebetulan biased terhadap periode anomali — backtest pakai window yang merepresentasikan siklus penuh dulu sebelum mengubah threshold produksi.

---

## Changelog Session 80 (2026-06-22)

### NEWS Fallback Source — Investinglive Kalau FinancialJuice Down

**Konteks:** Lanjutan session 79 — item "tidak dieksekusi" (fallback RSS) sempat ditunda karena belum ada sinyal urgensi. User minta dicek ulang: "cek bagian news, apakah bisa di scrap." Bukan asumsi — langsung uji fetch ke beberapa kandidat dari jaringan nyata sebelum menjawab.

**Hasil riset kandidat:**
| Sumber | Hasil |
|---|---|
| Investinglive `/feed/news/` | ✅ HTTP 200, RSS standar WordPress, 25 item, genre macro/forex sama persis dengan FJ (politik UK, Iran/Hormuz, China rare earth) |
| Investing.com `/rss/news_1.rss` | ✅ HTTP 200, kategori "Forex News" khusus |
| DailyFX | ❌ fetch gagal total |
| FXStreet | ❌ fetch gagal total |
| Reuters (feed publik) | ❌ 404, sudah tidak aktif |

Investinglive dipilih: domain sudah dipercaya (dipakai untuk option expiries di `optionsHandler`), dan struktur XML-nya (`<rss><item><title><guid><pubDate><link><description>`, CDATA-wrapped) **kompatibel langsung** tanpa transformasi dengan parser yang sudah ada (`parseRSSItems` di server, `parseRSS` di frontend) — tidak perlu endpoint normalisasi baru.

**Implementasi (`api/feeds.js` `rssHandler`):** Tambah `RSS_FALLBACK_URL`. Kalau fetch FinancialJuice gagal (network error / HTTP non-200 / response bukan RSS), coba fetch Investinglive sebelum jatuh ke stale Redis cache. Cache payload (`rss_cache`) sekarang menyimpan field `source` (`'financialjuice'` atau `'investinglive_fallback'`) untuk observability. Response header baru `X-News-Source` (selain `X-Cache-Source` yang sudah ada, sekarang juga punya value `FALLBACK`).

**Bug ikut ditemukan & diperbaiki (pola sama dengan session 79):** `redisCmd('SET', RSS_CACHE_KEY, ...).catch(()=>{})` di `rssHandler` adalah fire-and-forget tanpa `await` sebelum response dikirim — berisiko function Vercel mati sebelum SET selesai (TTL cache cuma 50-60s jadi dampaknya kemungkinan setiap fetch nyaris selalu miss cache dan hit upstream langsung, memperberat beban ke FinancialJuice). Diubah jadi `await` dengan try/catch.

**Frontend (`index.html`):** `fetchRSS()` sekarang membaca header `X-News-Source` dan simpan ke `lastNewsSource`. `fetchFeed()`: kalau `lastNewsSource === 'investinglive_fallback'`, status pill NEWS tab tampil "LIVE (fallback)" dengan dot kuning berkedip (`.dot.warn`, CSS baru — reuse pola blink dari `.dot.live` tapi warna `var(--yellow)`) supaya user sadar sedang baca sumber non-primer, bukan diam-diam ganti sumber tanpa indikasi.

**Testing:** `node --check` semua file + extract inline `<script>`. Live test via `vercel dev` + Redis production: (1) path normal — `financialjuice`, 100 item, header `X-News-Source: financialjuice`; (2) path fallback — `global.fetch` di-monkey-patch supaya request ke `financialjuice.com` reject, request ke Investinglive tetap asli → hasil 25 item, `X-Cache-Source: FALLBACK`, cache Redis tersimpan dengan `source: investinglive_fallback` (diverifikasi langsung via Upstash REST GET, bukan cuma percaya response). Direplay juga logic `parseRSS()` frontend persis terhadap XML Investinglive asli — 25/25 item lolos punya guid+title+pubDate+link lengkap.

---

## Changelog Session 79 (2026-06-22)

### Audit Ketahanan Informasi — 4 Perbaikan Silent-Failure di `api/`

**Konteks:** User membawa kritik dari Gemini soal kerentanan arsitektur `api/` (stuck CB bias, OHLCV blind spot saat rotasi pair, TA cache nunggu user, calendar tanpa fallback, single-source RSS). Sebelum eksekusi, kritik tersebut **diverifikasi langsung ke kode** (bukan ditelan mentah) — beberapa klaim Gemini ternyata salah/basi karena dia tidak baca `index.html`: staleness indicator UI sebenarnya **sudah ada luas** (9+ tempat: `cotStaleBadge`, CB rate liveDot, correlations/polymarket/research/retail-positioning stale tag, dll), dan OHLCV cache **sudah** punya cron warmer (GitHub Actions `ohlcv-sync.yml`, hourly) — Gemini melewatkan keduanya. Sebaliknya, `api/calendar.js` ternyata **lebih rapuh** dari yang Gemini bilang: satu-satunya endpoint tanpa serve-stale-cache sama sekali (langsung 500 kalau ForexFactory/Cloudflare block IP Vercel), padahal pola serve-stale sudah konsisten dipakai di `correlations.js`.

**Perbaikan yang dieksekusi (prioritas direvisi berdasarkan temuan di atas):**

1. **`api/calendar.js` — stale-cache fallback (prioritas tertinggi, gap nyata).** Tambah `CACHE_KEY='calendar_v1'`, TTL 6 jam. Sukses fetch → `await redisCmd('SET', ...)` (awalnya ditulis fire-and-forget `.catch(()=>{})` tanpa `await` — **bug nyata ketemu saat testing**: function Vercel mati sebelum SET selesai, jadi cache_v1 selalu kosong. Diperbaiki jadi `await` sebelum response dikirim, diverifikasi ulang via Upstash REST langsung). Saat fetch gagal total → serve cache lama dengan `stale: true` + `stale_reason`. Frontend (`index.html`): tambah `#calStaleBadge` (reuse class `.cot-stale-badge`) di header kalender, di-toggle di `fetchCalendar()` dan `fetchCalendarSilent()`.

2. **TA cache warmer — `.github/workflows/ta-warm.yml` (baru).** Hourly cron, loop 8 pair tetap (XAU + 7 FX major) ke `/api/correlations?action=ta&symbol=X&interval=1d` dengan header `x-cron-secret`. `api/correlations.js` Call `action=ta` ditambah bypass rate-limit kalau header cron-secret valid (pola sama dengan `ohlcv_sync` di `admin.js`). Cache key (`ta:{symbol}:1d`) persis sama dengan yang dibaca `fetchTaCache()` di `market-digest.js` — tidak perlu endpoint baru.

3. **`api/market-digest.js` — stuck-bias jadi divergence-flag.** Sebelumnya: swing bias >2 step dengan confidence non-High → `continue` (di-skip total, tanpa jejak). Sekarang: bias lama dipertahankan TAPI `confidence` di-downgrade ke `'Low'` + simpan `divergence_warning: {suggested_bias, suggested_confidence, detected_at, source_headlines}`. Auto-clear di cycle berikutnya kalau swing sudah mengecil atau confidence jadi High (object di-replace penuh, tidak ada field lama yang nempel). Confidence High dengan swing besar tetap langsung flip (behavior lama tidak berubah — ini fix untuk kasus ambigu saja). Diteruskan ke `cb-status.js` (`divergence_warning` di response) dan dirender di CB tracker UI (badge kuning "⚠ Divergence: bias mungkin bergeser ke X", reuse class `.cb-manual-warn`).

4. **OHLCV pair selection ikut headline dominan.** `CB_KW`/`kwTest` (sebelumnya didefinisikan lokal di dalam `_biasPromise`, dipakai cuma untuk Call 2) dipindah ke module-level supaya bisa dipakai ulang. Tambah `CUR_TO_OHLCV_PAIR` map (7 currency non-USD → pair label standar). Sebelum fetch OHLCV: hitung jumlah headline per currency dari `recentItems`, pilih currency dengan match terbanyak → map ke pair (mis. GBP dominan → `GBP/USD`). Kalau tidak ada currency mayor di headline hari ini, fallback ke `pair_recommendation` thesis kemarin (behavior lama), lalu default `EUR/USD` kalau itu pun kosong. USD sendiri tidak dihitung (sudah inherent di XAU/USD context yang selalu di-load).

**Testing:** `node --check` semua file diubah (lolos). Extract inline `<script>` dari `index.html` → `node --check` (lolos, tidak ada syntax error dari edit HTML). Replika logic test offline (tanpa cost API): pair-selection 5 skenario (GBP-dominant, EUR-dominant, no-major-news, USD-only-tidak-pilih-USD-pair, JPY-dominant) — **semua PASS**; divergence-flag 4 skenario (big-swing+Medium→flag, big-swing+High→flip langsung, small-swing→update normal, divergence-clear-di-cycle-berikutnya) — **semua PASS**. Live test: `vercel dev` lokal + `vercel env pull` (kredensial production asli) — `/api/calendar` normal & stale-fallback (disimulasikan dengan mock `fetch` reject langsung di handler) keduanya 200 dengan flag `stale` benar; `/api/correlations?action=ta` berfungsi; `/api/cb-status` mengembalikan field `divergence_warning` (null untuk currency normal). Tidak menjalankan `market-digest.js` end-to-end secara live karena costly (multi-LLM call berbayar) — divalidasi via logic replica test saja.

**Tidak dieksekusi dari saran Gemini (dengan alasan):** fallback RSS source untuk FinancialJuice — belum ada insiden downtime tercatat di histori project, risiko terendah dari 5 item yang diaudit, ditunda sampai ada sinyal nyata diperlukan.

---

## Changelog Session 75 (2026-06-22)

### BTC: Triple-Barrier Labeling — Diuji, Hasil: Signifikan Tapi Lebih Lemah Dari Champion

**Konteks:** Konsultasi eksternal (Gemini, diberi konteks lengkap `daun_merah.md` sesi 71-72 + `volatility_regime.py`) mengkritik bahwa target arah/vol-regime di proyek ini pakai label fixed-horizon (`.shift(-HORIZON)`) yang buta terhadap *path* harga — harga bisa menyentuh level lalu berbalik dalam horizon yang sama, dan tetap dianggap satu label. Diusulkan reformulasi via **Triple-Barrier Method** (Lopez de Prado): TP/SL berbasis ATR + time barrier, bukan delay tetap.

**Implementasi (`ml/triple_barrier.py`, baru):** Label long-only — untuk tiap bar, TP = close + 2×ATR, SL = close − 1×ATR, horizon 6 bar (sama dengan `target_dir_6`/`target_vol_regime_6` untuk komparasi adil). Label 1 jika TP tersentuh duluan, 0 jika SL duluan; tie dalam bar yang sama dianggap 0 (tidak bisa dipastikan urutannya dari OHLC). Dua varian time-barrier: "strict" (timeout dibuang) dan "loose" (timeout = 0). Walk-forward CV (LR/RF/GB) + permutation test, sama persis rigor eksperimen lain di proyek ini.

**Hasil:**
| Timeframe | Varian | AUC terbaik (Logistic Regression) | p-value |
|---|---|---|---|
| 4h | loose | 0.582 ± 0.024 | 0.000 |
| 4h | strict | 0.566 ± 0.023 | 0.000 |
| 1d | loose | 0.607 ± 0.075 | 0.000 |
| 1d | strict | 0.597 ± 0.067 | 0.000 |

Sinyalnya nyata (lolos permutation test di semua varian), tapi **lebih lemah dan jauh kurang stabil** dibanding champion proyek (`target_vol_regime_6`: AUC 0.633 ± 0.0035). Std di triple-barrier 0.02-0.075 vs 0.0035 — terutama buruk di 1d (cuma 2635 baris setelah dropna, ~527/fold). Catatan menarik: Logistic Regression menang di sini, bukan tree model — pola terbalik dari semua eksperimen lain di proyek ini (sinyal lebih linear-separable tapi tipis). Distribusi label: TP duluan ~18-20%, SL duluan ~46%, timeout ~34-36%.

**Kesimpulan:** kritik metodologis Gemini soal path-blindness itu valid, tapi memperbaikinya via triple-barrier tidak menghasilkan model lebih baik — cuma target reformulation dengan edge lebih kecil dan lebih tidak stabil. Konsisten dengan kesimpulan sesi 72: ceiling-nya ada di data (informasi yang bisa diekstrak dari OHLCV+konteks BTC sendiri), bukan di cara pelabelan atau pilihan algoritma. **Jangan disarankan ulang tanpa data/horizon yang genuinely baru.**

**File baru:** `ml/triple_barrier.py` (belum di-push — masih tahap eksperimen lokal per instruksi user).

---

## Changelog Session 72 (2026-06-19)

### BTC: EDA Target Volatility-Regime, GARCH/Sentiment, Mitigasi Multikolinearitas

**Konteks:** User minta dorong AUC volatility-regime ke 70% (dari baseline 0.633), dan minta cek ulang EDA/data-prep dulu sebelum nambah sumber data eksternal lagi — siapa tahu ada insight lebih murah daripada VIX/data baru.

**1. EDA baru, khusus target volatility-regime (`ml/eda_volregime.py`)** — EDA lama (`eda.py`) ternyata ditulis untuk target arah harga (era sebelum vol-regime jadi andalan), belum pernah diprofilkan untuk target ini. Temuan:
- Fitur non-vol (momentum/sentimen/COT) kontribusinya nyata: vol-only (3 fitur) AUC 0.58 (4h)/0.65 (1d) vs full set (25 fitur) 0.63/0.67.
- `fear_greed` masuk top-5 feature importance RF di kedua timeframe.
- ACF `realized_vol_6` sendiri decay pelan (lag1=0.91, lag6=0.43, lag20=0.35, lag60=0.21 di 4h) — ada memori volatilitas lebih panjang dari window 6/20 yang dipakai sekarang.
- Garman-Klass/Rogers-Satchell estimator cuma beda tipis dari Parkinson yang sudah dipakai — tidak worth diganti.
- Distribusi target per tahun fluktuasi besar (0.16-0.38) — sumber utama std antar-fold yang tinggi di CV 1d.

**2. GARCH(1,1) + fear_greed extremity — diuji ketat, hasil: TIDAK membantu (`ml/vol_regime_garch.py`)** — Dua ide termotivasi temuan EDA di atas: GARCH(1,1) conditional volatility (model eksplisit untuk persistence, dimotivasi temuan ACF) dan `|fear_greed-50|` (capture sentimen ekstrem di kedua arah, dimotivasi feature importance). Diuji walk-forward CV dengan disiplin no-lookahead (parameter GARCH di-fit dari training fold saja, lalu di-filter dengan parameter beku ke seluruh series). Hasil RF 4h: baseline 0.6329±0.0034, +fear_greed_extreme 0.6322±0.0105, +GARCH 0.6333±0.0031, +both 0.6337±0.0079 — semua delta dalam rentang noise. **Akar masalah ditemukan:** GARCH conditional vol berkorelasi **0.956** dengan `realized_vol_20` yang sudah jadi fitur — bukan informasi baru, cuma menurunkan ulang info yang sudah ada di rolling window.

**3. Mitigasi multikolinearitas pada fitur** — Dicek khusus untuk feature set vol-regime (16-21 pasang |corr|>0.7). Ditemukan 3 fitur vol-level yang dipakai saling redundan (realized_vol_6 ↔ parkinson_vol_mean_6 = 0.88, ↔ realized_vol_20 = 0.75-0.88) — efektif cuma ~1.5 sinyal independen, bukan 3 — ini penjelasan tambahan kenapa GARCH (mirip salah satunya) tidak nambah. Diimplementasikan: pangkas `ret_1`, `macd_signal`, `ema12_gt_ema26`, `cot_noncomm_long_pct`, `bb_pctb` dari `FEATURE_COLS` (`ml/train_models.py`) dan `realized_vol_6` dari `extra_cols` (`ml/volatility_regime.py`) — 25→19 fitur. Diverifikasi via walk-forward CV sebelum commit: tidak ada AUC cost (baseline baru 0.6302±0.0062 vs lama 0.633±0.0036, sama secara statistik), malah sedikit lebih stabil untuk Logistic Regression. Semua file hasil yang ter-commit (`model_comparison.json`, `cross_validation.json`, `regression_comparison.json`) diregenerate ulang dengan fitur yang sudah dipangkas supaya konsisten dengan kode — kesimpulan direction/regresi tidak berubah (tetap ~0.50-0.53 AUC, tetap R² negatif).

**4. VIX (cross-asset macro risk) — kandidat terakhir, dites, hasil: TIDAK signifikan.** Satu-satunya kandidat "informasi genuinely baru" yang masih belum dites setelah GARCH/sentiment ternyata cuma menurunkan ulang info yang sudah ada. VIX (CBOE volatility index, harian, gratis dari Yahoo sejak 1990 — tidak ada masalah histori pendek seperti DVOL). Korelasi mentahnya dengan target paling kuat dari semua fitur cross-asset yang dicoba (+0.07 di 4h, +0.10 di 1d). RF 4h walk-forward CV: 0.6270±0.0076 (tanpa VIX) → 0.6286±0.0028 (+VIX), delta +0.0015. Untuk memastikan bukan kebetulan, dilakukan permutation test LANGSUNG pada delta-nya (bukan cuma pada AUC) — shuffle target 30x, hitung ulang delta tiap kali, lihat di mana delta asli jatuh di distribusi itu. **Hasil: p=0.300 — tidak signifikan**, delta asli sepenuhnya konsisten dengan rentang kebetulan.

**Kesimpulan untuk pertanyaan "bisa ke 70%?":** Sudah dijawab TUNTAS secara empiris (gabungan session 71 DVOL + session 72 ini). Empat kandidat untuk push AUC di atas 0.63 — DVOL (data baru), GARCH (model lebih canggih), sentiment extremity (transformasi fitur), VIX (cross-asset macro) — semuanya dites dengan rigor walk-forward CV + permutation test, dan semuanya gagal. Ada penjelasan struktural kenapa: fitur rolling-window yang sudah ada sudah menyerap hampir semua informasi yang bisa direcover secara linear dari histori harga BTC sendiri. Untuk melewati 0.63 perlu sumber data yang genuinely baru (bukan derivasi dari OHLCV atau proxy cross-asset berkorelasi lemah) atau target/horizon yang fundamental berbeda — belum ada kandidat konkret saat ini. **Riset BTC ML sekarang benar-benar mentok tanpa input baru dari user.**

**5. Regresi besaran volatilitas (vs klasifikasi biner) — dites, hasil: GAGAL (`ml/vol_regression.py`)** — User tanya: yang sudah dites itu klasifikasi (top 30%/bukan), bagaimana dengan regresi nilai volatilitas-nya langsung? Beda dari regresi return (`train_regression.py`) yang sudah dicoba sebelumnya — ini regresi `forward_vol` (nilai kontinu di belakang threshold biner), belum pernah dicoba. Diuji walk-forward CV dengan baseline persistence (vol besok = `realized_vol_20` hari ini). **Hasil: Random Forest cuma R²=+0.030±0.049 (4h, nyaris nol) dan -0.195±0.202 (1d, negatif)** — Linear Regression dan Gradient Boosting negatif & tidak stabil antar-fold, **MLP divergen total** (R² minus ribuan, tanda training meledak). Single-split sempat kelihatan OK (R²=0.11-0.13) tapi itu fluke lagi — CV mean-nya jauh negatif, kejadian ketiga di proyek ini di mana single-split menyesatkan. **Kenapa regresi gagal padahal klasifikasi (agak) berhasil:** `forward_vol` itu standar deviasi dari cuma 6 return — sample sangat kecil, margin error sample std n=6 sekitar 30%, jadi target itu sendiri noisy. Klasifikasi cuma butuh rank/posisi relatif terhadap threshold yang benar, regresi butuh nilai eksak — itu kenapa noise target lebih mematikan untuk regresi.

**Kesimpulan akhir riset BTC ML:** output yang bisa dipakai dari seluruh riset ini adalah **classifier biner `target_vol_regime_6`** (sudah di pipeline produksi) — BUKAN forecast magnitude volatilitas. Semua jalur yang teridentifikasi sudah dites tuntas (arah harga, regresi return, klasifikasi vol-regime, regresi vol magnitude, DVOL, GARCH, sentiment extremity, VIX, multikolinearitas).

**File diupdate:** `ml/train_models.py`, `ml/volatility_regime.py`, `ml/STATUS.md`, `ml/results/REPORT.md`, `ml/results/model_comparison.json`, `ml/results/cross_validation.json`, `ml/results/regression_comparison.json`, `daun_merah_plan.md`. **File baru:** `ml/eda_volregime.py`, `ml/vol_regime_garch.py`, `ml/vol_regression.py`. (Eksperimen VIX dilakukan ad-hoc/interaktif, tidak dipersist jadi script baru karena hasilnya negatif — data `vix_test.csv` dihapus setelah pengujian selesai.)

---

## Changelog Session 71 (2026-06-19)

### BTC: Selesaikan Integrasi DVOL + Uji Ketat — Hasil: Tidak Membantu

**Konteks:** Lanjutan riset BTC dari session 70. Sebelumnya, integrasi fitur DVOL (Deribit implied volatility) berhenti di tengah jalan — data sudah di-backfill dan di-push, tapi `scripts/feature-engineering.js` belum menggunakannya di output kolom. Tujuannya menjawab pertanyaan terbuka: apakah AUC volatility-regime (baseline 0.633±0.0035) bisa didorong lebih tinggi (target 70-80%) dengan menambah DVOL sebagai fitur baru.

**Yang dikerjakan:**
1. **`scripts/feature-engineering.js`** — selesaikan kode yang sudah disiapkan (`dvolFf`, `dvolIndexByTs` sudah dihitung tapi belum dipakai): tambah `dvolIdx` lookup dan dua kolom baru ke output row: `dvol_close`, `dvol_change_1`. Regenerate `data/btc/features_4h.csv` (19.353 baris, 37 kolom) dan `features_1d.csv` (3.229 baris, 37 kolom). Coverage DVOL ~59% (terbatas sejak 2021-03-24, lebih pendek dari sumber lain 2017-18).
2. **`ml/volatility_regime.py`** — tambah opsi `use_dvol` ke `build_dataset()`, lalu jalankan perbandingan **apple-to-apple**: baseline vs +DVOL di baris yang identik (subset era-DVOL), bukan baseline-full-history vs +DVOL-history-lebih-pendek (yang akan merancukan efek DVOL dengan efek window waktu yang berbeda). Dievaluasi dengan rigor yang sama seperti eksperimen volatility-regime sebelumnya: single-split, walk-forward CV (4 fold), permutation test, 5 algoritma (Logistic Regression, Random Forest, Gradient Boosting, MLP, LSTM).

**Hasil (lengkap di `ml/results/REPORT.md` poin 10):**
- 4h: baseline di era-DVOL (n=11.473) AUC 0.6125±0.0502 vs +DVOL AUC 0.6185±0.0463 — selisih +0.006, jauh lebih kecil dari std antar-fold (0.046-0.05) → **tidak signifikan, noise bukan sinyal**.
- 1d: selisih +0.0003 — juga tidak signifikan, dan jauh lebih noisy (std 0.12-0.13) karena dataset jauh lebih kecil.
- **Temuan penting lain:** membatasi data ke era-DVOL saja (2021+, tanpa fitur DVOL sekalipun) sudah menurunkan AUC dari 0.633 (full history 2017-2024) ke 0.6125 — window 2021+ mencakup bear market BTC paling parah, lebih sulit diprediksi terlepas dari DVOL.
- **Kesimpulan:** DVOL, walau secara konsep adalah kandidat data baru paling kuat (implied volatility dari pasar opsi, beda jenis informasi dari realized vol historis yang sudah dipakai), **tidak terbukti menambah edge** setelah dievaluasi jujur. Kolom `dvol_close`/`dvol_change_1` tetap dipertahankan di pipeline (tidak merugikan), tapi tidak dipakai untuk klaim peningkatan model.

**Implikasi untuk arah riset:** AUC 0.633±0.0036 (Random Forest, 4h, volatility-regime, full history) kemungkinan adalah plafon untuk pendekatan dan fitur yang sudah dicoba. Semua jalur yang teridentifikasi (arah harga, regresi, volatility-regime, DVOL) sudah dites tuntas. Untuk melangkah lebih jauh (target 70-80%) perlu target/horizon yang fundamental berbeda atau sumber data baru — belum ada kandidat konkret saat ini.

**File diupdate:** `scripts/feature-engineering.js`, `ml/volatility_regime.py`, `ml/results/REPORT.md`, `ml/STATUS.md`, `daun_merah_plan.md`.

### Bersihkan Backlog Stale — `daun_merah_plan.md`

Audit mandiri: section 4.2 (FX Risk Reversals) dan 4.4 (Portfolio VaR) di `daun_merah_plan.md` masih berstatus "TUNGGU keputusan" / "SIAP DIKERJAKAN" — padahal keduanya **sudah live di production sejak session 46-47** (dikonfirmasi via curl ke endpoint production + cek kode `index.html`/`api/correlations.js`). Dokumen backlog belum pernah diupdate sejak 2026-06-03. Diringkas jadi catatan "selesai, live di production" supaya tidak rancu di sesi berikutnya. Backlog aktif sekarang cuma menyisakan BTC ML research (section 5), yang juga sudah mentok — semua jalur teridentifikasi sudah dites (lihat di atas).

---

## Changelog Session 70 (2026-06-18)

### Data Collection: BTC Dataset untuk Model Prediksi (Fase 1 — selesai)

**Konteks:** Eksplorasi membangun model prediksi bias arah BTC sebagai pendukung narasi thesis (bukan sinyal trading mandiri — ekspektasi akurasi directional realistis 52-58%, bukan 70-80%). Fase ini fokus murni ke data collection; modeling belum dimulai.

**Sumber data final (7 dataset, semua gratis):**
- **OHLCV spot BTC/USDT** (1h/4h/1d) — `data-api.binance.vision`, sejak 2017-08-17
- **COT Bitcoin (CME futures)** — `cftc.gov`, open interest + positioning non-commercial/commercial, mingguan sejak 2018-04
- **Fear & Greed Index** — `alternative.me`, harian sejak 2018-02
- **Hash rate** — `mempool.space`, harian sejak 2009, tanpa batasan histori
- **Stablecoin supply** (USDT+USDC market cap) — CoinGecko, harian, **dibatasi 365 hari ke belakang** (kebijakan free tier CoinGecko, bukan pilihan kita)
- **BTC dominance** — CoinGecko `/global`, snapshot harian — **tidak ada histori gratis** (Pro-only), akumulasi mulai sekarang ke depan saja
- **Funding rate (perpetual)** — di-drop, tidak ada sumber gratis yang tidak ter-geoblock
- **Orderbook live** — di-skip, tidak relevan untuk horizon intraday-swing & tidak cocok arsitektur serverless

**Masalah signifikan yang ditemukan & diperbaiki:**
1. `api.binance.com` (spot) dan `fapi.binance.com` (futures) **return HTTP 451 dari GitHub Actions runner** — Binance membatasi akses derivatif dari IP US karena alasan regulasi (CFTC restricted location), bukan bug. Spot dipindah ke `data-api.binance.vision` (mirror resmi Binance, tidak ter-geoblock). Futures (funding rate + open interest) tidak ada workaround resmi → open interest diganti sumber **CFTC COT CME Bitcoin** (kode kontrak `133741`), funding rate didrop permanen.
2. `cftc.gov` (untuk download zip historis COT) **403 di `fetch()` Node** (Cloudflare bot management, fingerprint TLS) tapi lolos via `curl` — download di `scripts/lib/cot-bitcoin.js` pakai `execFileSync('curl', ...)` bukan `fetch()`.
3. Jam sistem lokal awalnya disangka salah (cert Binance "expired") — ternyata jam benar, masalahnya DNS ISP lokal redirect `api.binance.com` ke `aduankonten.id` (blokir Kominfo), beda dari masalah geoblock GitHub Actions di atas.
4. CoinGecko free tier menolak query historis lebih dari 365 hari ke belakang (HTTP 401, `error_code: 10012`) — `stablecoin_supply` jadi terbatas 1 tahun, bukan full history sejak USDT/USDC listing.
5. CoinGecko free tier rate-limit ketat (429 setelah beberapa request berturutan) — ditambahkan `fetchJsonPatient()` di `btc-data.js` dengan backoff lebih sabar (10s × attempt, max 5x) khusus untuk panggilan CoinGecko.

**File baru:**
- `scripts/btc-backfill.js`, `scripts/btc-sync.js`, `scripts/lib/{btc-data,btc-sources,cot-bitcoin,extra-sources}.js`
- `.github/workflows/btc-backfill.yml` (workflow_dispatch, one-off) + `.github/workflows/btc-sync.yml` (cron hourly, auto-commit)
- `data/btc/*.csv` — terisi penuh: OHLCV 1h (77.332 baris), 4h (19.349), 1d (3.228), COT (427), Fear&Greed (3.056), hashrate (6.376), stablecoin_supply (365), btc_dominance (1, bertambah harian)

**Verifikasi data:** 0 duplikat di semua dataset; gap minor di OHLCV 1h/4h (28 dan 8 gap, max 34 jam, tersebar 2017-2023, konsisten dengan downtime exchange di awal era Binance) — OHLCV 1d, hashrate, dan stablecoin_supply tanpa gap berarti.

### Feature Engineering (Fase 2 — selesai)

**`scripts/feature-engineering.js`** menggabungkan ke-7 dataset jadi satu feature matrix per timeframe (`data/btc/features_4h.csv`, `features_1d.csv`), masing-masing 31 kolom:

- **Indikator teknikal** (dari OHLCV, dihitung sendiri di `scripts/lib/indicators.js`, tanpa dependency npm): `ret_1/6/18`, `log_ret_1`, `volatility_z20`, `rsi_14`, `macd`/`macd_signal`/`macd_hist`, `atr_14`, `bb_pctb` (Bollinger %B), `price_to_sma20`, `sma20_gt_sma50`, `ema12_gt_ema26`, `volume_z20`, `volume_change_pct`
- **Konteks eksternal** (forward-filled ke timestamp candle, **timestamp-gated — tidak ada lookahead bias**, nilai cuma muncul setelah benar-benar tersedia): `cot_open_interest`, `cot_net_noncomm`, `cot_noncomm_long_pct`, `cot_net_change_1w`, `fear_greed`, `hashrate`, `stablecoin_total_cap`, `btc_dominance_pct`
- **Target** (forward-looking, untuk fase modeling): `target_ret_6/18` (return n-periode ke depan), `target_dir_6/18` (1=naik, 0=turun)

**Sanity-check terhadap event historis yang dikenal** (bukan cuma cek row count):
- RSI turun ke 15-25 saat Black Thursday (12-13 Maret 2020, crash BTC $8000→$4800) — oversold ekstrem, sesuai ekspektasi
- RSI ~67-68 + `bb_pctb` > 1 (breakout upper band) tepat di ATH 8 November 2021 ($67.525) — overbought, sesuai ekspektasi
- 1 nilai `Infinity` ditemukan di `volume_change_pct` (candle volume=0 era awal Binance 2017) — diperbaiki, semua non-finite ditulis kosong bukan `Infinity`/`NaN`

**Coverage per kolom** (file 1d, 3.228 baris): indikator teknikal ~99% (NaN cuma di periode awal sebelum cukup histori), COT 92.7% (sebelum April 2018 belum ada), fear&greed 94.8% (sebelum Feb 2018), hashrate 100%, stablecoin 11.3% (limitasi 365 hari), btc_dominance 0% di file 1d saat ini (snapshot pertama diambil 15:53 UTC, setelah candle harian tutup jam 00:00 — akan mulai terisi mulai besok).

Workflow GitHub Actions (`btc-backfill.yml` dan `btc-sync.yml`) sudah di-update untuk regenerate feature matrix otomatis setiap kali data baru masuk.

### Model Comparison (Fase 3 — selesai, hasil: tidak ada edge yang robust)

**`ml/train_models.py`** (Python, `.venv` lokal — pandas, scikit-learn, torch/CPU) melatih 5 algoritma + 2 baseline naif (Logistic Regression, Random Forest, Gradient Boosting, MLP, **LSTM**), di 4 kombinasi timeframe×horizon, evaluasi awal pakai chronological split 80/20. **Fitur dipakai:** 22 kolom (teknikal + COT + fear&greed + hashrate) — `stablecoin_total_cap`/`btc_dominance_pct` di-exclude karena coverage historis rendah.

**Bug ditemukan & diperbaiki sebelum hasil final:** CFTC COT punya **publish-lag ~3 hari** (data "as of" Selasa, dirilis Jumat berikutnya) yang belum diperhitungkan di forward-fill `scripts/feature-engineering.js` — sempat ada lookahead bias kecil (candle bisa "lihat" data COT 3 hari sebelum benar-benar publik). Fixed dengan `COT_PUBLISH_LAG_MS`; semua model dilatih ulang dengan data yang sudah benar.

**`ml/cross_validation.py`** — walk-forward CV (4 fold ekspanding kronologis) untuk cek apakah hasil single-split di atas itu robust atau kebetulan. **Hasilnya penting:** config yang sebelumnya tampak terbaik (Random Forest, 1d/18-hari, single-split AUC 0.548) ternyata rata-rata AUC across-fold cuma **0.481 — di bawah 0.50, lebih buruk dari lempar koin.** Itu cuma kebetulan bagus di satu jendela test tertentu, bukan edge yang nyata. Satu-satunya hasil yang terlihat agak konsisten: **Random Forest di 4h/1-hari, AUC 0.532 ± 0.010** (mean tipis di atas random, tapi variansnya kecil antar-fold) — itu hasil paling kredibel di seluruh proyek ini, dan tetap sangat lemah.

**`ml/train_regression.py`** — eksperimen prediksi besaran return (`target_ret_6/18`, bukan cuma arah). **Hasil lebih buruk lagi:** hampir semua model (Linear Regression, Gradient Boosting, MLP, LSTM) punya **R² negatif** — lebih buruk daripada cuma menebak return 0%. Random Forest R²=0.0015, secara statistik sama dengan nol. Prediksi besaran return jauh lebih sulit daripada arah.

**Kesimpulan final (lengkap di `ml/results/REPORT.md`):**
1. Tidak ada edge direksional yang robust — satu-satunya hasil yang lolos CV (Random Forest 4h/1-hari, AUC 0.532) terlalu lemah untuk dijadikan sinyal apapun.
2. Hasil "terbaik" yang dilaporkan sebelum CV (55.6%/AUC 0.569 → 0.548 setelah fix bug) **tidak robust** — ini koreksi penting dari kesimpulan sesi sebelumnya.
3. Regresi besaran return tidak bekerja sama sekali.
4. **LSTM (deep learning) tidak pernah menang** di tiga eksperimen manapun — kadang malah jauh lebih buruk (R² regresi sangat negatif).
5. Lima algoritma yang sangat berbeda semua konvergen ke ~0.50 AUC — ini bukti bottleneck-nya **data/fitur, bukan pilihan algoritma**.

**Rekomendasi:** jangan dipakai sebagai sinyal trading atau bahkan input thesis-narrative yang percaya diri. Kalau tetap mau ada "lean" BTC di digest, posisikan sebagai narasi indikator teknikal/COT biasa (seperti sistem thesis XAU/forex yang sudah ada) — bukan probabilitas hasil model, karena model ini tidak terbukti menambah nilai di atas baca indikator langsung.

**Opsi lanjutan (belum dikerjakan):** feature pruning/importance analysis; reframe target dari "arah harga" (mendekati random walk) ke "deteksi rezim volatilitas tinggi" (lebih learnable secara teori); atau perbanyak fold CV (10+) untuk interval kepercayaan lebih ketat di hasil Random Forest 4h/1-hari yang borderline kredibel itu.

### Preprocessing Transparan di Pandas (tambahan)

**`ml/preprocess.py`** — versi pandas dari tahap cleaning+integrasi data, dipisah dari komputasi indikator teknikal (yang tetap di `scripts/feature-engineering.js`, Node). Tujuannya supaya proses seleksi kolom & pembersihan terlihat eksplisit langkah demi langkah, bukan tersembunyi.

- **Seleksi kolom per sumber** (didokumentasikan inline di kode): COT cuma ambil `open_interest` + 2 kubu utama (`noncomm_long/short`, `comm_long/short`) — buang `noncomm_spread` dan `nonreportable_*` (kurang informatif/lebih noisy); Fear&Greed cuma ambil `value` numerik, buang `classification` (cuma label kategori dari value yang sama); stablecoin cuma ambil total gabungan, buang breakdown USDT/USDC.
- **Cleaning**: dedupe timestamp, buang baris dengan harga ≤0/volume negatif (OHLCV), posisi negatif (COT), nilai di luar 0-100 (Fear&Greed, dominance), hashrate ≤0 — ditemukan 6 baris hashrate `0.0` di 4-9 Januari 2009 (beberapa hari setelah genesis block), dibuang (tidak berdampak karena OHLCV baru mulai 2017).
- **Merge**: `pandas.merge_asof(..., direction="backward")` — join point-in-time yang sama persis semantiknya dengan forward-fill di Node, tapi deklaratif/lebih mudah diaudit. Termasuk fix COT publish-lag yang sama.
- **Output**: `data/btc/clean_4h.csv`, `clean_1d.csv` (21 kolom, tanpa indikator teknikal).
- **Validasi cross-check**: dibandingkan manual dengan `features_1d.csv` (hasil Node) di tanggal 2021-11-10 — `close`, `open_interest`, `fear_greed`, `hashrate` semua identik, dan tanggal mulai COT (2018-04-13, sudah dengan koreksi lag) juga sama. Dua pipeline independen menghasilkan angka yang konsisten.

---

## Changelog Session 69 (2026-06-17)

### Polish: PWA Robustness — Notif Focus, Offline Awareness, Guards

**Konteks:** Pass penyempurnaan mandiri (tanpa instruksi spesifik) — fokus ke robustness PWA & UX yang aman, bukan refactor besar. Refactor konsolidasi 12→5 serverless function (`daun_merah.plan`) sengaja **tidak** dijalankan di sesi ini karena mengubah routing production dan butuh sesi terfokus + konfirmasi tersendiri.

**Perubahan `sw.js`:**
- `notificationclick` — **fix bug spawn instance baru.** Sebelumnya selalu `clients.openWindow(url)`, sehingga tiap kali notif diklik membuka instance/tab app baru. Sekarang:
  - Link eksternal (artikel http(s) ke host lain) → tetap buka tab baru
  - Link internal / `'/'` (buka app) → **fokus window app yang sudah terbuka**; hanya `openWindow` jika belum ada window
  - Deteksi via `isExternal = /^https?:\/\//i.test(url) && !url.includes(self.location.host)`
- `message` handler — tambah guard `if (!e.data) return;` (cegah throw saat menerima pesan tanpa `data`)

**Perubahan `index.html`:**
- **Connectivity awareness (baru):** listener `offline` → status pill jadi `OFFLINE`; `online` → `RECONNECTING` + `fetchFeed()` (refresh feed & status begitu jaringan kembali) + toast "Kembali online". Plus cek awal `if (!navigator.onLine) setStatus('error','OFFLINE')` saat load. Sebelumnya app hanya sadar `visibilitychange`/bfcache, buta terhadap putus/sambung jaringan.
- SW message listener (page side) — guard `e.data && e.data.type === 'NEW_ITEMS'`
- `<html lang="en">` → `lang="id"` (konten app full bahasa Indonesia — benar untuk screen reader/a11y)
- Tambah `<meta name="description">` (sebelumnya tidak ada) untuk metadata PWA/share

**Verifikasi:**
- `node --check sw.js` ✅ dan ekstraksi main inline script `index.html` (6785 baris) → `node --check` ✅
- Elemen `#dot`/`#statusText` (baris 1998–1999) berada sebelum `<script>` (2854) → aman dipanggil saat init
- `setStatus` adalah function declaration (hoisted) → tersedia di blok connectivity

---

## Changelog Session 67 (2026-06-16)

### Fix: Option Expiries — Prose Parser Fallback (Investinglive Format Change)

**Root cause:** Investinglive (`/feed/forexorders/`) sebelumnya mempublikasikan expiry data dalam format tabel terstruktur:
```
EUR/USD
1.0800 (€2.0bln)
1.0850 ($1.5bln)
```
Format ini sudah **berubah ke prosa naratif** — levels disebutkan dalam kalimat tanpa notional size:
```
"EUR/USD at the 1.1540 and 1.1600 levels"
```

**Perubahan `api/feeds.js`:**
- `parseOptionExpiries()` diubah menjadi dual-mode:
  - Primary: `parseStructuredExpiries()` — parser lama (pair header + level/size rows)
  - Fallback: `parseProseExpiries()` — parser baru: split per baris → deteksi pair via regex alias → extract semua angka decimal dalam baris yang sama → validasi range 0.3–5000
  - Field `size` dikembalikan sebagai string kosong `''` pada prose entries (tidak ada data notional)
- Tambah `?force=1` pada `optionsHandler` untuk bypass Redis cache (berguna setelah format change)

**Perubahan `index.html`:**
- `renderTekOptions()`: kolom Size disembunyikan jika semua filtered entries tidak punya size (`hasSizes` flag)
- Fix label sumber: `"sumber: Forexlive ↗"` → `"sumber: Investinglive ↗"`

**Verifikasi production:**
- Setelah deploy: `/api/feeds?type=options&force=1` mengembalikan EUR/USD 1.1540 + 1.1600 ✅

---

## Changelog Session 66 (2026-06-16)

### Feat: Ekspansi Sumber Riset + Option Expiries di TEK Tab

**Konteks:** Penambahan sumber-sumber supplemental berdasarkan analisis Gemini. FinancialJuice tetap sebagai satu-satunya sumber untuk AI digest dan tab NEWS — tidak berubah.

**Perubahan `api/feeds.js`:**
- `CB_RESEARCH_SOURCES` diperluas: tambah **RBA** (via rss2json), **BoC** (direct feed), **BoJ** (via rss2json)
- Tambah dua sumber macro research: **MTM** (Marc to Market) dan **ING** (ING Think) via rss2json
- Endpoint baru: `GET /api/feeds?type=options` — scrape Forexlive Technical Analysis RSS, cari post "FX option expiries … NY cut", parse data level + size per pair, cache 4h di Redis
- Parser `parseOptionExpiries()`: strip HTML → split per baris → detect pair header + inline pair → extract entries dengan regex level/size pattern
- `filterByPair()`: filter per tekPair dengan alias map (termasuk `XAUUSD: ['xau/usd','gold']`)

**Perubahan `index.html`:**
- CSS: tambah badge styles `.riset-badge.RBA`, `.BOC`, `.BOJ`, `.MTM`, `.ING` + CSS section `.tek-opts-*` untuk option expiries
- HTML (TEK panel): tambah div `#tekOptsSection` dengan header + `#tekOptsBody` — disisipkan antara `#tekNewsSection` dan `#corrPanelWrap`
- JS: `fetchTekOptions()` + `renderTekOptions()` — fetch cache 4h, filter berdasarkan `tekPair` aktif, render tabel level/size
- `onTekPairChange()` dan `initTeknikal()`: keduanya memanggil `renderTekOptions()` / `fetchTekOptions()` agar data selalu tersync dengan pair yang dipilih

**Desain keputusan:**
- XAU/USD akan sering kosong (Forexlive jarang publish XAU expiries) → tampilkan "Tidak ada expiry" bukan error
- AI digest tetap eksklusif dari `news_history` yang diisi hanya dari FinancialJuice

---

## Changelog Session 65 (2026-06-16)

### Fix: CAL Tab — Actual Values Auto-Update

**Problem:** Kolom ACTUAL di tab CAL menampilkan "—" meskipun ForexFactory sudah merilis nilai actual. Data hanya di-refresh saat user buka tab CAL (dengan threshold 1 jam), sehingga user harus manual refresh setiap kali ingin melihat actual terbaru.

**Root cause:**
- `startCountdownTimer()` menjalankan `renderCountdown()` setiap 30 detik — hanya update tampilan countdown, tidak re-fetch data
- `calFetchedAt` threshold 1 jam: data tidak di-fetch ulang sampai user tutup + buka tab CAL setelah 1 jam
- Background init refresh (S30M = 30 menit) update `calData` di memori tapi tidak re-render tab CAL

**Fix (`index.html`):**
1. Tambah variabel `let _calAutoRefreshTimer = null;` di calendar state section
2. `startCountdownTimer()`: tambah `setInterval(fetchCalendarSilent, 90000)` → `_calAutoRefreshTimer`
3. `stopCountdownTimer()`: clear `_calAutoRefreshTimer` saat user pindah tab
4. Tambah fungsi `fetchCalendarSilent()`:
   - Guard: `if (activeView !== 'cal') return` — tidak jalan jika user sudah pindah tab
   - Fetch `/api/calendar?_t=${buster}` dengan cache buster per 90s
   - Silent fail (no loading spinner, no error UI)
   - Update `calData`, `calFetchedAt`, panggil `renderCalendar()` + `renderCountdown()` + `updateCalLastUpdated()`

**Efek:** Actual values muncul otomatis dalam ≤90 detik setelah ForexFactory merilis data — tanpa manual refresh, tanpa loading spinner. Label "baru saja" di header kalender ikut update.

---

## Changelog Session 62 (2026-06-15)

### Analisa Feature Upgrade — MACD, ATR, Structured AI Output, Auto-refresh

**Tiga peningkatan sekaligus di tab ANALISA:**

**1. Indikator baru: MACD H4 + ATR 14H**
- `api/admin.js` — `_macdFull(closes)`: hitung MACD (EMA 12/26/9) dari H4 candles (butuh 35+ bar). Output: `macd`, `signal`, `histogram`, `status` (Bullish/Bearish/Recovering/Weakening)
- `_atr14h1(candles)`: hitung ATR-14 dari H1 candles. Output: `atr_h1` (price), `atr_pips` (null untuk XAU)
- `loadOhlcvData()` kini return `out.macd` dan `out.atr`
- `buildOhlcvText()` sertakan MACD dan ATR di blok teks yang dikirim ke AI
- Frontend: indicator card sekarang label "INDIKATOR — RSI / SMA / MACD / ATR" dengan tiga seksi terpisah (RSI/SMA dari ATR cache, MACD H4 dari candles, ATR 14H dari candles)

**2. Structured AI Output**
- Prompt AI diubah dari "4-5 kalimat bebas" → JSON dengan field: `bias`, `entry_zone`, `sl`, `tp`, `trigger`, `commentary`
- Backend parse JSON dari response, normalize bias ke bullish/bearish/neutral; fallback ke plain text jika parse gagal
- `ohlcvAnalyzeHandler` return `{ commentary, structured, model, loaded_at }`
- Frontend: `_renderStructuredAi()` — render bias chip berwarna (green/red/orange), trigger inline, baris ENTRY/SL/TP dalam monospace, commentary di bawah
- Cache format diperluas: `{ commentary, structured, model, hasMakro, saved_at }` — backward compat: old cache tanpa `structured` render sebagai plain text

**3. Auto-refresh 15 menit**
- `startAnalisaAutoRefresh()` / `stopAnalisaAutoRefresh()` menggunakan `setInterval` 15 menit
- `loadAnalisa()` selalu restart timer (reset countdown saat user manual refresh)
- Tab switch listener: stop timer saat meninggalkan tab ANALISA
- Header timestamp menampilkan label "auto 15m" di samping tombol ↻ refresh

---

## Changelog Session 56 (2026-06-12)

### OHLCV Upgrade — Multi-Timeframe: Daily 30D + 4H 10D + Volume GC=F

**Konteks:** Sebelumnya OHLCV hanya 1H 5D. Untuk analisa AI yang lebih dalam, perlu: Daily untuk struktur makro (trend 1 bulan), 4H untuk swing context, dan volume real dari GC=F (CME futures) sebagai konfirmasi conviction.

**Perubahan `api/admin.js`:**
- `fetchYahooOhlcv1h`: range `5d` → `10d` (diperlukan untuk resample 4H), tambah parsing volume (`v: Math.round(vol || 0)`)
- Fungsi baru `fetchYahooOhlcvDaily(symbol)`: fetch `interval=1d&range=1mo` dari Yahoo — semua pair, include volume
- Fungsi baru `resampleTo4h(candles1h)`: resample candles 1H → 4H dengan bucketing per 4×3600s; aggregate OHLC + sum volume
- `ohlcvSyncHandler` update: per pair, sekarang fetch 1H + daily lalu store 3 Redis keys:
  - `ohlcv:{symbol}:1h` — last 72 candles (3 trading days), TTL 8h
  - `ohlcv:{symbol}:4h` — last 60 candles (10 days), TTL 8h
  - `ohlcv:{symbol}:1d` — last 30 candles (1 month), TTL 25h
- Volume ada di semua TF candle object (field `v`), tapi hanya ditampilkan ke AI untuk GC=F

**Perubahan `api/market-digest.js`:**
- `fetchOhlcvContext(symbol, label)` full rewrite — sekarang baca 3 TF dari Redis paralel:
  - **[MAKRO — Daily 30D]**: range, trend, % 30D, top-2 resistance + bottom-2 support, volume avg/today + label HIGH/Normal/low (XAU only)
  - **[SWING — 4H 10D]**: range, trend, % 10D, swing high + swing low dengan tanggal WIB
  - **[ENTRY — 1H 3D]**: range, now, % 3D, trend; 24H candles per-jam dengan volume + label untuk XAU
  - Output format: `=== {label} MULTI-TIMEFRAME ===` diikuti 3 blok terstruktur
- Prompt header Call 1: diupdate ke `PRICE ACTION XAU/USD (Daily/4H/1H — ...)`
- Call 3 thesis injection: diubah dari `.split('\n')[0]` → `.split('\n').slice(1, 8).join('\n')` — memberikan summary Daily+4H+1H (bukan hanya header baris pertama)

**Volume philosophy:**
- FX OTC (EURUSD=X, dll): volume Yahoo adalah proxy dealer, tidak punya makna. Tetap disimpan di Redis tapi tidak ditampilkan ke AI
- GC=F (CME futures): volume real. Dipakai untuk label candle `V:8.2K [HIGH]` / `V:5.1K [low]`, plus daily vol context

**Redis keys baru per pair:**
- `ohlcv:{symbol}:4h` — 4H candles TTL 8h
- `ohlcv:{symbol}:1d` — Daily candles TTL 25h
- Total keys: 9 pairs × 3 TF = 27 Redis keys (sebelumnya 9 keys 1H saja)

---

## Changelog Session 55 (2026-06-12)

### Self-Healing OHLCV System — AI Price Context untuk Entry

**Masalah:** AI briefing hanya mengetahui harga spot saat ini + RSI/SMA, tidak bisa menyebut level konkret ("resistance 3380 yang diuji 2x", "ranging sejak Jun-10"). Tidak ada koneksi teknikal-fundamental untuk entry analysis.

**Solusi:** Sistem OHLCV 1H yang berjalan otomatis setiap jam, menyimpan data ke Redis, dan AI membacanya saat generate briefing.

**Perubahan `api/admin.js`:**
- Tambah `ohlcvSyncHandler` — action baru `?action=ohlcv_sync`
- `OHLCV_FIXED_PAIRS`: 8 pair fixed (XAU, 7 FX majors) selalu di-track
- `OHLCV_PAIR_SYMBOL_MAP`: mapping pair label → Yahoo symbol (14 pair + cross)
- `fetchYahooOhlcv1h(symbol)`: fetch `interval=1h&range=5d` dari Yahoo Finance
- Storage: Redis key `ohlcv:{symbol}:1h`, JSON array max 120 candles, TTL 8 jam
- Dynamic pair: baca `latest_thesis.pair_recommendation` → tambah ke sync list jika cross pair (misal EUR/JPY)
- Self-healing: TTL 8h = kalau cron stop, data expire otomatis. Kalau Yahoo gagal 1 pair, pair lain tetap sync.
- Tidak butuh file baru (sudah 12 functions di Vercel Hobby limit)

**Perubahan `vercel.json`:**
- Tambah cron `0 * * * *` untuk `/api/admin?action=ohlcv_sync` — jalan tiap jam

**Perubahan `api/market-digest.js`:**
- Tambah konstanta `OHLCV_SYMBOL_MAP` — 14 pair label → Yahoo symbol
- Tambah fungsi `fetchOhlcvContext(symbol, label)`:
  - Baca Redis `ohlcv:{symbol}:1h`
  - Compute: range 3D, trend direction (uptrend/downtrend/sideways), current price, 3D % change
  - Output compact: 1 baris summary + 24H candles mentah (H/L/C per jam, WIB)
  - Decimal precision otomatis per instrument (XAU=2, JPY=3, FX=5)
- Tambah `rawPrevThesis` ke parallel fetch block → determine FX pair berdasarkan previous thesis
- Load OHLCV untuk XAU + FX pair setelah parallel fetch (2 Redis reads paralel)
- Inject ke **Call 1** user message: blok `PRICE ACTION XAU/USD 1H` + `PRICE ACTION {pair} 1H`
- Inject ke **Call 3** thesis prompt: 1-line summary range + trend untuk precision entry/invalidation
- **Fix bug:** `GROQ_MODEL_PROSE = 'qwen/qwen3-32b'` (sebelumnya `'qwen3-32b'` tanpa prefix → model not found)
- **Call 4 SambaNova-first:** `_call4Promise` sekarang coba SambaNova DeepSeek-V3.2 (akun 1) dulu, fallback ke Groq. Condition diubah dari `(GROQ_KEY && deviceId)` → `((SAMBANOVA_KEY || GROQ_KEY) && deviceId)`

**Redis keys baru:**
- `ohlcv:GC=F:1h` — XAU/USD 1H candles, max 120 entries, TTL 8h
- `ohlcv:EURUSD=X:1h`, `ohlcv:GBPUSD=X:1h`, etc. — semua 8 fixed pair + dynamic cross pair

**AI provider strategy (updated):**
- Call 1 (prose briefing): SambaNova primary → OpenRouter → Groq qwen/qwen3-32b → Groq llama
- Call 2 (CB bias): SambaNova primary → Groq
- Call 3 (structured thesis): SambaNova primary → Groq
- Call 4 (thesis monitor): **SambaNova primary** (baru) → Groq ← semua call sekarang preferensi SambaNova DeepSeek-V3.2

---

## Changelog Session 54 (2026-06-11)

### Feat: Fundamental Drill-Down Overlay (tap currency → detail view)

**Masalah:** Panel fundamental menampilkan 8 mata uang sekaligus dengan font 8-9px, sulit dibaca. Tidak ada cara untuk fokus ke satu mata uang.

**Solusi:** Full-screen overlay yang muncul saat user tap currency card atau ranking cell.

**Perubahan `index.html`:**
- CSS baru: `.fd-overlay`, `.fd-hdr`, `.fd-hdr-close`, `.fd-hdr-nav`, `.fd-hdr-center`, `.fd-cur-tabs`, `.fd-cur-tab`, `.fd-score-strip`, `.fd-body`, `.fd-section-hdr`, `.fd-row`, `.fd-row-name`, `.fd-row-right`, `.fd-row-val`, `.fd-row-prev`, `.fd-row-period`, `.fd-extra-block`, `.fd-extra-title`, `.fd-extra-row`
- HTML: `#fdOverlay` — full-screen overlay dengan header (← back, nama mata uang besar, ‹ › nav), score strip, currency tabs, scrollable body
- JS: `openFundDetail(cur)`, `closeFundDetail()`, `navFundDetail(dir)`, `_renderFundDetail()` — render detail untuk satu currency
- `FUND_SECTIONS_MAP` + `FUND_SECTION_ORDER` — grouping indikator ke seksi: Inflasi, Pertumbuhan, Ketenagakerjaan, Aktivitas, Sentimen, Permintaan, Eksternal, Lainnya
- `fdScores` global — scores array dari `renderFundamental()` disimpan untuk overlay
- Tap fund-card → `openFundDetail(cur)` (cursor:pointer, ↗ hint di pojok kanan header)
- Tap frnk-cell (ranking strip) → `openFundDetail(cur)`
- Escape key menutup overlay (prioritas pertama sebelum kbOverlay)
- Detail view: CB rate di top (font 26px), tiap indikator font 18px (vs 9px sebelumnya), prev value ditampilkan, color-coded bull/bear, yield curve + likuiditas dalam card terpisah

---

### Fix: Regime selalu NEUTRAL — tambah tier ELEVATED + Yahoo MOVE live

**Root cause dua masalah:**
1. **MOVE data null** — Stooq (satu-satunya source) diblokir anti-scraping, circuit breaker terbuka → `move = null` → "0/2 trigger" (hanya VIX + HY dihitung). Banner tidak pernah bisa Risk-Off dari MOVE.
2. **VIX 20.6 di zona neutral** — threshold lama: risk_off > 25, risk_on < 15. VIX 15-25 selalu NEUTRAL meski sudah elevated secara historis.

**Perubahan `api/risk-regime.js`:**
- Tambah `fetchYahooMove()` — Yahoo Finance `^MOVE` (live, 15m delay), lebih reliable dari Stooq scraping
- Rename Stooq fetcher ke `fetchStooqMove()`, tetap sebagai fallback
- `fetchMove(stooqAllowed)` — selalu coba Yahoo dulu; Stooq hanya jika Yahoo gagal DAN circuit tidak OPEN
- Stooq circuit breaker hanya dicredit/didebited berdasarkan actual Stooq calls (bukan Yahoo sukses)
- Tambah regime tier **ELEVATED**: VIX > 20, MOVE > 100, atau VIX spike +3 dalam 2 hari
- Hierarchy regime: `risk_off` > `elevated` > `risk_on` (all benign) > `neutral`
- Tambah `move_source` ke payload response (`'yahoo'` atau `'stooq'`)
- Tambah `vix_elevated`, `move_elevated`, `vix_spike` ke `components`

**Perubahan `index.html`:**
- CSS: `.regime-banner.elevated { background: #251e08; color: #f59e0b; }` (amber/kuning)
- LABELS: tambah `elevated: 'ELEVATED'`; CLASSES: `elevated: 'elevated'`
- IMPLICATIONS: `elevated: 'Volatilitas naik · Selektif & kurangi size · Pantau VIX & MOVE ketat'`
- Detail panel VIX row: tampilkan threshold per level (> 20 ELEVATED, > 25 RISK-OFF, < 15 Risk-On, 15-20 netral)
- Detail panel MOVE row: tampilkan threshold per level (> 100, > 130, < 90)
- MOVE null case: tampilkan `"data tidak tersedia"` (sebelumnya baris hilang tanpa keterangan)
- VIX spike row: tampilkan jika `vix_spike = true`
- Data label: `"VIX & MOVE live · HY Data X"` jika MOVE dari Yahoo; `"VIX live · MOVE/HY Data X"` jika Stooq
- Journal regime filter dropdown: tambah option `elevated`
- Fix bug `_ckAutoMeanRev()`: perbandingan `=== 'Neutral'` (kapital) → `=== 'neutral'` — auto-tick tidak pernah jalan sebelumnya
- `_ckAutoMeanRev()` sekarang juga trigger untuk `'elevated'` (regime ranging/choppy)
- `ckAutoTick('rc1')`: pakai label readable (RISK-ON/ELEVATED/NEUTRAL/RISK-OFF) bukan raw value

---

## Changelog Session 53 (2026-06-10)

### Fix: AI Summarization — Vercel Timeout, Provider Diagnostics, CSS Badges

**Masalah root cause:** Vercel Hobby plan default function timeout adalah 10-15s, sedangkan SambaNova Call 1 sendiri membutuhkan timeout 28s (normal response time 13-20s). Ketika SambaNova timeout + OpenRouter timeout (15s), total waktu bisa melampaui limit Vercel → 504 sebelum Groq sempat menjadi fallback.

**Perubahan `vercel.json`:**
- Tambah blok `"functions"` dengan `maxDuration` explicit per endpoint:
  - `market-digest.js`: 60s
  - `journal.js`: 45s
  - `admin.js`: 60s
  - `correlations.js`: 30s
  - `real-yields.js`: 30s
  - `risk-regime.js`: 20s
  - `feeds.js`: 20s

**Perubahan `api/market-digest.js`:**
- Tambah `providerLog` array yang melacak setiap provider attempt: nama, status (ok/error/empty), elapsed time, char count
- Sertakan `provider_log` di response payload — tampil di frontend saat method=fallback
- Setiap fallback provider sekarang log: `sambanova:ok(1200ms,3400c)` atau `sambanova:HTTP429(100ms)` atau `sambanova:no_key`

**Perubahan `index.html`:**
- Frontend timeout: 45s → 55s (sesuai maxDuration 60s Vercel)
- CSS tambahan untuk method badges yang sebelumnya tidak styled: `deepseek-v3.2` (biru), `deepseek-v3.1` (biru), `gpt-oss-120b` (hijau), `qwen3-32b` (kuning, sama dengan groq)
- Tambah `fallback_quota` ke CSS fallback
- Tampilkan provider log (monospace, muted) di bawah meta bar ketika method=fallback, sehingga user bisa melihat provider mana yang gagal

**Env var:**
- Dokumentasikan `SAMBANOVA_API_KEY_CALL1` (akun 2, opsional) di daun_merah.md

---

## Changelog Session 51 (2026-06-05)

### Dashboard News Panel — Thematic Clustering

**Masalah:** Panel berita kiri di Dashboard menampilkan list kronologis mentah (20 headline berurutan) yang memaksa otak membaca setiap item satu per satu, termasuk berita tidak relevan dengan thesis aktif trader.

**Solusi:** Ubah paradigma dari *timeline* ke *status board* berbasis kategori.

**Perubahan `index.html`:**
- `renderDashNews()` diubah total: item dikelompokkan per kategori menggunakan `detectCat()` yang sudah ada
- 11 kategori ditampilkan dalam urutan prioritas: MKT MOVING → FOREX → MACRO → ECON DATA → BONDS → ENERGY → COMMODITIES → EQUITIES → GEOPOLIT. → INDEXES → CRYPTO
- Setiap kluster menampilkan: colored dot + label + count badge + timestamp item terbaru + chevron
- Klik header kluster untuk expand/collapse (state persists antar auto-refresh via `dashClusterState`)
- MKT MOVING auto-expand jika ada isi; semua kategori lain collapsed by default
- Kategori kosong tidak ditampilkan sama sekali
- Individual item tetap pakai format `.dash-news-item` yang sama, dot warna disesuaikan per kategori
- CSS baru: `.dash-cluster`, `.dash-cluster-header`, `.dash-cluster-dot`, `.dash-cluster-label`, `.dash-cluster-count`, `.dash-cluster-age`, `.dash-cluster-chevron`
- `toggleDashCluster(cat)` fungsi baru untuk handle expand/collapse
- `dashClusterState` state variable baru

---

## Changelog Session 50 (2026-06-25)

### Nav Polish — Analisa Border-Bottom + Mobile Bottom Nav Swap

**1. Tab ANALISA tidak ada border-bottom saat active — `index.html`**
- Root cause: semua `.nvtab[data-view="X"].active` punya rule `border-bottom-color`, kecuali `analisa` — jadi border tetap transparent walau tab aktif
- Fix: tambah `.nvtab[data-view="analisa"]` (warna `#fb923c`) + `.nvtab[data-view="analisa"].active { border-bottom-color: #fb923c; }`

**2. Mobile bottom nav: Checklist diganti Analisa**
- `#botNav`: button `data-view="checklist"` (icon checklist) diganti `data-view="analisa"` (icon chart) — label "Analisa"
- Checklist dipindah ke drawer "Lainnya": ditambahkan ke `DRAWER_ITEMS` + CSS hide `#botNav .bot-nav-btn[data-view="checklist"]`
- `analisa` dihapus dari `DRAWER_ITEMS` karena sekarang akses langsung dari bottom nav (gak perlu duplikat)
- Desktop top nav (`#navViews`) tidak berubah — checklist tetap tampil langsung di sana, hanya mobile bottom nav yang disesuaikan

**3. Tab MTF bias (D1/H4/H1/M15 dropdown) di tab TEKNIKAL bikin window melebar ke kanan di mobile**
- Root cause: `.tek-mtf-bar` (4 dropdown bias + tombol Auto + badge kesimpulan BULLISH/BEARISH/MIXED) pakai `display:flex` tanpa wrap — total lebar konten lebih besar dari viewport mobile, jadi overflow horizontal alih-alih wrap ke baris baru
- Fix: tambah `flex-wrap: wrap` pada `.tek-mtf-bar` (+ gap jadi `8px 10px` untuk jarak antar baris)

**4. Swipe gesture horizontal nyasar ke tab "Lainnya" — `index.html` (SWIPE NAVIGATION)**
- Root cause: array `VIEWS` di swipe handler masih include semua tab drawer-only (riset/cal/cot/fundamental/checklist/sizing/jurnal/petunjuk) di antara tab primer — jadi swipe dari ANALISA ke kanan nyasar ke `cal` (Kalender) bukan ke TEKNIKAL
- Fix: `VIEWS` dipersempit jadi cuma tab primer: `['dashboard','feed','ringkasan','analisa','teknikal']` — urutan sama dengan bottom nav mobile
- Tambahan: swipe ke kiri setelah tab terakhir (TEKNIKAL) sekarang langsung `openDrawer()` — konsisten dengan posisi "Lainnya" di paling kanan bottom nav

**5. FUNDAMENTAL detail overlay — swipe untuk ganti mata uang**
- Sebelumnya pindah currency di overlay detail (`fdOverlay`) cuma bisa lewat tombol ‹ › atau tap chip currency di `fdCurTabs`
- Tambah swipe horizontal di `#fdBody`: swipe kiri/kanan panggil `navFundDetail(1/-1)`, dengan deteksi dominan horizontal (sama pola dengan global swipe nav) supaya gak ganggu scroll vertikal daftar indikator
- `navFundDetail()` sekalian ditambah animasi slide-in (`swipe-in-right`/`swipe-in-left`, reuse keyframes yang sudah ada) biar transisi kerasa
- Tidak konflik dengan global swipe nav antar-tab karena `activeView` tetap `'fundamental'` saat overlay terbuka — dan `'fundamental'` sudah gak ada di array `VIEWS` swipe nav (poin 4), jadi handler global auto-skip

**6. Swipe saat drawer "Lainnya" terbuka tembus ganti tab di belakangnya**
- Root cause: global swipe nav handler gak cek status drawer — swipe di atas drawer yang sedang terbuka tetap dianggap swipe ganti tab, jadi konten di belakang drawer berubah sementara drawer-nya sendiri masih nampil di atas (state nyasar)
- Fix: tambah guard di awal `touchend` handler — kalau `#drawerPanel.open`, swipe arah manapun cuma `closeDrawer()`, gak lanjut ke logic ganti tab

**7. Fitur baru: US10Y yield strip di tab TEKNIKAL**
- Data udah ada di `api/real-yields.js` (`realYieldsData.USD.{nominal,real}`), tinggal ditarik ke UI — gak ada API call baru
- Pakai USD aja (bukan differential per-pair) karena itu satu-satunya yield yang konsisten ada di semua 8 pair TEK (XAUUSD + 7 FX major)
- Strip baru `#tekYieldStrip` di bawah `.tek-mtf-bar`: nampilin US10Y nominal + real yield (TIPS-implied)
- Khusus XAUUSD: real yield dikasih warna (merah kalau positif = tekanan ke Gold, hijau kalau negatif = suportif) + hint teks — karena ini driver fundamental klasik gold (inverse correlation ke real yield)
- Pair FX lain cuma nampilin angka netral (US10Y jadi konteks makro umum, gak ada hint directional spesifik karena bukan currency differential)
- Render dipanggil di 3 titik: `initTeknikal()` (pakai cache kalau masih fresh ≤6 jam, else `fetchRealYields()`), `selectTekPair()` (ganti pair), dan di akhir `fetchRealYields()` (data baru datang)

**8. Bug: kalender — event yang ketinggalan dicek dalam 3 jam jadi blank actual permanen**
- Root cause: `enrichCalActuals()` punya gate `(nowMs - evMs) > AFTER_MS) return` yang ngecek "udah berapa lama dari SEKARANG", bukan dari waktu rilis event — begitu lewat 3 jam wall-clock, event itu di-skip dari backfill SELAMANYA, walau actual-nya udah ada di feed FinancialJuice (dikonfirmasi langsung: AUD Employment Change & Unemployment Rate hari ini, headline actual muncul <1 menit setelah rilis, tapi event masih blank 4 jam kemudian karena user belum buka tab CAL dalam window itu)
- Window kecocokan per-headline (`BEFORE_MS`/`AFTER_MS` relatif ke `evMs`) udah benar dan tetap dipertahankan — yang dihapus cuma gate redundan yang gak ada hubungannya sama validitas match
- Fix: gate dipersempit jadi cuma skip event yang **belum rilis** (`evMs > nowMs`) — `allItems` cap 100 item biasanya nutup >5 jam riwayat headline, jadi backfill telat tetap kena tangkep di kunjungan berikutnya

**9. Fitur baru: COT week-over-week alignment flag (vs arah trade)**
- Helper baru `cotAlignmentNote(base, quote, dir)` — bandingin `lev_change_net` (perubahan posisi leveraged funds minggu-ke-minggu, data udah ada di `api/feeds.js`) base vs quote, threshold 5000 kontrak biar shift kecil/noise gak di-flag
- Live preview: `jnSnapshotInfo()` (form entry manual JURNAL) sekarang nampilin baris "✅ Selaras smart money" / "⚠ Kontra smart money" sebelum trade disimpan — `onchange="jnSnapshotInfo()"` ditambah ke `#jnPair` dan `#jnDir` biar update live
- Disimpan permanen: field `cot_alignment` (boolean) ditambah ke `cot_snapshot` (sekarang nyimpen `lev_change_net` juga, sebelumnya cuma `lev_net` statis) — dipanggil dari `jnSave()` (manual) dan `ckMt5AutoJournal()` (MT5 bridge auto-journal)
- `api/journal.js`: field `cot_alignment` ditambah ke whitelist POST entry; per-trade summary di endpoint `?action=analyze` sekarang nyebutin "selaras smart money" / "KONTRA smart money" + delta COT, dan instruksi prompt AI poin 2 (Keselarasan Framework) diperluas buat ikut nilai positioning institusional, bukan cuma CB bias + regime
- Badge "✅ selaras COT" / "⚠ kontra COT" ditambah di kartu list JURNAL biar kelihatan retroaktif juga
- Catatan desain: TIDAK ditambah breakdown win-rate numerik per kategori (bias/regime/COT) — sample trade trader pribadi biasanya kekecilan buat statistik valid, AI analysis yang udah ada (poin 2 prompt) lebih aman buat sample kecil drpd widget angka yang bisa overfit/noise

**10. Fitur baru: US10Y & US2Y sebagai chart candle sendiri di tab TEKNIKAL**
- Awalnya US10Y cuma badge angka (poin 7), tapi user mau technical reading langsung di yield-nya (trendline/SR) — bukan cuma satu angka
- `TEK_YIELD_INSTRUMENTS = ['US10Y','US02Y']` ditambah ke `TEK_ALL_PAIRS` (jadi muncul di dropdown pair, searchable by "10Y"/"2Y"/"yield"), dengan override manual di `TEK_TV_SYM` (`TVC:US10Y`/`TVC:US02Y` — data asli TradingView) karena auto-derive symbol dari nama pair gak cocok buat instrumen non-currency-pair ini
- `tekPairLabel()` dan 2 tempat lain yang masih hardcode `slice(0,3)+'/'+slice(3)` (renderTekNews, renderTekOptions) dirapihin pakai `tekPairLabel()` biar gak pecah format buat pair 5-karakter ini
- `TEK_YAHOO_SYM.US10Y = '^TNX'` (buat panel TA RSI/SMA) — US02Y gak ada index Yahoo yang bersih, jadi `fetchTaData()` skip otomatis (graceful, gak crash)
- `TEK_PAIR_KEYWORDS.US10Y/US02Y` di-set manual ke keyword USD (Fed/FOMC/yield) biar filter Berita Terkait tetap relevan
- Strip badge US10Y dari poin 7 di-skip otomatis (`renderTekYield()`) kalau lagi di-chart sendiri — gak ada badge duplikat
- **Update:** `TVC:US10Y`/`TVC:US02Y` ternyata kena paywall di widget gratis ("Simbol tersebut hanya tersedia di TradingView"). Diganti ke `FRED:DGS10`/`FRED:DGS2` (data US Treasury via FRED, sumber sama dengan `api/real-yields.js`, gak dikunci). Trade-off: FRED update harian doang, jadi timeframe intraday (H4/H1/M15) gak akan se-granular pair FX biasa — tapi chart-nya jalan tanpa paywall.
- **Update lagi:** Berita Terkait buat US10Y/US02Y awalnya pakai `TEK_CUR_KEYWORDS.USD` penuh (ikut 'dollar','dxy','trump','nfp' — kebanyakan gak relevan buat baca chart yield). Dipersempit jadi `TEK_YIELD_KEYWORDS` khusus: Fed/FOMC/rate decision, treasury auction/yield curve/TIPS/real yield, dan rilis makro yang langsung pengaruh ekspektasi rate (CPI/GDP/NFP/PCE/jobless claims) — driver yang beneran gerakin yield itu sendiri, bukan USD secara umum.

---

## Changelog Session 49 (2026-06-05)

### Unverified Audit + Maintenance Debt + OECD/TGA Fixes

**1. OECD Inflation Dead Code Removed — `api/real-yields.js`**
- Verified: `stats.oecd.org/SDMX-JSON` → 404 (deprecated), `sdmx.oecd.org` → 403 (Cloudflare block dari Vercel IPs)
- `fetchOECDInflation()` selalu silent fail, selalu fallback ke hardcoded
- Dihapus: `fetchOECDInflation()`, `OECD_TO_CURRENCY` constant, `oecdCached` Redis read, Step 1 OECD block
- Simplified: `inflationExp` langsung spread dari `INFLATION_EXPECTATIONS` tanpa OECD merge
- Orphaned Redis key `oecd_inflation` expire natural dalam 24h

**2. TGA via FRED WDTGAL — `api/real-yields.js`**
- Root cause: `fiscaldata.treasury.gov` blocked dari Vercel datacenter IPs (confirmed) → `tga_balance_bn` selalu null
- Fix: Ganti ke FRED series `WDTGAL` (US Treasury General Account, Fed H.4.1 weekly Wednesday levels)
- Tambah helper `fetchFredMulti(seriesId, limit)` untuk fetch N observasi (needed untuk `tga_change_bn`)
- `fetchLiquidityIndicators()`: sekarang `fetchFred('WALCL')` + `fetchFredMulti('WDTGAL', 2)` (keduanya via FRED API, tidak diblokir Vercel)
- Trade-off: WDTGAL weekly (Rabu), less granular dari daily Treasury API, tapi reliable. `tga_change_bn` = perbandingan 2 Rabu berturut-turut.

**3. FUND_SEED Update — `api/admin.js`**
- AUD GDP QoQ: 0.8% Q4 2025 → **0.3% Q1 2026** (ABS published June 3, 2026; QoQ below expected 0.5%)
- JPY GDP QoQ: 0.3% Q4 2025 → **0.5% Q1 2026** (Cabinet Office 1st preliminary May 19, 2026; annualized +2.1%)
- NZD GDP: tetap Q4 2025 (Q1 2026 publish June 18)

**4. GBP Inflation Expectation — Confirmed No Update Needed**
- BoE IAS Q2 2026 belum publish (konfirmasi via research). GBP 3.2% (Feb 2026) masih current.
- Next refresh: BoE IAS Q2 hasil biasanya ~Aug 2026.

**5. AI Liquidity + Yield Curve Prompt — Verified Working**
- Yield curve USD+EUR confirmed masuk ke `realYieldBlock` di prompt market-digest
- TGA sebelumnya null karena Vercel IP blocked → sudah fixed via WDTGAL
- Cold-start caveat: `liquidity_usd` dan `yield_curve` TTL 1h. Jika user buka tab FUNDAMENTAL sebelum generate digest, data selalu tersedia.

**6. crawl4ai Assessment**
- Python-based library, Docker mode punya REST API (callable dari Node.js)
- Berguna untuk bypass Cloudflare/anti-bot (ING Think, option expiry pages)
- **Tidak applicable untuk Vercel serverless** — butuh server terpisah
- Cloud API "coming soon" tapi belum tersedia
- Relevant di masa depan jika ada VPS scraping proxy

---

## Changelog Session 48 (2026-06-05)

### VIX Fix + TGA API Fix + Rename + RSS Research

**1. VIX Term Structure — `api/risk-regime.js`**
- Root cause: `^VIX1M` tidak tersedia di Yahoo Finance → selalu null → `structure` field tidak pernah dihitung.
- Fix: tambah fallback `else if (vix3m != null)` — hitung `structure` dari `vix_spot` vs `vix_3m` jika `vix_1m` null.
- Dikonfirmasi live: `{ vix_spot: 15.4, vix_1m: null, vix_3m: 19.23, structure: "contango" }`.

**2. TGA Balance — `api/real-yields.js`**
- Root cause: Treasury FiscalData API pindah endpoint. URL lama `/v1/accounting/dts/dts_table_1` return 404 dari semua sumber.
- URL baru ditemukan via JS bundle `fiscaldata.treasury.gov`: `/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance`
- Filter baru: `account_type:eq:Treasury General Account (TGA) Closing Balance`
- Field: `open_today_bal` — bukan `close_today_bal` yang selalu string `"null"` (Treasury naming quirk).
- Data confirmed lokal: Jun 3 = $845B, Jun 2 = $866B, change -$21B (drain).

**3. Rename CB WATCH → ARTIKEL — `index.html`**
- Top nav button, DRAWER_ITEMS label + desc, keyboard shortcut help (`G B`) — 3 titik diganti.
- Alasan: tab ini akan menampung artikel macro lebih luas (bukan hanya CB speeches), termasuk rencana tambah Marc to Market + ING Think.
- `data-view="riset"` dan semua JS logic tidak berubah — hanya label UI.

**4. Option Magnets — dipertahankan**
- Sebelumnya dikira dead code karena FinancialJuice tidak publish format expiry.
- Keputusan: **kode tetap ada** — regex parser + panel + CSS + filter button semua dipertahankan.
- Alasan: investing.com (kandidat backup source) publish headline option expiry yang bisa match regex secara otomatis.

**5. Audit `daun_merah_progress.md`**
- Item 12 (FX Risk Reversals) + Item 13 (Portfolio VaR): dikira ⚫ belum ada → ✅ sudah ada sejak session 46–47.
- Item 5 (TGA), Item 6 (VIX): diupdate → FIXED.
- Item 8 (Option Magnets): diupdate → dipertahankan (source lain mungkin punya data ini).
- Test live semua item 4–8 via WebFetch + curl ke production.

**6. Research RSS Backup Sources (Item 14)**
- **Investing.com**: `investing.com/rss/news_1.rss` — gratis, real-time, tapi noise tinggi (1 event = 3–5 artikel).
- **Reuters**: berbayar, skip.
- **Marc to Market** (`feeds.feedburner.com/MarcToMarket`): gratis, bersih, 6x/minggu — cocok masuk tab ARTIKEL bukan breaking news.
- **ING Think**: tidak ada RSS resmi, perlu scrape.
- **Econostream**: berbayar wire service, skip.
- Kesimpulan: tidak ada sumber gratis yang ideal sebagai real-time fallback. Marc to Market + ING Think lebih cocok sebagai sumber riset di tab ARTIKEL.

---

## Changelog Session 47 (2026-06-05)

### ScraperAPI Proxy + CME CVOL Fix + Bug Fixes

**1. ScraperAPI Proxy — `api/rate-path.js` + `api/correlations.js`**
- Root cause: CME Group memblokir IP data center Vercel (AWS/GCP) via Akamai WAF.
- Solusi: ScraperAPI residential IP proxy — tidak diblokir CME.
- `api/rate-path.js`: tambah `cmeFetch(targetUrl, directHeaders, timeoutMs)` — jika `SCRAPER_API_KEY` ada, semua CME fetch (FedWatch V1/V2, ZQ settlement, ZQ quote) di-route via `api.scraperapi.com`. Timeout naik 8-10s → 15s.
- **Env var baru:** `SCRAPER_API_KEY` di Vercel. Free tier: 5,000 credits/bulan, kebutuhan aktual ~120-180 req/bulan.

**2. CME CVOL Risk Reversals — Endpoint Baru + 6 Pair**
- Endpoint lama `CmeWS/mvc/Volatility/historical` return 404 (dihapus CME).
- Endpoint baru: `https://www.cmegroup.com/services/cvol?symbol={CODE}&isProtected&_t={timestamp}`
- Response format: array `[{ skew: "-0.402", atmInd, cvolPrice, ... }]` — field `skew` langsung di root.
- **Symbol mapping baru (semua dikonfirmasi via browser test):**
  - EUR/USD → `EUVL`, GBP/USD → `GBVL`, USD/JPY → `JPVL`
  - AUD/USD → `ADVL`, USD/CAD → `CAVL` (bukan CDVL), XAU/USD → `GCVL`
  - NZD/USD + USD/CHF: tidak tersedia di CME CVOL (options terlalu illiquid)
- **6 pair live:** EUR/USD (-0.402), GBP/USD (-0.728), USD/JPY (+1.598), AUD/USD (-0.819), USD/CAD (-0.166), XAU/USD (-0.021)
- Cache key: `rr_cache_v2`, TTL 3600s.
- Barchart OnDemand: dikonfirmasi **enterprise berbayar** (bukan free) — path tetap ada di kode tapi tidak digunakan.

**3. Bug Fixes**
- `index.html` line 2673: `handleNewItems is not defined` — SW masih kirim `NEW_ITEMS` tapi fungsi sudah dihapus. Fix: ganti `handleNewItems(e.data.items)` → `fetchFeed()`.
- `api/calendar.js`: return HTTP 500 saat FF XML tidak ada event di range tanggal (weekend). Fix: hanya throw 500 jika kedua fetch benar-benar gagal (`anyFetchSucceeded` flag). Event kosong (weekend/no high-impact) return 200 empty array.

**4. Penjelasan Manfaat Risk Reversal untuk Trader**
- RR = fear indicator dari options market (bukan performance indicator).
- Negatif = institusi beli put lebih mahal (fear downside). Positif = call bias (expect kenaikan).
- Kegunaan: konfirmasi CB bias, deteksi contrarian setup (RR ekstrem = semua positioned satu arah), sizing confidence (trade with/against institutional hedging).
- Contoh: AUD/USD -0.819 → institusi agresif hedge downside AUD; USD/JPY +1.598 → carry trade masih diminati.

---

## Changelog Session 46 (2026-06-04)

### Fitur Baru dari Backlog

**1. Portfolio VaR — Tab JURNAL (`index.html`)**
- Card `#jnVarCard` muncul di atas filter buttons di `jnListView` saat ada posisi open.
- `jnRenderVaR()`: async function yang fetch ATR per pair secara paralel, hitung VaR 1D 95% per posisi, lalu hitung Portfolio VaR via variance-covariance method (korelasi dari `corrData`).
- **Notional USD benar per pair type**: XAU/USD (`lots × 100 oz × price`), quote=USD (`lots × 100K × rate`), base=USD (`lots × 100K`), cross (`lots × 100K × base/USD rate dari szLiveRates`).
- **ATR cached** di `sessionStorage` 4 jam agar tidak re-fetch tiap kali filter berubah.
- Warning kuning jika 2 pair berkorelasi ≥0.70 dan arah sama (risiko amplified). Warning hijau jika hedge (arah berlawanan, risiko tereduksi).
- Diversification % = `(1 - portfolioVar1d / undiversifiedVar) × 100` — membandingkan VaR dengan korelasi vs tanpa korelasi.
- Note "buka tab KORELASI" muncul jika `corrData` belum dimuat.

**2. Cleveland Fed Inflation Nowcast — `api/real-yields.js`**
- Tambah fetch `EXPINF10YR` (FRED series — Cleveland Fed 10-year inflation expectation model, monthly) paralel dengan DGS10 dan T10YIE.
- USD inflation_exp sekarang: primary = TIPS T10YIE (market-implied, daily); fallback = Cleveland Fed EXPINF10YR jika TIPS gagal.
- `source_inflation` field mencantumkan keduanya: `"FRED T10YIE (TIPS breakeven) · Cleveland Fed 10yr: X%"`.
- Response USD menambah field `cleveland_fed_exp` (nullable).

**3. CME FedWatch Fix — `api/rate-path.js`**
- Split `CME_FEDWATCH_URL` jadi V1 (dengan `?startDate=`) dan V2 (tanpa param) — keduanya dicoba dalam loop.
- Shared `CME_HEADERS` object dengan full browser fingerprint (User-Agent, Sec-Fetch-*, Accept-Language).
- Tambah `fetchCMEQuoteZQ()`: coba endpoint quote publik CME untuk produk 305 (ZQ front-month). Muncul sebagai step 2b antara ZQ settlement dan T-bill.
- Source label baru `cme_zq_quote` di response jika berhasil.
- Fallback chain: CME FedWatch V1 → V2 → ZQ Settlement → ZQ Quote → FRED T-bill → Heuristic.

**4. FX Risk Reversals — `api/correlations.js` + `index.html`**
- `action=risk-reversal`: endpoint baru di correlations.js (tidak butuh rate limiter terpisah).
- **Attempt 1 — CME CVOL Skew**: fetch `https://www.cmegroup.com/CmeWS/mvc/Volatility/historical?productCode=EUSK` (dan GBSK, JPSK, ADSK, CDSK) tanpa auth. Jika ≥3 pair berhasil → pakai CME CVOL.
- **Attempt 2 — Barchart OnDemand**: jika `BARCHART_API_KEY` env var tersedia, fetch getFuturesOptionsEOD untuk 6E/6B/6J/6A/6C/6N/6S, cari 25-delta calls dan puts (tolerance ±0.06), hitung `RR = call_IV - put_IV`.
- **Jika keduanya gagal**: return `{ available: false, reason: '...' }` dengan instruksi menambah `BARCHART_API_KEY`.
- Redis cache `rr_cache` TTL 3600s.
- **Frontend**: section `#fundRRSection` di tab FUNDAMENTAL, muncul secara dinamis saat data tersedia. Per pair: angka RR + label (Call Bias ↑ / Put Bias ↓ / Neutral). Sumber ditampilkan di header. Dipanggil fire-and-forget dari `fetchFundamental()`.

---

## Changelog Session 45 (2026-06-04)

### Bug Fixes

**1. Rate Path — Fix keyless FRED + T-bill logic + heuristic (`api/rate-path.js`)**
- Ganti `fetchFredSeries` (butuh `FRED_API_KEY`) → `fetchFredCsv` (keyless, pattern sama dengan `cb-status.js` scrapeUSD). Root cause "selalu fallback ke heuristic": FRED API key missing/rate-limit → semua T-bill null → heuristic.
- T-bill term premium fix: T-bill yield biasanya ~20bps DI ATAS EFFR di regime hold (term premium). Logic lama: `prob_cut = (FF - tbill) / 0.25` → T-bill di atas FF → prob_hike=100% (salah). Logic baru: `spread = FF - tbill + 0.20` → jika T-bill 4.30% dan FF 3.75%: spread = -0.35 → prob_cut = 1% ✓.
- Heuristic threshold lebih akurat: d≥0.5 (FF 3.5-4.0%) → 7% (sebelumnya 12%). Untuk FF=3.75%: 7% vs CME FedWatch aktual ~1.6% (lebih mendekati realita, bukan 7.5× lebih tinggi seperti sebelumnya).
- `computeRatePath()` tidak lagi butuh `apiKey` parameter.

**2. GDP Nowcast — Keyless fetch + auto-trigger via fundamental_refresh (`api/admin.js`)**
- `gdpnowHandler`: ganti dari FRED API (butuh key) ke `fetchGdpNowData()` helper yang primary-nya FRED CSV keyless, fallback ke API. Data kini pasti tersimpan ke Redis saat cron jalan.
- `fundamentalRefreshHandler`: di akhir handler, auto-refresh GDP Nowcast jika data >6 jam stale. Artinya klik tombol "REFRESH" di tab FUNDAMENTAL sekarang juga update GDP Nowcast di card USD.
- Data disimpan di `fundamental:USD` → `GDP Nowcast` → auto-render di tabel karena `renderFundamental()` sudah render semua key.

**3. Fundamental Parser — Reject % untuk quantity indicators + Core PCE YoY disambiguation (`api/_fundamental_parser.js`)**
- Tambah `QUANTITY_INDICATORS` set: NFP, Jobless Claims, Employment Change, Claimant Count, Building Approvals, Housing Starts, Durable Goods Orders. Jika value-nya berakhir `%`, parse di-reject. Fix: `NFP: 0.0%` tidak lagi bisa overwrite seed `NFP: 178K`.
- Disambiguasi Core PCE: jika headline mengandung `y/y|yoy|annual|year-on-year` → key disimpan sebagai `Core PCE YoY` (bukan `Core PCE`). Mencegah nilai `4.4%` YoY overwrite seed MoM `0.3%`. Idem untuk `Core CPI MoM` → `Core CPI YoY`.

**4. Inflation Expectations Update (`api/real-yields.js`)**
- EUR: 2.1% → 2.0% (ECB SPF Q2 2026, as_of 2026-04-10)
- CAD: 2.3% → 2.2% (BoC MPR Apr 2026, as_of 2026-04-16)
- AUD: as_of updated → RBA SoMP May 2026 (2026-05-06), value 3.2% (unchanged, RBA hiking)
- NZD: 2.2% → 2.1% (RBNZ MPS May 2026, as_of 2026-05-27)
- CHF: as_of updated → SNB Mar 2026 (2026-03-19), value 0.4% (unchanged)
- JPY: as_of updated → BoJ Tankan Q1 2026 (2026-03-28, Tankan published late March)
- GBP: unchanged (BoE IAS Q2 2026 results not published yet as of June 4)

---

## Changelog Session 44 (2026-06-03)

### Implementasi daun_merah_plan.md — 14 Items

**Data Accuracy:**
- `api/cb-status.js` — CB_FALLBACK diperbarui: AUD last_meeting `2026-05-05` (hike +25bps ke 4.35%), NZD last_meeting `2026-05-27` (hold)
- `api/real-yields.js` — Tambah 3 data source baru:
  - **OECD CPI Forecast** (`fetchOECDInflation`): auto-fetch dari OECD Economic Outlook, override hardcoded INFLATION_EXPECTATIONS. Redis key `oecd_inflation` TTL 24h.
  - **TGA + Fed Balance Sheet** (`fetchLiquidityIndicators`): US Treasury FiscalData API + FRED WALCL. Redis key `liquidity_usd` TTL 1h.
  - **Yield Curve USD+EUR** (`fetchYieldCurve`): FRED DGS2/5/10/30 untuk USD, ECB SDW untuk EUR. Spread 2Y10Y + NORMAL/FLAT/INVERTED label. Redis key `yield_curve` TTL 1h.
- `api/admin.js` — Tambah `?action=gdpnow`: fetch FRED GDPNOW series, simpan ke `fundamental:USD` hash sebagai "GDP Nowcast"
- `api/rate-path.js` — Tambah `fetchCMEZQData()`: fetch ZQ (30-day Fed Funds futures) settlement dari CME public endpoint, hitung probabilities per FOMC meeting. Fallback ke heuristic SOFR jika CME unavailable.

**Performance:**
- `api/market-digest.js` — Call 2 (CB bias) dan Call 4 (thesis monitor) sekarang fire sebagai async IIFEs **sebelum** Call 1 dimulai, berjalan concurrent. Sebelumnya sequential; sekarang parallel → hemat ~5-10 detik wall time per request.
- `api/journal.js` — GET entries: dari N+1 sequential Redis GET menjadi single `MGET` batch. Sama untuk `?action=analyze`. Dari 51 roundtrips (50 entries) → 2 roundtrips.

**New Features:**
- `api/correlations.js` — Tambah `?action=atr`: hitung ATR-14 + 1-day daily σ dari Yahoo Finance OHLCV. Cache `atr:{symbol}` TTL 4h. Support 29 pairs + XAU/USD.
- `api/risk-regime.js` — Tambah VIX term structure: fetch ^VIX1M + ^VIX3M dari Yahoo. Response includes `vix_term_structure: { vix_spot, vix_1m, vix_3m, structure }`. Label: "Backwardation (Panik Akut)" vs "Contango (Fear Terdistribusi)".

**Frontend (index.html):**
- **ATR/VaR di Sizing Calculator**: warning kuning jika SL < ATR 14d, baris info ATR + 1d VaR 95% selalu tampil setelah data tersedia (~1 detik async).
- **Yield Curve display**: section YIELD CURVE di card USD dan EUR di tab FUNDAMENTAL. Tampil 2Y/5Y/10Y/30Y rates + spread 2Y10Y dengan color coding.
- **Liquidity USD display**: section LIQUIDITY USD di card USD — Fed Assets + TGA balance dengan arah drain/inject.
- **VIX Term Structure**: row tambahan di regime breakdown — warna merah untuk backwardation, hijau untuk contango.
- **Checklist state per-pair**: `ckLoad/ckSave` sekarang pakai key `daunmerah_v2_state_{PAIR}` (e.g. `_EURUSD`). Saat ganti pair, state pair lama disimpan dan state pair baru dimuat.

---

## Changelog Session 41 (2026-06-02)

### Bug Fix — Dashboard Panel Tampil di Mobile

**Root cause:** `#dashboardPanel { display: none }` ditulis di dalam `@media (min-width: 1024px)`. Artinya di mobile (< 1024px) panel tidak punya aturan display apapun — browser render sebagai block element di bawah feed. `hideAllPanels()` hanya remove class `.visible` yang tidak berpengaruh di mobile.

**Fix:** Pindahkan `#dashboardPanel { display: none }` ke luar media query (scope global). Hanya rule `#dashboardPanel.visible { display: grid }` yang tetap di dalam media query. Panel sekarang selalu tersembunyi di mobile.

---

## Changelog Session 40 (2026-06-02)

### Sizing Calculator — Form Persist + History Optimistic Update
- `szPersistForm()` / `szRestoreForm()`: simpan semua field form ke `localStorage` (`daun_merah_sz_form`) saat HITUNG atau saat direction/mode berubah. Auto-restore saat tab SIZING pertama dibuka (termasuk setelah refresh/reopen PWA). Guard `_szRestoring` flag agar restore tidak trigger save ganda.
- Fields yang disimpan: equity, risk%, pair, RR, stop (pips), entry (pips mode), entryPrice & slPrice (price mode), direction, mode
- `szSaveHistory()` refactor ke fire-and-forget: tidak lagi `await`, tidak lagi trigger `szLoadHistory()`. History update via optimistic local cache (`szHistoryCache`) — muncul instan tanpa network roundtrip.
- `szRenderHistory()` dipisah dari `szLoadHistory()` agar bisa di-call dari cache maupun dari network.
- `initSizing()`: render history dari cache (instant) + load fresh di background setiap tab dibuka.

### CSS Polish
- **`100dvh`**: `body { height: 100dvh }` (fallback `100%`). Mencegah layout terpotong address bar mobile browser (Safari iOS, Chrome Android).
- **Scrollbar desktop**: `@media (min-width:1024px)` tampilkan scrollbar tipis 5px untuk `.feed-scroll`. Warna `--border` / `--muted` on hover. User mouse tahu konten bisa di-scroll. Mobile tetap hidden.
- **Pulse animation loading**: `.loading-pulse` pakai existing `@keyframes textPulse`. Diterapkan di: CB research, kalender ekonomi, jurnal list, COT, fundamental, COT tren chart.

## Changelog Session 40 (2026-06-23)

### Fix: Fundamental tab — CB Rate row tidak pernah auto-update (stale seed)

**Bug ditemukan:** Audit data tab FUNDAMENTAL menemukan `ECB Rate` masih tertulis 2.15% padahal ECB sudah hike ke 2.40% (meeting 2026-06-17, terdeteksi oleh `cb-status.js`). Root cause: field `"{Bank} Rate"` di hash `fundamental:{currency}` ditulis sekali saat `fundamental_seed` (`source:"seed"`, tanpa tanggal) dan tidak pernah ikut pipeline auto-refresh (`autoUpdateFundamentals`/`fundamental_refresh`) — beda mekanisme dari indikator headline lain. Semua 8 CB rate kebetulan masih cocok kecuali ECB, yang baru kena karena rate decision terbaru.

**Fix:**
- Extract logic scrape+cache CB rate dari `api/cb-status.js` ke modul baru `api/_cb_rates.js` (prefix `_` → tidak dihitung ke limit 12 serverless function). Export `getLiveCbRates()` — scrape 8 official source (FRED, ECB Data Portal, BoE/BoJ/RBA/RBNZ/SNB webpage, BoC Valet) dengan 6h Redis cache (`cb_rates_live_v2`), sama persis dengan yang sudah dipakai `cb-status.js`.
- `api/cb-status.js` jadi thin wrapper: panggil `getLiveCbRates()` + merge `cb_bias`.
- `api/admin.js` `fundamentalGetHandler`: setelah baca hash `fundamental:{cur}`, overlay key `"{Bank} Rate"` dengan hasil `getLiveCbRates()` (`actual`, `period`/`date` = `last_meeting`, `source` = `rate_source`: `live_fresh`/`live_cached`/`fallback`). Jadi setiap kali tab FUNDAMENTAL fetch data, rate bank sentral selalu live (maks ~6 jam basi dari cache), bukan beku dari seed.
- Tidak perlu cron baru atau write-through ke Redis — overlay terjadi di read-time, reuse cache 6h yang sudah ada.

**Verifikasi:** Test lokal `getLiveCbRates()` → EUR balik `2.4%` (`live_fresh`), konsisten dengan endpoint `/api/cb-status` production. Simulasi overlay ke struktur `fundamental_get` menghasilkan `"ECB Rate":{"actual":"2.4%","source":"live_fresh",...}` — sesuai ekspektasi.

## Changelog Session 39 (2026-06-02)

### Export CSV — Tab JURNAL
- Tambah tombol **EXPORT CSV** di baris filter (kanan, warna hijau) pada `jnListView`
- `jnExportCSV()`: export semua `jnAllEntries` (semua status) ke file `.csv`, diurutkan ascending by `created_at`
- Kolom: No, Tanggal Buka, Pair, Arah, Status, Entry, SL, TP, Lots, RR Plan, R Aktual, Exit Price, Tanggal Tutup, Alasan Keluar, Horizon, Regime, Thesis, Catatan Post-Trade
- UTF-8 BOM di awal file agar Excel Windows buka langsung tanpa encoding issue
- Nama file otomatis: `jurnal_daun_merah_YYYY-MM-DD.csv`
- Proper CSV escaping: wrap in quotes jika ada koma/newline/quote, double-quote untuk escape

## Changelog Session 38 (2026-06-02)

### Critical Bug Fixes

- **Vercel Body Timeout** (`api/journal.js`): `readBody()` sekarang cek `req.body` terlebih dahulu sebelum listen ke stream. Vercel auto-parses request body sehingga stream `req.on('data')` tidak pernah fire — penyebab 504 Gateway Timeout pada POST request jurnal.
- **Swipe Navigation** (`index.html`): Ganti `getComputedStyle` check + hard `return` dengan while-loop yang skip tab `dashboard` secara eksplisit pada viewport < 1024px. User mobile tidak lagi tersangkut saat swipe dari/ke tab manapun.
- **Pair Slicing EUR/USD** (`index.html`, 2 lokasi): Fix `pair.slice(3,6)` → `pair.includes('/') ? pair.split('/')` di `ckPrefillJurnal()` dan `openMT5Modal()`. `EUR/USD` sebelumnya menghasilkan `/US` sehingga CB bias tidak ter-apply. Line 5444 sudah benar sejak awal.
- **Service Worker Memory Leak** (`sw.js`): `loadSeenGuids()` sekarang merge (tidak overwrite) Set in-memory. `saveSeenGuids()` trim `seenGuids` di memori ke 200 entri, selaras dengan cache storage — mencegah Set bertumbuh tak terbatas antar wake cycle.

## Changelog Session 37 (2026-06-02)

### Fitur 1 — COT Historical Trend Chart
- **Backend**: tambah branch `?type=cot_history&n=12` di `api/feeds.js` — baca Redis sorted set `cot_history` (sudah di-populate sejak session 20), slice N terbaru, return ascending untuk chart. Cache `cot_history_cache` TTL 3600s.
- **Frontend COT tab**: tombol `[TREN]` muncul di setiap row Leveraged Funds. Klik toggle panel inline SVG line chart 2 garis (AM net = teal `#00c896`, Lev net = pink `#f472b6`).
- SVG pure: viewBox 400×120, y-axis label, x-axis label (tanggal), zero line putus-putus, hover hitbox per titik data dengan tooltip global fixed.
- Client cache `cotHistoryCache` TTL 30 menit. State `cotTrendOpen` per currency, di-reset saat `renderCOT()` rebuild DOM.

### Fitur 2 — Macro Scenario Planner
- Panel inline muncul di bawah setiap event **High-impact** di tab CAL (toggle via tombol `[SIMULASI]`).
- Tombol `[▲ BEAT]` / `[▼ MISS]` → kalkulasi ranking 3 pair terbaik berdasarkan CB bias divergence dari `cbData`.
- Logic `scenarioRankCurrencies`: USD event → ranking 7 counterpart; non-USD event → pair vs USD + crosses.
- Hasil render: pair name, direction LONG/SHORT (warna hijau/merah), alasan CB bias + rate. Warning "tetap validasi via CHECKLIST" + tombol langsung ke checklist dengan pair pre-select.
- State `calScenarioOpen` reset saat `renderCalendar()` rebuild DOM.

### Fitur 3 — Command Center Dashboard (Desktop ≥1024px)
- Tab `DASHBOARD` di top nav — hanya muncul di `@media (min-width: 1024px)` via CSS.
- CSS grid 3-kolom: 280px News | 1fr AI Digest + Thesis | 260px CB Bias + Fund Ranking; event bar full-width di bawah.
- JS: `initDashboard()`, `renderDashNews()`, `renderDashDigest()`, `renderDashBias()`, `renderDashEvents()`, `refreshDashboard()`.
- Semua data reuse dari memory global (`allItems`, `ringkasanCache`, `cbData`, `fundData`, `calData`) — tidak ada fetch tambahan.
- Auto-refresh `setInterval` 60s hanya saat tab aktif; otomatis stop saat pindah tab.
- Keyboard shortcut: `G D`. Swipe mobile: skip dashboard (hidden tab check via `getComputedStyle`).

---

## Changelog Session 36 (2026-06-02)

### Equity Curve — Tab JURNAL
- Tambah tab **KURVA** di sub-nav Journal (sebelah "+ BARU")
- `jnRenderCurve()`: render SVG equity curve dari closed trades yang punya `r_actual`
- Kurva cumulative R-multiple, fill hijau di atas nol, merah di bawah nol
- Stats row: Total R, Win Rate, Avg Win R, Avg Loss R + Max Drawdown
- Zero dependency — pure SVG, load instan
- Auto-render saat tab KURVA dibuka; auto-refresh setelah `jnLoadEntries()` selesai

### Event Strip — Tab TEK
- Tambah horizontal scroll strip `#tekEventStrip` antara TradingView chart dan MTF bar
- `renderTekEventStrip()`: filter `calData` hanya High-impact, dalam 48 jam ke depan, untuk currencies yang relevan dengan pair aktif
- Mapping `PAIR_CURS` (e.g. EURUSD → EUR+USD) untuk filter otomatis per pair
- Setiap event tampil sebagai chip: currency color dot + nama event + time WIB + countdown ("2j 30m")
- Strip disembunyikan (`display:none`) jika tidak ada event relevan
- Di-update saat `initTeknikal()` dan setiap `onTekPairChange()`

---

## API Endpoints

### `GET /api/feeds?type=rss`
Proxy RSS FinancialJuice. Redis `rss_cache` TTL 60s. Header `X-Cache-Source: REDIS/UPSTREAM/STALE`.

### `GET /api/feeds?type=research`
Backend tab "CB WATCH". Fetch 6 RSS feeds paralel via `Promise.allSettled`. Merge, sort by date, 50 items terbaru (max 20/sumber). Redis `research_cache` TTL 6h. Support `?force=1` untuk bypass cache. Response: `{ items:[{ title, pubDate, link, source }], fetched_at, stale? }`.

**Sumber aktif:**
- `FED`  — `federalreserve.gov/feeds/speeches.xml` (direct — pidato governor)
- `FOMC` — `federalreserve.gov/feeds/press_monetary.xml` (direct — rate decisions)
- `FEDN` — `federalreserve.gov/feeds/feds_notes.xml` (direct — FEDS Notes, analytical)
- `ECB`  — `ecb.europa.eu/rss/press.html` (direct — press releases)
- `ECBB` — `ecb.europa.eu/rss/blog.html` (direct — ECB research blog)
- `BIS`  — `bis.org/doclist/cbspeeches.rss` via rss2json proxy (WAF bypass — unverified)

**Diblokir Vercel IPs (403), tidak digunakan:** IMF Blog, FRED Blog, BOE, NY Fed.

> Nitter (`?type=nitter`) sudah dihapus — semua instance return body kosong sejak X/Twitter blokir scraping.

### `GET /api/feeds?type=cot`
Scrape CFTC, parse Leveraged Funds + Asset Manager positions. Redis `cot_cache_v2` TTL 6 jam. Fallback ke stale jika parsed currencies < 5.

### `GET /api/admin?action=health`
Probe 6 external sources paralel. Telegram alert jika DOWN > 2 jam. Auth: `x-admin-secret` header.

### `GET /api/admin?action=redis-keys`
Registry semua Redis keys + live TTL. `POST ?action=redis-keys&cleanup=true` untuk hapus deprecated keys. Auth: `x-admin-secret`.

### `GET/POST/DELETE /api/admin?action=admin-prompts&key=...`
Update Groq prompts di Redis tanpa redeploy. Keys: `prompt_digest`, `prompt_bias`, `prompt_thesis`. Auth: `x-admin-secret`.

### `POST /api/admin?action=push`
Cron-triggered web push + Telegram. Auth: `x-cron-secret` header. Setup di cron-job.org: URL `/api/admin?action=push`.

### `GET /api/market-digest`
Main AI endpoint. Multi-provider chain dengan circuit breaker. Flow:
1. Load `prompt_digest` dari Redis (fallback ke hardcoded `DIGEST_SYSTEM_DEFAULT`)
2. Fetch RSS via internal `/api/feeds?type=rss`
3. Fetch ForexFactory kalender (this week + next week)
4. Load `digest_history` + `real_yields` + **`xau_spot`** dari Redis paralel
5. **`fetchXauSpot()`** — Yahoo Finance `GC=F` → fallback Binance PAXGUSDT. Cache Redis `xau_spot` TTL 5 menit. Inject ke prompt sebagai jangkar harga `$xxx.xx (+y%)`.
6. **Call 1 — Market Briefing (Bahasa Indonesia):**
   - Primary: OpenRouter `openai/gpt-oss-120b:free` (circuit breaker `ai:openrouter`, timeout 28s) — terbukti stabil, output Bahasa Indonesia confirmed via live test
   - Fallback 1: Groq `qwen/qwen3-32b` (timeout 20s, max_tokens 1800)
   - Fallback 2: Groq `llama-3.3-70b-versatile` (timeout 14s, max_tokens 2000)
   - Last resort: template fallback (kumpulan headline)
   - `method` field: `openrouter` / `groq-qwen3` / `groq` / `fallback`
   - Instruksi `PENTING: TULIS SELURUH OUTPUT DALAM BAHASA INDONESIA` ditambahkan ke user message — fix bahasa Inggris yang muncul saat model diabaikan system prompt
   - DeepSeek V4 Flash free dites tapi tidak dipakai — upstream Crucible konsisten 429, tidak reliable
7. Save ke `digest_history` (Redis, LPUSH/LTRIM max 7)
8. **SambaNova Call 2:** CB Bias Assessment — JSON per currency (circuit breaker `ai:sambanova`) — **DeepSeek-V3.2** (upgrade dari V3.1, session 34)
   - **Session 35 — Fundamental Anchor:** Sebelum build prompt, fetch `fundamental:{currency}` dari Redis untuk setiap `relevantCurrency`. Data injected ke prompt sebagai context objektif: `"USD: CPI YoY 3.2% (prev 3.5%), NFP: +180K [2026-05-30]"`. AI diberi instruksi untuk weight fundamentals lebih tinggi dari headline sentiment kalau bertentangan.
   - **Session 35 — Confidence Gate (A):** Kalau AI return confidence `Low` untuk suatu currency → skip update, pertahankan existing bias di Redis. Mencegah flip ke Neutral di hari sepi berita.
   - **Session 35 — Swing Anchor (B):** Kalau new bias bergerak >2 level dari existing bias (skala BIAS_ORDER 7 tingkat) tanpa `High` confidence → skip update. Contoh: `Cautious Dovish → Hawkish` butuh High confidence. Realistic pivot dengan banyak evidence (High conf) tetap langsung update.
   - Prompt diupdate: currency dengan bukti tidak cukup wajib **dihilangkan** dari response (bukan ditebak), instruksi confidence Low prefer omit.
9. Merge + save ke Redis `cb_bias` (hanya currencies yang lolos gate A + B)
10. **SambaNova Call 3:** Structured thesis JSON → fallback Groq llama jika sambanova OPEN — **DeepSeek-V3.2**
11. **Groq Call 4:** Thesis Invalidation Monitor — scan open journal entries vs headlines. Hasil di-cache Redis `thesis_alerts:{device_id}` (TTL 30 menit). Ditampilkan inline di ringkasan + toast notif saat ada kontradiksi. Initial load juga fetch cached alerts via `mode=cached&device_id=...`
12. **`autoUpdateFundamentals`** — parse 100 headline terbaru → HSET `fundamental:{currency}`, deteksi CB rate decision → `cb_decisions`
13. **`autoUpdateFundamentalsFromCalendar`** — FF calendar events dengan `actual` non-null langsung update `fundamental:{currency}` tanpa parsing teks (source: `ff_calendar`)
14. Return: `{article, method, news_count, cal_count, bias_updated, generated_at, thesis, thesis_alerts}`

**Circuit breakers:** `ai:openrouter`, `ai:cerebras`, `ai:sambanova` — reset via `POST /api/admin?action=circuit-reset`. Status via `GET /api/admin?action=circuit-status`.

**Redis keys baru:** `xau_spot` (TTL 300s) — harga XAU/USD live dari Yahoo GC=F atau Binance PAXG.

Rate limited: 4 req/min per IP.

### `GET /api/cb-status`
Static CB data (rates, last meeting) + bias dari Redis `cb_bias`.

### `GET /api/calendar`
ForexFactory high-impact + medium-impact events, 5 hari ke depan. Waktu dikonversi ke WIB (UTC+7).
Return fields per event: `{ date, time_wib, currency, event, impact, forecast, previous, actual }`
**TIDAK ADA field `datetime`** — frontend harus construct dari `date` + `time_wib`.

### `GET /api/risk-regime`
Classifier Risk-On/Neutral/Risk-Off dari VIX (FRED), MOVE (Stooq), HY OAS (FRED). Redis `risk_regime` TTL 1800s.

### `GET /api/real-yields`
Real yield differential. USD: DGS10 − T10YIE. 7 currencies lain hardcoded inflation expectations. Redis `real_yields` TTL 21600s.
Per currency: `{ nominal, inflation_exp, real, source_inflation, inflation_as_of, as_of, stale }`. `stale: true` jika `inflation_as_of > 90 hari`. UI menampilkan `(lama)` kuning + tooltip source + usia hari.

### `GET /api/rate-path`
USD rate path **HEURISTIC** (bukan CME FedWatch / market-implied). FRED SOFR/EFFR + step-function probability. UI menampilkan label "Estimasi (bukan probabilitas pasar)". Redis `rate_path` TTL 14400s.

### `GET /api/correlations`
Cross-asset Pearson 20d + 60d, 12 instrumen via Yahoo Finance. On-demand via button. Redis `correlations_v2` TTL 86400s. Rate limited: 5/min.
Response fields: `instruments`, `matrix_20d`, `matrix_60d`, `anomalies` (max 10, delta >0.4), `gold_correlations` (Gold vs 10 aset: DXY/Silver/Copper/WTI/US10Y/SPX/VIX/JPY/AUD/EUR — selalu ada, bukan hanya anomali), `computed_at`, `stale`.

### `GET /api/correlations?action=ta&symbol=...`
Endpoint TA murni (RSI 14, SMA 50, SMA 200, Volume) dari Yahoo Finance. Rate limited: 5/min (shared dengan correlations).
- `symbol`: default `GC=F`. FX: `EURUSD=X`, `USDJPY=X`, dll. Futures: `GC=F`, `CL=F`. Equities: `^GSPC`.
- `interval`: `5m` `15m` `30m` `1h` `4h` `1d`(default) `1wk`. Range dikunci otomatis per interval (misal `1h`→`60d`, `1d`→`1y`).
- Volume (`current_volume`, `volume_sma_20`, `volume_status`) hanya tersedia untuk futures/equities — `null` untuk FX OTC (`EURUSD=X` dll) karena Yahoo tidak menyediakan data volume OTC yang reliable.
- Redis cache per `ta:{symbol}:{interval}`: TTL 1800s (daily), 600s (intraday).
- Response fields: `symbol`, `interval`, `range`, `current_price`, `rsi_14`, `sma_50`, `sma_200`, `price_vs_sma50`, `price_vs_sma200`, `current_volume`, `volume_sma_20`, `volume_status`, `computed_at`, `from_cache`.
- **Frontend integrasi (session 20):** Panel TA 4-kotak ditampilkan di tab TEK, di bawah MTF bar dan di atas catatan analisa. Auto-fetch saat pair/TF berganti. Client-side cache 90s. FX OTC: volume ditampilkan "n/a FX OTC". TEK_YAHOO_SYM mapping: EURUSD→EURUSD=X, ..., XAUUSD→GC=F.

### `GET /api/correlations?action=ohlcv&symbol=...&tf=...`
Endpoint OHLCV candle data untuk Lightweight Charts (session 24). Rate limited: 10/min.
- `symbol`: Yahoo Finance symbol (e.g. `EURUSD=X`, `GC=F`).
- `tf`: `1d` | `1h` | `4h` | `15m`. Note: `4h` di-fetch sebagai `1h` lalu di-resample ke 4h server-side via `resample4h()` (Yahoo tidak support 4h native).
- Range otomatis per tf: `15m`→`5d`, `1h`→`30d`, `4h`→`60d`, `1d`→`1y`.
- Redis cache per `ohlcv:{symbol}:{tf}`: TTL 1800s (daily), 300s (intraday).
- Response: `{ symbol, tf, candles:[{time, open, high, low, close}], fetched_at }`.
- **Frontend (session 24):** Chart engine diganti dari TradingView embedded widget ke Lightweight Charts v4 (open-source, supports custom drawing). Drawing tools: horizontal line (S/R level), trendline, rectangle (supply-demand zone). Drawing disimpan ke `localStorage['tek_drawings']` per pair+TF key (e.g. `EURUSD_240`). Toolbar: cursor, 4 alat drawing, 4 pilihan warna, undo terakhir, hapus semua. Chart tinggi diperpanjang: `clamp(420px, 62vh, 780px)`.

### `POST/GET /api/sizing-history`
History sizing calculations per device. Redis sorted set `sizing_history:{device_id}`, max 10.

### `POST/PATCH/GET/DELETE /api/journal`
Trade journal CRUD. Soft-delete. Redis `journal:{device_id}:{id}` + sorted set `journal_index:{device_id}`.

### `GET /api/journal?action=analyze&device_id=xxx`
AI analysis of closed trade performance. Fetches all closed entries, sends to Groq `llama-3.3-70b-versatile`, returns analysis text + stats (win rate, total R, avg R). Cached per device_id for 1 hour (`journal_analysis:{device_id}`). `?force=1` bypasses cache. Requires ≥3 closed trades. Endpoint merged into `journal.js` to stay within Vercel 12-function limit.

### `GET /api/admin?action=fundamental_get`
Return semua data fundamental per 8 currency dari Redis (`fundamental:{currency}` HGETALL).

### `POST /api/admin?action=fundamental_seed`
Seed data awal fundamental (dijalankan sekali). Auth: `x-admin-secret`.

### `POST /api/admin?action=fundamental_refresh`
Refresh fundamental dari dua sumber: (1) `news_history` Redis — 100 headline FJ terbaru, (2) FF calendar (this week + last week) — ambil events dengan `actual` non-null. Kedua sumber diproses paralel dan hasilnya di-merge. Auth: `x-admin-secret`.

### `POST /api/admin?action=fundamental_analysis`
AI analysis currency terkuat/terlemah dari data fundamental. Cache Redis `fundamental_analysis` TTL 6h. Provider: Groq `llama-3.3-70b-versatile`.

### `POST /api/admin?action=journal_import`
Bulk import historical trades dengan timestamp asli (preserves `created_at`). Body: `{device_id, entries:[...]}`. Auth: `x-admin-secret`.

### `POST /api/subscribe`
Web Push subscription management.

---

## Desain UI / Color System

```css
:root {
  --bg: #0a0a08;        /* latar belakang utama */
  --surface: #111110;   /* card/nav surface */
  --border: #222220;
  --accent: #c0392b;    /* merah daun merah */
  --accent-dim: #7a1f17;
  --text: #e8e4d9;
  --muted: #6b6860;
  --text-mid: #a8a49a;
  --green: #27ae60;
  --yellow: #e67e22;
  --purple: #a78bfa;
  --pink: #f472b6;
}
```

Font: **Syne** (logo/heading), **DM Mono** (semua teks lainnya)

---

## Navigasi

### Desktop — Top Nav (`.nav-views`)

| Tab | `data-view` | Warna |
|-----|-------------|-------|
| NEWS | `feed` | `--accent` |
| RINGKASAN | `ringkasan` | `--accent` |
| CAL | `cal` | `--green` |
| COT | `cot` | `--purple` |
| FUNDAMENTAL | `fundamental` | `--yellow` |
| CHECKLIST | `checklist` | `--yellow` |
| SIZING | `sizing` | `--accent` |
| JURNAL | `jurnal` | `--pink` |
| PETUNJUK | `petunjuk` | `#60a5fa` |

### Mobile — Bottom Nav (`#botNav`, `.bot-nav`)
Fixed bottom bar, hanya muncul di ≤767px. Top nav disembunyikan di mobile. 8 tombol dengan SVG icon + label pendek. Active state disinkronkan dua arah dengan top nav.
**Catatan implementasi:** Event listener pakai event delegation pada `document` (bukan `querySelectorAll` langsung) karena `#botNav` HTML berada setelah `</script>` tag.

### Keyboard Shortcuts (2026-05-27)
Bloomberg-style keyboard navigation. Aktif hanya saat tidak ada input/textarea yang fokus.

**G + huruf — navigasi antar fitur:**
| Shortcut | Tujuan |
|----------|--------|
| `G N` | News (feed) |
| `G B` | CB Watch |
| `G R` | Ringkasan |
| `G K` | Kalender |
| `G C` | COT |
| `G F` | Fundamental |
| `G L` | Checklist |
| `G S` | Sizing |
| `G J` | Jurnal |
| `G P` | Petunjuk |
| `G T` | Teknikal |

**Angka 1–7 — sub-filter News** (hanya aktif saat di tab News): All, Mkt Moving, Forex, Macro, Econ Data, Energy, Geopolitical.

**Checklist navigation**: `↑`/`↓` navigasi item, `Space`/`Enter` centang/uncentang, `Esc` lepas fokus. Item terfokus diberi highlight kuning `.ck-focused`.

**Global**: `?` buka/tutup help overlay shortcut. `Esc` tutup overlay / lepas fokus checklist.

**G-mode indicator**: Saat `G` ditekan, muncul badge kecil di bawah layar ("G —") selama 1 detik sebagai feedback visual. Implementasi: `kbGSeq` flag + `setTimeout` 1000ms. Semua logika di `// ── KEYBOARD SHORTCUTS ──` section, sebelum `</script>`.

### Swipe Gesture (2026-05-07)
Navigasi antar tab dengan swipe kiri/kanan. Implementasi: `touchstart`/`touchend` listener pada `document` (passive). Logika: `|dx| ≥ 60px` AND `|dx| > |dy|` → navigate. Swipe kiri = tab berikutnya, swipe kanan = tab sebelumnya. Diabaikan jika touch dimulai di `#navViews`, `#navFilters`, `#botNav`, `input`, `select`, atau `textarea`. Reuse logika tab via `.click()` sehingga data fetch otomatis berjalan. Tab order: feed → ringkasan → cal → cot → checklist → sizing → jurnal → petunjuk.
Panel incoming diberi class `swipe-in-right` (swipe kiri) atau `swipe-in-left` (swipe kanan) — CSS keyframe `translateX(±40px)→0 + opacity:0→1`, 220ms ease-out, dihapus setelah `animationend`.

### Category Filters (`.nav-filters`)
Hanya muncul di view NEWS: All, Mkt Moving, Forex, Macro, Econ Data, Energy, Geopolitical.

---

## Checklist — Detail Teknis

DOM: item = `div.ck-item`, checkbox = `div.ck-box` dengan `id="ckbox_{id}"` (**bukan `<input>`**).

```js
const PLAYBOOKS = {
  smc_ict:        { name, color, sections:[...], quick:[...], gates:[...] },
  macro_momentum: { ... },
  event_driven:   { ... },
  mean_reversion: { ... },
};
const PB_REGIME_CHECK = { id:'regime_check', num:'00', ... }; // shared semua playbook
let ckActivePlaybook = localStorage.getItem('daun_merah_playbook') || 'smc_ict';
```

localStorage keys: `daunmerah_v2` (state), `daun_merah_playbook` (active), `daun_merah_device_id` (device ID)

### Scoring System (session 2026-05-27)
- **Weighted scoring** — gate sections (3 per playbook) mendapat bobot ×2, section biasa bobot ×1
- **Hanya parent items** yang dihitung dalam scoring; sub-items tetap interaktif tapi bersifat guidance
- **4 verdict zones:**
  - `0%` → `—` (pending)
  - `1–49%` → `NO TRADE` (merah)
  - `50–74%` → `PERTIMBANGKAN` (kuning)
  - `75–89%` → `SIAP TRADE` (hijau muda)
  - `90–100%` → `ENTRY` (hijau)
- Skor ditampilkan sebagai `Score: X%` di bawah verdict label

### Gate Sections (3 kritis per playbook)
| Playbook | Gates (bobot ×2) |
|---|---|
| SMC/ICT | `regime_check`, `gate` (Driver Validity), `risk` |
| Macro Momentum | `regime_check`, `mm_trend`, `mm_risk` |
| Event-Driven | `regime_check`, `ed_event`, `ed_risk` |
| Mean Reversion | `regime_check`, `mr_range`, `mr_risk` |

### SMC/ICT Simplification
- `postentry` (09) + `antibias` (10) → merge jadi `disiplin` (09), 6 items, tanpa sub-items

### Auto-populate Logic — `ckAutoTickRegimeCheck(pair)` + helper functions
**Shared (rc1–rc5, semua playbook):**
- `rc1` ← regimeData fresh (<30 min)
- `rc2` ← cbData bias untuk base + quote tersedia
- `rc3` ← cotData positions tersedia
- `rc4` ← calData: tidak ada High-impact event <6 jam → auto-tick; ada → auto-block
- `rc5` (hint) ← realYieldsData spread ditampilkan di `#ckPairHint`

**SMC/ICT** — `_ckAutoSMC(base, quote)`:
- `f2` ← cbData[base].bias ≥ Hawkish (level ≥3)
- `f3` ← cbData[quote].bias ≤ Dovish (level ≤1)
- `f1`, `f4b`, `f6` ← kedua kondisi di atas terpenuhi
- `tm1a` ← jam UTC 08–15 (London session)
- `tm1b` ← jam UTC 13–20 (NY session)

**Macro Momentum** — `_ckAutoMacro(base, quote)`:
- `mm_cb1` ← salah satu CB hawkish, yang lain dovish/netral (dari cbData)
- `mm_cb2` ← divergence ≥2 level dari `CB_BIAS_LEVEL` map
- `mm_cb4` ← real yield spread >0.3% mendukung arah
- `mm_co2` ← cotData Asset Manager net positions tersedia

**Event-Driven** — `_ckAutoEvent(base, quote)`:
- `ed_ev1` ← calData: ada High-impact event <24 jam untuk pair
- `ed_ev3` ← calData: event tersebut punya forecast atau previous

**Mean Reversion** — `_ckAutoMeanRev()`:
- `mr_ra4` ← regimeData.regime === 'Neutral'

**CB_BIAS_LEVEL mapping** (digunakan semua helper):
```js
const CB_BIAS_LEVEL = { 'very hawkish':4, 'hawkish':3, 'neutral':2, 'dovish':1, 'very dovish':0 };
```

**Helper `_ckEvTimestamp(ev)`** — construct UTC ms dari `ev.date` + `ev.time_wib` (WIB=UTC+7), replace duplikasi konstruksi timestamp di rc4 dan _ckAutoEvent.

---

## Redis Keys

| Key | Isi | TTL | Owner |
|-----|-----|-----|-------|
| `rss_cache` | `{xml, fetchedAt}` | 60s | `api/feeds.js` |
| `cot_cache_v2` | Full COT payload | 21600s | `api/feeds.js` |
| `cot_history` | Sorted set snapshot mingguan COT (score=timestamp, 90-day rolling) | no TTL (rolling ZREMRANGE) | `api/feeds.js` |
| `cot_hist_lock:{dateKey}` | Dedup lock per minggu COT report | 604800s | `api/feeds.js` |
| `research_cache` | CB Watch items JSON (FED+FOMC+FEDN+ECB+ECBB+BIS, 50 items terbaru) | 21600s | `api/feeds.js` |
| `cb_bias` | `{USD:{bias,confidence,updated_at},...}` | no TTL | `api/market-digest.js` |
| `digest_history` | Redis list max 7 entri digest AI (LPUSH/LTRIM) | no TTL | `api/market-digest.js` |
| `latest_thesis` | Structured thesis JSON | 21600s | `api/market-digest.js` |
| `risk_regime` | VIX/MOVE/HY payload | 1800s | `api/risk-regime.js` |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s | `api/real-yields.js` |
| `rate_path` | `{USD:{probHold,...}}` | 14400s | `api/rate-path.js` |
| `correlations_v2` | Correlation matrix 20d+60d + gold_correlations | 86400s | `api/correlations.js` |
| `health_last_ok` | HSET: source → last OK ISO | no TTL | `api/admin.js` |
| `sizing_history:{device_id}` | Sorted set sizing calculations | no TTL | `api/sizing-history.js` |
| `journal:{device_id}:{id}` | Full journal entry JSON | no TTL | `api/journal.js` |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL | `api/journal.js` |
| `journal_analysis:{device_id}` | AI performance analysis per device | 3600s | `api/journal.js` |
| `prompt_digest` | Override Groq prompt briefing | no TTL | `api/admin.js` |
| `prompt_bias` | Override Groq prompt CB bias | no TTL | `api/admin.js` |
| `prompt_thesis` | Override Groq prompt thesis | no TTL | `api/admin.js` |
| `push_subs` | HSET push subscriptions | no TTL | `api/subscribe.js` |
| `seen_guids_set` | Redis SET GUID berita (SADD/SMEMBERS, atomic dedup) | 86400s | `api/admin.js` |
| `push_lock` | Distributed lock cron push (SET NX EX 55) | 55s | `api/admin.js` |
| `rl:{endpoint}:{ip}:{window}` | Rate limiter counter | auto 2×window | `api/_ratelimit.js` |
| `fundamental:{currency}` | Hash: indicator → `{actual,period,date,source}` | no TTL (overwrite) | `api/admin.js` + `api/market-digest.js` |
| `fundamental_analysis` | JSON AI analysis currency terkuat/terlemah | 21600s | `api/admin.js` |
| `cb_decisions` | Hash: currency → `{last_meeting,last_decision,last_bps}` dari headline | no TTL | `api/market-digest.js` |
| `circuit:{source}` | JSON: `{state,failures,openUntil,lastFailure,lastSuccess}` — circuit breaker per sumber | 3600s | `api/_circuit_breaker.js` |
| `sizing_rates` | `{rates:{EURUSD,GBPUSD,...}, fetched_at}` — live FX rates untuk pip value cross-pair | 300s | `api/correlations.js` |

**Deprecated (sudah bisa dihapus):** `cot_cache`, `fundamentals_cache`, `seen_guids`

---

## Fungsi JS Kunci

```javascript
setFeedUI(show)             // toggle toolbar + navFilters visibility
hideAllPanels()             // hide semua panel (9 panel termasuk fundamentalPanel)
fetchFeed()                 // fetch /api/feeds?type=rss
fetchRegime()               // fetch /api/risk-regime, update banner
generateRingkasan()         // GET /api/market-digest
jnPrefillFromThesis()       // prefill form jurnal dari AI thesis
szGetDeviceId()             // get/create device ID dari localStorage
ckAutoTick(id, hint)        // auto-centang item checklist
ckAutoBlock(id, hint)       // auto-block item checklist (merah)
ckSwitchPlaybook(id)        // ganti playbook + reset state
ckAutoTickRegimeCheck(pair) // auto-tick rc1-rc4 dari live data
startCountdownTimer()       // mulai interval 30s countdown event CAL
stopCountdownTimer()        // hentikan interval saat keluar tab CAL
renderCountdown()           // hitung + render countdown ke high-impact event terdekat (24h window)
fetchFundamental()          // GET /api/admin?action=fundamental_get
renderFundamental()         // render kartu per currency dari fundData
generateFundamentalAnalysis() // POST /api/admin?action=fundamental_analysis
```

---

## Bug History

- **RINGKASAN "0 berita"** — `market-digest.js` masih memanggil `/api/rss` (sudah dihapus). Fix: update ke `/api/feeds?type=rss` (commit 6f48bcb).
- **Vercel 12-function limit** — 17 fungsi melebihi Vercel Hobby limit. Fix: konsolidasi ke 12 (commit 95db702).
- **`sendTelegram` naming conflict** — saat merge push.js + health.js ke admin.js. Fix: rename ke `sendHealthTelegram` + `sendPushTelegram`.
- **qwen-qwq-32b timeout** — model reasoning overhead melewati Vercel 25s limit. Rollback ke `llama-3.3-70b-versatile`.
- **sw.js FETCH_URL Netlify** — endpoint `/.netlify/functions/rss` mati sejak migrasi ke Vercel. Fix: update ke `/api/feeds?type=rss` (session 2026-04-27).
- **rc4 auto-tick false positive** — `ckAutoTickRegimeCheck` compare `ev.impact !== 'high'` (lowercase) tapi API return `'High'` (kapitalized). Dan `ev.datetime` tidak ada — construct dari `ev.date` + `ev.time_wib`. Fix: session 2026-04-27.
- **convertToWIB UTC offset salah** — ForexFactory XML pakai US/Eastern (EST/EDT), bukan UTC. Comment di code salah. `+7` seharusnya `+12` (EST) atau `+11` (EDT). Semua jam event di tab CAL off ~5 jam. Fix: session 2026-04-27.
- **rate-path heuristic tidak honest** — UI tampilkan probabilitas hold/cut tanpa label bahwa ini bukan market-implied. Fix: tambah label "Estimasi" di session 2026-04-27.
- **GOLD_KEYWORDS terlalu sempit** — banyak XAU driver (Fed, real yield, risk sentiment) tidak di-filter ke gold block. Fix: expand keywords + cap goldItems 25→30 (2026-05-04).
- **USDJPY inconsistent dengan FX lain** — label anomali "USDJPY vs Gold" membingungkan (USDJPY = USD kuat, sedangkan EUR/GBP/AUD = currency kuat). Fix: rename ke JPY + invert 1/close sehingga JPY kuat = naik, konsisten X/USD format (2026-05-04).
- **Korelasi gold hanya muncul saat anomali** — tidak ada tabel tetap XAU vs Silver/Copper/dll. Fix: tambah `gold_correlations` section di API + UI tabel selalu-tampil (2026-05-04).
- **CB meeting metadata bisa stale tanpa peringatan** — `last_meeting` dari CB_FALLBACK tidak diupdate otomatis; trader bisa baca konteks dari meeting 2 bulan lalu. Fix: tambah warning merah di CB card jika `last_meeting > 45 hari` (2026-05-04).
- **Real yield stale indicator tidak visible** — dot kuning 5px tidak terlihat; trader tidak sadar EUR/CAD/CHF inflation expectation >90 hari. Fix: nilai real yield berubah warna kuning + teks `(lama)` + tooltip source + usia hari (2026-05-04). API juga tambah field `inflation_as_of`.
- **CB bias timestamp tanpa tanggal** — `fmtCBTime` hanya tampilkan `HH:MM WIB`; bias kemarin terlihat seperti hari ini. Fix: tampilkan tanggal kalau >12 jam lalu (2026-05-04).
- **Petunjuk SOP stale** — step 2.3 hanya sebut 2 dari 4 playbook; tidak ada langkah korelasi. Fix: update step 2.3 + tambah step 1.5 Cross-Asset Correlations (2026-05-04).
- **AUTO refresh hilang setelah pindah tab** — browser mobile (iOS Safari, Chrome Android) bisa discard tab background → halaman reload → `autoToggle` reset ke off, interval hilang. Fix: simpan state ke `localStorage` + restore di `load` handler + `visibilitychange` listener restart interval saat tab aktif lagi + `pageshow` handler untuk bfcache restore (2026-05-05).
- **Ringkasan XAU/USD kehilangan konteks NY session** — `market-digest.js` hanya pakai 12 jam RSS window. Saat London session, berita NY session sebelumnya (20:00–03:00 WIB) sudah di luar window. Fix: `feeds.js` simpan item RSS ke Redis Sorted Set `news_history` (36h rolling, ZADD NX + ZREMRANGEBYSCORE auto-prune, throttle 5 menit via `news_history_lock` SET NX EX 300). `market-digest.js` baca `ZRANGEBYSCORE` paralel dengan RSS live (hard timeout 3s via Promise.race), merge + dedup by GUID. Gold block di-split jadi `[12 JAM TERAKHIR]` + `[KONTEKS HISTORIS 12-36 JAM LALU]` agar Groq bisa weight berita dengan tepat. Prompt Groq sekarang include nama hari (dayStr) + catatan otomatis Senin pagi untuk konteks volume weekend tipis (2026-05-05).
- **Berita duplikat + jadi 200 saat kembali dari background** — (1) `handleNewItems` selalu append → `allItems` bisa melebar sampai 200 kalau banyak GUID "baru". (2) Tidak ada guard concurrent `fetchFeed()` → `visibilitychange` + `window.load` trigger dua fetch bersamaan. Fix: `fetchFeed` diganti full merge-dedup via `Map<guid, item>` + slice ke 100. `isFetching` flag guard — fetch kedua langsung return. `handleNewItems` dihapus. (2026-05-05).
- **Nitter (@DeItaone) tidak mengirim berita apapun** — semua instance (`nitter.net`, `nitter.privacydev.net`, `nitter.poast.org`) return HTTP 200 body kosong karena X/Twitter memblokir scraping. Fix: hapus seluruh Nitter dari frontend + backend (`fetchNitter`, `parseNitterRSS`, `nitterHandler`, `FETCH_NITTER_URL`, `NITTER_INSTANCES`). Sumber berita sekarang hanya FinancialJuice RSS. (2026-05-05).
- **Push notifikasi duplikat** — dua cron trigger berjalan hampir bersamaan, keduanya baca `seen_guids` sebelum salah satu selesai menulis → kedua instance kirim notif yang sama. Fix: (1) distributed lock `push_lock` (SET NX EX 55) — cron kedua langsung return `Locked`. (2) `seen_guids` JSON array (GET/SET, race-prone) → `seen_guids_set` Redis native SET (SADD/SMEMBERS, atomic per-item). Lock dilepas setelah SADD selesai, sebelum kirim notif. (2026-05-06).
- **Push kategori terlalu sempit** — banyak headline forex/macro/econ-data jatuh ke kategori `news` karena keyword terbatas. Fix: pisahkan keyword ke `api/_push_keywords.js` (prefix `_`, tidak dihitung sebagai serverless function). Diperluas signifikan di semua kategori + hapus keyword false-positive (`record high/low`, `all-time high/low` dari MARKET_MOVING karena mislabel econ-data; `jordan` dari MACRO karena SNB governor sudah ganti ke Schlegel + collision dengan negara Jordan; `trade deficit/surplus` dari GEOPOLITICAL karena GEOPOLITICAL dicek lebih dulu sehingga data rilis salah dapat emoji). (2026-05-06).
- **Push notif flooding saat app dibuka + tidak ada notif saat app ditutup** — 3 bug sekaligus: (1) `seenGuids` di SW tersimpan di memori, hilang saat SW di-restart → saat app dibuka, semua artikel terlihat "baru" → flooding. (2) `checkForNewItems()` tidak cek `visibilityState` → tetap kirim browser notification meski app sedang terbuka & visible. (3) `requestNotif()` silent-catch error push subscription → user lihat toast "Aktif ✓" padahal subscription ke server tidak tersimpan, sehingga server tidak bisa kirim push saat app ditutup. Fix sw.js: `seenGuids` dipersist ke Cache Storage (`daun-merah-state` / `/sw-seen-guids`, max 200 GUID); `checkForNewItems()` cek `hasVisible` via `clients.matchAll` — skip browser notification jika ada client visible; `CHECK_NOW` menerima `guids` dari halaman agar sync sebelum fetch. Fix index.html: `startAutoRefresh()` kirim `guids` dengan `CHECK_NOW`; `requestNotif()` selalu unsubscribe + subscribe ulang agar subscription segar; catch block tampilkan toast "Notifikasi Terbatas ⚠" dengan pesan error spesifik (bukan toast sukses palsu). Fix admin.js: (4) stale subscription HDEL menggunakan key format salah (`base64.slice(80)`) berbeda dengan yang disimpan `subscribe.js` (`sha256(endpoint)`) → stale subs tidak pernah dibersihkan; fix: tambah `subKey()` dengan SHA-256 (sama dengan subscribe.js) + perbaiki loop `HGETALL` dari index `i=1` ke `i=0` agar iterasi benar. (2026-05-12).
- **Tambah tab TEKNIKAL** — Trader butuh reference chart dan catatan bias MTF tanpa buka app terpisah. Fix: tambah tab `TEK` baru (urutan ke-10) dengan: (1) TradingView Advanced Chart embed (pair selector 8 pasang + TF selector D1/H4/H1/M15, load lazy via script `s3.tradingview.com/tv.js`, tema dark, timezone Asia/Jakarta, hide side toolbar); (2) MTF Bias table — 4 timeframe × 3 toggle button (▲ Bull / ▼ Bear / → Neut), klik toggle-off, state tersimpan ke `localStorage` per pair, alignment summary otomatis di bawah (BULLISH/BEARISH/MIXED + hitungan TF); (3) textarea Catatan analisa tersimpan per pair di `localStorage`. Data persisted via `tek_bias_v2` + `tek_notes` keys. Terintegrasi di top nav, bottom nav (icon candlestick), dan swipe navigation. (2026-05-12).
- **UI/UX redesign: TAB CAL + FUNDAMENTAL terasa besar dan tidak empatik** — Layout tidak efisien untuk mobile: CB tracker memakai kartu besar 2×4 grid padahal informasi bisa dipadatkan; event card di CAL padding terlalu longgar; Fundamental menampilkan 8 kartu vertikal tanpa overview sehingga trader harus scroll seluruhnya untuk memahami gambaran besar. Fix: (1) **Fundamental** — tambah `Currency Strength Ranking` strip 4×2 grid di atas cards (sorted strongest→weakest, dengan score bar + badge Bull/Bear/Neut); ubah layout cards dari single column ke 2-column grid; kompres card padding + font size tabel; sembunyikan kolom period pada mobile (tampil di desktop). (2) **CAL CB tracker** — ganti dari card grid ke compact table layout: setiap baris = 1 bank sentral dengan kolom [currency | rate+realrate | decision | bias], tinggi menyusut dari ~80px/card ke ~28px/row. (3) **CAL event cards** — kurangi padding dari 12px → 9px, event name dari 13px → 12px, data row padding dari 7px → 5px, semua font label dikecilkan 1px. (4) hapus responsive overrides CB card lama yang tidak relevan. (2026-05-12).
- **Kualitas output ringkasan jelek** — AI output melanggar aturan prompt: membuka dengan kalimat generik ("Pagi ini..."), menggunakan hedging phrases ("dapat mempengaruhi", "dapat memberikan"), kalender hanya list event tanpa skenario beat/miss, XAUUSD section tidak dipisah secara visual. Root cause: (1) prompt dalam satu user message — instruksi tenggelam di bawah data; (2) max_tokens 1500 terlalu pendek; (3) rendering flat tanpa paragraph break atau pemisahan visual FX vs XAUUSD. Fix: (1) split prompt menjadi `system` message (aturan + frasa terlarang eksplisit + tes kalimat) + `user` message (data saja), temperature turun 0.30→0.25, max_tokens naik 1500→2000; (2) `renderArticleSections()` pisah artikel di marker `XAUUSD:` → dua card terpisah, FX card dengan accent merah, XAUUSD card dengan accent gold (#c9a227) + label `XAUUSD`; (3) `articleToHtml()` konversi `\n\n` ke `<p>` paragraf proper (tidak lagi `white-space: pre-line`). (2026-05-18).
- **Analisa XAU bisa menyesatkan: safe haven vs real yield tidak dihubungkan** — AI mengandalkan headline saja tanpa data numerik real yield, sehingga untuk event geopolitik energi (Iran/Hormuz) bisa langsung menyimpulkan "safe haven dominant" tanpa trace second-order: oil naik → inflasi → Fed hawkish → real yield naik → XAU bearish. Ini kebalikan dari safe haven narrative. Fix: (1) inject data real yield USD live dari Redis `real_yields` ke context Call 1 sebagai blok `DATA REAL YIELD USD (LIVE)` — AI kini punya angka USD 10Y nominal, TIPS breakeven, dan real yield aktual, bukan inferensi dari headline; (2) tambah aturan wajib di prompt: untuk geopolitik melibatkan energi/minyak, AI harus trace DUA rantai kausal (oil→inflation→Fed→real yield naik → bearish vs risk aversion→safe haven→bullish) dan bandingkan magnitude keduanya secara eksplisit sebelum menyimpulkan; (3) jika real yield > 2%, safe haven hanya bisa "dominant" jika ada bukti nyata flight-to-safety, bukan hanya narasi geopolitik. (2026-05-18).
- **market-digest.js Vercel 504 + cb_bias race condition** — timeout AI calls lama (20-25s) bisa menyebabkan total eksekusi melewati 25s Vercel limit → 504 Gateway Timeout pada worst case (semua provider gagal dan retry). Race condition: dua invokasi concurrent bisa GET-merge-SET cb_bias secara overlapping → update dari satu invokasi bisa ditimpa. Fix: (1) perketat semua timeout — Cerebras 20s→8s, SambaNova 20s→8s, Groq fallback Call1 25s→14s / Call2 15s→12s / Call3 15s→12s / Call4 15s→8s; (2) hapus SambaNova retry di Call 3 (menghemat 8s worst case); (3) tambah distributed lock `cb_bias_lock` (SET NX EX 10) — hanya satu invokasi yang bisa write cb_bias dalam satu window 10s, sisanya skip (tidak fail, hanya lewat). (2026-05-18).
- **Checklist terlalu ketat dan generik** — sistem binary gate (jika 1 gagal → NO TRADE) terlalu mekanis untuk trading discretionary; item-item penting seperti CB divergence, real yield, COT, dan session timing tidak otomatis terhubung ke data live yang sudah ada di app. Fix (2026-05-27): (1) **Weighted scoring** — gate sections (3 per playbook, bukan semua) bobot ×2, regular sections bobot ×1; hanya parent items dihitung (sub-items tetap interaktif sebagai guidance); (2) **4 verdict zones** — `—` / `NO TRADE` (<50%) / `PERTIMBANGKAN` (50-74%) / `SIAP TRADE` (75-89%) / `ENTRY` (≥90%) menggantikan binary pass/fail; (3) **Structural simplification** SMC/ICT — `postentry`+`antibias` di-merge jadi `DISIPLIN` (6 items); gates dikurangi dari 9 → 3 (hanya `regime_check`, `gate`, `risk`); (4) **Expanded auto-populate** via `_ckAutoSMC`, `_ckAutoMacro`, `_ckAutoEvent`, `_ckAutoMeanRev` — SMC auto-tick f1/f2/f3/f4b/f6/tm1a/tm1b dari cbData+session; Macro auto-tick mm_cb1/mm_cb2/mm_cb4/mm_co2 dari cbData+realYields+cotData; Event-Driven auto-tick ed_ev1/ed_ev3 dari calData; MeanRev auto-tick mr_ra4 dari regimeData; (5) **stopNote teks** diupdate dari bahasa "STOP" ke guidance kontekstual.
- **Cerebras model `qwen-3-235b-a22b-instruct-2507` deprecated 27 Mei 2026** — Call 1 market briefing gagal setiap request → circuit breaker `ai:cerebras` OPEN → app fallback ke Groq. Fix (2026-05-28): ganti `CEREBRAS_MODEL` ke `qwen-3-32b` (Qwen3 32B — masih aktif di Cerebras free tier, tetap kompatibel dengan prefix `/no_think` di prompt). Circuit breaker self-heal otomatis via OPEN→HALF_OPEN→CLOSED cycle (5 menit).
- **Integrasi checklist → jurnal + cross-device sync + playbook info** (2026-05-27): (1) **Checklist → Jurnal** — tombol "→ Buat Jurnal dari Checklist" muncul di sidebar (desktop) dan di atas section list (mobile) saat skor ≥50%; `ckPrefillJurnal()` mengisi form jurnal dengan: pair dari ck selector, direction dari CB bias (base vs quote hawkish level), dan thesis teks yang merangkum item ✅ checked / ⬜ unchecked per section + metadata playbook+skor+verdict; (2) **Device ID sync** — section "Sinkronisasi Device" di tab PETUNJUK: tampilkan Device ID aktif, tombol COPY (clipboard API, fallback select), dan input "Ganti ke Device ID Lain" dengan validasi `dev_` prefix dan konfirmasi; `ptInitDeviceIdDisplay()` dipanggil saat tab dibuka; (3) **Playbook info ⓘ** — button ⓘ di samping playbook selector; `ckTogglePbInfo()` toggle info box dengan judul + deskripsi per playbook dari `PB_INFO` map (SMC/ICT, Macro Momentum, Event-Driven, Mean Reversion); update otomatis sesuai playbook aktif.

---

## AI Provider Research (2026-05-28) — RESOLVED 2026-06-04

### ✅ Status: Selesai
Call 1 telah di-upgrade ke **SambaNova DeepSeek-V3.2** (akun 2) sebagai primary. Upgrade ini menggantikan pencarian provider yang dimulai setelah Cerebras `qwen-3-235b-a22b-instruct-2507` deprecated 27 Mei 2026.

### State Pipeline Final (Current)
```
Call 1: SambaNova DeepSeek-V3.2 akun 2 (primary)
      → OpenRouter gpt-oss-120b:free (fallback 2, 28s timeout)
      → Groq qwen3-32b (fallback 3, 20s timeout)
      → Template fallback (tidak ada AI)
```
`method` field di response: `sambanova` / `openrouter` / `groq-qwen3` / `fallback`

### Catatan Provider (referensi jika ada masalah di masa depan)

| Provider | Model | Status | Catatan |
|---|---|---|---|
| SambaNova | `DeepSeek-V3.2` | ✅ Primary (sejak 2026-06-04) | Kualitas tinggi, instruction following kuat |
| OpenRouter | `openai/gpt-oss-120b:free` | Fallback 2 | ~19s/400t, kadang timeout 28s |
| Groq | `qwen/qwen3-32b` | Fallback 3 | Rate limit per-model, kadang gagal |
| Groq | `llama-3.3-70b-versatile` | Fallback terakhir | Selalu berhasil, kualitas lebih rendah |

---

## Known Issues (P1-P3, belum difix)

### P1 — Risiko akurasi/keamanan modal
- **Push subscription key collision** — ~~sudah difix 2026-05-12~~ (SHA-256 via `subKey()`).
- **CB rates stale** — `api/cb-status.js` data ECB/BOE/RBA/RBNZ kemungkinan sudah ada meeting baru. Update manual diperlukan setelah setiap meeting. **Last updated 2026-05-05** (semua 8 CB sudah diverifikasi via API + web search).
- **Real yields stale** — `api/real-yields.js` data EUR `as_of` 2026-01-15, sekarang Apr 2026 = ~100 hari. Flag stale lebih visible di UI.

### P2 — Robustness
- **Groq calls error isolation** — Call 1/2/3 sequential. Jika Call 1 timeout, 2 dan 3 skip. Tidak ada partial response handling.
- **Service Worker update flow** — tidak ada skipWaiting dengan client notification, tidak ada cache versioning berfungsi.

### P3 — Polish
- **Checklist state per-pair** — `ckState` shared semua pair. Manual items (rc5, gates teknikal) carry over saat ganti pair.
- **Journal N+1 query** — ZRANGE + GET per-id = 51 Redis roundtrips untuk 50 entries. Gunakan MGET.
- **COT column parsing tidak validated** — kolom 4-9 assumed, tidak ada sanity check.
- **CB rates meeting metadata** — `CB_FALLBACK.last_meeting` perlu update manual setelah setiap meeting; UI sekarang menampilkan warning jika >45 hari, tapi data tetap perlu diisi manual.
- **Real yields inflation expectation** — EUR (as_of 2026-01-15), CAD (2026-01-29), CHF (2025-12-12) sudah >90 hari. UI sekarang menampilkan `(lama)` tapi nilai tidak berubah sampai di-update manual di `api/real-yields.js`.

### Fixed (sudah resolved)
- ✅ P1: `_ratelimit.js` INCR+EXPIRE race → SET NX EX + INCR (2026-04-27)
- ✅ P1: `subscribe.js` base64 slice collision → SHA-256 full hex (2026-04-27)
- ✅ P2: `digest_history` GET-push-SET race → LPUSH/LTRIM atomic (2026-04-27)
- ✅ P2: `feeds.js` rssMemCache module-level var → Redis-only (2026-04-27)
- ✅ P3: `_lastThesis` persist → localStorage (2026-04-27)
- ✅ P3: SOP/Petunjuk stale — step 2.3 sekarang sebut 4 playbook + tambah step 1.5 korelasi (2026-05-04)
- ✅ Informatif: CB meeting stale warning (>45 hari) + real yield stale visible + CB bias timestamp dengan tanggal (2026-05-04)
- ✅ Push duplikat: distributed lock + seen_guids → seen_guids_set (SADD atomic) (2026-05-06)
- ✅ Push kategori: keyword diperluas + false-positive dibersihkan, dipindah ke `api/_push_keywords.js` (2026-05-06)
- ✅ Swipe gesture navigasi tab (touchstart/touchend, threshold 60px horizontal, filter nav/input area) (2026-05-07)
- ✅ Hapus badge sumber "FJ" dari news feed — semua berita dari satu sumber (FinancialJuice), badge tidak informatif (2026-05-07)
- ✅ Countdown Timer tab CAL — kartu countdown + badge '!' di tab header, warning merah <30 menit, interval 30s hanya saat di tab CAL (2026-05-08)
- ✅ Tab FUNDAMENTAL — kartu 2×4 grid per currency, data dari Redis `fundamental:{currency}`, AI analysis Groq 6h cache, tombol manual trigger (2026-05-08)
- ✅ Auto-parse fundamental dari headline RSS — `autoUpdateFundamentals` di `market-digest.js`, regex 3-step: currency prefix → indikator keyword → angka, HSET idempotent (2026-05-08)
- ✅ Auto-detect CB rate decision dari headline — `parseCBDecision`, simpan ke `cb_decisions` Redis, `cb-status.js` override `last_decision/last_bps/last_meeting` dari hardcoded fallback (2026-05-08)
- ✅ Multi-provider AI: Cerebras (Call 1), SambaNova (Call 2–3), Groq (Call 4 + fallback) + Thesis Invalidation Monitor (2026-05-08)
- ✅ XAU/USD ditambahkan ke pair selector JURNAL dan SIZING (2026-05-08)
- ✅ `journal_import` endpoint — bulk import historical trades dengan timestamp asli, auth `x-admin-secret` (2026-05-08)
- ✅ **Self-healing system** — `_circuit_breaker.js` (Redis-backed: CLOSED→OPEN→HALF_OPEN, 3 failures → 5 min pause), `_retry.js` (exponential backoff fetch). Circuit breaker aktif di: `market-digest.js` (Cerebras + SambaNova), `risk-regime.js` (FRED + Stooq). `admin.js` health check kini: auto-clear cache sumber DOWN, Telegram notif saat source recover (2026-05-10)
- ✅ **COT display redesign** — stacked bar (L hijau / S merah = proporsi long:short), label L+value S-value per currency, net + weekly change, AM vs Leveraged group. `fmtAbs` helper inline. `makeRows` sekarang terima 4 param (netKey, changeKey, longKey, shortKey) (2026-05-10)
- ✅ **Fundamental display redesign** — dari 2×4 card grid ke full-width per-currency dengan `<table class="fund-table">` 3 kolom (indicator | value | period). Rate ditampilkan bolder di card header. Layout lebih rapi dan mudah dibaca (2026-05-10)
- ✅ **COT historical storage** — `storeCOTHistory()` di `feeds.js`: fire-and-forget per fetch, lock per reportDate (7d), sorted set `cot_history` rolling 90 hari. Data mulai terkumpul untuk future trend chart (2026-05-10)
- ✅ **Fundamental scoring system** — normalisasi per-currency (bukan absolute cross-currency), `FUND_SCORE_RULES` 20 indikator dengan dir+threshold, `parseIndVal` handles K/% suffix, `scoreInd` returns +1/-1/null. Score = bullish% dari indikator yang terscore. Confidence badge: High(≥7)/Med(≥4)/Low(<4) dari jumlah indikator yang tersedia — CHF dengan 3 indikator tetap bisa score tinggi tapi badge "Low". Value cells berwarna hijau/merah sesuai sinyal per indikator (2026-05-10)
- ✅ **AI Journal Analysis** — tombol "ANALISA AI" di tab JURNAL, memanggil `GET /api/journal?action=analyze`. AI (Groq llama-3.3-70b) analisis semua closed trade: pola menang/kalah, kualitas thesis, kelemahan, rekomendasi konkret. Statistik (win rate, total R, avg R) ditampilkan sebagai stat cards. Cache 1 jam per device. `force=1` untuk refresh. Endpoint digabung ke `journal.js` agar tetap di bawah limit 12 function (2026-05-10)
- ✅ **GOLD_KEYWORDS expansion** — tambah `'iran'` standalone, `'hormuz'`, `'beijing'`, `'china visit'`, `'rare earth'`, `'ofac sanction'`, `'iran oil'` dll. Sebelumnya Iran/Hormuz escalation + Trump-China visit menghasilkan 0 gold matches → AI wajib tulis "sinyal gold tipis". Setelah fix: 12/14 headline relevan match (2026-05-11)
- ✅ P2: cb_bias race condition — distributed lock `SET cb_bias_lock NX EX 10` di `market-digest.js`; semua timeout AI diperketat (Cerebras/SambaNova 8s, Groq fallback 12-14s) mencegah Vercel 504; hapus SambaNova retry Call 3 (2026-05-18)
- ✅ P1: Pip value cross-pair approximation — `calcPipValueUSD` sekarang terima param `rates` (live FX rates dari `sizing_rates` Redis). Cross pairs triangulasi via USD/quote nyata: EUR/JPY → 1000 JPY / USDJPY = USD; GBP/CAD → 10 CAD / USDCAD = USD. Fallback ke approximasi entry price jika rates belum tersedia. Backend: `GET /api/correlations?action=rates` (Yahoo v7/quote, Redis cache 5 menit, stale fallback). Frontend: `fetchSizingRates()` dipanggil di `initSizing()`, localStorage cache 4 jam, error message context-aware (2026-05-18)
- ✅ **Tab CB WATCH** — tab baru antara NEWS dan RINGKASAN (sebelumnya bernama "RISET", diubah karena konten lebih ke pidato + press release). Backend: `GET /api/feeds?type=research`, 6 sumber aktif (FED speeches + FOMC decisions + FEDN analytical notes + ECB press + ECBB blog, semua direct; BIS via rss2json proxy), max 20/sumber total 50, Redis TTL 6h, `?force=1` bypass cache. Frontend: dynamic filter per sumber, badge berwarna, judul clickable + tanggal. (2026-05-19)
- ✅ **Fundamental refresh independen dari digest** — `api/_fundamental_parser.js` (helper, tidak dihitung limit): ekstrak semua parsing logic dari `market-digest.js`. `admin.js` tambah action `fundamental_refresh`: baca 100 headline terbaru dari `news_history` Redis → `autoUpdateFundamentals` tanpa AI call. Tombol refresh di tab FUNDAMENTAL kini panggil `fundamental_refresh` dulu lalu `fundamental_get` — update data dalam detik tanpa perlu trigger full digest. (2026-05-21)
- ✅ **Fundamental scoring: change-based** — `scoreInd` kini terima `prevStr`: jika `previous` ada dan berbeda dari `actual`, scoring = perubahan vs sebelumnya (naik/turun × dir). Fallback ke static threshold jika `previous` belum ada. `IND_DIR` map covers semua known indicators; `guessDir()` infer direction dari keyword untuk dynamic indicators (unemploy→-1, employ/gdp/pmi/confidence→+1 dll). Backend `autoUpdateFundamentals` kini HMGET existing sebelum HSET — simpan `previous` di JSON jika nilai berubah. UI tabel: tampilkan arrow ↑↓ + nilai sebelumnya (`prev X`) di cell nilai. (2026-05-21)
- ✅ **Fundamental parser overhaul** — fix bug: `'australian unemploy'` tidak match "Australian Unemployment" (huruf "n" blocking substring) + CHF sama sekali tidak punya `'switzerland unemploy'`/`'swiss unemploy'`. Solusi: (1) expand `FUND_PREFIX_MAP` dengan adjective forms lengkap (australia→australian, japan→japanese, dll) untuk semua 8 currency; (2) tambah `COUNTRY_STRIP` map untuk dynamic indicator extraction — sekarang ANY rilis ekonomi FJ yang menyebut country/adjective + bernilai angka otomatis tercapture, bukan hanya indikator hardcoded; (3) value extraction prioritas "Actual X%" format FJ; (4) expand `FUND_INDICATOR_MAP` dengan 9 indikator baru (Composite PMI, Current Account, Wage Growth, Building Approvals, Consumer/Business Confidence, dll); (5) `FUND_SCORE_RULES` ditambah 12 rule baru. CHF seed ditambah `Unemployment Rate`. (2026-05-21)
- ✅ **Sizing Calculator overhaul** (2026-05-27): (1) **XAU/USD pip value bug** — diperbaiki: kode sebelumnya return $10/lot (10× salah, pakai forex formula). Fix: special case `XAU/USD` = 0.01 × 100 = $1/lot (100 oz/lot, 1 pip = $0.01); (2) **Dual SL mode** — toggle PIPS/HARGA: mode HARGA input entry + SL price → auto-compute stopPips dengan live pip size hint, mode PIPS seperti sebelumnya; (3) **Direction selector** — toggle LONG/SHORT (visual green/red), mempengaruhi arah harga di R-table dan SL/TP price; (4) **R-table harga** — kolom harga ditambah ke R-table jika entry diisi; baris SL dan TP (sesuai R:R) di-highlight dengan warna; (5) **R:R input** — field Target R:R (default 2), auto-hitung TP price + tampilkan di result; (6) **Pip size label** — info `1 pip = X · pip value = $Y/lot` update dinamis per pair + setelah hitung; (7) **Soft risk warning** — >2% warning kuning (tapi tetap hitung), >5% hard block merah; (8) **Sizing → Jurnal bridge** — tombol `→ BUAT TRADE DI JURNAL` di bawah hasil, `szPrefillJurnal()` switch ke tab jurnal + prefill pair/direction/entry/SL/TP/lots; simpan ke `window._lastSizing`.
- ✅ **Journal improvements** (2026-05-27): (1) **Harga di card** — entry/SL/TP/lots ditampilkan per card dalam satu baris compact (hanya field non-null); (2) **Auto-hitung R actual** — `jnStartClose(id)` lookup entry dari `jnAllEntries`, tampilkan referensi Entry/SL/TP di close form, `jnAutoComputeR()` via `oninput` pada Exit Price: R = dir × (exit − entry) / |entry − stop|; trader bisa override manual; (3) **Clear fields setelah save** — `jnSave()` clear semua field setelah berhasil (entry, stop, target, lots, thesis); (4) **showToast** — semua `alert()` di jurnal diganti `showToast()`; (5) **Expand thesis** — teks >120 char ditampilkan truncated + tombol "lihat semua" yang lookup dari `jnAllEntries` (tanpa passing teks di onclick attribute); (6) **ckPrefillJurnal enhancement** — setelah prefill dari checklist, cek `window._lastSizing` — jika pair cocok, prefill lots/entry/SL/TP dari hasil sizing terakhir.
- ✅ **MT5 Bridge auto-start saat Windows login** (2026-06-01) — `start_bridge.bat`: double-click untuk jalankan manual. `start_bridge_min.vbs`: wrapper yang jalankan .bat dalam kondisi minimized. Shortcut VBS ditaruh di `C:\Users\sam\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\DaunMerah-MT5Bridge.lnk` → bridge otomatis jalan di background setiap Windows login, tanpa perlu buka terminal. Untuk nonaktifkan auto-start: hapus shortcut di folder Startup. Bridge tidak bisa di-host di server (Hugging Face dll) karena `MetaTrader5` Python library Windows-only dan berkomunikasi langsung dengan MT5 terminal via IPC.
- ✅ **Checklist keyboard focus via mouse click** (2026-05-31) — klik item checklist dengan mouse tidak mengupdate `ckFocusIdx`, sehingga `Enter` tetap kena item pertama (atas). Fix: event delegation `document.click` → `.closest('#checklistPanel .ck-item, #checklistPanel .ck-sub')` → set `ckFocusIdx` + toggle `.ck-focused` ke item yang diklik. Sekarang bisa klik item mana saja di posisi mana saja, tekan `Enter` = centang item tersebut. Juga fix bug minor `ckNavClearFocus` yang hanya bersihkan `.ck-item.ck-focused` (tidak `.ck-sub.ck-focused`).
- ✅ **Panel kosong: Dashboard, Checklist, TEK, COT, Fundamental, Petunjuk** (2026-06-02) — Root cause: saat menambahkan fitur Export CSV di tab Jurnal, inner `<div>` ganda membuat tag penutup `</div>` untuk `jnListView` "terpakai" sebagai penutup inner div, sehingga `jurnalPanel` tidak pernah ditutup di DOM. Akibatnya semua panel setelah Jurnal (petunjuk, teknikal, dashboard, COT, fundamental, checklist) menjadi child dari `jurnalPanel`. `hideAllPanels()` menyembunyikan `jurnalPanel` → semua child ikut tersembunyi → layar hitam di Dashboard/Checklist/TEK. Fix: hapus inner `<div style="display:flex;gap:6px;margin-bottom:12px">` yang duplikat, sehingga `</div>` yang ada cukup untuk menutup `jnListView` dan `jurnalPanel` dalam urutan yang benar.

---

## Constraint Absolut

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. **Vercel Hobby: TEPAT 12 serverless functions** — files dengan prefix `_` tidak dihitung
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport, bottom nav di ≤767px
9. Indonesian UI text, English code/comments/variables

---

## CB Rates (Fallback Hardcoded — Live Scrape Mengoverride Otomatis)

File: `api/_cb_rates.js`, object `CB_FALLBACK` (di-`require` oleh `api/cb-status.js` dan `api/admin.js` `fundamentalGetHandler` — lihat Session 40).

`rate` di tabel ini cuma fallback kalau scrape live gagal — angka aktual yang ditampilkan ke user (tab CB Bias *dan* tab FUNDAMENTAL) selalu dari `getLiveCbRates()`, scrape 8 official source dengan Redis cache 6h. `last_meeting`/`last_decision`/`last_bps` tetap perlu update manual karena scraper cuma ambil angka rate, bukan metadata meeting.

| CB | Rate (fallback) | Last Meeting | Decision |
|----|------|-------------|----------|
| Fed | 3.75% | 2026-04-29 | hold |
| ECB | 2.15% | 2026-04-30 | hold |
| BOE | 3.75% | 2026-04-30 | hold |
| BOJ | 0.75% | 2026-04-28 | hold |
| BOC | 2.25% | 2026-04-29 | hold |
| RBA | 4.35% | 2026-05-06 | hike +25bps |
| RBNZ | 2.25% | 2026-04-09 | hold |
| SNB | 0.00% | 2026-03-19 | hold |

> **Last verified:** 2026-05-05. Semua rate dikonfirmasi via official APIs (FRED, ECB API, BoC Valet) + web search.
> **2026-06-23:** ECB fallback (2.15%) sudah ketinggalan — live scrape sudah balik 2.40% (hike 2026-06-17) dan ini yang ditampilkan ke user. Fallback constant di atas dibiarkan beda sengaja sebagai bukti `rate_stale` flag bekerja; update manual fallback ini kapan pun sempat, tidak urgent karena user-facing value sudah benar via live scrape.

---

## FOMC Dates Hardcoded

File: `api/rate-path.js`

2026: May 7, Jun 18, Jul 30, Sep 17, Nov 5, Dec 17
2027: Jan 28, Mar 18 (estimasi — belum dipublikasi Fed, diberi label sebagai estimate)

---

## Inflation Expectations Hardcoded (Update Quarterly)

File: `api/real-yields.js`, object `INFLATION_EXPECTATIONS`

Source: ECB SPF, BoE IAS, BoJ Tankan — cek `as_of` field, update jika > 90 hari.
Updated session 45: EUR→ECB SPF Q2 (Apr 2026), CAD→BoC MPR Apr, AUD→RBA SoMP May, NZD→RBNZ MPS May, CHF→SNB Mar, JPY→Tankan Q1 Mar 28. GBP tetap Feb (IAS Q2 belum publish).

---

## Environment

```
Stack:  Vanilla JS + HTML, Vercel Serverless Functions (Node.js CommonJS), Upstash Redis REST
AI:     Groq llama-3.3-70b-versatile (max 25s Vercel timeout)
Font:   Syne (heading) + DM Mono (body)
Colors: --accent: #c0392b (red), --pink: #f472b6 (jurnal), #60a5fa (petunjuk)
Redis:  Upstash REST — pattern: async function redisCmd(...args) di setiap api/*.js
Env:    GROQ_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
        FRED_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET
```

---

## Research: Free AI Inference API Providers (2026-05-28)

> Context: Production app Vercel serverless, butuh OpenAI-compatible endpoint, use case = generate Indonesian FX briefing ~2000 tokens output. Butuh model yang patuh instruksi kompleks Bahasa Indonesia.
> Benchmark pembanding: **Qwen3-235B-A22B-Instruct** (235B MoE, 22B aktif, top-tier instruction following).

### Tier 1 — Sangat Layak Produksi (Model Besar + Truly Free)

| Provider | Model ID (exact) | Model Size | Context | Max Output | Rate Limit Free | OpenAI-compat | Qwen3-235B? | Catatan |
|----------|-----------------|-----------|---------|------------|-----------------|---------------|-------------|---------|
| **OpenRouter** | `qwen/qwen3-235b-a22b:free` | 235B MoE | 131K | 8,192 | 20 RPM / 200 RPD | Ya (`openrouter.ai/api/v1`) | **Ya** | Model ID lain: `qwen/qwen3-235b-a22b-07-25:free` (262K ctx). Tambah $10 kredit → unlock 1,000 RPD. Rate limit shared antar semua free models. |
| **OpenRouter** | `meta-llama/llama-4-maverick:free` | 17B×128E MoE | 1M | — | 20 RPM / 200 RPD | Ya | Tidak | Top model OpenRouter per May 2026. Instruction following sangat kuat. |
| **OpenRouter** | `deepseek/deepseek-r1:free` | ~671B MoE | 200K | — | 20 RPM / 200 RPD | Ya | Tidak | Reasoning model, output verbose, bisa terlalu panjang untuk briefing. |
| **OpenRouter** | `openai/gpt-oss-120b:free` | 120B | — | — | 20 RPM / 200 RPD | Ya | Tidak | OpenAI open-source 120B, mulai replace Llama 4 Maverick di beberapa slot. |
| **Cerebras** | `qwen-3-235b-instruct` | 235B MoE | 64K (free) / 131K (paid) | — | 30 RPM / ~60K-100K TPM / 1M TPD | Ya (`inference.cerebras.ai/v1`) | **Ya** | Tercepat: ~1,400 tok/s. Truly free, no credit card. **Rekomendasi utama untuk upgrade Call 1.** Context cap 64K di free tier. |
| **Cerebras** | `qwen-3-32b` | 32B | 128K | — | 30 RPM / 1M TPD | Ya | Partial (32B) | Ini yang sudah dipakai app saat ini (post-deprecation fix 2026-05-28). |
| **SambaNova** | `Meta-Llama-3.1-405B-Instruct` | 405B | 128K | — | 10 RPM | Ya (`cloud.sambanova.ai/api`) | Tidak | Truly free (persistent, bukan credit). Llama 405B = model terbesar di free tier mana pun. 129 tok/s di SambaNova hardware RDU. |
| **SambaNova** | `Qwen2.5-72B-Instruct` | 72B | 128K | — | ~20 RPM | Ya | Tidak (Qwen 2.5, bukan 3) | Tersedia di free tier SambaNova. Qwen 2.5 generasi sebelumnya. |
| **Google AI Studio** | `gemini-2.5-flash` | — (proprietary) | 1M | 65,535 | 10 RPM / 500 RPD / 1M TPM | Ya (`generativelanguage.googleapis.com/v1beta/openai/`) | Tidak | Terbaik untuk output panjang (65K max output). Generous context 1M. Data digunakan untuk training di free tier. |
| **Google AI Studio** | `gemini-2.5-flash-lite` | — | 1M | — | 15 RPM / 1,000 RPD | Ya | Tidak | Lebih murah/cepat dari Flash tapi lebih lemah reasoning. |

### Tier 2 — Layak Tapi Ada Keterbatasan

| Provider | Model ID (exact) | Model Size | Context | Rate Limit Free | OpenAI-compat | Catatan |
|----------|-----------------|-----------|---------|-----------------|---------------|---------|
| **Groq** | `qwen/qwen3-32b` | 32B | 128K | 30 RPM / 6K TPM / 1K RPD | Ya (`api.groq.com/openai/v1`) | Qwen3-235B tidak tersedia di Groq. TPM 6K = bottleneck untuk ~2000 token output (hanya 3 req/menit efektif). Llama 4 Maverick deprecated 20 Feb 2026 → diganti `openai/gpt-oss-120b`. |
| **Groq** | `meta-llama/llama-4-scout-17b-16e-instruct` | 17B×16E MoE | 128K | 30 RPM / 30K TPM / 1K RPD | Ya | TPM lebih tinggi (30K vs 6K). Kecil tapi cepat. |
| **Groq** | `llama-3.3-70b-versatile` | 70B | 128K | 30 RPM / 6K TPM / 1K RPD | Ya | Sudah dipakai di app (Call 2,3,4 + fallback). |
| **Nvidia NIM** | `qwen/qwen3-235b-a22b` | 235B MoE | — | 40 RPM / 1,000 req total (credits) | Ya (`integrate.api.nvidia.com/v1`) | **Bukan truly free** — 1,000 inference credits saat signup (habis). Tidak sustainable untuk production. Bagus untuk testing/benchmarking. |
| **Mistral (La Plateforme)** | `mistral-large-latest` | ~123B | 128K | **2 RPM** / 1B TPM | Ya (`api.mistral.ai/v1`) | Free tier "Experiment" tanpa kartu kredit. RPM sangat rendah (2 RPM) = tidak viable produksi. Tapi 1B token/bulan jika RPM tidak jadi masalah. |
| **Mistral (La Plateforme)** | `mistral-medium-latest` | — | 128K | 2 RPM | Ya | Sama, instruksi following lebih lemah dari Large. |

### Tier 3 — Tidak Cocok untuk Use Case Ini

| Provider | Status Free Tier | Masalah | Qwen3-235B? |
|----------|-----------------|---------|-------------|
| **Together AI** | Bukan truly free — $25 signup credit (habis) | Credit model, bukan persistent free. Qwen3-235B tersedia tapi berbayar (`Qwen/Qwen3-235B-A22B-fp8-tput`). | Ya (berbayar) |
| **Fireworks AI** | 10 RPM gratis tanpa payment method | Qwen3-235B tersedia di Fireworks tapi tidak jelas apakah model besar masuk free quota. Primarily pay-per-token. | Ya (berbayar) |
| **Novita AI** | $0.50 trial credit (habis) | Credit model bukan persistent free. Cocok untuk image gen + LLM combo, bukan produksi. | Tidak dikonfirmasi |
| **Hugging Face Inference API** | ~1,000 req/hari, ~50 req/jam | Cold start 30+ detik untuk model besar. 70B+ model sangat terbatas di free tier. Bukan untuk latency-sensitive produksi. | Tidak (70B+ restricted) |
| **Cloudflare Workers AI** | 10,000 Neurons/hari | 70B model konsumsi banyak neurons → effective limit sangat rendah. 8B model cocok, 70B+ tidak viable free tier. | Tidak |

### Ringkasan Rekomendasi untuk Daun Merah

**Strategi terbaik (multi-provider failover):**

1. **Call 1 (Market Briefing)** — Tetap Cerebras `qwen-3-32b` sebagai primary (sudah dipakai). Upgrade kandidat: `qwen-3-235b-instruct` di Cerebras (235B, 1,400 tok/s, sama-sama free) jika ingin lebih baik. Context cap 64K cukup untuk briefing.

2. **Fallback Call 1** — OpenRouter `qwen/qwen3-235b-a22b:free` sebagai fallback sekunder. Context 131K, rate 20 RPM / 200 RPD. Max output 8K cukup untuk briefing 2K token.

3. **Alternative besar** — SambaNova `Meta-Llama-3.1-405B-Instruct` (405B! truly free, 10 RPM). Llama 405B terbukti sangat patuh instruksi kompleks + multilingual.

4. **Paling generous output** — Google Gemini 2.5 Flash (`gemini-2.5-flash`): max output 65K token (vs 8K OpenRouter), context 1M, base_url swap mudah. Tapi data dipakai training Google.

**Perbandingan langsung Qwen3-235B di berbagai provider:**

| Provider | Model ID | Gratis? | Speed | Context Free | Max Output |
|----------|---------|---------|-------|-------------|------------|
| Cerebras | `qwen-3-235b-instruct` | Ya (persistent) | ~1,400 tok/s | 64K | — |
| OpenRouter | `qwen/qwen3-235b-a22b:free` | Ya (persistent) | Medium | 131K | 8,192 |
| OpenRouter | `qwen/qwen3-235b-a22b-07-25:free` | Ya (persistent) | Medium | 262K | — |
| Nvidia NIM | `qwen/qwen3-235b-a22b` | Credits only | Fast | — | — |
| Together AI | `Qwen/Qwen3-235B-A22B-fp8-tput` | Tidak (berbayar) | Fast | 256K | — |
| Fireworks AI | `accounts/fireworks/models/qwen3-235b-a22b` | Tidak (berbayar) | Fast | — | — |

**Env var yang perlu ditambahkan jika expand provider:**
- `CEREBRAS_API_KEY` — sudah ada
- `OPENROUTER_API_KEY` — belum ada (gratis signup)
- `SAMBANOVA_API_KEY` — sudah ada
- `GEMINI_API_KEY` — belum ada (gratis di ai.google.dev)

**Base URLs:**
```
Cerebras:    https://inference.cerebras.ai/v1
OpenRouter:  https://openrouter.ai/api/v1
SambaNova:   https://cloud.sambanova.ai/api/v1
Gemini OAI:  https://generativelanguage.googleapis.com/v1beta/openai/
Groq:        https://api.groq.com/openai/v1
Nvidia NIM:  https://integrate.api.nvidia.com/v1
Mistral:     https://api.mistral.ai/v1
```

---

## Backlog — Data Source Upgrades

✅ Semua item di backlog asli ini sudah selesai — detail lengkap (root cause, implementasi, symbol mapping CME CVOL, status per endpoint) ada di entry changelog masing-masing: **Session 44-46** (GDPNow, TGA/Fed Balance Sheet, Cleveland Fed Inflation Nowcast, CME FedWatch fix, Portfolio VaR, FX Risk Reversals) dan **Session 47** (ScraperAPI Proxy + CME CVOL endpoint baru, 6 pair live).

---
