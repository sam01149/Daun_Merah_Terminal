# Daun Merah — Workflow Audit Data Fundamental (Semua Currency/Pair)

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : SOP tetap untuk mengaudit kebenaran & konsistensi data fundamental
           (8 currency: USD/EUR/GBP/JPY/CAD/AUD/NZD/CHF) yang mengalir dari
           sumber (FinancialJuice headline + calendar_v1/calendar_next_v1) ->
           parser (api/_fundamental_parser.js) -> penyimpanan Redis per
           currency -> agregasi pair -> narasi AI (Ringkasan/Analisa/Pre-Entry).
BOLEH    : Daftar indikator audit (kategori A-E), langkah eksekusi per kategori,
           template log temuan tiap run audit.
DILARANG : Bug spesifik yang sudah difix (-> changelog daun_merah.md), plan
           perbaikan besar (-> daun_merah_plan.md), pekerjaan audit yang
           mandek (-> daun_merah_progress.md). File ini HANYA metodologi +
           checklist yang dipakai ulang, bukan catatan hasil satu sesi.
FORMAT   : Update IN PLACE. Kategori/indikator baru ditambah ke checklist;
           log hasil audit per-run ditaruh di bagian "Riwayat Run" (ringkas,
           detail lengkap tetap di daun_merah.md).
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-08-15 (S315, diskusi user — kebutuhan audit menyeluruh
> data fundamental semua pair, indikator audit belum ada sebelumnya).

---

## 0. Kenapa file ini ada

Fitur Fundamental sudah berkali-kali kena bug produksi yang baru ketahuan
lewat laporan user manual (lihat riwayat komentar bug di
`api/_fundamental_parser.js` — HICP EUR fragmentasi 2026-08-15, ADP
Weekly-vs-Monthly 2026-08-11, GDP QoQ ketimpa YoY 2026-07-30, CPI QoQ vs "Cpi
Qoq" duplikat casing 2026-08-10, dll). Pola bug selalu sama: **parsing
salah currency/salah key/salah skala**, atau **data satu jenis dipakai
seolah bukti jenis lain** (lihat `[[project-currency-strength-cot-source-leakage-bug]]`,
`[[project-false-corroboration-rate-probabilities-bug]]` di memory). Audit
reaktif (nunggu user lapor) sudah terbukti lambat. File ini adalah checklist
terarah supaya audit bisa proaktif dan tidak melewatkan kategori bug yang
sudah pernah terjadi.

## 1. Ruang lingkup

- **8 currency**: USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF (+ XAU punya skema
  COT terpisah, lihat `[[project-cot-gold-different-cftc-report]]` — jangan
  disamakan skema audit-nya dengan FX).
- **2 sumber data mentah**: `calendar_v1`/`calendar_next_v1` (TradingView,
  terstruktur, dicoba DULU) dan headline FinancialJuice (parsing regex,
  fallback). Lihat `_fetchCalendarEventsForFund` & `autoUpdateFundamentals`
  di `api/_fundamental_parser.js`.
- **Titik penyimpanan**: Redis `fundamental:<CUR>` (per currency, key per
  indikator) + seed awal `FUND_SEED` di `api/admin.js`.
- **Titik konsumsi**: kartu Fundamental di UI, `FUND_SCORE_RULES`/`IND_DIR_MAP`
  (index.html) untuk skor arah, prompt AI Ringkasan/Analisa/Pre-Entry Check,
  gate corroboration auto-entry (`professional_llm_trader`).

## 2. Kategori indikator audit

### A. Akurasi vs fakta eksternal (news & internet)
1. **Nilai cocok rilis resmi** — actual/forecast/previous yang tersimpan
   dibandingkan ke sumber resmi (biro statistik negara terkait: BLS/BEA
   untuk USD, Eurostat/Destatis untuk EUR, ONS untuk GBP, dll) atau agregator
   tepercaya (Trading Economics/investing.com) sebagai proxy cepat.
2. **Tanggal rilis (`_seenAt`/timestamp) cocok kalender resmi** — bukan
   data lama yang "macet" (pola bug `[[project-plan-u-item6-10-pending]]`-style
   staleness, lihat juga S308 fix JPY/AUD/NZD/CHF macet permanen).
3. **Keputusan bank sentral (hike/hold/cut, besaran bp)** cocok pengumuman
   resmi — cek `CB_RATE_MAP`/`parseCBDecision` vs situs bank sentral.
4. **Skala/unit benar** — indikator di `QUANTITY_INDICATORS` (NFP, Jobless
   Claims, Building Permits, dst) HARUS berupa hitungan K/M, bukan persen.
   Sebaliknya indikator % (CPI, GDP, PMI) tidak boleh kebaca sebagai angka
   ribuan.
5. **Konsistensi 2 sumber** — kalau `calendar_v1` dan headline FinancialJuice
   sama-sama melaporkan indikator yang sama, nilainya harus sama (kalau beda,
   cek mana yang menang di `autoUpdateFundamentals` dan apakah itu keputusan
   yang benar).

### B. Ketepatan atribusi currency & indicator key
1. **Currency benar** — data event USD tidak pernah nyasar ke field EUR/GBP/dst
   (cek `FUND_PREFIX_MAP`/`FUND_COUNTRY_ONLY` match tepat, terutama judul yang
   menyebut >1 negara di kalimat prosa).
2. **Tidak ada key terfragmentasi/duplikat** untuk indikator yang sama (pola
   bug HICP EUR S315, "Cpi Qoq" vs "CPI QoQ" S308) — jalankan
   `reconcileFundamentalKeys` lalu scan manual key baru yang terlihat mirip
   nama existing (variasi casing/kata sisipan Final/Prelim/Flash/Weekly).
3. **Disambiguasi YoY/MoM/QoQ/Flash tidak salah arah** — terutama indikator
   yang sengaja dipisah (`Core PCE` vs `Core PCE YoY`, `GDP QoQ` vs `GDP YoY`,
   `CPI YoY` vs `CPI Flash YoY`).
4. **Headline yang GAGAL match** (tidak masuk currency/indicator manapun) di-
   sampling berkala — apakah ada indikator penting yang sebenarnya harus
   ditangkap tapi kelewat (gap keyword, seperti kasus HICP yang tidak ada di
   `FUND_INDICATOR_MAP` sebelum S315).

### C. Kebocoran lintas pair / lintas jenis data ("data terlempar ke pair lain")
1. **Data currency dipakai hanya di pair yang relevan** — fundamental USD
   tidak boleh muncul sebagai bukti/konteks pair yang tidak mengandung USD.
2. **Data non-fundamental TIDAK menyamar jadi bukti fundamental** — currency
   strength (`_pair_context.js`, price-derived) dan COT retail positioning
   dilarang diklaim sebagai "korroborasi makro" tanpa label sumber yang jelas
   (bug historis persis ini: `[[project-currency-strength-cot-source-leakage-bug]]`,
   `[[project-false-corroboration-rate-probabilities-bug]]`).
3. **Arah base/quote pada cross pair benar** — untuk pair hasil kombinasi 2
   currency (mis. EURGBP), cek strength EUR diberi tanda `+` dan GBP `-`
   secara konsisten, tidak tertukar.
4. **Gate/corroboration auto-entry** (`professional_llm_trader`) memasangkan
   sinyal currency yang benar ke pair yang benar — audit silang sample setup
   log terhadap currency asal sinyalnya.

### D. Downstream — narasi AI tidak menyimpang dari data tersimpan
1. **Angka yang disebut AI (Ringkasan/Analisa/Pre-Entry Check) match persis**
   dengan nilai di Redis — bukan hasil AI "mengarang" atau salah kutip.
2. **Urutan kepentingan indikator** (`FUND_IND_IMPORTANCE`) masih masuk akal
   secara ekonomi (rilis besar seperti CPI/NFP/rate decision harus lebih
   diprioritaskan daripada indikator minor).
3. **Arah skor** (`FUND_SCORE_RULES.dir` di index.html) sesuai teori ekonomi
   standar (CPI/GDP naik = bullish currency, unemployment/jobless claims naik
   = bearish, dst) — audit baris per baris, bukan asumsi semua benar.

### E. Kesehatan sistem / freshness
1. Reconciliation job jalan rutin tanpa error, tidak menumpuk orphan key.
2. Tidak ada currency yang datanya berhenti update >1 siklus rilis kalender
   padahal ada rilis yang seharusnya masuk (cross-check ke kalender resmi).
3. `totalScorable`/confidence tier per currency tidak digelembungkan oleh key
   sampah (kaitan langsung ke temuan kategori B.2).

## 3. Langkah eksekusi audit (per run)

**Fase 0 — Snapshot.**
Ambil dump `fundamental:<CUR>` untuk 8 currency (via endpoint admin/debug
yang sudah ada, atau `redis-cli` kalau akses langsung tersedia). Simpan
snapshot mentah di scratchpad session (bukan di repo) sebagai baseline
sebelum mulai coret-coret.

**Fase 1 — Sampling prioritas.**
Untuk tiap currency, audit dulu indikator berdampak besar (CPI/Core CPI, GDP,
rate decision, NFP/employment change, PMI utama) sebelum indikator minor —
bandingkan actual/forecast/previous ke sumber resmi (kategori A). Catat
selisih sekecil apa pun (bukan cuma yang keliatan absurd) karena bug historis
sering "masuk akal" secara skala (misal HICP 2,1% terlihat wajar padahal
salah indikator).

**Fase 2 — Scan struktural (kategori B).**
Jalankan `reconcileFundamentalKeys` (dry-run kalau ada mode-nya, atau baca
kode dulu sebelum eksekusi karena ini nulis ke Redis). List semua key per
currency, cari pasangan yang mirip nama (case-insensitive, strip kata
Final/Prelim/Flash/Weekly/Y-o-Y) — setiap pasangan mencurigakan jadi kandidat
audit manual apakah representasi indikator yang sama.

**Fase 3 — Cross-check kebocoran (kategori C).**
Ambil 2-3 pair sample yang currency-nya TIDAK overlap (mis. AUDNZD vs
USDJPY) dan pastikan narasi/konteks masing-masing benar-benar terpisah —
tidak ada bocoran currency yang tidak relevan. Cek juga field yang menandai
sumber data (fundamental vs price-derived vs COT) di prompt AI — pastikan
label jenis data eksplisit, tidak dicampur jadi satu klaim "makro selaras".

**Fase 4 — Downstream narrative (kategori D).**
Generate/lihat output Ringkasan & Analisa untuk sample pair mencakup semua 8
currency (minimal tiap currency muncul di ≥1 pair sample), cocokkan tiap
angka yang disebut AI ke data tersimpan persis.

**Fase 5 — Freshness (kategori E).**
Bandingkan `_seenAt` terbaru tiap currency ke kalender rilis resmi 30 hari
terakhir — currency yang harusnya punya rilis baru tapi datanya masih lama
ditandai untuk investigasi root cause (bukan langsung dianggap bug, bisa juga
memang belum ada rilis).

**Fase 6 — Dokumentasi.**
Temuan bug nyata (bukan false alarm) masuk `daun_merah.md` per pola commit
existing (`[SXXX] Fix bug <deskripsi>`). Temuan yang butuh keputusan/desain
besar sebelum dieksekusi masuk `daun_merah_plan.md`. Update "Riwayat Run" di
bawah dengan ringkasan 1-2 baris.

## 4. Kriteria selesai satu run audit

- Kategori A-E sudah disentuh untuk semua 8 currency (boleh sampling
  terarah untuk indikator minor, tapi indikator besar wajib 100% dicek).
- Setiap temuan bug sudah diverifikasi bukan false alarm sebelum dicatat
  (pola `[[project-audit-skip-pattern]]`-style — false alarm AUD/NZD S313
  jadi pelajaran: jangan buru-buru simpulkan bug tanpa cek root cause).
- Temuan sudah di-route ke file dokumentasi yang benar (§2 ATURAN.md) dan
  di-push.

## 5. Riwayat Run

*(kosong — isi 1-2 baris per run audit: tanggal, currency/kategori yang
dicek, jumlah temuan, link ke entri daun_merah.md yang relevan)*
