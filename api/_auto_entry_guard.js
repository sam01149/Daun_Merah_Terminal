// api/_auto_entry_guard.js — Audit celah "kesalahan trader" auto-entry (2026-07-28,
// daun_merah_progress.md). Pure functions saja (pola sama api/_position_review.js) —
// I/O (Redis/HTTP/AI) tetap di api/admin.js, supaya bisa dites unit tanpa mock jaringan.
//
// Riset dasar (daun_merah_referensi_riset.md §10, 4 Scopus AI report + 4 sitasi
// diverifikasi manual, 2026-07-28): benang merah SEMUA temuan adalah "pakai ambang
// ADAPTIF/dinamis, hindari cutoff statis/biner" — bukan "jangan pasang gate sama
// sekali". Tiga gate di file ini menerapkan itu:
// - Gate B (drawdown circuit breaker): ambang berbeda per risk_regime, BUKAN hitung
//   N-loss-beruntun statis (consecutive-loss rawan "magnet effect", Subrahmanyam 1994).
// - Gate C (regime confidence bar): sistem ini virtual/1-unit-R (tidak ada position
//   sizing kontinu), jadi "reduce size" (Moreira & Muir 2017) diterjemahkan jadi
//   "naikkan bar keyakinan" saat regime memburuk — bukan skip total.
// - Gate D (correlation cap): heuristik sederhana (gross-exposure constraint ala
//   riset), BUKAN covariance-matrix penuh — cuma cover SATU pasangan yang terbukti
//   korelatif di set 4-pair saat ini (XAU/USD-EUR/USD r=0,585, lihat riset.md).

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
const DEFAULT_DRAWDOWN_THRESHOLD_R = -5; // regime null/tak dikenal -> perlakukan seketat 'neutral'

// `closedSetups` = array setup_log_auto:v1 TERURUT ts naik, status 'tp' atau 'sl' saja
// (caller wajib filter+sort sebelum panggil — fungsi ini tidak mengurutkan ulang).
// Outcome R: 'tp' -> +rr (fallback +1 kalau rr tidak valid), 'sl' -> -1 tetap (risiko
// yang direalisasikan selalu 1R, terlepas rr yang ditarget).
function computeRollingR(closedSetups) {
  const window = (closedSetups || []).slice(-DRAWDOWN_WINDOW);
  let sum = 0;
  for (const st of window) {
    if (!st) continue;
    if (st.status === 'tp') {
      const rr = Number(st.rr);
      sum += Number.isFinite(rr) && rr > 0 ? rr : 1;
    } else if (st.status === 'sl') {
      sum -= 1;
    }
  }
  return sum;
}

// closedSetups: lihat computeRollingR. regime: 'risk_on'|'neutral'|'elevated'|'risk_off'|null.
function isDrawdownHalted({ closedSetups, regime }) {
  const rollingR = computeRollingR(closedSetups);
  const threshold = DRAWDOWN_HALT_THRESHOLD_R[regime] ?? DEFAULT_DRAWDOWN_THRESHOLD_R;
  return { halted: rollingR <= threshold, rollingR, threshold };
}

// ── Gate C: Regime confidence bar (pengganti "reduce size" utk sistem 1-unit-R) ──
// Blok entry confidence 'rendah' saat regime sedang stres (elevated/risk_off) —
// entry confidence 'sedang'/'tinggi' tetap lolos (bukan skip total, cuma naikkan
// bar kualitas sinyal saat kondisi makro sedang tidak mendukung).
//
// [2026-07-28, diskusi user] Gate ini HANYA relevan untuk pair dengan kaki USD
// langsung — risk_regime murni proxy VIX/MOVE/HY (risiko global/USD). AUD/NZD &
// EUR/GBP SENGAJA tidak dimasukkan: keduanya dipilih di redesain 4-pair justru
// karena independen dari faktor risiko global itu (r=0,10-0,19, daun_merah_riset.md)
// — edge-nya datang dari fundamental relatif (RBA/RBNZ, ECB/BOE), bukan VIX/MOVE.
// Menggate pair itu pakai regime global akan salah sasaran.
const REGIME_RELEVANT_SYMBOLS = new Set(['GC=F', 'EURUSD=X']);

function isRegimeConfidenceBlocked({ symbol, regime, confidence }) {
  if (!REGIME_RELEVANT_SYMBOLS.has(symbol)) return false;
  if (confidence !== 'rendah') return false;
  return regime === 'risk_off' || regime === 'elevated';
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

module.exports = {
  computeRollingR,
  isDrawdownHalted,
  isRegimeConfidenceBlocked,
  isCorrelatedExposureBlocked,
  DRAWDOWN_WINDOW,
  DRAWDOWN_HALT_THRESHOLD_R,
};
