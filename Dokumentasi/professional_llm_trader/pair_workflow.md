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

### 2a. Structural profile (`api/_pair_context.js`, `STRUCTURAL_PROFILES`)

- **HANYA isi kalau pair TERBUKTI range-bound/mean-reverting** — dua ekonomi yang mirip/berdekatan, kebijakan bank sentral cenderung searah, tanpa kaki USD (pola AUD/NZD, EUR/GBP). Riset dulu sumber kredibel (bandingkan rentang pip tipikal ke major pair, driver kebijakan bank sentral) sebelum menulis catatan struktural — jangan menulis narasi tanpa dasar.
- **JANGAN diisi kalau pair macro-driven/trending** (pola EUR/USD, XAU/USD, dan kemungkinan besar pair lintas-safe-haven macam CHF/JPY berdasar riset SNB-BOJ) — catatan struktural yang salah asumsi lebih berbahaya daripada tidak ada catatan sama sekali, karena bisa menyesatkan AI mengira breakout adalah noise.
- Format entri: 1 paragraf — rentang pip tipikal, alasan struktural (kenapa range-bound), pemicu breakout kredibel yang spesifik (bukan generik "kalau ada berita besar").

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

## TAHAP 3 — Checklist Titik Kode (mekanis, setelah Tahap 1 & 2 diputuskan)

Centang manual tiap kali eksekusi — urutan tidak wajib, tapi semua WAJIB disentuh atau disengaja dilewati dengan alasan:

- [ ] `vps/daemon.js` — `AUTO_ENTRY_SYMBOL_MAP` (entri baru `frxXXX: {symbol, label}`), `AUTO_ENTRY_PAIRS` default env var
- [ ] `vps/daemon.js` — `YAHOO_TO_DERIV_SYMBOL`: isi HANYA kalau pair itu genuinely simbol Deriv asli (lihat Tahap 1c); kalau Yahoo-only, JANGAN diisi
- [ ] `api/admin.js` — `OHLCV_FIXED_PAIRS` (cache `ohlcv_sync`)
- [ ] `api/admin.js` — `SPREAD_PRICE_ESTIMATE` (Tahap 2d, WAJIB — histori bug)
- [ ] `api/_ohlcv_fetch.js` — `YAHOO_TO_TWELVEDATA_SYMBOL` (fallback kalau Yahoo down)
- [ ] `api/_auto_entry_guard.js` — Gate D `CORRELATED_PARTNER`/`USD_VIEW_BY_SYMBOL_BIAS` ATAU cabang baru (Tahap 2c) — HANYA kalau korelasi mengharuskan
- [ ] `api/_pair_context.js` — `STRUCTURAL_PROFILES` — HANYA kalau Tahap 2a menyimpulkan range-bound
- [ ] `api/calendar.js` — cek komentar `SURPRISE_CURRENCIES` (kode auto-derive, cuma perlu update komentar kalau menyebut currency spesifik yang jadi salah)
- [ ] `dev-auto-entry.html` — `ACTIVE_FILTER_PAIRS` (filter dashboard Riwayat Setup)
- [ ] `test/vps/auto_entry.test.js` — update assert `AUTO_ENTRY_PAIRS`/`AUTO_ENTRY_SYMBOL_MAP` (akan merah otomatis kalau kelewat, itu sinyal wajib)
- [ ] `test/api/_auto_entry_guard.test.js` — tambah test Gate D kalau ada perubahan di poin Gate D
- [ ] `npm test` 100% hijau
- [ ] Dokumentasi: hasil pengukuran Tahap 1 → `riset.md` folder ini; implementasi → `changelog.md` folder ini; kalau ada yang ditunda → `progress.md` folder ini

---

## TAHAP 4 — Verifikasi Live

- Minimal 1 siklus `runAutoEntryCycle` produksi menghasilkan entri baru untuk pair ini di `setup_log_auto:v1` (developer scope, `dev-auto-entry.html`).
- Cek `missing_spread_table` KOSONG untuk pair baru (bukti Tahap 2d benar diisi).
- Kalau Gate D diisi: cek `auto_guard_stats:correlation_cap` bisa naik untuk pair ini kalau skenario korelasi kejadian (tidak wajib terjadi cepat, cukup pastikan kodenya sampai ke situ tanpa error).
- Update `professional_llm_trader/plan.md` §PLAN U kalau penambahan pair mengubah total sampel yang dibutuhkan gate n≥100 (jumlah pair × 30).
