# Konteks

Saya sedang eksplorasi apakah ada sinyal prediktif yang bisa dipakai dari data Bitcoin (BTC) yang gratis dan publik — bukan untuk bikin trading bot produksi, tapi untuk cek apakah ini feasible sama sekali, dan kalau iya, jalur mana yang paling menjanjikan dari yang sudah dicoba vs belum.

## Data yang dikumpulkan (semua gratis, publik)

- **OHLCV** (candle 1h/4h/1d) sejak Agustus 2017, dari Binance (lewat mirror `data-api.binance.vision` — API normalnya di-geoblock untuk infra berbasis US)
- **CME Bitcoin futures COT** (Commitments of Traders), mingguan sejak April 2018, dari CFTC.gov — data positioning institusional resmi (long/short non-commercial/spekulan, long/short commercial/hedger, open interest)
- **Fear & Greed Index**, harian sejak Februari 2018, dari alternative.me
- **Hashrate network Bitcoin**, harian sejak 2009, dari mempool.space
- **Stablecoin (USDT+USDC) market cap**, harian, dibatasi 365 hari terakhir saja (kebijakan free-tier CoinGecko)
- **BTC dominance %**, snapshot harian, tapi tanpa akses historis (CoinGecko free tier) — cuma terakumulasi mulai sekarang, praktis tidak terpakai untuk training

Funding rate (perpetual futures) dan data orderbook live dipertimbangkan tapi di-drop — funding rate tidak ada sumber gratis yang tidak ter-geoblock, dan orderbook depth tidak relevan untuk horizon intraday-swing yang saya target.

## Pipeline yang sudah dibangun

1. **Koleksi data** (Node.js) — backfill + sync incremental tiap sumber. Bug nyata yang ditemukan & diperbaiki: Binance API derivatif return HTTP 451 dari IP cloud berbasis US (geoblocking regulasi), jadi OHLCV spot pakai mirror alternatif; situs CFTC ada di belakang Cloudflare bot-detection yang nge-block `fetch()` Node tapi tidak `curl`; data COT CFTC punya **lag pelaporan ~3 hari nyata** (data "as of" Selasa, dirilis Jumat berikutnya) yang harus dikoreksi supaya tidak ada lookahead bias di join.
2. **Feature engineering** — gabung semua sumber ke grid timestamp OHLCV via forward-fill point-in-time (tidak ada lookahead — nilai cuma "terlihat" setelah benar-benar publik). Hitung indikator teknikal dari harga (return di beberapa horizon, RSI, MACD, ATR, Bollinger %B, sinyal trend SMA/EMA, rolling z-score return/volume) dan konteks eksternal (COT positioning dinormalisasi jadi % open interest dan rolling z-score open interest — angka mentah COT trending naik terus seiring tahun karena pasar futures makin matang, jadi harus dinormalisasi supaya tidak jadi confound; nilai Fear&Greed; hashrate; stablecoin supply; dominance).
3. Dua implementasi independen dari tahap cleaning/merge (satu di Node, satu di pandas) saling divalidasi cocok, untuk memastikan benar.
4. **Modeling** — latih Logistic Regression, Random Forest, Gradient Boosting (sklearn HistGradientBoosting), MLP, dan LSTM (PyTorch) untuk prediksi arah harga biner di 2 horizon (~1 hari & ~3 hari di candle 4h; ~6 hari & ~18 hari di candle 1d), dievaluasi lewat (a) single chronological split 80/20 dan (b) walk-forward cross-validation 4-fold (expanding window), dibandingkan ke 2 baseline naif (prediksi kelas mayoritas, prediksi arah sama dengan return terakhir).
5. Juga dicoba regresi (prediksi besaran return, bukan cuma arah) — algoritma sama, dievaluasi pakai MAE/RMSE/R².
6. **EDA** — konfirmasi return stationary (ADF test) sementara harga mentah tidak; konfirmasi autokorelasi return mendekati nol di semua lag sampai 40 (ACF/PACF); konfirmasi secara visual ada volatility clustering yang jelas (periode volatilitas tinggi mengelompok di 2018, crash COVID 2020, awal 2022 — bukan acak); dan menemukan bahwa net positioning non-commercial COT punya korelasi terkuat dengan forward return dari semua fitur tunggal (~-0.15 sampai -0.18 di horizon 1-2 bulan, arah kontrarian — speculative long yang crowded cenderung mendahului return yang lebih lemah), meski efek ini hilang khusus saat tren bull yang kuat dan sustained (rally ETF 2023-2024).
7. **Diagnostik** — cek multikolinearitas fitur (ditemukan redundansi signifikan, satu pasang fitur korelasinya 0.997-1.0, praktis duplikat), uji apakah memangkas ke fitur yang lebih sedikit/bersih memperbaiki hasil — di bawah walk-forward CV yang rigorous, **tidak** secara meyakinkan (model tree-based sudah cukup robust terhadap fitur redundan; model fitur tunggal yang awalnya terlihat mengalahkan model fitur lengkap di satu split kehilangan keunggulannya di bawah CV, mengekspos perbandingan awal itu sebagai fluke single-split lagi).

## Hasil jujur sejauh ini

Tidak ada algoritma, di horizon manapun yang diuji, menunjukkan edge prediksi arah yang bertahan di walk-forward cross-validation dengan margin yang nyaman. Hasil terbaik yang bertahan CV: Random Forest di candle 4h / horizon ~1 hari, mean ROC-AUC 0.528 (std 0.018) di 4 fold ekspanding — tipis di atas garis lempar-koin 0.50. Regresi (prediksi besaran return) malah lebih buruk — semua model kecuali Random Forest punya R² negatif (lebih buruk dari menebak nol), dan R² Random Forest (~0.0015) secara statistik sama dengan nol. Model deep learning (LSTM) tidak pernah mengungguli model tabular yang lebih sederhana di eksperimen manapun.

Satu lead dengan rasionalisasi ekonomi yang masuk akal dan bertahan sebagian di out-of-sample: COT contrarian positioning (speculative long crowded → forward return lebih lemah), tapi lemah secara absolut (R²~3%) dan gagal saat rezim bull yang kuat.

## Yang belum dicoba

- Reframe target prediksi dari "arah harga" ke "rezim volatilitas" (volatilitas tinggi vs rendah) — dimotivasi oleh volatility clustering yang jelas secara visual di EDA, yang (beda dengan arah harga) adalah fenomena nyata yang terdokumentasi baik di pasar finansial (volatility clustering tipe-GARCH), bukan mendekati random walk.
- ARIMA/SARIMAX — analisis ACF/PACF menunjukkan nyaris tidak ada struktur autokorelasi untuk ARIMA murni eksploitasi, tapi SARIMAX dengan exogenous regressor (COT/sentiment) belum diuji.
- Metrik on-chain di luar hashrate (misal exchange netflow, active addresses) — di-skip karena ketersediaan API gratisnya lebih lemah.
- Ensemble/stacking dari model yang sudah ada.
- Treat ini sebagai masalah klasifikasi rezim yang lebih luas (trending vs ranging market) ketimbang murni arah atau murni volatilitas.

## Pertanyaan saya untuk kamu

Saya ingin opini strategis yang jujur — bukan dukungan semu:

1. Dengan semua di atas, apakah ada angle atau target variable yang fundamentally berbeda yang harus saya coba, ketimbang terus iterasi di varian model prediksi-arah?
2. Apakah ide volatility-regime itu benar-benar lebih learnable daripada arah harga, atau itu cuma intuisi yang harus saya stress-test dulu sebelum invest waktu lebih lanjut?
3. Adakah pitfall yang dikenal di riset prediksi crypto retail/akademis (jebakan overfitting, data-snooping, isu semacam survivorship-bias) yang pipeline ini masih rawan terhadapnya, bahkan setelah perbaikan lookahead-bias dan normalisasi yang sudah dilakukan?
4. Apakah ada titik di mana "tidak ditemukan sinyal walau metodologinya cukup hati-hati" harus diterima begitu saja sebagai jawaban, dan kalau iya, apa yang akan meyakinkan kamu bahwa itu kasusnya di sini?
