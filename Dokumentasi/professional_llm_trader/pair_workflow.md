# Professional LLM Trader — Workflow Menambah Pair Baru

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : SOP/checklist hidup untuk MENGEVALUASI dan MENGEKSEKUSI penambahan pair baru ke
           AUTO_ENTRY_PAIRS — dua tahap: (1) indikator kelayakan (fit check), (2) kalau layak,
           bangun profiling/karakteristik pair supaya AI trading sesuai sifat pair itu.
BOLEH    : Kriteria terukur, ambang angka, daftar titik kode yang WAJIB disentuh, urutan
           langkah. Update in place (bukan changelog per-sesi) — dokumen ini WAJIB direvisi
           begitu ada titik kode baru yang lupa masuk daftar, atau ambang berubah dari data.
DILARANG : Hasil pengukuran pair spesifik (-> riset.md folder ini), keputusan sudah-dieksekusi
           (-> changelog.md folder ini), pair yang masih didiskusikan/ditunda
           (-> progress.md folder ini).
FORMAT   : Numbered steps + tabel ambang. Bukan naratif per-sesi.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-08-08, disarikan dari proses nyata redesain 4-pair (Session 247, `changelog.md` folder ini) + evaluasi ulang kandidat CHF/JPY (diskusi user hari yang sama) — dua kali proses ad-hoc ini yang jadi pola dasar workflow di bawah, supaya kali berikutnya tidak perlu direka ulang dari nol dan tidak ada titik kode yang kelewat (histori: bug `SPREAD_PRICE_ESTIMATE` lupa diisi untuk AUD/NZD, `YAHOO_TO_TWELVEDATA_SYMBOL` lupa fallback — dua-duanya baru ketahuan belakangan).

---

## TAHAP 1 — Indikator Kelayakan (Fit Check)

Kandidat pair HARUS lolos semua poin di bawah sebelum masuk Tahap 2. Ukur dengan data, jangan dengan intuisi logika mata uang saja — pelajaran kasus CHF/JPY (lihat riset.md folder ini): dua currency yang "kelihatannya" independen/senasib secara teori (dua-duanya safe-haven) ternyata TIDAK otomatis netral secara empiris, karena SNB & BOJ punya pendorong kebijakan independen sendiri-sendiri. Logika mata uang cuma hipotesis awal, wajib diverifikasi angka.

### 1a. Independensi korelasi

- Jalankan `node scripts/analyze_pair_correlation.js` — tambahkan symbol Yahoo kandidat ke array `PAIRS` di file itu kalau belum ada, run terhadap SEMUA pair yang AKTIF SEKARANG di `AUTO_ENTRY_PAIRS` (bukan pair lama/legacy yang sudah dibuang — pelajaran kasus CHF/JPY: angka korelasi ke Golden Trio lama sudah TIDAK relevan begitu GBP/USD dibuang dari set).
- **Ambang:** rata-rata `|r|` kandidat ke seluruh pair aktif < 0,3 (ideal < 0,2, setara AUD/NZD 0,10 / EUR/GBP 0,19), DAN tidak ada satu pun pasangan `|r|` > 0,585 (batas atas yang sudah diterima sistem untuk XAU/USD-EUR/USD, jangan lebih buruk dari itu).
- **Wajib jelaskan MEKANISME, bukan cuma angka:** kalau korelasi rendah, kenapa? (contoh valid: AUD/NZD & EUR/GBP — dua ekonomi mirip, kebijakan bank sentral cenderung searah, silang saling menetralkan faktor bersama). Kalau tidak bisa menjelaskan mekanisme yang masuk akal, angka korelasi rendah mungkin cuma kebetulan jendela data (60 hari) dan bisa berubah drastis saat regime shift (rujuk kasus CHF/JPY: dua safe-haven currency BISA korelasi tinggi saat risk-off akut meski korelasi harian tenang).

### 1b. Kecepatan sampel (opportunity rate)

- Jalankan `node scripts/analyze_setup_opportunity_rate.js` — tambahkan kandidat ke `CANDIDATE_PAIRS`, run terhadap rata-rata pair AKTIF sekarang sebagai pembanding.
- **Ambang:** peluang setup kandidat >= rata-rata pair aktif sekarang (jangan sampai pair baru justru memperlambat n≥30/pair dibanding kalau slot itu dipakai pair lain). Kalau di bawah rata-rata tapi masih dalam 5-10 poin, masih bisa dipertimbangkan (bukan hard-block, lihat catatan batas metode di bawah).
- **Catatan batas metode (WAJIB disebutkan tiap kali angka ini dikutip):** proxy ini batas ATAS (tidak memodelkan penolakan AI karena `makro_alignment` konflik) — untuk PERBANDINGAN RELATIF antar-pair, bukan estimasi presisi tingkat penolakan AI sungguhan.

### 1c. Ketersediaan & kualitas data

- **Yahoo:** test fetch langsung (`fetchYahoo` pola `scripts/analyze_pair_correlation.js`) — pastikan symbol valid & data historis cukup (≥60 hari 1H).
- **Deriv:** cek `YAHOO_TO_DERIV_SYMBOL` (`vps/daemon.js` / `api/_ohlcv_fetch.js`) — kalau simbolnya SUDAH ada di 14 pair yang di-stream Deriv, pair dapat live-streaming penuh (pola XAU/USD/EUR/USD/EUR/GBP). Kalau TIDAK ada, pair otomatis Yahoo-only (pola AUD/NZD) — INI BUKAN BLOCKER, sudah terbukti jalan di produksi, tapi catat sebagai known-limitation (presisi fill/TP/SL candle H1, bukan tick — lihat kasus AUD/NZD meleset ~5-6 pip, `progress.md` folder ini S269).
- **TwelveData fallback:** cek symbol format valid untuk `YAHOO_TO_TWELVEDATA_SYMBOL` (`api/_ohlcv_fetch.js`) — kalau format pair (`XXX/YYY`) tidak dikenali TwelveData, catat sebagai gap fallback yang perlu solusi lain, jangan asumsikan otomatis kompatibel.

### 1d. Anggaran call AI

- Hitung call/hari baru: `(jumlah pair aktif + 1) × jumlah slot/hari` (default 2 slot: 08:00 & 13:00 UTC) + slot khusus kalau ada (pola AUD/NZD, lihat Tahap 2f).
- **Ambang:** total tetap di bawah pagar `deepseek_experimental` (cek nilai terkini di `api/_ai_guard.js`, per 2026-08-08 = 15/hari).

**Kalau SEMUA poin 1a-1d lolos → lanjut Tahap 2. Kalau ada yang gagal → catat di `progress.md` folder ini sebagai TERTUNDA dengan alasan spesifik, JANGAN dipaksakan.**

---

## TAHAP 2 — Profiling & Karakteristik (kalau lolos Tahap 1)

Tujuan: AI (`ohlcvAnalyzeHandler`, prompt Analisa/auto-entry) membaca pair baru dengan pemahaman KHUSUS sifatnya, bukan generik. Pola yang sudah diimplementasikan untuk AUD/NZD & EUR/GBP (`riset.md` folder ini §"Profil struktural") jadi acuan, TAPI jangan copy-paste otomatis — tiap poin di bawah butuh keputusan sadar berbasis karakter pair itu sendiri.

### 2a. Catatan karakteristik (`api/_pair_context.js`, `STRUCTURAL_PROFILES`) — WAJIB diriset, DUA jenis framing

**Update 2026-08-08 (kasus CHF/JPY):** aturan lama di sini ("isi HANYA kalau range-bound, JANGAN kalau trending") ternyata bikin pair yang trending/macro-driven tapi TIDAK dapat data fundamental dalam (beda dari EUR/USD & XAU/USD) berakhir NOL konteks pair-spesifik sama sekali. Revisi: **setiap pair aktif WAJIB diriset & punya karakterisasi eksplisit** (sumber kredibel, bukan tebakan) — cuma mekanisme penyampaiannya yang beda tergantung apa pair itu sudah dapat konteks dari jalur lain atau belum:

1. **Range-bound/mean-reverting** (dua ekonomi mirip, kebijakan bank sentral cenderung searah, tanpa kaki USD — pola AUD/NZD, EUR/GBP): isi `STRUCTURAL_PROFILES` dengan framing "skeptis ke breakout kecuali ada pemicu jelas". Riset: rentang pip tipikal, alasan struktural, pemicu breakout kredibel yang SPESIFIK.
2. **Trending/macro-driven TAPI sudah dapat data fundamental dalam** (COT, CME options, labour market/rate-path — pola EUR/USD, XAU/USD): JANGAN isi `STRUCTURAL_PROFILES` — tapi WAJIB ada catatan kausal eksplisit LANGSUNG di `_formatFundamentalBlock`/`api/admin.js` (pola `goldNote` untuk XAU/USD, "DIFFERENTIAL SUKU BUNGA EUR-USD" untuk EUR/USD) supaya AI tidak cuma dapat angka mentah dua kaki terpisah, tapi juga arah kausal yang menghubungkannya.
3. **Trending/event-driven TAPI TIDAK dapat data fundamental dalam** (bukan pair berkaki USD, tidak ada COT/CME — pola CHF/JPY): isi `STRUCTURAL_PROFILES` juga, TAPI dengan framing KEBALIKAN dari poin 1 — "jangan skeptis ke breakout, momentum bisa valid & tiba-tiba, TAPI waspada [risiko spesifik pair ini]" (untuk CHF/JPY: risiko intervensi bank sentral sepihak). Riset apa yang bikin pair ini bergerak DAN apa yang bisa menyesatkan (headline noise vs pergerakan riil).

**Referensi lengkap hasil riset ke-5 pair aktif (sumber + framing dipakai): lihat §"Faktor Kekuatan/Kelemahan per Pair Aktif" di bawah.**

### 2b. Modul fundamental USD-sentris

- Cek apakah pair ada kaki USD. Kalau TIDAK (cross pair), modul `_labour_market.js`/`rate-path.js` otomatis tidak relevan — TIDAK perlu kerja tambahan, sudah digerbang otomatis oleh `legs.includes('USD')`.
- Real yield per-leg (`api/real-yields.js` → `_formatFundamentalBlock`) SUDAH loop otomatis semua leg (bukan hardcode USD, sejak fix 2026-08-04) — verifikasi saja currency baru (kalau ada currency yang belum pernah dipakai, mis. CHF/JPY) sudah ada di cache `real-yields.js`, jangan asumsikan.

### 2c. Gate D — correlation cap (`api/_auto_entry_guard.js`)

- Kalau Tahap 1a menemukan ADA pasangan dengan korelasi tidak-nol berarti (mis. 0,3-0,5) ke salah satu pair aktif: pair itu perlu di-cap.
- **Cek dulu mekanisme korelasinya SEBELUM nulis kode:** apakah lewat "pandangan USD bersama" (pola `USD_VIEW_BY_SYMBOL_BIAS` existing, cuma berlaku kalau kandidat DAN partner-nya sama-sama punya kaki USD)? Kalau BUKAN (pair kandidat tanpa kaki USD, korelasi ke pair lain lewat faktor lain — mis. risk-sentiment global), abstraksi "USD view" TIDAK berlaku — perlu cabang logika baru (bias-matching langsung antar dua pair spesifik), JANGAN dipaksa masuk skema USD view yang salah konsep.
- Kalau korelasi < 0,3 ke semua pair aktif (pola AUD/NZD, EUR/GBP saat ini): TIDAK perlu Gate D, cukup dicatat "sengaja tidak di-cap" di komentar kode.

### 2d. Cost/spread (`api/admin.js`, `SPREAD_PRICE_ESTIMATE`)

- **WAJIB tambah entri** — histori bug: AUD/NZD lupa dimasukkan, akibatnya seluruh setup pair itu diam-diam ke-skip dari `cost_expectancy` tanpa tanda apa pun di payload (baru ketahuan lewat audit manual). `missing_spread_table` (di `_aggCostExpectancy`) sekarang merekam gap ini otomatis kalau kelewat — TAPI tetap jangan andalkan itu sebagai pengganti mengisi tabelnya di awal.
- Ballpark angka: cari pair pembanding likuiditas serupa di tabel yang sudah ada (kolom cross pair JPY/CHF/dst), jangan angka sembarang.

### 2e. Regime relevance — **CATATAN: Gate C sudah DIHAPUS (2026-07-28)**

Dulu ada langkah "putuskan REGIME_RELEVANT_SYMBOLS" di sini — sudah tidak relevan, Gate C (regime confidence bar) dihapus total dari kode karena logikanya buta arah. `risk_regime` sekarang murni konteks informatif di prompt AI untuk SEMUA pair tanpa filter kode terpisah — tidak ada keputusan yang perlu dibuat di poin ini lagi. Baris ini SENGAJA dipertahankan sebagai penanda "jangan cari-cari Gate C, itu sudah tidak ada" untuk sesi berikutnya yang mungkin masih baca dokumentasi lama.

### 2f. Jam khusus (opsional, JANGAN default ditambahkan)

- Jadwal utama `AUTO_ENTRY_HOURS_UTC` (default 08:00 & 13:00 UTC) dioptimalkan untuk sesi London/NY. Pair baru **HANYA** butuh slot tambahan kalau punya sesi likuiditas puncak yang jauh dari jendela itu (pola AUD/NZD → Sydney-Tokyo, `AUTO_ENTRY_HOURS_UTC_AUDNZD`).
- **Default: JANGAN tambah mekanisme jam khusus baru** kecuali ada bukti/riset spesifik pair itu sepi di jam London/NY (lihat pola analisis di `riset.md` folder ini §"ketepatan jadwal cron"). Kalau tidak ada bukti kuat, cukup masukkan ke jadwal utama seperti EUR/USD, EUR/GBP.

---

## Faktor Kekuatan/Kelemahan per Pair Aktif (referensi hidup, WAJIB update tiap pair baru/ada temuan baru)

Riset 2026-08-08 (web search, sumber dicantumkan) — apa yang bikin tiap currency/pair MENGUAT vs MELEMAH, dan bagaimana itu disalurkan ke AI (jalur data fundamental langsung vs catatan naratif `STRUCTURAL_PROFILES`, lihat Tahap 2a).

### XAU/USD (Gold) — jalur: data fundamental langsung (`goldNote`, `_formatFundamentalBlock`)

- **Menguat kalau:** real yield USD TURUN (ongkos oportunitas pegang aset non-yield berkurang), USD MELEMAH (gold dihargakan global dalam USD, lebih murah buat pembeli non-AS), pembelian bank sentral tinggi (rekor 1.237 ton 2025, tahun ke-3 berturut >1.000 ton), risiko geopolitik naik (kontribusi ~8-12% return gold 2025).
- **Melemah kalau:** real yield USD NAIK, USD MENGUAT, Fed hawkish (suku bunga tinggi lebih lama).
- **Sudah tersalur ke AI:** `goldNote` di `_formatFundamentalBlock` (`api/admin.js`) — baris REAL YIELD USD otomatis dapat catatan "driver utama gold" tiap call.
- Sumber: [Gold Price Drivers — EBC Financial Group](https://www.ebc.com/forex/gold-price-drivers-rates-dollar-central-banks), [Gold 2026 Outlook — State Street](https://www.ssga.com/us/en/intermediary/insights/gold-2026-outlook-can-the-structural-bull-cycle-continue-to-5000), [ING THINK Gold 2026](https://think.ing.com/articles/golds-bull-run-to-continue-in-2026/).

### EUR/USD — jalur: data fundamental langsung (differential note, `_formatFundamentalBlock`)

- **Driver dominan (horizon 1-3 tahun):** DIFFERENTIAL suku bunga Fed-ECB — BUKAN level tiap kaki sendiri-sendiri. Riset pasar: tiap penyempitan 50bp differential ≈ 300-400 pip pergerakan EUR/USD, non-linear (dampak proporsional lebih besar makin rendah level suku bunga).
- **EUR menguat relatif kalau:** ECB relatif lebih hawkish dari Fed (differential menyempit/negatif dari sisi USD).
- **Driver jangka pendek tambahan:** feedback loop minyak/geopolitik — tiap headline gencatan senjata/eskalasi bisa gerakkan 50-100 pip.
- **Sudah tersalur ke AI:** baris "DIFFERENTIAL SUKU BUNGA EUR-USD" (ditambahkan 2026-08-08, `_formatFundamentalBlock`) — dihitung otomatis dari selisih REAL YIELD EUR minus USD tiap call.
- Sumber: [EURUSD 2026 Rate Differential — FXTM](https://www.fxtm.com/en/blog/eurusd-2026-rate-differential/), [EUR/USD Forecast — Central Bank Watch](https://centralbank.watch/compare/currency-pair-deep-dives/eur-usd/), [Why Fed & ECB Pull Different Directions — StoneX](https://www.stonex.com/en/insights/why-the-fed-and-the-ecb-keep-pulling-in-different-rate-directions-2026-07-08/).

### AUD/NZD — jalur: catatan naratif `STRUCTURAL_PROFILES` (framing: skeptis breakout)

- **AUD menguat/melemah ikut:** harga iron ore (proxy ekspor Australia), kebijakan RBA.
- **NZD menguat/melemah ikut:** harga dairy/lelang GDT (proxy ekspor NZ), kebijakan RBNZ.
- **Pair-nya sendiri:** range-bound/mean-reverting (400-800 pip tipikal) — RBA & RBNZ historisnya sering bergerak searah, jadi silang saling menetralkan faktor bersama. Breakout kredibel HANYA kalau RBA-RBNZ policy diverge tajam ATAU iron ore vs dairy berlawanan arah.
- Sumber riset asli (2026-08-04): [Forex For Starters — AUD/NZD](https://forexforstarters.com/markets/minors/aud-nzd/), [AvaTrade AUD-NZD](https://www.avatrade.com/trading-info/financial-instruments-index/fxoptions/aud-nzd).

### EUR/GBP — jalur: catatan naratif `STRUCTURAL_PROFILES` (framing: skeptis breakout)

- **EUR menguat/melemah ikut:** kebijakan ECB, data makro Eurozone gabungan.
- **GBP menguat/melemah ikut:** kebijakan BOE, data inflasi/tenaga kerja UK.
- **Pair-nya sendiri:** range-bound (40-70 pip harian tipikal, ATR14 rendah) — Eropa & Inggris berdekatan geografis, menyerap shock eksternal dengan cara mirip. Breakout kredibel HANYA kalau ada divergensi kebijakan ECB-BOE jelas atau berita fiskal/politik relatif UK-EU. Range kecil bikin spread memakan porsi lebih besar dari target profit.
- Sumber riset asli (2026-08-04): [FxPro EUR/GBP Trading Guide](https://www.fxpro.com/help-section/education/beginners/articles/mastering-eur-gbp-forex-trading-complete-guide-to-strategies-and-analysis-for-2026), [FXNX EUR/GBP Trading Guide](https://fxnx.com/en/blog/eur-gbp-trading-guide-mastering-institutional-anchor).

### CHF/JPY — jalur: catatan naratif `STRUCTURAL_PROFILES` (framing KEBALIKAN: jangan skeptis breakout, waspada intervensi)

- **CHF menguat kalau:** ketakutan pasar terpusat isu Eropa/stabilitas politik-perbankan (flight-to-quality ASLI ke sistem perbankan Swiss). SNB aktif intervensi menahan penguatan franc sejak 2009 (floor EUR/CHF 2011-2015, beli aset asing/jual CHF).
- **JPY menguat kalau:** UNWIND CARRY TRADE global (yen didanai carry trade karena suku bunga ultra-rendah — risk-off memicu penutupan besar-besaran, BUKAN murni "safe haven inflow" murni). VIX > 18 mulai unwind carry trade; VIX 18-27 flight-to-safety yen kuat; VIX > 40 safe-haven umum (JPY/CHF/USD) dominan, sinyal individual pair tenggelam.
- **Risiko KHUSUS pair ini:** intervensi bank sentral SEPIHAK bisa bikin lonjakan tajam dalam hitungan menit yang TIDAK berhubungan sama sekali dengan struktur teknikal. BOJ intervensi langsung 2022 (¥2,8 triliun, pertama sejak 1998) & 2024 (7x intervensi, total ¥24,5 triliun) — USD/JPY sempat surge ~10% dalam beberapa minggu sebelum intervensi 2024. Tanda peringatan: lonjakan vertikal tiba-tiba TANPA building momentum sebelumnya, order flow tidak wajar, komentar verbal pejabat Jepang/Swiss.
- **Pair-nya sendiri:** volatilitas cenderung datang tiba-tiba & arahnya sulit ditebak duluan (dua mekanisme safe-haven yang BEDA, tidak selalu searah). JANGAN anggap breakout di rezim bergejolak sebagai noise — kemungkinan pergerakan riil dari unwind carry trade/risk-off shock, TAPI validasi dulu bukan lonjakan intervensi sepihak.
- Sumber: [VT Markets — CHF vs JPY Safe-Haven 2026](https://www.vtmarkets.com/learn/chf-vs-jpy-identifying-the-superior-safe-haven-currency-in-2026-vt-markets/), [FXNX Safe Haven Currency Pairs](https://fxnx.com/en/blog/safe-haven-currency-pairs-your-forex-stability-guide), [Cross-Asset Risk Monitor — VIX thresholds](https://globalinvesting.github.io/guide-cross-asset-risk.html), [Risk Premiums & Yen Carry Trade — MDPI](https://www.mdpi.com/2227-9091/14/3/46), [Traders Union — BOJ Interventions](https://tradersunion.com/interesting-articles/currency-intervention/boj-interventions/), [BOJ Intervention 2022 vs 2024 — FXStreet](https://www.fxstreet.com/analysis/boj-intervention-2022-vs-2024-202404151139), [SNB Operational Framework Primer](https://gianlucabenigno.substack.com/p/the-snb-operational-framework-a-primer).

---

## TAHAP 3 — Checklist Titik Kode (mekanis, setelah Tahap 1 & 2 diputuskan)

Centang manual tiap kali eksekusi — urutan tidak wajib, tapi semua WAJIB disentuh atau disengaja dilewati dengan alasan:

- [ ] **Riset karakteristik pair (Tahap 2a) sudah ditulis di §"Faktor Kekuatan/Kelemahan per Pair Aktif" di atas** — sumber kredibel dicantumkan, framing yang dipilih (range-bound / fundamental-langsung / event-driven) dijustifikasi. JANGAN lanjut ke titik kode di bawah sebelum ini ada.
- [ ] `vps/daemon.js` — `AUTO_ENTRY_SYMBOL_MAP` (entri baru `frxXXX: {symbol, label}`), `AUTO_ENTRY_PAIRS` default env var
- [ ] `vps/daemon.js` — `YAHOO_TO_DERIV_SYMBOL`: isi HANYA kalau pair itu genuinely simbol Deriv asli (lihat Tahap 1c); kalau Yahoo-only, JANGAN diisi
- [ ] `api/admin.js` — `OHLCV_FIXED_PAIRS` (cache `ohlcv_sync`)
- [ ] `api/admin.js` — `SPREAD_PRICE_ESTIMATE` (Tahap 2d, WAJIB — histori bug)
- [ ] `api/admin.js` — `_formatFundamentalBlock`: kalau pair punya driver kausal terkuantifikasi (pola `goldNote` XAU/USD, "DIFFERENTIAL SUKU BUNGA" EUR/USD) DAN datanya sudah tersedia di `realYields`/`cbBias`/dst — tambahkan catatan kausal eksplisit, jangan biarkan AI cuma dapat angka mentah tanpa arah hubungan
- [ ] `api/_ohlcv_fetch.js` — `YAHOO_TO_TWELVEDATA_SYMBOL` (fallback kalau Yahoo down)
- [ ] `api/_auto_entry_guard.js` — Gate D `CORRELATED_PAIRS` (array `{a,b,sign}`) — HANYA kalau Tahap 2c menyimpulkan perlu di-cap; `sign` ditentukan dari ARAH korelasi (positif = bias sama dicap, negatif = bias berlawanan dicap), bukan dari abstraksi "USD view" (itu sudah di-generalisasi 2026-08-08, jangan bikin ulang model lama)
- [ ] `api/_pair_context.js` — `STRUCTURAL_PROFILES` — isi untuk framing #1 (range-bound, skeptis breakout) ATAU #3 (event-driven, framing kebalikan) di Tahap 2a; SKIP hanya untuk framing #2 (sudah dapat catatan kausal langsung di admin.js)
- [ ] `api/calendar.js` — **`SURPRISE_CURRENCIES` di sini HARDCODE, TERPISAH dari versi auto-derive di `vps/daemon.js`** (ditemukan 2026-08-08 — bug nyata, bukan cuma komentar basi) — WAJIB tambah currency baru manual ke set ini juga
- [ ] `dev-auto-entry.html` — cek `ACTIVE_FILTER_PAIRS` (per 2026-08-08 sudah auto-derive live dari `setup_stats?scope=auto`, kemungkinan besar TIDAK perlu edit manual lagi — verifikasi masih begitu, jangan asumsikan tanpa cek)
- [ ] `test/vps/auto_entry.test.js` — update assert `AUTO_ENTRY_PAIRS`/`AUTO_ENTRY_SYMBOL_MAP`/`SURPRISE_CURRENCIES` (akan merah otomatis kalau kelewat, itu sinyal wajib)
- [ ] `test/api/_auto_entry_guard.test.js` — tambah test Gate D kalau ada perubahan di poin Gate D
- [ ] `test/api/calendar.test.js` — update assert `SURPRISE_CURRENCIES`/`buildSurpriseEvents` kalau currency set berubah
- [ ] `test/lib/pair_context.test.js` — tambah test `STRUCTURAL_PROFILES` baru (regime bergejolak → muncul, regime normal → tidak)
- [ ] `test/admin/makro_ctx.test.js` — tambah test kalau ada catatan kausal baru di `_formatFundamentalBlock`
- [ ] `npm test` 100% hijau
- [ ] Dokumentasi: hasil pengukuran Tahap 1 + riset karakteristik Tahap 2a → `riset.md` folder ini; implementasi → `changelog.md` folder ini; kalau ada yang ditunda → `progress.md` folder ini

---

## TAHAP 4 — Verifikasi Live

- Minimal 1 siklus `runAutoEntryCycle` produksi menghasilkan entri baru untuk pair ini di `setup_log_auto:v1` (developer scope, `dev-auto-entry.html`).
- Cek `missing_spread_table` KOSONG untuk pair baru (bukti Tahap 2d benar diisi).
- Kalau Gate D diisi: cek `auto_guard_stats:correlation_cap` bisa naik untuk pair ini kalau skenario korelasi kejadian (tidak wajib terjadi cepat, cukup pastikan kodenya sampai ke situ tanpa error).
- Update `professional_llm_trader/plan.md` §PLAN U kalau penambahan pair mengubah total sampel yang dibutuhkan gate n≥100 (jumlah pair × 30).
