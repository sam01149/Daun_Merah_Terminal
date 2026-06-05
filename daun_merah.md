# Daun Merah — Project Context (Full Reference)

> **Last updated:** 2026-06-05 (session 50 — Risk Reversal fix, CB bias word-boundary, DAILY PULSE panel)
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
| RSS sumber berita | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) — satu-satunya sumber (Nitter dihapus 2026-05-05) |
| Kalender ekonomi | ForexFactory XML (`nfs.faireconomy.media`) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| Icon | `icon.svg` — dual-leaf loop design (bear merah + bull teal) |
| PWA | `manifest.json` → `icon.svg`, `sw.js` — Service Worker push |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `SAMBANOVA_API_KEY`
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

## CB Rates (Update Manual Setelah Meeting)

File: `api/cb-status.js`, object `CB_DATA`

| CB | Rate | Last Meeting | Decision |
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
> **Note 2026-06-04:** ECB meeting ~Jun 5, BOE ~Jun 19, SNB ~Jun 19. Live scraper `cb-status.js` akan otomatis update rate jika berubah. Fallback metadata (`last_meeting`, `last_decision`) perlu update manual setelah meeting.

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

### ✅ Selesai (Session 44–46)
- **GDPNow Atlanta Fed** — `api/admin.js` `?action=gdpnow` + auto-refresh dari `fundamental_refresh`. ✓
- **TGA + Fed Balance Sheet** — `api/real-yields.js` via FRED WALCL + FiscalData API. ✓
- **Cleveland Fed Inflation Nowcast** — FRED `EXPINF10YR` sebagai fallback TIPS di `real-yields.js`. ✓
- **CME FedWatch Fix** — V1/V2 URL + CME Quote API ZQ (step 2b) di `rate-path.js`. T-bill fallback tetap berjalan. ✓
- **Portfolio VaR** — `jnRenderVaR()` di tab JURNAL, variance-covariance, ATR-based. ✓
- **FX Risk Reversals** — `action=risk-reversal` di correlations.js. CME CVOL → Barchart (jika `BARCHART_API_KEY` tersedia). UI di FUNDAMENTAL tab. ✓

### ✅ Selesai Session 47 (2026-06-05) — ScraperAPI Proxy + CME CVOL endpoint baru

**Root cause:** CME Group memblokir IP data center Vercel (AWS/GCP) via Akamai/Cloudflare WAF. ScraperAPI menggunakan residential IPs yang tidak diblokir.

**Implementasi:**
- `api/rate-path.js` — tambah helper `cmeFetch(targetUrl, directHeaders, timeoutMs)`: jika `SCRAPER_API_KEY` tersedia, route semua CME fetch (FedWatch V1/V2, ZQ settlement, ZQ quote) melalui `api.scraperapi.com?api_key=...&url=...`. Timeout dinaikkan 8-10s → 15s untuk kompensasi latency proxy.
- `api/correlations.js` — CME CVOL fetch juga lewat ScraperAPI jika key tersedia.
- **Env var baru:** `SCRAPER_API_KEY` — sudah ditambah ke Vercel (2026-06-05). Free tier: 5,000 credits, ~1 credit/request.

**Status per endpoint (2026-06-05):**
- ✅ CME FedWatch (`rate-path.js`) — ScraperAPI proxy aktif untuk semua CME calls
- ✅ CME CVOL Risk Reversals — **6 pair live**: EUR/USD (EUVL), GBP/USD (GBVL), USD/JPY (JPVL), AUD/USD (ADVL), USD/CAD (CAVL), XAU/USD (GCVL). NZD/USD + USD/CHF tidak tersedia di CME CVOL (options terlalu illiquid). Section muncul di tab FUNDAMENTAL. Cache key `rr_cache_v2`, TTL 3600s.

**Symbol CME CVOL (semua dikonfirmasi 2026-06-05):** `EUVL`, `GBVL`, `JPVL`, `ADVL`, `CAVL`, `GCVL`

---
