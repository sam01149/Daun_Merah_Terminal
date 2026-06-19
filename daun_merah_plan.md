# Daun Merah — Backlog Aktif

> **Diperbarui:** 2026-06-19 (bersihkan item 4.2 + 4.4 yang sudah lama live di production tapi dokumen ini belum diupdate; section BTC ML jadi satu-satunya item aktif)
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

## 4.2 FX Risk Reversals (25-delta) — selesai, live di production

Diimplementasikan sejak session 46-47 (lihat daun_merah.md): action=risk-reversal di api/correlations.js, sumber CME CVOL /services/cvol (6 pair: EUR, GBP, JPY, AUD, CAD, XAU; NZD/CHF tidak tersedia karena options terlalu illiquid), cache rr_cache_v2 TTL 1h. Frontend: #fundRRSection di tab FUNDAMENTAL. Dikonfirmasi live (2026-06-19): EUR/USD -0.713, GBP/USD -1.048, USD/JPY +1.932, AUD/USD -0.891, USD/CAD -0.269, XAU/USD -1.047. Section research lama (Barchart vs CME CVOL) dihapus dari sini karena sudah lama tidak relevan — keputusan akhirnya CME CVOL, sudah jalan.

---

## 4.4 Portfolio VaR — selesai, live di production

Diimplementasikan sejak session 46 (lihat daun_merah.md): jnRenderVaR() + #jnVarCard di index.html, variance-covariance method pakai corrData.matrix_20d, notional per pair-type yang benar, ATR cached 4h di sessionStorage, warning korelasi >=0.70. Sama persis dengan spesifikasi yang sebelumnya direncanakan di section ini.

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
10. **✅ DVOL (implied volatility) — selesai diintegrasikan dan dites, hasil: TIDAK terbukti menambah AUC.** Motivasi: user tanya apakah AUC bisa didorong ke 70-80%; DVOL (ekspektasi volatilitas dari pasar opsi) adalah kandidat data baru paling kuat karena beda jenis informasi dari realized vol yang sudah dipakai. `dvol_close`/`dvol_change_1` ditambahkan ke `scripts/feature-engineering.js`, lalu diuji di `ml/volatility_regime.py` dengan rigor yang sama (walk-forward CV + permutation test), **dibandingkan apple-to-apple** (baseline vs +DVOL di baris yang identik, supaya tidak rancu dengan histori DVOL yang lebih pendek 2021+ vs sumber lain 2017+). Hasil 4h: baseline-di-era-DVOL 0.6125±0.0502 (n=11.473) vs +DVOL 0.6185±0.0463 — selisih +0.006, jauh lebih kecil dari std antar-fold (0.046-0.05) → **noise, bukan sinyal**. Hasil 1d serupa (selisih +0.0003). Temuan menarik lain: membatasi ke era DVOL saja (tanpa DVOL feature) sudah menurunkan AUC dari 0.633 (full history) ke 0.6125 — window 2021+ (mencakup bear market terburuk BTC) lebih sulit/noisy, bukan soal DVOL absen. Detail lengkap: `ml/results/REPORT.md` poin 10. **Kolom DVOL tetap dipertahankan di pipeline** (tidak merugikan, mungkin berguna untuk target lain) tapi tidak dipakai untuk klaim peningkatan model.
11. **✅ EDA khusus target volatility-regime + GARCH/sentiment + mitigasi multikolinearitas — selesai dites, hasil: TIDAK ada peningkatan, tapi dapat insight penting.** User minta dorong AUC ke 70% dan minta cek ulang EDA/data-prep. EDA lama (`eda.py`) ternyata untuk target arah harga, belum pernah diprofilkan khusus untuk target vol-regime — `ml/eda_volregime.py` (baru) menutup gap itu. Temuan: (a) fitur non-vol (momentum/sentimen/COT) berkontribusi nyata, bukan dead weight (vol-only 3 fitur AUC 0.58/0.65 vs full set 0.63/0.67); (b) `fear_greed` masuk top-5 feature importance di kedua timeframe; (c) ACF `realized_vol_6` sendiri decay pelan (lag1=0.91, lag6=0.43, lag20=0.35, lag60=0.21 di 4h) — ada "memori volatilitas" lebih panjang dari window 6/20 yang dipakai. Dua ide termotivasi temuan ini diuji ketat (walk-forward CV, `ml/vol_regime_garch.py`): **fear_greed extremity** (`|value-50|`) dan **GARCH(1,1) conditional volatility** — keduanya TIDAK menambah AUC (delta dalam rentang noise). **Akar masalah GARCH ditemukan:** conditional vol-nya berkorelasi 0.956 dengan `realized_vol_20` yang sudah jadi fitur — bukan informasi baru, cuma menurunkan ulang info yang sudah ada. Ini juga menjelaskan kenapa fitur OHLCV-derived lain (DVOL excepted, karena itu BUKAN derivasi OHLCV) semua mentok di angka yang sama. **Multikolinearitas dicek khusus untuk fitur vol-regime** (16-21 pasang |corr|>0.7) — ditemukan 3 fitur vol-level yang dipakai (`realized_vol_6/20`, `parkinson_vol_mean_6`) saling redundan satu sama lain (corr 0.75-0.88, efektif cuma ~1.5 sinyal independen, bukan 3) — sumber lain kenapa GARCH (mirip salah satunya) tidak nambah. **Dimitigasi:** pangkas `ret_1`, `macd_signal`, `ema12_gt_ema26`, `cot_noncomm_long_pct`, `bb_pctb` dari `FEATURE_COLS`, dan `realized_vol_6` dari `extra_cols` vol-regime (25→19 fitur). Diverifikasi via CV sebelum commit: tidak ada AUC cost (baseline baru 0.6302±0.0062, lama 0.633±0.0036 — sama secara statistik), malah sedikit lebih stabil untuk Logistic Regression. Semua file hasil yang ter-commit (`model_comparison.json`, `cross_validation.json`, `regression_comparison.json`) diregenerate dengan fitur yang sudah dipangkas supaya konsisten dengan kode. Detail lengkap: `ml/results/REPORT.md` poin 11.
12. **✅ VIX (cross-asset macro risk) — kandidat data baru terakhir, dites, hasil: TIDAK signifikan.** VIX (CBOE volatility index, harian, gratis dari Yahoo sejak 1990 — tidak ada masalah histori pendek seperti DVOL) adalah satu-satunya kandidat "informasi genuinely baru" yang belum dites setelah GARCH/sentiment (poin 11) ternyata cuma menurunkan ulang info yang sudah ada. Korelasi mentah dengan target paling kuat dari semua fitur cross-asset yang dicoba: +0.07 (4h)/+0.10 (1d). Tapi setelah diuji walk-forward CV: RF 4h naik tipis dari 0.6270±0.0076 ke 0.6286±0.0028 (delta +0.0015) — untuk memastikan bukan kebetulan, dilakukan permutation test LANGSUNG pada delta-nya (bukan cuma pada AUC): shuffle target 30x, hitung ulang delta no-VIX→+VIX tiap kali, lihat di mana delta asli jatuh di distribusi null itu. **Hasil: p=0.300 — tidak signifikan**, delta asli sepenuhnya konsisten dengan rentang yang dihasilkan kebetulan. Detail lengkap: `ml/results/REPORT.md` poin 12. Ini menutup pengujian empiris untuk pertanyaan "bisa ke 70%?" — empat kandidat (DVOL, GARCH, fear_greed extremity, VIX) semua dites dengan rigor yang sama, semua gagal.
13. **✅ Regresi besaran volatilitas (bukan klasifikasi) — dites, hasil: GAGAL, lebih buruk dari klasifikasi.** User tanya: yang sudah dites itu klasifikasi (top 30% atau bukan), bagaimana kalau regresi nilai volatilitas-nya langsung (bukan biner)? Beda dari regresi return (`train_regression.py`) yang sudah dicoba — ini regresi `forward_vol` (nilai kontinu di belakang threshold biner `target_vol_regime`), belum pernah dicoba. Diuji (`ml/vol_regression.py`) walk-forward CV dengan baseline persistence (vol besok = `realized_vol_20` hari ini). **Hasil: Random Forest cuma R²=+0.030±0.049 (4h, nyaris nol) dan -0.195±0.202 (1d, negatif)** — model lain (Linear Regression, Gradient Boosting) negatif & tidak stabil antar-fold, **MLP divergen total** (R² minus ribuan). Single-split sempat kelihatan OK (R²=0.11-0.13) tapi itu **fluke lagi** — CV mean-nya jauh negatif, kejadian ketiga di proyek ini dimana single-split menyesatkan. **Kenapa regresi gagal padahal klasifikasi (agak) berhasil:** `forward_vol` itu standar deviasi dari cuma 6 return — sample sangat kecil, jadi target itu sendiri noisy (margin error sample std n=6 itu sekitar 30%). Klasifikasi cuma butuh rank/posisi relatif terhadap threshold benar, regresi butuh nilai eksak — itu kenapa noise target lebih mematikan untuk regresi. **Kesimpulan: output yang bisa dipakai dari riset ini adalah classifier biner (`target_vol_regime_6`, sudah di pipeline), BUKAN forecast magnitude.** Detail lengkap: `ml/results/REPORT.md` poin 13.

### Ide yang SUDAH DITOLAK (jangan diusulkan ulang tanpa alasan baru)

- Monte Carlo GBM (constant volatility) untuk TP/SL — kontradiksi temuan vol clustering & fat-tail return.
- Volume bars — rasional "pasar sepi weekend" tidak relevan untuk BTC 24/7.
- ARIMA murni di return — ACF/PACF empiris ~0 di semua lag, tidak ada struktur untuk di-fit.
- HMM regime detection — bukan ditolak, tapi di-deprioritaskan (kompleksitas tambahan di atas hasil yang belum matang).
- DVOL sebagai fitur volatility-regime — diuji ketat, tidak terbukti membantu (poin 10). Bisa dipertimbangkan lagi untuk *target* lain (misal prediksi DVOL sendiri, atau spread implied-vs-realized vol), bukan untuk target ini tanpa alasan baru.
- GARCH(1,1) conditional volatility sebagai fitur — diuji ketat, redundan dengan `realized_vol_20` (corr 0.956), tidak menambah apa-apa (poin 11).
- fear_greed extremity (`|value-50|`) — diuji ketat, tidak terbukti membantu dibanding raw fear_greed (poin 11).
- Garman-Klass / Rogers-Satchell volatility estimator — korelasinya dengan target hampir identik dengan Parkinson yang sudah dipakai, tidak worth diganti (poin 11).
- VIX sebagai fitur cross-asset — diuji ketat, delta tidak signifikan di permutation test langsung (p=0.300) walau korelasi mentahnya paling kuat dari semua fitur cross-asset yang dicoba (poin 12).
- Regresi besaran volatilitas (forward_vol kontinu) sebagai pengganti klasifikasi biner — diuji ketat, gagal dan lebih tidak stabil dari klasifikasi (target terlalu noisy, sample std dari cuma 6 observasi). Jangan diusulkan ulang sebagai cara dapat output kontinu kecuali noise di target-nya diatasi dulu (misal target realized-vol dengan window lebih panjang/estimator lain) (poin 13).

### Angka-angka kunci (supaya tidak perlu dihitung ulang)

| Hasil | Nilai |
|---|---|
| Direction prediction terbaik (CV) | AUC 0.528 ± 0.018 |
| Volatility-regime terbaik (CV, full history, fitur sudah dipangkas) | **AUC 0.6302 ± 0.0062** (lama: 0.633±0.0036, sama secara statistik) |
| Permutation null untuk hasil itu | mean ~0.500, std ~0.005, p≈0 |
| Volatility-regime, era-DVOL saja, tanpa fitur DVOL (4h) | 0.6125 ± 0.0502 (n=11.473) |
| Volatility-regime, era-DVOL saja, +fitur DVOL (4h) | 0.6185 ± 0.0463 — bukan peningkatan nyata |
| Volatility-regime + GARCH(1,1) (4h, RF, CV) | 0.6333 ± 0.0031 — bukan peningkatan nyata |
| Volatility-regime + fear_greed extremity (4h, RF, CV) | 0.6322 ± 0.0105 — bukan peningkatan nyata |
| Volatility-regime + VIX (4h, RF, CV) | 0.6286 ± 0.0028 vs 0.6270 tanpa VIX — delta tidak signifikan, p=0.300 |
| Korelasi GARCH conditional vol dengan realized_vol_20 (fitur yang sudah ada) | 0.956 — kunci kenapa GARCH tidak membantu |
| Regresi forward_vol kontinu, Random Forest (CV) | 4h: R²=+0.030±0.049 (nyaris nol); 1d: R²=-0.195±0.202 (negatif) — gagal |
| COT contrarian correlation (native weekly) | -0.16 sampai -0.18 |

**Status keseluruhan riset BTC:** semua jalur yang teridentifikasi sejauh ini sudah dites (arah harga, regresi return, volatility-regime klasifikasi, regresi volatility magnitude, DVOL, GARCH, sentiment extremity, vol estimator alternatif, multikolinearitas, VIX). Volatility-regime **klasifikasi biner** (AUC ~0.63) tetap hasil terbaik dan satu-satunya yang lolos validasi ketat — regresi dari signal yang sama persis gagal karena target-nya terlalu noisy untuk prediksi nilai eksak. Ada penjelasan struktural KENAPA mentok di situ: fitur rolling-window yang sudah ada sudah menyerap hampir semua informasi yang bisa direcover secara linear dari histori harga BTC sendiri. Pertanyaan "bisa ke 70%?" sudah dijawab tuntas secara empiris dengan 4 kandidat berbeda (DVOL, GARCH, sentiment extremity, VIX) — semua gagal lolos uji rigor yang sama. **Output yang bisa dipakai dari riset ini: classifier biner `target_vol_regime_6` (sudah di pipeline produksi), bukan forecast magnitude.** Untuk melewati 0.63 perlu sumber data yang genuinely baru atau target/horizon yang fundamental berbeda — belum ada kandidat konkret. **Riset ini sekarang benar-benar mentok tanpa input baru dari user.**

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
