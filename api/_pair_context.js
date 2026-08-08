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

// Profil struktural per pair (2026-08-04, rapat user — riset di daun_merah_riset.md
// "[2026-08-04] Profil struktural AUD/NZD & EUR/GBP"). HANYA untuk pair yang secara
// struktural range-bound/mean-reverting (dua ekonomi mirip, tanpa kaki USD) — EUR/USD
// & XAU/USD SENGAJA tidak dikasih entri karena keduanya macro-driven/trending, bukan
// range-bound; nempelin "skeptis ke breakout" di situ justru salah kalibrasi.
// Dipakai HANYA saat rezim volatilitas 'bergejolak' terdeteksi (lihat formatPairContextBlock)
// supaya tidak jadi noise di kondisi tenang/normal — pair ini memang defaultnya diam.
// CHF/JPY (pair ke-5, 2026-08-08) SENGAJA TIDAK dikasih entri di sini juga, walau
// dua-duanya cross tanpa kaki USD — beda karakter dari AUD/NZD & EUR/GBP. Riset
// korelasi (riset.md folder professional_llm_trader) menemukan hipotesis "dua
// safe-haven saling menetralkan" (pola sama EUR/GBP) TIDAK terbukti untuk CHF/JPY:
// SNB & BOJ punya pendorong kebijakan independen sendiri-sendiri (bukan searah
// macam RBA-RBNZ), jadi pair ini kemungkinan lebih macro-driven/trending — nempelin
// catatan "skeptis ke breakout, anggap noise" di sini justru salah kalibrasi, sama
// alasannya kenapa EUR/USD & XAU/USD juga tidak dikasih entri.
const STRUCTURAL_PROFILES = {
  'AUD/NZD': 'Catatan struktural AUD/NZD: pair ini secara historis range-bound/mean-reverting (ekonomi Australia & New Zealand mirip, RBA & RBNZ sering bergerak searah) — breakout dari rezim bergejolak di atas HANYA kredibel kalau dibarengi salah satu pemicu jelas: RBA-RBNZ policy diverge tajam, atau harga komoditas kunci berlawanan arah (iron ore vs dairy/GDT). Tanpa pemicu itu, anggap ini kemungkinan besar noise dalam range, bukan breakout asli.',
  'EUR/GBP': 'Catatan struktural EUR/GBP: pair ini secara historis range-bound (ekonomi Eropa & Inggris berdekatan, menyerap shock eksternal dengan cara mirip, range harian tipikal cuma 40-70 pip) — breakout dari rezim bergejolak di atas HANYA kredibel kalau dibarengi divergensi kebijakan ECB-BOE yang jelas atau berita fiskal/politik relatif UK-EU. Tanpa pemicu itu, anggap ini kemungkinan besar noise dalam range. Perhatikan juga: range kecil pair ini bikin spread memakan porsi lebih besar dari target profit dibanding pair lain.',
};

// Format blok konteks untuk disuntik ke prompt AI Analisa. Fail-open murni: field
// yang null di-skip (bukan ditulis kosong); kalau regime & strength dua-duanya
// null, return '' supaya blok TIDAK MUNCUL sama sekali (plan U-2 kriteria selesai).
function formatPairContextBlock({ regime, strength, pairLabel }) {
  const lines = [];
  if (regime) {
    lines.push(`Rezim volatilitas ${pairLabel || 'pair ini'}: ${regime.regime.toUpperCase()} — ATR14 H1 sekarang lebih tinggi dari ${regime.rank_below} dari ${regime.sample_size} titik historis yang tersedia (rentang data ${regime.span_hours} jam terakhir). ${REGIME_INSTRUCTION[regime.regime]}`);
    // Kartu spesialis per pair — cuma muncul pas rezim 'bergejolak' (breakout dari kondisi
    // normal terdeteksi) DAN pair ini punya profil struktural. Fail-open: pair tanpa entri
    // (EUR/USD, XAU/USD) atau rezim selain bergejolak -> baris ini tidak pernah muncul.
    const profile = STRUCTURAL_PROFILES[pairLabel];
    if (regime.regime === 'bergejolak' && profile) lines.push(profile);
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
  STRUCTURAL_PROFILES,
  computeVolatilityRegime,
  computeCurrencyStrength,
  formatPairContextBlock,
  buildPairContext,
};
