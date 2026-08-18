# Professional LLM Trader — Changelog Teknis

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Changelog teknis KHUSUS inisiatif "Professional LLM Trader" (eks-Plan U) — sistem
           auto-entry AI eksperimental (setup_log_auto:v1, Gate A-E, pair auto-entry, Track 1-3,
           dev-auto-entry.html). Mirror aturan daun_merah.md, discope ke inisiatif ini saja.
BOLEH    : Fitur, bugfix, keputusan arsitektur, hasil verifikasi — SEMUA yang menyentuh logika/
           keputusan trading auto-entry (pair, gate, track, prompt AI khusus auto-entry, cost/
           win-rate/korelasi khusus auto-entry).
DILARANG : Infra umum yang melayani SELURUH app walau auto-entry numpang di atasnya (daemon VPS
           Plan Q, OHLCV sync umum, streaming candle 14 pair FX, alert berita/harga generik) ->
           tetap di Dokumentasi/daun_merah.md. Riset/eksperimen -> riset.md (folder ini).
           Pekerjaan tertunda -> progress.md (folder ini). Plan aktif -> plan.md (folder ini).
FORMAT   : Changelog append per sesi (terbaru di atas), sama persis format daun_merah.md.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-08-08 — dipisah dari `Dokumentasi/daun_merah.md` atas permintaan user: inisiatif jangka panjang (tujuan akhir: AI kelola dana riil) butuh ruang dokumentasi sendiri, bukan bercampur dengan changelog fitur publik lain. Seluruh entri historis yang secara eksplisit tentang auto-entry/Plan U dimigrasi ke sini dari `daun_merah.md` pada tanggal yang sama (lihat commit migrasi) — entri yang TIDAK dipindah berarti dinilai infra umum/campuran, tetap di `daun_merah.md`.


## Changelog Session 318 (2026-08-18) — Gate A (Kritikus) Sekarang Juga Menimbang Refine-in-Place

**Konteks:** Audit lanjutan dari user cek status SL setup `AUDNZD=X:1786695344751` (lihat `daun_merah.md` Session 318 untuk fix `commentary` yang tidak ter-refresh saat refine — bug berbeda tapi ditemukan di sesi & investigasi yang sama). Pertanyaan user "apakah Sistem Hakim kasih tahu soal event Westpac sebelum entry?" menuntun ke audit Gate A (AI Kritikus, `_runCriticVerdict`) — ternyata Kritikus TIDAK PERNAH dipanggil untuk skenario refine-in-place sama sekali.

**Root cause:** blok "Skenario Refinemen" (bias searah, `api/admin.js`) selalu set `blockedByOpenPosition = true` setelah menimpa `stalePending`, dan `autoGuardConsidered` (penggerbang Gate B/D/A) didefinisikan `isAutoCall && !dup && !blockedByOpenPosition` — jadi refine SELALU membuat `needsGateA` jatuh ke `false`. Akibatnya level entry/SL/TP FINAL yang benar-benar live (hasil refine ke-N) tidak pernah diaudit Kritikus, cuma generasi PERTAMA (kalau itu pun sempat lolos Gate D/B) yang pernah dicek — riwayat veto Kritikus cuma 1x dari 42 setup total (`gate_critic_veto`).

**Fix:** refine-in-place sekarang di-STAGE ke variabel `refineCandidate = { id, fields }` alih-alih langsung menimpa `stalePending` — `blockedByOpenPosition` TIDAK lagi dipasang di blok ini, jadi `autoGuardConsidered`/`needsGateA` mengalir natural sama seperti kandidat baru (Gate B/D korelasi & drawdown otomatis ikut berlaku juga untuk refine, efek samping yang disengaja — konsisten, bukan scope creep). Di Fase 2 (setelah Gate A, pola persis `buildNewSetupEntry()`): kalau target masih `pending` (race guard, id dicari ulang dari log segar) dan verdict BUKAN "batalkan", `refineCandidate.fields` di-`Object.assign` ke entry lama + `auto_guard_stats:saved_refine` naik. Kalau verdict "batalkan": level LAMA dipertahankan apa adanya (refine dianggap tidak pernah terjadi, BUKAN membatalkan posisi pending-nya), `refined_count` TIDAK naik, `auto_guard_stats:critic_veto_refine` naik (counter terpisah dari `critic_veto` milik kandidat baru — semantik beda, tidak boleh campur).

**Test:** 2 test baru di `test/admin/gate_a_race.test.js` (verdict lanjut -> level diterapkan; verdict batalkan -> level lama dipertahankan + `refined_count` tetap). `npm test` 1020/1020 hijau.

**Ide terkait yang DIPARKIR (bukan dikerjakan sesi ini):** tambah tipe trigger `calendar_event` ke `invalidation_trigger` (skema sekarang cuma dukung trigger harga) — lihat `riset.md` folder ini untuk detail & alasan penundaan.

## Changelog Session 319 (2026-08-18) — Stempel Versi Kebijakan per Setup + Gate D Menghitung Pending

**Konteks:** eksekusi 2 dari 3 temuan audit menyeluruh sesi sebelumnya (`riset.md` folder ini §Audit menyeluruh 2026-08-18, poin A1 & A3) setelah user memilih opsinya. Poin A2 (rumusan Plan U item #8 salah karena `riskMultiplier` tidak pernah menyentuh jalur auto) tidak butuh kode — rumusannya dikoreksi langsung di `progress.md` folder ini.

### 1. Stempel versi kebijakan (`policy_v`) — poin A3

**Masalah:** jalur keputusan auto-entry berubah ±26 kali sejak deploy Plan U (2026-07-20) sementara sampel n≥100 sedang dikumpulkan, dan tidak ada satu pun field yang merekam "setup ini lahir di bawah aturan versi berapa". Sampel yang terkumpul karena itu bukan satu populasi, dan tidak ada cara memisahkannya lagi selain rekonstruksi manual `ts` vs tanggal commit.

**Keputusan user: stempel versi, BUKAN pembekuan perubahan.** Sistem boleh terus berkembang; yang dibenahi adalah kemampuan menelusuri. Konsekuensinya diterima sadar: analisis n≥100 nanti harus dilakukan per-segmen (atau setidaknya sadar segmennya), bukan satu kolam besar.

**Implementasi (`api/_auto_entry_guard.js`):** `POLICY_EPOCHS` — 27 epoch, tiap entri `{ v, from (waktu commit UTC), impact, label }`. `from` diambil dari waktu commit asli di `git log` (bukan tanggal kira-kira), sehingga setup lama bisa dipetakan retroaktif dengan presisi jam, bukan hari. `impact` (`baseline`/`entry`/`pair_set`/`levels`/`exit`/`context`/`eval`) menandai APA yang berubah supaya penganalisis tidak wajib membelah sampel di setiap versi — pertanyaan win-rate cukup dibelah di `entry`/`pair_set`/`levels`/`exit`. `POLICY_VERSION` = versi epoch terakhir; `policyVersionForTs(ts)` memetakan setup lama.

**Aturan pemeliharaan yang ikut ditulis di kode:** epoch baru WAJIB ditambah setiap kali mengubah apa yang menentukan trade mana yang terjadi, di level berapa, di pair apa, atau kapan keluar. Perubahan murni observability/UI TIDAK menambah epoch (kalau tidak, jumlah epoch jadi tak bermakna). Epoch lama TIDAK boleh diedit.

**Perubahan (`api/admin.js`):** `policy_v: POLICY_VERSION` di `buildNewSetupEntry` DAN di `refineCandidate.fields` (level yang benar-benar live lahir dari kebijakan saat refine, bukan saat generasi pertama — pola sama `regime`/`model`). `_statsPayloadFromLog` mengisi `policy_v_est` untuk entri lama **saat dibaca saja, tanpa menulis balik ke Redis** — nama field sengaja dibedakan (`policy_v` = fakta yang direkam, `policy_v_est` = rekonstruksi), prinsip U-5a. Payload scope=auto sekarang juga membawa registry `policy_epochs` supaya penganalisis tidak perlu membuka source code. Payload publik tidak tersentuh (kedua pemanggil `_statsPayloadFromLog` adalah jalur scope=auto).

**Evaluasi mandiri sesi yang sama (celah di perubahan sendiri, ketahuan sebelum dianggap selesai):** `buildNewSetupEntry` adalah closure BERSAMA untuk `setup_log:v1` (manual, payload PUBLIK) dan `setup_log_auto:v1` (auto). Stempel versi awalnya dipasang tanpa gerbang, artinya (a) entri manual ikut dilabeli versi kebijakan yang tidak pernah berlaku untuknya — Gate A/B/D memang tidak pernah jalan di jalur manual — dan (b) key baru muncul di payload publik, melanggar isolasi senyap U-7. Sekarang digerbang `isAutoCall` lewat spread kondisional, jadi untuk manual field-nya HILANG SAMA SEKALI (bukan diisi `null` seperti tetangganya `cme_priority_prompt_v`) — U-7 melarang perubahan payload publik, dan key baru bernilai null tetap perubahan payload. Beda pola itu disengaja dan ditulis di komentar kode supaya tidak "diseragamkan" orang berikutnya.

**Perubahan (`dev-auto-entry.html`):** baris "Versi Kebijakan" di grup Parameter Trade — menampilkan `v{n} — {label epoch} [direkam saat setup dibuat | perkiraan dari waktu setup, bukan data asli]`, jadi asal-usul angkanya kelihatan langsung tanpa perlu tahu bedanya dua field itu.

**Batas presisi (didokumentasikan di kode, bukan disembunyikan):** `from` = waktu commit; deploy Vercel menyusul ~1 menit, perubahan `vps/daemon.js` menunggu redeploy Railway. Setup yang `ts`-nya jatuh dalam ~15 menit setelah batas epoch harus diperlakukan sebagai versi TIDAK PASTI.

### 2. Gate D menghitung posisi `pending` sebagai exposure — poin A1

**Masalah:** `isCorrelatedExposureBlocked` hanya menghitung partner ber-status `'open'`. Karena semua entry sistem ini limit order di zona konfluensi, `pending` justru state yang paling lama dihuni — dua setup korelatif bisa sama-sama `pending` searah lalu terisi di jam yang sama tanpa cap korelasi pernah menyala.

**Perubahan:** `EXPOSURE_BINDING_STATUSES = new Set(['open', 'pending'])`. Parameter `positions` (nama lama `openPositions` tetap diterima supaya call site & test lama tidak berubah beramai-ramai). Call site `api/admin.js` memakai nama baru.

**Yang SENGAJA tidak dilakukan:** tidak ada ambang umur pending ("hitung hanya yang < N jam") — itu akan menambah satu angka tebakan baru yang tidak tervalidasi, persis pola yang dihindari proyek ini (preseden Gate E). Biaya/manfaat perubahan ini tidak perlu ditebak: kandidat yang ditahan sudah otomatis jadi ghost (`canceled_reason: 'gate_correlation_cap'`), jadi `gate_reject_ghost` akan menunjukkan `saved` vs `cost` apa adanya.

**Trade-off diterima sadar:** gate jadi lebih sering menahan → laju sampel bisa sedikit melambat. Dampaknya terbatas: hanya 2 pasangan yang dipetakan di `CORRELATED_PAIRS` (bukan seluruh 5 pair), dan `pending` punya umur terbatas sendiri (jadi `expired` setelah horizon×1,5).

**Test:** 11 test baru — 5 di `test/api/_auto_entry_guard.test.js` untuk Gate D (pending searah blocked, pending berlawanan lolos, 7 status non-binding diabaikan, alias parameter lama, isi `EXPOSURE_BINDING_STATUSES`), 4 untuk registry versi (urutan/tanggal/label/impact valid, `POLICY_VERSION` sinkron, pemetaan `ts` termasuk tepat-di-batas & sebelum epoch pertama, input invalid → null), 4 di `test/admin/ta_struct.test.js` (`policy_v_est` diisi untuk entri lama, objek asli TIDAK dimutasi, entri baru tidak ditimpa, `ts` invalid tidak dikarang, registry ikut di payload). Satu test lama (`partner pending -> TIDAK blocked`) ekspektasinya DIBALIK, bukan dihapus — supaya kalau perilaku ini balik lagi ke lama, ketahuan sebagai perubahan sadar, bukan regresi diam-diam. `npm test` 1033/1033 hijau.

**Verifikasi live: BELUM.** Perlu minimal 1 siklus `runAutoEntryCycle` produksi setelah deploy untuk konfirmasi (a) setup baru benar membawa `policy_v: 27`, (b) entri lama tampil dengan `policy_v_est` di dashboard. Diparkir di `progress.md` folder ini.

## Changelog Session 316 (2026-08-16) — Gate D: Sign Statis Bisa Ditimpa Anomali Korelasi Live

**Konteks:** Audit kualitas informasi ke LLM trader (dipicu diskusi buku ekonometrika, lihat `daun_merah.md` Session 316 untuk konteks lengkap & 1 koreksi klaim yang sempat salah). Temuan: Gate D (`isCorrelatedExposureBlocked`, `api/_auto_entry_guard.js`) pakai tabel `CORRELATED_PAIRS` statis — sign korelasi (`positive`/`negative`) hasil riset manual bertanggal (GC=F-EURUSD=X: 26 Juli; EURUSD=X-CHFJPY=X: 8 Agustus), tidak pernah diperbarui otomatis — padahal `api/correlations.js` (`correlations_v3`) sudah menghitung ulang matriks korelasi 20D/60D TIAP HARI, termasuk deteksi anomali (`|r20-r60|>0,4`, sign-flip). Kalau korelasi riil sudah bergeser rezim sejak tanggal riset, Gate D tetap menahan/meloloskan posisi berdasar asumsi arah yang mungkin sudah tidak berlaku.

**Percobaan pertama — DIKOREKSI sebelum selesai (diskusi user, "apakah malah mencemari data?"):** implementasi awal menimpa sign statis pakai r20 mentah SETIAP HARI. User mempertanyakan risiko pencemaran — benar: r20 (rolling 20 hari) itu statistik berisik, bisa lintas-nol tanpa perubahan rezim sungguhan untuk pasangan yang korelasinya tidak terlalu kuat. Menimpa asumsi hasil riset manual dengan noise harian berisiko MENURUNKAN kualitas gate, bukan menaikkan.

**Desain final:** override sign HANYA kalau `correlations.js` sendiri sudah menandai pasangan itu sebagai anomali (`corrData.anomalies`, syarat `|r20-r60|>0,4` — ambang yang sudah dipakai & tervalidasi di tempat lain di sistem yang sama, bukan ambang baru buatan sendiri). Kalau tidak ada anomali terdeteksi untuk pasangan itu, diam-diam TETAP pakai sign statis. Pasangan yang salah satu legnya bukan instrumen langsung di `correlations.js` (CHFJPY=X — cross rate yang tidak difetch sendiri, cuma CHF & JPY masing-masing vs USD) juga otomatis fallback ke statis.

**File diubah:**
- `api/_auto_entry_guard.js` — `_correlationOf`/`isCorrelatedExposureBlocked` terima param opsional `liveSign` (map `{"A|B":"positive"|"negative"}`), default `undefined` = perilaku identik seperti sebelumnya (backward-compatible, semua test lama tidak diubah). `CORRELATED_PAIRS` diekspor.
- `api/admin.js` — `_buildLiveCorrSign(corrData)` (translasi simbol Yahoo ↔ label `correlations.js` via `CORR_SYMBOL_TO_LABEL`, baca dari `anomalies` bukan `matrix_20d` mentah) + fetch `correlations_v3` di luar critical section lock (pola sama `trackBlock`/`calAnalyzeBlock` — JANGAN tambah I/O di dalam lock mutasi log), hanya untuk `isAutoCall`. Hasil dioper ke `isCorrelatedExposureBlocked` di titik panggil Gate D.

**Catatan untuk evaluasi n≥100 epoch `post_cme`:** perubahan ini mengubah kondisi Gate D di tengah periode pengumpulan data (sama seperti perubahan CME yang memicu epoch-split sebelumnya) — TAPI berbeda dari kejadian itu, perubahan ini tidak mengubah desain dasar gate (masih heuristik sederhana per-pasangan, bukan covariance-matrix penuh), hanya sumber angka sign untuk kasus yang jarang terjadi (anomali terdeteksi). Dicatat di sini sebagai penanda kalau nanti evaluasi batch perlu mempertimbangkan titik perubahan ini.

**Test:** 7 test baru — 3 di `test/api/_auto_entry_guard.test.js` (liveSign override, fallback tanpa entry, backward-compatible tanpa param), 5 di `test/admin/ta_struct.test.js` (`_buildLiveCorrSign`: null/tanpa anomalies, override dari anomali terdeteksi, TIDAK override dari r20 non-anomali, pair CHF/JPY tetap tidak dipetakan, key urutan terbalik). `npm test` 1017/1017 hijau.

## Changelog Session 303 (2026-08-10) — Gate `makro_conflict` Dicoba lalu DIREVERT + Commentary AI Disimpan ke Log

**Konteks:** Lanjutan audit CHF/JPY sesi yang sama dengan [[project-currency-strength-cot-source-leakage-bug]] (Session 302). User audit setup CHF/JPY bullish dengan `makro_alignment:"konflik"` (JPY diprediksi menguat, berlawanan bias) tapi tetap tersimpan `pending` dengan entry/SL/TP lengkap — dikonfirmasi pola berulang di pair lain juga. Instruksi prompt (`entryZoneInstr`, `api/admin.js`) SUDAH sejak awal minta AI meng-null-kan `entry_zone/sl/tp` kalau `makro_alignment` "konflik", tapi murni permintaan teks, TIDAK PERNAH di-enforce kode — kemungkinan besar karena `entry_zone/sl/tp` diminta LEBIH DULU dari `makro_alignment` di skema JSON yang sama.

Terpisah, dijelaskan ke user kenapa `bias` bisa tetap "bullish" walau macro conflict — BUKAN bug: `bias` murni dari struktur teknikal (Daily+H4+BOS), independen dari `makro_alignment` (perbandingan terpisah), desain yang disengaja. TAPI penjelasan "kenapa teknikalnya masih dianggap kuat" itu ada di paragraf commentary AI, yang ternyata **tidak pernah disimpan ke `setup_log_auto:v1` sama sekali** — untuk setup auto (cron, tanpa penonton live), penjelasan itu hilang permanen begitu response API dibalas.

**Percobaan gate `makro_conflict` — DIBATALKAN sesi yang sama:** sempat ditambahkan gate keras (pola `correlation_cap`/`drawdown_circuit_breaker`) yang otomatis menahan kandidat `source:auto` begitu `makro_alignment` final = "konflik", sebelum Gate A dipanggil. User mempertanyakan ("gunanya sistem hakim apa?" + khawatir memperlambat laju entry) — ditelusuri ulang: `CRITIC_SYSTEM_PROMPT` (Gate A/AI Kritikus) SUDAH secara eksplisit diminta "fokus konflik makro" sebagai salah satu 4 hal wajib ditimbang, dan `makro_alignment`/`makro_alignment_reason` SUDAH dikirim ke Gate A sebagai fakta lewat `criticSetupBlock`. Gate keras itu berarti MENIMPA keputusan Gate A yang sudah menimbang info yang SAMA (bukan mengisi kekosongan) — dan berisiko mengurangi jumlah entry lebih dari yang diperkirakan (preseden [[gate-e-loosened-critic-veto-gap]]: hard block pernah bikin nol entry hari pertama, dilonggarkan). **Keputusan: revert total**, bukan diperlunak jadi observasi (opsi itu ditawarkan tapi tidak dipilih). Sistem Hakim sendiri BUKAN mekanisme penolak — dia HANYA mengoreksi label `makro_alignment` (lihat Session 301), tidak pernah membatalkan entry; yang menimbang layak-tidaknya trade adalah Gate A.

**Perubahan FINAL yang bertahan (`api/admin.js`):**
1. **`commentary` ditambah ke `buildNewSetupEntry`** — narasi lengkap 5-paragraf AI (termasuk penjelasan integrasi teknikal-vs-makro di paragraf 4) sekarang disimpan apa adanya (nullable, tanpa cap panjang tambahan). Berlaku untuk `setup_log:v1` (manual) MAUPUN `setup_log_auto:v1` (auto), satu closure yang sama.
2. Gate `makro_conflict`, entri `GHOST_TRACKED_CANCEL_REASONS`, dan registry `auto_guard_stats:makro_conflict` — DITAMBAH lalu DIHAPUS LAGI sesi yang sama, tidak ada jejak tersisa di kode (hanya komentar penjelasan di `autoGuardConsidered` block supaya tidak dicoba ulang tanpa alasan baru).

**Perubahan (`dev-auto-entry.html`):** helper baru `fldLong()` (beda dari `fld()` — full-width, `white-space:pre-wrap` supaya paragraf commentary tidak dipadatkan jadi satu baris), dipasang sebagai baris "Analisa Lengkap (AI)" di grup Ringkasan `buildSetupDetail()`. Ini BERTAHAN (tidak direvert) — murni tampilan, tidak mengubah keputusan trading apa pun.

**Test:** `npm test` 926/926 hijau (kembali ke baseline sebelum gate ditambah, +1 assertion baru commentary di `test/admin/pair_context_prompt.test.js`). `test/admin/gate_makro_conflict.test.js` sempat dibuat (3 test) lalu dihapus bersama revert-nya.

**Pelajaran untuk audit berikutnya (dicatat di `audit_workflow.md` §3a supaya tidak diusulkan ulang tanpa alasan baru):** kalau ketemu setup `source:auto` dengan `makro_alignment:"konflik"` tapi tetap `pending`/`open`, itu BUKAN otomatis bug — Gate A kemungkinan besar sudah menimbang info itu dan memutuskan `tunda`/`lanjut`. Tidak ada field per-setup yang merekam objection Gate A saat verdict bukan `batalkan` (celah observability terpisah, belum diminta dibangun).

## Changelog Session 296 (2026-08-08) — Tambah CHF/JPY sebagai Pair Ke-5 + Redesain Ruang Dokumentasi "Professional LLM Trader"

**Konteks:** User usul menambah CHF/JPY sebagai pair auto-entry ke-5, berdasar hipotesis "dua currency safe-haven kurang berhubungan ke 4 pair aktif". Diskusi & pengukuran ulang lengkap ada di `riset.md` folder ini §"Evaluasi ulang CHF/JPY sebagai pair ke-5" — ringkas: kandidat ini pernah GAGAL dites (Session 246-247) lawan Golden Trio lama (korelasi r=0,48, terkorelatif dari semua kandidat), tapi diukur ulang lawan 4 pair yang AKTIF SEKARANG (bukan set lama yang GBP/USD-nya sudah dibuang) hasilnya jauh lebih baik: rata-rata \|r\|=0,18, opportunity rate 66% setara EUR/GBP. Root cause pembalikan: GBP/USD (korelasi lumayan ke CHF/JPY, r=0,316) sudah tidak lagi jadi pembanding.

**Perubahan kode:**
1. `vps/daemon.js` — `AUTO_ENTRY_SYMBOL_MAP` tambah `frxCHFJPY: {symbol:'CHFJPY=X', label:'CHF/JPY'}`; default `AUTO_ENTRY_PAIRS` jadi `frxXAUUSD,frxEURUSD,frxAUDNZD,frxEURGBP,frxCHFJPY` (5 pair). TIDAK ditambah ke `YAHOO_TO_DERIV_SYMBOL` (Yahoo-only, sama pola AUD/NZD) dan TIDAK dikasih jam khusus (ikut jadwal utama 08:00/13:00 UTC — tidak ada bukti kuat sesi likuiditas CHF/JPY jauh dari London/NY, beda dari AUD/NZD yang punya alasan Sydney-Tokyo eksplisit).
2. `api/admin.js` — `OHLCV_FIXED_PAIRS` tambah `CHFJPY=X`; `SPREAD_PRICE_ESTIMATE` tambah `'CHF/JPY': 0.030` (WAJIB diisi dari awal — histori bug AUD/NZD lupa diisi, pelajaran yang jadi dasar checklist `pair_workflow.md` Tahap 2d).
3. `api/_ohlcv_fetch.js` — `YAHOO_TO_TWELVEDATA_SYMBOL` tambah `'CHFJPY=X': 'CHF/JPY'` (fallback kalau Yahoo down).
4. `api/_auto_entry_guard.js` — **Gate D di-refactor** dari model lama `CORRELATED_PARTNER`/`USD_VIEW_BY_SYMBOL_BIAS` (cuma berlaku untuk pasangan yang dua-duanya punya kaki USD) jadi `CORRELATED_PAIRS` generik (array `{a, b, sign}`, `sign:'positive'`/`'negative'` menentukan exposure searah dicek dari bias SAMA atau BERLAWANAN) — CHF/JPY tidak punya kaki USD sama sekali, jadi korelasinya ke EUR/USD (r=0,373) dicek langsung dari arah bias, bukan lewat abstraksi USD view. Perilaku pasangan lama GC=F/EURUSD=X TIDAK berubah (dites eksplisit, semua 7 test lama tetap hijau tanpa modifikasi).
5. `api/_pair_context.js` — `STRUCTURAL_PROFILES` untuk CHF/JPY awalnya SENGAJA dikosongkan di draf pertama sesi ini (alasan: framing "skeptis breakout" AUD/NZD & EUR/GBP salah kalibrasi untuk pair ini) — **direvisi di Addendum bawah** setelah user menegaskan tiap pair wajib punya karakterisasi eksplisit, bukan sekadar kosong.
6. `api/calendar.js` — **Bug ditemukan & difix saat audit checklist**: `SURPRISE_CURRENCIES` di file ini ternyata HARDCODE (`{USD,EUR,GBP,AUD,NZD}`), TERPISAH dari versi di `vps/daemon.js` yang auto-derive dari `AUTO_ENTRY_PAIRS` — kalau tidak ketahuan, event kalender CHF/JPY tidak akan pernah masuk cache `calendar_surprise_v1` walau pair-nya sudah aktif. Ditambahkan `CHF`/`JPY`, komentar diperjelas soal risiko drift dua konstanta terpisah ini ke depannya.
7. Test: `test/api/_auto_entry_guard.test.js` (5 test baru Gate D CHF/JPY), `test/vps/auto_entry.test.js` (update assert 5-pair + `SURPRISE_CURRENCIES` 7-currency + test baru symbol map CHF/JPY), `test/api/calendar.test.js` (update assert `SURPRISE_CURRENCIES` + `buildSurpriseEvents`).

**Redesain dokumentasi (bagian sama sesi ini, permintaan user terpisah):** inisiatif ini (eks-"Plan U") dipindah dari `Dokumentasi/daun_merah.md`/`_riset.md`/`_progress.md`/`_plan.md` ke ruang sendiri `Dokumentasi/professional_llm_trader/` (folder ini) — mirror struktur 4-file yang sama (changelog/riset/progress/plan) + file baru `pair_workflow.md` (SOP formal menambah pair baru: indikator kelayakan 2 dimensi + profiling karakteristik + checklist titik kode, disarikan dari proses nyata redesain 4-pair DAN evaluasi CHF/JPY ini). `ATURAN.md` §1/§2 diupdate nunjuk ruang baru ini; `.gitignore` ditambah `professional_llm_trader/plan.md`/`progress.md` (mengikuti konvensi lama `daun_merah_plan.md`/`_progress.md` local-only). Migrasi historis dikerjakan agent terpisah untuk `daun_merah.md` (44 heading session dipindah verbatim, 4 heading campuran sengaja dibiarkan — detail di `changelog.md` ini bagian atas / commit migrasi) dan manual untuk `riset.md`/`progress.md`/`plan.md` (volume lebih kecil).

**Verifikasi:** `npm test` 896/896 hijau (896 = 890 sebelum sesi ini + 6 net baru setelah update/tambah test). Verifikasi live BELUM dilakukan — butuh minimal 1 siklus `runAutoEntryCycle` produksi untuk konfirmasi CHF/JPY benar-benar menghasilkan setup pertama (dicatat sebagai item pending di `progress.md` folder ini kalau perlu, atau cek manual lewat `dev-auto-entry.html`).

### Addendum (lanjutan sesi sama) — Riset Karakteristik Ke-5 Pair Aktif + Dua Jenis Framing `STRUCTURAL_PROFILES`

**Konteks:** User tanya balik "apakah AI sudah menguasai karakteristik CHF/JPY?" dan "apakah AI sudah mengerti cara entry masing-masing pair?" — audit jujur menemukan poin 5 di atas (STRUCTURAL_PROFILES CHF/JPY sengaja kosong) itu GAP, bukan keputusan final yang benar: CHF/JPY jadi satu-satunya dari 5 pair aktif yang TIDAK dapat data fundamental dalam (COT/CME cuma untuk pair berkaki USD) MAUPUN catatan naratif — beda dari EUR/USD & XAU/USD yang memang tergantikan kedalaman data. User lalu eksplisit minta SEMUA pair diriset & didokumentasikan faktor kekuatan/kelemahannya, dicatat di `pair_workflow.md`.

**Riset (web search, sumber dicantumkan per pair di `pair_workflow.md` §"Faktor Kekuatan/Kelemahan per Pair Aktif"):** XAU/USD (real yield USD, USD strength, pembelian bank sentral, risiko geopolitik), EUR/USD (differential suku bunga Fed-ECB, ~300-400 pip per 50bp), AUD/NZD & EUR/GBP (sudah ada dari riset 2026-08-04, dikonfirmasi ulang), CHF/JPY (temuan kunci: CHF = flight-to-quality asli + intervensi SNB aktif sejak 2009; JPY = terutama UNWIND CARRY TRADE bukan murni safe-haven inflow, dengan ambang VIX 18/27/40 yang beda rezim; risiko intervensi BOJ sepihak — 2022 ¥2,8T, 2024 7x intervensi ¥24,5T — bisa bikin lonjakan vertikal yang BUKAN sinyal teknikal).

**Revisi mekanisme `STRUCTURAL_PROFILES` (`api/_pair_context.js`):** dari "cuma untuk range-bound" jadi TIGA jalur eksplisit (didokumentasikan di `pair_workflow.md` Tahap 2a) — (1) range-bound/naratif skeptis-breakout (AUD/NZD, EUR/GBP, tidak berubah), (2) trending TAPI sudah dapat data fundamental dalam → SKIP `STRUCTURAL_PROFILES`, tambah catatan kausal langsung di `_formatFundamentalBlock` (XAU/USD sudah punya `goldNote`; EUR/USD BARU ditambah baris "DIFFERENTIAL SUKU BUNGA EUR-USD" dihitung otomatis dari selisih real yield EUR-USD), (3) trending TANPA data fundamental dalam → ISI `STRUCTURAL_PROFILES` dengan framing KEBALIKAN dari (1): "jangan skeptis breakout, momentum bisa valid & tiba-tiba, TAPI waspada risiko spesifik" (CHF/JPY: risiko intervensi bank sentral sepihak) — mekanisme suntik ke prompt (gate `regime === 'bergejolak'`) TIDAK berubah, cuma isi framingnya yang beda.

**Verifikasi:** `npm test` 900/900 hijau (4 test baru: 2 di `test/lib/pair_context.test.js` untuk CHF/JPY bergejolak/normal, 2 di `test/admin/makro_ctx.test.js` untuk baris differential EUR/USD muncul & tidak muncul di pair lain).

## Changelog Session 294 (2026-08-08) — Karantina Framing CME-Priority ke isAutoCall + Penanda Versi Prompt

**Konteks:** Koreksi diri langsung setelah Session 293 di-push. User tanya "apakah ini semua masih selaras dengan Plan U?" — audit ulang kode menemukan celah: `fundBlock`/`rrBlock` (tempat framing "CME diprioritaskan di atas COT" ditanam Session 293) dibangun SEBELUM percabangan `isAutoCall` di `ohlcvAnalyzeHandler`, dipakai bareng oleh jalur manual publik ("Analisa AI", tombol yang siapa saja bisa klik) DAN jalur auto-entry (eksperimen developer-only). Artinya framing baru — yang justifikasi awalnya sendiri sudah terbukti lemah (klaim "0% win rate" salah hitung, Session 292) — sudah ikut memengaruhi fitur PUBLIK sejak Session 293, bukan cuma dites diam-diam di eksperimen. Ini berlawanan dengan prinsip isolasi Plan U/U-7 ("auto-entry eksperimen senyap, publik cuma dapat fitur informasi").

**Perbaikan (`api/admin.js`):**
- `_formatOptionsSentimentBlock(rr, prioritized)` — parameter baru. `prioritized` falsy (default) = framing LAMA ("cross-check tambahan, jangan mengubah bias"); `prioritized: true` = framing BARU Session 293 ("DIPRIORITASKAN di atas COT"). Fail-safe: parameter tidak diisi jatuh ke versi lama/aman, bukan versi baru.
- `ohlcvAnalyzeHandler`: `_formatOptionsSentimentBlock(rrPairSnapshot, isAutoCall)` — framing baru HANYA aktif kalau request ini benar cron auto-entry. `_formatFundamentalBlock`'s `hasCmeData` juga ditambah `&& isAutoCall`.
- `ohlcvCriticHandler` (tombol manual publik "UJI KELEMAHAN") — 100% tidak pernah dipanggil dari pipeline auto-entry (Gate A auto-entry pakai `_runCriticVerdict` langsung di dalam `ohlcvAnalyzeHandler`, bukan lewat endpoint ini), jadi `hasCmeData`/`prioritized` di sini sengaja TIDAK PERNAH diaktifkan — dikembalikan ke framing lama sepenuhnya.
- **Penanda versi prompt baru:** `COT_CME_PROMPT_VERSION` (const, saat ini `1`) + field `cme_priority_prompt_v` di tiap setup auto-entry (null = framing lama, angka = framing baru yang aktif saat setup itu dibuat). Beda dari `macro_snapshot.v` (itu versi skema DATA, ini versi LOGIC prompt) — mitigasi supaya nanti bisa dibedakan setup mana yang analisisnya dipengaruhi framing baru vs lama, tanpa nebak dari timestamp `ts`.

**Test:** `test/admin/makro_ctx.test.js` — 2 test lama diupdate (signature `_formatOptionsSentimentBlock` berubah), 1 test baru memverifikasi default/false tetap framing lama. Full suite: **890/890 hijau**.

**Catatan buat evaluasi nanti:** publik ("Analisa AI" + "UJI KELEMAHAN") untuk XAU/USD & EUR/USD sekarang KONSISTEN kembali dengan pair lain (framing netral, tidak ada prioritas CME eksplisit) — cuma jalur auto-entry developer-only yang dapat framing baru. Kalau nanti data `macro_snapshot`/`cme_priority_prompt_v` memvalidasi framing baru ini beneran membantu, baru layak dipertimbangkan dibuka ke publik juga.

**Addendum (sama sesi, self-check "ada lagi?"):** `_aggGateRejectGhostStats` (Session 292) sudah punya data lengkap tapi belum ada tampilannya di `dev-auto-entry.html` — dashboard dev sudah lama menampilkan `cancel_flip_ghost` (kartu "Manajemen Posisi & Cancel-Flip Ghost") tapi `gate_reject_ghost` yang baru dibangun tidak ikut kebagian kartu. Ditambahkan kartu baru "Ghost-Tracking Kandidat Ditahan Gate D/B/A" (`renderGateGhost`, dipecah per gate: correlation_cap/drawdown_circuit_breaker/critic_veto, masing-masing total/saved/cost/ambiguous/expired/pending) supaya datanya benar-benar bisa dibaca, bukan cuma tersimpan di JSON. Tidak ada perubahan `api/admin.js` — murni tambahan UI di `dev-auto-entry.html`, dicek sintaks JS-nya (`new Function`) tanpa error.

**Addendum 2 (sama sesi, user minta "rapihin tampilan dev-auto-entry, tapi semua info tetap kelihatan"):** dicek visual langsung via Playwright (server statis lokal + screenshot penuh-halaman, data dummy realistis) — halaman terdiri 9 kartu ditumpuk vertikal, secara individual rapi tapi 2 masalah nyata: (1) kartu "Manajemen Posisi & Cancel-Flip Ghost" mencampur 2 kelompok angka berbeda dalam satu grid TANPA pemisah sama sekali (dan kartu Ghost-Tracking baru tadi juga meniru gaya kotak-stat buat label kelompok, bukan caption yang jelas); (2) halaman jadi sangat panjang (9 kartu) tanpa cara cepat lompat ke bagian tertentu. Perbaikan (murni tampilan, **nol data dihapus/disembunyikan**):
- CSS class baru `.subhead` (caption teks kecil warna aksen, bukan kotak stat) dipakai buat memisahkan "Manajemen Posisi (U-5a)" vs "Cancel-Flip Ghost (U-3 lanjutan)" di kartu yang sama, dan tiap grup gate (Correlation Cap/Drawdown/Critic Veto) di kartu Ghost-Tracking.
- Quick-nav (`<div class="quicknav">`, deretan pill link) di atas tab Dashboard — lompat langsung ke salah satu dari 9 kartu, tiap kartu dikasih `id` + `scroll-margin-top`. Dicek fungsional via Playwright: klik link `#card-recent` benar-benar scroll ke kartu "Riwayat Setup".
- Panel respons bawah (`#respPanel`, `position:sticky`) sempat kelihatan "menimpa" konten di screenshot penuh-halaman — dicek ulang scroll manual (`scrollTo`), itu murni artefak cara browser render `position:sticky` saat screenshot 1 halaman panjang sekaligus, BUKAN bug nyata (posisinya benar nempel di bawah viewport saat scroll normal).

**Addendum 3 (sama sesi, user kirim screenshot baris detail "Riwayat Setup" — masih berantakan, minta filter jadi ikon):**
- **Baris detail setup** (`buildSetupDetail`, expand klik baris tabel): dulu 25+ field (narasi panjang AI campur tag pendek campur angka) ditulis DATAR tanpa kelompok sama sekali — persis keluhan di screenshot user. Dikelompokkan jadi 7 bagian pakai `.subhead` yang sama (Ringkasan / Makro & Konflik / Parameter Trade / Label Hasil / Invalidasi Teknikal / Intervensi Posisi / Anomali Data) lewat helper baru `fldGroup()`. Kelompok yang seluruh isinya kosong untuk setup tertentu otomatis tidak tampil. **Nol field dihapus** — beberapa label yang tadinya mengulang nama kelompoknya sendiri (mis. "Alasan Intervensi" → "Alasan", karena sudah di bawah judul "Intervensi Posisi") dipersingkat, isinya sama persis.
- **Filter Riwayat Setup**: `<select>` teks diganti badge/tombol yang bisa diklik langsung. Filter Status pakai warna `.badge` YANG SAMA dengan badge status di tabel (bukan emoji — dilarang ATURAN.md §4, badge warna adalah "ikon" yang sudah ada di sistem desain ini). Filter Pair pakai gaya `.pagebtn` yang sudah ada (dipakai pager tabel). State filter dipindah dari `<select>.value` ke variabel JS biasa (`filterStatusVal`/`filterSymbolVal`).
- Diverifikasi fungsional via Playwright (bukan cuma visual): klik badge status `sl` benar-benar memfilter ke 1 baris yang sesuai, klik tombol pair `AUDNZD=X` benar-benar memfilter ke pair itu saja.

**Addendum 4 (sama sesi, user kirim screenshot: baris Filter Status + Filter Pair di "Riwayat Setup" masih selalu terbuka, minta dibungkus ikon):**
- Tombol ikon corong (SVG inline, bukan emoji — sesuai ATURAN.md §4) di samping judul "Riwayat Setup", klik untuk buka/tutup panel filter (`#filterRow`, default tertutup via `max-height:0`). Ada badge angka merah di tombol kalau ada filter aktif (status dan/atau pair), supaya tetap kelihatan walau panelnya sedang ditutup.
- **Filter Pair dipersempit dari 8 pair ke 4 pair AKTIF** (`ACTIVE_FILTER_PAIRS`: GC=F, EURUSD=X, AUDNZD=X, EURGBP=X) — user tegur langsung ("kita kan cuma 4 pair, ngapain filternya banyak pair itu"). List lama (8 pair, termasuk GBPUSD/USDJPY/AUDUSD/USDCAD/USDCHF/NZDUSD yang sudah tidak aktif sejak narrowing ke Golden Trio+EURGBP) tetap dipakai apa adanya di `PAIRS` konstanta untuk Trigger Analisa manual (sengaja tetap luas, beda kebutuhan). Pair non-aktif yang masih punya baris data historis tetap muncul di filter lewat fallback "extra" (dihitung dari data asli, bukan daftar statis).
- **Layout badge dirapikan** — percobaan pertama melebarkan `.filterrow > div` supaya badge mengalir 1 baris penuh (`flex:0 0 auto`) DITOLAK user ("gaenak, mending yang tadi yang menurun"): lebih suka gaya menurun/multi-baris yang lama, cuma minta rapi. Solusi akhir: `.filterbtns` diganti dari `flex-wrap` (ragged, lebar tiap baris beda-beda) jadi CSS grid 3 kolom (`grid-template-columns:repeat(3,max-content)`) — badge tetap wrap ke bawah per 3 item, tapi sekarang sejajar rapi per kolom.
- Diverifikasi via Playwright (server statis lokal): toggle buka/tutup fungsional, badge count nyala saat filter aktif, filter pair benar cuma tampilkan 4 pair aktif, grid 3 kolom sejajar rapi.

## Changelog Session 293 (2026-08-08) — Reordering Prioritas COT vs CME di Prompt (Khusus XAU/USD & EUR/USD)

**Konteks:** Lanjutan Session 292. Dibedakan dua hal yang sempat tercampur di diskusi: (a) mekanisme **hard-block** dengan angka ambang skew spesifik (mis. `|rr_value| > 1.1` → paksa `entry_zone` null) — ini yang memang harus nunggu `macro_snapshot` terkumpul dulu untuk kalibrasi (masih TERTUNDA, lihat `daun_merah_progress.md`), vs (b) sekadar **mengubah framing/penekanan kalimat** di prompt (COT diberi catatan "data mingguan, lebih rendah prioritas" — CME diberi catatan "real-time, lebih diprioritaskan") — TIDAK butuh data apa pun untuk mulai, karena bukan aturan keras berangka, AI tetap yang memutuskan. Bagian (b) inilah yang dieksekusi sesi ini.

**Perubahan (`api/admin.js`), khusus berlaku untuk XAU/USD & EUR/USD** (satu-satunya 2 dari 4 pair auto-entry yang punya data CME CVOL — AUD/NZD & EUR/GBP otomatis TIDAK tersentuh sama sekali karena `rrPairSnapshot` selalu null buat mereka, bukan pair CVOL):

- **`_formatFundamentalBlock`**: parameter baru `hasCmeData` (boolean). Kalau true, catatan penutup blok fundamental menyertakan kalimat eksplisit: COT CFTC itu data mingguan (bisa lag beberapa hari) dan CME options skew (kalau ada di prompt yang sama) real-time serta LEBIH DIPRIORITASKAN untuk arah.
- **`_formatOptionsSentimentBlock`**: framing lama diganti total — dulu "*pakai sebagai cross-check tambahan, BUKAN sinyal utama...jangan mengubah bias*" (inilah gap yang ditemukan di audit CME sebelumnya), sekarang "*real-time — DIPRIORITASKAN di atas data COT mingguan untuk konfirmasi ARAH...kalau berlawanan dengan bias teknikal, pertimbangkan serius sebagai alasan menurunkan keyakinan atau meninjau ulang arah*". Tetap BUKAN auto-block — kalimat terakhir eksplisit bilang "tetap keputusanmu, bukan otomatis dibatalkan".
- **Reordering fetch di `ohlcvAnalyzeHandler`**: blok CME skew (`rr_cache_v2`) dipindah ke SEBELUM blok fundamental (dulu sesudah) supaya `rrPairSnapshot` siap dipakai untuk hitung `hasCmeData` — bukan fetch tambahan, cuma urutan baca cache yang sudah ada.
- **`ohlcvCriticHandler`** (tombol manual "UJI KELEMAHAN", fact sheet Gate A AI Kritikus) — fix yang sama diterapkan (parse `rawRR` sekali, `hasCmeData` dipakai di kedua blok) supaya konsisten dengan jalur auto-entry, tidak ada 2 sumber kebenaran.

**Test:** 4 test baru di `test/admin/makro_ctx.test.js` (hasCmeData true/false untuk `_formatFundamentalBlock`, framing baru + fail-open untuk `_formatOptionsSentimentBlock`, yang terakhir ini baru pertama kali diekspor/diuji langsung — sebelumnya nol test langsung). Full suite: **889/889 hijau**.

**Belum berubah:** ambang angka skew (masih observasi, belum ada hard-block), dan `daun_merah_progress.md` entri S292 diupdate untuk reflect bahwa cuma bagian hard-block yang masih tertunda data.

## Changelog Session 292 (2026-08-08) — Macro Snapshot per Setup + Ghost-Tracking Gate D/B/A

**Konteks:** Rapat user dengan Gemini soal CME Options Skew (`Dokumentasi/ringkasan_rapat_auto_entry_cme.md`) mengusulkan menaikkan prioritas CME CVOL skew di atas COT untuk XAU/USD & EUR/USD. Audit balik ke data mentah `setup_log_auto:v1` (bukan cuma percaya klaim dokumen) menemukan: (1) klaim "XAU/USD 0% WR (0 TP, 4 SL)" dan "EUR/GBP 0% WR" di dokumen SALAH HITUNG — win rate asli 25% dan 33% (1 TP masing-masing tertukar jadi SL); (2) akar masalah "AI melawan skew ekstrem" tidak bisa diverifikasi karena sistem TIDAK PERNAH menyimpan `rr_value`/skew ke record setup saat entry dibuat — cuma numpang lewat prompt lalu hilang, satu-satunya jejak kalau AI kebetulan menyebutnya di teks bebas `makro_alignment_reason` (cuma 1 dari 4 trade XAU lama begitu). Gap yang sama berlaku untuk SEMUA input makro lain (DXY, WTI, real yield per leg, COT per leg, retail sentiment, cb_bias) — tidak ada satupun yang direkam terstruktur.

**Keputusan (diskusi user):** sebelum menaikkan prioritas CME beneran, bangun dulu infrastruktur pencatatannya — supaya audit serupa di masa depan tidak lagi buta. Sekalian dibangun juga ghost-tracking untuk kandidat yang ditahan Gate D/B/A (celah yang sebelumnya "sengaja belum dibuat" — lihat Session 277/283) karena analog persis dengan `_evaluateCanceledGhost` (bias_flip) yang sudah ada, dan levelnya (entry/sl/tp) sudah selesai dihitung SEBELUM gate mana pun jalan — jadi nol biaya AI call tambahan.

**A. Macro snapshot per setup (`api/admin.js`):**
- `_buildMacroSnapshot()` (pure function, dekat `_formatFundamentalBlock`) — merangkum cb_bias/COT/retail per leg pair ini, real yield per leg, DXY/WTI, VIX/MOVE, dan CME skew (`rr_value`/`call_iv`/`put_iv`/`skew_change_pct`/`vol_level`/`convexity`) jadi satu objek `{ v: 1, cb_bias, cot, retail, real_yields, dxy, wti, vix, move, rr }`. Null kalau semua sumber kosong (fail-open, konsisten pola blok lain).
- Variabel `cotParsed`/`retailParsed`/`macroDrivers`/`riskParsed`/`rrPairSnapshot` diangkat dari scope try-block lokal ke scope `ohlcvAnalyzeHandler` (sebelumnya di-parse inline lalu hilang) — nol fetch Redis tambahan, tinggal reuse data yang sudah ditarik untuk prompt.
- Field baru `macro_snapshot` ditambahkan ke `buildNewSetupEntry()` — field `v:1` di dalamnya jadi penanda skema eksplisit (setup lama tanpa field ini otomatis `macro_snapshot: undefined`, gampang difilter di analisis nanti tanpa nebak-nebak null per sub-field).

**B. Ghost-tracking Gate D/B/A (`api/admin.js`):**
- `_evaluateCanceledGhost` digeneralisasi: dulu cuma proses `canceled_reason === 'bias_flip'`, sekarang pakai `GHOST_TRACKED_CANCEL_REASONS` (Set: `bias_flip`, `gate_correlation_cap`, `gate_drawdown_circuit_breaker`, `gate_critic_veto`). Filter `ghostPending` di `_buildAutoScopeStats` ikut digeneralisasi.
- Titik reject Gate D/B (Fase 1) dan Gate A/critic_veto (Fase 2) — sebelumnya kandidat yang ditahan cuma nambah counter `auto_guard_stats:*` lalu levelnya dibuang total. Sekarang direkam sebagai `status:'canceled'` + `canceled_reason:'gate_<gateKey>'` + `canceled_t`, memakai `buildNewSetupEntry()` yang sama (jadi otomatis dapat `macro_snapshot` juga) — status asli TIDAK pernah jadi `pending`/`open`, jadi tidak ikut win-rate/exposure manapun, prinsip sama U-5a.
- `_aggGateRejectGhostStats()` — agregat ghost dipecah PER GATE (`gate_correlation_cap`/`gate_drawdown_circuit_breaker`/`gate_critic_veto` masing-masing `{total, saved, cost, ambiguous, expired_no_fill, pending}`), beda dari `_aggCancelFlipGhostStats` yang tetap khusus `bias_flip`. `saved` = gate benar menahan (ghost_status sl), `cost` = gate salah menahan (ghost_status tp — kandidat sebenarnya menang). Di-wire ke `_aggSetupStats` sebagai `gate_reject_ghost`, dan ditambahkan ke daftar strip `_omitManagement` (developer-only, scope=auto — tidak pernah bocor ke payload publik, sama seperti `management`/`cancel_flip_ghost`).

**Test:** 2 test lama di `test/admin/gate_a_race.test.js` diupdate — asumsi lama "critic_veto -> log.length 0" sekarang jadi "critic_veto -> tersimpan sebagai ghost `canceled`, tapi tidak pernah live pending/open" (perilaku yang sebenarnya ingin dijaga test itu). Test baru ditambahkan di `test/admin/ta_struct.test.js` untuk `_buildMacroSnapshot`, `_aggGateRejectGhostStats`, dan `_evaluateCanceledGhost` versi generalisasi. Full suite: **885/885 hijau**.

**Belum ada threshold/aturan baru yang berubah** — sesi ini murni infrastruktur pencatatan. Kalibrasi ambang skew (dibahas di rapat CME) dan keputusan reprioritas COT vs CME menunggu data ini terkumpul dulu, tidak dieksekusi sesi ini.

## Changelog Session 290 (2026-08-06) — Transparansi Tampilan Loss Label di Dev Console Auto-Entry

**Konteks:** user minta agar `loss_label` ditampilkan secara eksplisit di antarmuka HTML (`dev-auto-entry.html`) agar jenis loss (misal `fundamental_shock`, `fakeout_sl`, atau murni teknikal) langsung terlihat jelas tanpa kebingungan.

**Perubahan di `dev-auto-entry.html`:**
1. **Badges di Kolom Status Tabel Utama**: Khusus baris berstatus `sl`, ditambahkan chip badge sekunder di sebelah badge `sl`:
   - Jika `loss_label` terisi (mis. `fundamental_shock` / `fakeout_sl`): tampil badge kuning dengan nama label tersebut.
   - Jika `loss_label` null: tampil badge abu-abu `teknikal`.
2. **Aksi Disarankan (`buildExecutiveAction`)**: Mengganti teks instruksi generik lama ("Lakukan post-mortem singkat: cek apakah...") dengan **kesimpulan hasil post-mortem otomatis yang kontekstual** (`Hasil post-mortem otomatis: Loss murni teknikal / dipicu berita / intervensi`).
3. **Field Detail Expand (`buildSetupDetail`)**: Field `Loss Label` dan `Alasan Loss Label` kini tidak lagi disembunyikan saat `null` untuk status SL. Menampilkan eksplisit `teknikal (default: murni teknikal, tidak ada berita ±2j)` dan alasannya.
4. **Narasi "Kenapa Bisa SL"**: Diperjelas menyebut `murni teknikal: tidak ada rilis berita high-impact ±2 jam` jika SL terjadi tanpa pemicu berita.

**Verifikasi:** `npm test` 878/878 hijau.

**File diubah:** `dev-auto-entry.html`, `Dokumentasi/daun_merah.md`.

## Changelog Session 289 (2026-08-06) — Hapus Penyebutan "CEO" dari UI Ringkasan

**Konteks:** user meminta agar penyebutan "CEO" di detail setup dihapus.

**Perubahan:** di `dev-auto-entry.html`, label dan nama helper dirapikan:
1. `Ringkasan Eksekutif (CEO)` → `Ringkasan Eksekutif`
2. `Aksi Disarankan (CEO)` → `Aksi Disarankan`
3. Helper internal `buildCeoSummary`/`buildCeoAction` diganti ke `buildExecutiveSummary`/`buildExecutiveAction` agar konsisten.

**Catatan perilaku:** isi ringkasan/aksi tidak berubah (tetap hasil olahan logic frontend dari data setup), hanya penyebutan "CEO" yang dihapus.

**Verifikasi:** `npm test` 878/878 hijau.

**File diubah:** `dev-auto-entry.html`, `Dokumentasi/daun_merah.md`.

## Changelog Session 288 (2026-08-06) — Upgrade Detail Setup ke Ringkasan Eksekutif (CEO View)

**Konteks:** user meminta agar tampilan tidak berhenti di log sistem mentah, tetapi menampilkan seluruh informasi penting dalam format yang langsung bisa dipakai pengambilan keputusan level eksekutif.

**Perubahan di `dev-auto-entry.html` (detail expand Riwayat Setup):**
1. Tambah **Ringkasan Eksekutif (CEO)**: satu paragraf kompak yang menggabungkan identitas setup, level entry/SL/TP, RR, horizon, confidence, konteks makro, conflict, dan outcome saat ini.
2. Tambah **Aksi Disarankan (CEO)**: rekomendasi tindakan ringkas berbasis status setup (pending/open/tp/sl/ambiguous/dll).
3. Tambah **Kenapa Status Ini Terjadi**: narasi status-aware untuk semua status (bukan hanya SL), termasuk TP/open/pending/ambiguous dan status non-trading.
4. Tetap pertahankan **Kenapa Bisa SL** khusus status SL sebagai breakdown loss paling detail.

**Verifikasi:** `npm test` 878/878 hijau.

**File diubah:** `dev-auto-entry.html`, `Dokumentasi/daun_merah.md`.

## Changelog Session 287 (2026-08-06) — Tambah Ringkasan "Kenapa Bisa SL" di Dev Auto-Entry

**Konteks:** user meminta alasan kenapa sebuah setup bisa berakhir SL ditampilkan lebih jelas. Detail existing sudah menyimpan banyak field (alignment, conflict, loss label, intervensi), tapi belum ada satu ringkasan singkat yang langsung menjawab pertanyaan "kenapa kena SL".

**Perubahan:** `dev-auto-entry.html` menambahkan field detail baru **Kenapa Bisa SL** pada baris expand tabel Riwayat Setup.

**Logika ringkasan (prioritas):**
1. Jika ada `loss_label` + `label_reason`, ringkasan memakai label tersebut (paling spesifik).
2. Jika SL terjadi setelah intervensi `tighten_sl`, ringkasan menyebut SL hasil intervensi + alasan intervensi.
3. Jika belum ada label/intervensi spesifik, ringkasan fallback: harga bergerak berlawanan dengan skenario, lalu menyertakan konteks setup (makro alignment, conflict, RR, horizon) bila tersedia.

**Verifikasi:** `npm test` 878/878 hijau.

**File diubah:** `dev-auto-entry.html`, `Dokumentasi/daun_merah.md`.

## Changelog Session 286 (2026-08-06) — Implement Retry Persisten untuk Auto-Entry yang Di-Skip Karena News

**Konteks:** user menanyakan apakah auto-entry yang di-skip karena hard/breaking/surprise news seharusnya dicoba ulang setelah masa berisiko selesai, bukan menunggu slot cron berikutnya. Karena mekanisme saat ini hanya `continue` ke pair berikutnya, kesempatan entry bisa hilang sampai jam berikutnya meskipun berita sudah lewat.

**Perubahan:** `vps/daemon.js` sekarang menambahkan mekanisme retry persisten satu kali untuk pair yang di-skip karena news. Saat skip terjadi, sistem menghitung waktu aman (`event time + 1 jam`) dan menjadwalkan retry pada waktu itu. Scheduler retry disimpan di Redis (ZSET + payload per-pair) supaya tidak hilang saat daemon restart. Saat waktu retry tiba, daemon menjalankan ulang siklus auto-entry untuk pair yang bersangkutan, lalu menghapus pending retry setelah dieksekusi.

**Detail implementasi:**
1. Tambah pending-retry infra di `vps/daemon.js` dengan key Redis `auto_pending_retries_z` dan `auto_pending_retry_data:{pair}`.
2. `checkHardNewsSkip` sekarang menyimpan `event_ms` sehingga retry dapat menghitung safe time dari event berita kalender yang sebenarnya.
3. `runAutoEntryCycle` saat skip hard/breaking/surprise news memanggil `scheduleAutoPendingRetry` jika safe time masih di masa depan, bukan cuma membiarkan pair menunggu slot berikutnya.
4. `startScheduler` menambahkan ticker pemrosesan pending-retry tiap menit, sehingga retry jatuh tempo dieksekusi tanpa menunggu jam cron rutin.

**Verifikasi:** `node --check vps/daemon.js` berhasil; `npm test` berhasil 100% hijau.

**File diubah:** `vps/daemon.js`, `Dokumentasi/daun_merah.md`.

## Changelog Session 284 (2026-08-05) — Fix Bug Korroborasi Palsu: Snapshot "Interest Rate Probabilities" Salah Skip 4 Pair Auto-Entry Sekaligus

**Konteks:** user tanya apakah auto-entry sempat trigger call hari ini. Cek `auto_skip_log` produksi: slot 08:15 UTC (15:15 WIB) memang jalan, tapi ke-4 pair (XAU/USD, EUR/USD, AUD/NZD, EUR/GBP) SEMUA di-skip `breaking_news` gara-gara headline "Fed/ECB/RBA & RBNZ Interest Rate Probabilities". User curiga (screenshot kalender ekonomi Dashboard hari itu memang tidak ada rilis suku bunga apa pun di jam segitu) dan minta dicek ulang.

**Root cause:** headline itu BUKAN kalender rilis (makanya tidak ada di Dashboard) — itu wire boilerplate FinancialJuice (snapshot probabilitas gaya CME FedWatch, sudah diakui di komentar `api/market-digest.js` sebagai "carries zero directional signal on its own"). Bug sungguhannya ada di `isCorroborated` (`vps/daemon.js` + duplikatnya `api/_position_review.js`, dipakai `checkBreakingNewsSkip` DAN `handlePosReviewCandidate`): token signifikan (>3 huruf) headline "Fed/ECB/RBA & RBNZ Interest Rate Probabilities" SAMA PERSIS lintas bank ("interest","rate","probabilities") karena boilerplate template — nama bank sendiri (fed/ecb/rba, semua <=3 huruf) kebuang filter panjang token. Akibatnya overlap>=2 token lolos sebagai "korroborasi 2 sumber independen" walau ke-4 headline itu soal 4 bank sentral yang beda total, bukan konfirmasi silang atas 1 peristiwa nyata — memicu skip serentak semua pair, tanpa ada rilis/kejutan apa pun.

**Perbaikan:** tambah `WIRE_SNAPSHOT_RE` (regex `/interest rate probabilit(y|ies)/i`) di `isCorroborated` — headline yang match TIDAK PERNAH dianggap terkorroborasi (baik sebagai subjek yang mau di-skip, maupun sebagai "bukti" korroborasi headline lain). Diterapkan di KEDUA salinan (`vps/daemon.js` & `api/_position_review.js`, dijaga sinkron test drift-guard existing) — sama-sama relevan karena bug yang sama juga berisiko memicu review posisi terbuka yang tidak perlu (`handlePosReviewCandidate`), bukan cuma skip entry baru.

**Verifikasi:** `npm test` 875/875 hijau (7 test baru: 5 di `test/vps/position_review.test.js` — 2 kasus `isCorroborated`, 1 kasus `findBreakingNewsMatch` reproduksi persis skenario produksi 2026-08-05 07:30-08:15 UTC, 2 kasus baru ditambah ke drift-guard existing; 2 di `test/admin/position_review.test.js` sisi `api/_position_review.js`).

**File diubah:** `vps/daemon.js`, `api/_position_review.js`, `test/vps/position_review.test.js`, `test/admin/position_review.test.js`.

## Changelog Session 283 lanjutan (2026-08-05) — Audit Reasoning Bebas-Teks Lintas-Pair + Fix Root Cause `risk_regime` Null + Backfill Manual

**Konteks:** lanjutan sesi yang sama dengan entri di bawah (Sistem Hakim koreksi arah). User tanya lebih lanjut soal trade AUDNZD `1785849311337` — dari situ dikonfirmasi bug `makro_alignment_reason` bukan cuma salah tulis, tapi bug penalaran arah base/quote sungguhan (dibuktikan lewat perbandingan ke trade AUDNZD lain dengan fundamental serupa yang penalarannya BENAR). Audit lanjutan (agent, hasil sempat tercatat di `daun_merah_riset.md`, sekarang dihapus dari sana krn sudah dieksekusi — riwayat cukup di sini) menyapu semua 23 setup `setup_log_auto:v1`: EUR/GBP (cross pair lain, risiko sama) bersih, GC=F/EUR/USD/GBP/USD bersih, tapi bug yang sama ternyata bocor ke field kedua di trade AUDNZD yang sama — `intervention.reason` (alasan tighten_sl ghost/counterfactual pasca-entry) juga menyebut data NZD kuat sebagai "mengancam" bias bearish, padahal seharusnya "mendukung" (NZD menguat = searah dengan bearish AUD/NZD, bukan melawannya).

**Perbaikan #1 — instruksi prompt (cegah bug arah berulang):** tambah aturan eksplisit base/quote di 2 titik: instruksi field `makro_alignment` blok Analisa (`api/admin.js` ~L4722) dan system prompt `position_review` (~L3851). Intinya: sebelum menilai searah/konflik atau mendukung/mengancam, model WAJIB tentukan dulu mata uang mana (base/quote) yang diuntungkan oleh bias, dengan contoh eksplisit AUD/NZD & EUR/GBP — supaya tidak lagi membalik logika di pair silang non-USD.

**Perbaikan #2 — root cause `risk_regime` null:** cache `risk_regime` (`api/risk-regime.js`, TTL 5 menit) ternyata HANYA dipanaskan lewat kunjungan browser (`index.html`), tidak ada pemanasan server-side. `runAutoEntryCycle` jam `:15` membaca cache itu secara PASIF (`redisCmd GET` biasa, `api/admin.js:4537`, bukan lewat handler yang punya fallback fetch-on-miss) — kalau tidak ada user browsing dalam 5 menit terakhir, `regime` tercatat null diam-diam (persis kasus AUDNZD di atas: 0/1 sejak Track 1b live 2026-08-04). Fix: `vps/daemon.js` — cron baru menit `:10` (5 menit sebelum tiap slot auto-entry `:15`) memanggil `/api/risk-regime` server-side, di union jam `AUTO_ENTRY_HOURS_UTC` + `AUTO_ENTRY_HOURS_UTC_AUDNZD`.

**Backfill data historis (manual, atas instruksi eksplisit user):** 22 setup lama (sebelum Track 1b live) diisi field `regime` retrospektif dari ingatan user (21 `neutral`, 1 `risk_off` untuk GC=F terakhir sebelum Track 1b) + tag `regime_source:'manual_backfill'` supaya bisa dibedakan dari nilai hasil hitungan otomatis sistem saat analisis nanti (dibahas eksplisit dengan user: backfill manual TIDAK setara secara metodologis dengan nilai terhitung kode — ditandai, bukan disamarkan). 1 setup yang sudah live (`regime:null`) sengaja TIDAK disentuh, akan terisi otomatis begitu fix #2 berjalan.

**Insiden kecil saat backfill (terdeteksi & dipulihkan sesi yang sama):** percobaan tulis pertama ke Redis salah format (double-JSON-encode manual, tidak match pola `redisCmd` yang dipakai kode aplikasi) sempat merusak struktur tersimpan `setup_log_auto:v1`. Terdeteksi langsung lewat verifikasi baca-ulang, dipulihkan dari backup lokal yang diambil sebelum tulis-ulang kedua, diverifikasi byte-identik pasca-perbaikan. Tidak ada data hilang, tapi jadi pengingat: perubahan tulis-langsung ke Redis produksi wajib backup lokal dulu + verifikasi format persis sama dengan `redisCmd` aplikasi (command-array via POST ke base URL), bukan REST path style (`/set/key`).

**Verifikasi:** `node --test` 871/871 hijau (tidak ada test baru — perubahan ini murni teks prompt + jadwal cron, tidak mengubah logika yang sudah dites). Data Redis diverifikasi ulang pasca-tulis (distribusi `regime` & kecocokan tiap field per-setup dicek manual, match backup).

**File diubah:** `api/admin.js` (2 instruksi prompt), `vps/daemon.js` (cron pemanasan `risk_regime`), `Dokumentasi/daun_merah_riset.md` (entri audit dihapus, sudah dieksekusi), data `setup_log_auto:v1` di Redis produksi (bukan file kode, tidak ter-commit).

## Changelog Session 283 (2026-08-05) — Sistem Hakim: Koreksi Arah Sebaliknya (AI Salah Klaim Konflik Padahal cbDir Searah)

**Konteks:** user tanya penjelasan end-to-end setup AUDNZD `1785849311337` (kena SL 2026-08-05) — dari situ ketahuan kalimat `makro_alignment_reason` yang ditulis AI sendiri kontradiktif secara logika: "Fundamental NZD Hawkish ... mendukung NZD, berlawanan dengan bias bearish AUD/NZD yang berarti NZD menguat". NZD menguat justru SEARAH dengan bearish AUD/NZD (bearish AUD/NZD = AUD melemah **terhadap** NZD = NZD menguat), bukan berlawanan — AI menandai `makro_alignment:'konflik'` & `conflict:'arah'` sendiri padahal argumennya sendiri menunjukkan searah. Dicek ke `conflict_source` setup itu: `'ai'`, bukan `'sistem_hakim'` — artinya pengecekan objektif kode (`cbDir` dari `_computeCbDirServerSide`, dibandingkan ke `structured.bias`) TIDAK mendeteksi konflik nyata di sini; yang keliru murni klaim teks bebas model.

**Celah yang ditemukan:** veto "[SISTEM HAKIM]" (`ohlcvAnalyzeHandler`, `api/admin.js`, dibuat Session ~sekitar 2026-07-29) selama ini SEARAH SATU JALAN — hanya menangkap kasus AI **gagal melihat** konflik nyata (`cbDir` melawan bias teknikal → dipaksa `konflik`/`arah`). Tidak ada rem untuk kebalikannya: AI **salah mengklaim** konflik padahal `cbDir` (sudah lolos syarat confidence High kedua leg + tanpa `divergence_warning`) justru SEARAH. Klaim salah begini menyeret setup ke jalur "hati-hati" (Gate A/AI Kritikus, riwayat tighten-SL reaktif) tanpa dasar nyata.

**Perbaikan:** tambah cabang `else if` di blok veto — kalau `cbDir` SEARAH dengan bias teknikal (`long`+bullish atau `short`+bearish) tapi `structured.makro_alignment==='konflik'`/`conflict==='arah'`, dikoreksi balik ke `'searah'`/`'none'`. Ditandai field baru `sistem_hakim:'corrected'` (state ketiga selain `'fired'`/`'clear'`) — dipisah dari `'clear'` supaya `_sistemHakimCalibration` (dan `setup_stats?scope=auto`) bisa mengukur terpisah apakah koreksi ini menyelamatkan setup yang sebenarnya valid. Telemetri baru `sistem_hakim_stats:corrected` (pola sama `:considered`/`:fired`, didaftarkan ke `KEY_REGISTRY`).

**Catatan pembahasan lanjutan (tidak mengubah kode):** user juga menanyakan kenapa harga tetap bergerak melawan (AUD menguat jangka pendek, hit SL) walau NZD dilaporkan hawkish — dijelaskan itu bukan bukti klaim konflik AI benar; arah yang terjadi (AUD/NZD naik) sebenarnya berlawanan dengan KEDUA argumen (bearish teknikal maupun narasi NZD-kuat AI), dan pergerakannya sendiri kecil (~18 pip ke SL yang sudah diperketat) — sejalan dengan noise jangka pendek, bukan pembenaran retroaktif atas alasan yang secara logika tetap salah tulis.

**Verifikasi:** `npm test` 871/871 hijau (2 test baru + 1 test existing direvisi di `test/admin/sistem_hakim.test.js`: kalibrasi 3-bucket, skenario integrasi cbDir-searah-tapi-AI-klaim-konflik → `conflict:'none'`, `makro_alignment:'searah'`, `sistem_hakim:'corrected'`, counter `sistem_hakim_stats:corrected` naik, `sistem_hakim_stats:fired` TIDAK naik).

**File diubah:** `api/admin.js` (blok veto `[SISTEM HAKIM]`, `_sistemHakimCalibration`, `KEY_REGISTRY`), `test/admin/sistem_hakim.test.js`.

## Changelog Session 282 lanjutan 2 (2026-08-04) — Track 1b: Rekam `risk_regime` Per-Setup (Cegah Kebocoran Data untuk Plan U Item #10)

**Konteks:** temuan dari audit lintas-sesi (chatroom lain, dikonfirmasi user) — `buildNewSetupEntry()` (`api/admin.js`) merekam banyak field per setup, tapi TIDAK ADA `risk_regime` (risk_on/neutral/elevated/risk_off) yang berlaku SAAT setup itu dibuat. Cache `risk_regime` (`api/risk-regime.js`) TTL cuma 5 menit dan SELALU ditimpa nilai terbaru — tidak ada arsip historis. Kalau tidak direkam sekarang, rezim yang berlaku di tiap tanggal historis makin sulit direkonstruksi begitu Plan U item #10 ("gating berbasis rezim" — `daun_merah_progress.md` §S209, KONDISIONAL pada bukti confluence zone regime-dependent) atau audit "apakah bias AI konsisten dengan rezim" mulai dikerjakan nanti (n≥100 gate, ~3 bulan lagi). Beda kelas dari Track 3 (trailing/breakeven) — bukan kalibrasi yang perlu ditunda, murni mencegah kebocoran data historis; biayanya nol (`autoGuardRegime` sudah dihitung untuk Gate B, tidak ada fetch/heuristik baru).

**Diskusi tambahan sebelum eksekusi:** user tanya apakah rezim berarti sistem harus "tutup pair" tertentu — dikonfirmasi TIDAK: definisi asli item #10 (`daun_merah_progress.md`) adalah aturan GLOBAL (skip semua entry baru ATAU kecilkan size, bukan pair-specific), dan itu beda layer dari kemampuan AI memilih arah/pair sendiri berdasar rezim (`RISK REGIME:` sudah disuntik ke prompt sejak awal, `api/admin.js` ~4171) — sudah ada, bukan hal baru. Data awal (S209) belum menunjukkan bukti regime-dependency yang jelas, jadi item #10 sendiri masih murni kondisional/belum tentu dieksekusi.

**Perubahan:** `regime: autoGuardRegime` ditambahkan ke `buildNewSetupEntry()` dan diperbarui ke generasi terbaru di blok refine-in-place (pola sama field lain di blok itu) — berlaku untuk setup manual maupun auto (nilai `autoGuardRegime` sudah dihitung untuk semua panggilan `ohlcv_analyze`, tidak dibatasi `isAutoCall`). Null kalau cache `risk_regime` kosong/gagal parse — fail-open, tidak menggagalkan penyimpanan setup.

**Verifikasi:** `npm test` 870/870 hijau (2 test baru di `test/admin/gate_a_race.test.js`: field terisi dari cache `risk_regime`, dan fail-open ke null kalau cache kosong).

**File diubah:** `api/admin.js`, `test/admin/gate_a_race.test.js`.

## Changelog Session 282 lanjutan (2026-08-04) — Fix: Invalidasi Teknikal Sempat Menghalangi AI Position Review

**Konteks:** langsung setelah Track 1 di bawah di-push, user tanya "gimana kalau dia ngasal aja batalkan trade? ada ga kemungkinan gitu?" — pertanyaan itu membongkar celah desain nyata (bukan cuma teoretis) di implementasi pertama.

**Celah yang ditemukan:** `_evaluateTechInvalidation` (kode murni, deteksi invalidasi teknikal deterministik) menulis hasilnya ke field `intervention`/`managed_status` — field yang SAMA dipakai guard "1 intervensi per posisi" di `positionReviewHandler` (~baris 3746, `if (st.intervention) skip 'already_managed'`) dan `runFridayTightenCycle` (~baris 3969, `candidates = ...filter(!s.intervention)`). Akibatnya: kalau AI menulis `invalidation_trigger` yang levelnya asal/gampang kesenggol noise candle biasa (validasi yang ada cuma cek "ini angka", TIDAK cek "ini masuk akal secara struktur" — celah kedua yang SENGAJA belum diperbaiki, lihat bawah), dan kode ini "menyala" duluan, posisi itu jadi **tidak pernah kebagian giliran direview AI position-review yang MERESPONS BERITA ASLI** — mekanisme kode-murni yang belum terverifikasi kualitasnya jadi menghalangi mekanisme AI yang jauh lebih penting.

**Perbaikan:** field dipisah total — hasil deteksi sekarang ditulis ke `tech_invalidated: {at, level, type, direction}` (field BARU, independen), bukan lagi `intervention`/`managed_status`. Konsekuensinya: `tech_invalidated` bisa hidup berdampingan dengan `intervention` AI di posisi yang sama (dua catatan independen, bukan satu slot rebutan) — AI position review dan tighten preventif Jumat sekarang TIDAK PERNAH terhalang oleh mekanisme kode murni ini.

**File diubah:** `api/admin.js` (`_evaluateTechInvalidation`, `buildNewSetupEntry`, blok refine-in-place), `api/_position_review.js` (`_aggManagementStats` baca dari `tech_invalidated`), `dev-auto-entry.html` (render field terpisah), `test/admin/tech_invalidation.test.js` (test baru: intervention AI existing tidak menghalangi/tidak ditimpa), `test/admin/position_review.test.js` (test baru level-handler: `tech_invalidated` terisi TIDAK men-skip review AI, dibuktikan `review_count` tetap naik).

**Celah kedua (SENGAJA belum diperbaiki, keputusan user):** validasi `invalidation_trigger` cuma memastikan levelnya angka valid, tidak mengecek kewajaran (level terlalu dekat entry, dsb). Ditunda sampai ada data nyata (n cukup di `tech_invalidation` bucket `_aggManagementStats`) untuk kalibrasi ambang — pola sama alasan Track 3 ditunda (`daun_merah.md` Session 277→281, Gate E).

**Verifikasi:** `npm test` 868/868 hijau (2 test baru + 8 test existing direvisi mengikuti field baru).

## Changelog Session 282 (2026-08-04) — Plan "Road to Professional LLM Trader": Track 1 (Invalidasi Teknikal) + Track 2a (Jam Khusus AUD/NZD)

**Konteks:** eksekusi `daun_merah_plan.md` §"PLAN — Road to Professional LLM Trader" (dibuat sesi sebelumnya dari audit total auto-entry vs Plan U, 2026-08-04). Plan itu punya 3 track kesiapan beda: Track 1 siap eksekusi langsung, Track 2 butuh keputusan user per sub-item (2a/2b), Track 3 (trailing stop/breakeven/partial TP) DITUNDA sampai n≥100 tercapai — TIDAK disentuh sesi ini. User memilih Track 2a **Opsi B** (tambah jam khusus AUD/NZD) dan Track 2b **Opsi A** (terima risiko, tidak tambah fallback GH Actions) — 2b karena itu murni keputusan "tidak melakukan apa-apa", tidak ada kerja kode.

**Track 1 — Tegakkan Invalidasi Teknikal (exit dini deterministik, NOL biaya AI tambahan):**

Sebelumnya `invalidation_condition` (field `structured` dari AI) cuma teks bebas untuk jurnal — tidak pernah ditegakkan otomatis, beda dari SL/TP yang memang dicek tiap tick. Sekarang AI juga mengisi `invalidation_trigger` terstruktur paralel (`{type, level, timeframe, direction}`, nullable — fail-open kalau AI tidak bisa mengekspresikan sebagai satu level angka, TIDAK dipaksa mengarang).

1. **`api/admin.js`** — prompt `ohlcvAnalyzeHandler` (~baris 4674) minta AI isi `invalidation_trigger` di samping `invalidation_condition`; hasilnya divalidasi ketat (`type`/`direction` harus dari set yang dikenal, `level` harus angka finite) sebelum disimpan ke `setup_log_auto:v1`/`setup_log:v1` (baru & refine-in-place).
2. **`api/_auto_entry_guard.js`** — fungsi pure baru `isInvalidationTriggered({invalidation_trigger, candles, startMs, boundaryMs})`: cek CLOSE candle H1 (bukan wick, konsisten "Daily close balik di bawah SMA50" — beda dari SL/TP yang memang harus tahan noise intrabar) terhadap level, pakai candle yang SUDAH difetch untuk `_evaluateSetups` (nol fetch tambahan). `startMs` dari `st.ts` (bukan `filled_t`) — thesis bisa batal SEBELUM posisi sempat fill. `boundaryMs` = `closed_t` (kalau status sudah resolve ke tp/sl/ambiguous) — TP/SL asli MENANG kalau tersentuh di candle sama/lebih dulu, invalidasi cuma berlaku SEBELUM itu.
3. **`api/admin.js`** — loop baru `_evaluateTechInvalidation` dipanggil SETELAH `_evaluateSetups` di kedua jalur evaluasi (`_buildAutoScopeStats` scope=auto & `setupStatsHandler` publik/manual). Hasil ditulis ke field `tech_invalidated: {at, level, type, direction}` — **status/tp/sl MENTAH tidak pernah ditimpa** (prinsip U-5a, ghost/counterfactual tetap jalan apa adanya). *(Revisi: versi awal sesi ini reuse field `intervention`/`managed_status` — TERNYATA menghalangi AI position review, diperbaiki sesi lanjutan langsung di bawah, `tech_invalidated` field independen sejak awal disebut di sini.)*
4. **`api/_position_review.js`** — `_aggManagementStats` dapat bucket baru `tech_invalidation: {count, saved, cost, ghost_pending}` (baca dari `tech_invalidated`), TIDAK ikut mengurangi `reviews`/`hold` (bukan hasil review AI, pola sama `tighten_preventive`).
5. **`dev-auto-entry.html`** — jurnal render trigger mentah (`Invalidasi Teknikal (trigger AI)`) + label intervensi/hasil baru di `INTERVENTION_LABEL`/`MANAGED_STATUS_LABEL`.

**Track 2a — Jam Khusus AUD/NZD (sesi Sydney-Tokyo):**

`AUTO_ENTRY_HOURS_UTC` (08:00/13:00 UTC = 15:00/20:00 WIB) pas untuk XAU/EUR/GBP (London/NY) tapi AUD/NZD justru sepi di jam itu — sesi puncaknya Sydney-Tokyo (~22:00-08:00 UTC / 05:00-15:00 WIB). `vps/daemon.js`: `runAutoEntryCycle` sekarang terima parameter `pairs` opsional (default `AUTO_ENTRY_PAIRS`); env var baru `AUTO_ENTRY_HOURS_UTC_AUDNZD` (default `'0'` = 00:00 UTC/07:00 WIB) menjadwalkan cron TERPISAH yang memanggil `runAutoEntryCycle(['frxAUDNZD'])` — **3 pair lain TIDAK bertambah call/hari**. Env var opsional/fail-open, tidak perlu aksi manual di Railway (didokumentasikan di `vps/README-deploy.md` §env var).

**Verifikasi:** `npm test` 866/866 hijau (16 test baru: 8 `isInvalidationTriggered` termasuk kasus prioritas TP/SL-menang, 7 `_evaluateTechInvalidation` termasuk status pending/open/sudah-resolve, 1 update `_aggManagementStats`). Grep manual memastikan nol call SambaNova/DeepSeek baru ditambahkan di jalur Track 1 (sesuai syarat plan). **Verifikasi live BELUM dilakukan** (butuh siklus `runAutoEntryCycle` produksi nyata untuk konfirmasi AI benar-benar bisa mengisi `invalidation_trigger` non-null, dan sinyal AUD/NZD muncul di jam 07:00 WIB) — dicatat sebagai item pending, lihat `daun_merah_progress.md`.

**File diubah:** `api/admin.js`, `api/_auto_entry_guard.js`, `api/_position_review.js`, `vps/daemon.js`, `dev-auto-entry.html`, `vps/README-deploy.md`, `test/api/_auto_entry_guard.test.js`, `test/admin/position_review.test.js`, `test/admin/tech_invalidation.test.js` (baru).

## Changelog Session 281 (2026-08-04) — Gate E Dilonggarkan (Diskusi User Pasca-Audit Nol-Entry)

**Konteks:** user tanya kenapa auto-entry nol entry/pending sepanjang hari (audit live ke Redis produksi via Upstash REST langsung — beberapa key seperti `auto_guard_stats:conflict_waktu` dan `ai_budget:*:{tanggal}` tidak terdaftar di `KEY_REGISTRY` `api/admin.js` redis-keys handler, jadi 404 walau valid). Ketemu: Gate E (`conflict:'waktu'`, dibuat pagi itu juga di Session 277 lanjutan) langsung menahan satu-satunya kandidat yang sampai tahap akhir gate hari itu — hari pertama gate baru ini aktif. Diskusi lanjutan membongkar 2 celah desain: (1) dasar pembuatan Gate E cuma 4-5 sampel SL — bertentangan dengan prinsip evaluasi n>=100 per-batch yang sudah dipegang untuk sistem ini ([[project-auto-entry-trainee-mental-model]]); (2) sudah ada lapis proteksi TERPISAH untuk risiko berita di posisi yang SUDAH open (tighten_sl reaktif berita, `api/_position_review.js`) — hard block pra-entry jadi dobel-guard, bukan satu-satunya pertahanan.

**Perubahan (2 gate, keduanya soal "berita/waktu", dipilih SELEKTIF — gate berbasis data riil/kejadian nyata TIDAK disentuh):**

1. **`api/admin.js` (Gate E, sekitar `ohlcvAnalyzeHandler`):** `conflict:'waktu'` dari self-assessment AI TIDAK lagi auto-reject sebelum Gate A dipanggil. Sekarang cuma jadi counter observasi non-blocking (`auto_guard_stats:conflict_waktu_flagged`, didaftarkan ke `KEY_REGISTRY`) — kandidatnya tetap diteruskan ke Gate A (AI Kritikus, `_runCriticVerdict`) yang independen menilai, dengan tambahan satu baris konteks di `criticSetupBlock` yang secara eksplisit menyebut catatan timing dari analisa awal dan mengingatkan bahwa posisi open tetap dilindungi tighten-SL reaktif berita. Gate A sendiri sudah menerima kalender event high-impact yang sama (`calAnalyzeBlock`) sejak awal, jadi tidak ada informasi baru yang hilang — cuma keputusan akhirnya dipindah dari self-report tunggal ke pengecekan independen kedua.
2. **`vps/daemon.js` (`checkHardNewsSkip`):** cek MAJU (`findHardNewsEvent`, event high-impact yang akan rilis beberapa jam ke depan) dihapus dari kombinasi skip — dianggap REDUNDAN dengan Gate E (AI penganalisa sudah lihat kalender yang sama, dan sekarang hasil penilaiannya lolos ke Gate A, bukan dibuang). Cek MUNDUR (`findRecentHardNewsEvent`, event yang BARU SAJA rilis dalam 1 jam terakhir) TETAP dipertahankan — beda karakter, berbasis kasus SL nyata (AUD/NZD, lihat Session 277/280) dan soal data candle yang mungkin belum settle, bukan tebakan self-report yang bisa diserahkan ke AI. `findHardNewsEvent` sendiri TETAP ada sebagai pure function + unit test (tidak dihapus, cuma tidak lagi dipanggil sebagai gate).

**Yang SENGAJA tidak disentuh** (beda karakter, berbasis data terukur bukan self-report subjektif — melonggarkannya menukar keamanan modal demi frekuensi tanpa dasar kualitas): Gate B (drawdown circuit breaker, ambang adaptif per `risk_regime`), Gate D (correlation cap, XAU/USD-EUR/USD r=0,585 empiris), Gate "kejutan ekonomi" Plan X (`checkSurpriseSkip`, baru dideploy sesi lain — ambangnya sendiri ditandai eksplisit "belum dikalibrasi dari data live", terlalu baru untuk dievaluasi).

**Diskusi tambahan (belum dieksekusi, sengaja didokumentasikan):** user mempertanyakan apakah Gate A (AI Kritikus) sendiri bisa dipercaya untuk benar-benar menolak setup yang memang berisiko (bukan cuma rubber-stamp). Jawaban: tidak ada garansi mutlak, tapi 3 mitigasi struktural sudah ada — (a) AI call independen/terpisah dari yang membuat setup, (b) instruksi eksplisit melarang keberatan generik tanpa angka konkret, (c) 3 tingkat verdict (`lanjut`/`tunda`/`batalkan`) di mana cuma "batalkan" (keberatan fundamental) yang benar-benar menahan — "tunda" tetap tersimpan. Celah yang diakui terbuka: TIDAK ada pelacakan counterfactual/ghost untuk `critic_veto` (beda dari `bias_flip` yang sudah punya `_evaluateCanceledGhost`) — belum diketahui apakah 2 veto historis itu memang tepat atau salah tolak setup bagus. User belum minta ini dibangun — dicatat sebagai potensi kerja lanjutan, bukan item aktif.

**Verifikasi:** `npm test` 850/850 hijau (2 test lama Gate E diganti jadi 2 test baru yang memverifikasi Gate A tetap dipanggil untuk `conflict:'waktu'`, baik verdict "lanjut" maupun "batalkan"). `test/api/_auto_entry_guard.test.js` (unit `isTimingConflictBlocked`) tidak berubah — fungsi predikatnya sendiri tetap sama, cuma tidak lagi dipakai sebagai gate yang menahan penyimpanan.

**File diubah:** `api/_auto_entry_guard.js`, `api/admin.js`, `vps/daemon.js`, `test/admin/gate_a_race.test.js`.

## Changelog Session 280 (2026-08-04) — Plan X: Deteksi Kejutan Ekonomi (Actual vs Forecast) untuk Auto-Entry

**Konteks:** lanjutan langsung audit SL Session 277 lanjutan — investigasi trade AUD/NZD kena SL menemukan rilis "Australia Household Spending" (actual 0,8% vs forecast 0,2%, beat 4x) ikut mendorong pembalikan yang berujung SL, tapi event ini divonis **Low impact** oleh vendor TradingView (`importance:-1`) sehingga tidak pernah masuk `calendar_v1`/`calendar_next_v1` dan tidak pernah dicek gate manapun (`checkHardNewsSkip`/`findRecentHardNewsEvent`, keduanya cuma cek `impact==='High'`). Detail plan lengkap sudah dihapus dari `daun_merah_plan.md` (Plan X selesai).

**Implementasi — Opsi A (rasio sederhana, gate aktif) + fondasi Opsi B (logging, tidak aktif sebagai gate):**

- `api/calendar.js`: cache KEDUA (`calendar_surprise_v1`/`calendar_surprise_next_v1`) dibangun dari `allEvents` yang SAMA dipakai payload `calendar_v1`/`calendar_next_v1` — NOL fetch tambahan ke TradingView. Scope 5 currency (`SURPRISE_CURRENCIES = {USD,EUR,GBP,AUD,NZD}`, union `AUTO_ENTRY_PAIRS` aktif, bukan 8 currency `MAJOR_CURRENCIES`), TANPA filter impact (beda dari payload utama yang cuma High/Medium). Logika filter/dedup/sort payload utama diekstrak jadi `dedupeCalendarEvents()` (perilaku IDENTIK, cuma dipindah supaya testable tanpa mock HTTP/Redis) — dites regresi 7 kasus (`test/api/calendar.test.js`), payload/kontrak UI existing dikonfirmasi tidak berubah.
- `vps/daemon.js`: `computeSurpriseRatio({actualRaw,forecastRaw,previousRaw})` — rasio `|actual-forecast|/|basis|`, basis fallback ke `previousRaw` kalau `forecastRaw` 0 (BUKAN kalau `forecastRaw` null/tidak ada — forecast wajib ada sebagai sinyal "ada ekspektasi utk dibandingkan"), `null` kalau `actualRaw` belum terisi atau basis 0/tidak ada (bukan "surprise=0"). Ambang awal `SURPRISE_RATIO_THRESHOLD = 1.0` — HEURISTIK, belum dikalibrasi dari data live, direvisi setelah cukup sampel `surprise_log:v1`. `findSurpriseEvent` (pola `findRecentHardNewsEvent`, cek ke belakang saja — surprise cuma bisa dihitung setelah actual terisi) dan `checkSurpriseSkip` (Lapis 1c, wired ke `runAutoEntryCycle` sejajar `checkHardNewsSkip`/`checkBreakingNewsSkip`) — independen dari label impact vendor, murni rasio numerik. Setiap event yang actual-nya terisi dalam window 1 jam dicatat ke `surprise_log:v1` (LPUSH+LTRIM cap 300) terlepas lolos ambang atau tidak — fondasi Opsi B (z-score per jenis event begitu sampel >=8-10 terkumpul), TIDAK diimplementasikan sebagai gate di sesi ini.
- `SURPRISE_CURRENCIES` diturunkan otomatis dari `AUTO_ENTRY_PAIRS` AKTIF (bukan seluruh `AUTO_ENTRY_SYMBOL_MAP`, yang masih menyimpan entri lama pra-redesain Golden Trio seperti GBP/USD, USD/JPY, dst) — kalau `AUTO_ENTRY_PAIRS` berubah, currency set ikut menyesuaikan tanpa ubah 2 tempat.

**Verifikasi:** `npm test` 849/849 hijau (naik dari baseline 808 — 41 test baru). Volume live dicek langsung ke TradingView (5 currency, 7 hari ke depan): 114 event total, 107 di antaranya Low/Medium (7 High) — cache kedua ini ringan, tidak membengkak. Replay retroaktif kasus AUD/NZD (actual 0,8% vs forecast 0,2%, `impact:'Low'`) via `findSurpriseEvent` mengonfirmasi mekanisme ini AKAN menangkap kasus yang memicu plan ini (ratio 3,0 >> ambang 1,0), walau label impact vendor Low. Setelah deploy: `calendar_v1` production dikonfirmasi tidak berubah (43 event, shape 14 field identik sebelum/sesudah); `calendar_surprise_v1` baru terbukti terisi (116 event, tepat 5 currency `{AUD,EUR,GBP,NZD,USD}`). `checkSurpriseSkip` dijalankan lokal terhadap Redis produksi untuk 4 pair aktif — tidak crash, tidak ada skip palsu (dicek manual: satu-satunya event dalam window 1 jam saat itu, "USD LMI Logistics Managers Index", punya `forecast_raw:null` sehingga benar secara desain TIDAK bisa dihitung rasionya, bukan bug). Jalur tulis `surprise_log:v1` (LPUSH+LTRIM) diverifikasi terpisah dengan 1 entri terkontrol yang langsung dibersihkan (LPOP) — log produksi kembali ke 0 entri, tidak ada data uji tertinggal. Entri riil pertama akan masuk begitu ada rilis nyata dengan forecast valid dalam window 1 jam saat `runAutoEntryCycle` jalan (2x/hari, jam 8 & 13 UTC).

## Changelog Session 277 lanjutan (2026-08-04) — Audit SL Auto-Entry: Fix Bug Korroborasi Berita + Gate Timing-Risk Baru

**Konteks:** user minta cek kenapa trade AUD/NZD auto-entry kena SL. Audit 5 SL terakhir `setup_log_auto:v1` menemukan pola: 3 dari 4 setup berlabel `conflict:"waktu"` (AI sendiri sudah menandai ada event high-impact dalam horizon trade) berakhir SL, tapi label ini cuma dicatat pasif, tidak pernah menahan entry. Investigasi lanjutan trade AUD/NZD spesifik menemukan: mekanisme in-trade review real-time (`vps/daemon.js` `tryTriggerPosReview`/`handlePosReviewCandidate`) SEHARUSNYA sempat trigger dari 3 headline "Australia household spending" yang saling terkorroborasi, tapi gagal total — root cause: bug prune buffer korroborasi.

### Root cause utama — bug prune buffer korroborasi berbasis `pubDate` bukan waktu proses

`prunePosReviewNewsBuffer`/`processPosReviewRecheckQueue` (`vps/daemon.js`) membuang item dari buffer berdasarkan `nowMs - pubDate` (waktu publikasi asli berita vs jam dinding sekarang) — kalau daemon sempat lag/restart dan berita telat diproses (terbukti live: backlog ~89 menit untuk kasus AUD/NZD), item yang BARU SAJA tiba di sistem langsung dianggap basi dan di-prune SEBELUM sempat dibandingkan dengan sibling-nya yang datang detik kemudian dalam batch backlog yang sama. Audit lintas semua pair (`posreview_skip_log`, 50 entri) menemukan 27 entri (54%) berpola backlog serupa, 18 di antaranya (67%) seharusnya lolos korroborasi kalau bug ini tidak ada — 1 kejadian (AUD/NZD) terbukti berkonsekuensi nyata (status `sl`).

**Fix:** basis retensi buffer/recheck-queue diganti dari `pubDate` ke `_seenAt` (kapan daemon PERTAMA KALI memproses item, di-set sekali saat push, dipersist ke Redis `posreview_news_buffer` supaya survive restart) — fallback ke `pubDate` untuk data lama pra-fix (tidak ada regresi). `isCorroborated` sendiri (pubDate-to-pubDate ±30 menit) TIDAK diubah — itu sudah benar, cuma buffer lifecycle-nya yang salah.

### Temuan sampingan — bug substring matching currency-leg

`detectCurrencyLegs`/`POSREVIEW_CURRENCY_KEYWORDS` (`vps/daemon.js`) dan `_newsMatchesLegs`/`LOSS_LABEL_CURRENCY_KEYWORDS` (`api/admin.js`) dulu pakai `t.includes(kw)` (substring polos) — "Saudi official..." salah match leg AUD gara-gara "Saudi" mengandung substring "aud" (pola sama "shipping→ppi" yang sudah difix di `newscat.js`). Diganti word-boundary regex, precompiled di module scope, di kedua sisi (duplikasi sadar, konsisten pola existing).

### 3 perbaikan disepakati user (AskUserQuestion, semua sekaligus)

1. **Fix bug buffer di atas** — otomatis juga memperbaiki `checkBreakingNewsSkip` (Lapis 1b, filter pre-entry breaking-news yang SUDAH ADA di `runAutoEntryCycle`, sebelumnya diasumsikan tidak ada sama sekali sampai ditemukan saat baca kode — koreksi riset sebelumnya).
2. **Gate E — `conflict:"waktu"`** (`api/_auto_entry_guard.js` `isTimingConflictBlocked`, dipanggil di rantai Gate B/D `api/admin.js`): AI sendiri menandai `conflict:"waktu"` sekarang menahan penyimpanan setup SIKLUS INI (bukan batalkan permanen — auto-entry re-evaluasi tiap jadwal cron berikutnya, jadi "tunda sampai window aman" adalah efek alami arsitektur, sesuai keputusan user).
3. **Perluas window breaking-news-skip & tambah cek kalender ke belakang** (keputusan user: 1 jam): `findBreakingNewsMatch` dapat window recency eksplisit (`BREAKING_NEWS_SKIP_WINDOW_MS = 1 jam`, sebelumnya implisit terikat retensi buffer 35 menit tanpa makna jelas); `findRecentHardNewsEvent` (baru, companion `findHardNewsEvent`) menambah cek ke BELAKANG di `checkHardNewsSkip` — event kalender High-impact yang BARU SAJA rilis (bukan cuma yang akan datang) juga menahan entry baru. `POSREVIEW_NEWS_BUFFER_MS` dilebarkan (35 menit → ~95 menit: window skip 1 jam + margin korroborasi 30 menit) supaya breaking news masih "terlihat" buffer sampai window skip-nya habis.

**Verifikasi:** `npm test` 808/808 hijau. Simulasi replay data produksi real (Redis `news_history`/`posreview_news_buffer`/`setup_log_auto:v1`) mengonfirmasi 18 entri backlog yang gagal korroborasi seharusnya lolos, dan kasus AUD/NZD (satu-satunya dengan konsekuensi `sl` terbukti dalam jendela data 34 jam yang tersisa).

## Changelog Session 274 lanjutan 2 (2026-08-03) — position_review: Call SambaNova Utama Pindah dari Pool Produksi ke Pool Eksperimen

**Konteks:** ditemukan saat user tanya "apakah bug macro tadi menghabiskan AI call auto-entry saya" — jawabannya lebih serius dari sekadar "iya menghabiskan jatah auto-entry": call-nya ternyata memakai pool budget **PRODUKSI/PUBLIK**, bukan pool eksperimen auto-entry sama sekali.

**Root cause:** `positionReviewHandler` (`api/admin.js` ~baris 3660) — call SambaNova UTAMA (dicoba pertama, sebelum fallback DeepSeek) pakai key `'ai:sambanova:main'` (circuit breaker) dan `'sambanova_main'` (budget harian) — **key produksi**, dibagi dengan traffic publik Ringkasan/Analisa manual/Pre-Entry Check. Padahal fitur ini developer-only (HANYA proses id dari `setup_log_auto:v1`, id manual ditolak sebelum sampai ke call AI — lihat langkah 2a/2b di handler yang sama). Fallback DeepSeek 15 baris di bawahnya justru SUDAH BENAR pakai pool eksperimen sejak awal — komentarnya sendiri eksplisit bilang "sama isolasi dengan Gate A Kritikus & ohlcv_analyze auto-entry" — cuma call SambaNova primer yang kelewatan tidak ikut diisolasi sejak fitur ini pertama dibuat (Plan U-5b, bukan disebabkan bug macro sebelumnya; bug macro cuma bikin call ini lebih sering ke-trigger).

**Implementasi:** key diganti `'ai:sambanova:main'` → `'ai:sambanova:main:experimental'` (circuit breaker) dan `'sambanova_main'` → `'sambanova_main_experimental'` (budget harian, limit 30/hari — pool yang sama dipakai call generate sinyal auto-entry utama), konsisten dengan Plan V-3 (isolasi call developer-only dari traffic publik).

**Verifikasi:** 1 test baru di `test/admin/isolation_auto.test.js` (pola sama test PLAN V-3 lain di file yang sama) — konfirmasi counter `ai_budget:sambanova_main_experimental:<hari>` naik, counter `ai_budget:sambanova_main:<hari>` (produksi) TIDAK tersentuh. `npm test` 759/759 hijau.

---

## Changelog Session 267 (2026-07-30) — Fix Label "n" Gate Plan U: Total → TP+SL

**Konteks:** User tanya apakah status `canceled` di auto-entry trade log (`setup_log_auto:v1`) jadi noise statistik — n total 19 sementara 7 di antaranya `canceled`. Audit kode `_aggSetupStats` (api/admin.js) konfirmasi `canceled` sudah dikecualikan dari kalkulasi win-rate/expectancy sejak Plan U-1/U-3 (bukan bug perhitungan). Tapi ditemukan bug tampilan nyata: dashboard internal `dev-auto-entry.html` (Gate Plan U — Cukup Data?) memberi label "n" pada field `total` (termasuk pending/canceled/ambiguous), bukan `tp+sl` (setup yang benar-benar closed dan bisa dipelajari) — beresiko menyesatkan (n terlihat lebih besar dari sample yang sesungguhnya dipakai untuk win-rate). Halaman publik `index.html` (Track Record) sudah benar sejak awal (pakai `decided = tp+sl`).

**Root cause:** `renderGate()` di `dev-auto-entry.html` memakai `symbols[k].total`/`global.total` sebagai basis gate n≥100/n≥30, padahal field yang selaras dengan makna "sample yang bisa dijadikan pelajaran" adalah `tp+sl`. `renderGlobal()`/`renderSymbols()` juga tidak memberi anotasi n eksplisit di samping Win Rate Raw/Adj. (berbeda dari `renderCalibration()` yang sudah benar pakai `(n=X)`).

**Fix (`dev-auto-entry.html`):**
- `renderGate()`: gate global & per-pair sekarang dihitung dari `tp+sl`, bukan `total`; hint teks diperjelas ("n = closed TP+SL, bukan total baris log").
- `renderGlobal()`: label `Total` → `Total (semua status)`, `Canceled` → `Canceled (bukan n, tak dipelajari)`, `Win Rate Raw/Adj.` diberi anotasi `(n=tp+sl)`.
- `renderSymbols()` (kartu per pair): tambah `Canceled` ke baris status, `Win Rate Raw/Adj.` diberi anotasi `(n=tp+sl)`.

**Data aktual saat audit (Redis `setup_log_auto:v1`, 2026-07-30):** total 19 (pending 3, sl 4, tp 5, canceled 7). n win-rate yang benar = 9 (tp+sl), bukan 19. 4/7 canceled berasal dari bug lama sebelum fix Session 216; 2/7 dari Flip Guard `bias_flip` normal (27 Juli); 1/7 koreksi manual retroaktif bug race condition Session 242. Baris `canceled` sengaja TIDAK dihapus dari log (nilai audit trail via `_evaluateCanceledGhost`), hanya perlu jelas tidak dihitung sebagai n.

**Verifikasi:** cek sintaks JS (`new Function()` pada blok `<script>`) lolos tanpa error; visual diverifikasi via script Playwright ad-hoc (mock endpoint `setup_stats`, server statis lokal, screenshot) — Gate/Ringkasan Global/Per Pair/filter+pager semua benar (lihat lanjutan di bawah).

**Lanjutan sesi sama — Filter & Paginasi "Riwayat Setup" (`dev-auto-entry.html`):** tabel "10 Setup Terbaru" diganti "Riwayat Setup" dengan filter status + pair dan paginasi 10/halaman (tombol nomor halaman), karena backend sebelumnya hard-cap `recent: log.slice(0, 10)` di `_statsPayloadFromLog` (`api/admin.js`) — sekarang kirim `log` penuh (sudah newest-first via `unshift`), paginasi/filter dikerjakan client-side. Diverifikasi via script Playwright ad-hoc (server statis lokal + mock `setup_stats`, 25 entri dummy): halaman 1 = 10 baris, halaman 3 = 5 baris sisa, filter status+pair kombinasi menghasilkan subset benar, tanpa JS error (screenshot tersimpan sesi, tidak di-commit).

**Playwright MCP ditambahkan (scope user, butuh restart sesi untuk aktif sebagai tool):** `claude mcp add playwright -s user -- npx -y @playwright/mcp@latest` — sebelumnya verifikasi visual Playwright harus ditulis manual sebagai script Node lewat package `playwright` yang sudah ada di `node_modules` (tidak ideal, banyak boilerplate server statis + mock fetch). Server terkoneksi (`claude mcp list` konfirmasi), tapi tool listing terkunci di awal sesi — baru bisa dipakai native mulai sesi berikutnya.

**Lanjutan sesi sama — DeepSeek v4-flash jadi fallback untuk 2 call yang murni SambaNova (diskusi user soal model AI):** audit `Dokumentasi/daun_merah_ai.md` mengonfirmasi DeepSeek v4-flash (API resmi, berbayar dari saldo top-up, `DEEPSEEK_API_KEY`) **sudah** jadi PRIMARY di hampir semua fitur AI (Ringkasan Berita, Analisa AI per Pair, Pre-Entry Check, termasuk generate setup auto-entry `ohlcv_analyze&auto=1`) sejak Plan O-3/O-6. Yang masih murni SambaNova `DeepSeek-V3.2` TANPA fallback sama sekali: **AI Kritikus / Gate A** (`_runCriticVerdict`, dipakai auto-entry Gate A + tombol manual "UJI KELEMAHAN") dan **Review Posisi Virtual** (`positionReviewHandler`, §3.7). User minta v4-flash jadi FALLBACK (bukan primary — SambaNova tetap primary karena gratis), supaya kalau SambaNova gagal/limit habis, Kritikus (satu-satunya gerbang anti-confirmation-bias auto-entry, Session 250) tidak diam-diam fail-open ke verdict "lanjut" cuma karena provider gratisnya down.

- `_runCriticVerdict`: tambah parameter `deepseekCbKey`/`deepseekBudgetKey` (default `'ai:deepseek'`/`'deepseek'` — pool produksi, dipakai tombol manual publik "UJI KELEMAHAN"); tambah blok fallback DeepSeek v4-flash setelah SambaNova gagal, termasuk deteksi HTTP 402 (saldo habis) konsisten dengan pola `ohlcv_analyze`.
- Pemanggil Gate A auto-entry (`ohlcvAnalyzeHandler`) pass `deepseekCbKey: 'ai:deepseek:experimental', deepseekBudgetKey: 'deepseek_experimental'` — BERBAGI pool eksperimen yang sama dengan DeepSeek primary `ohlcv_analyze` auto-entry (isolasi dari traffic publik tetap terjaga, konsisten pola Plan V-3/audit S218).
- `positionReviewHandler`: tambah blok fallback identik, juga pakai `ai:deepseek:experimental`/`deepseek_experimental` (fitur ini 100% developer-only, hanya melayani id `setup_log_auto:v1` — tidak ada versi publiknya jadi tidak perlu pool terpisah manual/auto).
- **TIDAK disentuh (keputusan sengaja sebelumnya, bukan gap):** Market-Digest Call 4 (cek kontradiksi thesis) — dokumen eksplisit menyebut "SENGAJA TETAP SambaNova, hemat saldo top-up".
- 2 test lama di `test/admin/isolation_auto.test.js` diupdate (bukan bug, ekspektasi lama asumsi Kritikus tidak pernah fallback): jumlah call DeepSeek ter-capture naik dari 1→2, counter `ai_budget:deepseek_experimental` naik dari '1'→'2' (SambaNova di-stub selalu gagal di skenario test itu, jadi Kritikus konsisten jatuh ke fallback). 691/691 test lulus.

**Lanjutan sesi sama — Cek Saldo DeepSeek on-demand (jawab pertanyaan user "kapan tahu batas kredit habis"):** sebelum ini TIDAK ADA cara proaktif tahu saldo DeepSeek mau habis — satu-satunya deteksi murni reaktif (HTTP 402 saat generate call sungguhan, auto-fallback SambaNova, dicatat di log server tapi tidak pernah tampil ke user). DeepSeek API resmi punya endpoint `GET https://api.deepseek.com/user/balance` (dikonfirmasi via dokumentasi resmi) yang belum pernah dipakai di kode ini.

- Endpoint baru `action=deepseek_balance` (`api/admin.js`, `deepseekBalanceHandler`) — CRON_SECRET-gated, query langsung ke DeepSeek, TIDAK lewat `allowAiCall`/circuit breaker (read-only, bukan generate call, tidak masuk pagar biaya 50/hari).
- Kartu baru "Saldo DeepSeek" di atas dashboard `dev-auto-entry.html` — tombol "Cek Saldo" on-demand (bukan auto-refresh), tampilkan `is_available`, `total_balance`/`topped_up_balance`/`granted_balance` per currency, warna merah/kuning/hijau berdasar ambang `total_balance` (<$1 merah, <$5 kuning).
- Diverifikasi via script Playwright ad-hoc (mock response, 5 stat card render benar, tanpa JS error).
- Belum dicek saldo REAL (perlu buka dashboard live dengan CRON_SECRET asli) — terakhir diketahui dari dokumen: top-up $2 pada 2026-07-18, burn rate ±$0.0033/generate (snapshot lama, sebelum fallback Kritikus/Position Review menambah trafik kecil ke pool ini).

**Lanjutan sesi sama (S267 lanjutan, 2026-07-30) — Keputusan FINAL: SambaNova V3.2 TETAP primary di Kritikus/Position Review, TIDAK dipromosikan ke DeepSeek v4-flash:** item tertunda dari sesi ini sendiri (lihat entri di atas — v4-flash baru jadi fallback) dibahas tuntas dan diputuskan, bukan lagi terbuka.

- Riset benchmark publik (Artificial Analysis, docs resmi DeepSeek): V3.2 bukan model lemah (MMLU 88.5, GPQA ~59, setara kelas GPT-4o/Claude 3.5 Sonnet). V4-Flash unggul di atas kertas (Intelligence Index 40 vs 25, MMLU 90.1 vs 87.8) TAPI angka itu untuk mode **reasoning/thinking AKTIF** — sementara panggilan `_runCriticVerdict`/`positionReviewHandler` ke v4-flash eksplisit set `thinking: {type:'disabled'}` (demi latensi, di dalam budget Gate A 25 detik). Tidak ada data publik bersih untuk "v4-flash non-thinking vs V3.2 non-thinking" — jadi gap kualitas riil di konfigurasi produksi kita kemungkinan lebih tipis dari yang benchmark reasoning-mode tunjukkan.
- Opsi shadow-test (jalankan v4-flash paralel logging-only untuk bandingkan verdict vs SambaNova) diusulkan tapi **ditolak user** — dianggap menguras kuota/saldo tanpa manfaat cukup jelas.
- **Keputusan:** biarkan SambaNova V3.2 tetap primary (independensi model thesis-vs-kritikus terjaga, gratis), v4-flash tetap fallback-only seperti yang sudah di-deploy. Tidak perlu dibuka lagi kecuali ada data baru (mis. sampel `auto_guard_stats:critic_veto` cukup besar untuk audit rasio veto, atau benchmark non-thinking v4-flash resmi dirilis).

**Lanjutan sesi sama — Tampilkan dasar keputusan AI per setup di "Riwayat Setup" (`dev-auto-entry.html`):** user tanya apakah ada keterangan alasan AI mengambil entry tertentu (contoh konkret: `EURUSD=X:1785417323600`, bullish, pending) atau murni otomatis tanpa penjelasan. Audit `api/admin.js` (`buildNewSetupEntry`) konfirmasi setiap entri `setup_log_auto:v1` **sudah** menyimpan dasar keputusan sejak Plan U-1/W (`alignment`, `makro_alignment`, `makro_alignment_reason`, `conflict`, `conflict_note`, `conflict_source`, `sistem_hakim`) dan field ini **sudah** ikut dikirim penuh via `setup_stats?scope=auto` (`recent`, lihat `_statsPayloadFromLog`) — gap-nya murni tampilan: tabel "Riwayat Setup" cuma render 11 kolom ringkas (bukan bug baru, cuma belum pernah dibangun).

- Tambah kolom expander (▸/▾) di awal tiap baris — klik baris toggle baris detail di bawahnya (`buildSetupDetail`) menampilkan field alignment/makro_alignment_reason/conflict_note/conflict_source/sistem_hakim/rr/horizon_days/model/loss_label+alasan, field null disembunyikan otomatis.
- Tidak ada perubahan backend/skema data — murni render dari field yang sudah ada di payload.
- Diverifikasi via Playwright MCP (server statis lokal + mock `setup_stats` 2 entri: 1 dengan field konflik penuh mirip contoh user, 1 dengan sebagian besar field null) — expand/collapse independen per baris, field null tersembunyi, tanpa JS error.

## Changelog Session 262 (2026-07-29) — Insiden SL Palsu GC=F: Investigasi Salah Arah, Root Cause Basis Blowout Expiry, Guard Korroborasi Baru

**Konteks:** User curiga saat setup auto-entry GC=F (`GC=F:1785244513683`, bearish, entry 4044,35/SL 4065,00/TP 3968,97) berstatus `sl` padahal menurut chart MT5 live-nya harga belum pernah dekat 4065.

**Investigasi ronde 1 (KELIRU, sempat di-deploy sebagai fix):** Candle `ohlcv:GC=F:1h` jam 2026-07-29T07:00:00Z tercatat H 4106,70 (dicross-check via curl langsung ke Yahoo Finance chart API — angkanya identik, jadi bukan salah cache lokal). 3 sumber independen (Twelve Data XAU/USD spot H 4047,76; chart MT5 XAUUSD live user ~4038-4046; berita pasar gold 4020-4043 hari itu) tampak membantah lonjakan itu — disimpulkan bad print Yahoo GC=F futures, 2 candle dikoreksi jadi angka estimasi & status setup dikembalikan `sl` → `open`.

**Investigasi ronde 2 (ralat, root cause sebenarnya):** ~15 menit kemudian status balik lagi ke `sl` (candle baru H 4098 muncul) — penyelidikan lebih dalam ke candle 1 MENIT Yahoo GC=F menunjukkan **volume riil berkelanjutan** (13-180 kontrak/menit, bukan nol) di kisaran 4096-4106 selama berjam-jam, dan meta Yahoo melaporkan `regularMarketDayHigh: 4106.70` resmi + kontrak aktif `"Gold Aug 26"` (mendekati expiry akhir Juli). Kesimpulan yang benar: GC=F (futures COMEX) **memang benar-benar diperdagangkan** di ~4096-4106 dengan volume nyata — BUKAN bad print, melainkan **basis blowout futures-vs-spot riil** (fenomena dikenal: kontrak mendekati expiry, likuiditas menipis, harga bisa lepas jauh dari spot). SL 4065 memang genuinely tersentuh di sisi GC=F, meski XAU/USD spot yang ditradingkan user via broker tidak pernah dekat level itu. Data dikembalikan lagi ke nilai Yahoo asli & status `sl` dengan `closed_t` breach asli (07:00 UTC) — 2 ronde koreksi tercatat di `data_fix_reason` sebagai jejak audit penuh.

**Root cause aktual:** GC=F dipakai sebagai harga acuan "XAU/USD" karena punya volume asli (dipakai analisis, lihat catatan lama di `_ohlcv_fetch.js`), tapi sebagai kontrak futures ia rawan basis blowout vs spot menjelang expiry kontrak aktif — bukan bug data, tapi mismatch instrumen (futures vs spot) yang biasanya cuma beda "beberapa dolar" tapi kadang bisa blowout puluhan dolar.

**Fix kode (`api/admin.js`) — guard korroborasi sumber kedua, bukan cuma koreksi data:**
- `_corroborateLevel`/`_breachDirection` (pure) + `_corroborateGoldTransitions`/`_finalizeSetupTransitions`: setiap kali `_evaluateSetups` mendeteksi transisi BARU ke tp/sl untuk simbol di `CORROBORATION_SYMBOLS` (saat ini hanya `GC=F`), cross-check candle jam yang sama dari Twelve Data XAU/USD (fallback existing, tidak ada integrasi vendor baru) sebelum dipercaya final. Toleransi basis 15 USD (`GOLD_BASIS_TOLERANCE_USD`) — longgar untuk spread wajar, ketat menangkap divergensi >$50 seperti insiden ini.
- Kalau spot TIDAK korroborasi: status di-revert ke `open`, `closed_t` dihapus, field audit `divergence_hold` (would_be_status/level/direction/reason) dicatat — evaluasi tick berikutnya tetap jalan normal (kalau breach berlanjut & kali ini terkonfirmasi, closed dengan benar). Push notifikasi baru `_notifyDivergenceHold` (subscriber dev) supaya user tahu tanpa harus curiga manual seperti insiden ini.
- Fetch Twelve Data dilakukan DI LUAR lock utama pemanggil (bisa sampai ~10 detik, hampir sama dengan TTL lock `lock:setuplog_write:*`) — revert (kalau ada) pakai siklus lock terpisah & pendek, re-read Redis fresh sebelum menimpa. Twelve Data gagal/limit habis → fail-open (percaya `_evaluateSetups` apa adanya), konsisten dengan pola fail-open di seluruh file.
- Diintegrasikan di kedua jalur yang bisa memfinalisasi tp/sl: `_buildAutoScopeStats` (poll `setup_stats?scope=auto`) dan `positionReviewHandler` (event-driven daemon) — sama-sama lewat `_finalizeSetupTransitions`, tidak ada jalur yang lolos tanpa guard.

**GAP KRITIS ditemukan saat implementasi, LANGSUNG DITUTUP sesi ini:** `TWELVEDATA_API_KEY` **belum pernah di-set di Vercel production** (action item lama sejak Session 186, tercatat "fallback no-op" di `daun_merah_vendor.md`) — tanpa key ini, guard korroborasi baru DIAM-DIAM tidak pernah jalan (fail-open selalu, karena `fetchFallbackCandles` langsung throw tanpa API key). User sempat menyangka sudah di-add ("sudah") tapi `vercel env ls` membuktikan tidak ada baris `TWELVEDATA_API_KEY` sama sekali di environment manapun — bukan kasus var "Sensitive" yang value-nya disembunyikan (baris tetap ada), murni belum ke-submit. Ditambahkan via `vercel env add TWELVEDATA_API_KEY production/preview` (value dari `.env.local`, yang tersimpan salah nama `TWELVE_DATA_API_KEY`) lalu `vercel redeploy` manual ke deployment production terbaru supaya langsung aktif tanpa nunggu push kode berikutnya — diverifikasi ulang via `vercel env ls`.

**Verifikasi:** `npm test` 685/685 hijau (671 sebelumnya + 14 test baru `test/admin/gold_corroboration.test.js` — pure function `_breachDirection`/`_corroborateLevel` termasuk replay persis insiden asli, integrasi `_corroborateGoldTransitions` revert/konfirmasi/fail-open/simbol-di-luar-scope, `_finalizeSetupTransitions` no-op kalau tidak ada transisi). Bug ditemukan & difix saat menulis test: `Object.assign` di path revert tidak menghapus `closed_t` dari objek in-memory (Object.assign tidak menghapus key yang sudah tak ada di source) — delete eksplisit ditambahkan sebelum assign.

**File diubah:** `api/admin.js`, `test/admin/gold_corroboration.test.js` (baru). Data Redis (`ohlcv:GC=F:1h`, `setup_log_auto:v1`) dikoreksi 2 ronde via skrip sekali-pakai (tidak disimpan di repo) — state akhir: candle asli dipulihkan, status `sl` dengan closed_t breach asli.

## Changelog Session 261 (2026-07-29) — Audit Lanjutan Celah Auto-Entry: Race Condition Gate A + 3 Perbaikan Statistik

**Konteks:** Lanjutan audit Plan U pasca-Session 259 (aktivasi Sistem Hakim). User minta saya nilai mana dari 6 celah audit awal yang "layak dikerjakan" tanpa menambah noise — disepakati 4 item: race condition Gate A, cost expectancy diam-diam exclude pair, Gate B pakai rr bukan realized-R, dan ambiguitas fallback regime. Item lain (ghost-tracking Gate B/D, deteksi fail-open bertumpuk) ditahan sesuai rekomendasi (berisiko jadi observability tak diminta).

**1. BUG KRITIS — race condition Gate A vs lock TTL (`api/admin.js`):** Ditemukan saat menelusuri lebih dalam: lock `lock:setuplog_write:setup_log_auto:v1` TTL 10 detik, tapi Gate A (AI Kritikus, `_runCriticVerdict`) timeout 25 detik — SELURUH Gate D/B/A + tulis akhir sebelumnya terjadi di bawah SATU lock yang sama, jadi TIAP KALI Gate A benar-benar terpanggil, lock itu kedaluwarsa jauh sebelum selesai (window nyata untuk proses lain menimpa array yang sama, lost update). `positionReviewHandler` sudah lama punya pola yang benar untuk masalah identik (lock dilepas sebelum AI call, state dibaca ulang & divalidasi di lock baru sebelum tulis) — direplikasi ke `ohlcvAnalyzeHandler` via 2 fase: Fase 1 (dup/openSame/stalePending refine-atau-flip, Gate D/B) di bawah lock singkat, selesai di situ juga kalau tidak perlu Gate A (manual SELALU lewat jalur ini, tidak ada perubahan perilaku/latensi untuk manual); Fase 2 (Gate A) tanpa lock, lalu re-acquire + baca ulang state segar sebelum tulis (kalau state berubah selama AI mikir, keputusan dibuang — `race_detected`, bukan menimpa buta). Bonus fix sekunder yang ikut ketemu: pembatalan stale pending via Flip Guard (`canceled_reason:'bias_flip'`) dulu bisa hilang tanpa jejak kalau kandidat barunya kemudian ditahan Gate D/B/A (shouldSaveLog tidak diset true di cabang itu) — sekarang selalu tersimpan.

**2. Cost expectancy diam-diam exclude pair (`api/admin.js`, `_aggCostExpectancy`):** Pair closed (tp/sl) yang tidak ada di `SPREAD_PRICE_ESTIMATE` dulu dikecualikan dari `n` tanpa tanda apa pun (persis insiden AUD/NZD 2026-07-28, baru ketahuan manual). Field baru `missing_spread_table` (murni aditif) sekarang merekam label pair yang hilang, supaya gap serupa di pair baru langsung kelihatan di payload `setup_stats`.

**3. Gate B pakai realized-R, bukan `rr` target tersimpan (`api/_auto_entry_guard.js` + `api/admin.js`):** `computeRollingR` (Gate B) dan `_costAdjustedR` (cost expectancy) dulu memprioritaskan field `rr` tersimpan (target saat setup dibuat/direfine) untuk outcome TP — bisa meleset dari level FINAL kalau di-refine tapi `structured.risk_reward` kebetulan null di generate itu. Prioritas dibalik: geometri riil (`entry_zone`/`sl`/`tp` yang benar-benar tersimpan) menang, `rr` cuma fallback kalau `tp` tidak ada. Dibulatkan 2 desimal (konsisten dengan cara `risk_reward` dihitung saat generate) supaya tidak ada noise floating-point.

**4. Ambiguitas fallback regime di Gate B (`api/_auto_entry_guard.js`):** `isDrawdownHalted` dulu memperlakukan regime `null`/gagal-fetch/tak dikenal SAMA seperti `'neutral'` (-5R) — mencampur "regime memang dinilai netral" dengan "kita tidak tahu regime-nya sama sekali" (data hilang, bukan sinyal tenang). **Perubahan perilaku nyata:** sekarang diperlakukan seketat `'risk_off'` (-2R, paling konservatif) saat regime tidak diketahui — circuit breaker jadi lebih mudah menyala saat data regime hilang, bukan lebih longgar. Field baru `regime_known` (aditif) membedakan kasus ini dari regime `'neutral'` asli untuk analisis nanti.

**Verifikasi:** `npm test` 671/671 hijau (666 sebelumnya + 4 test baru `test/admin/gate_a_race.test.js` — termasuk skenario race_detected & flip-cancel-lalu-divero persis yang dibongkar temuan #1 — + 1 test baru `missing_spread_table`). Test lama yang assert perilaku pra-fix (`isDrawdownHalted` fallback -5R, `_aggCostExpectancy` shape lama) diperbarui eksplisit ke perilaku baru, bukan dihapus.

**File diubah:** `api/admin.js`, `api/_auto_entry_guard.js`, `test/admin/gate_a_race.test.js` (baru), `test/admin/cost_confidence_latency.test.js`, `test/api/_auto_entry_guard.test.js`.

**Ditahan (sesuai rekomendasi, bukan dikerjakan sesi ini):** ghost-tracking utk Gate B/D (pola sama `_evaluateCanceledGhost`, worth dikerjakan kalau memang mau audit validitas kedua gate itu — bukan sekadar penasaran); deteksi fail-open bertumpuk (risiko jadi observability tak diminta kalau dibikin sistem alarm penuh — kalau tetap mau, cukup 1 angka pasif per entry, bukan sistem deteksi).

## Changelog Session 259 (2026-07-29) — Aktivasi "Sistem Hakim" di Jalur Cron Auto-Entry + Pengukuran Terpisah

**Konteks:** Lanjutan diskusi audit alur auto-entry (Plan U, `setup_log_auto:v1`) — user diberi peta workflow lengkap (diagram if/else per gerbang, dibuat sebagai artifact) untuk menelusuri celah sendiri, lalu spesifik menanyakan mekanisme konsistensi bias AI antar-slot 08:15/13:15 UTC. Audit menemukan: guard `[SISTEM HAKIM]` (veto soft yang memaksa `conflict='arah'` kalau bias teknikal AI berlawanan dengan arah bank sentral tersimpan, `cbDir`) sudah lama ada di kode tapi **tidak pernah aktif di jalur cron otomatis** — `cbDir` cuma dikirim lewat body POST manual (`index.html`), sementara trigger cron (`vps/daemon.js`) adalah GET tanpa body. User minta 3 hal: (1) aktifkan di jalur cron, (2) JANGAN jadikan Sistem Hakim pembuat keputusan — bukan gate baru yang bisa veto sendiri, sesuaikan syarat kekuatan buktinya dengan kelemahan sinyal, (3) cari cara mengukur dampaknya tanpa merusak statistik existing (drawdown/cost-expectancy/confidence-calibration).

**Fix (`api/admin.js`):**
- `_computeCbDirServerSide(...)` — replikasi server-side dari `_ckInferDirFromCbBias` (index.html), pakai cache `cb_bias`/`thesis` XAU yang SUDAH difetch untuk blok fundamental (tidak fetch dobel). Syarat SENGAJA lebih ketat dari versi client (yang tidak cek confidence sama sekali): confidence KEDUA leg harus `'High'` (bukan Medium/Low) dan tidak sedang di-flag `divergence_warning` (Call 2 digest menahan bias lama karena sinyal baru belum cukup kuat); XAU butuh `xau_confidence>=4` (skala 1-5). Evidence lemah → `null` (Sistem Hakim diam-diam tidak nyala), bukan menebak.
- Dipanggil HANYA sebagai fallback saat `isAutoCall && !cbDir` — perilaku manual (index.html, selalu kirim `cbDir` sendiri di body, termasuk kalau nilainya sengaja `null`) tidak disentuh sama sekali.
- Pengukuran murni aditif, TIDAK mengubah field/kalibrasi yang sudah ada (confidence, conflict, makro_alignment, drawdown, cost_expectancy tetap identik): 2 field baru per entri `setup_log_auto` (`sistem_hakim: 'fired'|'clear'|null`, `conflict_source: 'ai'|'sistem_hakim'|null` — diperbarui juga di jalur refine in-place, pola sama field mentah lain), 1 agregat baru `sistem_hakim_calibration` (win-rate fired vs clear, hanya closed tp/sl, pola persis `_confidenceCalibration`) masuk `_aggSetupStats` (otomatis muncul di `setup_stats?scope=auto`), dan 2 counter Redis `sistem_hakim_stats:considered`/`fired` (family terpisah dari `auto_guard_stats:*` — Sistem Hakim bukan gate, tidak pernah membatalkan penyimpanan setup sendiri, cuma melabeli `conflict` yang lalu dibaca Flip Guard existing).

**Verifikasi:** `npm test` 666/666 hijau (652 sebelumnya + 14 test baru `test/admin/sistem_hakim.test.js` — pure function `_computeCbDirServerSide`/`_sistemHakimCalibration`, plus 3 test integrasi end-to-end: fired saat cb_bias High/High divergen, TIDAK fire saat confidence Medium, manual tidak terpengaruh sama sekali).

**File diubah:** `api/admin.js`, `test/admin/sistem_hakim.test.js` (baru).

**Belum dikerjakan (ditahan sampai konfirmasi akhir, sesuai permintaan user "itu dibagian akhir saja konfirmasinya"):** demote COT/retail sentiment jadi elemen sekunder di artifact audit workflow (COT tidak punya age-label di prompt, walau bisa basi 3-8 hari — retail sudah ada age-label, risikonya lebih kecil); keputusan "jangan tambah sumber data fundamental baru" sudah disetujui user, tidak perlu perubahan kode.

## Changelog Session 253 (2026-07-28) — Watcher TP/SL Real-Time (Q-7) + Multi-Provider Emas + Push Notif Dev

**Konteks:** user lapor 2 kasus terpisah di dev-auto-entry.html: (1) EURUSD=X sudah kena TP di MT5/TradingView tapi status di dev console masih `open` — investigasi menemukan root cause SEBENARNYA adalah `_evaluateSetups` (api/admin.js) cuma dievaluasi ulang kalau ada yang buka dev-auto-entry.html manual atau saat slot auto-entry 2x/hari — TIDAK ADA re-evaluasi berkala, jadi status bisa basi berjam-jam walau harga riil sudah tembus level; (2) GC=F (XAU/USD) diduga kena SL di MT5 tapi tidak di sistem — ternyata BUKAN bug, `GC=F` = kontrak futures COMEX (Yahoo), bukan spot XAU/USD broker, jadi ada basis (selisih harga wajar futures-vs-spot) yang membuat level SL/TP tidak selalu sinkron dengan broker riil.

**Keputusan user:** (a) tambahkan push notification ke HP saat setup kena TP/SL (bukan Telegram), (b) untuk emas, pakai MULTI-PROVIDER — Yahoo tetap untuk volume, Deriv ditambahkan untuk live streaming — bukan pilih salah satu.

**Implementasi Q-7 (`vps/daemon.js`):**
- Watcher event-driven baru (`maybeTriggerSetupWatch`/`getOpenSetupsWatchlist`/`priceCrossesLevel`) — di-hook ke `handleOhlcvUpdate` (pair FX yang sudah streaming Deriv Q-3) DAN ke tick baru `frxXAUUSD` (lihat poin multi-provider di bawah). Watchlist setup open (`setup_log_auto:v1`) di-cache in-memory 2 menit (pola sama `ZONE_DATA_CACHE_TTL_MS` Q-5) supaya tidak nge-GET Redis tiap tick. Saat harga live melewati sl/tp, daemon TIDAK menulis Redis sendiri (sengaja tidak menduplikasi `_detectLossLabel`/logika `_evaluateSetups` yang butuh candle+kalender penuh) — cuma trigger HTTP debounced 20 detik ke `setup_stats&scope=auto` yang sudah teruji.
- Baseline cron tambahan tiap 5 menit (jaring pengaman untuk symbol tanpa live stream, mis. `AUDNZD=X`) memanggil endpoint yang sama.
- **Multi-provider emas:** `frxXAUUSD` di-subscribe TERPISAH lewat `ticks` polos (BUKAN `ticks_history style:candles` seperti 14 pair `YAHOO_TO_DERIV_SYMBOL`) — supaya TIDAK ikut `mergeClosedCandle`/`writeClosedCandle` yang akan menimpa `ohlcv:GC=F:1h` dengan candle `v:0` (Deriv XAU spot tanpa volume). Live tick dipakai SEMATA untuk deteksi dini TP/SL; candle + volume `GC=F` tetap 100% dari Yahoo (`ohlcv_sync`/`ohlcv_analyze`) — dua provider jalan bersamaan tanpa saling menimpa.

**Implementasi notifikasi (`api/admin.js`):**
- `_buildAutoScopeStats` sekarang snapshot status SEBELUM `_evaluateSetups` (`statusBeforeById`), lalu setelah evaluasi + write Redis, deteksi setup yang baru transisi ke `tp`/`sl`/`ambiguous` dan panggil `_notifySetupOutcome` (push web-push) untuk tiap transisi — jadi berlaku dari SEMUA jalur trigger (event-driven daemon, baseline 5 menit, buka dev-auto-entry.html manual, atau slot auto-entry 2x/hari), bukan cuma satu.
- Push dikirim ke hash Redis BARU `push_subs_dev` — **TERPISAH TOTAL** dari `push_subs` publik (dipakai notifikasi berita `api/subscribe.js`). Auto-entry tetap developer-only (Plan U-7 REVISI VISIBILITAS) — kalau numpang `push_subs`, user biasa yang subscribe notif berita bisa kebagian alert eksperimen ini, bocor eksistensi fitur yang sengaja disembunyikan.
- Endpoint baru `action=push_subscribe_dev` (POST subscribe / DELETE unsubscribe), auth sama seperti aksi dev lain (`x-admin-secret`/`x-cron-secret` == `CRON_SECRET`), BUKAN `requireAppKey` publik.
- `dev-auto-entry.html`: tombol "Notif TP/SL: on/off" di header (reuse VAPID public key yang sama dengan index.html, tapi subscribe ke endpoint & hash Redis terpisah). Registrasi service worker `./sw.js` (payload-agnostic, tidak perlu ubah `sw.js`).

**Kenapa desain ini (bukan alternatif lain):** sempat dipertimbangkan daemon.js langsung menulis status + label loss sendiri saat live-tick match, ditolak karena akan menduplikasi logika `_detectLossLabel` (fundamental_shock/fakeout_sl butuh candle penuh + kalender events) di 2 bahasa/file — risiko divergensi untuk sistem yang arahnya AI pegang dana riil (lihat prioritas rigor [[project-plan-u-end-goal-ai-fund-manager]]). Trigger-only (daemon relay, admin.js authoritative) menjaga SATU sumber kebenaran untuk state-transition, sekaligus tetap dapat manfaat latensi deteksi (detik, bukan jam).

**Lanjutan (audit tradeoff diminta user):** ditemukan Q-7 (event-driven + baseline 5 menit) SATU-SATUNYA hidup di `vps/daemon.js` — beda dari `ohlcv_sync`/`retail-sentiment-warm` yang sudah punya fallback GH Actions paralel, Q-7 belum. Ditambahkan `.github/workflows/setup-tp-sl-watch.yml` (cron `*/5 * * * *`, pola identik `ohlcv-sync.yml`) supaya evaluasi `setup_stats&scope=auto` tetap jalan walau VPS Railway down — aman dipanggil ganda karena lock `lock:setuplog_write:setup_log_auto:v1` sudah ada sejak sebelumnya.

Dicek juga langsung ke Upstash (`DBSIZE` + `INFO memory`) atas pertanyaan user soal kapasitas penyimpanan: 203 key, `used_memory` 415KB dari `maxmemory` 64MB (~0,6% terpakai) — jauh dari batas, dan `push_subs_dev` (hash baru sesi ini) menambah cuma beberapa KB. Command COUNT (bukan storage) yang jadi sumber tradeoff nyata sesi ini (baseline cron + watchlist cache daemon menambah frekuensi panggilan Redis/Vercel) — belum ada visibilitas otomatis ke kuota command harian Upstash dari sisi kode, tetap perlu dicek manual ke dashboard tiap awal bulan (pola existing, lihat `daun_merah_vendor.md`).

**Test:** `priceCrossesLevel` + drift-guard `XAU_YAHOO_SYMBOL`/`XAU_DERIV_SYMBOL` tidak ikut `YAHOO_TO_DERIV_SYMBOL` (`test/vps/vps_daemon.test.js`, +4). `pushSubscribeDevHandler` (auth/validasi/isolasi dari `push_subs`) + notifikasi terkirim HANYA saat transisi status baru, tidak terkirim ulang untuk status yang sudah tp/sl sebelumnya, tidak crash tanpa subscriber (`test/admin/push_subscribe_dev.test.js`, baru, 7 test — pakai kunci VAPID asli via `web-push.generateVAPIDKeys()` karena `web-push` throw kalau format kunci sembarangan). `npm test` 640/640 hijau (629 lama + 11 baru).

**File diubah:** `vps/daemon.js` (Q-7 watcher + subscribe tick XAU + cron baseline 5 menit), `api/admin.js` (`pushSubscribeDevHandler`, `_notifySetupOutcome`, hook transisi di `_buildAutoScopeStats`, entri `KEY_REGISTRY`), `dev-auto-entry.html` (tombol + subscribe flow push dev-only), `test/vps/vps_daemon.test.js`, `test/admin/push_subscribe_dev.test.js` (baru).

**Addendum (2026-07-28, audit log live pasca-deploy) — cadence cron GH Actions jauh di bawah konfigurasi:** dicek `gh run list` untuk `setup-tp-sl-watch.yml` (Q-7 fallback, cron `*/5 * * * *`) — dalam ~4,5 jam pertama sejak workflow dibuat, cuma **2 run** yang benar-benar tereksekusi (gap 1j46m lalu 2j31m), bukan ~54 run yang diharapkan tiap 5 menit. Dicek juga `ohlcv-sync.yml` (cron `0 * * * *`, sudah lama live) sebagai pembanding: rata-rata gap AKTUAL dari 30 run terakhir **130 menit** (bukan 60), min 61 menit, max 251 menit. Ini BUKAN bug kode (tiap run yang benar-benar jalan sukses HTTP 200) — ini keterbatasan dikenal GitHub Actions: `schedule` event di runner shared bisa ditunda/dijatuhkan signifikan saat load tinggi, makin parah untuk interval pendek. Dampak nyata saat ini nihil karena jalur utama (daemon Railway, heartbeat live diverifikasi <1 menit saat audit) masih menanggung beban real-time — GH Actions di sini murni fallback sekunder. Yang perlu diingat: **kalau Railway down BERSAMAAN dengan gap panjang GH Actions ini, jeda deteksi TP/SL bisa jauh lebih lama dari asumsi "5 menit"** — dicatat sebagai karakteristik infra, bukan item kerja (tidak ada mitigasi yang diusulkan, sesuai instruksi user prioritaskan kurangi noise bukan tambah observabilitas).

## Changelog Session 252 (2026-07-28) — Riset Akurasi & Kualitas Auto-Entry (8 sitasi baru) + Fix Celah Spread AUD/NZD

**Konteks:** user minta riset hal-hal yang bisa membuat auto-entry lebih akurat & berkualitas. Riset murni (bukan eksekusi fitur) — beda dari Session 250/251 yang membangun & memangkas gate.

Kriteria inklusi ditulis SEBELUM search (mengikuti temuan §12 Cao 2025 soal triase terstruktur), 6 query `search_scopus` (~90 hasil mentah), 8 paper lolos verifikasi web ke sumber primer.

**Hasil riset:** `daun_merah_referensi_riset.md` §13 (5 sub-bagian: efikasi stop-loss, periodisitas intraday FX, biaya transaksi, meta-labeling, ensemble LLM) + terjemahan ke kode aktual di `daun_merah_riset.md` (4 celah terukur, diurut manfaat-per-usaha).

Sitasi baru terverifikasi: Kaminski & Lo (2014 JFM), Lo & Remorov (2017 JFM), Arratia & Dorador (2019 QF), Andersen & Bollerslev (1997 JEF), Ito & Hashimoto (2006 JJIE), Filippou dkk. (2024 JFE), Hsu-Taylor-Wang (2016 JIE), Schoenegger dkk. (2024 Science Advances).

**Kesimpulan utama (tidak ada gate/mekanisme baru direkomendasikan):** 3 dari 4 celah bisa dijawab dengan menganalisis data yang SUDAH terkumpul.

Yang paling penting — spread sudah dihitung di NILAI hasil (`_costAdjustedR`, item #1 rigor Plan U 2026-07-20) tapi belum di PENENTUAN hasil: `_evaluateSetups` memutuskan `tp` vs `sl` dari wick candle H1 di harga mid tanpa spread, jadi expectancy net konservatif TAPI `win_rate_raw`/`win_rate_adjusted` (kriteria gate n≥100) masih optimis.

Dua temuan yang sifatnya VALIDASI, bukan masalah: slot 08:15 & 13:15 UTC sudah jatuh di jendela aktivitas tinggi/spread tersempit (Ito & Hashimoto 2006), dan tighten preventif Jumat tetap didukung walau overnight gap dimodelkan (Arratia & Dorador 2019).

**Fix yang langsung dikerjakan (celah data, ditemukan saat verifikasi klaim riset ke kode):** `SPREAD_PRICE_ESTIMATE` (`api/admin.js`) tidak punya entri `AUD/NZD` padahal pair itu masuk `AUTO_ENTRY_PAIRS` sejak redesain 4-pair Session 247 — akibatnya SELURUH setup AUD/NZD di-skip diam-diam dari `cost_expectancy` (fallback `null` per-entri di `_costAdjustedR`), jadi angka expectancy net selama ini cuma mewakili 3 dari 4 pair tanpa tanda apa pun di payload. Ditambahkan `'AUD/NZD': 0.00030` (ballpark konsisten tabel: NZD/USD 0,00025, EUR/AUD 0,00035).

**Koreksi klaim sesi ini sendiri:** dugaan awal "biaya spread tidak dimodelkan sama sekali" SALAH — dicek ke kode, `SPREAD_PRICE_ESTIMATE`/`_costAdjustedR`/`_aggCostExpectancy` sudah ada sejak 2026-07-20. Yang benar adalah pembedaan nilai-vs-penentuan di atas.

**File diubah:** `api/admin.js` (1 entri tabel spread + komentar), `Dokumentasi/daun_merah_referensi_riset.md` (§13 baru), `Dokumentasi/daun_merah_riset.md` (entri riset aktif).

`npm test` 629/629 hijau. Tidak ada perubahan runtime auto-entry, tidak ada perubahan UI/payload publik — isolasi senyap U-7 tidak tersentuh.

## Changelog Session 251 (2026-07-28) — Hapus Gate C, Riset Scopus AI Lanjutan Audit-Guard

**Konteks:** Lanjutan sesi 250 (4 gate audit-guard). Diminta riset Scopus AI lanjutan (§11/§12 `daun_merah_referensi_riset.md`) khusus soal noise-vs-sinyal stacking 4 gate — tidak ditemukan paper langsung yang uji topik itu (beda konsep dari data-snooping/White 2000 & Bajgrowicz-Scaillet 2012 yang disitasi), jadi jawaban empiris disarankan lewat counter `auto_guard_stats` + counterfactual (`_evaluateCanceledGhost`-style), bukan literatur tambahan.

Riset kedua (percepatan proses riset sendiri) menghasilkan Cao 2025/Khraisha 2024/Pham 2016 — memvalidasi kewajiban verifikasi manual existing, bukan rekomendasi baru.

**Diskusi Gate C:** user menunjukkan celah nyata di `isRegimeConfidenceBlocked()` — fungsi ini BUTA ARAH (cuma cek `symbol/regime/confidence`, tidak menerima `bias`), jadi XAU/USD **bullish** (selaras teori safe-haven) saat `risk_off` tetap diblokir kalau confidence rendah, walau arahnya sendiri sudah benar.

Argumen user: skeptisisme "risk_off → hati-hati" seharusnya sudah jadi bagian penalaran AI thesis (Analisa/pre-entry check yang baca `risk_regime` langsung), bukan filter buta terpisah di atasnya. **Keputusan: Gate C dihapus**, sesi yang sama dengan pembuatannya (Session 250).

**Eksekusi:**
- `api/_auto_entry_guard.js`: hapus `REGIME_RELEVANT_SYMBOLS` + `isRegimeConfidenceBlocked()`, update header comment ("Tiga gate" → "Dua gate": B drawdown circuit breaker, D correlation cap).
- `api/admin.js`: hapus pemanggilan Gate C di persist block `ohlcvAnalyzeHandler`, hapus import, hapus entri `auto_guard_stats:regime_confidence` dari `KEY_REGISTRY`, pindah ke `DEPRECATED_KEYS` (key belum pernah tertulis live — dicek `exists:false` semua counter `auto_guard_stats:*` di production, auto-entry belum sempat jalan sejak deploy S250).
- `test/api/_auto_entry_guard.test.js`: hapus 5 test Gate C.
- `npm test` 627/627 hijau (632 - 5 test Gate C yang dihapus).

**Sisa aktif:** Gate A (AI Kritikus), Gate B (drawdown circuit breaker), Gate D (correlation cap) — semua HANYA jalur `isAutoCall`, isolasi U-7 tetap terjaga.

**Lanjutan audit kritis Gate A/B (sama sesi):** diminta cari kelemahan nyata lain (bukan dipaksakan) di gate sisa.

- **Gate A:** klaim awal "model+temperature PERSIS SAMA dengan call thesis" **DIKOREKSI** (user menunjukkan salah baca kode) — PRIMARY call thesis (termasuk auto-entry) sebenarnya **DeepSeek v4-flash via API resmi (berbayar, saldo top-up)**, `admin.js:4086`, BUKAN SambaNova; SambaNova V3.2 cuma fallback kalau v4-flash gagal. Gate A (`_runCriticVerdict`) SambaNova-only, tidak pernah pakai v4-flash. Jadi di kondisi normal (v4-flash primary berhasil): thesis & kritikus itu DUA MODEL BEDA (v4-flash vs V3.2), bukan self-review — klaim "sama persis" cuma benar di skenario fallback (v4-flash gagal DAN thesis juga jatuh ke SambaNova). Kritikus sendiri tetap free tier (pool terpisah 30/hari, tidak menyentuh saldo berbayar). **Keputusan: TIDAK dihapus** (beda dari Gate C yang punya bug logika jelas, dan alasan "self-review" ternyata lebih lemah dari klaim awal) — pantau rasio `critic_veto`/`considered` begitu ada data live.
- **Gate B:** ditemukan tidak ada ambang sampel minimum sebelum circuit breaker aktif — di awal umur sistem (rolling window 10 = seluruh riwayat yang ada saat ini), 2 SL beruntun saat `risk_off` (ambang -2R) sudah cukup membekukan SEMUA pair, padahal itu cuma variance dari sampel kecil, bertentangan dengan prinsip "tunggu n cukup" yang dipegang di tempat lain Plan U. **Diperbaiki:** tambah `DRAWDOWN_MIN_SAMPLE = 5` (konsisten dengan preseden ambang `_formatTrackRecordBlock` yang juga butuh >=5 setup selesai) — `isDrawdownHalted()` sekarang selalu `halted:false` kalau `closedSetups.length < 5`, apapun rollingR-nya. Field `sampleSize` ditambahkan ke return value.
- **Gate D:** dicek ulang (sudah sadar arah lewat `usdView`, dan `vps/daemon.js` loop 4 pair SEQUENTIAL bukan paralel jadi tidak ada race kondisi) — tidak ditemukan cacat, dibiarkan apa adanya.

**File diubah:** `api/_auto_entry_guard.js` (`DRAWDOWN_MIN_SAMPLE` + update `isDrawdownHalted`), `test/api/_auto_entry_guard.test.js` (2 test baru ambang minimum + 2 test lama disesuaikan sampel >=5). `npm test` 629/629 hijau.

## Changelog Session 250 (2026-07-28) — Eksekusi 4 Gate Audit "Kesalahan Trader" Auto-Entry

**Konteks:** Lanjutan diskusi user soal tujuan akhir Plan U (AI jadi pengelola dana riil, bukan sekadar eksperimen) — diminta audit celah "kesalahan trader" di pipeline auto-entry. Audit kode (langsung ke file, bukan checklist generik) menemukan 4 celah nyata di `vps/daemon.js` → `api/admin.js` → `setup_log_auto:v1`:

1. AI Kritikus (`ohlcv_critic`, alat anti-confirmation-bias yang sudah ada) tidak pernah dipanggil untuk auto-entry, cuma tombol manual.
2. Tidak ada circuit breaker kerugian beruntun.
3. `risk_regime` (VIX/MOVE/HY) cuma teks informatif di prompt AI, tidak ada gate kode.
4. Tidak ada batas eksposur portofolio lintas-pair (relevan ke caveat XAU/USD-EUR/USD r=0,585 yang sudah dicatat sesi ini juga).

User khawatir menerapkan ke-4 gate sekaligus akan membuat sistem terlalu ketat (sinyal makin jarang, mengancam kecepatan akumulasi n≥30/pair Plan U) — diminta riset Scopus AI dulu sebelum eksekusi.

**Riset (`daun_merah_referensi_riset.md` §10, 4 sitasi diverifikasi manual — Varma 2025, Moreira & Muir 2017, Zhao/Ledoit/Jiang 2023, Subrahmanyam 1994):** kekhawatiran user beralasan tapi solusinya ambang ADAPTIF per kondisi pasar, bukan batalkan gate-nya. Benang merah 4 topik: drawdown-based circuit breaker > consecutive-loss (yang terakhir rawan "magnet effect" — trader/algo malah mempercepat aksi mendekati ambang); "reduce size/bar" > "skip entirely" untuk gate volatilitas; HRP/gross-exposure constraint sederhana cukup untuk correlation cap skala retail.

**Eksekusi — 4 gate, HANYA jalur `isAutoCall` (manual TIDAK disentuh, isolasi U-7 tetap):**

1. **Gate A (AI Kritikus otomatis):** logika AI-call `ohlcv_critic` diekstrak jadi `_runCriticVerdict()` reusable (dipakai tombol manual DAN Gate A auto-entry — fact sheet Gate A numpang blok yang sudah dibangun untuk prompt Analisa, TIDAK fetch Redis tambahan). Verdict `"batalkan"` → setup tidak disimpan.
   **Bug ditemukan & difix saat implementasi:** draft awal Gate A memanggil pool AI `ai:sambanova:main`/`sambanova_main` yang sama dengan tombol manual publik — pola bug PERSIS yang pernah ditemukan S218 untuk `deepseek_experimental` (auto-entry & manual rebutan kuota harian yang sama). Diperbaiki: `_runCriticVerdict` sekarang terima `cbKey`/`budgetKey` opsional, Gate A pakai `ai:sambanova:main:experimental`/`sambanova_main_experimental` (key yang SUDAH ada di `KNOWN_CIRCUITS`, dipakai call auto-entry utama — konsisten).
2. **Gate B (drawdown circuit breaker adaptif):** `isDrawdownHalted()` di `api/_auto_entry_guard.js` baru — rolling 10 setup tertutup terakhir (lintas semua pair), ambang R berbeda per `risk_regime` (risk_on -6R, neutral -5R, elevated -3R, risk_off -2R, heuristik awal belum dikalibrasi live).
3. **Gate C (regime confidence bar):** `isRegimeConfidenceBlocked()` — tolak entry `confidence:"rendah"` saat regime `elevated`/`risk_off`; confidence sedang/tinggi tidak pernah diblokir. Terjemahan "reduce size" (Moreira & Muir) ke sistem virtual 1-unit-R yang tidak punya position sizing kontinu.
4. **Gate D (correlation cap):** `isCorrelatedExposureBlocked()` — cuma cover SATU pasangan yang terbukti korelatif di set 4-pair saat ini (XAU/USD-EUR/USD r=0,585), blokir entry baru kalau pandangan USD-nya sama dengan posisi open pasangannya.

Ke-4 gate dicek berurutan (murah dulu: regime→correlation→drawdown, baru AI Kritikus di akhir supaya kandidat yang bakal ditahan gate murah tidak buang budget AI).

**File diubah:** `api/_auto_entry_guard.js` (baru, pure function), `api/admin.js` (`_runCriticVerdict` diekstrak dari `ohlcvCriticHandler`, gate dipasang di persist block `ohlcvAnalyzeHandler`), `test/api/_auto_entry_guard.test.js` (baru, 18 test).

**Verifikasi:** `npm test` 631/631 hijau (613 lama + 18 baru), termasuk `test/admin/position_review.test.js` yang meng-`require('../../api/admin.js')` langsung (memastikan refactor `ohlcvCriticHandler` tidak merusak module load). Response JSON tombol manual "UJI KELEMAHAN" dijaga identik (field `objections/verdict/model/raw/symbol/label/generated_at` sama persis). Belum ada verifikasi live cron (gate baru jalan di panggilan `auto=1` scheduler berikutnya) — dipantau via log `auto-entry <symbol> ditahan oleh audit-guard: <alasan>`.

**Addendum (sama sesi) — dampak ke kecepatan n≥30/pair + pencatatan ringan:** user tanya apakah gate baru bikin akumulasi sampel Plan U lebih lambat — jawaban jujur: **iya**, karena kandidat yang ditahan gate TIDAK tersimpan sama sekali (beda dari dup/refine lama yang tetap punya jejak), jadi rate sampel/hari pasti turun; besarannya belum bisa dihitung pasti tanpa data live.

User juga tanya apakah menumpuk 4 gate ini berisiko jadi "noise" — jawaban jujur: ada risiko nyata, karena SEMUA ambang di ke-4 gate masih heuristik awal (belum dikalibrasi dari data Daun Merah sendiri), dan riset Scopus AI kemarin sendiri bilang "empirical quantification of combined filter pipelines is limited" — interaksi ke-4 gate SEKALIGUS belum pernah diukur siapa pun di literatur.

Untuk mulai menjawab ini secara empiris (bukan tebak-tebak lagi), ditambahkan **pencatatan ringan**: counter Redis `INCR` polos `auto_guard_stats:{considered,saved,regime_confidence,correlation_cap,drawdown_circuit_breaker,critic_veto}` (invarian: `considered = saved + 4 alasan lainnya`), dibaca via `redis-keys?key=auto_guard_stats:<nama>&x-admin-secret=...` (field `value` baru ditambahkan ke `getKeyInfo()` KHUSUS prefix ini — key lain di registry tidak terpengaruh).

**Batasan disadari & dicatat eksplisit:** ini cuma jawab "seberapa sering tiap gate nyala", BUKAN "apakah gate itu benar" (kandidat yang ditahan memang akan SL, vs noise — sebenarnya akan TP kalau tidak ditahan). Untuk itu perlu pola counterfactual seperti `_evaluateCanceledGhost` (bias_flip) — sengaja belum dibuat (lebih besar dari "pencatatan ringan" yang diminta), jadi kandidat untuk lanjutan kalau user mau benar-benar menguji tiap gate itu menyelamatkan atau cuma sok tahu.

**Addendum kedua (sama sesi) — persempit Gate C, TOLAK tambahan sample-log Gate A (user tegas: "gasuka noise"):** user tanya apakah Gate C bisa "menyesuaikan" untuk XAU/USD (yang secara klasik bisa bull/bear beda arah saat risk_off) dan kenapa AUD/NZD/EUR/GBP ikut kena regime global padahal fundamentalnya beda.

Jawaban: Gate C dipersempit HANYA ke `GC=F`/`EURUSD=X` (`REGIME_RELEVANT_SYMBOLS` di `_auto_entry_guard.js`) — AUD/NZD & EUR/GBP di-skip total, karena keduanya SENGAJA dipilih di redesain 4-pair karena independen dari faktor risiko global (r=0,10-0,19), jadi `risk_regime` memang tidak relevan buat pair itu.

**Sengaja TIDAK** menambah aturan arah bull/bear XAU/USD berdasar risk_off — itu akan kontradiksi temuan korelasi kita sendiri (XAU/USD-EUR/USD bergerak BERSAMAAN r=0,585, bukan berlawanan seperti cerita "gold safe-haven vs dollar") dan berarti nambah asumsi baru yang belum terbukti.

User juga eksplisit MENOLAK usul menambah sample-log 5 alasan "batalkan" terakhir Gate A — instruksi tegas: prioritaskan kurangi permukaan noise, bukan tambah observabilitas baru kalau tidak diminta.

## Changelog Session 248 (2026-07-27) — Koreksi Data Race Condition GC=F Tumpang Tindih

**Konteks:** User cek dashboard "10 Setup Terbaru" di dev console (Session 247), sadar ada 2 entri GC=F berstatus `open` sekaligus dengan bias berlawanan (bullish `GC=F:1784708110704` vs bearish `GC=F:1784880912664`) — padahal `api/admin.js` punya guard eksplisit "1 ide aktif per symbol" (dari Plan U-3 lanjutan, 2026-07-20) yang seharusnya memblokir sinyal baru selama pair itu masih ada posisi open.

**Root cause (ditelusuri dari kode + changelog Session 242):** Bukan guard gagal — ini residu dari bug race condition ts-reset-refine yang sudah difix Session 242 (2026-07-25). Kronologi: `GC=F:1784708110704` (bullish) sempat salah ter-mark status `tp` (closed) lebih awal akibat bug tersebut; karena guard hanya cek `status === 'open'`, saat `GC=F:1784880912664` (bearish) dibuat 24/7 15:15 UTC, pair GC=F *terlihat* kosong (tidak ada yang open) sehingga entri baru lolos dibuat. Sehari kemudian (25/7), status entri pertama dikoreksi manual balik ke `open` (fix Session 242) — efek sampingnya, baru sekarang kelihatan 2 posisi tumpang tindih berkorelasi (1 pergerakan harga XAU/USD terhitung sebagai 2 event independen), persis risiko yang disebut di komentar guard itu sendiri.

**Perbaikan:** Entri `GC=F:1784880912664` (bearish, lahir dari kondisi race) dibatalkan retroaktif via `setup_override` (`scope:auto`, `data_fix.status:'canceled'`) — bukan mengubah hasil trade, murni pelabelan status sesuai kebijakan guard yang seharusnya berlaku sejak awal. Jejak audit lengkap tersimpan di `data_fix_reason`/`data_fix_by:'admin'`/`data_fix_at`. Entri `GC=F:1784708110704` (bullish, korban asli bug Session 242) TIDAK disentuh — tetap `open`, itu posisi yang sah.

**Catatan untuk data n≥30 per-pair (gate Plan U):** total historis GC=F masih terhitung 5 termasuk entri yang baru dibatalkan ini (dibatalkan ≠ dihapus), tapi tidak lagi ikut win-rate/expectancy TP-SL. Dampak ke statistik saat ini kecil (masih fase awal, jauh dari n≥30), dicatat sekarang supaya tidak terulang jadi kebingungan nanti saat n sudah besar.

## Changelog Session 247 (2026-07-26) — Eksekusi Redesain Independensi Pair Auto-Entry Plan U

**Konteks:** Lanjutan riset Session 246 (`daun_merah_riset.md`) — audit korelasi membuktikan Golden Trio (XAU/USD, EUR/USD, GBP/USD) saling korelatif (r=0,53-0,83, share kaki USD), jadi n≥100 gabungan BUKAN sampel independen. Setelah diskusi & analisis kandidat (4 pair diuji: EUR/GBP, AUD/JPY, AUD/NZD, CHF/JPY di dua dimensi — kecepatan & independensi), user putuskan eksekusi: **GBP/USD dibuang, AUD/NZD + EUR/GBP masuk** — pair final EUR/USD, XAU/USD, AUD/NZD, EUR/GBP.

**Perubahan kode:**
1. `vps/daemon.js` — `AUTO_ENTRY_SYMBOL_MAP` tambah `frxAUDNZD`/`frxEURGBP`; default `AUTO_ENTRY_PAIRS` diganti `frxXAUUSD,frxEURUSD,frxAUDNZD,frxEURGBP` (4 pair, 8 call/hari, naik dari 6 — masih jauh di bawah pagar `deepseek_experimental` 15/hari). `frxGBPUSD` tetap ada di map (tidak dihapus, cuma tidak lagi di daftar aktif) supaya tidak breaking kalau ada yang override env var lama.
2. `api/admin.js` — `OHLCV_FIXED_PAIRS` tambah `AUDNZD=X`/`EURGBP=X` supaya cache `ohlcv:*:1h/4h/1d` selalu terjaga cron `ohlcv_sync` (EUR/GBP dobel sumber — sudah ada di `YAHOO_TO_DERIV_SYMBOL` daemon.js sejak Q-3, jadi dapat Deriv stream + fallback cron ini; AUD/NZD Yahoo-only sama pola GC=F, tidak ada mapping Deriv).
3. `api/_ohlcv_fetch.js` — **bug ditemukan & difix saat testing**: `AUDNZD=X` belum ada di `YAHOO_TO_TWELVEDATA_SYMBOL`, jadi kalau Yahoo down, AUD/NZD tidak punya fallback (test `ohlcv_sync_fallback_integration.test.js` gagal 9/10 synced sebelum fix). Ditambahkan `'AUDNZD=X': 'AUD/NZD'`.
4. `dev-auto-entry.html` — kartu baru **"Gate Plan U — Cukup Data?"** di puncak dashboard: cek eksplisit n global ≥100 **DAN** SETIAP pair individual ≥30 (bukan cuma global saja) — kalau ada pair di bawah ambang walau total sudah ≥100, status tampil "BELUM CUKUP" + pair mana yang belum lolos. Ini fix konseptual penting yang muncul dari diskusi: skema lama (3 pair) kebetulan bikin dua ambang nyampe bareng, tapi begitu jumlah pair berubah, dua ambang itu bisa tidak sinkron lagi kalau tidak dicek eksplisit.
5. `test/vps/auto_entry.test.js` — update ekspektasi default `AUTO_ENTRY_PAIRS` + tambah test mapping AUD/NZD & EUR/GBP.

**Keputusan yang SENGAJA tidak dieksekusi:** 10 entri lama `setup_log_auto:v1` (dari regime Golden Trio lama) DIBIARKAN apa adanya, tidak dihapus/diarsipkan — non-destruktif, dan entri GC=F/EURUSD=X yang masih relevan tetap terus terakumulasi normal; entri GBP/USD lama cuma berhenti bertambah (tidak di-generate baru), tapi tetap valid dievaluasi TP/SL seperti biasa.

**Verifikasi:** `npm test` 613/613 hijau (612 sebelumnya + 1 test baru, minus 1 kegagalan sementara saat fix TwelveData fallback). Dashboard Gate card diverifikasi Playwright + mock server untuk 2 skenario (lolos semua & ada pair belum ≥30) — render benar, nol JS error. Ketersediaan data Yahoo untuk AUDNZD=X/EURGBP=X sudah diverifikasi Session 246 (backtest korelasi & opportunity-rate). Deriv streaming utk AUD/NZD TIDAK diverifikasi (di luar scope — pair ini didesain Yahoo-only, sama seperti XAU/USD yang sudah production-proven tanpa Deriv).

## Changelog Session 246 (2026-07-26) — UI Dev Console untuk Auto-Entry (Plan U), Ganti Postman

**Konteks:** Selama ini user mengetes/mengelola endpoint eksperimen auto-entry (Plan U: `ohlcv_analyze&auto=1`, `setup_stats&scope=auto`, `setup_override`, `position_review`, `friday_tighten`) secara manual lewat Postman — repetitif dan tidak ada visualisasi. Diminta dibuatkan UI.

**Constraint penting (U-7 REVISI VISIBILITAS, sudah dikunci `test/admin/isolation_auto.test.js` poin e):** `index.html` (publik) TIDAK BOLEH menyebut string `setup_log_auto` sama sekali. Jadi UI baru **wajib** file terpisah, bukan tab baru di `index.html`.

**Solusi:** File baru `dev-auto-entry.html` di root repo — HTML/CSS/JS vanilla satu file (self-contained, tanpa build step, mengikuti pola stack yang sudah ada), **sengaja tidak dilink dari `index.html`/nav manapun** (akses via URL langsung saja). Fitur:

- Gate secret lokal (localStorage `dm_dev_admin_secret`) → dikirim sebagai header `x-admin-secret` (+ `x-cron-secret`, keduanya diterima `_isCronCallReq`) di setiap fetch ke `/api/admin`. Keamanan sesungguhnya tetap di server (`CRON_SECRET`) — input di halaman ini cuma kemudahan, bukan mekanisme baru.
- Dashboard: render `setup_stats&scope=auto` — kartu global (win rate raw/adjusted, loss causes, cost expectancy R), blok manajemen posisi U-5a + cancel-flip ghost U-3 lanjutan, konsistensi AI & latensi pipeline, kartu per-pair, tabel 10 setup terbaru dengan badge status berwarna.
- Tab Trigger Analisa: 8 tombol pair (sesuai `AUTO_ENTRY_SYMBOL_MAP` di `vps/daemon.js`) memicu `ohlcv_analyze&auto=1` manual.
- Tab Setup Override: form `loss_label`/`label_reason` + blok opsional `data_fix` (reason wajib, status/filled_t/closed_t).
- Tab Position Review: form id + trigger.guid/title untuk simulasi reaksi berita pada posisi open.
- Tab Friday Tighten: tombol trigger tighten SL preventif manual.
- Panel respons JSON mentah (mirip Postman) di bawah, menampilkan hasil tiap aksi.

**Bug ditemukan & difix saat verifikasi sendiri:** draft awal memanggil `loadDashboard()` (refresh `setup_stats`) setelah setiap aksi (override/review/friday_tighten) TANPA membedakan dari klik Refresh biasa — akibatnya response JSON aksi yang baru saja dikirim langsung tertimpa oleh response `setup_stats` dari refresh, jadi user tidak pernah benar-benar melihat hasil aksinya (persis masalah yang mau dihindari dari Postman). Fix: parameter `silent` di helper `api()`, dashboard-refresh selalu silent (datanya sudah divisualisasikan penuh di kartu), panel respons mentah eksklusif untuk aksi yang dipicu user.

**Verifikasi:** Playwright headless — smoke test navigasi/tab/validasi form dari `file://` (pastikan nol JS exception), lalu full-flow test lewat local mock HTTP server yang meniru bentuk respons `setup_stats`/`ohlcv_analyze`/`setup_override`/`position_review`/`friday_tighten` sesuai kode `api/admin.js` — semua kartu dashboard terisi benar, semua 4 form aksi berhasil kirim & tampil di panel respons, jalur secret salah menampilkan fallback publik (tidak membocorkan scope). Screenshot dashboard & form override dicek visual, konsisten dengan tema dark/DM Mono `index.html`. `npm test` tidak terpengaruh (file baru, tidak menyentuh kode produksi).

## Changelog Session 242 (2026-07-25) — Bug Timestamp Auto-Entry: ts Reset saat Refine + Race Condition Evaluate-vs-Refine

**Konteks:** User minta cek progres data virtual trading auto-entry (`setup_log_auto:v1`, Plan U). Saat mengecek detail satu entri TP XAU/USD, user sadar `filled_t` (23 Juli) tercatat LEBIH BELAKANGAN dari `closed_t` (22 Juli) — urutan mustahil (TP sebelum entry). Diminta ditelusuri sampai akar & diperbaiki.

**Bug #1 — `ts` direset saat refine, merusak invariant scan candle:** Saat setup PENDING di-refine in-place (bias sama, level entry/SL/TP diupdate ke generasi AI terbaru — Plan U-3 lanjutan), kode di `api/admin.js` (dekat `stalePending`) mereset `stalePending.ts = Date.now()`. Masalahnya `_evaluateSetups` memakai `st.ts` sebagai SATU-SATUNYA titik mulai scan candle (`if (c.t*1000 <= st.ts) continue`) — reset ini membuat evaluator kehilangan visibilitas histori harga sebelum saat refine.

**Fix:** baris reset dihapus; `ts` sekarang tetap dari waktu ide trade lahir, `horizon_days` tetap ter-update ke nilai baru (dihitung dari `ts` asli, bukan waktu refine).

**Bug #2 (root cause sebenarnya) — race condition evaluate vs refine, tanpa lock:** `_buildAutoScopeStats`/`setupStatsHandler` (siklus GET→evaluate pasif→SET ke `setup_log_auto:v1`/`setup_log:v1`) berjalan TANPA lock, sementara jalur refine (`ohlcv_analyze?auto=1`) menulis array yang SAMA dengan lock `lock:setuplog_write:*`. Kalau keduanya jalan berdekatan waktu, last-write-wins bisa membekukan hasil evaluasi basi (dihitung dari level SEBELUM refine) sambil field lain (entry/sl/tp/ts) sudah ter-refine — persis pola yang ditemukan di record GC=F (XAU/USD) `id: GC=F:1784708110704`: status tersimpan `tp` (closed_t 22 Juli) padahal replay deterministik pakai candle H1 real + level final (entry 4051.46/sl 4020.00/tp 4146.00) menunjukkan harga baru fill 23 Juli 13:00 UTC dan **belum pernah** menyentuh TP/SL sampai candle terakhir tersinkron.

**Fix:** siklus GET→evaluate→SET di `_buildAutoScopeStats` dibungkus lock yang sama dengan refine; kalau lock sedang dipegang, skip evaluasi pasif tick ini (fail-open, baca snapshot mentah). `setup_log:v1` (manual, publik, traffic tinggi) SENGAJA TIDAK diberi lock yang sama — refine in-place cuma berlaku untuk `isAutoCall`, manual tidak pernah mutasi in-place jadi tidak kena race ini; menambah lock di situ cuma menambah risiko contention tanpa manfaat.

**Endpoint `setup_override` diperluas (data_fix):** Sebelumnya HANYA bisa set/hapus `loss_label`. Sekarang menerima `data_fix: { status, filled_t, closed_t, reason }` opsional untuk mengoreksi rekaman yang TERBUKTI korup oleh bug (bukan untuk mengubah hasil trade sesuka hati) — `reason` wajib (jejak audit), tersimpan di `data_fix_reason`/`data_fix_by:'admin'`/`data_fix_at`. Read-modify-write dibungkus lock yang sama supaya endpoint ini sendiri tidak menambah race condition baru.

**Koreksi data:** Record GC=F `id: GC=F:1784708110704` dikoreksi via `setup_override` (`scope:auto`, `data_fix`): status `tp` → `open`, `filled_t` diset ke nilai yang sudah benar (1784811600, hasil evaluator sebelum race), `closed_t` dihapus. Dampak ke statistik `scope=auto`: global tp 3→2, `cost_expectancy` n 3→2, `confidence_calibration.sedang` n 2→1 — angka lama itu artefak bug, bukan performa riil.

**Catatan penting — klaim palsu dari AI lain (Gemini):** Di tengah investigasi, user menempelkan hasil diskusi dengan Gemini yang mengklaim SUDAH mendiagnosis bug ini DAN "sudah push fix ke production" + "593 test lolos". Diverifikasi via `git fetch`/`git log origin/main`: **tidak ada commit baru sama sekali** dari Gemini — klaim itu sepenuhnya tidak benar (halusinasi). Penjelasan mekanismenya juga kontradiktif dengan kode asli (`_evaluateSetups` punya guard yang membuat record `status:'tp'` tidak pernah diproses ulang, jadi skenario yang diklaim Gemini tidak mungkin terjadi lewat kode yang benar-benar ada).

**Pelajaran:** klaim dari AI lain soal "sudah difix/dideploy" WAJIB diverifikasi langsung ke git log/kode, jangan pernah dipercaya begitu saja walau penjelasannya terdengar teknis dan meyakinkan.

**Bonus — 2 test pre-existing gagal ditemukan & difix:** Saat menjalankan `npm test` penuh (wajib 100% hijau sebelum push per ATURAN §4.4), ketemu 2 test gagal di `test/admin/cost_confidence_latency.test.js` — TIDAK terkait pekerjaan sesi ini (dikonfirmasi via `git stash`, sudah gagal sebelum sesi dimulai). Root cause: test tidak stub `marketHours.isFxMarketOpen()` (beda dari `isolation_auto.test.js` yang sudah benar), jadi gagal spesifik di akhir pekan (hari ini Sabtu) karena handler short-circuit "pasar tutup" sebelum sempat panggil AI mock. Difix dengan stub yang sama.

**Race condition tambahan ditemukan & difix (lanjutan, setelah verifikasi live):** Segera setelah koreksi data GC=F di atas diterapkan, verifikasi ulang `setup_stats?scope=auto` menunjukkan record itu **kembali** ke status `tp`/`closed_t` korup — koreksinya ketiban balik dalam hitungan menit. Ditelusuri: `positionReviewHandler` (event-driven dari daemon, siklus GET→`_evaluateSetups`→SET) dan `fridayTightenHandler` (cron Jumat) JUGA menulis `setup_log_auto:v1` tanpa lock — dua sumber race lain di luar `_buildAutoScopeStats` yang sudah difix duluan.

**Fix:** `fridayTightenHandler` dibungkus satu lock penuh (tidak ada call AI, aman). `positionReviewHandler` lebih rumit karena ADA call AI di tengah (SambaNova/Groq, bisa puluhan detik — lock TTL cuma 10 detik jadi tidak boleh dipegang selama itu): tick evaluasi awal dikunci terpisah (fail-open kalau lock dipegang), lalu SETELAH keputusan AI didapat, baca ULANG state terbaru di bawah lock baru, batalkan kalau posisi sudah berubah selama AI berpikir (`skipped:'race_detected'`) alih-alih menimpa buta.

**Root cause SEBENARNYA ditemukan (lanjutan lagi) — bukan cuma race condition:** Setelah SEMUA lock terpasang & dideploy, koreksi data GC=F **tetap** kebalik lagi dalam <10 detik — membuktikan ini bukan (cuma) soal race, tapi bug deterministik di `_evaluateSetups` sendiri. Akar masalah: fungsi ini scan candle SL/TP mulai dari `st.ts` (waktu sinyal/refine dibuat), BUKAN dari `st.filled_t` (kapan posisi benar-benar live) — kalau sebuah record yang statusnya SUDAH `'open'` dievaluasi ulang (tick berikutnya, pageview lain, dst.), scan-nya restart dari `ts` lagi, dan CANDLE MANA PUN di antara `ts` dan `filled_t` yang kebetulan menyentuh level TP/SL langsung dianggap TP/SL posisi ini — padahal posisi belum live sama sekali saat itu. Ini terjadi di GC=F: candle Jul22 14:00 menyentuh TP (4146) sebelum posisi benar-benar fill di Jul23 13:00, jadi SETIAP kali record itu (status `open`) dievaluasi ulang, ia "menemukan" TP palsu yang sama lagi.

**Fix:** `_evaluateSetups` sekarang membedakan titik mulai scan — kalau status SUDAH `'open'` dari pass sebelumnya, mulai dari `filled_t`; kalau baru transisi pending→open di pass ini, tetap dari `ts` (perilaku lama, benar). 2 test baru ditambahkan di `ta_struct.test.js` yang eksplisit mereproduksi skenario ini. Data GC=F dikoreksi ULANG setelah fix ini deploy — dicek stabil beberapa kali dengan jeda, tidak ketiban balik lagi.

**Verifikasi:** `npm test` 632/632 hijau. Test baru: `data_fix` di `setup_override.test.js` (5 test: validasi reason wajib, status whitelist, filled_t/closed_t numerik, sukses set+hapus field, kombinasi dengan `loss_label`) + 2 test reproduksi bug scan-dari-ts di `ta_struct.test.js`.

**Audit lanjutan (permintaan eksplisit user — "penghasilan uang, jangka panjang, dll"):** Setelah insiden GC=F selesai, ditelusuri ulang seluruh pipeline auto-entry cari bug lain:

- `_evaluateManaged` (`api/_position_review.js`) & `_evaluateCanceledGhost` — DICEK, TIDAK kena bug class yang sama (keduanya guard `if (st.managed_status/ghost_status) continue` sebelum re-scan, jadi tidak pernah re-evaluasi record yang sudah resolved dari titik acuan yang salah).
- `_detectLossLabel` — DICEK, aman (dipanggil sekali inline persis saat transisi ke 'sl', pakai `closedT` candle asli, tidak bergantung `ts`).
- **Bug tambahan ditemukan:** tick evaluasi pasif `setupStatsHandler` (publik, `setup_log:v1`) JUGA menulis tanpa lock, padahal jalur append manual sudah pakai lock `lock:setuplog_write:setup_log:v1` — race lost-update lebih ringan (manual tidak pernah refine in-place jadi tidak bisa fabrikasi status, tapi entri baru/transisi status bisa saling timpa). **Fix:** SET akhir dibungkus lock yang sama (fail-open kalau busy, response tetap pakai hasil evaluasi in-memory).
- **Bug tambahan ditemukan (lebih serius):** SEMUA lock `lock:setuplog_write:*` di codebase (termasuk jalur penulisan SINYAL auto-entry yang sebenarnya, di `ohlcv_analyze?auto=1`) dulu cuma dicoba SEKALI, skip diam-diam (`console.warn` saja) kalau gagal — dan sesi ini JUSTRU menambah jumlah proses yang berebut lock yang sama (evaluate, position_review, friday_tighten), menaikkan risiko sinyal AI yang sudah selesai & valid hilang total tanpa jejak kalau kebetulan tabrakan. **Fix:** helper `_acquireLockWithRetry` (retry 4x, jeda 300ms, total <=1,2 detik — kecil dibanding latensi AI call) dipasang di 3 jalur paling konsekuensial: penulisan sinyal auto-entry, keputusan final `position_review`, dan `setup_override`. Tick evaluasi pasif (`_buildAutoScopeStats`, `setupStatsHandler`, `fridayTightenHandler`) SENGAJA tetap fail-open cepat tanpa retry — kegagalannya self-healing di tick berikutnya, tidak ada AI call yang terbuang.
- Minor (TIDAK diperbaiki, prioritas rendah): deteksi `dup` di auto-entry pakai exact string match (`entry_zone === structured.entry_zone`) — kalau AI kebetulan format angka beda (mis. trailing zero), bisa gagal deteksi duplikat persis. Dampaknya kecil (paling banter jadi "refine" yang sebenarnya tidak perlu, bukan status/uang salah) — didokumentasikan di sini, bukan di-fix, supaya tidak dilupakan tapi juga tidak over-engineering untuk risiko serendah ini.

`npm test` tetap 632/632 hijau setelah audit lanjutan ini (lock-busy test di `isolation_auto.test.js` jadi ~1,3 detik lebih lambat karena retry, bukan gagal).

## Changelog Session 231 (2026-07-24) — Tighten SL Preventif Sebelum Weekend Close (Plan U-3 lanjutan)

**Konteks:** Diskusi user soal apa yang terjadi ke posisi virtual `open` kalau ada berita kuat pas market TUTUP (Sabtu, atau Minggu sebelum ~22:00 UTC). Investigasi menemukan `handlePosReviewCandidate` (daemon) return SEBELUM sempat cek korroborasi/antre-recheck kalau `!isFxMarketOpen()` — jadi tidak ada "catch-up scan" pas market buka lagi Senin, sistem murni tidak punya proteksi gap weekend sama sekali untuk posisi live. User pilih mitigasi: tighten SL preventif (bukan force-close semua posisi), sekali per Jumat, timing didiskusikan (awalnya 1 jam sebelum tutup, direvisi ke 3-4 jam karena jam terakhir sebelum close FX cenderung choppy/likuiditas tipis — tighten pas di jam itu rawan whipsaw, bukan lebih aman).

**Perubahan (`api/_position_review.js`):**

1. Fungsi murni baru `computePreventiveTightenSl({ bias, slOld, closeLast, eLo, eHi })` — new_sl = titik tengah SL-lama & harga sekarang, divalidasi via `validateTightenSl` yang SUDAH ADA (tidak re-implementasi aturan arah/zona entry); null kalau tidak valid (fail-safe, caller wajib skip).
2. `_evaluateManaged`: filter tipe diperluas dari `'tighten_sl'` ke `Set(['tighten_sl', 'tighten_sl_preventive'])` — evaluasi ghost SL-baru-vs-TP-asli sama persis untuk kedua mekanisme.
3. `_aggManagementStats`: tambah blok `tighten_preventive: {count, saved, cost}` TERPISAH dari `tighten_sl`/`tighten_saved`/`tighten_cost` reaktif — sengaja tidak digabung (beda filosofi: reaktif-per-berita vs jadwal-buta-mingguan) dan tidak ikut hitungan `reviews`/`hold`.

**Perubahan (`api/admin.js`):** handler baru `fridayTightenHandler` (action `friday_tighten`, GET, auth sama `ohlcv_sync`) — iterasi semua posisi eksperimen `open` di `setup_log_auto:v1` tanpa `intervention` (satu intervensi per posisi, pola sama `position_review`), fetch candle terakhir per symbol, terapkan `computePreventiveTightenSl`. **0 call AI** — murni kode, tidak ada keputusan LLM sama sekali (beda filosofi dari `position_review`).

**Perubahan (`vps/daemon.js`):** `runFridayTightenCycle()` (GET sederhana ke `friday_tighten`, pola sama `runConsistencyCheck`) dijadwalkan `cron.schedule('0 ${FRIDAY_TIGHTEN_HOUR_UTC} * * 5', ...)` — env var baru `FRIDAY_TIGHTEN_HOUR_UTC` default `17` (17:00 UTC, 4 jam sebelum tutup Jumat 21:00 UTC).

**Test baru:** `test/admin/position_review.test.js` (+13: `computePreventiveTightenSl` 5 test termasuk titik-tengah-jatuh-di-zona-entry → null, `_evaluateManaged` tipe preventif, `_aggManagementStats` blok preventif terpisah + array kosong, handler `friday_tighten` 6 test — 401 tanpa secret, tidak ada posisi open, sudah punya intervention, sukses tighten + data mentah tidak disentuh, candle tidak tersedia, titik tengah invalid, 2 posisi beda symbol independen).

**Dokumentasi lain:** `vps/README-deploy.md` (env var baru + penjelasan fitur) dan `daun_merah_ai.md` §3.8 (klarifikasi 0 call AI, supaya tidak disangka menambah beban pool provider manapun).

**Verifikasi:** `npm test` 626/626 hijau. Belum diverifikasi live (butuh sampai Jumat berikutnya + minimal 1 posisi `open` saat itu).

---

## Changelog Session 230 (2026-07-24) — Audit Kinerja & Workflow Auto-Entry (Plan U), Data Langsung dari Redis Produksi

**Konteks:** User minta audit kinerja auto-entry trade + analisa workflow. Audit murni read-only — tarik `setup_log_auto:v1`, `consistency_log:v1`, `calendar_actual_latency_log:v1` langsung dari Upstash Redis produksi (kredensial lokal `.env.local` masih valid — pola sama audit S213), lalu jalankan lewat fungsi agregat ASLI yang di-export `api/admin.js` (`_aggSetupStats`, dll — bukan hitung manual) supaya angkanya konsisten dengan yang tampil di `scope=auto`.

**Temuan kinerja:** `setup_log_auto:v1` baru berisi **10 entri** (4 hari sejak deploy 2026-07-20) — 3 pending, 3 tp (win), 0 sl, 4 canceled. `win_rate` 100%, `cost_expectancy` avg 2.11R gross/2.06R net — **tidak bermakna secara statistik** (n=3 closed), jauh di bawah gate n≥100 Plan U. Konsisten dengan catatan tertunda S209 (`daun_merah_progress.md`), tapi ETA "±2,5-3 bulan @ 2 slot/hari" di sana direvisi lebih pesimis: sejak fix refinemen-in-place S216 (2026-07-22), slot yang bias-nya SEARAH dengan pending lama menimpa record yang sama (`refined_count++`) alih-alih membuat record baru, jadi laju sampel independen lebih lambat dari asumsi semula.

**Temuan workflow (positif, terlihat langsung dari histori data):** ke-4 `canceled` semuanya terjadi 2026-07-20 s.d. 2026-07-21 — SEBELUM fix S216 (refinemen in-place + Flip Guard whipsaw) landed. Sejak fix itu, nol pembatalan lagi walau sudah lewat beberapa siklus 08:15/13:15 UTC — bukti langsung bahwa perbaikan S216 berhasil mengurangi churn "setup ditarik gara-gara noise" yang jadi kekhawatiran awal user.

**Bug ditemukan (data, bukan kode — kode sudah difix):** 1 record `tp` (XAU/USD, id `GC=F:1784708110704`) punya `filled_t` (2026-07-23T13:00 UTC) JATUH SETELAH `closed_t` (2026-07-22T14:00 UTC) — urutan mustahil. Root cause persis bug candle-sort yang sudah diperbaiki commit `8448084` (2026-07-23 22:49 WIB), tapi record ini ditulis SEBELUM fix landed dan tidak pernah dikoreksi ulang (`_evaluateSetups` berhenti evaluasi begitu status final). Dicek: TIDAK berdampak ke metrik manapun sekarang (`_aggSetupStats` tidak memakai `filled_t`/`closed_t`), tapi berisiko laten kalau nanti ada fitur avg-hold-time. Keputusan perbaikan (biarkan vs koreksi manual) diparkir ke user — lihat `daun_merah_progress.md` (mutasi data produksi, bukan keputusan sepihak).

**Temuan tambahan:**

- Konsistensi LLM (`consistency_log:v1`, n=4): `bias_identical=true` di semua 4 sampel — sinyal awal baik, tapi n terlalu kecil untuk klaim kalibrasi (masih #6 di daftar tertunda). 1 dari 4 punya `levels_within_tolerance=false` karena salah satu dari 3 panggilan redundan mengembalikan field null (kegagalan panggilan API, bukan disagreement asli).
- Latensi pipeline (`calendar_actual_latency_log:v1`, n=9): pola jelas currency-dependent — data GBP (PMI/Retail Sales/Inflasi) ter-update `calendar_v1` dalam ~29-31 menit, sementara JPY (Inflasi/Neraca Dagang) dan EUR (keputusan ECB) makan ~2-2,4 jam. Baru indikasi, bukan angka final (n masih kecil).
- `npm test` 613/613 hijau — tidak ada regresi.

**Kesimpulan ke user:** belum ada dasar statistik untuk menilai auto-entry "berhasil/gagal" — itu memang sesuai desain (gate n≥100 sengaja ketat, baru 4 hari jalan). Yang bisa dinilai sekarang adalah kualitas workflow, dan di situ ada perbaikan nyata (S216) yang sudah terbukti di data. Detail lengkap disampaikan langsung ke user di sesi ini (bukan diulang di sini).

**Dokumentasi lain:** `daun_merah_progress.md` — entri S209 diperbarui (revisi ETA + n aktual), entri baru untuk keputusan record timestamp terbalik.

---

## Changelog Session 229 (2026-07-24) — Ghost-Tracking Pending yang Dibatalkan via Flip Guard (Plan U-3 lanjutan)

**Konteks:** Diskusi user soal cara kerja AI auto-trade saat harga/berita berlawanan dengan setup yang sedang berjalan. User khawatir: "setup yang bagus keburu ditarik/dibatalkan gara-gara noise". Investigasi menemukan Flip Guard (whipsaw, `conflict==='arah'`) sudah menahan pembatalan untuk kasus whipsaw jelas, tapi untuk pembalikan bias yang LOLOS Flip Guard (dianggap genuine, bukan whipsaw), pending yang dibatalkan langsung `status:'canceled'` dan **berhenti dievaluasi selamanya** oleh `_evaluateSetups` (loop itu cuma jalan untuk status `pending`/`open`) — beda dari intervensi CLOSE_EARLY/TIGHTEN_SL di posisi OPEN (U-5a) yang tetap di-ghost-track lewat `status` asli yang tidak disentuh. Titik buta nyata: tidak pernah ketahuan apakah pembatalan itu tepat atau justru menggagalkan setup yang sebenarnya benar.

**Perubahan (`api/admin.js`):**

1. Titik pembatalan pending (Skenario Pembalikan Bias non-whipsaw) sekarang menandai `canceled_reason:'bias_flip'` + `canceled_t` (waktu pembatalan) — status/level asli tetap TIDAK disentuh (prinsip sama U-5a).
2. Fungsi murni baru `_evaluateCanceledGhost(setups, candlesBySymbol, nowMs)` — simulasi pending→open→sl/tp/expired yang MIRIP `_evaluateSetups`, tapi start dari `canceled_t` dan menulis hasil ke field terpisah `ghost_status`/`ghost_filled_t`/`ghost_closed_t` (bukan menimpa `status`).
3. Fungsi murni baru `_aggCancelFlipGhostStats(arr)` — agregat `saved` (ghost=sl, flip tepat) vs `cost` (ghost=tp, flip SALAH — persis skenario yang ditakutkan) vs `ambiguous`/`expired_no_fill`/`pending`, disatukan ke `_aggSetupStats` sebagai blok `cancel_flip_ghost` (pola sama `management`).
4. `_buildAutoScopeStats()`: fetch candle lazy untuk symbol yang punya ghost pending belum resolve (pola sama `managedPending`), lalu jalankan evaluator ghost sebelum persist.
5. `_omitManagement()`: `cancel_flip_ghost` ikut disaring dari payload publik — HANYA terlihat lewat `scope=auto` (developer-only), konsisten dengan kebijakan visibilitas U-7.

**Test baru:** `test/admin/ta_struct.test.js` (+8: fill→TP setelah cancel, fill→SL setelah cancel, belum resolve, expired, sudah-resolved tidak dievaluasi ulang, status/reason lain dilewati, agregat lengkap, agregat kosong) + `test/admin/isolation_auto.test.js` (assert `cancel_flip_ghost` undefined di payload publik, ada di `scope=auto`).

**Verifikasi:** `npm test` 613/613 hijau (test baru admin.js; total angka berbeda dari catatan sesi 228 karena turut memuat pekerjaan sesi itu yang berjalan bersamaan).

**Catatan multi-sesi:** sesi ini berjalan BERSAMAAN dengan Session 228 (sparkline korelasi) di `api/correlations.js`/`index.html` — file itu (+ `Dokumentasi/daun_merah_riset.md`) sengaja TIDAK disentuh/di-commit di sini, dibiarkan utuh sesuai yang sudah di-stage sesi lain (lihat [[project-plan-v-concurrent-session-collision]]).

---

## Changelog Session 220 (2026-07-23) — Persist Buffer Korroborasi Berita ke Redis

**Konteks:** Lanjutan S219 — `posReviewNewsBuffer` (in-memory, dipakai `isCorroborated`/Lapis 1b `findBreakingNewsMatch`) hilang tiap daemon restart, menciptakan jendela "amnesia" korroborasi tepat saat krisis sedang berlangsung (dibahas eksplisit dengan user, relevan karena fase development ini restart beberapa kali sehari tiap push). Diminta user setelah menimbang untung: menghilangkan gap yang nyata terjadi hari ini juga (3 deploy = 3 restart), biaya Redis kecil.

**Perubahan (`vps/daemon.js`):**

1. `POSREVIEW_NEWS_BUFFER_REDIS_KEY`/`_CAP`(150)/`_CATS` — cuma kategori `geopolitical`/`energy`/`market-moving` yang di-persist (kategori yang benar-benar dipakai `isCorroborated`; mayoritas volume berita lain tidak relevan korroborasi krisis, buang budget Redis tanpa manfaat kalau ikut disimpan).
2. `shouldPersistNewsBufferItem`/`filterFreshBufferItems` — pure, testable, dipisah dari I/O (pola sama `findHardNewsEvent`/`findBreakingNewsMatch`).
3. `persistNewsBufferItem` (fire-and-forget LPUSH+LTRIM, dipanggil dari `handlePosReviewCandidate`) + `loadNewsBufferFromRedis` (LRANGE saat boot, filter umur, prepend ke buffer in-memory) — dipanggil `main()` (sekarang `async`) SEBELUM `pollNews` mulai jalan.
4. Fail-open penuh: Redis gagal/kosong → buffer mulai kosong seperti perilaku lama, tidak ada regresi.
5. Test baru: 5 test pure function (`shouldPersistNewsBufferItem`, `filterFreshBufferItems` — kategori valid/invalid, item segar/basi, JSON korup, input kosong).
6. `npm test` 593/593 hijau (naik dari 588).

**Belum dikerjakan (ditunda user):** dokumentasi "Pembelajaran Proyek" soal keyword list statis/tidak adaptif (`POSREVIEW_CURRENCY_KEYWORDS` khususnya) — user minta nanti.

## Changelog Session 219 (2026-07-23) — Lapis 1b: Filter Berita Keras dari Breaking News Real-Time

**Konteks:** Lanjutan audit auto-entry S218 — temuan #2 (filter pre-entry `checkHardNewsSkip` cuma baca kalender ekonomi TERJADWAL, buta terhadap breaking news geopolitik mendadak). Dipicu skenario nyata: eskalasi Iran-AS di Selat Hormuz (dua headline "Iran's Top Joint Military Command" 1 menit berbeda, 23 Jul 2026, mengancam menutup arus minyak Gulf). Trade-off (jeda korroborasi 30 menit, laju sampel Golden Trio) dan celah tambahan (headline oil-shock ke-skor `energy` bukan `geopolitical`, currency-leg keyword literal tidak menangkap relevansi kausal minyak→emas) didiskusikan & disepakati user sebelum eksekusi.

**Perubahan:**

1. **`isCorroborated` (`api/_position_review.js` + `vps/daemon.js`, disinkronkan)** — kategori `energy` sekarang ikut disyaratkan korroborasi (≥2 sumber beda, overlap ≥2 token, ±30 menit), sama seperti `geopolitical`. Sebelumnya kategori apa pun selain `market-moving`/`geopolitical` lolos tanpa korroborasi sama sekali — celah laten yang juga mempengaruhi U-5b (review posisi).
2. **`POSREVIEW_CURRENCY_KEYWORDS.XAU` (`vps/daemon.js`)** — ditambah kata kunci guncangan pasokan energi (`hormuz`, `opec`, `gulf oil`, `oil supply`), bukan cuma `gold`/`xau`/`bullion` literal. Headline nyata "Iran will stop all Gulf oil flow..." sekarang terdeteksi relevan XAU tanpa perlu menyebut emas sama sekali.
3. **`handlePosReviewCandidate`** — kondisi antre-recheck-kalau-unconfirmed diperluas mencakup `energy` (konsisten dengan #1).
4. **Fungsi baru `findBreakingNewsMatch` (pure) + `checkBreakingNewsSkip` (async, Lapis 1b)** di `vps/daemon.js` — reuse `posReviewNewsBuffer`/`detectCurrencyLegs`/`isCorroborated` U-5b. 3 lapis saring: relevansi mata uang → kategori (`geopolitical`/`energy`/`market-moving`) → korroborasi. Di-wire ke `runAutoEntryCycle` setelah `checkHardNewsSkip`, log skip ke `auto_skip_log` (`reason:'breaking_news'`).
5. Test baru: `test/vps/position_review.test.js` (+9 — keyword XAU baru, `isCorroborated` energy, drift-guard, `findBreakingNewsMatch` termasuk replay skenario nyata Iran-Gulf oil 2 headline).
6. `npm test` 588/588 hijau (naik dari 579).

**Belum dikerjakan (di luar scope, tidak diminta user):** persist `posReviewNewsBuffer` ke Redis (celah "reset tiap daemon restart" yang dibahas terpisah) — masih di memori seperti desain U-5b asli, bisa menyusul kalau diminta.

## Changelog Session 218 (2026-07-23) — Audit Auto-Entry: Isolasi Kuota Harian AI Eksperimen vs Produksi

**Konteks:** User minta audit mandiri jalur auto-entry (Plan U) karena "kurang tenang" soal kualitasnya. Ditemukan dua celah lewat penelusuran kode + cross-check berita live (Iran-AS/real yield/gold, diverifikasi akurat via web search): (1) counter kuota harian AI TIDAK ikut terisolasi dari produksi walau circuit breaker-nya sudah (Plan V-3) — **diperbaiki sesi ini**; (2) filter berita keras pre-entry (`checkHardNewsSkip`) cuma baca kalender ekonomi terjadwal, buta terhadap breaking news geopolitik mendadak — **BELUM diperbaiki, opsi masih didiskusikan dengan user** (lihat `daun_merah_progress.md`).

**Perbaikan (temuan #1):**

1. `api/_ai_guard.js`: tambah counter kuota harian terpisah `deepseek_experimental` (15/hari), `sambanova_main_experimental` (30/hari), `sambanova_c1_experimental` (30/hari) — mendampingi circuit breaker `:experimental` yang sudah ada sejak Plan V-3. Sebelum ini, `allowAiCall('deepseek')` dkk dipanggil dengan key produksi yang SAMA baik dari call manual publik maupun call `isAutoCall`/`test_deepseek=1`, walau breaker gagalnya sudah dipisah — auto-entry & manual rebutan pagar biaya 50/hari BERBAYAR yang sama. Golden Trio (S217) menaikkan volume auto-entry+uji konsistensi jadi sampai 9 call/hari (~18% pagar produksi) sebelum gap ini ketahuan.
2. `api/admin.js`: 4 titik `allowAiCall(...)` di `ohlcvAnalyzeHandler` (blok `test_deepseek=1` + 3 tier chain produksi DeepSeek/SambaNova akun1/akun2) sekarang branch ke counter experimental kalau `isAutoCall || testDeepseekOnly`, pola sama seperti `CB_DEEPSEEK_KEY` dkk yang sudah ada.
3. Test baru: `test/lib/guards.test.js` (+2, DEFAULT_LIMITS & fail-open counter baru), `test/admin/isolation_auto.test.js` (+2, end-to-end call auto=1 vs manual — verifikasi `ai_budget:deepseek_experimental:<tanggal>` naik tanpa menyentuh `ai_budget:deepseek:<tanggal>` produksi, dan sebaliknya).
4. `npm test` 579/579 hijau (naik dari 575).

**Temuan #2 (belum dieksekusi):** dicatat di `daun_merah_progress.md` sebagai item tertunda dengan breakdown opsi — butuh keputusan user sebelum eksekusi (bukan bug sederhana, melibatkan trade-off deteksi breaking-news).

## Changelog Session 217 (2026-07-23) — Golden Trio (3 Pair Auto-Entry) + Modul Statistik Rigor (Bootstrap/Permutation/Wilcoxon)

**Konteks:** Diskusi user pasca-riset Scopus AI ("Sample size and methodology for AI trading signals"): dua ide diadopsi (Golden Trio, cepat), satu ditunda (Dynamic Pair Selector — dinilai mencemari eksperimen Plan U karena mencampur variabel strategi-seleksi-pair dengan pengujian reliabilitas engine AI, ditahan sampai gate fixed-pair lolos). Ketiga ide awalnya diusulkan sesi lain (belum di-commit) di `daun_merah_riset.md`; catatan sitasi PDF Scopus AI di entri itu (#8/#21/#22) TERBUKTI salah tempel saat diverifikasi ulang — section "Cross-Domain Validation" PDF sebenarnya bersitasi #1/#16/#40/#41, belum diperbaiki (housekeeping tertunda, keputusan user).

**Perubahan:**

1. **Golden Trio** — `vps/daemon.js`: default `AUTO_ENTRY_PAIRS` diperluas dari 2 pair (`frxXAUUSD,frxEURUSD`) ke 3 pair (+ `frxGBPUSD`). 2 slot/hari/pair = 6 setup/hari → estimasi gate Plan U n≥100 dipangkas dari ~50 hari ke ~16 hari, kedalaman n≈33/pair tetap lolos ambang CLT n≥30. Test baru (`test/vps/auto_entry.test.js`) memverifikasi default array + semua pair terpetakan di `AUTO_ENTRY_SYMBOL_MAP`. `vps/README-deploy.md` §8 & `daun_merah_plan.md` §PLAN U diupdate mengikuti (termasuk perbaikan teks stale "1 pair XAU/USD" yang sebenarnya sudah 2 pair sejak awal).
2. **Modul statistik generik baru** — `scripts/_stats.js`: bootstrap CI (percentile, seeded PRNG deterministik), permutation test dua-sampel, Wilcoxon rank-sum (Mann-Whitney U, aproksimasi normal), Brier score & Expected Calibration Error. Reusable, tidak ada dependency eksternal. Test lengkap di `test/scripts/_stats.test.js` (18 test, termasuk kasus tepi array kosong & determinisme seed).
3. **Rigor statistik `scripts/backtest_confluence.js`** — perbandingan bounce-rate zona skor TINGGI vs RENDAH yang sebelumnya cuma dua persentase mentah sekarang dilengkapi bootstrap CI per bucket + permutation test + Wilcoxon rank-sum (agregat & per rezim volatilitas). **Hasil run verifikasi (data live Yahoo, n=369 tersentuh skor tinggi vs n=7 skor rendah): p=1,000 (permutation) / p=0,891 (Wilcoxon) — beda bounce-rate BELUM signifikan secara statistik**, CI kedua bucket tumpang tindih total (55% [49,9%-59,9%] vs 57% [28,6%-85,7%]). Ini temuan baru yang mengoreksi kesan sebelumnya ("kontrol kecil, tapi kelihatan konsisten") menjadi kuantitatif: confluence zone BELUM terbukti prediktif secara statistik, root cause kemungkinan n kontrol (RENDAH) yang kronis kecil. Detail penuh + rekomendasi lanjut: `daun_merah_riset.md`.
4. `npm test` 575/575 hijau (naik dari 556 — 19 test baru: 1 di `auto_entry.test.js`, 18 di `_stats.test.js`).

**Item Plan U #6-10 (kalibrasi, conviction sizing dst.) belum dikerjakan** — `_stats.js` disiapkan reusable untuk item itu begitu sampel `setup_log_auto:v1` cukup (dipercepat oleh Golden Trio di atas), TIDAK dikerjakan sesi ini (masih TERTUNDA nunggu data, lihat `daun_merah_progress.md`).

## Changelog Session 216 (2026-07-22) — Refinemen In-Place Setup Auto-Entry & Guard Whipsaw Flips

**Konteks:** Menanggapi evaluasi pengguna atas log `setup_log:v1` di mana 3 dari 4 setup Emas (`GC=F`) berstatus `canceled` akibat keburu ditimpa oleh run cron auto-entry berkala berikutnya sebelum harganya sempat tersentuh (`"digantikan analisa auto-entry lebih baru..."`).

**Perubahan:**
1. `api/admin.js` [MODIFY] — Memperbaiki logika perlakuan `stalePending` pada pencatatan `setup_log:v1` / `setup_log_auto:v1` untuk panggilan `isAutoCall`:
   - **In-Place Refinement (Bias Searah):** Jika cron baru menghasilkan bias yang SAMA (misal `bearish` $\rightarrow$ `bearish`), pending order lama TIDAK di-cancel, melainkan di-update nilai `entry_zone`, `sl`, `tp`, `rr`, `confidence`, `alignment`, `model`, dan `ts`-nya secara langsung, serta menambahkan counter `refined_count`. Ini mencegah kanibalisasi pending order valid.
   - **Flip Guard (Bias Berlawanan):** Jika cron baru membalikkan bias (misal `bullish` $\rightarrow$ `bearish`), pergeseran hanya membatalkan order lama jika bebas dari status `conflict === 'arah'` (bukan *whipsaw* sinyal mentah). Jika *whipsaw*, pembalikan ditolak dan pending order lama dipertahankan.
2. `test/admin/isolation_auto.test.js` [MODIFY] — Memperbarui unit test untuk memverifikasi behavior in-place refinement (status tetap `pending`, level ter-update, `refined_count` bertambah) dan pembalikan bias yang valid.
3. `npm test` dijalankan dan terverifikasi 100% hijau (556/556 pass).

## Changelog Session 213 (2026-07-21) — Verifikasi status operasional daemon VPS Railway dan kinerja awal trading otomatis Plan U

**Konteks:** Melakukan audit operasional pasca-pemasangan daemon VPS di Railway dan aktivasi auto-entry virtual Plan U (2026-07-20). Verifikasi dilakukan dengan menginterogasi database Upstash Redis secara langsung.

**Perubahan/Hasil Audit:**
1. **Status Uptime Daemon**: VPS Railway terkonfirmasi aktif dan berdenyut secara konsisten (beat terakhir diterima 17 detik yang lalu).
2. **Kinerja Auto-Entry (setup_log_auto:v1)**:
   - Terkumpul **5 sampel setup virtual** sejak rilis (2026-07-20). Ini memulai akumulasi sampel menuju target n≥100 untuk Kriteria Fase Tes.
   - Hasil setup closed: 1 setup menyentuh target profit (EURUSD=X bearish setup -> `🟢 TP` pada 2026-07-20), 2 setup dibatalkan (`canceled`). Win-rate awal 100% pada setup yang terpicu.
   - Setup pending aktif: 2 setup diterbitkan pada slot pagi ini (EURUSD=X bearish entry 1.14384; GC=F bullish entry 3988.34).
3. **Uji Konsistensi LLM (consistency_log:v1)**: Terverifikasi berjalan 1x sehari. Entri terbaru (2026-07-21) menunjukkan bias LLM tetap identik (3/3 bullish), namun tingkat toleransi level teknikal gagal dipenuhi karena call ketiga menghasilkan level null (indikasi model tidak patuh skema).
4. **Log Latensi Kalender (calendar_actual_latency_log:v1)**: Pengumpulan data berjalan. Tercatat latensi aktual data makro CAD *Inflation Rate YoY* terdeteksi terlambat ~63 menit dari jadwal rilis (2026-07-20).
5. **Skrip Scratch**: Menambahkan skrip bantu `scratch/check_trading.js` untuk memudahkan pengecekan status di masa mendatang.

## Changelog Session 209 (2026-07-20) — Rigor tambahan Plan U: cost expectancy, kalibrasi confidence, latensi pipeline, backtest lintas rezim + carry

**Konteks:** Diskusi user pasca-Plan U soal apakah virtual trading realistis bisa "menang" (EMH/Meese-Rogoff/Klein sudah tercatat di `daun_merah_referensi_riset.md` sebagai constraint).

Disepakati 10 arah kerja untuk memperbaiki KUALITAS evaluasi (bukan mencari alpha baru) — sesi ini eksekusi 5 yang bisa jalan sekarang tanpa menunggu data: cost modeling, kalibrasi confidence, ukur latensi, backtest lintas rezim, backtest carry.

**1. Transaction cost modeling (`api/admin.js`):**
- `SPREAD_PRICE_ESTIMATE`: tabel spread retail ESTIMASI (bukan kutipan broker riil, bukan diverifikasi live) per 14 pair FX + XAU/USD, satuan harga.
- `_costAdjustedR(st)`: R-multiple gross vs net-biaya per setup closed (tp/sl) — risk = |entry_mid - sl|, gross menang = `rr` tersimpan (atau dihitung ulang dari tp), gross kalah = -1, cost = spread/risk dikurangkan dari kedua arah.
- `_aggCostExpectancy(arr)`: rata-rata `avg_r_gross` vs `avg_r_net` — masuk `setup_stats` sebagai field `cost_expectancy` (semua scope, publik & auto). Data mentah (status/level) TIDAK disentuh, murni field agregat baru.

**2. Kalibrasi confidence AI:**
- `ohlcv_analyze` (`api/admin.js`) — field JSON baru `confidence` (tinggi/sedang/rendah), instruksi eksplisit "HARUS konsisten dengan paragraf KESIMPULAN". Normalisasi: default `null` (BUKAN dipaksa satu nilai seperti `conflict`) kalau model tidak patuh skema ATAU `entry_zone` null — nilai keliru lebih baik diskip daripada mencemari data kalibrasi. Dipersist ke `setup_log:v1`/`setup_log_auto:v1` (field baru, backward-compatible).
- `_confidenceCalibration(arr)`: win-rate dipecah per level confidence (hanya closed tp/sl) — masuk `setup_stats` sebagai `confidence_calibration`. Tujuan: AI terkalibrasi baik seharusnya win-rate tinggi>sedang>rendah; kalau flat/terbalik, confidence self-assessment AI tidak informatif untuk sizing.

**3. Ukur latensi pipeline (`api/admin.js`, `_buildAutoScopeStats`):**
- `_summarizeLatency(entries)`: avg/median/min/max (menit) dari `calendar_actual_latency_log:v1` (log existing U-3 sub-riset, poll 10 menit — vps/daemon.js) — pure function, testable tanpa Redis.
- `_pipelineLatencySummary()`: baca log via Redis, masuk payload `scope=auto` sebagai `pipeline_latency`. Belum ada sampel cukup untuk laporan (log baru mulai terisi sejak deploy Plan U 2026-07-20) — field siap, tunggu data alami terkumpul.

**4. Backtest lintas rezim (`scripts/backtest_confluence.js`):**
- Tambah `computeVolatilityRegime` (reuse `api/_pair_context.js`, fungsi sama yang disuntik ke prompt AI Analisa produksi) per titik evaluasi — bounce-rate zona tinggi/rendah sekarang dipecah per rezim (tenang/normal/bergejolak), bukan cuma agregat global.
- **Dijalankan live (2026-07-20):** agregat global HAMPIR IDENTIK run 2026-07-17 (skor tinggi 918 zona, 369 sentuh (40%) → bounce 54%; skor rendah 30 zona, 7 sentuh (23%) → bounce 57% — kontrol rendah MASIH terlalu kecil untuk klaim pembanding, dan kali ini malah SETARA/lebih tinggi dari skor tinggi, bukan lebih rendah seperti run sebelumnya — jangan kutip sebagai bukti confluence tidak bekerja, n kontrol terlalu kecil untuk kesimpulan apa pun). **Temuan baru dari breakdown rezim:** bounce-rate zona skor TINGGI stabil di 51-54% di ketiga rezim (tenang 54%, normal 54%, bergejolak 51%) — TIDAK degradasi signifikan di rezim bergejolak seperti dugaan awal diskusi. Detail lengkap + interpretasi: `daun_merah_riset.md`.

**5. Backtest carry/yield differential (`scripts/backtest_carry.js`, BARU):**
- Script terpisah dari confluence — signal carry bulanan dari differential yield 10Y nominal (proxy, FRED — sama series `real-yields.js`) EUR/GBP/AUD/JPY vs USD, dibandingkan kontrol Buy&Hold dan Anti-Carry.
- **BELUM dieksekusi live** — butuh `FRED_API_KEY` yang tidak tersedia di lingkungan sesi ini (`.env.local` lokal cuma punya Redis/Gemini/Telegram/VAPID, bukan FRED). Kode sudah diverifikasi jalan sampai titik fetch (gagal graceful per-pair dengan pesan jelas saat key kosong, tidak crash). User perlu jalankan manual: `FRED_API_KEY=xxx node scripts/backtest_carry.js` (key yang sama dengan Vercel).

**Verifikasi:** `npm test` 550/550 hijau (537 sebelumnya + 13 baru di `test/admin/cost_confidence_latency.test.js`, termasuk 2 test integrasi ohlcv_analyze end-to-end untuk field `confidence`). Tidak ada perubahan `index.html`/`sw.js`/`?v=` (perubahan backend + script riset, tidak menyentuh frontend). Item #6-10 dari 10 arah kerja yang didiskusikan (kalibrasi antar-provider, evaluasi loss-avoidance sbg metrik utama, validasi conviction sizing, out-of-sample split, gating berbasis rezim) SENGAJA belum dikerjakan — butuh sampel `setup_log_auto:v1` cukup (n≥100 gate Plan U) yang baru mulai terkumpul sejak deploy hari ini, bukan bisa dikerjakan offline sekarang.

## Changelog Session 208 (2026-07-20) — Plan V-3: circuit breaker terpisah untuk call developer-only Plan U

**Konteks:** Eksekusi item V-3 dari `Dokumentasi/daun_merah_plan.md` (§PLAN V, hasil rapat audit boros/self-healing 2026-07-20). Temuan rapat: call AI `isAutoCall` (auto-entry Plan U, developer-only, 4×/hari) dan diagnostik `test_deepseek=1` (uji konsistensi, 3×/hari) memakai circuit breaker KEY SAMA (`ai:deepseek`, dan untuk `isAutoCall` juga `ai:sambanova:main`/`ai:sambanova:c1`) dengan traffic publik (Ringkasan, Analisa manual, Pre-Entry Check) — kegagalan eksperimen developer-only bisa mentrip breaker yang sama dan menjatuhkan fitur publik ke fallback tier padahal provider publik sebenarnya sehat.

**Perubahan:**
1. `api/admin.js` `ohlcvAnalyzeHandler` — helper lokal `isExperimental = isAutoCall || testDeepseekOnly` + 3 konstanta breaker key (`CB_DEEPSEEK_KEY`/`CB_SAMBA_MAIN_KEY`/`CB_SAMBA_C1_KEY`) yang resolve ke `<key>:experimental` kalau eksperimen, key produksi kalau tidak. Diterapkan konsisten di 3 titik call produksi (DeepSeek primary, SambaNova akun-1, SambaNova akun-2) — `canCall`/`onSuccess`/`onFailure` selalu pakai konstanta yang sama per call, tidak ada campur key. Blok diagnostik `testDeepseekOnly` (selalu eksperimen) diganti key literal `'ai:deepseek:experimental'`.
2. `api/admin.js` `KNOWN_CIRCUITS` — tambah 3 key experimental (`ai:deepseek:experimental`, `ai:sambanova:main:experimental`, `ai:sambanova:c1:experimental`) supaya terlihat di `action=circuit-status`/`circuit-reset` untuk observability.
3. `test/admin/isolation_auto.test.js` — 4 test: (auto=1) dan (test_deepseek=1) 3x gagal beruntun mentrip breaker experimental TANPA menyentuh breaker produksi; kontrol negatif — call publik 3x gagal mentrip breaker produksi TANPA menyentuh breaker experimental; ditambah 1 test cek-ulang untuk fallback SambaNova akun-1 (`ai:sambanova:main:experimental`, bukan cuma `ai:deepseek:experimental`) — memastikan ketiga key breaker yang disentuh V-3 (DeepSeek, SambaNova akun-1, SambaNova akun-2) terverifikasi, bukan cuma satu.
4. `allowAiCall('deepseek')` (jatah harian) SENGAJA TIDAK dipisah — tetap shared by design (`daun_merah_ai.md` §4), sesuai scope minimal plan ini.

**Catatan tabrakan multi-sesi:** Plan V-2 (dedup cron `ohlcv_sync`) dikerjakan PARALEL oleh sesi lain di working directory yang sama (lihat Session 207 di bawah). Perubahan V-3 di `api/admin.js` berada di region kode terpisah (`ohlcvAnalyzeHandler`/`KNOWN_CIRCUITS`, ~baris 1400 & 3700+) dari perubahan V-2 (`ohlcvSyncHandler`/`KEY_REGISTRY`, ~baris 507 & 1565+) — tidak overlap. Commit ini HANYA berisi hunk V-3 (diverifikasi lewat `git diff --cached` sebelum commit); hunk V-2 & `test/admin/ohlcv_sync_cron_dedup.test.js` sengaja dibiarkan tidak tersentuh untuk sesi tersebut commit sendiri.

**Verifikasi:** `npm test` 537/537 hijau (termasuk 4 test V-3 di `isolation_auto.test.js`, ditambah 1 saat cek-ulang isolasi SambaNova). Tidak ada perubahan `index.html`/`?v=`/`APP_VERSION` (perubahan aditif/isolatif terhadap breaker key, sesuai prinsip Plan V). Verifikasi live tersisa: pantau `action=circuit-status` setelah beberapa siklus auto-entry, konfirmasi `ai:deepseek:experimental`/`ai:sambanova:main:experimental`/`ai:sambanova:c1:experimental` bisa OPEN independen dari key produksinya masing-masing.

## Changelog Session 203 (2026-07-20) — Plan U-3 lanjutan 2: lock race-condition setup_log + probe kesehatan calendar_v1

**Konteks:** Lanjutan audit mandiri pasca-U-6 (`Session 202`) — user diskusi 5 potensi celah, minta 2 dikerjakan sekarang (sisanya cuma perlu dipantau, bukan bug).

**1. Race condition penulisan `setup_log_auto:v1`/`setup_log:v1` (`api/admin.js`):**
Pola baca-array→ubah→tulis-balik di `ohlcvAnalyzeHandler` tidak atomik — kalau `AUTO_ENTRY_PAIRS` diperluas (>1 pair berbagi satu array yang sama) dan dua request nyaris bersamaan, yang menulis belakangan bisa menimpa perubahan yang menulis duluan (lost update). Aman hari ini (cuma 1 pair, 2 slot/hari berurutan) tapi jadi bug data nyata begitu pair ditambah. Fix: lock singkat `lock:setuplog_write:<key>` (`SET NX EX 10`, pola sama `lock:market_digest_generate`) menyerialkan penulisan per key — kalau lock lagi dipegang, logging kali ini di-skip (best-effort, response analisa tetap 200 seperti biasa, TIDAK PERNAH gagal karena ini).

**2. Probe kesehatan `calendar_v1` (`api/admin.js`, `action=health`):**
Ditemukan: probe `forexfactory` yang sudah ada cuma cek sumber XML LAMA yang sudah tidak dipakai lagi sejak `api/calendar.js` pindah ke TradingView (session 2026-07-13, fallback FF dihapus) — jadi tidak pernah membuktikan `calendar_v1` (cache yang benar-benar dipakai `fundamental_shock` U-1 & filter berita keras U-3) itu sendiri sehat. Kalau pipeline TradingView→Redis rusak diam-diam, probe lama tetap bilang OK. Probe baru `calendar_cache` baca `calendar_v1` langsung, cek umur `fetched_at` (ambang 180 menit) — DOWN kalau kosong/tidak valid/basi.

**Test baru** (`test/admin/isolation_auto.test.js`, +5): lock dipegang → write di-skip, response tetap 200; lock bebas → write jalan & lock ke-DEL; `probeCalendarCache` segar/basi/kosong (3 kasus).

**Verifikasi:** `npm test` 527/527 hijau (522 + 5 baru).

## Changelog Session 202 (2026-07-20) — Plan U-3 lanjutan: cegah posisi virtual auto-entry menumpuk per symbol

**Konteks:** Diskusi user pasca-U-6 menemukan celah desain: dedup lama di `ohlcvAnalyzeHandler` (`api/admin.js`) cuma skip kalau entry_zone+SL+TP **persis identik** dengan setup pending/open yang sudah ada — kalau AI kasih level SEDIKIT beda antar-slot (mis. entry 4010 lalu 4000, arah sama), keduanya tercatat sebagai 2 posisi virtual independen di `setup_log_auto:v1`. Risikonya: kalau satu pergerakan harga men-trigger SL di kedua-duanya, itu 1 kesalahan AI terhitung 2x di statistik — mencemari validitas sampel n≥100 yang jadi syarat Kriteria Fase Tes.

**Perubahan (`api/admin.js`, HANYA untuk `isAutoCall` — manual/`setup_log:v1` TIDAK diubah):**
- Kalau symbol yang sama sudah punya posisi **`open`** (harga sudah masuk zona entry): call auto baru **di-skip total**, tidak menambah ide baru di atas posisi yang sudah live — konsisten dengan prinsip "jangan numpuk risk", dan reaksi ke berita untuk posisi open sudah ranah Review Posisi (U-5), bukan auto-replace buta di sini.
- Kalau symbol yang sama cuma punya posisi **`pending`** lama (belum kena harga sama sekali) dengan level BEDA dari analisa baru: posisi lama diubah statusnya jadi **`canceled`** (`label_reason:'digantikan analisa auto-entry lebih baru sebelum kena harga'`, `label_by:'auto'` — status `canceled` sudah ada di skema U-1 dan TIDAK PERNAH masuk pembagi win-rate manapun, jadi tidak mencemari statistik tapi juga tidak menghilangkan jejaknya), lalu analisa terbaru tetap dicatat sebagai posisi aktif baru. Hasilnya: cuma 1 ide aktif per symbol setiap saat, tapi pandangan AI terbaru tetap terpakai (bukan di-skip begitu saja).
- Dedup exact-match lama (level persis sama) TETAP ada di atas kebijakan baru ini — kalau analisa baru levelnya identik dengan yang sudah pending, tidak ada perubahan (tidak dicatat ulang, tidak ada cancel percuma).

**Test baru** (`test/admin/isolation_auto.test.js`, +3): pending lama beda level → dibatalkan + baru dicatat; posisi open → skip total, lama tidak disentuh; call manual dengan pending lama → TIDAK dibatalkan (regresi negatif, kebijakan hanya untuk auto).

**Verifikasi:** `npm test` 522/522 hijau (519 sebelumnya + 3 baru).

## Changelog Session 201 (2026-07-20) — Plan U: Auto-Entry Virtual (Fase Tes) + Konteks AI + Integritas Pembelajaran

**Konteks:** Menguji kualitas keputusan AI Analisa secara empiris lewat auto-entry VIRTUAL (paper trading, TANPA broker/uang riil), sekaligus memperbaiki integritas data pembelajaran (SL akibat news shock vs level teknikal buruk) dan konteks yang dilihat AI (rezim volatilitas, currency strength, flag konflik). Dikerjakan multi-sesi di branch `plan-u` (papan klaim & detail teknis lengkap ada di git history `daun_merah_plan.md`, dihapus dari file aktif setelah sesi ini). **Keputusan penting yang mengubah desain awal (rapat 2026-07-20): auto-entry & manajemen posisi adalah eksperimen developer-only** — publik HANYA menerima fitur informasi (label penyebab loss, dua metrik, konteks AI, checklist bertingkat); tidak ada jejak auto-entry yang terlihat pengguna.

**U-1 (`d9529a2`) — Tracker: label penyebab loss, dua metrik, override admin:**
- Skema setup ditambah `source`/`alignment`/`loss_label`/`label_reason`/`label_by` (backward-compatible).
- Deteksi otomatis penyebab SL: `fundamental_shock` (event high-impact ±2 jam dari `calendar_v1`) dan `fakeout_sl` (kriteria ketat: harga balik tembus zona entry + sentuh TP asli dalam ≤4 jam) — prioritas fundamental_shock, tidak menumpuk.
- `win_rate_raw` (apa adanya, tidak pernah disensor) vs `win_rate_adjusted` (SL berlabel dikeluarkan) + breakdown `loss_causes`.
- Action `setup_override` (admin, proteksi `CRON_SECRET`) untuk melabel manual tanpa menyentuh data mentah.
- Setup `alignment:'konflik'` sekarang DICATAT (dulu di-skip) supaya bisa dibandingkan kinerjanya vs selaras.

**U-2 (`fba301f`) — Konteks AI: rezim volatilitas, currency strength, flag konflik:**
- Modul `api/_pair_context.js`: rezim volatilitas dari ATR(14) H1 vs persentil 14 hari (`tenang|normal|bergejolak`), currency strength dari agregasi %change 14 pair (fail-open, minimal 6 pair).
- Prompt `ohlcv_analyze` disuap blok rezim + strength (pola ordinal tanpa persen, sama seperti blok labour market S154).
- Field `conflict`(`none|arah|waktu`)/`conflict_note` di output structured — dibandingkan bias teknikal vs makro, konflik arah WAJIB dilaporkan (bukan alasan no-trade otomatis).

**U-3 (`b7ecbb9`) — Daemon: scheduler auto-entry virtual + filter berita + uji konsistensi LLM:**
- Scheduler `vps/daemon.js` memanggil `ohlcv_analyze&auto=1` untuk XAU/USD (`AUTO_ENTRY_PAIRS`, default `frxXAUUSD,frxEURUSD`), 2 slot/hari (London/NY open), hanya saat FX buka.
- Filter berita keras: skip slot kalau ada event high-impact <4 jam untuk currency kaki pair (log `auto_skip_log`).
- Uji konsistensi LLM: 1 slot/hari, 3x panggilan berturut jalur diagnostik (tidak menulis cache/setup produksi), skor ke `consistency_log:v1`.
- **Sub-riset latensi `calendar_v1` (WAJIB sebelum aktifkan Lapis 2 auto-cancel): TIDAK bisa dituntaskan sinkron dalam satu sesi** (event high-impact berikutnya saat itu >18 jam dari waktu kerja) → **Lapis 2 (auto-cancel virtual) DI-DESCOPE** untuk rilis ini, sesuai klausul plan sendiri ("data tidak terverifikasi = jangan dipaksakan"). Instrumentasi pengumpulan sampel (`pollCalendarLatency`, poll 10 menit → `calendar_actual_latency_log:v1`) TETAP dibangun & aktif — keputusan aktifkan/descope permanen menyusul setelah ≥3 sampel nyata terkumpul pasca-live. Detail: `vps/README-deploy.md` §8.

**U-4 (`566d6f0`) — Checklist verdict bertingkat, risk multiplier, pindah tombol Entry MT5:**
- Konflik kelas WAKTU (rc4, <6 jam) tetap auto-block mutlak. Konflik kelas ARAH (rc3/rc6/flag `conflict:'arah'`) → status "KONFLIK" (via `ckAutoConflict()`, beda dari `ckAutoBlock()`), tidak menggagalkan gate tapi menurunkan verdict.
- `ckGetVerdict()` menghasilkan `riskMultiplier` (bersih 1.0 / konflik arah 0.5 "HALF SIZE" / <50% & gate waktu gagal = 0). Sizing membaca verdict pair yang sama, tampilkan `risk% × multiplier` eksplisit.
- Tombol Entry MT5 (`ckShowMt5Modal` → `szShowMt5Modal`) pindah utuh ke panel Sizing (guard `ckCurrentPair === szPair` wajib sebelum baca verdict).

**U-5a (`6ba67b0`) — Backend review posisi virtual:**
- Field `intervention`/`managed_status`/`managed_closed_t`/`review_count` (backward-compatible, data mentah/status pasif TIDAK PERNAH ditimpa — ghost/counterfactual tetap dievaluasi apa adanya).
- Handler `position_review`: re-cek murah (setup masih `open`?) sebelum call AI, satu intervensi per posisi, 1 call AI (chain existing via `_ai_guard`) dengan validasi kode fail-safe (TIGHTEN_SL wajib lebih ketat & tidak menyalip entry, CLOSE_EARLY pakai close H1 terakhir — bukan harga karangan; output tak-patuh-skema/timeout → HOLD).
- `_evaluateManaged` + blok `management` di `_aggSetupStats`: saved/cost dua sisi dilaporkan apa adanya, tidak ada metrik yang menyensor kegagalan intervensi.

**U-5b (`f1cfebf`) — Daemon: trigger review posisi event-driven + heuristik UNCONFIRMED:**
- Hook di `pollNews` (kategori `market-moving`/`geopolitical`) → deteksi currency headline (keyword lokal di daemon, bukan `newscat.js`) → cari setup `open` yang match.
- `isCorroborated()`: geopolitik butuh ≥2 item berbeda (guid beda) ±30 menit overlap token — UNCONFIRMED didiskon (default HOLD di prompt), bukan diverifikasi real-time; antrian recheck memori (hangus >30 menit).
- Guard budget: cooldown per posisi (`posreview_cd:<id>`, default 6 jam) + cap harian (`posreview_daily:<yyyymmdd>`, default 3).

**U-5c — DIBATALKAN.** Sempat dikerjakan (`3ff59ab`, tampilan publik "MANAJEMEN POSISI (VIRTUAL)" di `index.html`) lalu di-revert total (`aecb692`, diff terhadap `566d6f0` kosong) mengikuti REVISI VISIBILITAS: publik tidak boleh melihat jejak eksperimen auto-entry.

**U-7 (`078254c`) — Isolasi senyap auto-entry (eksekusi REVISI VISIBILITAS):**
- Cache `ohlcv_analysis:<symbol>` SKIP ditulis untuk `isAutoCall` (gate `!isDiagnosticOnly && !isAutoCall`) — pengguna tidak pernah melihat "Analisa sudah jadi"/auto-tick checklist dari call daemon.
- Log terpisah total: `setup_log_auto:v1` (cap 200 sendiri) untuk `isAutoCall`, `setup_log:v1` murni manual — dievaluasi sebagai dua array terpisah, tidak pernah dicampur.
- `setup_stats` publik = agregat `setup_log:v1` saja, blok `management` dihilangkan (`_omitManagement`) dari payload publik.
- `scope=auto` (proteksi `CRON_SECRET`/`x-vercel-cron`) khusus developer — tanpa secret balik response publik biasa (tidak membocorkan keberadaan scope).
- `position_review` menolak id yang hanya ada di `setup_log:v1` (`{skipped:'not_experiment'}`) tanpa call AI; `vps/daemon.js` dipastikan baca `setup_log_auto:v1` (bukan key lama).
- `index.html`: baris "Source: manual X · auto Y" (kode mati U-4) dihapus total; `APP_VERSION` → `2026.07.20.2`.

**U-6 (sesi ini) — Merge, push, verifikasi live:**
- Stash 2 file dokumentasi Session 200 yang sudah modified sebelum Plan U dimulai (bukan bagian Plan U, dikembalikan & di-commit terpisah `3321c28` setelah merge) — sesuai instruksi "JANGAN disentuh sesi U" di header plan.
- `git merge plan-u --no-ff` ke `main` (`93b8ceb`) — **tanpa konflik**. `npm test` 519/519 hijau sebelum dan sesudah merge. `git push origin main` — deploy live terkonfirmasi (`APP_VERSION 2026.07.20.2` live, 0 hit grep `setup_log_auto` di `index.html` produksi, fitur `riskMultiplier`/`szShowMt5Modal`/`ckAutoConflict` U-4 terkonfirmasi ada di HTML produksi).
- **Verifikasi live publik (tanpa secret):** `setup_stats` publik tidak punya key `management` (sesuai desain); `scope=auto` TANPA secret balik payload identik dengan publik (byte-identical, dikonfirmasi) — tidak membocorkan keberadaan scope.
- **Verifikasi senyap dengan secret (kriteria inti U-7): LOLOS.** Percobaan pertama pakai nilai `.env.local` gagal auth (root cause: value tersimpan dengan tanda kutip literal di file — bukan secret salah/rotated, murni bug parsing skrip verifikasi sendiri; efek samping: 1 AI call produksi terpakai + 1 entri manual asli tercatat wajar di `setup_log:v1`, tidak berbahaya). Setelah tanda kutip dilepas saat parsing, secret cocok. Uji ulang pakai simbol EUR/USD (hindari cooldown dedup 30 menit `GC=F` dari percobaan gagal sebelumnya): `ohlcv_analysis:EURUSD=X` (`mode=cached`) **tidak berubah** setelah call `auto=1`; entri baru masuk `setup_log_auto:v1` dengan `source:'auto'` (dikonfirmasi via `scope=auto`); `setup_stats` publik **tidak menampilkan** simbol/entri EUR/USD ini (tidak bocor). Isolasi senyap U-7 terkonfirmasi bekerja end-to-end di production.
- Railway daemon log (konfirmasi `vps/daemon.js` versi baru live & scheduler U-3/U-5b aktif) **tidak diverifikasi sesi ini** (tidak ada akses dashboard Railway) — didelegasikan ke user.

**Kesimpulan:** Kode seluruh Plan U (U-1..U-5b, U-7) live di production sejak `93b8ceb`, isolasi senyap terverifikasi end-to-end (LOLOS). Test hijau 519/519, deploy terkonfirmasi via HTTP. Gate "Kriteria Fase Tes" (n≥100 setup, skor konsistensi ≥80%, dst.) mulai berjalan sejak deploy ini; log Railway masih perlu dicek user.

