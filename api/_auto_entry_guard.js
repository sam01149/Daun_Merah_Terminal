// api/_auto_entry_guard.js — Audit celah "kesalahan trader" auto-entry (2026-07-28,
// daun_merah_progress.md). Pure functions saja (pola sama api/_position_review.js) —
// I/O (Redis/HTTP/AI) tetap di api/admin.js, supaya bisa dites unit tanpa mock jaringan.
//
// Riset dasar (daun_merah_referensi_riset.md §10, 4 Scopus AI report + 4 sitasi
// diverifikasi manual, 2026-07-28): benang merah SEMUA temuan adalah "pakai ambang
// ADAPTIF/dinamis, hindari cutoff statis/biner" — bukan "jangan pasang gate sama
// sekali". Dua gate di file ini menerapkan itu:
// - Gate B (drawdown circuit breaker): ambang berbeda per risk_regime, BUKAN hitung
//   N-loss-beruntun statis (consecutive-loss rawan "magnet effect", Subrahmanyam 1994).
// - Gate D (correlation cap): heuristik sederhana (gross-exposure constraint ala
//   riset), BUKAN covariance-matrix penuh — cuma cover pasangan yang terbukti
//   korelatif di set pair aktif (lihat CORRELATED_PAIRS di bawah + riset.md folder
//   professional_llm_trader untuk data pengukuran tiap pasangan).
//
// Gate C (regime confidence bar) DIHAPUS 2026-07-28 (sesi sama dengan pembuatannya) —
// keputusan user: gate ini buta arah (blok confidence rendah saat regime stres TANPA
// peduli bias align atau tidak dengan regime), dan skeptisisme "risk_off -> hati-hati"
// itu SUDAH seharusnya jadi bagian penalaran AI thesis (Analisa/pre-entry check yang
// baca risk_regime langsung), bukan filter buta terpisah di atasnya. Kasus konkret yang
// membongkar ini: XAU/USD bullish saat risk_off (justru selaras teori safe-haven) tetap
// diblokir gate ini kalau confidence rendah — padahal arahnya sendiri sudah "benar".

// ── Gate B: Drawdown circuit breaker (adaptif per regime) ───────────────────────
// Ambang HEURISTIK AWAL (belum dikalibrasi dari data live — pola sama NOISE_BAND_PCT
// di _cb_shock.js/VIX_PCTL_10Y di risk-regime.js, direvisi setelah cukup sampel real):
// window rolling 10 setup TERTUTUP terakhir (lintas SEMUA pair, ~1-1.5 hari aktivitas
// di kadence 8 call/hari) — kalau total R gabungan sudah seburuk ambang, tahan entry
// baru sampai membaik. Ambang mengetat seiring regime memburuk (risk_off paling ketat).
const DRAWDOWN_WINDOW = 10;
const DRAWDOWN_HALT_THRESHOLD_R = {
  risk_on: -6,
  neutral: -5,
  elevated: -3,
  risk_off: -2,
};
// BUG DITEMUKAN & DIFIX (2026-07-29, audit lanjutan celah kesalahan trader): regime
// null/gagal-fetch/tak dikenal dulu diam-diam disamakan dengan 'neutral' (-5R) —
// mencampur dua kondisi beda: "regime memang dinilai netral" vs "kita tidak tahu
// regime-nya sama sekali" (data hilang bukan sinyal tenang). Sekarang diperlakukan
// seketat 'risk_off' (paling konservatif) supaya ketidaktahuan tidak diam-diam
// melonggarkan circuit breaker. Referensi ke DRAWDOWN_HALT_THRESHOLD_R.risk_off
// (bukan angka -2 duplikat) supaya tidak drift kalau ambang risk_off direvisi nanti.
const DEFAULT_DRAWDOWN_THRESHOLD_R = DRAWDOWN_HALT_THRESHOLD_R.risk_off;

// [2026-07-28, audit lanjutan] Ambang minimum sampel SEBELUM circuit breaker boleh
// menyala — tanpa ini, di awal umur sistem (rolling window 10 = SELURUH riwayat yang
// ada, bukan window "recent" dari sampel besar) cukup 2 SL beruntun saat risk_off
// (ambang -2R) buat membekukan SEMUA pair, padahal 2 kekalahan dari sampel sekecil itu
// tidak beda dari variance biasa. Angka 5 dipilih konsisten dengan preseden ambang
// minimum yang sudah dipakai di tempat lain (`_formatTrackRecordBlock` butuh >=5 setup
// selesai sebelum dipercaya, lihat komentar sekitar baris "butuh >=5 setup selesai" di
// admin.js) — bukan angka baru yang diarang.
const DRAWDOWN_MIN_SAMPLE = 5;

// Realized-R dari geometri level yang BENAR-BENAR tersimpan (entry_zone/sl/tp), BUKAN
// dari field `rr` (target saat setup dibuat/direfine — audit lanjutan 2026-07-29: bisa
// meleset dari level FINAL kalau di-refine tapi `structured.risk_reward` kebetulan null
// di generate itu). Prioritas: geometri riil > `rr` tersimpan > fallback 1 (data lama/
// tak lengkap sama sekali). Pola sama _costAdjustedR (api/admin.js) — diduplikasi di
// sini secara sadar (bukan di-share) supaya modul ini tetap pure/tanpa dependensi silang
// dengan admin.js (lihat header file: "Pure functions saja... dites unit tanpa mock").
function _realizedWinR(st) {
  const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
  const e = nums(st.entry_zone), slNum = nums(st.sl)[0], tpNum = nums(st.tp)[0];
  if (e.length && slNum != null && tpNum != null) {
    const entryMid = (Math.min(...e) + Math.max(...e)) / 2;
    const risk = Math.abs(entryMid - slNum);
    if (risk > 0) return Math.round((Math.abs(tpNum - entryMid) / risk) * 100) / 100;
  }
  const rr = Number(st.rr);
  return Number.isFinite(rr) && rr > 0 ? rr : 1;
}

// `closedSetups` = array setup_log_auto:v1 TERURUT ts naik, status 'tp' atau 'sl' saja
// (caller wajib filter+sort sebelum panggil — fungsi ini tidak mengurutkan ulang).
// Outcome R: 'tp' -> +realizedWinR (lihat _realizedWinR), 'sl' -> -1 tetap (risiko yang
// direalisasikan selalu 1R, terlepas rr yang ditarget).
function computeRollingR(closedSetups) {
  const window = (closedSetups || []).slice(-DRAWDOWN_WINDOW);
  let sum = 0;
  for (const st of window) {
    if (!st) continue;
    if (st.status === 'tp') {
      sum += _realizedWinR(st);
    } else if (st.status === 'sl') {
      sum -= 1;
    }
  }
  return sum;
}

// closedSetups: lihat computeRollingR. regime: 'risk_on'|'neutral'|'elevated'|'risk_off'|null.
// Sampel < DRAWDOWN_MIN_SAMPLE -> tidak pernah halted, apapun rollingR-nya (belum cukup
// data buat bedakan "lagi apes" dari "cuma variance normal"). `regime_known` dilaporkan
// terpisah (2026-07-29) supaya "regime memang netral" vs "regime tidak diketahui" bisa
// dibedakan belakangan di analisis, walau threshold efektifnya sekarang identik dgn
// risk_off untuk kasus tak diketahui (lihat DEFAULT_DRAWDOWN_THRESHOLD_R).
function isDrawdownHalted({ closedSetups, regime }) {
  const sampleSize = (closedSetups || []).length;
  const rollingR = computeRollingR(closedSetups);
  const regimeKnown = Object.prototype.hasOwnProperty.call(DRAWDOWN_HALT_THRESHOLD_R, regime);
  const threshold = regimeKnown ? DRAWDOWN_HALT_THRESHOLD_R[regime] : DEFAULT_DRAWDOWN_THRESHOLD_R;
  const halted = sampleSize >= DRAWDOWN_MIN_SAMPLE && rollingR <= threshold;
  return { halted, rollingR, threshold, sampleSize, regime_known: regimeKnown };
}

// ── Gate B katup darurat berbasis waktu (2026-08-22, syarat aktivasi ulang Gate B
// yang disebut sendiri di catatan nonaktifnya, POLICY_EPOCHS v29) ──────────────────
// Celah desain asli: Gate B GLOBAL lintas-pair, cuma bisa membaik lewat (a) trade
// baru yang closed profit, atau (b) rezim risiko membaik dari luar. Kalau di titik
// tertentu SEMUA pair kebetulan nol posisi pending/open sekaligus DAN rolling-R masih
// di bawah ambang, jalan (a) mustahil (entry baru itu sendiri yang diblokir) — macet
// permanen sampai (b) terjadi, yang bisa tidak pernah terjadi.
//
// Fix: kalau TIDAK ADA posisi pending/open di SELURUH log (lintas semua pair) DAN
// sudah >= N hari sejak entri REAL terakhir (status apa pun SELAIN 'canceled' — ghost
// yang ditahan gate tetap tercatat 'canceled' tiap siklus, jadi timestamp log TIDAK
// berhenti maju cuma karena gate menyala; harus diukur dari entri yang benar-benar
// tembus, bukan dari entri log APAPUN), izinkan SATU kandidat lolos supaya siklus
// (a) bisa jalan lagi. N hari (bukan jam) sengaja dipilih jauh di atas kadence normal
// (2 slot/hari/pair) supaya valve tidak menyala di kondisi flat yang wajar/singkat,
// cuma di kemacetan yang genuinely berkepanjangan.
const DRAWDOWN_EMERGENCY_VALVE_DAYS = 3; // HEURISTIK AWAL, belum dikalibrasi dari data live — pola sama DRAWDOWN_HALT_THRESHOLD_R

function isDrawdownEmergencyValveOpen({ log, nowMs }) {
  const entries = Array.isArray(log) ? log : [];
  const hasPendingOrOpen = entries.some(s => s && (s.status === 'pending' || s.status === 'open'));
  if (hasPendingOrOpen) return false; // ada posisi yang masih bisa closed -> jalan (a) masih hidup, valve tidak perlu

  const realTsList = entries
    .filter(s => s && s.status !== 'canceled')
    .map(s => {
      const m = String(s.id || '').match(/:(\d+)$/);
      return m ? Number(m[1]) : (s.ts ? new Date(s.ts).getTime() : null);
    })
    .filter(t => Number.isFinite(t));
  if (realTsList.length === 0) return true; // tidak pernah ada entri real sama sekali -> jangan macet dari awal umur sistem

  const lastRealTs = Math.max(...realTsList);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const daysSinceLastReal = (now - lastRealTs) / 86400000;
  return daysSinceLastReal >= DRAWDOWN_EMERGENCY_VALVE_DAYS;
}

// ── Gate D: Correlation cap (heuristik sederhana, pasangan terbukti korelatif) ──
// Daftar pasangan pair yang korelasinya cukup besar untuk di-cap (r absolut >= ~0,3
// ke pair aktif lain — ambang & metode di pair_workflow.md folder professional_llm_trader,
// Tahap 1a/2c). `sign:'positive'` (r>0, mis. XAU/USD-EUR/USD r=0,585, CHF/JPY-EUR/USD
// r=0,373) -> exposure searah kalau BIAS SAMA; `sign:'negative'` (r<0, belum ada
// kasus nyata sejauh ini) -> exposure searah kalau BIAS BERLAWANAN. Generalisasi
// 2026-08-08 (redesain saat CHF/JPY ditambah) dari model lama "pandangan USD
// bersama" yang cuma berlaku untuk pasangan yang dua-duanya punya kaki USD — CHF/JPY
// tidak punya kaki USD sama sekali, jadi korelasinya ke EUR/USD dicek langsung lewat
// arah bias, bukan lewat abstraksi USD. Perilaku pasangan GC=F/EURUSD=X TIDAK berubah
// dari sebelumnya (dites eksplisit di test/api/_auto_entry_guard.test.js).
// Pair lain di set (AUD/NZD, EUR/GBP) SENGAJA tidak dipetakan (korelasi nyaris nol
// ke anggota lain, r=0,03-0,19) — tidak perlu di-cap.
//
// liveSign (opsional, audit 2026-08-16): angka r di atas snapshot manual dari
// tanggal riset masing-masing, tidak pernah diperbarui otomatis walau sistem SUDAH
// menghitung ulang matriks korelasi 20D/60D tiap hari (api/correlations.js,
// correlations_v3). admin.js (_buildLiveCorrSign) boleh oper map
// `{ "A|B": "positive"|"negative" }` ke fungsi di bawah untuk menimpa sign statis
// per-pasangan — TAPI HANYA kalau correlations.js sendiri sudah mendeteksi anomali
// nyata (|r20-r60|>0,4), BUKAN dari r20 mentah tiap hari (diskusi user 2026-08-16:
// r20 harian berisik, bisa lintas-nol tanpa perubahan rezim sungguhan — menimpa
// asumsi hasil riset dengan noise harian berisiko menurunkan kualitas gate, bukan
// menaikkan). Kalau pasangannya tidak ada anomali terdeteksi, atau tidak ada di live
// data sama sekali (mis. CHF/JPY — bukan instrumen langsung di correlations.js), atau
// liveSign tidak dioper sama sekali, fallback diam-diam ke tabel statis di bawah
// (fail-open, pola sama semua blok lain di codebase ini). TIDAK mengubah desain "heuristik
// sederhana, bukan covariance-matrix penuh" — cuma sumber angka sign yang diperbarui.
const CORRELATED_PAIRS = [
  { a: 'GC=F', b: 'EURUSD=X', sign: 'positive' }, // r=0,585, riset 2026-07-26
  { a: 'EURUSD=X', b: 'CHFJPY=X', sign: 'positive' }, // r=0,373, riset 2026-08-08
];

function _correlationOf(symbol, partner, liveSign) {
  const entry = CORRELATED_PAIRS.find(p => (p.a === symbol && p.b === partner) || (p.b === symbol && p.a === partner));
  if (!entry) return null;
  if (liveSign) {
    const live = liveSign[`${symbol}|${partner}`] || liveSign[`${partner}|${symbol}`];
    if (live === 'positive' || live === 'negative') return { ...entry, sign: live };
  }
  return entry;
}

function _correlatedPartnersOf(symbol) {
  return CORRELATED_PAIRS.filter(p => p.a === symbol || p.b === symbol).map(p => (p.a === symbol ? p.b : p.a));
}

// CELAH DITEMUKAN & DITUTUP (2026-08-18, audit menyeluruh — riset.md folder
// professional_llm_trader §Audit menyeluruh 2026-08-18 poin A1, disetujui user):
// gate ini dulu HANYA menghitung partner ber-status 'open'. Padahal SEMUA entry
// sistem ini limit order di zona konfluensi, jadi 'pending' (order sudah hidup,
// tinggal menunggu harga) justru state yang paling lama dihuni — dua setup
// korelatif bisa sama-sama 'pending' searah lalu terisi di jam yang sama, dan cap
// korelasi tidak pernah menyala sama sekali. Di mode virtual efeknya "cuma"
// mencemari statistik; kalau nanti jalan dengan dana riil, itu eksposur ganda yang
// tidak pernah diputuskan siapa pun. 'pending' sekarang ikut dihitung sebagai
// exposure yang mengikat.
//
// TRADE-OFF YANG DITERIMA SADAR: gate jadi lebih sering menahan, jadi laju
// pengumpulan sampel bisa sedikit melambat — tapi dampaknya terbatas karena hanya
// 2 pasangan yang dipetakan di CORRELATED_PAIRS (bukan seluruh 5 pair), dan
// 'pending' punya umur terbatas sendiri (jadi 'expired' setelah horizon*1.5 di
// _evaluateSetups). Biaya/manfaatnya TIDAK perlu ditebak: kandidat yang ditahan
// gate ini sudah otomatis direkam sebagai ghost (canceled_reason
// 'gate_correlation_cap' -> _evaluateCanceledGhost), jadi `gate_reject_ghost`
// nanti menunjukkan berapa yang benar diselamatkan (saved) vs berapa yang
// sebenarnya menang (cost). Sengaja TIDAK memakai ambang umur pending ("hitung
// hanya yang < N jam") — itu akan menambah satu angka tebakan baru yang tidak
// tervalidasi, persis pola yang dihindari proyek ini.
const EXPOSURE_BINDING_STATUSES = new Set(['open', 'pending']);

// positions: array entri setup_log_auto:v1 (semua pair, status apa saja — fungsi
// ini sendiri yang filter status yang mengikat exposure). `openPositions` = nama
// parameter lama, tetap diterima supaya call site & test lama tidak perlu diubah
// beramai-ramai; keduanya berarti hal yang sama sekarang (open + pending).
// liveSign: lihat komentar CORRELATED_PAIRS di atas.
function isCorrelatedExposureBlocked({ symbol, bias, positions, openPositions, liveSign }) {
  const list = positions || openPositions || [];
  for (const partner of _correlatedPartnersOf(symbol)) {
    const boundPartner = list.find(p => p && p.symbol === partner && EXPOSURE_BINDING_STATUSES.has(p.status));
    if (!boundPartner) continue;
    const corr = _correlationOf(symbol, partner, liveSign);
    const sameDirection = bias === boundPartner.bias;
    if (corr.sign === 'positive' ? sameDirection : !sameDirection) return true;
  }
  return false;
}

// ── Gate E: Timing conflict flag (AI's own conflict:'waktu' self-assessment) ────
// Audit S277 (2026-08-04): AI sudah menandai sendiri (skema `conflict` PLAN U-2 —
// none/arah/waktu, lihat api/admin.js) kalau setup punya konflik WAKTU dengan event
// mendatang (mis. horizon multi-hari tapi ada FOMC besok). Sempat jadi HARD BLOCK
// (auto-reject sebelum Gate A dipanggil sama sekali) di sesi yang sama, lalu
// DILONGGARKAN sesi itu juga (diskusi user): dasar hard block-nya cuma 4-5 sampel SL
// — terlalu tipis untuk cutoff permanen (prinsip evaluasi n>=100 per-batch untuk
// sistem ini, daun_merah_progress.md), DAN sudah ada lapis proteksi TERPISAH untuk
// risiko berita di posisi yang SUDAH open (tighten_sl reaktif berita,
// api/_position_review.js) — hard block pra-entry jadi dobel-guard, bukan
// satu-satunya pertahanan. Fungsi ini sekarang MURNI predikat klasifikasi (dipakai
// buat counter observasi + konteks tambahan ke Gate A/AI Kritikus di api/admin.js),
// TIDAK dipanggil sebagai gate yang menahan penyimpanan.
function isTimingConflictBlocked(conflict) {
  return conflict === 'waktu';
}

// ── Track 1 (Road to Professional LLM Trader, 2026-08-04): invalidasi teknikal ──
// Cek MURNI level/MA/swing (`invalidation_trigger`, diisi AI sendiri saat generate
// sinyal — lihat prompt api/admin.js) terhadap candle H1 yang SUDAH difetch untuk
// evaluasi status (`_evaluateSetups`) — NOL fetch/call tambahan, deterministik
// (bukan AI). Dicek via CLOSE candle (bukan wick H/L seperti SL/TP) — kondisi
// struktural ("Daily close balik di bawah SMA50") secara wajar berbasis close,
// beda dari SL/TP yang memang harus tahan noise intrabar.
//
// Prioritas TP/SL asli (diskusi user): kalau posisi sudah resolve ke tp/sl/
// ambiguous, invalidasi HANYA dihitung untuk candle SEBELUM boundary yang
// tersentuh itu (`boundaryMs`, caller kirim `closed_t` kalau ada) — TP/SL yang
// tersentuh di candle sama/lebih dulu MENANG, konsisten prinsip "SL/TP asli
// adalah kontrak trade, invalidasi teknikal cuma exit dini SEBELUM itu terjadi".
//
// `startMs`: WAJIB dari `st.ts` (bukan `filled_t`) — thesis bisa batal SEBELUM
// posisi sempat fill (PENDING), jangan tunggu fill dulu baru dicek.
const INVALIDATION_TRIGGER_TYPES = new Set(['ma_break', 'price_level', 'swing_break']);
const INVALIDATION_TRIGGER_DIRECTIONS = new Set(['above', 'below']);
const INVALIDATION_TRIGGER_TIMEFRAMES = new Set(['1h', '4h', '1d']);

function isInvalidationTriggered({ invalidation_trigger, candles, startMs, boundaryMs }) {
  const trig = invalidation_trigger;
  if (!trig || !INVALIDATION_TRIGGER_TYPES.has(trig.type) || !INVALIDATION_TRIGGER_DIRECTIONS.has(trig.direction)) return null;
  const level = Number(trig.level);
  if (!Number.isFinite(level) || !Number.isFinite(startMs)) return null;
  const bound = Number.isFinite(boundaryMs) ? boundaryMs : Infinity;
  const all = Array.isArray(candles) ? [...candles].sort((a, b) => a.t - b.t) : [];
  for (const c of all) {
    if (!c) continue;
    const tMs = c.t * 1000;
    if (tMs <= startMs) continue;
    if (tMs >= bound) break;
    const close = Number(c.c);
    if (!Number.isFinite(close)) continue;
    const touched = trig.direction === 'above' ? close >= level : close <= level;
    if (touched) return { triggered: true, at: c.t };
  }
  return { triggered: false, at: null };
}

// ── Stempel versi kebijakan auto-entry (2026-08-18, keputusan user setelah audit
// menyeluruh — lihat riset.md folder professional_llm_trader §Audit menyeluruh
// 2026-08-18 poin A3) ──────────────────────────────────────────────────────────
// MASALAH YANG DIPECAHKAN: sejak deploy Plan U (2026-07-20) jalur keputusan
// auto-entry berubah puluhan kali (ganti komposisi pair, tambah/hapus gate, ubah
// prompt, ubah cara refine), tapi tidak ada satu pun field yang merekam "setup ini
// lahir di bawah aturan main versi berapa". Akibatnya sampel n>=100 yang sedang
// dikumpulkan sebenarnya campuran belasan rezim kebijakan, dan tidak ada cara
// memisahkannya lagi selain rekonstruksi manual dari `ts` vs tanggal commit.
// User memilih STEMPEL VERSI (bukan pembekuan perubahan): sistem boleh terus
// berkembang, tapi tiap setup membawa penanda supaya siapa pun (manusia atau AI)
// yang menganalisis statistiknya bisa memisahkan populasi sendiri.
//
// CARA PAKAI UNTUK ANALISIS STATISTIK:
// - Setup baru membawa `policy_v` (distempel saat dibuat/di-refine, lihat
//   buildNewSetupEntry & refineCandidate di api/admin.js).
// - Setup LAMA (sebelum 2026-08-18) tidak punya field itu — payload scope=auto
//   mengisi `policy_v_est` hasil rekonstruksi dari `ts` lewat policyVersionForTs().
//   SENGAJA nama field berbeda: `policy_v` = fakta yang direkam, `policy_v_est` =
//   perkiraan retroaktif (prinsip U-5a — jangan pernah menyamarkan rekonstruksi
//   sebagai data asli).
// - `impact` tiap epoch menandai APA yang berubah, supaya segmentasi tidak harus
//   membelah sampel di SETIAP versi: pertanyaan soal win-rate cukup dibelah di
//   perubahan `entry`/`pair_set`/`levels`/`exit`, sedangkan perubahan `context`
//   (informasi yang dilihat AI) dan `eval` (cara hasil dinilai) dibelah hanya kalau
//   pertanyaannya memang menyangkut itu.
// - `kind` menandai SIFAT perubahannya, dan ini yang menentukan data sebelah MANA
//   yang dicurigai — dua jenis di bawah minta perlakuan BERLAWANAN, jadi jangan
//   diperlakukan sama hanya karena sama-sama "perubahan":
//   * `'fix'` — memperbaiki sesuatu yang MEMANG rusak/tidak sesuai maksud desain
//     (bug, celah, gate yang tidak menutup apa yang seharusnya ditutup). Yang
//     tercemar adalah data SEBELUM perbaikan, bukan sesudah — data lama dihasilkan
//     sistem yang cacat. Perlakuan analis: curigai/keluarkan jendela SEBELUM epoch
//     ini kalau bug-nya menyentuh hal yang sedang dianalisis; data sesudahnya justru
//     lebih bersih, BUKAN "generasi baru yang tidak bisa digabung". Perbaikan jenis
//     ini TIDAK PERLU ditahan/dijadwalkan — menunda perbaikan bug demi "menjaga
//     kemurnian sampel" justru menambah data cacat, bukan menjaganya.
//   * `'policy'` — mengubah STRATEGINYA sendiri walau tidak ada yang rusak (pair
//     baru, gate baru, ambang baru, framing prompt baru). Ini benar-benar memecah
//     populasi: sebelum & sesudah adalah dua sistem berbeda yang sama-sama sah.
//     Perlakuan analis: batas populasi. Perubahan jenis inilah yang layak DIRANSUM
//     (kumpulkan dulu, terapkan berbarengan di titik evaluasi), bukan yang `'fix'`.
//   * `'mixed'` — satu deploy membawa keduanya sekaligus. Sedapat mungkin DIHINDARI
//     ke depan: pisahkan commit fix dan commit policy supaya batasnya tetap tajam
//     (v15 contoh nyata kenapa ini merepotkan — fix buffer korroborasi menumpang di
//     deploy yang sama dengan gate baru, jadi tidak bisa dinilai terpisah).
//
// ATURAN PEMELIHARAAN (WAJIB): tiap kali mengubah apa pun yang menentukan TRADE
// MANA yang terjadi, DI LEVEL BERAPA, DI PAIR APA, atau KAPAN KELUAR — tambahkan
// epoch baru di bawah (jangan mengedit epoch lama, itu memalsukan sejarah), isi
// `from` dengan waktu commit deploy-nya, dan TENTUKAN `kind` dengan jujur: kalau
// ragu antara 'fix' dan 'policy', tanya "apakah perilaku lama itu memang yang
// diniatkan?" — kalau ya, itu 'policy'; kalau perilaku lama tidak pernah diniatkan
// siapa pun, itu 'fix'. Menandai perubahan strategi sebagai 'fix' akan menipu
// analisis nanti (batas populasi jadi tidak kelihatan), dan sebaliknya menandai
// perbaikan bug sebagai 'policy' bikin sampel dipotong tanpa alasan. Perubahan yang MURNI observability/UI/
// dokumentasi TIDAK perlu epoch baru (tidak mengubah trade yang terjadi) — itu
// sengaja, supaya jumlah epoch tetap bermakna, bukan bertambah tiap commit.
//
// PRESISI BATAS: `from` = waktu commit (UTC) perubahan itu masuk `main`. Deploy
// Vercel menyusul ~1 menit; perubahan di `vps/daemon.js` menunggu redeploy Railway
// (bisa beberapa menit lebih lama). Untuk setup yang `ts`-nya jatuh dalam ~15 menit
// setelah batas epoch, perlakukan versinya sebagai TIDAK PASTI, bukan akurat.
const POLICY_EPOCHS = [
  { v: 1,  from: '2026-07-20T12:39:39Z', kind: 'policy', impact: 'baseline', label: 'Plan U live — auto-entry virtual pertama (XAU/USD + EUR/USD)' },
  { v: 2,  from: '2026-07-20T13:43:38Z', kind: 'policy', impact: 'entry',    label: 'U-3: cegah posisi menumpuk per symbol (skip kalau open, ganti kalau pending)' },
  { v: 3,  from: '2026-07-22T15:45:31Z', kind: 'policy', impact: 'entry',    label: 'S216: refinemen in-place setup pending + Flip Guard whipsaw' },
  { v: 4,  from: '2026-07-23T12:00:20Z', kind: 'policy', impact: 'pair_set', label: 'S217: Golden Trio — 3 pair (XAU/USD, EUR/USD, GBP/USD)' },
  { v: 5,  from: '2026-07-23T13:08:18Z', kind: 'policy', impact: 'entry',    label: 'S219+S220: filter berita keras breaking news + buffer korroborasi persisten (skip pra-entry)' },
  { v: 6,  from: '2026-07-24T16:26:06Z', kind: 'policy', impact: 'exit',     label: 'S231: tighten SL preventif sebelum weekend close' },
  { v: 7,  from: '2026-07-25T18:51:02Z', kind: 'fix', impact: 'eval',     label: 'S242: fix timestamp fill/close terbalik + scan TP/SL dari filled_t (mengubah cara hasil dinilai, bukan trade yang diambil)' },
  { v: 8,  from: '2026-07-26T23:28:19Z', kind: 'policy', impact: 'pair_set', label: 'S247: redesain independensi — GBP/USD dibuang, AUD/NZD + EUR/GBP masuk (4 pair)' },
  { v: 9,  from: '2026-07-28T12:01:21Z', kind: 'policy', impact: 'entry',    label: 'S250: 4 gate audit-guard aktif (Gate A Kritikus, B drawdown, C regime, D korelasi)' },
  { v: 10, from: '2026-07-28T14:24:49Z', kind: 'policy', impact: 'entry',    label: 'S251: Gate C dihapus + Gate B butuh ambang sampel minimum' },
  { v: 11, from: '2026-07-28T17:27:20Z', kind: 'fix', impact: 'eval',     label: 'S253: watcher TP/SL real-time Q-7 (deteksi hasil dalam detik, bukan jam)' },
  { v: 12, from: '2026-07-29T16:08:05Z', kind: 'policy', impact: 'context',  label: 'S259: Sistem Hakim aktif di jalur cron (koreksi label makro_alignment)' },
  { v: 13, from: '2026-07-29T16:46:20Z', kind: 'fix', impact: 'entry',    label: 'S261: fix race condition Gate A + 3 celah statistik' },
  { v: 14, from: '2026-07-29T17:35:49Z', kind: 'fix', impact: 'levels',   label: 'S262: guard korroborasi sumber kedua GC=F sebelum finalisasi tp/sl' },
  { v: 15, from: '2026-08-04T14:52:09Z', kind: 'mixed', impact: 'entry',    label: 'S277: fix prune buffer korroborasi + Gate E timing-risk sebagai hard block' },
  { v: 16, from: '2026-08-04T17:52:35Z', kind: 'policy', impact: 'entry',    label: 'S280: deteksi kejutan ekonomi (actual vs forecast) sebagai alasan skip' },
  { v: 17, from: '2026-08-04T18:44:24Z', kind: 'policy', impact: 'entry',    label: 'S281: Gate E dilonggarkan — conflict waktu tidak lagi auto-reject, diteruskan ke Gate A' },
  { v: 18, from: '2026-08-04T19:26:22Z', kind: 'policy', impact: 'exit',     label: 'S282: Track 1 invalidasi teknikal deterministik + Track 2a jam khusus AUD/NZD' },
  { v: 19, from: '2026-08-05T11:13:40Z', kind: 'fix', impact: 'context',  label: 'S283: Sistem Hakim bisa mengoreksi balik (state corrected)' },
  { v: 20, from: '2026-08-05T19:05:08Z', kind: 'fix', impact: 'entry',    label: 'S284: fix korroborasi palsu Interest Rate Probabilities (dulu men-skip 4 pair sekaligus)' },
  { v: 21, from: '2026-08-06T11:06:02Z', kind: 'policy', impact: 'entry',    label: 'S286: retry persisten untuk slot yang di-skip berita (mengubah laju & jam entry)' },
  { v: 22, from: '2026-08-08T16:43:04Z', kind: 'policy', impact: 'context',  label: 'S293+S294: framing CME-priority di prompt, dikarantina ke jalur auto (lihat juga cme_priority_prompt_v)' },
  { v: 23, from: '2026-08-08T19:03:05Z', kind: 'policy', impact: 'pair_set', label: 'S296: CHF/JPY masuk sebagai pair ke-5' },
  { v: 24, from: '2026-08-10T16:04:02Z', kind: 'fix', impact: 'context',  label: 'S301: guard kontradiksi arah mengoreksi makro_alignment otomatis' },
  { v: 25, from: '2026-08-16T13:58:32Z', kind: 'policy', impact: 'entry',    label: 'S316: Gate D — sign korelasi statis bisa ditimpa anomali korelasi live' },
  // v26 & v27 `from` DIKOREKSI 2026-08-18 (audit PLAN Z, menemukan value asli tidak
  // cocok waktu commit git log — v26 salah salin waktu lokal WIB tanpa konversi
  // (+07:00 ditulis seolah Z), v27 angka bulat yang tidak cocok waktu lokal MAUPUN
  // UTC commit-nya sama sekali). Nilai commit asli (git log --format=%aI): v26
  // `923e886` = 2026-08-18T12:05:11+07:00 = 05:05:11Z; v27 `a843c5a` =
  // 2026-08-18T12:56:31+07:00 = 05:56:31Z. Epoch v1-v25 BELUM diaudit ulang untuk
  // pola bug yang sama — lihat progress.md folder professional_llm_trader.
  { v: 26, from: '2026-08-18T05:05:11Z', kind: 'fix', impact: 'entry',    label: 'S318: Gate A (Kritikus) ikut menimbang level hasil refine-in-place' },
  { v: 27, from: '2026-08-18T05:56:31Z', kind: 'fix', impact: 'entry',    label: 'S319: Gate D menghitung posisi pending sebagai exposure, bukan cuma open' },
  { v: 28, from: '2026-08-18T09:12:12Z', kind: 'policy', impact: 'levels',  label: 'PLAN Z: sl/tp/invalidation_trigger wajib dari kandidat deterministik (api/_levels.js), dulu bebas dikarang AI' },
  { v: 29, from: '2026-08-20T08:36:35Z', kind: 'policy', impact: 'entry',    label: 'S323 lanj.4: Gate B (drawdown circuit breaker) dinonaktifkan sementara selama fase pengumpulan sampel n>=100' },
  { v: 30, from: '2026-08-21T18:54:19Z', kind: 'fix', impact: 'entry',    label: 'Gate B diaktifkan ulang dengan katup darurat waktu (isDrawdownEmergencyValveOpen) — celah macet total dari v29 diperbaiki, ambang R tetap heuristik belum dikalibrasi' },
  { v: 31, from: '2026-08-21T19:31:00Z', kind: 'policy', impact: 'entry',    label: 'AATAS: urutan keputusan auto-entry dibalik jadi makro-first (REGIME CHECK + gate driver/fundamental dulu, teknikal cuma presisi timing) — porting checklist SMC/ICT manual ke jalur isAutoCall' },
];

// AATAS_EPOCH (2026-08-22, keputusan user): batas populasi statistik dashboard
// auto-entry. Semua angka AGREGAT (win rate, jumlah TP/SL, cost_expectancy, dst)
// dihitung ULANG hanya dari setup ber-`policy_v` >= angka ini — arsitektur keputusan
// sebelum AATAS beda mendasar (teknikal dulu, makro catatan kaki), jadi menggabungkan
// dua populasi itu memberi angka yang tidak berarti apa-apa. TABEL Riwayat Setup
// TIDAK ikut difilter (histori lengkap tetap tampil) — yang direset cuma agregat.
// Nilainya SENGAJA dikunci ke v31 (bukan POLICY_VERSION yang bergerak): epoch baru
// SESUDAH ini masih satu arsitektur yang sama, jangan mereset sampel lagi tiap ada
// perubahan kebijakan kecil.
const AATAS_EPOCH = 31;

const POLICY_VERSION = POLICY_EPOCHS[POLICY_EPOCHS.length - 1].v;
const _POLICY_EPOCH_MS = POLICY_EPOCHS.map(e => ({ v: e.v, ms: Date.parse(e.from) }));

// Rekonstruksi versi kebijakan untuk setup LAMA yang tidak membawa `policy_v`.
// Return null kalau ts tidak valid atau lebih tua dari epoch pertama (jangan
// mengarang versi untuk data pra-Plan U / setup manual lama).
function policyVersionForTs(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  let found = null;
  for (const e of _POLICY_EPOCH_MS) { if (t >= e.ms) found = e.v; }
  return found;
}

// AATAS Step 0 cabang XAU/USD — SATU-SATUNYA hard-block baru dari porting ini.
// Aturan (plan AATAS, cabang gold): Real Yield + DXY + Risk Regime WAJIB 3/3 sepakat.
// Kalau tidak bulat, korelasi live yield-emas jadi arbitrase: korelasi NORMAL -> Real
// Yield sendiri boleh jadi penentu (lanjut, bukan blok); korelasi ANOMALI (ambang
// |r20-r60|>0,4 yang sudah tervalidasi, sama seperti Gate D live-sign) -> TIDAK ENTRY,
// karena penentu tunggal yang tersisa itu sendiri sedang tidak bisa dipercaya.
//
// Fail-open disengaja (pola sama semua gate di file ini): `unanimous` null/undefined
// (AI tidak melaporkan) atau `corrAnomaly` null (cache korelasi kosong/tanpa data
// RealYield) TIDAK memblokir — blok hanya kalau DUA-DUANYA fakta positif.
function isGoldRegimeBlocked({ unanimous, corrAnomaly } = {}) {
  return unanimous === false && corrAnomaly === true;
}

module.exports = {
  computeRollingR,
  POLICY_EPOCHS,
  AATAS_EPOCH,
  isGoldRegimeBlocked,
  POLICY_VERSION,
  policyVersionForTs,
  isDrawdownHalted,
  isDrawdownEmergencyValveOpen,
  DRAWDOWN_EMERGENCY_VALVE_DAYS,
  isCorrelatedExposureBlocked,
  CORRELATED_PAIRS,
  EXPOSURE_BINDING_STATUSES,
  isTimingConflictBlocked,
  isInvalidationTriggered,
  INVALIDATION_TRIGGER_TYPES,
  INVALIDATION_TRIGGER_DIRECTIONS,
  INVALIDATION_TRIGGER_TIMEFRAMES,
  DRAWDOWN_WINDOW,
  DRAWDOWN_HALT_THRESHOLD_R,
  _realizedWinR,
};
