# Daun Merah — Rencana Pengembangan Aktif

> **Dibuat:** 2026-06-02 (session 36)
> **Status:** Menunggu konfirmasi eksekusi

---

## Sesi Berikutnya — Urutan Eksekusi

| # | Fitur | Effort | Payoff | Backend? |
|---|-------|--------|--------|----------|
| 1 | COT Historical Trend Chart | Sedang | Sangat Tinggi | Ya (branch baru di feeds.js) |
| 2 | Macro Scenario Planner | Rendah-Sedang | Tinggi | Tidak (pure frontend) |
| 3 | Command Center Dashboard | Tinggi | Tinggi | Tidak (pure CSS+HTML) |
| 4 | Code Splitting | Tinggi | Maintainability | Tidak (refactor saja) |

---

## Fitur 1 — COT Historical Trend Chart

### Tujuan
Tampilkan perubahan tren net-posisi COT (Asset Manager vs Leveraged Funds) per currency dalam 12 minggu terakhir. Data sudah terkumpul di Redis `cot_history` (rolling 90 hari) sejak session 20 (2026-05-10) — hanya butuh endpoint + visualisasi.

### Backend — `api/feeds.js`

Tambah branch baru `?type=cot_history` di handler yang sudah ada (tidak tambah function baru).

```js
// GET /api/feeds?type=cot_history&n=12
// Baca n entri terakhir dari sorted set cot_history
```

**Logic:**
1. `ZRANGE cot_history 0 -1 WITHSCORES` → ambil semua entri (score = timestamp)
2. Slice ke 12 terbaru (descending by score)
3. Parse setiap entry JSON: `{ positions, report_date, stored_at }`
4. Return array terurut ascending (terlama → terbaru):

```json
{
  "history": [
    {
      "report_date": "2026-03-18",
      "ts": 1742281200000,
      "positions": {
        "USD": { "am_net": 45210, "lev_net": -12300, "am_change_net": 1200, "lev_change_net": -800 },
        "EUR": { ... },
        ...
      }
    },
    ...
  ],
  "count": 12
}
```

**Redis command:**
```js
const raw = await redisCmd('ZRANGE', 'cot_history', '0', '-1', 'WITHSCORES');
// raw = ['json1', 'score1', 'json2', 'score2', ...]
// Parse pairs, sort descending by score, slice N, sort ascending untuk chart
```

**Cache:** Redis `cot_history_cache` TTL 3600s — data COT weekly, tidak perlu refresh sering.

**Constraint:** tidak ada function baru, numpang `feeds.js`. Tetap 12 function limit.

---

### Frontend — Tab COT

**Tambahan UI:**
- Per currency card di COT tab: tambah tombol kecil `[TREN]` di pojok kanan atas card
- Klik `[TREN]` → buka panel inline di bawah card (toggle, bukan modal)
- Panel berisi SVG line chart: 2 garis (AM net = warna teal, Lev net = warna pink)

**Fungsi baru:**
```js
async function cotFetchHistory(currency)   // GET /api/feeds?type=cot_history
function cotRenderTrendPanel(currency, historyData)  // render SVG
function cotToggleTrend(currency)          // show/hide panel per currency
```

**SVG Chart (zero dependency, seperti equity curve):**
- Width: 100%, Height: 120px (viewBox 400×120)
- X-axis: minggu (report_date, label bulan/tanggal)
- Y-axis: net position (ribuan kontrak)
- Garis AM net: `#00c896` (teal) — uang besar / institutional
- Garis Lev net: `#f472b6` (pink) — hedge fund / spekulan
- Legend: dot + label "Asset Mgr" dan "Leveraged"
- Zero line putus-putus
- Tooltip saat hover: `report_date · AM: +45.2K · Lev: -12.3K`

**Client-side cache:** `cotHistoryCache[currency]` + timestamp, TTL 30 menit (data weekly, tidak berubah).

**State:** `cotTrendOpen = {}` (objek currency → boolean) untuk toggle.

---

### UI Sketch Tab COT (setelah perubahan)

```
┌─────────────────────────────────────────────────────┐
│  COT Positioning    [Report: May 13]  [⚠ Stale]    │
├─────────────────────────────────────────────────────┤
│  USD  ████████████░░░░  AM: +45.2K ↑1.2K           │
│        ░░░░████████████  Lev: -12.3K ↓0.8K  [TREN] │
│  ────────────────────────────────────────────────── │
│  ▼ TREN USD (klik [TREN] untuk toggle)             │
│  ┌──────────────────────────────────────────────┐  │
│  │  AM Net ——  Lev Net ——                       │  │
│  │  +50K ┤  ╭──╮                               │  │
│  │       │ ╭╯  ╰──╮    ╭──╮                   │  │
│  │    0  ┤─────────────────────────────────    │  │
│  │  -20K │           ╰──╯    ╰──  (Lev)       │  │
│  │       Mar    Apr    May                     │  │
│  └──────────────────────────────────────────────┘  │
│  EUR  ....                              [TREN]      │
└─────────────────────────────────────────────────────┘
```

---

## Fitur 2 — Macro Scenario Planner

### Tujuan
Saat trader klik event High-impact di tab CAL, muncul panel "Simulasi Rilis" dengan tombol BEAT/MISS. PWA otomatis rekomendasikan pair optimal berdasarkan CB bias dan fundamental terkini.

### Pure Frontend — Tidak ada perubahan backend

Gunakan data yang sudah ada di memori:
- `calData` — event list (currency, event name, date, time_wib)
- `cbData` — CB bias per currency (bias, confidence)
- `fundData` — fundamental score per currency

**Logic Inti:**

```js
function scenarioGetPairs(eventCurrency, direction) {
  // direction: 'beat' (event currency menguat) atau 'miss' (event currency melemah)
  // 1. Tentukan apakah event currency menjadi BASE atau QUOTE
  // 2. Jika BEAT: event currency = kuat → cari 3 currency paling lemah (dovish + fund score rendah)
  // 3. Jika MISS: event currency = lemah → cari 3 currency paling kuat (hawkish + fund score tinggi)
  // 4. Return array pair recommendation: [{pair, direction, reason}]
}
```

**CB Bias Score** (sudah ada sebagai `CB_BIAS_LEVEL`):
```js
const CB_BIAS_LEVEL = { 'very hawkish':4, 'hawkish':3, 'neutral':2, 'dovish':1, 'very dovish':0 };
```

**Pair recommendation logic (BEAT example untuk USD NFP):**
1. `eventCurrency = 'USD'`, `biasScore(USD)` dari `cbData`
2. Cari 3 currency lain dengan `biasScore` paling rendah (paling dovish)
3. Jika USD adalah base currency dalam pair standar (USDXXX): recommend LONG
4. Jika USD adalah quote currency (XXXUSD): recommend SHORT
5. Tambah konteks: CB rate USD vs counterpart, fundamental score

**Currency → pair mapping** (pair standar Daun Merah):
```js
const USD_PAIRS = {
  EUR: { pair:'EURUSD', usd:'quote' },  // USD kuat = EURUSD turun = SHORT
  GBP: { pair:'GBPUSD', usd:'quote' },
  JPY: { pair:'USDJPY', usd:'base' },   // USD kuat = USDJPY naik = LONG
  AUD: { pair:'AUDUSD', usd:'quote' },
  NZD: { pair:'NZDUSD', usd:'quote' },
  CAD: { pair:'USDCAD', usd:'base' },
  CHF: { pair:'USDCHF', usd:'base' },
};
// Untuk non-USD event (EUR, GBP dll): pair melawan currency paling berlawanan
```

---

### UI — Panel Simulasi di Tab CAL

**Trigger:** klik event card High-impact → panel muncul inline di bawah event card (bukan modal/popup).

**Layout panel:**

```
┌─────────────────────────────────────────────────────┐
│  SIMULASI RILIS: NFP (USD)  ×                       │
│  Ekspektasi: 185K  ·  Previous: 177K                │
├─────────────────────────────────────────────────────┤
│        [▲ BEAT]          [▼ MISS]                  │
├─────────────────────────────────────────────────────┤
│  (klik salah satu untuk melihat rekomendasi)        │
└─────────────────────────────────────────────────────┘

── Setelah klik BEAT ─────────────────────────────────

┌─────────────────────────────────────────────────────┐
│  SIMULASI: NFP BEAT → USD menguat                   │
├─────────────────────────────────────────────────────┤
│  #1  LONG USD/JPY                                   │
│      JPY: Very Dovish (BOJ 0.75%) · Fund: lemah     │
│      CB Divergence: USD Hawkish vs JPY Very Dovish  │
│                                                     │
│  #2  LONG USD/CHF                                   │
│      CHF: Dovish (SNB 0.00%) · Fund: mixed          │
│                                                     │
│  #3  SHORT EUR/USD                                  │
│      EUR: Neutral · CB rate: 2.15% (ECB hold)      │
├─────────────────────────────────────────────────────┤
│  ⚠ Ini rekomendasi awal — tetap validasi via       │
│  CHECKLIST sebelum entry.                           │
│          [→ Buka CHECKLIST]                         │
└─────────────────────────────────────────────────────┘
```

**Fungsi baru:**
```js
function calOpenScenario(evIdx)          // buka panel simulasi untuk event ke-evIdx
function calCloseScenario()              // tutup panel
function calRunScenario(direction)       // hitung + render rekomendasi
function scenarioRankCurrencies(eventCur, direction)  // core ranking logic
function scenarioRenderResults(pairs)    // render hasil
```

**State:**
```js
let calScenarioOpen = null;  // index event yang sedang dibuka panel-nya
```

**Constraint:**
- Jika `cbData` belum tersedia: tampilkan "Data CB belum dimuat — buka tab RINGKASAN dulu"
- Pair recommendation hanya dari 8 pair yang sudah ada di aplikasi
- Tombol "→ Buka CHECKLIST" switch ke tab checklist + set pair selector ke pair #1

---

## Fitur 3 — Command Center Dashboard (Desktop)

### Tujuan
Layout 4-panel untuk layar lebar (≥1024px) — trader bisa lihat News, AI Digest, Currency Strength, dan Event terdekat dalam satu tampilan tanpa pindah tab.

### Implementasi — Pure CSS + HTML

**Pendekatan:**
- Tambah tab baru `DASHBOARD` di nav (hanya muncul di `@media (min-width: 1024px)`)
- Panel dashboard mereuse data yang sudah ada (tidak ada fetch tambahan) — cukup re-render ke div baru
- Semua data sudah di-fetch saat panel aktif masing-masing; dashboard hanya sebagai "view" alternatif

**CSS Grid Layout:**

```
┌────────────────────────────────────────────────────────────────────┐
│  [NEWS] [RINGKASAN] [CAL] [COT] [FUND] [CHECKLIST] ... [DASHBOARD] │  ← top nav
├──────────────────┬─────────────────────────┬───────────────────────┤
│                  │                         │                       │
│  LIVE NEWS FEED  │   AI DIGEST             │  CB BIAS MATRIX       │
│  (live scroll)   │   (briefing terbaru)    │  (8 currency pills)   │
│                  │                         │                       │
│  compact list:   │   Artikel briefing      │  USD ● Hawkish        │
│  · [●] headline  │   paling baru           │  EUR ● Neutral        │
│  · [●] headline  │                         │  JPY ● Very Dovish    │
│  · [●] headline  │   ─────────────────     │  GBP ● Neutral        │
│  · ...           │   THESIS AKTIF          │  AUD ● Hawkish        │
│                  │   (pair + direction)     │  ...                  │
│  [AUTO: ON]      │                         │                       │
│                  │   AI updated: 14 menit  │  Fund: [RANKING STRIP]│
├──────────────────┴─────────────────────────┴───────────────────────┤
│  EVENT TERDEKAT (next 24h, High-impact only)                       │
│  [● USD NFP · 21:30 WIB · 3j 15m]  [● EUR CPI · 15:30 · 8j 40m]  │
└────────────────────────────────────────────────────────────────────┘
```

**Grid CSS:**
```css
@media (min-width: 1024px) {
  #dashboardPanel {
    display: grid;
    grid-template-columns: 280px 1fr 260px;
    grid-template-rows: 1fr auto;
    height: calc(100vh - 48px);  /* minus nav height */
    gap: 0;
    overflow: hidden;
  }
  #dashNewsCol   { grid-column: 1; grid-row: 1; overflow-y: auto; border-right: 1px solid var(--border); }
  #dashMainCol   { grid-column: 2; grid-row: 1; overflow-y: auto; border-right: 1px solid var(--border); }
  #dashSideCol   { grid-column: 3; grid-row: 1; overflow-y: auto; }
  #dashEventBar  { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid var(--border); flex-shrink: 0; }
}
```

**Data rendering — reuse existing functions:**

| Panel | Data source | Render function |
|-------|------------|-----------------|
| News col | `allItems` (sudah ada) | Render 20 headline terbaru dalam format compact |
| AI Digest | `lastDigest` (string article) | Trim ke 500 char, tampilkan full jika di-expand |
| CB Bias | `cbData` (sudah ada) | Loop 8 currency → pill warna + bias label |
| Fund Ranking | `fundData` (sudah ada) | Strip ranking horizontal (seperti di tab FUNDAMENTAL) |
| Event bar | `calData` (sudah ada) | Filter High-impact 24h, chips seperti tekEventStrip |

**Fungsi baru:**
```js
function initDashboard()        // setup, fetch jika ada data yang belum ter-load
function renderDashNews()       // render compact news list
function renderDashDigest()     // render AI briefing terbaru + thesis
function renderDashBias()       // render CB bias pills + fund ranking
function renderDashEvents()     // render event bar (reuse logic tekEventStrip)
function refreshDashboard()     // re-render semua panel (dipanggil setiap 60s)
```

**Auto-refresh:** `setInterval(refreshDashboard, 60000)` hanya saat tab DASHBOARD aktif — `clearInterval` saat pindah tab.

**Nav:** Tab DASHBOARD hanya muncul di CSS `@media (min-width: 1024px)` — hidden di mobile. Keyboard shortcut: `G D`.

**Constraint:**
- Tidak fetch data baru — semua reuse `allItems`, `cbData`, `fundData`, `calData`, `lastDigest` yang sudah ada di memori
- Jika data belum ter-load: tampilkan "Buka tab [X] dulu untuk memuat data, atau tunggu auto-refresh"
- Mobile: tab DASHBOARD tidak muncul sama sekali (CSS `display:none` di ≤1023px)

---

## Fitur 4 — Code Splitting (Sesi Terpisah)

> **Catatan:** Dikerjakan setelah Fitur 1-3 selesai dan stable. Ini adalah refactor murni, tidak ada perubahan behavior.

### Tujuan
Pecah `index.html` (6600+ baris) menjadi file-file terpisah tanpa build tool, tanpa mengubah arsitektur global variable yang sudah ada.

### Target Struktur File

```
Financial_Feed_App/
├── index.html          ← HTML skeleton + <link> + <script> tags (~600 baris)
├── styles.css          ← Semua CSS (~1400 baris)
├── app-core.js         ← State global, constants, util, tab routing, SW init (~500 baris)
├── app-feeds.js        ← News feed, calendar, COT, CB Watch (~600 baris)
├── app-ai.js           ← Market digest, AI briefing, thesis, CB bias (~400 baris)
├── app-jurnal.js       ← Journal CRUD, equity curve, sizing bridge (~600 baris)
├── app-teknikal.js     ← TradingView chart, TA panel, event strip, MTF (~400 baris)
├── app-checklist.js    ← Checklist, scoring, auto-tick, playbook (~800 baris)
├── app-dashboard.js    ← Dashboard panel (setelah Fitur 3 selesai)
└── api/                ← Tidak berubah
```

### Urutan Eksekusi Split

**Step 1 — CSS (paling aman, tidak ada dependency):**
- Extract semua CSS dari `<style>` ke `styles.css`
- Ganti dengan `<link rel="stylesheet" href="styles.css">`
- Test: semua tab harus identik secara visual

**Step 2 — JS Core (global state dan utils):**
- Extract: semua `let/const` global di atas, `setFeedUI`, `hideAllPanels`, `showToast`, `szGetDeviceId`, tab routing event listener, SW init
- Simpan ke `app-core.js`
- `index.html` load dengan `<script src="app-core.js">` paling atas

**Step 3 — JS per fitur (berurutan, cek dependency):**
- Extract `app-feeds.js` → `fetchFeed`, `renderFeed`, `fetchCalendar`, `renderCalendar`, `fetchCOT`, `renderCOT`
- Extract `app-ai.js` → `generateRingkasan`, `renderArticle`, `fetchCBStatus`
- Extract `app-checklist.js` → semua `ck*` functions, `PLAYBOOKS`, `PB_REGIME_CHECK`
- Extract `app-jurnal.js` → semua `jn*` functions, `szPrefillJurnal`, sizing functions
- Extract `app-teknikal.js` → semua `tek*` functions, `createTVChart`, `renderTekEventStrip`

**Risiko & Mitigasi:**
- **Urutan script load:** `app-core.js` wajib paling atas (defines globals yang dipakai file lain)
- **Circular dependency:** tidak ada di arsitektur saat ini (semua terpusat di globals), tapi perlu dicek manual
- **DOMContentLoaded:** pastikan semua event listener tetap wrap dalam event ini (sudah benar di kode sekarang)
- **Testing:** setelah setiap step, buka semua 10+ tab dan test fungsi kritis (fetch, render, tab switch, push notif)

### Constraint Split
- Tidak mengubah nama function atau variable (breaking change)
- Tidak mengubah ke ES modules (`type="module"`) — tetap global scope via `<script src>`
- Tidak mengubah arsitektur routing atau state management
- Tidak ada tree-shaking atau minification (Vercel serve as-is)

---

## Catatan Implementasi

### Constraints Absolut (tidak boleh dilanggar)
1. Max 12 Vercel serverless functions (prefix `_` tidak dihitung)
2. No new npm dependencies
3. No build tool (webpack/vite/rollup)
4. Mobile-first — test 380px viewport setiap perubahan UI
5. Setiap Redis key baru harus punya TTL eksplisit
6. Tidak ada silent failure — setiap `catch` harus log context

### Data yang Sudah Ada di Memori (tersedia tanpa fetch tambahan)
| Variable | Isi | Di-fetch saat |
|----------|-----|---------------|
| `allItems` | Array 100 news headline | Tab NEWS dibuka / auto-refresh |
| `calData` | Array event kalender 5 hari | Tab CAL / setiap 30 menit |
| `cotData` | COT snapshot mingguan | Tab COT dibuka |
| `cbData` | CB bias 8 currency | Tab RINGKASAN / setiap 5 menit |
| `fundData` | Fundamental data 8 currency | Tab FUNDAMENTAL dibuka |
| `regimeData` | Risk regime (Risk-On/Off/Neutral) | Tab RINGKASAN / setiap 30 menit |
| `jnAllEntries` | Trade journal entries | Tab JURNAL dibuka |

### Fitur yang Ditunda
- ~~MT5 Advanced Bridge (Partial Close, SL to BE)~~ — kompleks, ditunda ke sesi masa depan
- ~~Text-to-Speech Audio Briefing~~ — ditunda (UX premium tapi bukan bottleneck)
- ~~Bug fixes sw.js + mt5_bridge.py~~ — ditunda ke sesi tersendiri

---

*File ini akan diupdate setelah setiap fitur diimplementasikan. Fitur yang sudah selesai dipindahkan ke `daun_merah.md` → section Changelog.*
