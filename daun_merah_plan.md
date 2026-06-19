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

## 5. BTC Predictive Model (ML Research) — Handoff Konteks Penuh

> **Ditulis:** 2026-06-19, untuk lanjut di sesi/AI lain. Ini bukan fitur UI Daun Merah — ini riset terpisah (folder `ml/` dan `scripts/btc-*`, `data/btc/`) untuk eksplorasi apakah ada model prediktif BTC yang bisa dipakai. Baca seluruh section ini sebelum mulai kerja, supaya tidak mengulang yang sudah dicoba.

### 🎯 Target proyek (diklarifikasi user 2026-06-19)

**Bangun model BTC yang berkualitas dengan ROC-AUC setinggi mungkin, baseline target: 70%.**

Konteks penting: sejauh ini target **arah harga** (naik/turun) sudah terbukti dead-end (AUC ~0.53, tidak robust di CV). Target **volatility-regime** (apakah volatilitas ke depan tinggi/rendah) jauh lebih menjanjikan — AUC 0.633 ± 0.0035, robust dan signifikan secara statistik (permutation test p≈0). **Ini kemungkinan jalur paling realistis untuk mencapai target 70%** — lihat rencana DVOL di bawah sebagai langkah konkret berikutnya untuk mendekati target itu. Evaluasi WAJIB pakai walk-forward CV + permutation test, bukan single train/test split (sudah 2x kejadian single-split kelihatan bagus tapi ternyata fluke saat divalidasi CV).

### Ringkasan arsitektur

```
data/btc/*.csv          ← data mentah (8 sumber gratis) + features_4h.csv/features_1d.csv (hasil olahan)
scripts/btc-*.js        ← Node: koleksi data (backfill + sync hourly via GitHub Actions)
scripts/feature-engineering.js  ← Node: hitung indikator teknikal + gabung semua sumber + buat target
ml/*.py                 ← Python (.venv lokal: pandas, scikit-learn, torch): modeling, EDA, eksperimen
ml/results/REPORT.md    ← laporan naratif lengkap (Part 1 = arah harga, Part 2 = diagnostik + volatility-regime)
ml/STATUS.md            ← snapshot status teknis sebelumnya (mungkin sudah agak stale, REPORT.md lebih lengkap)
```

### Sumber data (semua gratis, 8 total)

| Sumber | Isi | Histori | Catatan |
|---|---|---|---|
| `data-api.binance.vision` | OHLCV 1h/4h/1d | sejak 2017-08 | `api.binance.com` asli di-geoblock (HTTP 451) dari GitHub Actions (US) — pakai mirror ini |
| `cftc.gov` | COT CME Bitcoin futures (mingguan) | sejak 2018-04 | Publish lag 3 hari (as-of Selasa, rilis Jumat) — **sudah di-fix**. Cloudflare block `fetch()` Node tapi tidak `curl` — script pakai `curl` |
| `alternative.me` | Fear & Greed Index (harian) | sejak 2018-02 | — |
| `mempool.space` | Hashrate (harian) | sejak 2009 | tanpa batasan |
| CoinGecko | Stablecoin supply (USDT+USDC), BTC dominance | stablecoin: 365 hari (limit free-tier); dominance: tidak ada histori, akumulasi mulai sekarang | — |
| `deribit.com` | **DVOL** (implied volatility index BTC, hourly) | sejak 2021-03-24 | **Sudah selesai diintegrasikan ke fitur dan dites — tidak terbukti menambah AUC** (lihat poin 10 di bawah). Deribit & Binance **di-blokir ISP Indonesia** (DNS redirect ke `aduankonten.id`) — tidak bisa diakses dari mesin lokal, **harus** dari GitHub Actions |

Funding rate (perpetual futures) dan orderbook live **sengaja di-skip** — funding rate tidak ada sumber gratis yang tidak ter-geoblock; orderbook tidak relevan untuk horizon intraday-swing dan tidak cocok arsitektur serverless.

### Apa yang sudah dicoba dan hasilnya (urut kronologis)

1. **Prediksi arah harga** (`target_dir_6`/`target_dir_18`, biner naik/turun) — 5 algoritma (Logistic Regression, Random Forest, Gradient Boosting, MLP, LSTM) + 2 baseline naif, evaluasi single-split DAN walk-forward CV (4 fold ekspanding) DAN permutation test. **Hasil: tidak ada edge yang robust.** Hasil terbaik yang lolos CV cuma AUC 0.528±0.018 (Random Forest, 4h/1-hari). Satu hasil yang awalnya kelihatan bagus di single-split (55.6%/AUC 0.569) **ternyata fluke** — rata-rata CV-nya 0.481 (di bawah random).
2. **Regresi return** (prediksi besaran, bukan arah) — lebih buruk lagi, hampir semua model R² negatif.
3. **Bug ditemukan & diperbaiki:** COT publish-lag (lookahead bias 3 hari), dan normalisasi COT (`cot_open_interest`/`cot_net_noncomm` mentah trending naik seiring tahun karena pasar futures makin matang → diganti `cot_open_interest_z` rolling z-score dan `cot_net_pct` rasio self-normalizing).
4. **Feature diagnostics:** multikolinearitas nyata (13-18 pasang fitur korelasi >0.7, termasuk `ret_1`≈`log_ret_1` duplikat), TAPI memangkas fitur **tidak** memperbaiki hasil di CV — bottleneck-nya data/sinyal, bukan strategi fitur.
5. **COT contrarian positioning:** `cot_net_pct` di resolusi mingguan native (427 laporan, bukan versi duplikasi harian) berkorelasi -0.16 sampai -0.18 dengan forward return 1-2 bulan (crowded long → return lemah). Bertahan di 3/4 fold CV, **gagal khusus saat bull run kuat 2023-2024**. Real tapi lemah (R²~3%).
6. **EDA: volatility clustering dikonfirmasi kuat.** ACF `|return|` tetap 0.15-0.26 di SEMUA lag sampai 40 (vs ~0 untuk raw return) — ini yang memotivasi eksperimen volatility-regime di bawah.
7. **🏆 Volatility-regime classification — hasil terbaik proyek ini.** Target: apakah realized volatility 6 periode ke depan ada di top 30% dari rolling 500-periode terakhir (threshold adaptif, bukan fixed, karena level volatilitas BTC berubah dari tahun ke tahun). Fitur tambahan: Parkinson volatility (estimator high-low range), realized vol level 6/20-periode. **Random Forest, 4h: walk-forward CV AUC 0.633 ± 0.0035** (sangat stabil antar-fold), permutation test p≈0 (signifikan, bukan noise). Logistic Regression dekat kedua (0.627±0.010). **LSTM paling lemah di SEMUA 4 eksperimen** (arah, CV arah, regresi, volatility-regime) — deep learning tidak pernah menang di proyek ini, jangan coba lagi tanpa alasan baru.
8. **Sudah diintegrasikan ke pipeline resmi** (`scripts/feature-engineering.js`): kolom `target_vol_regime_6`, `realized_vol_6`, `realized_vol_20`, `parkinson_vol_mean_6`. Diverifikasi reproduce hasil Python persis (0.6333±0.0035, jumlah baris identik).
9. **Saran AI eksternal (Gemini) dievaluasi, tidak ditelan mentah:** saran volatility-regime tervalidasi kuat (poin 7), tapi saran Monte Carlo GBM untuk TP/SL probability **ditolak** (asumsi volatilitas konstan kontradiksi dengan temuan clustering; asumsi shock Gaussian kontradiksi fat-tail return yang ditemukan EDA, kurtosis 8.6-23). Saran "volume bars" juga ditolak (rasionalnya soal pasar sepi weekend tidak relevan untuk BTC yang trading 24/7).
10. **✅ DVOL (implied volatility) — selesai diintegrasikan dan dites, hasil: TIDAK terbukti menambah AUC.** Motivasi: user tanya apakah AUC bisa didorong ke 70-80%; DVOL (ekspektasi volatilitas dari pasar opsi) adalah kandidat data baru paling kuat karena beda jenis informasi dari realized vol yang sudah dipakai. `dvol_close`/`dvol_change_1` ditambahkan ke `scripts/feature-engineering.js`, lalu diuji di `ml/volatility_regime.py` dengan rigor yang sama (walk-forward CV + permutation test), **dibandingkan apple-to-apple** (baseline vs +DVOL di baris yang identik, supaya tidak rancu dengan histori DVOL yang lebih pendek 2021+ vs sumber lain 2017+). Hasil 4h: baseline-di-era-DVOL 0.6125±0.0502 (n=11.473) vs +DVOL 0.6185±0.0463 — selisih +0.006, jauh lebih kecil dari std antar-fold (0.046-0.05) → **noise, bukan sinyal**. Hasil 1d serupa (selisih +0.0003). Temuan menarik lain: membatasi ke era DVOL saja (tanpa DVOL feature) sudah menurunkan AUC dari 0.633 (full history) ke 0.6125 — window 2021+ (mencakup bear market terburuk BTC) lebih sulit/noisy, bukan soal DVOL absen. Detail lengkap: `ml/results/REPORT.md` poin 10. **Kolom DVOL tetap dipertahankan di pipeline** (tidak merugikan, mungkin berguna untuk target lain) tapi tidak dipakai untuk klaim peningkatan model. Menjawab pertanyaan terbuka soal AUC 70-80% secara empiris: **0.633 kemungkinan adalah plafon** untuk pendekatan/fitur saat ini — perlu target/horizon yang fundamental berbeda untuk melangkah lebih jauh, belum teridentifikasi.

### Ide yang SUDAH DITOLAK (jangan diusulkan ulang tanpa alasan baru)

- Monte Carlo GBM (constant volatility) untuk TP/SL — kontradiksi temuan vol clustering & fat-tail return.
- Volume bars — rasional "pasar sepi weekend" tidak relevan untuk BTC 24/7.
- ARIMA murni di return — ACF/PACF empiris ~0 di semua lag, tidak ada struktur untuk di-fit.
- HMM regime detection — bukan ditolak, tapi di-deprioritaskan (kompleksitas tambahan di atas hasil yang belum matang).
- DVOL sebagai fitur volatility-regime — diuji ketat, tidak terbukti membantu (poin 10 di atas). Bisa dipertimbangkan lagi untuk *target* lain (misal prediksi DVOL sendiri, atau spread implied-vs-realized vol), bukan untuk target ini tanpa alasan baru.

### Angka-angka kunci (supaya tidak perlu dihitung ulang)

| Hasil | Nilai |
|---|---|
| Direction prediction terbaik (CV) | AUC 0.528 ± 0.018 |
| Volatility-regime terbaik (CV, full history, tanpa DVOL) | **AUC 0.633 ± 0.0036** |
| Permutation null untuk hasil itu | mean 0.500, std 0.006, p≈0 |
| Volatility-regime, era-DVOL saja, tanpa fitur DVOL (4h) | 0.6125 ± 0.0502 (n=11.473) |
| Volatility-regime, era-DVOL saja, +fitur DVOL (4h) | 0.6185 ± 0.0463 — bukan peningkatan nyata |
| COT contrarian correlation (native weekly) | -0.16 sampai -0.18 |

**Status keseluruhan riset BTC:** semua jalur yang teridentifikasi sejauh ini sudah dites (arah harga, regresi, volatility-regime, DVOL). Volatility-regime (AUC 0.633) tetap hasil terbaik dan satu-satunya yang lolos validasi ketat. Belum ada kandidat data/ide baru untuk dicoba — perlu input baru (data source lain atau target lain) untuk melanjutkan riset ini.

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
