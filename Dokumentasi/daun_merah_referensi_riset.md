# Daun Merah — Rujukan Riset Akademis (Constraint / Method / Application Papers)

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Daftar pustaka permanen — dokumen/paper peneliti eksternal + relevansinya ke Daun Merah.
BOLEH    : Sitasi TERVERIFIKASI ke sumber primer (author/tahun/jurnal dicek via web, bukan dari
           klaim LLM) + tipe (Constraint/Method/Application) + temuan inti + implikasi ke proyek.
DILARANG : Riset internal/eksperimen sendiri (-> daun_merah_riset.md), sitasi belum diverifikasi,
           changelog (-> daun_merah.md).
FORMAT   : Tabel per kategori topik: | Paper | Tipe | Temuan inti | + blok "Implikasi untuk
           Daun Merah" per kategori.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-07-10 (Session 155, lanjutan)
> **Tujuan:** perpustakaan rujukan permanen yang dicek SEBELUM memulai proyek makro/forex baru di Daun Merah — supaya tidak menghabiskan waktu membuktikan ulang batas yang sudah diketahui literatur (pola yang terjadi di riset NFP, lihat [[nfp-causal-research-framework]] / Session 150-153 di `daun_merah.md`).
> **Metodologi verifikasi:** semua sitasi di bawah dicek via web search terhadap sumber primer (NBER/JSTOR/jurnal/RePEc) sebelum dimasukkan — bukan disalin mentah dari konsultasi LLM lain. Kalau ada sitasi baru mau ditambahkan ke file ini, verifikasi dulu (author/tahun/jurnal), jangan percaya nama paper dari LLM tanpa cek.

Tiga kategori per paper:

- **Constraint** — batas teoritis/empiris: apa yang KEMUNGKINAN tidak bisa dilakukan
- **Method** — pendekatan yang valid untuk domain yang batasnya sudah diketahui
- **Application** — implementasi nyata di trading/kebijakan

---

## 1. Prediktabilitas nilai tukar (relevan: Thesis AI — `pair_recommendation`, `direction`)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Meese & Rogoff (1983), *Journal of International Economics* | Constraint | Model fundamental makro (inflasi, suku bunga, money supply) tidak mengalahkan random walk di horizon pendek. Fondasi seluruh literatur ini. |
| Cheung, Chinn & Pascual (2005) *"Empirical Exchange Rate Models of the Nineties: Are Any Fit to Survive?"* + follow-up 2019 *"Exchange Rate Prediction Redux"* (NBER w23267) | Constraint | Temuan Meese-Rogoff masih bertahan >20 tahun kemudian dan model/spesifikasi/currency yang bagus di satu periode belum tentu bagus di periode lain (regime-dependent). |
| Rossi (2013), *Journal of Economic Literature*, "Exchange Rate Predictability" | Constraint/Method | Survei besar: performa model sangat bergantung rezim, hubungan fundamental berubah antar-waktu, evaluasi out-of-sample jauh lebih penting dari in-sample. |
| Kwas, Beckmann & Rubaszek (2024), *International Journal of Forecasting* 40(1), 268-284, "Are consensus FX forecasts valuable for investors?" | Application | Forecast profesional (median konsensus) berguna sebagai input portofolio meski tidak selalu unggul secara statistik vs benchmark klasik (carry, momentum). |
| Aşırım, İlgar, Aşırım, Salepçioğlu & Asirim (2026), *Financial Innovation* 12:63, "Modeling foreign exchange rates as stochastic difference equations with minimum uncertainty for prediction analysis", DOI 10.1186/s40854-025-00858-w | Method (klaim diragukan — lihat catatan kritis) | Model AR(16) adaptif (Recursive Least Squares, window bergeser di-refit tiap sample) di-fit langsung ke LEVEL harga FX per jam (bukan return). Window training lebih besar → variance & volatilitas (ACF width) koefisien mengecil drastis → diklaim reduksi >60% root-relative-square error prediksi 24 jam ke depan (AUD/USD, EUR/GBP, data jam Metatrader-4 2015-2018), akurasi diklaim setara LSTM/CNN dengan biaya komputasi jauh lebih rendah. |

**Implikasi untuk Daun Merah:** Thesis AI (Call 3 `market-digest.js`) sudah secara implisit konsisten dengan ini — tidak pernah diklaim sebagai "prediksi harga", tapi narasi tesis berbasis kondisi makro/teknikal terkini dengan invalidation trigger eksplisit. Jangan pernah menambahkan fitur yang mengklaim akurasi arah harga FX jangka pendek dari fundamental murni — literatur ini sudah menutup jalur itu.

**Catatan kritis paper Aşırım dkk. (dibaca lengkap 2026-08-17, dikirim user via fitur artikel):** paper ini SAMA SEKALI tidak membandingkan hasil ke baseline random-walk/naif ("harga besok = harga hari ini") — pelanggaran paling dasar terhadap kaidah Rossi (2013) tepat di atas: evaluasi out-of-sample WAJIB terhadap random walk. FX per jam sangat persisten (mendekati unit-root); AR(16) yang di-refit ke LEVEL harga (bukan return/log-diff) nyaris pasti menghasilkan koefisien yang jumlahnya ≈1 (persistence), sehingga model ini kemungkinan besar cuma meniru random walk dengan bungkus statistik rumit — error 0,7–1,9%/24 jam BUKAN bukti skill prediktif tanpa pembanding "tidak berubah". Kelemahan tambahan: tanpa biaya transaksi/spread, hanya 1 periode 2015-2018 (tidak walk-forward lintas rezim), hanya 2 pair, segmen RLS overlapping (residual berkorelasi, understate uncertainty). **Verdict: paper ini justru MEMPERKUAT sikap skeptis §1 di atas, bukan mengoreksinya.** Dicatat sebagai referensi/jebakan kalau ide serupa (adaptive AR/RLS sebagai modul prediksi harga) muncul lagi di masa depan — BUKAN kandidat implementasi. Tidak ada tindakan untuk Daun Merah: Plan W tetap beku sampai gate n≥100 (lihat `professional_llm_trader/`), dan arsitektur Daun Merah (AI-fundamental+gate) tidak butuh modul black-box price-only semacam ini.

---

## 2. Data makro vs konsensus pasar (relevan: proyek NFP — sudah STOP)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Klein (2022) | Constraint | Model berbasis indikator publik sangat sulit mengalahkan median konsensus profesional — informasinya sudah diketahui & diproses semua peserta pasar. |

**Status:** sudah dipakai penuh di [[nfp-causal-research-framework]]. Proyek NFP STOP (0/25 Fase 1 + 3 celah tuntas). Jangan diusulkan ulang tanpa data/metode genuinely baru.

---

## 3. Nowcasting — kondisi ekonomi saat ini, bukan prediksi masa depan (relevan: Labour Market Assessment, sudah dieksekusi S154)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Giannone, Reichlin & Small (2008), *Journal of Monetary Economics* 55, 665-676, "Nowcasting: The Real-Time Informational Content of Macroeconomic Data" | Method | Metode formal mengevaluasi dampak marjinal tiap rilis data intra-bulan terhadap estimasi kondisi ekonomi saat ini ("jagged edge" data — rilis tidak sinkron). Kerja seminal nowcasting bank sentral. |

**Implikasi:** [[labour-market-assessment-pivot]] (blok Ketenagakerjaan di detail USD, `api/_labour_market.js`) SECARA SEMANGAT sudah menjalankan prinsip ini — "9 dari X indikator searah" adalah nowcast kondisi tenaga kerja saat ini, bukan prediksi rilis mendatang, dengan label eksplisit "Konteks, bukan sinyal — data sudah priced-in". Paper ini memberi dasar metodologis retroaktif untuk pendekatan yang sudah dipilih. Pola ini bisa direplikasi untuk dimensi makro lain (inflasi, growth) kalau user minta assessment serupa.

---

## 4. Kombinasi indikator/forecast (relevan: agregasi banyak indikator jadi satu label)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Bates & Granger (1969) | Method | Kombinasi beberapa forecast biasanya lebih akurat & robust (MSFE lebih rendah) daripada satu model terbaik. |
| Timmermann (2006), survei | Method | Konfirmasi: kombinasi forecast umumnya menang vs model tunggal. |
| Literatur "forecast combination puzzle" (mis. Claeskens et al., *Solving the Forecast Combination Puzzle* 2023) | Constraint | Bobot optimal (estimated optimal weights) sering justru KALAH dari simple average di aplikasi nyata — rata-rata sederhana lebih robust daripada pembobotan canggih. |

**Implikasi:** ini justru validasi desain existing — `buildAssessment()` di labour market pakai **agreement count sederhana** (berapa dari N indikator searah), bukan bobot statistik rumit. Forecast combination puzzle bilang itu pilihan yang tepat, bukan penyederhanaan yang kurang canggih. Jangan "upgrade" ke pembobotan optimal tanpa bukti kuat — literatur justru mengarah ke arah sebaliknya.

---

## 5. Efek informasi bank sentral (relevan: invalidation trigger seputar FOMC/rate decision)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Nakamura & Steinsson (2018), *Quarterly Journal of Economics* 133(3), 1283-1330, "High-Frequency Identification of Monetary Non-Neutrality: The Information Effect" | Constraint/Method | Pengumuman bank sentral bergerakkan pasar bukan cuma lewat perubahan suku bunga itu sendiri, tapi juga lewat "information effect" — mengungkap info privat bank sentral tentang kondisi ekonomi yang mengubah ekspektasi pasar terhadap growth/inflasi. |

**Implikasi:** kalau Thesis AI atau invalidation trigger menyinggung keputusan FOMC/ECB, jangan hanya baca arah suku bunga (hawkish/dovish) — pertimbangkan juga apakah pasar bereaksi karena *policy shock* (kenaikan/penurunan itu sendiri) atau *information shock* (isi statement mengungkap pandangan bank sentral soal ekonomi yang berbeda dari ekspektasi). Belum ada implementasi eksplisit soal ini di kode — dicatat sebagai referensi untuk kalau fitur macro-event interpretation diperdalam.

---

## 6. Reaksi pasar terhadap rilis berita makro (relevan: bug Session 152 & 155 — thesis alert/invalidation salah baca headline)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Andersen, Bollerslev, Diebold & Vega (2003), *American Economic Review* 93(1), 38-62, "Micro Effects of Macro Announcements: Real-Time Price Discovery in Foreign Exchange" | Constraint/Method | Surprise rilis makro (actual vs ekspektasi survei) memicu lonjakan mean FX jangka pendek yang jelas dan cepat; ada *sign effect* — bad news berdampak lebih besar dari good news yang magnitude-nya sama. |

**Implikasi:** mengonfirmasi bahwa fondasi arsitektur kalender Daun Merah (bandingkan actual vs consensus, bukan level absolut) sudah benar secara literatur. Relevan langsung ke dua bug yang baru diperbaiki: Session 152 (Thesis Alert salah kutip "Currency Strength Chart" — itu price-derived, bukan surprise rilis, jadi memang seharusnya diabaikan sebagai bukti kontradiksi) dan Session 155 (invalidation trigger salah comot currency di luar pair). Paper ini memberi alasan akademis kenapa aturan "surprise vs consensus, bukan level harga" itu prinsip yang benar untuk dipertahankan ketat di prompt manapun yang menghasilkan trigger/alert.

---

## 7. ⚠️ Positioning spekulatif/retail sebagai sinyal kontrarian (relevan: **fitur LIVE** — Retail Sentiment `api/feeds.js`, dipakai di Journal/Sizing/Scenario Comparison)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Klitgaard & Weir (2004), *Federal Reserve Bank of New York Economic Policy Review*, "Exchange Rate Changes and Net Positions of Speculators in the Futures Markets" | Constraint | Data CFTC net position spekulan berkorelasi **kontemporer** kuat dengan pergerakan FX mingguan — TAPI hubungan itu **tidak terbukti prediktif** untuk pergerakan ke depan. |
| Menkhoff & Taylor (2007), *Journal of Economic Literature*, "The Obstinate Passion of Foreign Exchange Professionals: Technical Analysis" | Application | 30-40% trader FX profesional mengaku analisis teknikal jadi basis keputusan utama horizon pendek — memberi konteks kenapa positioning ekstrem retail sering jadi mitos "kontrarian" di kalangan trading tanpa dasar akademis kuat. |
| Menkhoff (2008), *Journal of Empirical Finance*, "Investor Sentiment in the US-Dollar" | Application | Sentimen investor punya orientasi non-linear jangka panjang terhadap PPP — bukan sinyal kontrarian jangka pendek sederhana. |

**⚠️ Ini temuan paling penting dari riset kali ini, dan berbeda dari yang lain karena menyentuh fitur yang SUDAH LIVE dan mendorong keputusan nyata (bukan proyek yang sudah di-kill seperti NFP).**

Pencarian literatur akademik (bukan blog trading) untuk "retail positioning ekstrem = sinyal reversal" mayoritas hanya menemukan konten praktisi/blog trading tanpa validasi statistik formal — kecuali Klitgaard & Weir (2004, NY Fed, sumber paling kredibel yang ditemukan) yang justru **menyangkal** klaim prediktif itu untuk data CFTC (net position spekulan besar, bukan retail myfxbook, tapi mekanismenya serupa: "ekstrem positioning ⇒ reversal"). Ini konsisten dengan pola Klein/Meese-Rogoff: klaim populer trading yang belum tentu punya dasar akademis kuat.

**Ini BUKAN rekomendasi untuk menghapus fitur retail sentiment** — keputusan produk itu ada di tangan user, dan kontrarian retail-positioning tetap dipakai luas di industri (mungkin bekerja di rezim/horizon tertentu yang literatur akademik belum tangkap, atau nilainya lebih sebagai satu input kecil dalam sizing, bukan sinyal berdiri sendiri). Yang saya catat di sini murni supaya user sadar: **belum ada bukti akademis kuat yang saya temukan yang mendukung "retail positioning ekstrem → reversal" sebagai edge statistik**, beda dengan misalnya prinsip surprise-vs-consensus (#6) yang punya dukungan literatur jelas. Kalau suatu saat mau diuji lebih rigor (mis. gaya kill-gate NFP), ini titik awal yang tepat — dan kemungkinan hasilnya sejalan dengan Klitgaard & Weir.

---

## 8. Efektivitas indikator teknikal & sistem hibrida (relevan: **fitur LIVE** — Confluence Zones & Analisa AI per Pair)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Scopus AI Synthesis Report (2026) *"Technical analysis indicators for forex trading"* | Method / Constraint | Meta-analisis literatur 2010–2024: Tidak ada indikator tunggal yang mendominasi secara konsisten. Sistem hibrida/multi-indicator yang menggabungkan price-derived levels dengan machine learning/adaptasi dinamik terhadap volatility regime memiliki performa terbaik. Bahaya utama adalah multikolinieritas dan overfitting. |

**Implikasi untuk Daun Merah:**

1. **Validasi Arsitektur:** Desain *Confluence Zones* (penggabungan S/R, Fibonacci, Pivot, SMA, Expiry) yang dihitung deterministik di backend sebelum masuk ke prompt Analisa AI sudah 100% sejalan dengan rekomendasi riset ini untuk menggunakan sistem hibrida/multi-indikator guna mengurangi *overfitting* LLM.
2. **Potensi Upgrade (Adaptasi Regim):** Kita bisa membuat toleransi/bobot di `_confluenceZones` dinamis terhadap regim volatilitas (misal: saat volatilitas tinggi/risk-off, kurangi bobot SMA trend-following, naikkan bobot S/R horizontal).
3. **Potensi Noise (Dihindari):** Penambahan model ML optimisasi kompleks (Genetic Algorithm/PSO) atau penambahan indikator momentum redundan (seperti Stochastic/CCI) adalah *noise* yang harus dihindari karena batasan komputasi serverless Vercel Hobby dan risiko multikolinieritas.

---

## 9. Sample size & rigor statistik evaluasi sinyal AI trading (relevan: Plan U — gate fase tes auto-entry & `scripts/backtest_confluence.js`)

| Paper | Tipe | Temuan inti |
|---|---|---|
| Scopus AI Synthesis Report (2026-07-22), *"Evaluating AI/LLM-Generated Financial Trading Signals: Sample Size, Statistical Methodology, and Overfitting Mitigation in Backtesting and Paper Trading"* | Method | Meta-analisis: n ≥ 100 direkomendasikan untuk evaluasi out-of-sample robust (n ≥ 30 cuma batas bawah CLT, sering tidak cukup di praktik); metodologi wajib campuran Monte Carlo, bootstrap/permutation test, t-test/Wilcoxon, dan walk-forward expanding-window; kalibrasi pakai MAE/RMSE/MAPE/R² + metrik kalibrasi (Brier score, expected calibration error); mitigasi overfitting via sampel besar + cross-validation + regularisasi. §5.1 *"Multi-Asset, Multi-Market Testing"*: validasi lintas aset/pasar wajib untuk memastikan generalisasi — sitasi [1][16][40][41] (dikoreksi 2026-07-23 dari nomor #8/#21/#22 yang salah alamat di draf pertama; #22 lama bahkan bukan paper trading — soal bias geografis rekomendasi LLM). Rujukan primer §5.1: [1] Li et al. (2026, *Proc. ACM SIGKDD*) — LLM-based investing strategies; [16] Umadevi et al. (2023, *I-SMAC*) — neural network forex forecasting; [40] Friday et al. (2024, *LNEE*) — ML untuk forex decision-making; [41] Mishra et al. (2025, *AIP Conf. Proc.*) — survei ML algorithmic trading. |

**Implikasi untuk Daun Merah:**

1. **Sudah diimplementasi & dipakai (2026-07-22, `scripts/_stats.js`):** bootstrap 95% CI, permutation test, dan Wilcoxon rank-sum sekarang dipakai di `backtest_confluence.js` — respons langsung terhadap rekomendasi §2.2 report ini. Contoh hasil: beda bounce-rate skor tinggi vs rendah **p=1,000** (permutation) / **p=0,891** (Wilcoxon) — belum signifikan secara statistik pada n saat ini (lihat entri riset aktif di `daun_merah_riset.md`).
2. **Sudah diimplementasi tapi BELUM diterapkan (2026-07-22, `scripts/_stats.js`):** fungsi Brier score & Expected Calibration Error sudah dibuat reusable di modul yang sama (bukan dari nol) — tinggal dipakai untuk item #6 Plan U (kalibrasi antar-provider AI) begitu sampel `confidence_calibration` per provider di `setup_log_auto:v1` cukup (gate n≥100, lihat `daun_merah_progress.md`).
3. **Landasan Plan U Cross-Domain Validation Tahap 2:** §5.1 (sitasi di atas) jadi dasar akademis kenapa validasi Non-USD Cross Pairs harus jadi protokol terpisah (out-of-domain), bukan diasumsikan otomatis berhasil dari hasil in-domain Major USD Pairs — lihat entri riset aktif terkait di `daun_merah_riset.md`.
4. **Belum diimplementasi sama sekali, kandidat item #10 Plan U (nunggu rentang data lebih panjang, lihat `daun_merah_progress.md`):** walk-forward expanding-window untuk gating berbasis rezim — beda dari #2 di atas, ini bukan cuma nunggu n≥100 tapi butuh rentang WAKTU historis lebih panjang (>60 hari, lintas rezim/tahun) supaya ada cukup window temporal untuk digeser.

---

## 10. Manajemen risiko sistem trading otomatis — filter stacking, circuit breaker, regime gate, correlation cap (relevan: audit celah "kesalahan trader" Plan U, 2026-07-28)

4 Scopus AI Synthesis Report (2026-07-28) merespons audit kode yang menemukan 4 celah di pipeline auto-entry (AI Kritikus tidak terpasang, tidak ada circuit breaker loss beruntun, `risk_regime` cuma teks di prompt, tidak ada cap eksposur lintas-pair) — dan kekhawatiran user bahwa menambahkan ke-4 gate sekaligus akan membuat sistem terlalu ketat. Sitasi inti (4 dari puluhan yang dikutip tiap report) **diverifikasi manual via web search terhadap sumber primer** sesuai aturan file ini:

| Paper | Tipe | Temuan inti |
|---|---|---|
| Varma (2025), *"The False Promise of Drawdown Rules: New Evidence and a Better Framework"*, Journal of Portfolio Management 52(1), 145-161, DOI 10.3905/jpm.2025.1.765 | Constraint | Ambang drawdown TETAP (fixed) bisa memperkuat kerugian alih-alih menahannya (data ETF & long-short 1993-2022); metrik CDAP (coherent drawdown-adjusted performance) dan kerangka adaptif berbasis rezim pasar + sinyal risiko sistematik jauh lebih robust dari aturan biner. |
| Moreira & Muir (2017), *"Volatility-Managed Portfolios"*, Journal of Finance 72(4), 1611-1644 | Method | Portofolio yang menurunkan UKURAN posisi (bukan berhenti total) saat volatilitas naik menghasilkan alpha & Sharpe ratio jauh lebih tinggi — berlaku lintas banyak faktor termasuk **currency carry trade**. Bukti landasan kenapa "reduce size" > "skip entirely" untuk gate volatilitas. |
| Zhao, Ledoit & Jiang (2023), *"Risk Reduction and Efficiency Increase in Large Portfolios: Gross-Exposure Constraints and Shrinkage of the Covariance Matrix"*, Journal of Financial Econometrics 21(1), 73-105 | Method | Shrinkage estimator korelasi/kovarians yang dipilih tepat SELALU mengalahkan batas gross-exposure sembarangan — tapi studi ini berbasis portofolio besar (institusional), penerapan ke skala retail 4-pair Daun Merah bersifat heuristik, bukan literal. |
| Subrahmanyam (1994), *"Circuit Breakers and Market Volatility: A Theoretical Perspective"*, Journal of Finance 49, 237-254 | Constraint | Paper fondasi "magnet effect": circuit breaker (termasuk halt berbasis N-loss-beruntun) bisa PARADOKS memperbesar volatilitas — trader/algo mempercepat aksi mendekati ambang batas untuk menghindari terkunci, ambang kaku (bukan dinamis) berisiko menciptakan halt palsu. |

**Ringkasan sintesis 4 report** (tidak semua ~90 sitasi lain diverifikasi satu-satu — hanya 4 di atas + pola konsisten across 4 report independen):

- **Filter-stacking:** kekhawatiran user TERBUKTI BERALASAN secara literatur — menumpuk filter konservatif memang mengurangi frekuensi trade & bisa menurunkan performa kalau ambangnya STATIS/kaku. TAPI solusinya bukan batalkan filter, melainkan pakai ambang ADAPTIF (regime-switching, Kalman filter, ML) — tidak ada studi yang menguji ke-4 filter bersamaan persis, tapi bukti komponen konsisten mendukung kombinasi asal adaptif.
- **Circuit breaker:** drawdown-based (persentase kerugian) lebih didukung bukti empiris daripada consecutive-loss (hitung kekalahan beruntun) — yang terakhir rawan "magnet effect" (Subrahmanyam 1994, dikonfirmasi ulang di pasar China modern). Kalau mau circuit breaker, prioritaskan berbasis drawdown/volatilitas yang adaptif, bukan sekadar hitung N-loss-beruntun statis.
- **Gate regime volatilitas (VIX):** TIDAK ADA studi head-to-head langsung "skip entry" vs "reduce size" khusus FX — tapi bukti tidak langsung + Moreira & Muir (2017) condong ke "reduce size" (position sizing dinamis) lebih superior untuk drawdown/tail-risk daripada skip total (dianggap "blunt instrument"). Tidak ada ambang VIX universal (rentang 15-59 disitasi, tidak standar) — model dinamis/regime-switching lebih disarankan dari cutoff tetap.
- **Correlation cap:** HRP (Hierarchical Risk Parity), shrinkage estimator, dan gross-exposure constraint sederhana adalah heuristik yang cocok untuk portofolio skala retail 20-50 instrumen TANPA perlu optimasi covariance-matrix penuh — tapi bukti lebih kuat di ekuitas/multi-aset dibanding FX murni, dan portofolio retail justru LEBIH rentan ke lonjakan korelasi saat event makro (bias perilaku + posisi terkonsentrasi) — bukan alasan untuk mengabaikan gate ini di sistem kecil, justru sebaliknya.

**Implikasi untuk Daun Merah:** kalau ke-4 gate dari audit (`daun_merah_progress.md` — audit celah kesalahan trader) jadi dieksekusi, benang merah dari SEMUA topik adalah sama: **pilih ambang dinamis/adaptif, hindari cutoff statis/biner** — bukan batalkan gate-nya. Belum diputuskan eksekusi kode apa pun; nunggu keputusan user pasca-riset ini.

**Update Session 251 (2026-07-28, sesi sama):** Gate C (regime confidence bar) DIHAPUS — celah yang ditemukan user: fungsi ini buta arah (blok confidence rendah saat regime stres TANPA cek align bias vs regime), jadi XAU/USD bullish saat risk_off (selaras teori safe-haven) tetap diblokir walau arahnya sendiri benar. Keputusan: skeptisisme regime seharusnya bagian penalaran AI thesis (yang sudah baca `risk_regime` di prompt Analisa/pre-entry check), bukan filter buta terpisah. Sisa aktif: Gate A, B, D — analisis Moreira & Muir (2017) di atas ("reduce size" > "skip total") jadi TIDAK diterapkan sebagai gate kode terpisah, dikembalikan ke penalaran AI di prompt.

---

## 11. Noise vs sinyal dari stacking gate audit-guard existing (relevan: `api/_auto_entry_guard.js`, 2026-07-28)

Riset lanjutan atas §10 — TUJUANNYA BUKAN cari gate baru, tapi cek apakah menumpuk Gate A (AI Kritikus) + B (drawdown circuit breaker) + D (correlation cap) sekaligus berisiko jadi over-filtering/noise (mengeblok setup yang sebenarnya profitable) dibanding manfaat nyata. (Ditulis saat masih 4 gate — Gate C dihapus sesi yang sama, lihat update di §10 di atas; analisis di bawah ini tentang prinsip stacking filter secara umum, tetap berlaku untuk 3 gate sisa.)

| Paper | Tipe | Temuan inti |
|---|---|---|
| White (2000), *Econometrica* 68(5), "A Reality Check for Data Snooping" | Constraint | Menguji banyak aturan/kondisi pada data yang sama membuat performa "terbaik" yang ditemukan rentan bias seleksi (data snooping) — perlu test formal (Reality Check/bootstrap), bukan asumsi bahwa aturan yang lolos backtest otomatis genuinely superior. |
| Bajgrowicz & Scaillet (2012), *Journal of Financial Economics* 106(3), 473-491, "Technical Trading Revisited: False Discoveries, Persistence Tests, and Transaction Costs" | Constraint | Dari 7.846 aturan trading di DJIA 1897-2011: false discovery rate test menyaring lebih ketat dari metode lama, TAPI bahkan aturan yang lolos persistence test tidak bisa dipilih ex-ante sebagai pemenang masa depan, dan performa in-sample sekalipun HABIS oleh biaya transaksi kecil sekalipun. |

**Verdict jujur, bukan dipaksakan:** TIDAK ditemukan paper yang langsung menguji "stacking N filter risiko independen yang masing-masing sudah bukti-basis (bukan hasil data-mining) menyebabkan over-filtering di sistem trading real" — pola yang sama seperti §7 (retail positioning): literatur akademik finance banyak bicara soal bahaya MENAMBAH/MENGOPTIMASI aturan cari sinyal terbaik (data snooping, disitasi di atas), bukan soal MENUMPUK kontrol risiko yang tiap komponennya sudah divalidasi terpisah dari literatur berbeda (Subrahmanyam 1994, Moreira & Muir 2017, Zhao-Ledoit-Jiang 2023 — lihat §10). Dua hal ini secara konsep berbeda: data-snooping soal mencari-cari SINYAL entry terbaik dari banyak kombinasi; ke-4 gate Daun Merah adalah FILTER PENOLAK yang sudah pre-registered sebelum data dikumpulkan, bukan hasil pencarian kombinasi terbaik.

**Implikasi untuk Daun Merah:** karena tidak ada dasar akademis langsung untuk mengklaim ke-4 gate ini "terlalu banyak" ATAU "aman ditumpuk", **jangan tambah/kurangi gate berdasar riset ini** — pertanyaan "apakah gate ini terlalu sering menahan setup yang sebenarnya TP" adalah pertanyaan EMPIRIS, dan instrumentasinya SUDAH ADA: counter `auto_guard_stats:*` (commit `062fc16`) mencatat frekuensi tiap gate nyala. Yang belum ada — dan SENGAJA belum dibuat karena "lebih besar dari pencatatan ringan yang diminta" (catatan commit `062fc16` sendiri) — adalah pola counterfactual (`_evaluateCanceledGhost`-style) untuk tahu apakah setup yang digagalkan gate itu SEBENARNYA akan TP atau SL kalau tetap dieksekusi. Itu satu-satunya cara valid menjawab noise-vs-sinyal di sini, bukan riset literatur tambahan — cek berkala `setup_stats`/`auto_guard_stats` begitu sampel cukup, bukan sebelum itu.

---

## 12. Mempercepat proses riset kami sendiri (Scopus AI + verifikasi) tanpa mengorbankan rigor (relevan: metodologi file ini sendiri, §"Cara pakai file ini" di bawah)

Dipicu permintaan user 2026-07-28: cari cara mempercepat riset TANPA merusak kualitas (atau kalau bisa meningkatkan) — kalau tidak ada, tidak apa. Ada temuan konkret dan relevan langsung ke workflow verifikasi yang sudah jadi SOT file ini ("semua sitasi dicek via web search terhadap sumber primer, bukan disalin mentah dari klaim LLM").

| Paper | Tipe | Temuan inti |
|---|---|---|
| Khraisha et al. (2024), *Research Synthesis Methods* 15(4), 616-626, "Can large language models replace humans in systematic reviews?" | Constraint | Evaluasi GPT-4 "human-out-of-the-loop" (LLM murni tanpa verifikasi manusia) untuk screening/ekstraksi data: akurasi mentah terlihat setara manusia, TAPI setelah dikoreksi untuk chance agreement + ketidakseimbangan dataset, performa turun jadi tanpa-agreement s/d moderat tergantung rasio data. LLM sendirian BELUM cukup andal untuk sepenuhnya menggantikan verifikasi manusia. |
| Cao et al. (2025), *Annals of Internal Medicine* 178, 389-401, "Development of Prompt Templates for Large Language Model–Driven Screening in Systematic Reviews" | Method | Template prompt generik yang terstruktur dengan baik, diuji ke 48.425 sitasi lintas 10 systematic review: sensitivitas screening abstrak rata-rata **97,7%**, spesifisitas **85,2%** — jauh lebih baik dari pendekatan ad-hoc, membuktikan LLM-assisted screening BISA cepat dan cukup andal KALAU prompt/kriterianya terstruktur jelas, bukan sekadar "baca lalu putuskan". |
| Pham et al. (2016), *Research Synthesis Methods*, "Implications of applying methodological shortcuts to expedite systematic reviews" | Constraint | 3 studi kasus: memotong langkah metodologis (search dipersempit, single-reviewer tanpa cross-check, dst.) membuat rata-rata studi relevan TERLEWAT di 39 dari 143 kemungkinan meta-analisis (14 di antaranya jadi tidak bisa dilakukan sama sekali karena studi tersisa <2) — arah kesimpulan biasanya tidak berubah, tapi presisi estimasi (confidence interval) melebar/kesimpulan jadi lebih lemah. |
| Tricco et al. (2022), *JBI Evidence Synthesis*, "Rapid reviews and the methodological rigor of evidence synthesis: A JBI position statement" | Method | Rapid review yang SAH secara metodologis tetap mempertahankan elemen inti (kriteria eligibilitas jelas di awal, pencarian yang cukup komprehensif untuk pertanyaan spesifik, minimal spot-check kualitas) — "cepat" berarti mempersempit SCOPE pertanyaan (bukan jumlah pertanyaan sekaligus) dan bukan menghapus langkah verifikasi, bukan berarti melonggarkan standar bukti. |

**Sintesis** (bukan dipaksakan — langsung actionable ke workflow file ini):

1. **Konfirmasi validasi arsitektur existing:** kewajiban file ini (WebSearch verifikasi tiap sitasi ke sumber primer sebelum ditulis, bukan salin mentah dari respons LLM/Scopus abstract metadata) itu TEPAT dan punya dasar — Khraisha (2024) membuktikan LLM murni tanpa verifikasi manusia performanya turun signifikan setelah dikoreksi bias. **Jangan pernah dilonggarkan** jadi "percaya judul+abstrak Scopus AI langsung tanpa cek" — itu persis "methodological shortcut" yang Pham (2016) buktikan berisiko melewatkan temuan relevan.
2. **Peluang percepatan nyata yang AMAN (dari Cao 2025):** triase awal (dari puluhan hasil `search_scopus` mentah, pilih mana yang layak dibaca detail/verifikasi) bisa dipercepat dengan kriteria inklusi yang DITULIS EKSPLISIT di awal sebelum search (jenis topik, rentang tahun, jurnal/sumber primer vs predatori, jumlah sitasi minimum) — bukan menilai satu-satu tanpa kriteria. Ini murni mempercepat tahap TRIASE, bukan menggantikan verifikasi akhir yang tetap wajib manual per sitasi yang benar-benar dikutip ke file ini.
3. **Tidak ada rekomendasi mengurangi verifikasi manual** — satu-satunya cara aman mempercepat (triase terstruktur di awal) sudah konsisten dengan cara kerja sesi ini sendiri (2026-07-28: dari ~15 query pencarian, hanya sitasi yang lolos verifikasi web search primer yang masuk §11/§12 di atas).

---

## 13. Kualitas & akurasi eksekusi auto-entry — penempatan SL, jam eksekusi, biaya transaksi, lapis filter sekunder, ensemble LLM (relevan: pipeline auto-entry `api/admin.js` + `vps/daemon.js`, 2026-07-28)

Riset baru atas permintaan user ("apa yang bisa membuat auto-entry lebih akurat & berkualitas"). **Kriteria inklusi ditulis SEBELUM search** (metode §12 poin 2, mempercepat triase tanpa mengurangi verifikasi):

- (a) topik harus menyentuh komponen pipeline auto-entry yang SUDAH ADA — penempatan SL/TP, waktu eksekusi, biaya transaksi, lapis filter sekunder, keandalan keputusan LLM — bukan ide fitur baru;
- (b) jurnal peer-review terindeks Scopus / NBER / working paper bank sentral, tolak blog praktisi;
- (c) empiris diutamakan ≥2005, seminal boleh lebih tua;
- (d) tiap sitasi yang dikutip ke file ini WAJIB lolos verifikasi web ke sumber primer (judul/penulis/jurnal/volume/halaman).

Dari ~90 hasil `search_scopus` mentah lintas 6 query, 8 paper di bawah yang lolos.

### 13a. Kapan aturan stop-loss benar-benar menolong

| Paper | Tipe | Temuan inti |
|---|---|---|
| Kaminski & Lo (2014), *Journal of Financial Markets* 18, 234-254, "When do stop-loss rules stop losses?" | Constraint/Method | Di bawah random walk, aturan stop-loss sederhana SELALU menurunkan expected return. Stop-loss baru menghasilkan "stopping premium" positif di proses return yang lebih realistis: **momentum atau regime-switching**. Empiris ekuitas AS 1950-2004: aturan tertentu menambah 50-100 bp/bulan selama periode stop-out. |
| Lo & Remorov (2017), *Journal of Financial Markets* 34, 1-15, "Stop-loss strategies with serial correlation, regime switching, and transaction costs" | Constraint | Diuji ke sampel besar saham individual AS: **stop-loss yang KETAT cenderung kalah dari buy-and-hold** dalam kerangka mean-variance karena biaya trading berlebih. Outperformance hanya mungkin untuk aset dengan korelasi serial return cukup tinggi; sebagian strategi berhasil menekan downside risk, tapi tidak substansial. |
| Arratia & Dorador (2019), *Quantitative Finance* 19(11), 1857-1873, "On the efficacy of stop-loss rules in the presence of overnight gaps" | Method | 4 implementasi stop-loss populer diuji pada model return yang MEMASUKKAN overnight gap (loncat harga close→open) dan flash crash, lintas model random walk/autoregressive/regime-switching. Kesimpulan umum: **stop-loss tetap memperbaiki expected risk-adjusted return di pasar naik dan expected return absolut di pasar turun, walau gap dimodelkan** — gap bukan alasan meninggalkan aturan stop. |

**Implikasi untuk Daun Merah:**

1. **Lever yang relevan bukan "pakai SL atau tidak" (SL wajib, sudah benar), tapi JARAK SL relatif volatilitas.** Kaminski-Lo + Lo-Remorov sama-sama menunjuk arah yang sama: stop terlalu ketat merusak. Pipeline saat ini membiarkan LLM memilih SL dari zona konfluensi tanpa lantai jarak minimum berbasis ATR — padahal ATR14 H1 SUDAH dihitung deterministik di `api/_pair_context.js`. Ini bisa DIUKUR dari data yang sudah terkumpul (bandingkan `sl` distance/ATR vs tingkat kena SL di `setup_log_auto:v1`) sebelum satu baris kode pun diubah.
2. **Caveat kejujuran:** ketiga paper menguji aturan EXIT atas posisi yang sudah dipegang (mayoritas ekuitas), bukan setup entry ber-R tetap seperti Daun Merah. Analoginya parsial — jangan dikutip seolah membuktikan aturan SL Daun Merah unggul.
3. **Tighten preventif Jumat (`runFridayTightenCycle`) dapat dukungan tidak langsung** dari Arratia & Dorador: aturan stop tetap efektif walau gap akhir pekan diperhitungkan. Tidak ada bukti yang menuntut perubahan perilaku ini.

### 13b. Periodisitas intraday FX — apakah jam eksekusi penting

| Paper | Tipe | Temuan inti |
|---|---|---|
| Andersen & Bollerslev (1997), *Journal of Empirical Finance* 4(2-3), 115-158, "Intraday periodicity and volatility persistence in financial markets" | Method | Kerja seminal (>750 sitasi Scopus): volatilitas intraday FX (sampel DM-dolar 5 menit) punya **pola periodik deterministik yang kuat**, terikat pembukaan/tumpang-tindih sesi dan rilis makro terjadwal; pola ini harus dipisahkan dulu sebelum menyimpulkan apa pun soal persistensi volatilitas. |
| Ito & Hashimoto (2006), *Journal of the Japanese and International Economies* 20(4), 637-664, "Intraday seasonality in activities of the foreign exchange markets: Evidence from the electronic broking system" | Application | Data EBS (quote & transaksi riil USD/JPY & EUR/USD): pola U intraday terkonfirmasi untuk sesi Tokyo & London (tidak untuk New York). **Korelasi volatilitas-aktivitas positif tinggi, korelasi volatilitas-bid/ask spread NEGATIF** (spread paling lebar justru saat aktivitas paling sepi). Volume & volatilitas naik signifikan di sekitar rilis AS, tidak di rilis Jepang. |

**Implikasi untuk Daun Merah:** ini VALIDASI, bukan temuan yang menuntut perubahan. Slot auto-entry saat ini (08:15 & 13:15 UTC, `AUTO_ENTRY_HOURS_UTC` default `8,13` di `vps/daemon.js`) jatuh di pagi London dan menjelang/awal tumpang-tindih London-New York — persis jendela aktivitas tinggi & spread tersempit menurut Ito-Hashimoto. Yang perlu disadari: karena volatilitas per jam berbeda besar secara deterministik, **jarak SL struktural yang sama punya arti risiko berbeda tergantung jam setup lahir**, dan `_evaluateSetups` yang mengevaluasi sentuhan SL/TP dari wick candle H1 paling rawan menghasilkan "SL kena" palsu di jam sepi (spread lebar). Tidak ada rekomendasi menambah jam atau gate jam baru.

### 13c. Biaya transaksi — seberapa besar bias evaluasi tanpa spread

| Paper | Tipe | Temuan inti |
|---|---|---|
| Filippou, Maurer, Pezzo & Taylor (2024), *Journal of Financial Economics* 159, 103886, "Importance of transaction costs for asset allocation in foreign exchange markets" | Constraint | Biaya transaksi punya efek **first-order** pada kinerja portofolio mata uang. Nuansanya penting: biaya proporsional dari quoted bid-ask spread **relatif kecil**; yang menggerus sampai banyak strategi populer jadi tidak profitable adalah **price impact karena volume besar** (dana besar). |
| Hsu, Taylor & Wang (2016), *Journal of International Economics* 102, 188-208, "Technical trading: Is it still beating the foreign exchange market?" | Application | 21.000+ aturan teknikal, 30 mata uang maju & berkembang, 45 tahun data harian, dengan **stepwise test anti data-snooping** dan validasi out-of-sample: masih ditemukan prediktabilitas & excess profitability yang substansial di kedua kelompok mata uang. Biaya transaksi yang dipakai 2 bp (mata uang maju) / 6 bp (berkembang) — **biaya sebesar itu tidak otomatis menghapus profitabilitas**, tapi profitabilitas menurun sepanjang waktu dan lebih kuat di mata uang yang lebih volatil/pasar kurang matang. |

**Implikasi untuk Daun Merah:**

1. **Pembanding sehat untuk nada skeptis §7/§11.** Hsu-Taylor-Wang adalah bukti terkuat yang ditemukan sejauh ini bahwa aturan teknikal di FX BELUM mati setelah dikoreksi data-snooping — sekaligus mengingatkan bahwa edge-nya tipis (ordo basis point) dan meluruh seiring waktu.
2. **Ukuran retail = price impact tidak relevan, spread relevan.** Filippou dkk. memberi dasar kenapa Daun Merah tidak perlu memodelkan price impact sama sekali, TAPI juga kenapa spread nol bukan asumsi netral: `_evaluateSetups` (`api/admin.js`) mengisi entry di harga limit persis dan menilai sentuhan SL/TP dari wick candle H1 **tanpa spread/slippage sama sekali**. Biasnya berarah satu sisi (SL kena lebih cepat, TP kena lebih lambat di dunia nyata), jadi win-rate terukur condong optimis — relevan langsung ke kredibilitas gate n≥100.

### 13d. Lapis filter sekunder & keandalan keputusan LLM

| Paper | Tipe | Temuan inti |
|---|---|---|
| Joubert (2022), *Journal of Financial Data Science* 4(3), hal. 31 dst., "Meta-Labeling: Theory and Framework" | Method | Meta-labeling = lapisan ML sekunder di atas strategi primer, tugasnya **menyaring false positive DAN menentukan ukuran posisi** — bukan cuma veto biner. Kerangka evaluasinya eksplisit: hubungkan metrik klasifikasi biner (precision/recall) dengan metrik strategi (Sharpe, max drawdown); komponen meta-labeling diurai jadi 3 bagian yang efeknya diuji terkontrol. |
| Schoenegger, Tuminauskaite, Park, Bastos & Tetlock (2024), *Science Advances* 10(45), eadp1528, "Wisdom of the silicon crowd: LLM ensemble prediction capabilities rival human crowd accuracy" | Method | Ensemble 12 LLM memprediksi 31 pertanyaan biner vs 925 peramal manusia dalam turnamen 3 bulan: **agregat LLM mengalahkan benchmark tanpa-informasi dan secara statistik tidak bisa dibedakan dari agregat manusia** — padahal riset sebelumnya menunjukkan LLM TUNGGAL (termasuk model frontier) sering gagal mengalahkan benchmark 50%. Temuan sekunder: prediksi LLM membaik 17-28% ketika diberi median prediksi manusia. |

**Implikasi untuk Daun Merah:**

1. **Gate A (AI Kritikus) ternyata punya nama di literatur: meta-labeling.** Konsekuensi yang berguna: cara mengevaluasinya BUKAN "berapa sering ia memveto" (frekuensi `auto_guard_stats:critic_veto` saja), melainkan precision/recall atas kandidat yang diveto vs yang lolos — yang butuh persis data counterfactual yang sudah ditandai belum ada di §11 dan `daun_merah_progress.md` (pola `_evaluateCanceledGhost`). Joubert juga menempatkan **sizing** sebagai bagian sah lapisan ini, menyambung Moreira & Muir (§10, "reduce size" > "skip total") yang sengaja tidak dijadikan gate terpisah.
2. **Titik lemah paling mendasar bukan filternya, tapi bahwa keputusannya dari SATU model.** Schoenegger dkk. adalah bukti peer-review terkuat yang ditemukan bahwa nilai tambah datang dari AGREGASI beberapa model independen, bukan dari rantai veto. Daun Merah sudah punya rantai multi-provider (fallback berurutan, bukan agregasi) + uji konsistensi harian (`runConsistencyCheck`) — instrumen untuk mengetahui apakah ensemble akan mengubah apa pun sebenarnya sudah ada. **Biaya nyata:** agregasi berarti N× call AI per slot; konsisten dengan §4 (forecast combination puzzle) bentuknya harus rata-rata/mayoritas sederhana, BUKAN pembobotan optimal.

**Verdict jujur:** tidak ada satu pun paper di §13 yang menuntut penambahan gate/mekanisme baru. Tiga dari lima arah (SL vs ATR, bias spread, ensemble vs model tunggal) bisa dijawab dengan MENGANALISIS data yang sudah terkumpul, bukan dengan menambah lapisan — konsisten dengan penutup §11. Tidak ditemukan paper peer-review tentang bias resolusi bar (SL & TP tersentuh di candle H1 yang sama, sekarang dilabeli `ambiguous`); itu isu pengukuran internal, dicatat di `daun_merah_riset.md`, bukan di sini.

---

## 14. Apakah ada sistem serupa & ekspektasi realistis "n bakal gimana" (relevan: pertanyaan user 2026-08-03 — auto-entry Daun Merah dibanding trader profesional/riset lain)

Dipicu pertanyaan langsung: apakah ada yang sudah membangun sistem serupa (LLM generate thesis → gate risiko adaptif → conviction sizing, live/paper-traded), dan apakah literatur bisa memberi ekspektasi realistis soal hasil setelah n≥100 setup. Semua sitasi di bawah **diverifikasi manual via WebFetch ke sumber primer** (bukan disalin dari snippet pencarian) sesuai SOP §12 file ini — 1 detail (angka Sharpe spesifik per-simbol paper #1) TIDAK berhasil dikonfirmasi langsung dan ditandai begitu.

| Paper | Tipe | Temuan inti |
|---|---|---|
| Qian et al. (2025), *"When Agents Trade: Live Multi-Market Trading Benchmark for LLM Agents"*, arXiv:2510.11695 (v1 13 Okt 2025) | Application | Benchmark **LIVE sungguhan** (bukan backtest), Agustus-September 2025, crypto+saham: 5 LLM (GPT-4o, GPT-4.1, Claude-3.5-haiku, Claude-sonnet-4, Gemini-2.0-flash) × 4 arsitektur agent. Sistem paling dekat sebagai analog "LLM thesis → dieksekusi → dilaporkan performa" yang ditemukan — tapi bukan FX, bukan skala retail kecil, tidak ada circuit-breaker adaptif/conviction-sizing eksplisit. **Catatan kejujuran:** angka contoh (mis. "TSLA return 40,83%/Sharpe 6,47") ADA di paper tapi tidak berhasil diverifikasi ulang dari teks yang terekstrak — jangan dikutip sebagai angka pasti tanpa cek manual tabel PDF. |
| Li, Zeng, Xing, Xu & Xu (2025), *"Profit Mirage: Revisiting Information Leakage in LLM-based Financial Agents"*, arXiv:2510.07920 (v1 9 Okt 2025) | Constraint | Win-rate/Sharpe mengesankan yang dilaporkan banyak paper LLM-trading **runtuh setelah melewati batas knowledge window model** — akibat information leakage/look-ahead bias. Merilis benchmark FinLake-Bench (leakage-resistant) + framework FactFin (counterfactual simulator) untuk deteksi. |
| Xia, You, Wang, Liu, Qi, Wu & Zhang (2026), *"Agentic Trading: When LLM Agents Meet Financial Markets"* (survei 77 studi), arXiv:2605.19337 (v1 19 Mei 2026) | Constraint | Bidang LLM-trading agent secara umum masih **imatur**: dari subset 19 studi empiris yang diaudit, hanya 2 pakai protokol evaluasi konsisten, 1 mendokumentasikan biaya transaksi eksplisit, TIDAK ADA yang capai level reproducibility tertinggi (R3). "Protocol incomparability" jadi masalah struktural bidang ini. |
| Deep, Deep & Lamptey (2025), *"Interpretable Hypothesis-Driven Trading: A Rigorous Walk-Forward Validation Framework for Market Microstructure Signals"*, arXiv:2512.12924 (v1 15 Des 2025) | Method | Bukan LLM, tapi kalibrasi ekspektasi n: walk-forward 34 periode independen, 5 pola microstructure, 100 saham AS 2015-2024 — hasil agregat Sharpe **0,33, p=0,34 (TIDAK signifikan)**, annualized return 0,55%, max DD -2,76%. Edge kecil di sinyal sistematis butuh jauh lebih dari ratusan sampel untuk keluar dari noise. |
| Li, Gonsalves, Li, Yoon & Wang (2026, Harvard AI/Robotics Lab + HBS), *"TrustTrade: Human-Inspired Selective Consensus Reduces Decision Uncertainty in LLM Trading Agents"*, arXiv:2603.22567 (v1 23 Mar 2026) | Method | Multi-agent LLM trading dengan bobot **dinamis berdasar kesepakatan semantik/numerik antar-agent** (bukan uniform trust ke semua model) + anchor sinyal temporal + memory reflektif. Konsep berdekatan dengan rencana kalibrasi lintas-provider Daun Merah, tapi berbasis consensus-weighting, bukan Brier/ECE per-provider. |
| Barot & Borkhatariya (2026), *"PolySwarm: A Multi-Agent Large Language Model Framework for Prediction Market Trading and Latency Arbitrage"*, arXiv:2604.03888 (v1 4 Apr 2026) | Method | 50 persona LLM, confidence-weighted Bayesian combination + **quarter-Kelly position sizing** — konsep sizing berbasis confidence paling mirip conviction-sizing Daun Merah yang ditemukan. Untuk prediction market (Polymarket), bukan FX. **Tidak ada hasil trading live/riil dilaporkan** — evaluasi hanya Brier score/kalibrasi/log-loss di simulasi. |
| Xue (2026), *"Representation Signatures and Risk-Feedback Alignment in LLM Trading Agents"*, arXiv:2605.28850 (v1 16 Mei 2026) | Application | Testbed TradeArena, risk-gate diuji lintas 5 provider modern (GPT-5.5, Gemini 3.1 Pro, Kimi K2.5, GLM-5, Claude Opus 4.7) — tapi cap posisi **TETAP** (20%/35%/50%, bukan drawdown adaptif per-regime seperti Gate B Daun Merah) dan TIDAK ditautkan ke conviction/confidence model (diperlakukan sebagai parameter kebijakan eksternal). |

**Jawaban langsung ke pertanyaan user:**

1. **"Ada yang sudah kerjakan seperti kita?"** — Tidak ditemukan satu pun paper yang menggabungkan kelima komponen Daun Merah sekaligus (multi-provider fallback thesis-gen, conviction-sizing 0,5x/1,0x, drawdown circuit breaker adaptif-per-regime, correlation cap co-exposure fundamental, gate kalibrasi Brier/ECE lintas-provider) dalam satu pipeline paper-trading FX retail. Komponen individualnya masing-masing ADA presedennya di riset terpisah (lihat tabel), tapi kombinasi persis ini tampak **genuinely jarang/belum diteliti langsung** — dikonfirmasi tidak langsung oleh survei Xia et al. (2026) yang menyimpulkan bidang ini masih kekurangan protokol evaluasi standar secara umum. Bukan berarti pendekatan Daun Merah salah — justru artinya tidak ada "jawaban dari literatur" untuk disalin, harus tetap dibuktikan sendiri dari data live.
2. **"n bakal gimana?"** — Literatur TIDAK memberi angka win-rate/Sharpe spesifik yang bisa dijadikan target realistis untuk n~100-300 setup FX retail (gap literatur, jujur dilaporkan sebagai "tidak ditemukan" bukan dipaksakan). Sinyal tidak langsung yang ADA: (a) Deep/Deep/Lamptey (2025) — bahkan dengan 34 periode walk-forward independen atas ratusan sampel, sinyal microstructure "kecil" tetap gagal signifikan (p=0,34); edge tipis butuh jauh lebih banyak dari n=100 untuk keluar dari noise statistik biasa. (b) Li et al. (2025, Profit Mirage) — angka performa "bagus" yang dilaporkan banyak paper LLM-trading justru rawan inflated oleh information leakage, jadi ekspektasi yang realistis untuk n=100 pertama Daun Merah **BUKAN "harus profitable signifikan"**, melainkan "cukup untuk mulai membedakan noise dari sinyal, bukan capaian akhir". Ini menguatkan (bukan mengubah) kriteria existing Plan U: gate n≥100 sebagai syarat MINIMUM untuk mulai bicara, bukan jaminan hasil positif.
3. **Poin baru yang relevan untuk direnungkan (bukan tindakan wajib):** Agent Market Arena (Qian et al. 2025) menemukan **pemilihan model LLM berdampak minimal terhadap variasi performa dibanding arsitektur agent-nya** — kalau pola ini berlaku juga di Daun Merah, implikasinya rencana kalibrasi Brier/ECE lintas-provider (item #6 Plan U, `daun_merah_progress.md`) mungkin menemukan bedanya lebih kecil dari yang diasumsikan. Ini BUKAN alasan membatalkan item #6 — cek empiris tetap lebih valid dari asumsi literatur luar domain — tapi jadi ekspektasi yang lebih realistis saat menafsirkan hasilnya nanti.

**Implikasi untuk Daun Merah:** tidak ada rekomendasi tambah/ubah kode dari riset ini. Konfirmasi terkuat: sikap konservatif existing (gate n≥100 sebagai syarat minimum bukan cukup, bootstrap/permutation test, skeptisisme terhadap klaim performa) SEJALAN dengan arah kritik literatur LLM-trading terkini (Profit Mirage, survei Xia et al.), bukan berlebihan/paranoid.

---

## 15. Arsitektur workflow keputusan LLM bertahap (relevan: AATAS — Call 1 makro-only, Call 2 teknikal, Gate A Kritikus, `checklist_pct`; pertanyaan user 2026-08-31 "workflow AATAS ini harusnya bagus kah?")

Dipicu pertanyaan langsung apakah BENTUK workflow AATAS (bukan hasil tradingnya) punya dasar riset. Beda dari §13d/§14 yang menilai komponen (meta-labeling, ensemble, ekspektasi n): di sini yang dinilai adalah keputusan arsitektur — memecah 1 panggilan jadi 2, mengunci arah di panggilan pertama, menyembunyikan data teknikal dari panggilan makro, menegakkan aturan di KODE, dan meminta model menilai dirinya sendiri lewat `checklist_pct`. Semua sitasi diverifikasi ke sumber primer (ACL Anthology/PMLR/ICLR/NeurIPS/arXiv/DOI Scopus) sesuai SOP §12.

### 15a. Yang MEMBENARKAN desain AATAS

| Paper | Tipe | Temuan inti |
|---|---|---|
| Shi, Chen, Misra, Scales, Dohan, Chi, Schärli & Zhou (2023), *ICML*, PMLR 202:31210-31227, "Large Language Models Can Be Easily Distracted by Irrelevant Context" | Constraint | Dataset GSM-IC: menambahkan kalimat yang tidak relevan ke soal membuat performa model anjlok **bahkan pada soal yang versi bersihnya dijawab benar**. Chain-of-thought & least-to-most sama-sama rentan; yang menolong antara lain self-consistency dan contoh yang memuat konteks tak relevan. |
| Chen, Chi, Wang & Zhou (2024), *ICML*, PMLR 235:6596-6620, "Premise Order Matters in Reasoning with Large Language Models" | Constraint | LLM rapuh terhadap URUTAN premis walau isi tugasnya identik: mengurutkan premis sesuai alur pembuktian menaikkan akurasi drastis, sedangkan permutasi urutan bisa menjatuhkan performa **>30%** (benchmark R-GSM). |
| Huang, Chen, Mishra, Zheng, Yu, Song & Zhou (2024), *ICLR 2024*, "Large Language Models Cannot Self-Correct Reasoning Yet" | Constraint | *Intrinsic self-correction* (model memperbaiki jawabannya sendiri TANPA umpan balik eksternal) umumnya **menurunkan** performa, bukan menaikkan. Perbaikan yang dilaporkan di literatur lain umumnya berasal dari sinyal eksternal, bukan dari introspeksi model. |
| Wu, Zeng, Zhang, Tan, Shen & Jiang (2024), *EMNLP 2024 Main* (2024.emnlp-main.714), arXiv:2405.14092, "Large Language Models Can Self-Correct with Key Condition Verification" (ProCo) | Method | Kebalikannya berlaku kalau ada VERIFIER: menutup satu kondisi kunci di soal lalu meminta model memprediksinya ulang dari jawabannya sendiri (verify-then-correct) memberi +6,8 EM (open-domain QA), +14,1 akurasi (aritmetika), +9,6 (commonsense) dibanding Self-Correct biasa. Artinya koreksi diri berguna kalau digantung pada pemeriksaan yang bisa diverifikasi, bukan pada opini model. |
| Xiao, Sun, Luo & Wang (2024/2025), arXiv:2412.20138 (v7, 3 Jun 2025), "TradingAgents: Multi-Agents LLM Financial Trading Framework" | Application/Method | Arsitektur meniru firma trading: analis fundamental/sentimen/teknikal terpisah, peneliti Bull vs Bear, tim risk. Inovasi eksplisit: **structured communication** (agen bertukar laporan terstruktur, bukan riwayat percakapan bebas) untuk menghindari "telephone effect", dan debat bahasa alami DIBATASI hanya untuk tim peneliti & risk. Klaim hasil: unggul atas baseline pada cumulative return, Sharpe, max drawdown (klaim penulis, bukan replikasi independen). |
| Yu, Yao, Li, Deng, Jiang, Cao, Chen, Suchow, Cui, Liu, Xu, Zhang, Subbalakshmi, Xiong, He, Huang, Li & Xie (2024), *NeurIPS 2024*, "FinCon: A Synthesized LLM Multi-Agent System with Conceptual Verbal Reinforcement for Enhanced Financial Decision Making" | Application | Hierarki manager-analis + komponen risk control dua lapis, termasuk self-critique episodik yang memutakhirkan "keyakinan investasi sistematis" dan disebarkan SELEKTIF ke node relevan — menurunkan overhead komunikasi sekaligus menaikkan performa. |
| Schall dkk. (2026), *Autonomous Intelligent Systems*, DOI 10.1007/s43684-026-00136-1, "Safe integration of Large Language Models into industrial process control: a multi-agent architecture with P&ID-grounded validation" | Method | Pola pengaman domain safety-critical: usulan LLM divalidasi terhadap model formal (P&ID) SEBELUM dieksekusi — analog langsung "AI mengusulkan, kode yang menggerbang" seperti Gate 1/Gate 6 AATAS. |

**Implikasi (positif) untuk AATAS:**

1. **Menyembunyikan data teknikal dari Call 1 lebih kuat daripada melarangnya lewat kalimat prompt** — Shi dkk. (2023) menunjukkan konteks tak relevan merusak penalaran walau modelnya "tahu" itu tak relevan. `_stripIndicatorLines` + pemisahan blok data di `api/admin.js` adalah implementasi yang benar dari temuan ini, bukan kosmetik.
2. **Urutan makro→teknikal adalah intervensi nyata, bukan selera** — Chen dkk. (2024) membuktikan urutan premis mengubah akurasi hingga >30% pada tugas yang isinya identik.
3. **Penegakan di KODE (`_aatasGate1CodeCheck`, regex indikator, RR dihitung kode, kanonikalisasi verdict) adalah bagian paling didukung riset dari seluruh AATAS** — Huang dkk. (2024) menutup jalur "AI memeriksa dirinya sendiri", Wu dkk. (2024) & Schall dkk. (2026) menunjukkan jalur yang berhasil adalah verifikasi eksternal/formal atas keluaran AI.
4. **Handoff antar-call berbentuk JSON skema-terkunci, bukan prosa** — persis anti-"telephone effect" yang disebut TradingAgents.
5. **Pemisahan peran (analis makro / analis struktur / kritikus)** sejalan dengan arsitektur arus utama di literatur (TradingAgents, FinCon).

### 15b. Yang MENANTANG desain AATAS

| Paper | Tipe | Temuan inti |
|---|---|---|
| Ermakova dkk. (2026), *CHIIR 2026*, DOI 10.1145/3786304.3787879, "Confirmation, Framing, and Position Biases in LLM Responses" | Constraint | Jawaban LLM bergeser sistematis mengikuti framing & posisi informasi di dalam prompt, termasuk kecenderungan mengonfirmasi premis yang sudah dinyatakan. |
| Malmqvist (2025), *LNNS* (SAI), DOI 10.1007/978-3-031-92611-2_5, "Sycophancy in Large Language Models: Causes and Mitigations" (55 sitasi) | Constraint | Sycophancy = kecenderungan model menyetujui pendapat yang sudah dinyatakan di dalam konteks walau salah; akarnya di optimisasi preferensi manusia (RLHF), bukan sekadar gaya bahasa. |
| Leng dkk. (2025), *ICLR 2025*, "Taming Overconfidence in LLMs: Reward Calibration in RLHF" | Constraint | Model hasil RLHF **overconfident secara sistematis** pada confidence yang diverbalkan; butuh kalibrasi reward khusus untuk memperbaikinya. |
| Chhikara dkk. (2025), *TMLR*, "Mind the Confidence Gap: Overconfidence, Calibration, and Distractor Effects in Large Language Models" | Constraint | Celah kalibrasi bertahan lintas model & tugas, dan MEMBURUK saat ada distraktor — persis kondisi prompt trading yang padat data. |
| Ni dkk. (2025), *LNCS*, DOI 10.1007/978-981-96-1710-4_10, "Are Large Language Models More Honest in Their Probabilistic or Verbalized Confidence?" | Constraint | Confidence yang DIUCAPKAN model dan probabilitas internalnya berbeda keandalannya — angka persen yang ditulis model tidak otomatis mewakili keyakinannya. |
| MacGregor (1994), *International Journal of Forecasting* 10(2), DOI 10.1016/0169-2070(94)90018-3, "Judgmental decomposition: when does it work?" | Constraint | Dekomposisi penilaian **tidak selalu** menolong — manfaatnya bersyarat (komponen harus bisa dinilai lebih akurat daripada keseluruhan). *Catatan kejujuran: abstrak tidak tersedia lewat Scopus API dan paper belum dibaca penuh — dipakai hanya sebagai penanda kondisionalitas, JANGAN dikutip untuk angka/efek spesifik.* |
| Armstrong (2006), *International Journal of Forecasting*, DOI 10.1016/j.ijforecast.2006.04.006, "Findings from evidence-based forecasting: Methods for reducing forecast error" | Method | Ringkasan bukti prinsip peramalan berbasis bukti (termasuk kapan dekomposisi & kombinasi menolong) — rujukan payung untuk klaim "dekomposisi bersyarat, kombinasi hampir selalu menolong". |
| Saha dkk. (2025), *ICAIF 2025*, DOI 10.1145/3768292.3770387, "Large Language Model Agents for Investment Management: Foundations, Benchmarks, and Research Frontiers" | Constraint | Survei mutakhir bidang LLM-agent investasi (fondasi, benchmark, frontier) — menguatkan gambaran §14 bahwa protokol evaluasi bidang ini belum matang. |
| Shu dkk. (2026), *IEEE BigComp 2026*, DOI 10.1109/BigComp68355.2026.00019, "ForexAgent: Identifying Trading Strategies in Forex Markets with Large Language Models" | Application | Salah satu dari sedikit paper LLM-agent yang benar-benar di domain FX (mayoritas literatur di ekuitas/kripto) — penanda bahwa pembanding langsung untuk Daun Merah masih sangat tipis. |

**Implikasi (kritis) untuk AATAS:**

1. **Mengunci arah di Call 1 menyembuhkan satu bias dan memasang bias lain.** Tujuannya benar (mencegah rasionalisasi teknikal post-hoc — masalah yang memang terbukti di audit sendiri: fade-tren GC=F/CHF/JPY, kebocoran currency-strength). Tapi Call 2 & Gate A menerima arah itu sebagai FAKTA di dalam prompt, dan literatur sycophancy/confirmation bias (Malmqvist 2025; Ermakova dkk. 2026) memprediksi keduanya condong MENGONFIRMASI premis yang sudah dinyatakan. Kontras arsitektural: TradingAgents & FinCon justru mempertahankan hipotesis tandingan (Bull vs Bear) sampai tahap keputusan.
2. **`checklist_pct` adalah verbalized self-confidence — kelas angka yang riset kalibrasi sebut paling tidak bisa dipercaya** (Leng dkk. 2025; Chhikara dkk. 2025; Ni dkk. 2025). Untungnya kode sudah TIDAK memakainya sebagai gate (`_aatasRejectReason` hanya memakai verdict + dua gate pass/fail). Sikap yang benar: perlakukan sebagai metadata deskriptif, dan jangan dipakai untuk sizing/gating sebelum diuji Brier/ECE (item #6 Plan U, masih terparkir).
3. **Gate A (AI Kritikus) memakai provider yang SAMA dengan Call 1/2** (`cbKey: 'ai:deepseek:experimental'`). Menurut Huang dkk. (2024) itu mendekati intrinsic self-correction; nilai tambah menurut Schoenegger dkk. (2024, §13d) datang dari agregasi model BERBEDA. Kalau Gate A suatu saat dinaikkan dari penasihat fail-open jadi penentu, mengganti providernya (mis. Gemini yang sudah ter-wire sebagai fallback gratis) adalah perubahan satu-variabel yang murah.
4. **Dekomposisi menempatkan gerbang pengikat tepat di komponen terlemah.** MacGregor (1994)/Armstrong (2006): dekomposisi menolong kalau tiap komponen bisa dinilai lebih akurat daripada keseluruhan. Di AATAS, komponen yang MENGIKAT (Call 1: arah dari makro, horizon ~5 hari) justru yang literatur FX-nya paling pesimistis (§1: Meese-Rogoff 1983; Rossi 2013). Konsekuensi jujur: **jangan berharap gerbang makro menambah edge ARAH**; harapkan ia menambah KONSISTENSI (menolak tesis tanpa bukti/konfirmasi). Prediksi terukur yang membedakan dua harapan itu: populasi AATAS mestinya menunjukkan lebih sedikit pembalikan tesis yang saling bertentangan & lebih sedikit setup tanpa driver terverifikasi — bukan otomatis win-rate lebih tinggi.

**Verdict jujur:** dari sisi BENTUK workflow, AATAS ada di sisi yang benar dari literatur pada 4 dari 5 keputusan arsitektur besarnya (isolasi data, urutan premis, penegakan lewat kode, handoff terstruktur). Yang paling bisa diperdebatkan secara riset adalah **penguncian arah tanpa hipotesis tandingan**; artefak yang paling lemah adalah **`checklist_pct` sebagai skor-diri**. Tidak ada satu pun paper di atas yang menuntut penambahan gate baru — perbaikan yang disarankan bersifat mengubah SATU variabel yang sudah ada (provider Kritikus; cek arah dua-arah di Call 1), sejalan dengan §11 (jangan tambah/kurangi gate berdasar literatur saja) dan disiplin isolasi-satu-variabel di `professional_llm_trader/`.

---

## Cara pakai file ini

Sebelum memulai riset/fitur makro baru di Daun Merah:

1. Cek tabel di atas — apakah topiknya sudah ada constraint paper yang relevan?
2. Kalau ada dan constraint-nya negatif (seperti Klein untuk NFP), pertimbangkan pivot tujuan dari "prediksi/edge" ke "assessment kontekstual" (pola nowcasting §3) SEBELUM investasi waktu riset besar.
3. Kalau menambah paper baru ke file ini: verifikasi dulu via web search terhadap sumber primer, jangan salin mentah dari LLM lain tanpa cek.

## Rujukan silang

- [[nfp-causal-research-framework]] — memory: kill-gate NFP final, kenapa proyek itu STOP
- [[labour-market-assessment-pivot]] — memory: pivot ke nowcasting rule-based, sudah dieksekusi S154
- `daun_merah.md` Session 150-153 — detail teknis lengkap riset NFP (Klein sebagai constraint utama)
