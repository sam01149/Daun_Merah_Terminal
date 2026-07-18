# Daun Merah — Inventaris Vendor & Layanan Eksternal

> **Dibuat:** 2026-07-11 (session 157)
> **Tujuan dokumen:** daftar lengkap semua layanan pihak ketiga yang dipakai app ini — siapa, buat apa, gratis/berbayar, dan env var mana yang terkait. Untuk detail pemakaian AI secara spesifik (limit, frekuensi, fallback), lihat [daun_merah_ai.md](daun_merah_ai.md).

---

## 1. Infrastruktur Inti

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **Vercel** | Hosting serverless functions (`api/*.js`) + static frontend + 1 cron bawaan (`gdpnow`) | Hobby (gratis) | — |
| **GitHub Actions** | Cron scheduler pengganti — dipindah dari `vercel.json` karena Vercel Hobby plan tidak menjamin >1 cron/hari jalan konsisten (lihat §2) | Gratis (public repo) | `secrets.CRON_SECRET` (GitHub Secrets) |
| **Upstash Redis** | Database cache utama — REST API (bukan koneksi TCP langsung), dipakai HAMPIR SEMUA endpoint (`api/*.js`) untuk cache, rate limit counter, circuit breaker state, jatah harian AI | Free tier | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

### Cron aktif di GitHub Actions (`.github/workflows/`)

| Workflow | Jadwal | Yang dipanggil |
|---|---|---|
| `market-digest.yml` | 07:00, 14:00, 19:30 WIB | Generate Ringkasan Berita penuh + Analisa AI XAU/USD |
| `ohlcv-sync.yml` | Tiap jam | Sinkron candle OHLCV (H1/H4/D1) untuk semua pair terlacak |
| `ta-warm.yml` | Tiap jam | Pre-warm cache indikator teknikal 8 pair utama |
| `retail-sentiment-warm.yml` | Tiap 15 menit | Paksa refresh cache retail sentiment (COT-adjacent) |
| `btc-sync.yml` | **Nonaktif** (schedule dimatikan 2026-06-22) | Riset BTC ML — diasingkan ke folder gitignored, `workflow_dispatch` manual saja kalau mau diaktifkan lagi |
| `btc-backfill.yml` | Manual (`workflow_dispatch`) | Backfill data historis BTC (riset, sama nasibnya dengan `btc-sync.yml`) |
| `test-deribit.yml` | Manual (`workflow_dispatch`) | Diagnostik koneksi Deribit API (BTC options), bukan fitur produksi |
| `keepalive.yml` | 1x/bulan (tgl 1, 03:00 UTC) | Commit heartbeat (`.github/heartbeat.txt`) supaya GitHub tidak menonaktifkan otomatis semua scheduled workflow di atas — GitHub mematikan cron di repo publik yang 60 hari tanpa aktivitas commit (M2, audit 2026-07-18). **Kalau app dipensiunkan, matikan workflow ini manual** (hapus/nonaktifkan `.github/workflows/keepalive.yml`) — jangan biarkan heartbeat palsu terus commit ke repo mati. |

Semua workflow di atas autentikasi ke `api/*.js` lewat header `x-cron-secret`, dicocokkan ke `CRON_SECRET` di kode (`api/_app_key.js`, `api/_ratelimit.js` — whitelist otomatis, tidak kena rate limit per-IP).

---

## 2. AI Providers (ringkas — detail penuh di [daun_merah_ai.md](daun_merah_ai.md))

| Provider | Env var | Tier |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | Free (persisten) |
| Cerebras | `CEREBRAS_API_KEY` | Free (persisten) |
| SambaNova (2 akun terpisah) | `SAMBANOVA_API_KEY`, `SAMBANOVA_API_KEY_CALL1` | Free (persisten) |
| Groq | `GROQ_API_KEY` | Free (persisten) |
| Ollama Cloud | `OLLAMA_API_KEY` | Free |
| Google AI Studio (Gemini) | `GEMINI_API_KEY` | Free (1.500 RPD) — dipromosikan Plan N (2026-07-18) |

---

## 3. Data Makro & Bank Sentral

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **FRED (Federal Reserve Economic Data, St. Louis Fed)** | Sumber data utama seri makro AS (yield, inflasi, GDPNow, labour market rule-based, dll) — dipakai di `real-yields.js`, `risk-regime.js`, `_labour_market.js`, `admin.js` | Free (API key wajib) | `FRED_API_KEY` |
| **ECB Data API** (`data-api.ecb.europa.eu`) | Yield Eropa + suku bunga acuan ECB | Free, tanpa API key | — |
| **Bank of England, Bank of Japan, Bank of Canada, RBA, RBNZ, SNB** (situs resmi masing-masing) | Suku bunga acuan live per bank sentral non-Fed/ECB (`_cb_rates.js`) | Free, scraping halaman publik | — |
| **CFTC** (`cftc.gov`) | Commitment of Traders (COT) — positioning institusional | Free, file publik | — |
| **CME Group** (`cmegroup.com`) | FedWatch Tool (probabilitas keputusan FOMC) + CVOL (implied volatility FX) — via `rate-path.js`, `correlations.js` | Free, tapi **diblokir Akamai WAF untuk IP Vercel** → wajib lewat proxy ScraperAPI (lihat §5) | — |
| **Barchart OnDemand** | Fallback sumber risk-reversal FX kalau CME CVOL gagal | **Enterprise berbayar** (dikonfirmasi Session 47 — bukan free seperti awalnya dikira dari komentar kode "free signup"). Path tetap ada di kode tapi **tidak dipakai** — `BARCHART_API_KEY` kemungkinan besar tidak pernah di-set | `BARCHART_API_KEY` |
| **Polymarket (Gamma API)** | Data prediction market untuk sinyal sentimen | Free, publik | — |

---

## 4. Data Harga & Teknikal

| Vendor | Fungsi | Tier |
|---|---|---|
| **Yahoo Finance** (`query1.finance.yahoo.com`, tidak resmi/unofficial) | Sumber utama candle OHLCV semua pair FX + XAU/USD | Free, tanpa API key (endpoint publik tidak resmi) |
| **Binance API** | Fallback harga (PAXG untuk proxy XAU, dan referensi crypto) — dicoba PERTAMA untuk XAU/USD sebelum Twelve Data (di dalam `fetchYahooOhlcv1h`) | Free, publik |
| **Deriv API** (`ws.derivws.com`, WebSocket) | **PRIMARY** candle OHLCV untuk **14 pair FX** (Plan P, 2026-07-18) — broker-grade, streaming-capable, dicoba SEBELUM Yahoo di `_ohlcv_fetch.js` (`fetchDerivCandles`), dipakai `ohlcv_sync` (cron, sekuensial dengan budget guard 20s) & `refreshOhlcvFromYahoo` (on-demand). Symbol format `frxEURUSD` dst (mapping di kode). **XAU/USD (GC=F) SENGAJA TIDAK ikut** — GC=F harga futures vs `frxXAUUSD` spot (level beda beberapa dolar), dan GC=F volume dipakai analisis sedangkan Deriv tanpa volume. Aturan satu-array-satu-sumber: Deriv sukses → pakai penuh, gagal → jatuh ke Yahoo penuh (tidak pernah campur candle lintas sumber). | Free, tanpa akun untuk data publik. **App_id sementara pakai publik `1089`** (lihat catatan risiko di `_ohlcv_fetch.js`) — app_id dedicated yang didaftarkan user via `developers.deriv.com` (portal baru) TERNYATA tidak kompatibel dengan endpoint `ws.derivws.com` (server balas `InvalidAppID`, diverifikasi live terhadap 3 titik server). Root cause: Deriv punya 2 sistem developer terpisah yang app_id-nya belum/tidak saling kompatibel; jalur self-service untuk app_id lama yang kompatibel belum ditemukan (semua link "API developer" di akun Deriv mengarah ke portal baru). **Action item user:** cari cara dapat app_id dedicated yang kompatibel dengan `ws.derivws.com` (kemungkinan perlu hubungi `api-support@deriv.com` langsung), lalu ganti env var `DERIV_APP_ID` — TIDAK perlu ubah kode. |
| **Twelve Data** (`api.twelvedata.com`) | Fallback candle OHLCV ketiga (setelah Deriv untuk 14 pair FX, atau kedua untuk XAU/USD) kalau Yahoo (dan Binance khusus XAU) gagal/0 candle (M1, audit 2026-07-18) — mengatasi titik-gagal-tunggal Yahoo di `_ohlcv_fetch.js` (`fetchFallbackCandles`), dipakai `ohlcv_sync` (cron) & `refreshOhlcvFromYahoo` (on-demand tab Analisa). Symbol format `EUR/USD` (beda dari Yahoo `EURUSD=X`, mapping di kode). Source aktual per-pair per-run ditandai di Redis `ohlcv:<symbol>:source` (`'deriv'|'yahoo'|'twelvedata'`), dibaca `?action=ohlcv_dashboard`. Counter `yahoo_fail_streak` + alert Telegram kalau 3x sync beruntun Yahoo down sistemik (cooldown 6 jam). | **Free tier: 800 credit/hari, 8 request/menit** (diverifikasi 2026-07-18 via docs.twelvedata.com — 1 credit/request). **Action item user MASIH TERBUKA (dicek ulang S186 lanjutan malam):** `TWELVEDATA_API_KEY` belum ada sama sekali di Vercel production — fallback ini masih no-op diam-diam. Catatan tambahan: `.env.local` sempat berisi key dengan nama BEDA (`TWELVE_DATA_API_KEY`, ada underscore ekstra) yang tidak akan pernah terbaca kode — kalau didaftarkan, pastikan nama persis `TWELVEDATA_API_KEY` |
| **Stooq** | Data VIX/index tambahan (`risk-regime.js`) | Free, publik |
| **TradingView** (`economic-calendar.tradingview.com`) | Kalender ekonomi — sumber SATU-SATUNYA untuk tab CAL sejak fallback ForexFactory dihapus 2026-07-13 (lihat §6); kalau gagal, `api/calendar.js` jatuh ke stale-cache Redis, bukan ganti sumber | Free, endpoint publik tidak resmi |

---

## 5. Proxy

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **ScraperAPI** | Proxy residential IP — dipakai KHUSUS untuk fetch CME (FedWatch + CVOL) karena CME memblokir IP datacenter Vercel lewat Akamai WAF | **Free tier permanen: 1.000 credit/bulan, maks 5 concurrent connection** (dikonfirmasi dari docs.scraperapi.com — bukan trial sekali pakai). Pemakaian aktual app ini ~120-180 request/bulan (dicatat Session 47) = ~12-18% dari jatah gratis, request-nya standar tanpa parameter premium (`render`, geotargeting) yang biasanya menambah biaya credit. **Kemungkinan besar TIDAK benar-benar berbayar** — lihat §9 untuk detail | `SCRAPER_API_KEY` |

---

## 6. Berita & RSS

| Vendor | Fungsi | Tier |
|---|---|---|
| **FinancialJuice** (`financialjuice.com`) | Sumber RSS berita utama untuk headline real-time | Free, RSS publik |
| **ForexFactory data mirror** (`nfs.faireconomy.media`) | Dulu fallback kalender tab CAL saat TradingView gagal (`api/calendar.js`) — **dihapus 2026-07-13** atas permintaan user (swap sumber saat outage bikin UX membingungkan; TradingView jarang benar-benar down, dan kalau gagal sekarang langsung stale-cache, bukan ganti sumber). Masih dipakai sebagai sumber KALENDAR SATU-SATUNYA di `api/market-digest.js` untuk konteks AI Ringkasan — fitur berbeda, tidak disentuh | Free, publik |
| **InvestingLive** (`investinglive.com`) | RSS berita tambahan | Free, publik |
| **ActionForex** (`actionforex.com`) | RSS analisis teknikal tambahan | Free, publik |
| **FXSSI** (`fxssi.com`) | Sumber sentimen retail (current ratio) | Free, publik |
| **ING Think** (`think.ing.com`) | RSS riset makro tambahan | Free, publik |
| **rss2json** (`api.rss2json.com`) | Proxy konversi RSS→JSON untuk feed yang butuh parsing khusus | Free, publik |
| **Federal Reserve, ECB, BIS press release feeds** | RSS resmi rilis kebijakan bank sentral | Free, publik |

---

## 7. Notifikasi

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **Telegram Bot API** | Kirim notifikasi/alert ke channel/chat admin | Free | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| **Web Push (VAPID)** | Push notification browser (thesis alert, dll) — standar Web Push, bukan layanan pihak ketiga berbayar, tapi butuh key pair VAPID sendiri | Free (protokol terbuka) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

---

## 8. Ringkasan Env Var (semua vendor)

```
# AI Providers
OPENROUTER_API_KEY
CEREBRAS_API_KEY
SAMBANOVA_API_KEY
SAMBANOVA_API_KEY_CALL1
GROQ_API_KEY
OLLAMA_API_KEY
GEMINI_API_KEY       # Dipromosikan Plan N (2026-07-18) — Google AI Studio (Gemini)
DEEPSEEK_API_KEY     # Plan O (2026-07-18) — DeepSeek API resmi, PRIMARY Ringkasan/Analisa/Pre-Entry Check, berbayar dari saldo top-up user

# Data
FRED_API_KEY
BARCHART_API_KEY
SCRAPER_API_KEY
TWELVEDATA_API_KEY   # M1 2026-07-18 — belum di-set user, fallback no-op sampai ada
DERIV_APP_ID         # Plan P (2026-07-18) — sementara app_id publik "1089", ganti begitu dapat app_id dedicated yang kompatibel (lihat §4)

# Infra
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CRON_SECRET
APP_KEY

# Notifikasi
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

**Catatan:** daftar env var di `daun_merah.md § Environment` (blok lama) sudah tidak lengkap — tidak menyebut `SCRAPER_API_KEY`, `BARCHART_API_KEY`, `APP_KEY`, atau env var AI selain `GROQ_API_KEY`. File ini (§8 di atas) adalah daftar terlengkap saat ini, disusun langsung dari grep `process.env.*` di seluruh `api/*.js`.

---

## 9. Status Berbayar — Dikoreksi (2026-07-11)

**Klaim versi sebelumnya ("ScraperAPI satu-satunya vendor berbayar murni") TIDAK AKURAT** — dikoreksi setelah user menanyakan limit persisnya dan ketemu catatan Session 47 yang sebelumnya terlewat.

### ScraperAPI — kemungkinan besar sebenarnya GRATIS
Dikonfirmasi dari [docs.scraperapi.com](https://docs.scraperapi.com/resources/faq/plans-and-billing): free tier-nya **permanen (bukan trial 7 hari saja)** — **1.000 credit/bulan, maks 5 concurrent connection**, tanpa kartu kredit. Pemakaian aktual app ini (dicatat Session 47): **~120-180 request/bulan** untuk fetch CME (FedWatch + CVOL), request standar tanpa parameter premium (`render=true`, geotargeting) yang biasanya menambah biaya credit per request — jadi 1 request ≈ 1 credit. Itu cuma **12-18% dari jatah 1.000/bulan**, jauh di bawah batas.

**Kesimpulan:** kecuali akun yang dipakai memang sudah di-upgrade manual ke plan berbayar (Hobby $49/bulan dst — tidak ada bukti di kode untuk ini), app ini **tidak perlu bayar apa-apa untuk ScraperAPI**. Catatan lama di `daun_merah.md` Session 47 ("Free tier: 5.000 credits/bulan") kemungkinan mengacu ke jatah trial 7-hari (5.000 credit), bukan jatah bulanan permanen (1.000 credit) — beda sumber informasi, tapi kesimpulan praktisnya sama: pemakaian aktual jauh di bawah kapasitas gratis manapun yang berlaku.

### Barchart OnDemand — dikoreksi jadi berbayar
Versi sebelumnya salah menyebut ini "free (signup manual)" berdasarkan komentar kode. Catatan Session 47 (`daun_merah.md` baris 3113) sudah mengonfirmasi lebih dulu: **"Barchart OnDemand: dikonfirmasi enterprise berbayar (bukan free) — path tetap ada di kode tapi tidak digunakan."** `BARCHART_API_KEY` kemungkinan besar tidak pernah benar-benar di-set di Vercel karena itu.

### Kesimpulan baru
Berdasarkan bukti yang ada, **kemungkinan besar TIDAK ADA vendor berbayar yang aktif dipakai** di app ini sama sekali — ScraperAPI di jatah gratisnya, Barchart path mati/tidak dipakai. Satu-satunya cara memastikan 100% adalah cek langsung dashboard billing ScraperAPI. Kalau suatu saat ScraperAPI kena limit/tidak tersedia, fallback-nya adalah fetch langsung ke CME tanpa proxy (`cmeFetch()` di `rate-path.js`/`correlations.js`), yang kemungkinan besar diblokir WAF — fitur FedWatch/CVOL otomatis jatuh ke sumber fallback berikutnya (Barchart untuk CVOL — tapi ini juga tidak aktif) atau kosong dengan graceful degradation, bukan crash.

### Update 2026-07-11 — Pemakaian aktual ternyata di luar proyeksi, sudah diperbaiki

User cek langsung dashboard ScraperAPI: **417 dari 1.000 credit terpakai dalam ~5 hari** (renew 25 hari lagi) — proyeksi ~2.500 credit/bulan kalau dibiarkan, **2,5x lebih tinggi dari jatah gratis**, bakal habis di hari ke-12 dari siklus 30 hari.

**Root cause:** fitur Risk Reversal/CVOL (`correlations.js`, action `risk-reversal`) — bukan FedWatch — yang jadi biang keladinya. Tiap refresh menghabiskan **6 credit sekaligus** (1 per pair: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, XAU/USD, semua paralel), dengan cache TTL cuma **1 jam** — kalau panel korelasi/vol ramai dikunjungi tiap jam, itu bisa sampai 144 credit/hari sendirian. Estimasi lama di Session 47 ("~120-180 request/bulan") ditulis SEBELUM fitur CVOL 6-pair ditambahkan di sesi yang sama, jadi tidak sempat diperbarui.

**Sempat dicek juga:** ganti vendor (ScrapingAnt 10.000 credit/bulan, Scrapfly 1.000 credit/bulan, Scrape.do, ScrapingBee, Crawlbase, WebScrapingAPI, Zyte) — **tidak ada yang lebih baik**. Semua kompetitor menerapkan pengali 25-30x credit untuk fitur residential-proxy/anti-WAF yang justru dibutuhkan buat lolos Akamai (yang dipakai CME) — begitu dihitung ulang, kapasitas efektifnya untuk kasus spesifik ini malah lebih kecil dari ScraperAPI (ScraperAPI unik: base rate 1 credit-nya SUDAH residential-grade tanpa toggle premium). Catatan tambahan: akun Scrapfly yang sempat dibuat user punya toggle **"PAG" (Pay As you Go) auto-billing overage aktif by default** — potensi risiko tagihan tak terduga kalau jadi dipakai tanpa dimatikan dulu.

**Fix v1 (sempat diterapkan):** `RR_CACHE_TTL` 3600 (1h) → 21600 (6h) — motong konsumsi CVOL dari maks 144/hari jadi maks 24/hari, tapi mengorbankan freshness (skew jadi bisa 6 jam basi).

**Fix v2 (final, session 157 lanjutan 5) — solusi yang lebih baik, ditemukan setelah user menguji langsung:** ternyata endpoint CME `/services/cvol` **support multi-symbol dalam satu request** (`?symbol=EUVL,GBVL,JPVL,...` comma-separated) — dikonfirmasi via live test user pakai `SCRAPER_API_KEY` sendiri, balikin array berisi entry per symbol dalam 1 response. Kode di-refactor: 6 request terpisah (6 credit/refresh) → **1 request batch (1 credit/refresh)**, cost turun 6x. Ini memungkinkan `RR_CACHE_TTL` **dibalikin ke 3600 (1 jam)** — freshness sama seperti semula, tapi biayanya SAMA seperti versi 6-jam (1 credit × 24 refresh/hari = 24 credit/hari, identik dengan 6 credit × 4 refresh/hari versi lama). Freshness dan hemat kuota dua-duanya tercapai, bukan trade-off.
- `correlations.js`: fetch CVOL di-batch, mapping balik ke pair lewat field `symbol` di tiap entry response (bukan posisi array — CME tidak menjamin urutan).
- `market-digest.js`: penanda umur `[data X jam lalu]` + perluasan CATATAN STALENESS (dari fix v1) **tetap dipertahankan** — praktik baik ini valid di TTL manapun, cuma sekarang biasanya menunjukkan "<1 jam" bukan "beberapa jam".
- Margin budget dihitung ulang: 1 jam TTL + FedWatch (rate-path.js, TTL 4h terpisah) = ~900 credit/bulan skenario TERBURUK (trafik nonstop 24 jam), realistisnya jauh di bawah itu berdasarkan pola trafik riil (~14 jam aktif/hari dari data dashboard).
- Diverifikasi: simulasi parsing pakai data JSON ASLI dari live test user (termasuk kasus symbol tak dikenal & skew rusak, tidak crash) + test suite 190/190 tetap hijau.

---

## 10. Catatan Operasional (M4, audit 2026-07-18 — tanpa kode)

- **Upstash Redis:** cek dashboard (command count & storage) tiap awal bulan — semua endpoint bergantung pada Redis ini, kalau limit free tier kena, seluruh app (cache, rate limit, circuit breaker, jatah AI harian) ikut terganggu serentak.
- **Billing SambaNova:** mekanisme top-up TIDAK dikonfirmasi (lihat riwayat session 163-165, `daun_merah.md`) — kalau Ringkasan mendadak sering jatuh ke fallback chain, cek akun SambaNova langsung DULU sebelum mengubah kode.
- **Deprecation model AI** (DeepSeek-V3.2 dkk): kalau provider menghapus/mengganti model, gejalanya error tertelan diam-diam oleh fallback chain (tidak crash, tapi kualitas turun) — pantau badge method di UI Ringkasan secara berkala, jangan asumsikan diam = sehat.
- **GitHub Actions email warning:** kalau GitHub mengirim email "workflow disabled due to inactivity" untuk repo ini, JANGAN diabaikan — itu tandanya `keepalive.yml` (§1) gagal jalan atau baru dipasang setelah repo sudah kena nonaktifkan; re-enable manual via tab Actions.
