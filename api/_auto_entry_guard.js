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

// openPositions: array entri setup_log_auto:v1 (semua pair, status apa saja — fungsi
// ini sendiri yang filter 'open'). liveSign: lihat komentar CORRELATED_PAIRS di atas.
function isCorrelatedExposureBlocked({ symbol, bias, openPositions, liveSign }) {
  for (const partner of _correlatedPartnersOf(symbol)) {
    const openPartner = (openPositions || []).find(p => p && p.symbol === partner && p.status === 'open');
    if (!openPartner) continue;
    const corr = _correlationOf(symbol, partner, liveSign);
    const sameDirection = bias === openPartner.bias;
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

module.exports = {
  computeRollingR,
  isDrawdownHalted,
  isCorrelatedExposureBlocked,
  CORRELATED_PAIRS,
  isTimingConflictBlocked,
  isInvalidationTriggered,
  INVALIDATION_TRIGGER_TYPES,
  INVALIDATION_TRIGGER_DIRECTIONS,
  INVALIDATION_TRIGGER_TIMEFRAMES,
  DRAWDOWN_WINDOW,
  DRAWDOWN_HALT_THRESHOLD_R,
  _realizedWinR,
};
