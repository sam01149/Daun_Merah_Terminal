// test/lib/pair_context.test.js — PLAN U-2 (2026-07-20)
// Unit test pure functions konteks AI Analisa (api/_pair_context.js): rezim
// volatilitas (ATR14 H1 rolling percentile) + currency strength (%change H1 ~3
// hari lintas pair FX) + formatter blok prompt. Fixture candle sintetis (close
// flat/linear) supaya TR/ATR & %change terkontrol dan mudah diverifikasi.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeVolatilityRegime,
  computeCurrencyStrength,
  formatPairContextBlock,
  buildPairContext,
} = require('../../api/_pair_context.js');

// close flat 100, h/l simetris ±rangeFn(i)/2 di sekitar 100 — dengan close flat,
// TR = h-l persis (prevClose=100 selalu), jadi rentang TR terkontrol penuh.
function mkCandles(n, rangeFn, startT = 0) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const half = rangeFn(i) / 2;
    arr.push({ t: startT + i * 3600, o: 100, h: 100 + half, l: 100 - half, c: 100 });
  }
  return arr;
}

// close bergerak linear dari startClose ke endClose sepanjang `hours` candle —
// dipakai untuk fixture currency strength (%change H1 terkontrol).
function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

// ── computeVolatilityRegime ───────────────────────────────────────────────────

test('regime: < 16 candle -> null (fail-open, bukan label menyesatkan)', () => {
  assert.equal(computeVolatilityRegime(mkCandles(10, () => 1)), null);
  assert.equal(computeVolatilityRegime(null), null);
  assert.equal(computeVolatilityRegime([]), null);
});

test('regime: sampel rolling ATR < MIN_ATR_SAMPLES (24) -> null meski >16 candle', () => {
  // 37 candle -> series length 23 (< 24) -> null; 38 candle -> series 24 -> lolos.
  assert.equal(computeVolatilityRegime(mkCandles(37, () => 1)), null);
  assert.notEqual(computeVolatilityRegime(mkCandles(38, i => 1 + i * 0.001)), null);
});

test('regime: TR baru jauh lebih besar dari histori -> bergejolak', () => {
  const candles = mkCandles(100, i => (i < 70 ? 0.2 : 2.0));
  const r = computeVolatilityRegime(candles);
  assert.equal(r.regime, 'bergejolak');
  assert.ok(r.percentile > 0.7, `percentile ${r.percentile} harus >0.7`);
  assert.equal(r.sample_size, 86);
});

test('regime: TR baru jauh lebih kecil dari histori -> tenang', () => {
  const candles = mkCandles(100, i => (i < 70 ? 2.0 : 0.2));
  const r = computeVolatilityRegime(candles);
  assert.equal(r.regime, 'tenang');
  assert.ok(r.percentile < 0.3, `percentile ${r.percentile} harus <0.3`);
});

test('regime: TR berosilasi di sekitar rata-rata -> normal', () => {
  const candles = mkCandles(100, i => 1.0 + Math.sin(i / 5) * 0.5);
  const r = computeVolatilityRegime(candles);
  assert.equal(r.regime, 'normal');
  assert.ok(r.percentile >= 0.3 && r.percentile <= 0.7, `percentile ${r.percentile} harus 0.3-0.7`);
});

test('regime: urutan candle dibalik (DESC) tetap dihitung benar (dinormalisasi ASC internal)', () => {
  const asc = mkCandles(100, i => (i < 70 ? 0.2 : 2.0));
  const desc = [...asc].reverse();
  assert.deepEqual(computeVolatilityRegime(desc), computeVolatilityRegime(asc));
});

// ── computeCurrencyStrength ───────────────────────────────────────────────────

// USD menguat luas: EUR/GBP/AUD/NZD turun vs USD, USD/JPY & USD/CAD naik (USD basis).
const USD_STRONG_PAIRS = [
  { label: 'EUR/USD', candles: mkTrendCandles(1.10, 1.08) },
  { label: 'GBP/USD', candles: mkTrendCandles(1.30, 1.28) },
  { label: 'USD/JPY', candles: mkTrendCandles(150, 152) },
  { label: 'AUD/USD', candles: mkTrendCandles(0.65, 0.64) },
  { label: 'USD/CAD', candles: mkTrendCandles(1.35, 1.37) },
  { label: 'NZD/USD', candles: mkTrendCandles(0.60, 0.59) },
];

test('strength: USD basis di beberapa pair & quote di pair lain, semuanya menguat -> USD rank #1', () => {
  const s = computeCurrencyStrength(USD_STRONG_PAIRS);
  assert.ok(s);
  assert.equal(s.ranked[0].currency, 'USD');
  assert.equal(s.ranked[s.ranked.length - 1].currency, 'EUR');
  assert.equal(s.sample_pairs, 6);
  assert.equal(s.span_hours, 72);
  // Urutan skor turun monoton
  for (let i = 1; i < s.ranked.length; i++) assert.ok(s.ranked[i - 1].score >= s.ranked[i].score);
});

test('strength: < MIN_STRENGTH_PAIRS (6) pair valid -> null (fail-open)', () => {
  assert.equal(computeCurrencyStrength(USD_STRONG_PAIRS.slice(0, 5)), null);
  assert.equal(computeCurrencyStrength([]), null);
  assert.equal(computeCurrencyStrength(null), null);
});

test('strength: pair dengan candle kosong/kurang atau label tidak valid di-skip, bukan bikin crash', () => {
  const withGaps = [
    ...USD_STRONG_PAIRS,
    { label: 'EUR/GBP', candles: null },
    { label: 'AUD/JPY', candles: mkTrendCandles(95, 96, 3) }, // terlalu sedikit candle (<6)
    { label: 'INVALIDLABEL', candles: mkTrendCandles(1, 2) },
    null,
  ];
  const s = computeCurrencyStrength(withGaps);
  assert.ok(s);
  assert.equal(s.sample_pairs, 6, 'hanya 6 pair valid asli yang terhitung, sisanya di-skip diam-diam');
});

test('strength: referensi ~72 jam lalu diambil dari candle terdekat yang tidak lebih baru dari target', () => {
  // 80 candle @1 jam, target 72 jam lalu dari candle terakhir (index 79) -> index 7.
  const candles = mkTrendCandles(1.0, 1.08, 80); // linear naik
  const pairs = [
    { label: 'EUR/USD', candles },
    { label: 'GBP/USD', candles: mkTrendCandles(1.30, 1.28) },
    { label: 'USD/JPY', candles: mkTrendCandles(150, 152) },
    { label: 'AUD/USD', candles: mkTrendCandles(0.65, 0.64) },
    { label: 'USD/CAD', candles: mkTrendCandles(1.35, 1.37) },
    { label: 'NZD/USD', candles: mkTrendCandles(0.60, 0.59) },
  ];
  const s = computeCurrencyStrength(pairs);
  const eur = s.ranked.find(r => r.currency === 'EUR');
  // EUR naik dari 1.0 ke 1.08 (naik) sepanjang seri penuh — referensi 72 jam lalu
  // (bukan candle pertama) berarti magnitudo %change EUR/USD < (1.08-1.0)/1.0*100=8%.
  const closeAt7 = 1.0 + (1.08 - 1.0) * (7 / 79);
  const closeAt79 = 1.08;
  const expectedPct = (closeAt79 - closeAt7) / closeAt7 * 100;
  // EUR score = rata2 dari EUR/USD (base) — hanya 1 pair mengandung EUR di sini.
  // score dibulatkan 4 desimal oleh computeCurrencyStrength -> toleransi longgar dikit.
  assert.ok(Math.abs(eur.score - expectedPct) < 1e-3, `expected ~${expectedPct}, got ${eur.score}`);
});

// ── formatPairContextBlock ────────────────────────────────────────────────────

test('format: regime & strength dua-duanya null -> string kosong (blok tidak muncul, fail-open)', () => {
  assert.equal(formatPairContextBlock({ regime: null, strength: null, pairLabel: 'EUR/USD' }), '');
});

test('format: hanya regime tersedia -> blok cuma berisi baris rezim, tanpa baris currency strength', () => {
  const regime = computeVolatilityRegime(mkCandles(100, i => (i < 70 ? 0.2 : 2.0)));
  const out = formatPairContextBlock({ regime, strength: null, pairLabel: 'XAU/USD' });
  assert.ok(out.startsWith('[KONTEKS REZIM & KEKUATAN MATA UANG]'));
  assert.ok(out.includes('Rezim volatilitas XAU/USD: BERGEJOLAK'));
  assert.ok(!out.includes('Currency strength'));
});

test('format: ordinal ranking tanpa persen/angka skor mentah di narasi currency strength', () => {
  const strength = computeCurrencyStrength(USD_STRONG_PAIRS);
  const out = formatPairContextBlock({ regime: null, strength, pairLabel: 'EUR/USD' });
  assert.ok(out.includes('USD #1'));
  assert.ok(out.includes('EUR #7'));
  assert.ok(!/[-+]?\d+(\.\d+)?%/.test(out), 'narasi currency strength tidak boleh menampilkan angka skor/persen mentah per currency');
});

test('format: regime rezim ATR ditulis sebagai hitungan ordinal (X dari Y), bukan persentase', () => {
  const regime = computeVolatilityRegime(mkCandles(100, i => (i < 70 ? 0.2 : 2.0)));
  const out = formatPairContextBlock({ regime, strength: null, pairLabel: 'EUR/USD' });
  assert.ok(/lebih tinggi dari \d+ dari \d+ titik historis/.test(out), out);
  assert.ok(!/\d+%/.test(out), 'baris rezim tidak boleh menampilkan angka persen mentah');
});

// ── buildPairContext (glue murni, tanpa I/O) ──────────────────────────────────

test('buildPairContext: data penuh -> regime+strength+block terisi', () => {
  const candlesBySymbol = { 'GC=F': mkCandles(100, i => (i < 70 ? 0.2 : 2.0)) };
  const fxPairs = [
    { symbol: 'EURUSD=X', label: 'EUR/USD' }, { symbol: 'GBPUSD=X', label: 'GBP/USD' },
    { symbol: 'USDJPY=X', label: 'USD/JPY' }, { symbol: 'AUDUSD=X', label: 'AUD/USD' },
    { symbol: 'USDCAD=X', label: 'USD/CAD' }, { symbol: 'NZDUSD=X', label: 'NZD/USD' },
  ];
  fxPairs.forEach((p, i) => { candlesBySymbol[p.symbol] = USD_STRONG_PAIRS[i].candles; });

  const ctx = buildPairContext({ candlesBySymbol, symbol: 'GC=F', label: 'XAU/USD', fxPairs });
  assert.equal(ctx.regime.regime, 'bergejolak');
  assert.equal(ctx.strength.ranked[0].currency, 'USD');
  assert.ok(ctx.block.includes('Rezim volatilitas XAU/USD'));
  assert.ok(ctx.block.includes('Currency strength'));
});

test('buildPairContext: candle simbol yang dianalisa tidak ada di cache -> regime null, strength tetap jalan kalau fxPairs lengkap', () => {
  const candlesBySymbol = {};
  const fxPairs = [
    { symbol: 'EURUSD=X', label: 'EUR/USD' }, { symbol: 'GBPUSD=X', label: 'GBP/USD' },
    { symbol: 'USDJPY=X', label: 'USD/JPY' }, { symbol: 'AUDUSD=X', label: 'AUD/USD' },
    { symbol: 'USDCAD=X', label: 'USD/CAD' }, { symbol: 'NZDUSD=X', label: 'NZD/USD' },
  ];
  fxPairs.forEach((p, i) => { candlesBySymbol[p.symbol] = USD_STRONG_PAIRS[i].candles; });

  const ctx = buildPairContext({ candlesBySymbol, symbol: 'GC=F', label: 'XAU/USD', fxPairs });
  assert.equal(ctx.regime, null);
  assert.ok(ctx.strength);
  assert.ok(!ctx.block.includes('Rezim volatilitas'));
  assert.ok(ctx.block.includes('Currency strength'));
});

test('buildPairContext: semua data kosong -> regime/strength null, block string kosong', () => {
  const ctx = buildPairContext({ candlesBySymbol: {}, symbol: 'GC=F', label: 'XAU/USD', fxPairs: [] });
  assert.equal(ctx.regime, null);
  assert.equal(ctx.strength, null);
  assert.equal(ctx.block, '');
});
