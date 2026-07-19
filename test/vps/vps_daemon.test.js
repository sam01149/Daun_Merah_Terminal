// test/vps_daemon.test.js — Plan Q-2..Q-6 (vps/daemon.js).
//
// vps/ di-deploy sebagai Docker image TERISOLASI (build context = folder vps/
// saja), jadi newscat.js dan mapping symbol Deriv DIDUPLIKASI dari file asalnya
// (../newscat.js, api/_ohlcv_fetch.js) alih-alih di-require lintas folder. Test
// drift-guard di sini memastikan duplikasi itu tidak diam-diam menyimpang.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  mergeClosedCandle, normalizeDerivCandle, isHighImpactCategory, priceInZone,
  YAHOO_TO_DERIV_SYMBOL,
} = require('../../vps/daemon.js');
const { mapYahooSymbolToDeriv } = require('../../api/_ohlcv_fetch.js');

// ── Drift guard: vps/newscat.js harus byte-identik dengan newscat.js root ───

test('vps/newscat.js byte-identik dengan newscat.js root (single source of truth)', () => {
  const root = fs.readFileSync(path.join(__dirname, '..', '..', 'newscat.js'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '..', '..', 'vps', 'newscat.js'), 'utf8');
  assert.equal(copy, root,
    'vps/newscat.js menyimpang dari newscat.js root — salin ulang persis, jangan edit salah satu sendirian');
});

// ── Drift guard: mapping symbol Deriv di daemon.js harus sinkron dengan _ohlcv_fetch.js ──

test('YAHOO_TO_DERIV_SYMBOL di daemon.js sinkron dengan mapYahooSymbolToDeriv (_ohlcv_fetch.js)', () => {
  const keys = Object.keys(YAHOO_TO_DERIV_SYMBOL);
  assert.equal(keys.length, 14, 'daemon.js harus punya 14 pair FX (sama scope Plan P)');
  for (const yahooSymbol of keys) {
    assert.equal(
      YAHOO_TO_DERIV_SYMBOL[yahooSymbol],
      mapYahooSymbolToDeriv(yahooSymbol),
      `mapping ${yahooSymbol} beda antara daemon.js dan api/_ohlcv_fetch.js`
    );
  }
});

// ── normalizeDerivCandle ─────────────────────────────────────────────────────

test('normalizeDerivCandle: menerima field open_time (subscribe stream)', () => {
  const out = normalizeDerivCandle({ open_time: 1752800400, open: '1.0850', high: '1.0860', low: '1.0840', close: '1.0855' });
  assert.deepEqual(out, { t: 1752800400, o: 1.085, h: 1.086, l: 1.084, c: 1.0855, v: 0 });
});

test('normalizeDerivCandle: menerima field epoch (fallback shape)', () => {
  const out = normalizeDerivCandle({ epoch: 1752800400, open: '1.0850', high: '1.0860', low: '1.0840', close: '1.0855' });
  assert.equal(out.t, 1752800400);
});

test('normalizeDerivCandle: data cacat -> null, bukan crash', () => {
  assert.equal(normalizeDerivCandle({ open_time: 1752800400, open: 'NaN', high: '1', low: '1', close: '1' }), null);
  assert.equal(normalizeDerivCandle({}), null);
});

// ── mergeClosedCandle: tulis HANYA saat close, tidak duplikat, urut, cap panjang ──

test('mergeClosedCandle: menambah candle baru di ujung array terurut', () => {
  const existing = [{ t: 100, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 200, o: 1, h: 1, l: 1, c: 1, v: 0 }];
  const out = mergeClosedCandle(existing, { t: 300, o: 2, h: 2, l: 2, c: 2, v: 0 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(c => c.t), [100, 200, 300]);
});

test('mergeClosedCandle: epoch yang sama menimpa (bukan duplikat)', () => {
  const existing = [{ t: 100, o: 1, h: 1, l: 1, c: 1, v: 0 }];
  const out = mergeClosedCandle(existing, { t: 100, o: 9, h: 9, l: 9, c: 9, v: 0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].c, 9);
});

test('mergeClosedCandle: dipotong ke maxLen (default 120), yang terlama dibuang', () => {
  const existing = Array.from({ length: 120 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1, v: 0 }));
  const out = mergeClosedCandle(existing, { t: 120, o: 2, h: 2, l: 2, c: 2, v: 0 });
  assert.equal(out.length, 120);
  assert.equal(out[0].t, 1); // t=0 terbuang
  assert.equal(out[out.length - 1].t, 120);
});

// ── isHighImpactCategory ─────────────────────────────────────────────────────

test('isHighImpactCategory: hanya market-moving yang dianggap high-impact', () => {
  assert.equal(isHighImpactCategory('market-moving'), true);
  assert.equal(isHighImpactCategory('geopolitical'), false);
  assert.equal(isHighImpactCategory('macro'), false);
  assert.equal(isHighImpactCategory('econ-data'), false);
});

// ── priceInZone ──────────────────────────────────────────────────────────────

test('priceInZone: true kalau jarak <= tolerance', () => {
  assert.equal(priceInZone(1.0855, 1.0850, 0.001), true);
  assert.equal(priceInZone(1.0900, 1.0850, 0.001), false);
});

test('priceInZone: input non-finite -> false, bukan crash', () => {
  assert.equal(priceInZone(NaN, 1.085, 0.001), false);
  assert.equal(priceInZone(1.085, null, 0.001), false);
  assert.equal(priceInZone(1.085, 1.085, undefined), false);
});
