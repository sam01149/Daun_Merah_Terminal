const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ema, atr, resampleCandles, computePrimeExecution, finalPrimeVerdict } = require('../../api/_prime_execution');

function candles(count, start, step, range = 0.2, seconds = 86400) {
  return Array.from({ length:count }, (_, i) => {
    const c = start + i * step;
    return { t:1_700_000_000 + i * seconds, o:c - step / 2, h:c + range / 2, l:c - range / 2, c, v:0 };
  });
}

test('Prime: EMA memakai SMA seed lalu pembobotan eksponensial', () => {
  assert.equal(ema([1, 2, 3, 4], 3), 3);
  assert.equal(ema([1, 2], 3), null);
});

test('Prime: ATR memakai true range dan Wilder smoothing', () => {
  const rows = [
    { t:1, o:9, h:10, l:8, c:9 },
    { t:2, o:9, h:12, l:9, c:11 },
    { t:3, o:11, h:13, l:10, c:12 },
    { t:4, o:12, h:14, l:11, c:13 },
  ];
  assert.equal(atr(rows, 3), 3);
});

test('Prime: resampling menjaga open pertama, ekstrem, dan close terakhir', () => {
  const rows = [
    { t:0, o:1, h:3, l:1, c:2, v:1 },
    { t:3600, o:2, h:4, l:0.5, c:3, v:2 },
  ];
  assert.deepEqual(resampleCandles(rows, 6), [{ t:0, o:1, h:4, l:0.5, c:3, v:3 }]);
});

test('Trend: bullish 3/3 otomatis memberi BUY ONLY tanpa konfirmasi pengguna', () => {
  const metrics = computePrimeExecution({
    symbol:'EURUSD=X', label:'EUR/USD',
    d1:candles(260, 1, 0.001, 0.002),
    h4:candles(180, 1, 0.002, 0.001, 14400),
    h6:candles(60, 1, 0.0001, 0.001, 21600),
    computedAt:Date.parse('2026-10-24T12:00:00Z'),
  });
  assert.equal(metrics.available, true);
  assert.equal(metrics.trend.relation, 'above');
  assert.equal(metrics.momentum.direction, 'bullish');
  assert.equal(metrics.strength.passed, true);
  assert.equal(metrics.verdict, 'BUY ONLY');
  assert.equal(finalPrimeVerdict(metrics), 'BUY ONLY');
});

test('Prime: dua dari tiga selalu WAIT', () => {
  const metrics = computePrimeExecution({
    symbol:'EURUSD=X', label:'EUR/USD',
    d1:candles(260, 1, 0.001, 0.002),
    h4:candles(180, 1, 0.000001, 0.0005, 14400),
    h6:candles(60, 1, 0.0001, 0.01, 21600),
  });
  assert.equal(metrics.trend.relation, 'above');
  assert.equal(metrics.momentum.direction, 'bullish');
  assert.equal(metrics.strength.passed, false);
  assert.equal(finalPrimeVerdict(metrics), 'WAIT');
});

test('Prime: warm-up kurang tidak pernah menghasilkan arah final', () => {
  const metrics = computePrimeExecution({
    symbol:'USDJPY=X', d1:candles(199, 100, 0.1), h4:candles(99, 100, 0.1, 0.2, 14400), h6:candles(14, 100, 0.1, 0.2, 21600),
  });
  assert.equal(metrics.available, false);
  assert.equal(finalPrimeVerdict(metrics), 'WAIT');
});

test('Prime: snapshot lama selalu WAIT walau tiga pemeriksaan lolos', () => {
  const metrics = computePrimeExecution({
    symbol:'EURUSD=X', d1:candles(260, 1, 0.001, 0.002),
    h4:candles(180, 1, 0.002, 0.001, 14400),
    h6:candles(60, 1, 0.0001, 0.001, 21600), stale:true,
  });
  assert.equal(metrics.available, true);
  assert.equal(metrics.verdict, 'WAIT');
  assert.equal(finalPrimeVerdict(metrics), 'WAIT');
});
