# Daun Merah — Project Context (Full Reference)

> **Last updated:** 2026-04-26
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
| Frontend | Vanilla JS + HTML/CSS, single file `index.html` (~3500+ baris) |
| Backend | Vercel Serverless Functions (Node.js, CommonJS `module.exports`) |
| AI | Groq API — model `llama-3.3-70b-versatile` |
| Cache/DB | Upstash Redis REST API |
| RSS sumber berita | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) |
| Kalender ekonomi | ForexFactory XML (`nfs.faireconomy.media`) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| Icon | `icon.svg` — dual-leaf loop design (bear merah + bull teal) |
| PWA | `manifest.json` → `icon.svg`, `sw.js` — Service Worker push |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
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
    ├── _ratelimit.js       # Shared rate limiter helper — prefix _ = bukan route publik
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
Proxy RSS FinancialJuice. In-memory cache 50s + Redis `rss_cache` TTL 60s. Header `X-Cache-Source: MEMORY/REDIS/UPSTREAM/STALE`.

> **Kenapa konsolidasi:** `market-digest.js` fetch RSS via internal URL ini untuk menghindari IP block FinancialJuice. Setelah rss.js dihapus, market-digest.js sudah diupdate ke `/api/feeds?type=rss`.

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
Main AI endpoint. Flow:
1. Load `prompt_digest` dari Redis (fallback ke hardcoded `DIGEST_INSTR_DEFAULT`)
2. Fetch RSS via internal `/api/feeds?type=rss`
3. Fetch ForexFactory kalender (this week + next week)
4. Load `digest_history` dari Redis
5. **Groq Call 1:** Market briefing (Bahasa Indonesia, termasuk paragraf XAUUSD scalping)
6. Save ke `digest_history` (Redis, max 7 entri)
7. **Groq Call 2:** CB Bias Assessment — JSON per currency
8. Merge + save ke Redis `cb_bias`
9. **Groq Call 3:** Structured thesis JSON
10. Return: `{article, method, news_count, cal_count, bias_updated, generated_at, thesis}`

Rate limited: 4 req/min per IP.

### `GET /api/cb-status`
Static CB data (rates, last meeting) + bias dari Redis `cb_bias`.

### `GET /api/calendar`
ForexFactory high-impact events, 5 hari ke depan (WIB).

### `GET /api/risk-regime`
Classifier Risk-On/Neutral/Risk-Off dari VIX (FRED), MOVE (Stooq), HY OAS (FRED). Redis `risk_regime` TTL 1800s.

### `GET /api/real-yields`
Real yield differential. USD: DGS10 − T10YIE. 7 currencies lain hardcoded inflation expectations. Redis `real_yields` TTL 21600s.

### `GET /api/rate-path`
USD rate path approximation. FRED SOFR/EFFR + heuristic. BUKAN CME FedWatch (SPA). Redis `rate_path` TTL 14400s.

### `GET /api/correlations`
Cross-asset Pearson 20d + 60d, 10 instrumen via Yahoo Finance (Stooq diganti — blokir Vercel IPs). On-demand via button. Redis `correlations` TTL 86400s. Rate limited: 5/min.

### `POST/GET /api/sizing-history`
History sizing calculations per device. Redis sorted set `sizing_history:{device_id}`, max 10.

### `POST/PATCH/GET/DELETE /api/journal`
Trade journal CRUD. Soft-delete. Redis `journal:{device_id}:{id}` + sorted set `journal_index:{device_id}`.

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
| CHECKLIST | `checklist` | `--yellow` |
| SIZING | `sizing` | `--accent` |
| JURNAL | `jurnal` | `--pink` |
| PETUNJUK | `petunjuk` | `#60a5fa` |

### Mobile — Bottom Nav (`#botNav`, `.bot-nav`)
Fixed bottom bar, hanya muncul di ≤767px. Top nav disembunyikan di mobile. 8 tombol dengan SVG icon + label pendek. Active state disinkronkan dua arah dengan top nav.  
**Catatan implementasi:** Event listener pakai event delegation pada `document` (bukan `querySelectorAll` langsung) karena `#botNav` HTML berada setelah `</script>` tag — script harus jalan sebelum elemen ada di DOM.

### Category Filters (`.nav-filters`)
Hanya muncul di view NEWS: All, Mkt Moving, Forex, Macro, Econ Data, Energy, Geopolitical.

---

## Panel-Panel

### NEWS (`feedScroll`)
FinancialJuice RSS real-time. Auto-refresh toggle 50 detik. Filter per kategori.

### RINGKASAN (`ringkasanPanel`)
AI Market Briefing (3 Groq calls) + Cross-Asset Correlations section.  
Prompt: structured macro briefing — METODE per-tema (mekanisme konkret FX, magnitude, konflik), CONTINUITY (berubah vs tetap vs sesi sebelumnya), KALENDER beat/miss scenarios, penutup wajib sebut nama currency terkuat/terlemah. XAUUSD: 3-channel framework (USD/real yields, safe haven, risk sentiment ekuitas) dengan resolusi konflik eksplisit + trigger spike dengan waktu WIB.

### CAL (`calPanel`)
Economic calendar + CB tracker + Real Yields + Rate Path (USD).

### COT (`cotPanel`)
CFTC Commitment of Traders — Leveraged Funds + Asset Manager net positions 7 currencies.

### CHECKLIST (`checklistPanel`)
4 playbook: `smc_ict`, `macro_momentum`, `event_driven`, `mean_reversion`. Section REGIME CHECK (num='00') di semua playbook dengan 5 item auto-tick.  
**Mobile layout:** `ck-wrap` di ≤767px diubah ke `flex-direction:column` dan `.ck-sidebar` disembunyikan. Sidebar (verdict/progress/quick check) digantikan oleh `.ck-mobile-bar` yang muncul di dalam `.ck-sections`.

### SIZING (`sizingPanel`)
Position sizing calculator. Input: equity/risk%/pair/stop pips. Hard block >2% risk.

### JURNAL (`jurnalPanel`)
Trade journal. Auto-snapshot makro saat entry. Prefill dari AI thesis via `jnPrefillFromThesis()`.

### PETUNJUK (`petunjukPanel`)
SOP end-to-end penggunaan aplikasi. Statis (tidak ada API call). Berisi:
- Alur keputusan quick-reference (COT → RINGKASAN → CAL → NEWS → CHECKLIST → SIZING → JURNAL)
- Fase 1: Pre-Session (4 langkah)
- Fase 2: Live Session (4 langkah)
- Fase 3: Post-Trade (2 langkah)
- 6 Aturan Kunci (3 larangan + 3 keharusan)

---

## Redis Keys

| Key | Isi | TTL | Owner |
|-----|-----|-----|-------|
| `rss_cache` | `{xml, fetchedAt}` | 60s | `api/feeds.js` |
| `cot_cache_v2` | Full COT payload | no TTL (6h manual) | `api/feeds.js` |
| `cb_bias` | `{USD:{bias,confidence,updated_at},...}` | no TTL | `api/market-digest.js` |
| `digest_history` | Array max 7 entri digest AI | no TTL | `api/market-digest.js` |
| `latest_thesis` | Structured thesis JSON | 21600s | `api/market-digest.js` |
| `risk_regime` | VIX/MOVE/HY payload | 1800s | `api/risk-regime.js` |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s | `api/real-yields.js` |
| `rate_path` | `{USD:{probHold,...}}` | 14400s | `api/rate-path.js` |
| `correlations` | Correlation matrix 20d+60d | 86400s | `api/correlations.js` |
| `health_last_ok` | HSET: source → last OK ISO | no TTL | `api/admin.js` |
| `sizing_history:{device_id}` | Sorted set sizing calculations | no TTL | `api/sizing-history.js` |
| `journal:{device_id}:{id}` | Full journal entry JSON | no TTL | `api/journal.js` |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL | `api/journal.js` |
| `prompt_digest` | Override Groq prompt briefing | no TTL | `api/admin.js` |
| `prompt_bias` | Override Groq prompt CB bias | no TTL | `api/admin.js` |
| `prompt_thesis` | Override Groq prompt thesis | no TTL | `api/admin.js` |
| `push_subs` | HSET push subscriptions | no TTL | `api/subscribe.js` |
| `seen_guids` | Set GUID berita (dedup push) | 86400s | `api/admin.js` |
| `rl:{endpoint}:{ip}:{window}` | Rate limiter counter | auto 2×window | `api/_ratelimit.js` |

**Deprecated (sudah bisa dihapus):** `cot_cache`, `fundamentals_cache`

---

## Fungsi JS Kunci

```javascript
setFeedUI(show)           // toggle toolbar + navFilters visibility
hideAllPanels()           // hide semua panel (8 panel termasuk petunjukPanel)
fetchFeed()               // fetch /api/feeds?type=rss
fetchRegime()             // fetch /api/risk-regime, update banner
generateRingkasan()       // GET /api/market-digest
jnPrefillFromThesis()     // prefill form jurnal dari AI thesis
szGetDeviceId()           // get/create device ID dari localStorage
ckAutoTick(id, hint)      // auto-centang item checklist
ckAutoBlock(id, hint)     // auto-block item checklist (merah)
ckSwitchPlaybook(id)      // ganti playbook + reset state
```

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

---

## Commit History (Terbaru)

```
b1729e9  feat: add PETUNJUK tab — end-to-end SOP for trading workflow
6f48bcb  fix: market-digest internal RSS call pointing to deleted /api/rss endpoint
108ffab  feat: mobile bottom nav + SVG icon (Daun Merah dual-leaf)
95db702  fix: consolidate API routes to stay within Vercel Hobby 12-function limit
658a1a6  feat: Task 10f/g/h — Health Monitoring, Redis Key Registry, Rate Limiting
022dc40  feat: Task 7-9, Task 10a/b/e — Regime Gate, Journal, Thesis, Playbooks, Correlations, Rate Path, Hardening
9e5f7fa  feat: Task 4 — Position Sizing Calculator (SIZING tab + backend)
```

---

## Bug History yang Penting

- **RINGKASAN "0 berita"** — `market-digest.js` masih memanggil `/api/rss` (sudah dihapus saat konsolidasi). Fix: update ke `/api/feeds?type=rss` (commit 6f48bcb).
- **Vercel 12-function limit** — 17 fungsi melebihi Vercel Hobby limit. Fix: konsolidasi ke 12 (commit 95db702). File `feeds.js` = rss.js + cot.js. File `admin.js` = health.js + redis-keys.js + admin-prompts.js + push.js.
- **`sendTelegram` naming conflict** — saat merge push.js + health.js ke admin.js, keduanya punya `sendTelegram`. Fix: rename ke `sendHealthTelegram` + `sendPushTelegram`.
- **qwen-qwq-32b timeout** — model reasoning overhead melewati Vercel 25s limit. Rollback ke `llama-3.3-70b-versatile`.

---

## Constraint Absolut

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. Vercel Hobby: max 12 serverless functions — jangan tambah file baru di `api/` tanpa menghapus yang lain
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport
9. Indonesian UI text, English code/comments/variables
