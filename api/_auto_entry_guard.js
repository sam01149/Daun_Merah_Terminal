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
//   riset), BUKAN covariance-matrix penuh — cuma cover SATU pasangan yang terbukti
//   korelatif di set 4-pair saat ini (XAU/USD-EUR/USD r=0,585, lihat riset.md).
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

// ── Gate D: Correlation cap (heuristik sederhana, 1 pasangan terbukti korelatif) ──
// Peta symbol Yahoo -> pandangan USD tersirat dari bias. XAU/USD & EUR/USD naik
// BERSAMAAN (r=0,585, riset 2026-07-26) -> keduanya proxy "USD melemah" saat bullish.
// Pair lain di set 4-pair (AUD/NZD, EUR/GBP) SENGAJA tidak dipetakan (korelasi
// nyaris nol ke anggota lain, r=0,03-0,19) — tidak perlu di-cap.
const CORRELATED_PARTNER = { 'GC=F': 'EURUSD=X', 'EURUSD=X': 'GC=F' };
const USD_VIEW_BY_SYMBOL_BIAS = {
  'GC=F':      { bullish: 'weak', bearish: 'strong' },
  'EURUSD=X':  { bullish: 'weak', bearish: 'strong' },
};

function usdView(symbol, bias) {
  return USD_VIEW_BY_SYMBOL_BIAS[symbol]?.[bias] ?? null;
}

// openPositions: array entri setup_log_auto:v1 (semua pair, status apa saja — fungsi
// ini sendiri yang filter 'open').
function isCorrelatedExposureBlocked({ symbol, bias, openPositions }) {
  const partner = CORRELATED_PARTNER[symbol];
  if (!partner) return false;
  const newView = usdView(symbol, bias);
  if (!newView) return false;
  const openPartner = (openPositions || []).find(p => p && p.symbol === partner && p.status === 'open');
  if (!openPartner) return false;
  return usdView(partner, openPartner.bias) === newView;
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

module.exports = {
  computeRollingR,
  isDrawdownHalted,
  isCorrelatedExposureBlocked,
  isTimingConflictBlocked,
  DRAWDOWN_WINDOW,
  DRAWDOWN_HALT_THRESHOLD_R,
  _realizedWinR,
};
