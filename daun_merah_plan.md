# Daun Merah — Backlog Aktif

> **Diperbarui:** 2026-06-03
> **Stack:** Vanilla JS + single `index.html` · Vercel Serverless Functions (Node.js CommonJS) · Upstash Redis REST

---

## Constraint Global (Tidak Boleh Dilanggar)

- Vercel Hobby: TEPAT 12 serverless functions (file dengan prefix `_` tidak dihitung)
- Daftar functions: `admin`, `calendar`, `cb-status`, `correlations`, `feeds`, `journal`, `market-digest`, `rate-path`, `real-yields`, `risk-regime`, `sizing-history`, `subscribe` → **sudah 12, tidak boleh tambah file baru di `/api/`**
- No new npm dependencies
- Frontend tetap single `index.html`
- Semua external call wajib Redis cache + explicit TTL
- Fallback ke stale cache jika fetch gagal — tidak boleh return error ke user
- Env vars: `FRED_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `SAMBANOVA_API_KEY`, `SAMBANOVA_API_KEY_CALL1`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

## 4.2 FX Risk Reversals (25-delta)

**Konteks trading:** 25-delta risk reversal = selisih implied volatility antara call 25-delta dan put 25-delta pada pair yang sama. Nilai positif = market bayar lebih mahal untuk call (takut pair naik). Nilai negatif = market takut pair turun. Mencerminkan arah hedging institusional.

---

### Hasil Research — Kesimpulan

**Tidak ada endpoint gratis zero-friction** yang langsung return 25-delta RR. Semua sumber butuh minimal registrasi gratis.

| Sumber | Auth | Pairs | Return IV+Delta | 25d RR Langsung |
|--------|------|-------|----------------|-----------------|
| **Barchart OnDemand** | **Free API key** | **6E,6B,6J,6A,6C,6N,6S** | **Ya** | **Ya (direct compute)** |
| CME CVOL Skew (formal API) | OAuth gratis | EUR,GBP,JPY,AUD,CAD | Skew proxy | Proxy saja |
| CME CVOL Skew (visualizer XHR) | Mungkin tanpa key | EUR,GBP,JPY,AUD,CAD | Skew proxy | Proxy saja |
| CME `CmeWS/mvc/Settlements` | Tidak perlu | 7 pairs | Settlement price saja | Tidak (butuh Black-76 solver) |
| DTCC SDR | Tidak perlu | OTC | Tidak (premium bukan vol) | Tidak |
| Investing.com / Saxo | Session/OAuth | Major | Ya | Ya | Tidak (anti-scrape/auth) |

---

### Dua Opsi Implementasi

**Opsi A — Barchart OnDemand (Recommended, clean 25d RR)**

1. Daftar free API key di `barchart.com/ondemand` (signup email, no payment)
2. Endpoint: `https://ondemand.websol.barchart.com/getFuturesOptionsEOD.json?apikey=KEY&root=6E&fields=impliedVolatility,delta,type,strike`
3. Parse: filter calls dengan `delta ≈ 0.25`, puts dengan `delta ≈ -0.25`
4. `RR = call_IV - put_IV` → langsung angka risk reversal clean
5. Pairs: `6E`=EUR/USD, `6B`=GBP/USD, `6J`=JPY/USD, `6A`=AUD/USD, `6C`=CAD/USD, `6N`=NZD/USD, `6S`=CHF/USD

**Opsi B — CME CVOL Skew (Proxy tanpa registrasi, jika visualizer XHR bisa diakses)**

CME publish `EUSK`, `GBSK`, `JPSK`, `ADSK` — Skew = UpVar − DnVar. Methodologi berbeda dari 25d RR tapi interpretasinya sama: positif = call bias, negatif = put bias. Perlu inspect network tab di browser saat buka halaman CVOL untuk dapat endpoint XHR-nya.

---

### Implementasi (setelah API key tersedia)

- Tambah `action=risk-reversal` ke `api/correlations.js`
- Env var baru: `BARCHART_API_KEY` (jika pilih Opsi A)
- Redis cache `rr:6E` TTL 3600 (1h)
- Response: `{ pair, rr_value, call_iv, put_iv, updated_at, source }`
- Tampil di CB Bias section atau tab FUNDAMENTAL
- Label: positif hijau "call bias ↑", negatif merah "put bias ↓", ±0.2 abu "neutral"

**Status:** TUNGGU keputusan — perlu Barchart API key atau verifikasi CME CVOL XHR endpoint

---

## 4.4 Portfolio VaR — Gabungan Posisi Terbuka

**Konteks trading:** VaR per trade hanya melihat satu posisi. Jika punya 3 posisi terbuka yang berkorelasi tinggi (misal EUR/USD long, GBP/USD long, EUR/GBP flat), total risiko sebenarnya bisa jauh lebih besar dari jumlah individual karena ketiganya bergerak bersama.

**Prasyarat:** Item 4.1 (ATR/VaR per trade) sudah live sejak commit 0d51a7d. ✅

---

### Schema Journal Entry (Dikonfirmasi oleh Research)

Field yang tersedia di setiap entry: `id`, `pair`, `direction` (`"long"`/`"short"`), `entry_price`, `stop_price`, `target_price`, `size_lots`, `rr_planned`, `status` (`"open"`/`"closed"`/`"archived"`), `thesis_text`, `time_horizon`, `regime_at_entry`, `cb_bias_snapshot`, `cot_snapshot`.

**Tidak ada `dollarRisk` di entry** — harus dihitung ulang dari `entry_price`, `stop_price`, `size_lots` menggunakan fungsi `calcPipValueUSD(pair, entryPrice, rates)` yang sudah ada di `index.html` (baris ~5959).

---

### Correlation Matrix (Dikonfirmasi)

Data korelasi tersimpan di variabel `corrData` (bukan `correlationsCache`). Struktur:
```javascript
corrData = {
  matrix_20d: { 'EUR|GBP': 0.83, 'EUR|AUD': 0.71, ... },  // key = "A|B" single currency code
  matrix_60d: { ... },
  ...
}
```
Hanya cover: EUR, GBP, JPY, AUD, Gold. **NZD, CAD, CHF tidak ada** — default ke corr=0 (underestimate risk untuk pair tersebut).

Mapper pair → currency code:
```javascript
function pairToCurrCode(pair) {
  if (pair === 'XAU/USD') return 'Gold';
  const [base, quote] = pair.split('/');
  return quote === 'USD' ? base : (base === 'USD' ? quote : base);
}
function getCorr(pairA, pairB) {
  const a = pairToCurrCode(pairA), b = pairToCurrCode(pairB);
  return corrData?.matrix_20d?.[`${a}|${b}`] ?? corrData?.matrix_20d?.[`${b}|${a}`] ?? 0;
}
```

---

### Logika Implementasi

1. Filter: `const openEntries = jnAllEntries.filter(e => e.status === 'open')`
2. Untuk tiap open entry dengan `entry_price`, `stop_price`, `size_lots` non-null:
   - Fetch ATR: `GET /api/correlations?action=atr&pair=<pair>` (cached 4h — cepat)
   - Hitung `stopPips = Math.abs(entry_price - stop_price) / pip_size`
   - Hitung `dollarRisk` via `calcPipValueUSD` (atau fallback notional: `lots × 100000`)
   - `VaR_i = 1.645 × daily_sigma × (dollarRisk / stopPips) × atr_pips`
3. Combined VaR (variance-covariance):
```javascript
function portfolioVaR(vars) {
  let sum = 0;
  for (let i = 0; i < vars.length; i++) {
    sum += vars[i].var ** 2;
    for (let j = i + 1; j < vars.length; j++) {
      const rho = getCorr(vars[i].pair, vars[j].pair);
      const dirSign = vars[i].direction === vars[j].direction ? 1 : -1;
      sum += 2 * rho * dirSign * vars[i].var * vars[j].var;
    }
  }
  return Math.sqrt(Math.max(0, sum));
}
```
4. Flag korelasi: pair dengan `getCorr() > 0.7` → tampil sebagai warning

---

### Titik Perubahan di index.html

**HTML:** Baris ~1969 di dalam `<div id="jnListView">` — insert `<div id="jnVarCard">` sebelum filter buttons row.

**JS trigger:** Panggil `jnRenderVaR()` di akhir `jnLoadEntries()` (baris ~6496, setelah `jnAllEntries` terisi) dan di akhir `jnRenderEntries()` (baris ~6520).

**Edge case:**
- Jika `corrData` null → tampil undiversified VaR (sum-of-squares tanpa cross terms) + note "data korelasi belum dimuat"
- Jika `szLiveRates` null → gunakan notional-based VaR sebagai fallback
- Show loading state saat ATR fetch sedang berjalan (N parallel calls per open position)

---

**Output UI:**
```
PORTFOLIO RISK SUMMARY
Open: 3 posisi · Combined VaR 1d: $450
⚠ EUR/USD + GBP/USD berkorelasi tinggi (0.85) — exposure efektif lebih besar
```

**Perubahan file:** `index.html` saja — 3 area: HTML card, fungsi `jnRenderVaR()` baru, panggil di `jnLoadEntries()` dan `jnRenderEntries()`

**Keterbatasan yang perlu dicatat di UI:** NZD/CAD/CHF pairs diasumsikan uncorrelated (korelasi defaultnya 0) karena tidak ada di matrix — bisa underestimate portfolio risk.

**Status:** SIAP DIKERJAKAN

---

## Referensi API Endpoints Terbukti Bekerja

| Data | URL | Auth |
|------|-----|------|
| FRED series | `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=KEY&limit=5&sort_order=desc&file_type=json` | `FRED_API_KEY` |
| Yahoo Finance OHLCV | `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1mo` | none |
| TGA Balance | `https://api.fiscaldata.treasury.gov/services/api/v1/accounting/dts/dts_table_1?filter=account_type:eq:Federal%20Reserve%20Account&sort=-record_date&page[size]=5` | none |
| ECB Yield Curve 10Y | `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata&lastNObservations=1` | none |
| ECB Yield Curve 2Y | `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=jsondata&lastNObservations=1` | none |
| FinancialJuice RSS | `https://www.financialjuice.com/feed.ashx?xy=rss` | none |
| ForexFactory Calendar | `https://nfs.faireconomy.media/ff_calendar_thisweek.xml` | none |
