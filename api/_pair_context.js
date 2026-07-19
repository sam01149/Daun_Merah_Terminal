// api/_pair_context.js — PLAN U-2 (2026-07-20)
// Konteks tambahan untuk prompt AI Analisa: rezim volatilitas per pair (ATR14 H1
// sekarang dibanding rolling ATR14 historis yang TERSEDIA di cache) + currency
// strength lintas pair FX (agregasi %change H1 ~3 hari per kaki mata uang).
// Pure functions — TIDAK ada I/O Redis di sini (dipanggil dari api/admin.js yang
// sudah punya candle di tangan), pola sama seperti api/_labour_market.js.
//
// Catatan jujur soal window data: cache `ohlcv:<sym>:1h` di Redis dibatasi 120
// candle (~5 hari trading, lihat admin.js ohlcv_sync), BUKAN 14 hari kalender
// seperti sketsa awal plan — window aktual dilaporkan apa adanya (span_hours),
// tidak diklaim 14 hari yang tidak didukung data (fail-open: sampel terlalu
// sedikit -> null, bukan label menyesatkan).
//
// Ordinal, TANPA persen mentah di narasi prompt (pola sama dengan blok labour
// market S154 — memory labour-market-assessment-pivot): rezim ditampilkan sebagai
// label + hitungan "X dari Y titik historis", currency strength sebagai ranking
// ordinal (#1 terkuat .. #N terlemah), bukan skor numerik mentah.

const MIN_ATR_SAMPLES = 24;     // titik rolling ATR14 minimal supaya persentil bermakna
const MIN_STRENGTH_PAIRS = 6;   // fail-open (plan U-2 §1b): pair dengan data < ini -> null
const STRENGTH_LOOKBACK_H = 72; // "delta 3 hari" (plan U-2 §1b)

function _sortAsc(candles) {
  return [...candles].sort((a, b) => a.t - b.t);
}

function _trueRange(cur, prevClose) {
  return Math.max(cur.h - cur.l, Math.abs(cur.h - prevClose), Math.abs(cur.l - prevClose));
}

// Rolling ATR14 (mean TR 14 bar) di tiap titik sepanjang seri — dipakai untuk
// persentil rezim, BEDA dari _atr14h1 di admin.js (yang cuma nilai TUNGGAL
// terakhir, bukan seri).
function _rollingAtr14(sortedCandles) {
  if (!Array.isArray(sortedCandles) || sortedCandles.length < 16) return [];
  const trs = [];
  for (let i = 1; i < sortedCandles.length; i++) {
    trs.push(_trueRange(sortedCandles[i], sortedCandles[i - 1].c));
  }
  const series = [];
  for (let i = 13; i < trs.length; i++) {
    series.push(trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0) / 14);
  }
  return series; // index terakhir = ATR14 "sekarang"
}

// Rezim volatilitas satu pair dari candle H1 (array {t,o,h,l,c}, urutan bebas —
// dinormalisasi ASC di sini). Persentil <30/30-70/>70 (plan U-2 §1a) menentukan
// label ordinal tenang/normal/bergejolak. Fail-open: sampel < MIN_ATR_SAMPLES -> null.
function computeVolatilityRegime(candles1h) {
  if (!Array.isArray(candles1h) || candles1h.length < 16) return null;
  const sorted = _sortAsc(candles1h);
  const series = _rollingAtr14(sorted);
  if (series.length < MIN_ATR_SAMPLES) return null;

  const current = series[series.length - 1];
  const below = series.filter(v => v < current).length;
  const percentile = below / series.length;
  const regime = percentile < 0.3 ? 'tenang' : percentile > 0.7 ? 'bergejolak' : 'normal';
  const spanHours = Math.round((sorted[sorted.length - 1].t - sorted[0].t) / 3600);

  return {
    regime,
    percentile: +percentile.toFixed(2), // dipakai UI/agregat — narasi prompt pakai rank_below/sample_size, bukan ini
    rank_below: below,
    sample_size: series.length,
    span_hours: spanHours,
    atr_now: current,
  };
}

// Currency strength: %change close H1 sekarang vs ~72 jam lalu per pair, agregasi
// sederhana per kaki (base: +change, quote: -change), lalu rata-rata per currency.
// pairs: [{ label: 'EUR/USD', candles: [...] }, ...]. Toleran data hilang — pair
// tanpa candle cukup (atau label tidak valid) di-skip; sisa < MIN_STRENGTH_PAIRS -> null.
function computeCurrencyStrength(pairs) {
  if (!Array.isArray(pairs)) return null;
  const perPairChange = [];
  for (const p of pairs) {
    if (!p || !Array.isArray(p.candles) || p.candles.length < 6) continue;
    const legs = String(p.label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
    if (legs.length !== 2) continue;
    const sorted = _sortAsc(p.candles);
    const last = sorted[sorted.length - 1];
    const targetT = last.t - STRENGTH_LOOKBACK_H * 3600;
    let ref = sorted[0];
    for (const c of sorted) { if (c.t <= targetT) ref = c; else break; }
    if (ref.t === last.t || !ref.c || !last.c) continue;
    const changePct = (last.c - ref.c) / ref.c * 100;
    perPairChange.push({ label: p.label, base: legs[0], quote: legs[1], change_pct: changePct });
  }
  if (perPairChange.length < MIN_STRENGTH_PAIRS) return null;

  const scores = {};
  for (const pc of perPairChange) {
    if (!scores[pc.base])  scores[pc.base]  = { sum: 0, n: 0 };
    if (!scores[pc.quote]) scores[pc.quote] = { sum: 0, n: 0 };
    scores[pc.base].sum  += pc.change_pct; scores[pc.base].n++;
    scores[pc.quote].sum -= pc.change_pct; scores[pc.quote].n++;
  }
  const ranked = Object.entries(scores)
    .map(([currency, s]) => ({ currency, score: +(s.sum / s.n).toFixed(4) }))
    .sort((a, b) => b.score - a.score);

  return { ranked, sample_pairs: perPairChange.length, span_hours: STRENGTH_LOOKBACK_H };
}

const REGIME_INSTRUCTION = {
  tenang: 'Rezim tenang: pakai aturan entry/SL/TP standar — jangan memperbesar posisi hanya karena volatilitas rendah, kondisi bisa berubah cepat.',
  normal: 'Rezim normal: pakai aturan entry/SL/TP standar tanpa penyesuaian tambahan.',
  bergejolak: 'Rezim bergejolak: syarat konfirmasi entry WAJIB lebih ketat (tunggu konfirmasi price action lebih jelas sebelum masuk), SL WAJIB diberi buffer lebih lebar dari biasanya, dan berita negatif untuk pair ini diberi bobot lebih besar dari kondisi normal.',
};

// Format blok konteks untuk disuntik ke prompt AI Analisa. Fail-open murni: field
// yang null di-skip (bukan ditulis kosong); kalau regime & strength dua-duanya
// null, return '' supaya blok TIDAK MUNCUL sama sekali (plan U-2 kriteria selesai).
function formatPairContextBlock({ regime, strength, pairLabel }) {
  const lines = [];
  if (regime) {
    lines.push(`Rezim volatilitas ${pairLabel || 'pair ini'}: ${regime.regime.toUpperCase()} — ATR14 H1 sekarang lebih tinggi dari ${regime.rank_below} dari ${regime.sample_size} titik historis yang tersedia (rentang data ${regime.span_hours} jam terakhir). ${REGIME_INSTRUCTION[regime.regime]}`);
  }
  if (strength && strength.ranked?.length) {
    const n = strength.ranked.length;
    const rankText = strength.ranked.map((r, i) => `${r.currency} #${i + 1}`).join(', ');
    const days = Math.round(strength.span_hours / 24);
    lines.push(`Currency strength (ordinal, dari %change H1 ~${days} hari terakhir lintas ${strength.sample_pairs} pair FX; #1 = terkuat, #${n} = terlemah): ${rankText}. Ini konteks tambahan, bukan sinyal arah tunggal — pertimbangkan bersama struktur teknikal pair ini, jangan jadikan satu-satunya alasan bias.`);
  }
  if (lines.length === 0) return '';
  return `[KONTEKS REZIM & KEKUATAN MATA UANG]\n${lines.join('\n')}`;
}

// Gabungan: hitung regime (pair yang dianalisa) + strength (lintas fxPairs) lalu
// format sekaligus — satu pintu masuk untuk admin.js supaya tidak perlu tahu
// detail internal. candlesBySymbol: { 'EURUSD=X': [...], ... } (key = symbol Yahoo).
// fxPairs: [{ symbol, label }] daftar pair FX yang dipakai untuk currency strength
// (TIDAK termasuk XAU/USD — bukan currency).
function buildPairContext({ candlesBySymbol, symbol, label, fxPairs }) {
  const regime = computeVolatilityRegime(candlesBySymbol?.[symbol]);
  const strengthInput = (fxPairs || []).map(p => ({ label: p.label, candles: candlesBySymbol?.[p.symbol] }));
  const strength = computeCurrencyStrength(strengthInput);
  const block = formatPairContextBlock({ regime, strength, pairLabel: label });
  return { regime, strength, block };
}

module.exports = {
  MIN_ATR_SAMPLES,
  MIN_STRENGTH_PAIRS,
  STRENGTH_LOOKBACK_H,
  computeVolatilityRegime,
  computeCurrencyStrength,
  formatPairContextBlock,
  buildPairContext,
};
