# Daun Merah — Project Context (Full Reference)

> **Last updated:** 2026-05-28 (session 29)
> **Branch:** main — semua perubahan deployed ke production
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`
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
| AI | **Multi-provider:** Cerebras `qwen-3-32b` (Call 1 briefing), SambaNova (Call 2–3 bias+thesis), Groq (Call 4 thesis-invalidation + fallback semua call) |
| Cache/DB | Upstash Redis REST API |
| RSS sumber berita | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) — satu-satunya sumber (Nitter dihapus 2026-05-05) |
| Kalender ekonomi | ForexFactory XML (`nfs.faireconomy.media`) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| Icon | `icon.svg` — dual-leaf loop design (bear merah + bull teal) |
| PWA | `manifest.json` → `icon.svg`, `sw.js` — Service Worker push |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
- `CEREBRAS_API_KEY`
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
Main AI endpoint. Multi-provider: Cerebras (Call 1), SambaNova (Call 2–3), Groq (Call 4 + fallback). Flow:
1. Load `prompt_digest` dari Redis (fallback ke hardcoded `DIGEST_INSTR_DEFAULT`)
2. Fetch RSS via internal `/api/feeds?type=rss`
3. Fetch ForexFactory kalender (this week + next week)
4. Load `digest_history` + `real_yields` + **`xau_spot`** dari Redis paralel
5. **`fetchXauSpot()`** — Yahoo Finance `GC=F` → fallback Binance PAXGUSDT. Cache Redis `xau_spot` TTL 5 menit. Inject ke prompt sebagai jangkar harga `$xxx.xx (+y%)`.
6. **Cerebras Call 1:** Market briefing (Bahasa Indonesia). XAUUSD paragraf menggunakan pendekatan **benang merah**: buka dengan harga live, rajut headline + real yield + geopolitik secara natural tanpa rantai kausal kaku.
7. Save ke `digest_history` (Redis, LPUSH/LTRIM max 7)
8. **SambaNova Call 2:** CB Bias Assessment — JSON per currency
9. Merge + save ke Redis `cb_bias`
10. **SambaNova Call 3:** Structured thesis JSON
11. **Groq Call 4:** Thesis Invalidation Monitor — scan open journal entries vs headlines, push notif jika ada kontradiksi
12. **`autoUpdateFundamentals`** — parse 100 headline terbaru → HSET `fundamental:{currency}`, deteksi CB rate decision → `cb_decisions`
13. **`autoUpdateFundamentalsFromCalendar`** — FF calendar events dengan `actual` non-null langsung update `fundamental:{currency}` tanpa parsing teks (source: `ff_calendar`)
13. Return: `{article, method, news_count, cal_count, bias_updated, generated_at, thesis}`

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

---

## FOMC Dates Hardcoded

File: `api/rate-path.js`

2026: May 7, Jun 18, Jul 30, Sep 17, Nov 5, Dec 17
2027: Jan 28, Mar 18 (estimasi — belum dipublikasi Fed, diberi label sebagai estimate)

---

## Inflation Expectations Hardcoded (Update Quarterly)

File: `api/real-yields.js`, object `INFLATION_EXPECTATIONS`

Source: ECB SPF, BoE IAS, BoJ Tankan — cek `as_of` field, update jika > 90 hari.

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
