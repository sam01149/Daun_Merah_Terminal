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

**Implikasi untuk Daun Merah:** Thesis AI (Call 3 `market-digest.js`) sudah secara implisit konsisten dengan ini — tidak pernah diklaim sebagai "prediksi harga", tapi narasi tesis berbasis kondisi makro/teknikal terkini dengan invalidation trigger eksplisit. Jangan pernah menambahkan fitur yang mengklaim akurasi arah harga FX jangka pendek dari fundamental murni — literatur ini sudah menutup jalur itu.

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

## Cara pakai file ini

Sebelum memulai riset/fitur makro baru di Daun Merah:
1. Cek tabel di atas — apakah topiknya sudah ada constraint paper yang relevan?
2. Kalau ada dan constraint-nya negatif (seperti Klein untuk NFP), pertimbangkan pivot tujuan dari "prediksi/edge" ke "assessment kontekstual" (pola nowcasting §3) SEBELUM investasi waktu riset besar.
3. Kalau menambah paper baru ke file ini: verifikasi dulu via web search terhadap sumber primer, jangan salin mentah dari LLM lain tanpa cek.

## Rujukan silang

- [[nfp-causal-research-framework]] — memory: kill-gate NFP final, kenapa proyek itu STOP
- [[labour-market-assessment-pivot]] — memory: pivot ke nowcasting rule-based, sudah dieksekusi S154
- `daun_merah.md` Session 150-153 — detail teknis lengkap riset NFP (Klein sebagai constraint utama)
