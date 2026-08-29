# Daun Merah — Inventaris Vendor & Layanan Eksternal

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Inventaris KONDISI-SEKARANG semua layanan pihak ketiga (infra, data, hosting, dsb).
BOLEH    : Vendor aktif + fungsi + tier gratis/berbayar + env var terkait + hasil evaluasi
           kandidat (diterima/ditolak + alasan singkat + tanggal).
DILARANG : Detail limit/chain provider AI (-> daun_merah_ai.md), cerita proses evaluasi panjang
           (-> changelog daun_merah.md), plan migrasi vendor (-> daun_merah_plan.md).
FORMAT   : Update IN PLACE (bukan append changelog) — baris/tabel vendor diubah langsung +
           catat tanggal perubahan; vendor yang dibuang tetap dicatat singkat sebagai DITOLAK.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-07-11 (session 157)
> **Tujuan dokumen:** daftar lengkap semua layanan pihak ketiga yang dipakai app ini — siapa, buat apa, gratis/berbayar, dan env var mana yang terkait. Untuk detail pemakaian AI secara spesifik (limit, frekuensi, fallback), lihat [daun_merah_ai.md](daun_merah_ai.md).

---

## 1. Infrastruktur Inti

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **Vercel** | Hosting serverless functions (`api/*.js`) + static frontend + 1 cron bawaan (`gdpnow`) | Hobby (gratis) | — |
| **GitHub Actions** | Cron scheduler pengganti — dipindah dari `vercel.json` karena Vercel Hobby plan tidak menjamin >1 cron/hari jalan konsisten (lihat §2) | Gratis (public repo) | `secrets.CRON_SECRET` (GitHub Secrets) |
| **Upstash Redis (akun 1, utama)** | Database cache utama — REST API (bukan koneksi TCP langsung); dipakai HAMPIR SEMUA endpoint (`api/*.js`) untuk cache, circuit breaker state, jatah harian AI, journal/sizing, gate AATAS. **2026-08-27:** rate limit counter dipindah ke akun 2 (di bawah) supaya tidak rebutan kuota dengan fitur kritikal ini | Free tier | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Upstash Redis (akun 2, rate limit)** | Akun kedua, dibuat 2026-08-27 karena command bulanan akun 1 mepet kuota free tier (326K/500K per catatan `admin.js`). Rate limit counter (`api/_ratelimit.js`, jalan di HAMPIR SEMUA endpoint publik = kontributor command terbesar) dipindah ke sini, terisolasi dari fitur lain. Fail-open tetap berlaku kalau akun ini down | Free tier | `UPSTASH2_REDIS_REST_URL`, `UPSTASH2_REDIS_REST_TOKEN` |
| **Railway** | VPS daemon `vps/daemon.js` (heartbeat, streaming candle Deriv WS, alert berita/harga real-time, scheduler cadangan market-digest/ohlcv_sync, cron auto-entry) — lihat `vps/README-deploy.md` | **Aktif, tapi awasi (2026-08-20, Session 323):** sempat down 2 hari (2026-08-18/19) dengan pesan deploy "free plan wajib Serverless", lalu hidup sendiri lagi tanpa perubahan setting — penyebab pulihnya belum dikonfirmasi (dugaan: siklus kredit $1/bulan reset). Render dicoba sebagai alternatif, GAGAL di verifikasi kartu (sama seperti Oracle dulu) — panduan migrasi tetap tersimpan di `vps/README-deploy.md` §0 sebagai cadangan kalau Railway mati lagi. Kalau pola mati berulang tiap bulan, pertimbangkan upgrade Railway berbayar (~$5/bulan) | `UPSTASH_REDIS_REST_URL/TOKEN`, `DERIV_APP_ID`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN/CHAT_ID`, `VAPID_PUBLIC/PRIVATE_KEY` — daftar lengkap di `vps/README-deploy.md` §6 |

### Cron aktif di GitHub Actions (`.github/workflows/`)

| Workflow | Jadwal | Yang dipanggil |
|---|---|---|
| `market-digest.yml` | 07:00, 14:00, 19:30 WIB | Generate Ringkasan Berita penuh + Analisa AI XAU/USD |
| `ohlcv-sync.yml` | Tiap jam | Sinkron candle OHLCV (H1/H4/D1) untuk semua pair terlacak. **Dedup cron (Plan V-2, 2026-07-20):** berjalan paralel dengan Railway daemon Q-6 (menit :05) yang memicu endpoint sama — pemicu kedua dalam window 45 menit jadi no-op (`ohlcv_sync:last_run_at`, pola `_cron_dedup.js`), nol fetch/nol TA-warm |
| `ta-warm.yml` | **Nonaktif** (schedule dimatikan 2026-07-20, Plan V-1) | Pre-warm cache indikator teknikal 8 pair utama — terbukti redundant, `ohlcvSyncHandler` (`api/admin.js`) sudah warm TA cache untuk 8 pair yang sama tiap kali `ohlcv_sync` jalan; `workflow_dispatch` manual tetap ada untuk reaktivasi |
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
| Google AI Studio (Gemini) | `GEMINI_API_KEY` | Free (1.500 RPD) — dipromosikan Plan N (2026-07-18); primary/satu-satunya provider Analisis Fundamental & AI Coach Jurnal sejak 2026-08-12 (lihat catatan SambaNova di bawah) |
| DeepSeek (API resmi) | `DEEPSEEK_API_KEY` | Berbayar dari saldo top-up user (bukan free tier); model `deepseek-v4-flash` (auto-upgrade ke build V4-Flash-0731 sejak 2026-07-31, server-side, harga tak berubah) untuk hampir semua fitur, KECUALI Call 1 Ringkasan Berita yang dipromosikan ke `deepseek-v4-pro` 2026-08-17 (detail chain per-fitur & alasan promosi: `daun_merah_ai.md`); primary/satu-satunya provider hampir semua fitur AI sejak SambaNova diputus (lihat di bawah) |

**DITOLAK/DIPUTUS:** OpenRouter, Cerebras, Groq, Ollama Cloud — semua **kontrak diputus user 2026-07-25**, env var dihapus dari Vercel, kode chain/diagnostik-nya dihapus total dari `api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`. Sebelumnya berstatus "Free (persisten)".

**SambaNova (2 akun, `SAMBANOVA_API_KEY`/`SAMBANOVA_API_KEY_CALL1`) — DIPUTUS KONTRAK TOTAL 2026-08-12.** Root cause: akun 2 diblokir billing SambaNova sendiri — respons API eksplisit "A payment method is required. Add one at https://cloud.sambanova.ai/plans/billing to continue." Ganti API key baru untuk akun 1 & 2 (dicoba live) TIDAK memperbaikinya — keduanya tetap gagal (akun 1: timeout beruntun lalu HTTP 429 rate-limit; akun 2: pesan billing eksplisit yang sama persis walau key sudah diganti), mengindikasikan masalah di level akun/billing, bukan sekadar key kedaluwarsa. Keputusan user: putuskan kontrak daripada terus bergantung ke provider yang mewajibkan pembayaran padahal awalnya dipilih karena free tier. Env var dihapus dari Vercel (Production & Preview), kode chain/circuit/budget-nya dihapus total dari `api/admin.js`, `api/journal.js`, `api/market-digest.js`, `api/_ai_guard.js`. Penggantinya per fitur: Analisis Fundamental & AI Coach Jurnal → Gemini (primary/satu-satunya); semua fitur lain (ohlcv_analyze, Kritikus, pre_entry_check, Sistem Hakim Gate A, Call 1-4 market-digest, Review Posisi Virtual) → DeepSeek (primary/satu-satunya, sudah primary di banyak tempat ini sejak Plan O).

**GLM 5.2 — DITOLAK 2 KALI, dua alasan beda:** (1) via NVIDIA NIM trial (S190/S191) — ToS trial melarang "not in production", BUKAN soal kualitas (malah dicatat "lebih natural" dari model lain saat itu). (2) via API resmi z.ai (dicek 2026-07-29) — ToS resmi (`docs.z.ai/legal-agreement/terms-of-use`) SECARA EKSPLISIT DAN KATEGORIS melarang penggunaan untuk "investment and financial management", "finance, investments", dan "decision-making activities" (Section III.6.a/b, Additional Terms 1.f.iii/iv) — TANPA pengecualian disclaimer/human-oversight. Ini blocker kategoris untuk SELURUH use case Daun Merah (analisa finansial + auto-entry trading decision), bukan cuma satu fitur — jangan evaluasi ulang tanpa z.ai mengubah ToS-nya secara eksplisit.

**Nemotron/NVIDIA NIM diusulkan ulang 2026-08-11, DITOLAK, dicek ulang live 2 sisi:** (1) ToS trial (`assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA API Trial Terms of Service.pdf`) masih sama persis — "may only use the API Service for internal testing and evaluation purposes, not in production"; pembatasannya berbasis TUJUAN pemakaian (nyata vs sekadar uji coba), BUKAN jumlah user — argumen "cuma 1 user" tidak mengubah status "production" di mata ToS ini. (2) Teknis: riwayat tes live proyek ini sendiri (Plan N session 145-147, 2026-07-06/07 & 2026-07-18) sudah gagal — Nemotron 3 Ultra/Super 0/4 & 0/6 percobaan via OpenRouter (kosong/timeout), DAN via NVIDIA NIM langsung format failure (skip section FX total) + latency 20,9-24,1 detik (mepet timeout Vercel 25s). User setuju tidak dipasang, tetap pakai DeepSeek/Gemini di semua fitur.

**Nemotron 3 Ultra diusulkan LAGI 2026-08-25 lewat jalur baru (OpenCode Zen, gateway gratis pihak ketiga) — DITOLAK LAGI, blocker ToS yang SAMA ternyata tetap berlaku.** Sempat diimplementasi live di `api/journal.js` (AI Coach Jurnal, hasil kualitas bagus & cepat ~16s) sebelum ketahuan: dokumentasi resmi OpenCode Zen sendiri menyatakan Nemotron Free tier "**Trial use only — do not submit personal or confidential data**" dan mewajibkan pengguna setuju **NVIDIA API Trial Terms of Service** yang sama persis dengan penolakan 2026-08-11 di atas — OpenCode Zen cuma jadi perantara, bukan lisensi terpisah dari NVIDIA. Data jurnal trading (thesis, catatan personal trader) juga masuk kategori "personal/confidential data" yang eksplisit dilarang. **Pelajaran:** blocker ToS provider melekat ke MODEL-nya (NVIDIA/Nemotron), bukan cuma ke satu jalur akses spesifik (NIM langsung) — ganti gateway/aggregator tidak menghilangkan batasan ToS asli kalau gateway itu sendiri masih mewajibkan persetujuan ToS yang sama. Cek ToS provider ASLI di balik model, bukan cuma ToS gateway-nya, sebelum coba lagi via jalur ketiga manapun (OpenRouter/OpenCode Zen/dst).

---

## 3. Data Makro & Bank Sentral

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **FRED (Federal Reserve Economic Data, St. Louis Fed)** | Sumber data utama seri makro AS (yield, inflasi, GDPNow, labour market rule-based, dll) — dipakai di `real-yields.js`, `risk-regime.js`, `_labour_market.js`, `admin.js`. **Dua jebakan yang sudah menggigit (audit 2026-08-29):** (1) endpoint keyless `fredgraph.csv` **mengabaikan** `sort_order`/`limit` (selalu kirim seri PENUH urut ASCENDING) dan headernya sudah berubah dari `DATE,` jadi `observation_date,` — dua fungsi memakai asumsi lama dan rusak, SUDAH DIPERBAIKI 2026-08-29 — dan parameter pembatas yang BENAR-BENAR dihormati `fredgraph.csv` adalah **`cosd`** (start date), bukan `sort_order`/`limit`: tanpa `cosd`, DTB3 mengirim 300 KB / 18.000+ baris sejak 1954 dan cukup untuk menabrak timeout dari Vercel. Reader tunggalnya sekarang `fetchFredCsvLatest` di `api/_cb_rates.js` — JANGAN bikin salinan kedua, duplikasi itulah yang bikin bug ini terjadi di dua file sekaligus. Header request juga penting: UA telanjang tanpa `Accept` terbukti konsisten gagal dari IP Vercel; (2) yield 10Y non-USD memakai seri OECD BULANAN `IRLTLT01*M156N` yang observasi terakhirnya basi 3-8 bulan | Free (API key wajib untuk endpoint `api.stlouisfed.org`; `fredgraph.csv` tanpa key) | `FRED_API_KEY` |
| **ECB Data API** (`data-api.ecb.europa.eu`) | Yield Eropa + suku bunga acuan ECB | Free, tanpa API key | — |
| **Bank of England (IADB), Bank of Canada (Valet API)** | Suku bunga acuan live GBP & CAD, sumber PRIMER resmi (`_cb_rates.js`). BoE: seri `IUDBEDR` lewat IADB CSV — **wajib follow redirect**, endpoint balas 302 dulu. Menggantikan scraping halaman HTML BoE yang mati (audit 2026-08-29) | Free, tanpa key | — |
| **BIS Data Portal** (`stats.bis.org`, dataflow `WS_CBPOL`) | Suku bunga acuan JPY/AUD/NZD/CHF — SATU request SDMX untuk empat currency sekaligus, membawa tanggal observasi. Dipakai sejak 2026-08-29 menggantikan 4 scraper situs resmi yang semuanya mati (BoJ 404, RBA HTTP 403, RBNZ HTTP 403, SNB 0 match regex). **USD & EUR SENGAJA tidak diambil dari sini** walau tersedia: BIS memakai MIDPOINT target range Fed (3.625) sedangkan app ini konsisten memakai batas ATAS `DFEDTARU` (3.75), dan BIS XM (2.25) beda definisi dari `MRR_FR` API resmi ECB (2.40) — beda DEFINISI, bukan beda kesegaran, jadi sumber primer menang. Kalau `_parseBisCbpol` throw karena kolom hilang, artinya BIS mengubah format SDMX-nya | Free, tanpa key | — |
| **CFTC** (`cftc.gov`) | Commitment of Traders (COT) — positioning institusional | Free, file publik | — |
| **CME Group** (`cmegroup.com`) | CVOL (implied volatility FX, `correlations.js`) — MASIH JALAN. Lihat catatan FedWatch di bawah tabel | CVOL: free tapi **diblokir Akamai WAF untuk IP Vercel** → wajib proxy ScraperAPI (lihat §5) | — |
| **Barchart OnDemand** | Fallback sumber risk-reversal FX kalau CME CVOL gagal | **Enterprise berbayar** (dikonfirmasi Session 47 — bukan free seperti awalnya dikira dari komentar kode "free signup"). Path tetap ada di kode tapi **tidak dipakai** — `BARCHART_API_KEY` kemungkinan besar tidak pernah di-set | `BARCHART_API_KEY` |
| **Polymarket (Gamma API)** | Data prediction market untuk sinyal sentimen | Free, publik | — |

**Catatan CME FedWatch (dihapus 2026-07-24):** FedWatch Tool + ZQ settlement + Quote API (`rate-path.js`) dihapus — seluruh keluarga hidden API `CmeWS/mvc/*` dipensiunkan CME (dikonfirmasi 404 terstruktur di 3 endpoint sekaligus + dokumentasi resmi CME: FedWatch sekarang produk berbayar EOD/Intraday API, mulai ~$25/bulan). `rate-path.js` sekarang langsung ke fallback FRED T-bill / heuristik, tidak coba CME sama sekali lagi.

---

## 4. Data Harga & Teknikal

| Vendor | Fungsi | Tier |
|---|---|---|
| **Lightweight Charts v4** (`unpkg.com/lightweight-charts@4`) | Library chart candlestick di frontend (tab Teknikal) — menggantikan TradingView embed sejak Session 215 (2026-07-22). MIT license, dibuat TradingView sendiri, tanpa watermark, tanpa delay data. Data aktual dari Deriv WebSocket (real-time per detik) | Free, MIT, tanpa API key |
| **Yahoo Finance** (`query1.finance.yahoo.com`, tidak resmi/unofficial) | Sumber utama candle OHLCV semua pair FX + XAU/USD | Free, tanpa API key (endpoint publik tidak resmi) |
| **Binance API** | Fallback harga (PAXG untuk proxy XAU, dan referensi crypto) — dicoba PERTAMA untuk XAU/USD sebelum Twelve Data (di dalam `fetchYahooOhlcv1h`) | Free, publik |
| **Deriv API** (`ws.derivws.com`, WebSocket) | **PRIMARY** candle OHLCV untuk **14 pair FX** (Plan P, 2026-07-18) — broker-grade, streaming-capable, dicoba SEBELUM Yahoo di `_ohlcv_fetch.js` (`fetchDerivCandles`), dipakai `ohlcv_sync` (cron, sekuensial dengan budget guard 20s) & `refreshOhlcvFromYahoo` (on-demand). Symbol format `frxEURUSD` dst (mapping di kode). **XAU/USD (GC=F) SENGAJA TIDAK ikut** — GC=F harga futures vs `frxXAUUSD` spot (level beda beberapa dolar), dan GC=F volume dipakai analisis sedangkan Deriv tanpa volume. Aturan satu-array-satu-sumber: Deriv sukses → pakai penuh, gagal → jatuh ke Yahoo penuh (tidak pernah campur candle lintas sumber) | Free, tanpa akun untuk data publik. Lihat catatan app_id di bawah tabel |
| **Twelve Data** (`api.twelvedata.com`) | Fallback candle OHLCV ketiga (setelah Deriv untuk 14 pair FX, atau kedua untuk XAU/USD) kalau Yahoo (dan Binance khusus XAU) gagal/0 candle (M1, audit 2026-07-18) — mengatasi titik-gagal-tunggal Yahoo di `_ohlcv_fetch.js` (`fetchFallbackCandles`), dipakai `ohlcv_sync` (cron) & `refreshOhlcvFromYahoo` (on-demand tab Analisa). Symbol format `EUR/USD` (beda dari Yahoo `EURUSD=X`, mapping di kode). Source aktual per-pair per-run ditandai di Redis `ohlcv:<symbol>:source` (`'deriv'|'yahoo'|'twelvedata'`), dibaca `?action=ohlcv_dashboard`. Counter `yahoo_fail_streak` + alert Telegram kalau 3x sync beruntun Yahoo down sistemik (cooldown 6 jam) | Lihat catatan credit di bawah tabel |
| **Stooq** | Data VIX/index tambahan (`risk-regime.js`) | Free, publik |
| **TradingView** (`economic-calendar.tradingview.com`) | Kalender ekonomi — sumber SATU-SATUNYA untuk tab CAL sejak fallback ForexFactory dihapus 2026-07-13 (lihat §6); kalau gagal, `api/calendar.js` jatuh ke stale-cache Redis, bukan ganti sumber | Free, endpoint publik tidak resmi |

**Evaluasi objektif Deriv vs Yahoo vs kandidat baru (S265, 2026-07-30):** dicek langsung ke Redis produksi + live candle 3 sumber (bukan asumsi) — Deriv DIPERTAHANKAN sebagai primary 14 pair FX, tidak ada bukti perlu ganti. Divergensi Deriv-vs-Yahoo empiris cuma rata-rata 1-4 pip (192 candle H1 x 3 pair), Deriv malah lebih kontinu antar-candle dari Yahoo. Dua kejadian SL riil yang diperiksa (EUR/USD Fed shock, EUR/GBP whipsaw) sama-sama breach SL jauh di luar margin divergensi manapun — tidak ada skenario ganti sumber yang mengubah hasil. Root cause insiden GC=F (basis blowout futures-vs-spot, §262-263) tidak berlaku ke FX spot (tidak ada expiry kontrak). Metodologi lengkap: `daun_merah.md` Session 265. Kandidat baru dicek & **DITOLAK**: OANDA v20 (broker-grade tapi tidak terbukti lebih akurat dari Deriv, butuh registrasi akun demo tambahan), TrueFX & Dukascopy (data ECN kualitas terbaik tapi archive/tick-collector oriented, bukan live REST/WS — butuh infra ingest baru tanpa masalah nyata yang dipecahkan), Twelve Data sebagai primary (limit 8 req/menit tidak cukup untuk peran real-time Deriv — tetap fallback #2 seperti sekarang).

**Catatan app_id Deriv:** app_id sementara pakai publik `1089` (lihat catatan risiko di `_ohlcv_fetch.js`) — app_id dedicated yang didaftarkan user via `developers.deriv.com` (portal baru) TERNYATA tidak kompatibel dengan endpoint `ws.derivws.com` (server balas `InvalidAppID`, diverifikasi live terhadap 3 titik server). Root cause: Deriv punya 2 sistem developer terpisah yang app_id-nya belum/tidak saling kompatibel; jalur self-service untuk app_id lama yang kompatibel belum ditemukan (semua link "API developer" di akun Deriv mengarah ke portal baru). **Action item user:** cari cara dapat app_id dedicated yang kompatibel dengan `ws.derivws.com` (kemungkinan perlu hubungi `api-support@deriv.com` langsung), lalu ganti env var `DERIV_APP_ID` — TIDAK perlu ubah kode.

**Catatan credit Twelve Data:** Free tier 800 credit/hari, 8 request/menit (diverifikasi 2026-07-18 via docs.twelvedata.com — 1 credit/request). **RESOLVED (S262, 2026-07-29):** `TWELVEDATA_API_KEY` akhirnya di-set di Vercel (Production + Preview) via `vercel env add` + redeploy manual (`vercel redeploy`) supaya langsung aktif — diverifikasi lewat `vercel env ls`. Sebelumnya sempat action item terbuka lama (sejak Session 186) karena bikin fallback OHLCV no-op diam-diam; sekarang juga jadi dependency guard korroborasi GC=F (`_corroborateGoldTransitions`, `api/admin.js`, insiden GC=F:1785244513683 — lihat `daun_merah.md` Session 262) yang mencegah status tp/sl palsu akibat basis blowout futures-vs-spot mendekati expiry kontrak — guard itu sekarang aktif. Catatan historis: `.env.local` sempat berisi key dengan nama BEDA (`TWELVE_DATA_API_KEY`, ada underscore ekstra) yang tidak akan pernah terbaca kode — value-nya yang dipakai untuk daftar ke Vercel, dengan nama yang benar.

---

## 5. Proxy

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **ScraperAPI** | Proxy residential IP — dipakai KHUSUS untuk fetch CVOL (CME) karena CME memblokir IP datacenter Vercel lewat Akamai WAF. Sebelum 2026-07-24 juga dipakai untuk FedWatch/ZQ/Quote (`rate-path.js`) — sudah dihapus, lihat baris CME Group di atas | Free tier permanen: 1.000 credit/bulan, maks 5 concurrent connection. Lihat §9 untuk riwayat pemakaian & audit biaya | `SCRAPER_API_KEY` |
| **r.jina.ai (Jina AI Reader)** | **Fallback KEDUA** khusus CVOL (`correlations.js`) — dicoba HANYA kalau ScraperAPI/direct gagal. Fetch dari IP Jina sendiri (tidak masuk daftar blokir WAF Akamai/CME). Ditambahkan 2026-07-28 saat ScraperAPI outage — bukan pengganti permanen, bukan proxy resmi (produk aslinya "web reader" buat LLM, dipakai di sini secara tidak konvensional karena responsnya untuk endpoint JSON kebetulan passthrough apa adanya). Kalau dua-duanya gagal, fitur RR graceful degradation ke `available:false`, bukan crash | Gratis, tanpa signup/key, tapi TANPA SLA — berpotensi rate-limit kalau volume naik (aman untuk kasus ini, RR cuma refresh 1x/jam) | (tidak ada — no key) |

---

## 6. Berita & RSS

| Vendor | Fungsi | Tier |
|---|---|---|
| **FinancialJuice** (`financialjuice.com`) | Sumber RSS berita utama untuk headline real-time | Free, RSS publik |
| **ForexFactory data mirror** (`nfs.faireconomy.media`) | Dulu fallback kalender tab CAL saat TradingView gagal (`api/calendar.js`) — **dihapus 2026-07-13** atas permintaan user (swap sumber saat outage bikin UX membingungkan; TradingView jarang benar-benar down, dan kalau gagal sekarang langsung stale-cache, bukan ganti sumber). Masih dipakai sebagai sumber KALENDAR SATU-SATUNYA di `api/market-digest.js` untuk konteks AI Ringkasan — fitur berbeda, tidak disentuh | Free, publik |
| **InvestingLive** (`investinglive.com`) | RSS berita tambahan | Free, publik |
| **ActionForex** (`actionforex.com`) | RSS analisis teknikal tambahan | Free, publik |
| **FXSSI** (`fxssi.com`) | Sumber sentimen retail (current ratio). **Halaman gratis memuat 12 pair** (diverifikasi live 2026-08-29): AUD/JPY, AUD/USD, EUR/AUD, EUR/JPY, EUR/USD, GBP/JPY, GBP/USD, NZD/USD, USD/CAD, USD/CHF, USD/JPY, XAU/USD. `RETAIL_PAIRS` di `api/feeds.js` menyaringnya jadi 8 — 4 pair (AUD/JPY, EUR/AUD, EUR/JPY, GBP/JPY) dibuang filter. **Ditinjau ulang 2026-08-29: TIDAK layak diambil** — tidak satu pun dari keempatnya ditradingkan auto-entry, jadi nilainya nol sekarang; jangan diangkat lagi sebagai "sisa ekstraksi". Tidak memuat AUD/NZD, EUR/GBP, CHF/JPY (3 pair auto-entry) — itu batas vendor, bukan filter | Free, publik |
| **ING Think** (`think.ing.com`) | RSS riset makro tambahan | Free, publik |
| **rss2json** (`api.rss2json.com`) | Proxy konversi RSS→JSON untuk feed yang butuh parsing khusus | Free, publik |
| **Federal Reserve, ECB, BIS press release feeds** | RSS resmi rilis kebijakan bank sentral | Free, publik |
| **NBER** (`nber.org/rss/new.xml`) | RSS working paper ekonomi terbaru (SEMUA bidang, disaring `RESEARCH_RELEVANCE_RE` di kode ke FX/makro/LLM-trading) — ditambahkan 2026-08-15 supaya tab Artikel juga menampilkan riset dari PENELITI, bukan cuma institusi bank sentral di atas | Free, RSS publik, full-text PDF gratis |
| **RePEc / NEP-IFN** (`nep.repec.org/rss/nep-ifn.rss.xml`) | Digest mingguan working paper kanal "International Finance", dikurasi editor manusia RePEc (tidak perlu filter tambahan di kode) — ditambahkan 2026-08-15 | Free, RSS publik, mayoritas link PDF gratis |
| **Scopus (Elsevier Search API)** (`api.elsevier.com/content/search/scopus`) | Metadata bibliografi paper peer-review (judul/penulis/jurnal/link) — **BUKAN abstrak**. Ditambahkan 2026-08-15, query 2 topik (FX/makro + LLM-trading), 6 jam cache bareng sumber lain di atas. **Batas ToS Elsevier (diverifikasi live via `dev.elsevier.com`, 2026-08-15): akses key non-komersial DILARANG menampilkan abstrak di forum publik** — kode di `api/feeds.js` (`parseScopusEntries`) didesain sengaja TIDAK PERNAH meminta/membaca field abstrak sama sekali, hanya field yang "generally permissible" (judul, penulis, nama jurnal, link). Kalau suatu saat ada kebutuhan menampilkan abstrak/full-text, WAJIB nego lisensi komersial terpisah ke Elsevier dulu — jangan asumsikan key yang ada sekarang cukup. **RESOLVED (2026-08-15, sesi sama):** `vercel env add SCOPUS1_API_KEY` (Production+Preview) + `vercel redeploy` — diverifikasi live: `Scopus-FX`/`Scopus-LLM` masing-masing 10 item tampil normal di `financial-feed-app.vercel.app`. | Free tier developer — `X-RateLimit-Limit: 20000` terkonfirmasi live dari header respons key produksi (2026-08-15), periode reset persis (harian/mingguan) belum terverifikasi pasti dari satu kali baca header. Pemakaian aktual di sini ~8 request/hari (2 query x 6 hasil, refresh 6 jam) — aman jauh di bawah 20.000 baik itu limitnya harian maupun mingguan. |

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
SAMBANOVA_API_KEY
SAMBANOVA_API_KEY_CALL1
GEMINI_API_KEY       # Dipromosikan Plan N (2026-07-18) — Google AI Studio (Gemini)
DEEPSEEK_API_KEY     # Plan O (2026-07-18) — DeepSeek API resmi, PRIMARY Ringkasan/Analisa/Pre-Entry Check, berbayar dari saldo top-up user
# OPENROUTER_API_KEY / CEREBRAS_API_KEY / GROQ_API_KEY / OLLAMA_API_KEY — DIHAPUS dari Vercel 2026-07-25 (kontrak diputus user)

# Data
FRED_API_KEY
BARCHART_API_KEY
SCRAPER_API_KEY
TWELVEDATA_API_KEY   # RESOLVED S262 (2026-07-29) — di-set Production+Preview, dependency guard korroborasi GC=F, lihat §4
DERIV_APP_ID         # Plan P (2026-07-18) — sementara app_id publik "1089", ganti begitu dapat app_id dedicated yang kompatibel (lihat §4)
SCOPUS1_API_KEY      # Ditambahkan 2026-08-15 — Scopus Search API, lihat §6 untuk batas ToS (metadata saja, TANPA abstrak)
SCOPUS_API_KEY       # Fallback nama var kalau SCOPUS1_API_KEY suatu saat di-rename di Vercel dashboard

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

## 9. Status Berbayar — riwayat & koreksi (2026-07-11, update 2026-07-28)

**Ringkas kondisi terkini:** kemungkinan besar TIDAK ADA vendor berbayar aktif dipakai — ScraperAPI di jatah gratisnya (lihat riwayat konsumsi di bawah), Barchart path mati/tidak dipakai. Satu-satunya cara memastikan 100% adalah cek langsung dashboard billing ScraperAPI.

### ScraperAPI — free tier permanen, bukan trial

Dikonfirmasi dari [docs.scraperapi.com](https://docs.scraperapi.com/resources/faq/plans-and-billing): free tier-nya permanen (bukan trial 7 hari saja) — **1.000 credit/bulan, maks 5 concurrent connection**, tanpa kartu kredit.

- Klaim versi lama ("ScraperAPI satu-satunya vendor berbayar murni") **TIDAK AKURAT** — dikoreksi 2026-07-11 setelah user menanyakan limit persisnya.
- Catatan lama Session 47 ("Free tier: 5.000 credits/bulan") kemungkinan mengacu ke jatah trial 7-hari (5.000 credit), bukan jatah bulanan permanen (1.000 credit) — beda sumber informasi, tapi kesimpulan praktisnya sama: pemakaian jauh di bawah kapasitas gratis manapun yang berlaku.

**Riwayat konsumsi & insiden:**

1. **2026-07-11 — pemakaian di luar proyeksi awal.** Dashboard ScraperAPI: 417 dari 1.000 credit terpakai dalam ~5 hari (renew 25 hari lagi) — proyeksi ~2.500 credit/bulan kalau dibiarkan, 2,5x lebih tinggi dari jatah gratis, bakal habis di hari ke-12 dari siklus 30 hari. **Root cause:** fitur Risk Reversal/CVOL (`correlations.js`) menghabiskan 6 credit sekaligus per refresh (1 per pair paralel: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, XAU/USD), cache TTL cuma 1 jam.
2. **Fix v1 (sempat diterapkan):** `RR_CACHE_TTL` 3600 (1h) → 21600 (6h) — motong konsumsi CVOL dari maks 144/hari jadi maks 24/hari, tapi mengorbankan freshness (skew jadi bisa 6 jam basi).
3. **Fix v2 (final, session 157 lanjutan 5):** endpoint CME `/services/cvol` ternyata support multi-symbol dalam satu request (`?symbol=EUVL,GBVL,JPVL,...`) — dikonfirmasi via live test user, balikin array per symbol dalam 1 response. Kode di-refactor: 6 request terpisah (6 credit/refresh) → 1 request batch (1 credit/refresh), cost turun 6x. `RR_CACHE_TTL` dibalikin ke 3600 (1 jam) — freshness sama seperti semula, tapi biayanya SAMA seperti versi 6-jam (1 credit × 24 refresh/hari = 24 credit/hari). Freshness dan hemat kuota dua-duanya tercapai, bukan trade-off.
   - `correlations.js`: fetch CVOL di-batch, mapping balik ke pair lewat field `symbol` di tiap entry response (bukan posisi array — CME tidak menjamin urutan).
   - `market-digest.js`: penanda umur `[data X jam lalu]` + perluasan CATATAN STALENESS tetap dipertahankan — praktik baik ini valid di TTL manapun, cuma sekarang biasanya menunjukkan "<1 jam" bukan "beberapa jam".
   - Margin budget dihitung ulang: 1 jam TTL + FedWatch (rate-path.js, TTL 4h terpisah) = ~900 credit/bulan skenario TERBURUK (trafik nonstop 24 jam), realistisnya jauh di bawah itu (~14 jam aktif/hari dari data dashboard).
   - Diverifikasi: simulasi parsing pakai data JSON ASLI dari live test user (termasuk kasus symbol tak dikenal & skew rusak, tidak crash) + test suite 190/190 tetap hijau.
4. **2026-07-28 — outage TLS cert expired.** Insiden resmi status.scraperapi.com, sudah dimitigasi via fallback r.jina.ai (§5). Kronologi & alasan teknis lengkap: `daun_merah.md` Session 249. Sempat dicek ganti vendor (ScrapingAnt 10.000 credit/bulan, Scrapfly 1.000 credit/bulan, Scrape.do, ScrapingBee, Crawlbase, WebScrapingAPI, Zyte) — tidak ada yang lebih baik: semua kompetitor menerapkan pengali 25-30x credit untuk fitur residential-proxy/anti-WAF yang justru dibutuhkan buat lolos Akamai, jadi kapasitas efektifnya untuk kasus ini malah lebih kecil dari ScraperAPI. Catatan: akun Scrapfly yang sempat dibuat user punya toggle "PAG" (Pay As you Go) auto-billing overage aktif by default — potensi risiko tagihan tak terduga kalau jadi dipakai tanpa dimatikan dulu.

### Barchart OnDemand — berbayar (dikoreksi dari catatan lama "free")

Versi sebelumnya salah menyebut ini "free (signup manual)" berdasarkan komentar kode. Catatan Session 47 (`daun_merah.md` baris 3113) sudah mengonfirmasi lebih dulu: "Barchart OnDemand: dikonfirmasi enterprise berbayar (bukan free) — path tetap ada di kode tapi tidak digunakan." `BARCHART_API_KEY` kemungkinan besar tidak pernah benar-benar di-set di Vercel karena itu.

**Fallback kalau ScraperAPI limit/tidak tersedia:** fetch langsung ke CME tanpa proxy (`cmeFetch()` di `rate-path.js`/`correlations.js`), yang kemungkinan besar diblokir WAF — fitur FedWatch/CVOL otomatis jatuh ke sumber fallback berikutnya (Barchart untuk CVOL — tapi ini juga tidak aktif) atau kosong dengan graceful degradation, bukan crash.

---

## 10. Higgsfield (asset kreatif — icon/foto/video/ppt, BUKAN bagian app produksi)

- **Fungsi:** generator gambar/video/audio AI (MCP tool), dipakai sekali S221 (2026-07-23) untuk bikin asset visual identitas (`asset/` lokal, gitignored, bukan bagian repo/deploy).
- **Bukan "gratis 1 hari"** seperti awalnya dikira user — ini **trial 3 hari** (mulai otomatis saat MCP connect, berakhir 2026-07-26 07:09 UTC), jatah 100 credit MCP-only. Setelah trial habis, **kartu auto-charge** subscription Plus bulanan kecuali dibatalkan duluan (via widget billing Higgsfield, bilang "cancel auto-renewal").
- **Status:** DITOLAK lanjut (S221) — credit habis di tengah jalan (100 → 4), user pilih stop bukan top-up. Kalau mau dipakai lagi nanti, ini bukan vendor produksi app, jadi tidak ada dampak ke `api/_ai_guard.js` atau chain AI produksi.
- **Harga top-up (kalau mau lanjut nanti):** one-time 500 credit $26 / 1000 credit $49 / 2000 credit $95 / 4000 credit $190 (semua ~44% off harga normal), atau plan Ultra $99/bulan = 3000 credit.
- **Gotcha biaya:** preflight `get_cost` TANPA parameter `resolution` eksplisit mengestimasi di resolusi default (1K) yang jauh lebih murah dari 2K yang benar-benar dipakai — 8 gambar 2K + beberapa gambar lain menghabiskan ~96 credit padahal preflight awal (1K) memperkirakan low single-digit per gambar. Video (Kling 3.0, Seedance) jauh lebih mahal lagi: ~10-16 credit per klip 5-8 detik bahkan di resolusi rendah.

---

## 11. Catatan Operasional (M4, audit 2026-07-18 — tanpa kode)

- **Upstash Redis:** cek dashboard KEDUA akun (command count & storage) tiap awal bulan. Sejak 2026-08-27 beban dipecah 2 akun (rate limit terpisah dari cache/circuit breaker/jatah AI/journal) supaya satu fitur boros tidak mengunci semua fitur lain serentak — tapi masing-masing akun tetap free tier dan bisa kena limit sendiri-sendiri.
- **SambaNova (2026-08-12):** kontrak diputus total — akun diblokir billing SambaNova sendiri, mekanisme top-up yang sebelumnya tidak dikonfirmasi (session 163-165) ternyata memang jadi masalah nyata; ganti key tidak memperbaiki. Provider ini sudah tidak dipakai fitur manapun, tidak perlu dicek lagi.
- **Deprecation model AI** (DeepSeek-V3.2 dkk): kalau provider menghapus/mengganti model, gejalanya error tertelan diam-diam oleh fallback chain (tidak crash, tapi kualitas turun) — pantau badge method di UI Ringkasan secara berkala, jangan asumsikan diam = sehat.
- **GitHub Actions email warning:** kalau GitHub mengirim email "workflow disabled due to inactivity" untuk repo ini, JANGAN diabaikan — itu tandanya `keepalive.yml` (§1) gagal jalan atau baru dipasang setelah repo sudah kena nonaktifkan; re-enable manual via tab Actions.

---

## 12. Data yang Belum Diekstrak Maksimal (audit 2026-08-29, S336)

Daftar data yang **sudah tersedia gratis dari vendor yang sudah dipakai** tapi belum ditarik/dipakai. Bukan usulan vendor baru — murni sisa ekstraksi dari kontrak yang sudah ada.

| Vendor | Sudah diambil | Belum diambil (tersedia, gratis) |
|---|---|---|
| **FXSSI** | 8 pair | ~~4 pair lagi di respons yang sama~~ — **DICORET 2026-08-29**: keempatnya (AUD/JPY, EUR/AUD, EUR/JPY, GBP/JPY) tidak ditradingkan auto-entry, jadi mengambilnya nol nilai. "Tersedia gratis" bukan alasan cukup untuk mengambil |
| **FRED** | VIXCLS, BAMLH0A0HYM2, GDPNOW, DGS2/5/10/30, T10YIE, EXPINF10YR, WALCL, WDTGAL, RRPONTSYD, DFEDTARU + 8 seri labour market | Seri makro berdampak-FX yang belum dipakai sama sekali: `NFCI` (Chicago Fed financial conditions), `STLFSI4` (financial stress), `T5YIFR` (5y5y forward inflation — patokan ekspektasi inflasi jangka panjang yang dipakai bank sentral), `DTWEXBGS` (broad dollar index, alternatif DXY yang bobotnya lebih representatif), `BAA10Y` (credit spread). **Koreksi 2026-08-29 (sesi sama):** `DFII10` sempat masuk daftar ini, DICORET — secara definisi FRED `T10YIE = DGS10 - DFII10`, jadi real yield USD yang sekarang dihitung (`DGS10 - T10YIE`) SUDAH persis sama dengan `DFII10`; diverifikasi angka 2026-08-27: 4.67 - 2.33 = 2.34 = DFII10. Nol tambahan informasi. `NFCI`/`STLFSI4` juga sebagian besar TUMPANG TINDIH dengan VIX + HY OAS yang sudah ditarik (keduanya indeks komposit yang salah satu inputnya justru spread kredit & volatilitas) — nilainya marjinal, jangan diprioritaskan |
| **Kalender ekonomi (TradingView)** | `actual_raw`/`forecast_raw`/`previous_raw` sudah ditarik dan disimpan ke `calendar_surprise_v1` + `surprise_log:v1` (cap 300) | Dipakai HANYA sebagai gate skip auto-entry sesaat setelah rilis. Belum ada **indeks kejutan ekonomi per currency** (agregat surprise 4-12 minggu = sinyal makro arah, bukan cuma pemicu skip). Komentar `vps/daemon.js` sendiri menyebut ini "fondasi Opsi B (z-score per event)" yang belum dibangun |
| **Cache `real_yields`** | Nominal + ekspektasi inflasi + real yield untuk 8 currency | Baris `DIFFERENTIAL SUKU BUNGA` di prompt AI **di-hardcode hanya untuk EUR/USD**. Empat pair auto-entry lain (XAU/USD, AUD/NZD, EUR/GBP, CHF/JPY) punya data kedua kaki di cache yang sama tapi tidak pernah dapat baris differential — padahal differential suku bunga adalah driver FX paling standar |
| **COT CFTC** (`financial_lof.htm`) | Asset Manager + Leveraged Funds (long/short/net/perubahan), Open Interest, % of OI, persentil 3 tahun via Socrata | Kategori Dealer/Intermediary, Other Reportables, dan Non-Reportable (proxy ritel di futures) ada di blok teks yang SAMA, belum diparse. Nilainya belum tentu tinggi — catat sebagai opsi, bukan rekomendasi |
| **Twelve Data** | Fallback OHLCV tier-3 (praktis nyaris tidak pernah terpakai karena Deriv+Yahoo jarang gagal bersamaan) | Kuota 800 credit/hari nyaris tidak terpakai. Kalau nanti butuh riwayat harga lebih panjang atau data yang Deriv/Yahoo tidak punya, kuota ini sudah ada dan gratis |
| **Deriv / Yahoo / Twelve Data (kedalaman riwayat)** | `ohlcv:<sym>:1h` 120 candle (~5 hari), `:4h` 60, `:1d` 135 (~6 bulan) | Batas ini **dipilih sendiri**, bukan batas vendor: `fetchDerivCandles` meminta `count: 140` untuk 1d supaya "konsisten dengan window Yahoo `range=6mo`". Deriv `ticks_history` melayani sampai 5.000 candle, Yahoo melayani `range=2y/5y/max`, Twelve Data `outputsize` sampai 5.000. Konsekuensi nyata: label rezim volatilitas di `_pair_context.js` dihitung dari ATR14 H1 atas window ~5 hari saja, jadi "bergejolak vs tenang" itu relatif terhadap seminggu terakhir, bukan terhadap distribusi historis yang bermakna. Riwayat 1-2 tahun akan membuka persentil ATR yang sah, perbandingan volatilitas realized vs implied (data CVOL sudah ada), jarak ke MA 200-hari, dan musiman |

