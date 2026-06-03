# Daun Merah — Implementation Plan (Lengkap)

> **Dibuat:** 2026-06-03 | **Diperbarui:** 2026-06-03
> **Tujuan dokumen:** Cukup detail untuk dikerjakan AI lain tanpa tanya-tanya tambahan.
> **Production URL:** https://financial-feed-app.vercel.app
> **Stack:** Vanilla JS + single `index.html` · Vercel Serverless Functions (Node.js CommonJS) · Upstash Redis REST

---

## Constraint Global (Tidak Boleh Dilanggar)

- Vercel Hobby: TEPAT 12 serverless functions (file dengan prefix `_` tidak dihitung sebagai function)
- Daftar functions saat ini: `admin`, `calendar`, `cb-status`, `correlations`, `feeds`, `journal`, `market-digest`, `rate-path`, `real-yields`, `risk-regime`, `sizing-history`, `subscribe` → **sudah 12, tidak boleh tambah file baru di `/api/`**
- No new npm dependencies (kecuali sudah ada di `package.json`)
- Frontend tetap single `index.html` (saat ini ~7400+ baris)
- Semua external call wajib Redis cache + explicit TTL
- Fallback ke nilai lama (stale cache) jika fetch gagal — tidak boleh return error ke user
- Env vars tersedia: `FRED_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `SAMBANOVA_API_KEY`, `SAMBANOVA_API_KEY_CALL1`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

## Prioritas 1 — Data Accuracy

### 1.1 Cleveland Fed / OECD: Inflation Expectations Non-USD (Otomatis)

**Problem:**
`api/real-yields.js` menggunakan object `INFLATION_EXPECTATIONS` hardcoded. EUR sudah stale >100 hari (as_of 2026-01-15), CHF >180 hari (as_of 2025-12-12). Nilai yang stale membuat real yield tidak akurat, yang memengaruhi CB bias analysis.

**Solusi — Tahap 1: Fetch otomatis dari OECD API (gratis, no auth):**

Endpoint OECD Economic Outlook:
```
https://stats.oecd.org/SDMX-JSON/data/EO/AUS+CAN+CHL+CHE+FRA+DEU+GBR+JPN+NZL+USA.CPI.A/all?startTime=2025&endTime=2026&dimensionAtObservation=allDimensions
```
Response berisi CPI forecast per negara. Parse field `value` dari observation terakhir.

Country code mapping untuk parse:
```javascript
const OECD_TO_CURRENCY = {
  'AUS': 'AUD',
  'CAN': 'CAD',
  'CHE': 'CHF',
  'GBR': 'GBP',
  'JPN': 'JPY',
  'NZL': 'NZD',
  'FRA': 'EUR',  // EUR proxy via France
};
```

**Implementasi di `api/real-yields.js`:**

1. Tambah fungsi `fetchOECDInflation()`:
```javascript
async function fetchOECDInflation() {
  const url = 'https://stats.oecd.org/SDMX-JSON/data/EO/AUS+CAN+CHE+GBR+JPN+NZL+FRA.CPI.A/all?startTime=2025&endTime=2026&dimensionAtObservation=allDimensions';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`OECD HTTP ${r.status}`);
  const json = await r.json();
  // Parse SDMX-JSON format — values keyed by "COUNTRY:VARIABLE:FREQ"
  // Return object: { AUD: 2.8, CAD: 2.1, ... }
}
```

2. Cek Redis cache `oecd_inflation` (TTL 24h) sebelum fetch.

3. Jika OECD fetch berhasil: update `INFLATION_EXPECTATIONS` values in-memory sebelum compute real yields.

4. Jika OECD gagal: gunakan hardcoded values (behavior existing).

5. Simpan hasil ke Redis `oecd_inflation` dengan TTL 86400 (24h).

**Perubahan file:** `api/real-yields.js` saja — tambah fungsi `fetchOECDInflation()` dan panggil di awal handler sebelum compute loop.

**Redis key baru:** `oecd_inflation` TTL 86400

---

### 1.2 GDPNow Atlanta Fed

**Problem:** Tidak ada nowcast GDP real-time. AI digest hanya punya opini dari headline tanpa angka keras GDP quarter berjalan.

**Atlanta Fed GDPNow:** Update setiap 1-2 hari kerja. Data tersedia dalam format text/CSV publik.

**Sumber data yang perlu diinvestigasi dulu:**
- Cek `https://www.atlantafed.org/cqer/research/gdpnow` untuk menemukan URL CSV/JSON publik
- Atlanta Fed biasanya menyediakan file: `GDPNow-latest.csv` atau `GDPNow-latest.xlsx`
- Alternatif: FRED series `GDPNOW` (jika tersedia dan current)

**Setelah sumber ditemukan, implementasi:**

1. Tambah action `gdpnow` ke `api/admin.js` (sudah 12 functions, tidak bisa file baru):
   - Bisa masuk ke `?action=fundamental_refresh` yang sudah ada, atau tambah `?action=gdpnow`

2. Fetch GDP Nowcast, extract angka estimasi terkini (format: "2.4%" atau "2.4").

3. Simpan ke Redis hash `fundamental:USD` sebagai field `GDP Nowcast`:
```javascript
await redisCmd('HSET', 'fundamental:USD', 'GDP Nowcast', JSON.stringify({
  actual: '2.4%',
  previous: null,
  date: '2026-06-03',
  source: 'Atlanta Fed GDPNow',
}));
```

4. Field ini akan otomatis tampil di tab FUNDAMENTAL card USD (existing renderer membaca `fundamental:USD` hash).

**Perubahan file:** `api/admin.js` (tambah handler atau extend `fundamental_refresh`)

**Redis key yang diupdate:** `fundamental:USD` (existing hash)

---

### 1.3 TGA + Fed Balance Sheet via FRED

**Problem:** Tidak ada indikator likuiditas USD sistemik. TGA (Treasury General Account) drain/refill adalah driver besar cross-asset yang tidak tercermin di mana pun di app.

**Data:**
- `WALCL` — Fed Total Assets (weekly, setiap Kamis, dalam juta USD)
- TGA balance: tersedia via US Treasury FiscalData API (gratis, no auth)
  - `https://api.fiscaldata.treasury.gov/services/api/v1/accounting/dts/dts_table_1?filter=account_type:eq:Federal%20Reserve%20Account&sort=-record_date&page[size]=5`
  - Field yang relevan: `close_today_bal` (dalam juta USD), `record_date`

**Implementasi — extend `api/real-yields.js`:**

Tambah fungsi `fetchLiquidityIndicators()`:
```javascript
async function fetchLiquidityIndicators() {
  const [fedAssets, tgaRes] = await Promise.allSettled([
    fetchFred('WALCL'),  // Fed total assets — fungsi fetchFred() sudah ada di file ini
    fetch('https://api.fiscaldata.treasury.gov/services/api/v1/accounting/dts/dts_table_1?filter=account_type:eq:Federal%20Reserve%20Account&sort=-record_date&page[size]=5', {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  const result = {};

  if (fedAssets.status === 'fulfilled') {
    result.fed_assets_bn = Math.round(fedAssets.value.latest / 1000); // convert M → B
    result.fed_assets_date = fedAssets.value.date;
  }

  if (tgaRes.status === 'fulfilled' && tgaRes.value.ok) {
    const json = await tgaRes.value.json();
    const latest = json?.data?.[0];
    if (latest?.close_today_bal) {
      result.tga_balance_bn = Math.round(parseFloat(latest.close_today_bal) / 1000);
      result.tga_date = latest.record_date;
    }
  }

  return result;
}
```

Panggil di handler `real-yields.js`, simpan ke Redis `liquidity_usd` TTL 3600 (1h), dan include di response payload:
```javascript
const payload = {
  currencies: results,
  liquidity: liquidityData,  // { fed_assets_bn, fed_assets_date, tga_balance_bn, tga_date }
  computed_at: new Date().toISOString()
};
```

**Tampil di frontend:** Tab FUNDAMENTAL card USD — tambah 2 row setelah existing indicators. Logic pembacaan: TGA naik = serap likuiditas (label merah), TGA turun = inject likuiditas (label hijau). Fed Assets naik = QE (hijau), turun = QT (merah).

**Perubahan file:** `api/real-yields.js` (tambah fetch + response field) + `index.html` (tambah render untuk `liquidity_usd` di card USD)

**Redis key baru:** `liquidity_usd` TTL 3600

---

## Prioritas 2 — Fix Data yang Broken

### 2.1 CME FedWatch — Rate Path Market-Implied

**Problem:** `api/rate-path.js` saat ini menggunakan heuristic SOFR karena CME endpoint tidak berfungsi. Function `computeRatePath()` menghasilkan angka probabilitas yang tidak mencerminkan market pricing sesungguhnya.

**Pendekatan yang harus diinvestigasi (dalam urutan):**

**Candidate 1 — CME 30-Day Fed Funds Futures (ZQ):**
```
https://www.cmegroup.com/CmeWS/mvc/Settlements/futures/tradeDate/YYYYMMDD/productCode/ZQ
```
Ganti `YYYYMMDD` dengan tanggal kemarin (trading day). Response berisi settlement prices per contract. Implied rate = 100 - settlement_price. Probabilitas dihitung dari selisih antar contract months.

**Cara hitung probability dari ZQ futures:**
```
current_rate = FRED EFFR (sudah ada di code)
next_contract_price = settlement price ZQ bulan berikutnya
implied_rate_next = 100 - next_contract_price
delta = current_rate - implied_rate_next
prob_cut25 = delta / 0.25  // jika delta ~0.25, probabilitas cut ~100%
prob_hold = 1 - prob_cut25
```

**Candidate 2 — FRED FEDTARMD series:**
FRED mungkin punya series forward rate yang bisa digunakan. Cek: `FEDTARMD` (daily midpoint fed funds target).

**Candidate 3 — FedWatch HTML scrape sebagai last resort:**
Page `https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html` memuat data dari endpoint internal. Inspect network tab saat membuka halaman untuk menemukan JSON endpoint yang benar.

**Implementasi setelah endpoint ditemukan:**

Replace fungsi `computeRatePath()` di `api/rate-path.js`:
- Fetch ZQ settlement prices untuk 3 contract months ke depan
- Compute implied rates per month
- Compute probabilities per FOMC meeting (gunakan `getNextFOMCMeetings()` yang sudah ada)
- Update field `source` dari `'heuristic_sofr'` ke `'cme_zq_futures'`
- Remove field `data_note` yang saat ini jujur mengakui ketidakakuratan

**Redis key:** `rate_path` TTL 14400 (4h) — tidak berubah

**Perubahan file:** `api/rate-path.js` — replace `computeRatePath()` function body

---

## Prioritas 3 — Known Issues

### 3.1 CB Rates Update Manual (SEGERA)

**Problem:** `api/cb-status.js` — `CB_FALLBACK` terakhir diverifikasi 2026-05-05. Beberapa CB kemungkinan sudah rapat sejak itu.

**Dates terakhir di file (per 2026-06-03):**
```
USD: last_meeting 2026-04-29 (next: 2026-06-18)
EUR: last_meeting 2026-04-30 (ECB next: cek jadwal)
GBP: last_meeting 2026-04-30 (BOE next: cek jadwal)
JPY: last_meeting 2026-04-28 (BOJ next: cek jadwal)
CAD: last_meeting 2026-04-29 (BOC next: cek jadwal)
AUD: last_meeting 2026-05-06, last_decision hike +25bps → rate 4.35 (RBA next: Jul?)
NZD: last_meeting 2026-04-09 (RBNZ next: cek jadwal)
CHF: last_meeting 2026-03-19 (SNB next: cek jadwal)
```

**Action:** Sebelum mengerjakan item ini, cek jadwal meeting masing-masing CB via web search untuk periode Mei–Juni 2026, update `CB_FALLBACK` di `api/cb-status.js` dengan:
- `rate`: rate terbaru
- `last_meeting`: tanggal meeting terakhir
- `last_decision`: `'hold'`, `'hike'`, atau `'cut'`
- `last_bps`: besaran perubahan dalam basis points (0 jika hold)

**Perubahan file:** `api/cb-status.js` — update object `CB_FALLBACK` saja

---

### 3.2 Real Yields Inflation Stale

**Problem:** EUR (as_of 2026-01-15), CAD (as_of 2026-01-29), CHF (as_of 2025-12-12) — semua melewati threshold 90 hari dan ditandai `stale: true` di UI.

**Action:** Ini akan terselesaikan otomatis saat item 1.1 (OECD fetch) selesai.
Jika item 1.1 belum dikerjakan: update manual nilai di `INFLATION_EXPECTATIONS` object di `api/real-yields.js` dari sumber:
- EUR: ECB Survey of Professional Forecasters (spf.ecb.europa.eu)
- CAD: Bank of Canada MPR terbaru (bankofcanada.ca)
- CHF: SNB Inflation Forecast terbaru (snb.ch)

---

### 3.3 Parallelisasi AI Calls di market-digest.js (Robustness)

**Problem:** Call 1 (briefing), Call 2 (CB bias), Call 3 (thesis), Call 4 (thesis alerts) dijalankan sequential. Call 2 dan Call 4 sebenarnya independen dari Call 1 (tidak butuh `article`) — mereka hanya butuh `recentItems`. Jika Call 1 lambat, semua waktu eksekusi function habis sebelum Call 2–4 selesai.

**Solusi — Refactor flow di `api/market-digest.js`:**

Saat ini:
```
Call 1 → Call 2 → Call 3 (needs article) → Call 4
```

Setelah refactor:
```
[Call 1, Call 2, Call 4] parallel → lalu Call 3 (needs article dari Call 1)
```

**Cara implementasi:**

1. Extract logic Call 1, Call 2, Call 4 masing-masing ke fungsi terpisah: `runCall1(...)`, `runCall2(...)`, `runCall4(...)`
2. Jalankan paralel:
```javascript
const [article, { biasUpdated }, thesisAlerts] = await Promise.all([
  runCall1(recentItems, ...),
  runCall2(recentItems, ...),
  runCall4(recentItems, deviceId, ...),
]);
const thesis = article ? await runCall3(article, ...) : null;
```
3. Masing-masing fungsi punya try/catch sendiri — kegagalan satu tidak mempengaruhi yang lain

**Perubahan file:** `api/market-digest.js` — refactor body handler, tidak mengubah API response shape

---

## Prioritas 4 — New Edge Features

### 4.1 ATR/VaR Warning di Sizing Calculator

**Konteks trading:** SL yang terlalu dekat dari entry bisa kena stop bukan karena thesis salah, tapi karena pergerakan normal harian (noise) pair tersebut. ATR (Average True Range) 14-hari mengukur berapa pip rata-rata "range" harian. Jika SL < ATR, posisi trader sangat berisiko tersingkir oleh noise.

**Cara kerja yang diinginkan:**
1. Saat trader ganti pair di sizing calculator (`szUpdatePipInfo()`) → fetch ATR pair tersebut dari backend
2. Saat `calcSizing()` dipanggil → bandingkan `stopPips` dengan `atr_pips`
3. Jika `stopPips < atr_pips` → tampil warning kuning di bawah result
4. Di bawah warnings, selalu tampil baris ATR + 1-day VaR sebagai informasi

---

**Bagian A — Backend: Tambah `action=atr` ke `api/correlations.js`**

Ini file yang paling tepat karena sudah punya `fetchYahoo()` dan sudah handle OHLCV.

Tambah blok baru sebelum routing akhir di `module.exports`:
```javascript
if (req.query.action === 'atr') {
  const pairInput = req.query.pair || 'EUR/USD'; // e.g. "EUR/USD"

  // Map SZ_PAIRS format → Yahoo Finance symbol
  const YAHOO_SYMBOL_MAP = {
    'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'AUD/USD': 'AUDUSD=X',
    'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
    'USD/JPY': 'USDJPY=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
    'AUD/JPY': 'AUDJPY=X', 'NZD/JPY': 'NZDJPY=X', 'CAD/JPY': 'CADJPY=X',
    'CHF/JPY': 'CHFJPY=X', 'EUR/GBP': 'EURGBP=X', 'EUR/CAD': 'EURCAD=X',
    'EUR/AUD': 'EURAUD=X', 'EUR/NZD': 'EURNZD=X', 'EUR/CHF': 'EURCHF=X',
    'GBP/CAD': 'GBPCAD=X', 'GBP/AUD': 'GBPAUD=X', 'GBP/NZD': 'GBPNZD=X',
    'GBP/CHF': 'GBPCHF=X', 'AUD/CAD': 'AUDCAD=X', 'AUD/NZD': 'AUDNZD=X',
    'AUD/CHF': 'AUDCHF=X', 'NZD/CAD': 'NZDCAD=X', 'NZD/CHF': 'NZDCHF=X',
    'CAD/CHF': 'CADCHF=X', 'XAU/USD': 'GC=F',
  };

  // Pip size per pair (untuk konversi ATR price → pips)
  const PIP_SIZE_MAP = {
    'USD/JPY': 0.01, 'EUR/JPY': 0.01, 'GBP/JPY': 0.01, 'AUD/JPY': 0.01,
    'NZD/JPY': 0.01, 'CAD/JPY': 0.01, 'CHF/JPY': 0.01,
    'XAU/USD': 0.1,
  };
  const pipSize = PIP_SIZE_MAP[pairInput] || 0.0001;

  const symbol = YAHOO_SYMBOL_MAP[pairInput];
  if (!symbol) return res.status(400).json({ error: 'Unknown pair' });

  const cacheKey = `atr:${symbol}`;
  const cacheTTL = 14400; // 4 hours

  try {
    // Check Redis cache
    const cached = await redisCmd('GET', cacheKey);
    if (cached) {
      const d = JSON.parse(cached);
      if (Date.now() - new Date(d.computed_at).getTime() < cacheTTL * 1000)
        return res.status(200).json({ ...d, from_cache: true });
    }

    // Fetch 1 month daily OHLCV from Yahoo
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('No result');

    const q = result.indicators?.quote?.[0] || {};
    const highs  = q.high  || [];
    const lows   = q.low   || [];
    const closes = q.close || [];

    // Build candle array (need previous close for TR)
    const candles = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || highs[i] == null || lows[i] == null) continue;
      candles.push({ high: highs[i], low: lows[i], close: closes[i] });
    }
    if (candles.length < 15) throw new Error('Insufficient data');

    // Calculate ATR-14
    const trValues = [];
    for (let i = 1; i < candles.length; i++) {
      const { high, low } = candles[i];
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }
    const atr14 = trValues.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trValues.length);
    const atrPips = Math.round(atr14 / pipSize);

    // Calculate 20-day daily σ (std dev of log returns)
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
    const recentReturns = returns.slice(-20);
    const meanR = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const variance = recentReturns.reduce((acc, r) => acc + (r - meanR) ** 2, 0) / recentReturns.length;
    const dailySigma = Math.sqrt(variance); // as decimal (e.g. 0.006 = 0.6%)

    const payload = {
      pair: pairInput, symbol,
      atr_14d: +atr14.toFixed(6),
      atr_pips: atrPips,
      daily_sigma: +dailySigma.toFixed(6),
      pip_size: pipSize,
      computed_at: new Date().toISOString(),
    };
    await redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', cacheTTL);
    return res.status(200).json({ ...payload, from_cache: false });

  } catch(e) {
    // Serve stale cache on error
    try {
      const stale = await redisCmd('GET', cacheKey);
      if (stale) return res.status(200).json({ ...JSON.parse(stale), from_cache: true, stale: true });
    } catch(_) {}
    return res.status(500).json({ error: e.message });
  }
}
```

---

**Bagian B — Frontend: Perubahan di `index.html`**

**1. Tambah state variable** (di blok `// ── POSITION SIZING CALCULATOR ───`, sekitar baris 5876):
```javascript
let szAtrData = null; // { atr_pips, daily_sigma, pair } — diisi async saat pair berubah
```

**2. Extend `szUpdatePipInfo()`** (fungsi ada di sekitar baris 6017) untuk trigger fetch ATR:
```javascript
function szUpdatePipInfo() {
  const pair = document.getElementById('szPair').value;
  // ... existing code ...

  // Fetch ATR async — tidak blocking
  szAtrData = null; // clear stale data dari pair sebelumnya
  fetch(`/api/correlations?action=atr&pair=${encodeURIComponent(pair)}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && d.atr_pips) szAtrData = d; })
    .catch(() => {});
}
```

**3. Extend `calcSizing()`** — tambahkan logika ATR warning dan VaR row.

Temukan blok `const warnings = [];` (sekitar baris 6146), setelah baris existing warnings tambahkan:
```javascript
// ATR warning
if (szAtrData && szAtrData.atr_pips && stopPips < szAtrData.atr_pips) {
  warnings.push(`SL (${stopPips} pip) lebih kecil dari ATR 14d (${szAtrData.atr_pips} pip) — risiko kena stop oleh noise harian`);
}
```

Temukan blok render `resultEl.innerHTML = \`...\`` (sekitar baris 6202). Di dalam `<div class="sz-result-block">`, setelah baris warnings (`${warnings.map(...).join('')}`), tambahkan VaR row:
```javascript
${szAtrData && szAtrData.atr_pips ? (() => {
  const atrPips = szAtrData.atr_pips;
  // 1-day 95% VaR = 1.645 × σ × position_value
  const positionValue = lots * 100000 * (pipVal / (szAtrData.pip_size * 100000 / pipVal) || 1);
  // Simpler: VaR in USD = 1.645 × daily_sigma × (dollarRisk / stopPips × atrPips)
  const varUsd = szAtrData.daily_sigma
    ? (1.645 * szAtrData.daily_sigma * (dollarRisk / stopPips) * atrPips).toFixed(2)
    : null;
  const atrColor = stopPips < atrPips ? 'var(--yellow)' : 'var(--green)';
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-family:'DM Mono',monospace;font-size:10px;color:var(--muted)">
    ATR 14d: <span style="color:${atrColor}">${atrPips} pip</span>${varUsd ? ` · 1d VaR 95%: <span style="color:var(--text)">$${varUsd}</span>` : ''}
  </div>`;
})() : ''}
```

**Catatan implementor:** Formula VaR di atas adalah approximasi. Formula yang lebih bersih:
```
VaR_1d_95% = 1.645 × daily_sigma × current_price × lots × contract_size × pip_value_per_unit
```
Gunakan `szAtrData.daily_sigma × (dollarRisk / stopPips) × szAtrData.atr_pips` sebagai approximasi yang sudah cukup akurat untuk keperluan warning.

**Perubahan file:** `api/correlations.js` (tambah `action=atr` block) + `index.html` (3 titik perubahan kecil)

**Redis key baru:** `atr:${symbol}` TTL 14400 (contoh: `atr:EURUSD=X`, `atr:GC=F`)

**Testing criteria:** Pilih EUR/USD, set SL 10 pip → harus muncul warning kuning. Set SL 150 pip → tidak ada warning ATR. Baris ATR/VaR selalu muncul di bawah result setelah data tersedia (~1 detik).

---

### 4.2 FX Risk Reversals (25-delta) — PENELITIAN DULU

**Konteks trading:** 25-delta risk reversal = selisih implied volatility antara call 25-delta dan put 25-delta pada pair yang sama. Nilai positif = market bayar lebih mahal untuk call (takut pair naik, beli protection ke atas). Nilai negatif = market takut pair turun. Ini mencerminkan arah hedging institusional, bukan sekedar opini analis.

**Kenapa belum bisa dikerjakan:** Sumber data FX options gratis yang reliable untuk 8 major pairs belum ditemukan. Data ini OTC dan umumnya hanya tersedia via Bloomberg/Reuters yang berbayar.

**Kandidat sumber data yang harus diinvestigasi sebelum implementasi:**

1. **CME FX Options** — CME mempublikasikan settlement data untuk FX options (futures-style). Symbolnya adalah `6E` (EUR/USD), `6B` (GBP/USD), `6J` (JPY/USD), dll. Settlement data ada di:
   - `https://www.cmegroup.com/CmeWS/mvc/Settlements/options/tradeDate/YYYYMMDD/productCode/6E`
   - Tapi ini option on futures, bukan spot FX. Masih berguna sebagai proksi.

2. **Investing.com / MarketBeat** — Beberapa broker dan data provider mempublikasikan 1W/1M risk reversals untuk major pairs. Cek apakah ada endpoint yang bisa di-scrape tanpa auth.

3. **DTCC SDR (Swap Data Repository)** — DTCC mempublikasikan FX options trade data secara publik (CFTC requirement). URL: `https://pddata.dtcc.com/gtr/cftc/`. Tapi format raw, butuh parsing berat, dan tidak per-pair dengan mudah.

**Implementasi setelah sumber ditemukan:**

- Tambah `action=risk-reversal` ke `api/correlations.js`
- Fetch data per pair (EUR/USD, GBP/USD, USD/JPY, AUD/USD minimal)
- Redis cache `rr:EURUSD` TTL 3600 (1h, karena opsi data lebih sering update)
- Response: `{ pair, rr_1w, rr_1m, updated_at }` (rr = risk reversal value)
- Tampil di CB Bias section dashboard sebagai kolom tambahan, atau di RINGKASAN di bawah CB bias
- Label: nilai positif hijau "call bias", nilai negatif merah "put bias"

**Status:** TUNGGU — penelitian sumber data dulu sebelum mulai coding

---

### 4.3 Yield Curve Lintas Negara via FRED + ECB

**Konteks trading:** Rate differential adalah mesin utama FX macro. Tapi hanya CB Rate point-in-time tidak cukup — bentuk yield curve (flat/inverted/steep) mencerminkan ekspektasi pasar ke depan, bukan hanya level saat ini. Curve inverted (2Y > 10Y) = pasar ekspektasi perlambatan/cuts.

**Data yang dibutuhkan per currency:**
- USD: 2Y, 5Y, 10Y, 30Y nominal yield + spread 2Y10Y (sebagai inversi indicator)
- EUR: 2Y, 10Y ECB spot rates
- GBP: 2Y, 10Y Gilt yields (opsional, bisa jadi Phase 2)

**Sumber data USD (semua dari FRED, `fetchFred()` sudah ada di `api/real-yields.js`):**
```javascript
const YIELD_CURVE_SERIES = {
  USD_2Y:  'DGS2',   // 2-Year Treasury Constant Maturity Rate (daily)
  USD_5Y:  'DGS5',   // 5-Year
  USD_10Y: 'DGS10',  // 10-Year (sudah di-fetch untuk real yields)
  USD_30Y: 'DGS30',  // 30-Year
};
// Spread 2Y10Y = DGS10 - DGS2 (positif = normal, negatif = inverted)
```

**Sumber data EUR (ECB Statistical Data Warehouse — gratis, no auth):**
```
https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=jsondata&lastNObservations=1
https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata&lastNObservations=1
```
Parse: `json.dataSets[0].series["0:0:0:0:0:0:0"].observations` → ambil nilai terbaru.

**Implementasi di `api/real-yields.js`:**

1. Tambah fungsi `fetchYieldCurve()`:
```javascript
async function fetchYieldCurve() {
  const result = {};

  // USD dari FRED (parallel)
  const [dgs2, dgs5, dgs10, dgs30] = await Promise.allSettled([
    fetchFred('DGS2'), fetchFred('DGS5'), fetchFred('DGS10'), fetchFred('DGS30'),
  ]);

  const usd = {};
  if (dgs2.status === 'fulfilled')  usd['2y']  = dgs2.value.latest;
  if (dgs5.status === 'fulfilled')  usd['5y']  = dgs5.value.latest;
  if (dgs10.status === 'fulfilled') usd['10y'] = dgs10.value.latest;
  if (dgs30.status === 'fulfilled') usd['30y'] = dgs30.value.latest;
  if (usd['2y'] != null && usd['10y'] != null)
    usd['spread_2y10y'] = +(usd['10y'] - usd['2y']).toFixed(3);
  if (Object.keys(usd).length > 0) result.USD = usd;

  // EUR dari ECB SDW (parallel dengan USD fetch di atas, atau dalam satu Promise.all besar)
  try {
    const [eur2y, eur10y] = await Promise.allSettled([
      fetch('https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=jsondata&lastNObservations=1', { signal: AbortSignal.timeout(8000) }),
      fetch('https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata&lastNObservations=1', { signal: AbortSignal.timeout(8000) }),
    ]);
    const parseEcb = async (res) => {
      if (res.status !== 'fulfilled' || !res.value.ok) return null;
      const j = await res.value.json();
      const series = j?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0']?.observations;
      if (!series) return null;
      const keys = Object.keys(series).sort((a, b) => +b - +a);
      return series[keys[0]]?.[0] ?? null;
    };
    const [e2y, e10y] = await Promise.all([parseEcb(eur2y), parseEcb(eur10y)]);
    const eur = {};
    if (e2y  != null) eur['2y']  = +e2y.toFixed(3);
    if (e10y != null) eur['10y'] = +e10y.toFixed(3);
    if (eur['2y'] != null && eur['10y'] != null)
      eur['spread_2y10y'] = +(eur['10y'] - eur['2y']).toFixed(3);
    if (Object.keys(eur).length > 0) result.EUR = eur;
  } catch(e) { console.warn('fetchYieldCurve EUR failed:', e.message); }

  return result;
}
```

2. Panggil `fetchYieldCurve()` di handler, simpan ke Redis `yield_curve` TTL 3600 (1h), include di response.

3. USD `10y` yang sudah difetch untuk real yields bisa di-reuse (tidak fetch ulang).

**Frontend — tampil di tab FUNDAMENTAL, card USD:**

Tambah section "YIELD CURVE" di bawah existing USD indicators. Format:
```
2Y: 4.25% · 5Y: 4.35% · 10Y: 4.50% · 30Y: 4.65%
2Y10Y spread: +0.25% (NORMAL)
```
Jika spread < 0: label merah "INVERTED", jika < 0.2: label kuning "FLAT", jika > 0.5: label hijau "STEEP".

Sama untuk EUR card jika data tersedia.

**Redis key baru:** `yield_curve` TTL 3600

**Perubahan file:** `api/real-yields.js` (tambah `fetchYieldCurve()` + include di response) + `index.html` (tampilkan di card USD dan EUR di tab FUNDAMENTAL)

---

### 4.4 Portfolio VaR — Gabungan Posisi Terbuka

**Konteks trading:** VaR per trade (item 4.1) hanya melihat satu posisi. Jika punya 3 posisi terbuka yang berkorelasi tinggi (misal EUR/USD long, GBP/USD long, EUR/GBP flat), total risiko sebenarnya bisa jauh lebih besar dari jumlah individual karena ketiganya bergerak bersama.

**Prasyarat:** Item 4.1 (ATR/VaR per trade) harus sudah live dan terbukti berguna sebelum mengerjakan ini.

**Logika:**

1. Ambil semua open journal entries dari `jnAllEntries` (sudah tersedia di frontend).
2. Untuk setiap entry yang punya `pair` dan `lots`, fetch ATR dari cache `/api/correlations?action=atr&pair=...`
3. Hitung individual VaR per posisi: `VaR_i = 1.645 × σ_i × notional_i`
4. Untuk combined VaR, gunakan korelasi dari `correlationsCache` yang sudah ada:
   - Jika korelasi antar pair > 0.7 → flag sebagai "correlated risk"
   - Combined VaR (simplified) = `√(Σ VaR_i² + 2 × Σ_{i≠j} corr_ij × VaR_i × VaR_j)`
5. Tampil di tab JURNAL, bagian atas sebelum daftar entries, sebagai summary card

**Output UI (di `jurnalPanel`, di atas daftar entries):**
```
PORTFOLIO RISK SUMMARY
Open: 3 posisi · Combined VaR 1d: $450
⚠ EUR/USD + GBP/USD berkorelasi tinggi (0.85) — exposure efektif lebih besar
```

**Perubahan file:** `index.html` saja (client-side math menggunakan data yang sudah ada)

**Status:** Kerjakan setelah 4.1 selesai dan dipakai minimal 2 minggu

---

## ❌ Fitur yang Ditolak (Dengan Alasan)

### ✗ Econometrics & Kointegrasi (Granger Causality, OLS Regression)
**Alasan:** Alat untuk quant/pairs trader yang trading mean reversion secara sistematis. Daun Merah dibangun untuk gaya macro discretionary — keputusan entry berdasarkan fundamental, CB divergence, dan event-driven. Uji statistik Granger causality tidak cocok dengan workflow ini. Selain itu compute-heavy, tidak cocok untuk Vercel serverless.

### ✗ Social Sentiment (Twitter/Reddit/WSB/Stocktwits)
**Alasan:** Twitter API sejak 2023 tidak gratis (mulai $100/bulan). Reddit/WSB sentiment sangat relevan untuk equities tapi noise untuk FX — institutional flow jauh lebih dominan di forex market. Crypto Fear & Greed Index yang sudah ada sudah mewakili retail sentiment untuk XAU/crypto channel. Effort tinggi, signal-to-noise rendah untuk gaya macro FX.

---

## Prioritas 5 — UX & Completeness

### 5.1 Checklist State Per-Pair
**Problem:** `ckState` (object yang menyimpan checklist item states) shared untuk semua pair. Saat ganti pair di dropdown checklist, manual items dari pair sebelumnya carry over.

**Solusi:**
- Saat ini: `localStorage.setItem('daunmerah_v2_state', ...)` (single key)
- Ganti ke: `localStorage.setItem('daunmerah_v2_state_EURUSD', ...)` — key per pair
- Saat pair berubah (dropdown change event): save state pair lama → load state pair baru
- Pair key: gunakan pair string tanpa `/`, contoh `EURUSD`, `USDJPY`

**Perubahan file:** `index.html` — fungsi `ckSave()`, `ckLoad()`, dan event handler ganti pair di checklist

---

### 5.2 Journal N+1 Query (Performance)
**Problem:** `api/journal.js` — load all entries menggunakan `ZRANGE journal_index:${deviceId} 0 -1` untuk dapat semua IDs, lalu loop GET per ID. Untuk 50 entries = 51 Redis roundtrips.

**Solusi:** Ganti ke `MGET` batch:
```javascript
const ids = await redisCmd('ZRANGE', `journal_index:${deviceId}`, 0, -1, 'REV');
const keys = ids.map(id => `journal:${deviceId}:${id}`);
// Gunakan pipeline atau MGET
const rawEntries = await redisCmd('MGET', ...keys);
const entries = rawEntries.map(r => { try { return JSON.parse(r); } catch(_) { return null; } }).filter(Boolean);
```

**Catatan:** Upstash Redis REST API mendukung multi-key GET via pipeline. Cek apakah `redisCmd('MGET', key1, key2, ...)` bekerja di Upstash REST format — jika tidak, gunakan `https://redis-url/pipeline` endpoint.

**Perubahan file:** `api/journal.js` — bagian handler yang loads entries

---

### 5.3 VIX Term Structure
**Problem:** Hanya VIX spot (^VIX). Tidak bisa lihat apakah struktur VIX sedang backwardation (spot > futures = panik akut) atau contango (futures > spot = fear terdistribusi ke depan).

**Solusi:**
- Tambah fetch Yahoo Finance untuk `^VIX1M` dan `^VIX3M` (VIX 1-month dan 3-month futures)
- Logic yang sudah ada untuk `^VIX` spot ada di `api/risk-regime.js` — extend di sana
- Tampil di header bar risk regime atau di tab COT sebagai baris tambahan
- Label: jika VIX1M > VIX → "Contango (Fear Terdistribusi)", jika VIX > VIX1M → "Backwardation (Panik Akut)"

**Perubahan file:** `api/risk-regime.js` + `index.html` (display)

---

## Urutan Pengerjaan yang Disarankan

```
[1]  3.1  CB Rates update manual          → cepat, cek kalender CB + update hardcode
[2]  1.3  TGA + Fed Balance Sheet (FRED)  → cepat, FRED_API_KEY sudah ada
[3]  4.3  Yield Curve USD via FRED        → ekstensi natural dari [2], kerjakan bersamaan
[4]  3.3  Parallelisasi AI Calls          → robustness, reduce cold-call latency
[5]  1.1  OECD Inflation Nowcast          → fix EUR/CHF stale (selesaikan 3.2)
[6]  1.2  GDPNow Atlanta Fed             → research endpoint dulu, lalu implement
[7]  2.1  CME FedWatch                   → research ZQ futures endpoint dulu
[8]  4.1  ATR/VaR di sizing calculator   → quick win, mandiri
[9]  4.3  Yield Curve EUR (ECB SDW)      → ekstensi dari [3]
[10] 5.3  VIX Term Structure             → polish, tapi berguna
[11] 4.2  FX Risk Reversals              → tunggu sumber data reliable ditemukan
[12] 4.4  Portfolio VaR                  → setelah 4.1 live minimal 2 minggu
[13] 5.1  Checklist state per-pair       → UX, kapan sempat
[14] 5.2  Journal MGET batch             → performance, kapan sempat
```

---

## Referensi API Endpoints yang Sudah Terbukti Bekerja

| Data | URL | Auth |
|------|-----|------|
| FRED series | `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=KEY&limit=5&sort_order=desc&file_type=json` | `FRED_API_KEY` env |
| Yahoo Finance OHLCV | `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1mo` | none |
| TGA Balance | `https://api.fiscaldata.treasury.gov/services/api/v1/accounting/dts/dts_table_1?filter=account_type:eq:Federal%20Reserve%20Account&sort=-record_date&page[size]=5` | none |
| ECB Yield Curve 10Y | `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata&lastNObservations=1` | none |
| ECB Yield Curve 2Y | `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=jsondata&lastNObservations=1` | none |
| FinancialJuice RSS | `https://www.financialjuice.com/feed.ashx?xy=rss` | none |
| ForexFactory Calendar | `https://nfs.faireconomy.media/ff_calendar_thisweek.xml` | none |

**Note untuk implementor:** URL yang ditandai "perlu verifikasi" di atas (Cleveland Fed, Atlanta Fed GDPNow, CME ZQ futures) harus di-test dahulu sebelum ditulis ke kode — beberapa mungkin butuh penyesuaian endpoint.
