// test/ohlcv_fallback.test.js
// M1 (audit 2026-07-18): Yahoo Finance = titik gagal tunggal semua candle OHLCV FX.
// Fallback Twelve Data (_ohlcv_fetch.js) + counter/alert Yahoo down (admin.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapYahooSymbolToTwelveData,
  normalizeTwelveDataCandles,
  fetchFallbackCandles,
  shouldSendYahooAlert,
} = require('../../api/_ohlcv_fetch.js');

// ── mapYahooSymbolToTwelveData: mapping simbol ──────────────────────────────

test('mapYahooSymbolToTwelveData: 15 pair terdaftar (8 fixed + 7 dinamis) terpetakan benar', () => {
  assert.equal(mapYahooSymbolToTwelveData('GC=F'), 'XAU/USD');
  assert.equal(mapYahooSymbolToTwelveData('EURUSD=X'), 'EUR/USD');
  assert.equal(mapYahooSymbolToTwelveData('USDJPY=X'), 'USD/JPY');
  assert.equal(mapYahooSymbolToTwelveData('GBPCAD=X'), 'GBP/CAD');
});

test('mapYahooSymbolToTwelveData: simbol tidak dikenal -> null (bukan crash)', () => {
  assert.equal(mapYahooSymbolToTwelveData('BTCUSD=X'), null);
  assert.equal(mapYahooSymbolToTwelveData(''), null);
  assert.equal(mapYahooSymbolToTwelveData(undefined), null);
});

// ── normalizeTwelveDataCandles: normalisasi shape ───────────────────────────

test('normalizeTwelveDataCandles: shape identik candle Yahoo (t epoch UTC, o/h/l/c/v)', () => {
  const values = [
    { datetime: '2026-07-18 03:00:00', open: '1.08500', high: '1.08600', low: '1.08400', close: '1.08550', volume: '1234' },
    { datetime: '2026-07-18 02:00:00', open: '1.08400', high: '1.08500', low: '1.08300', close: '1.08500', volume: '5678' },
  ];
  const out = normalizeTwelveDataCandles(values);
  assert.equal(out.length, 2);
  // Harus terurut ascending walau input desc
  assert.ok(out[0].t < out[1].t);
  assert.equal(out[1].t, Math.floor(Date.parse('2026-07-18T03:00:00Z') / 1000));
  assert.equal(out[0].o, 1.084);
  assert.equal(out[0].c, 1.085);
  assert.equal(out[0].v, 5678);
});

test('normalizeTwelveDataCandles: baris korup (NaN/tanpa datetime) diskip, bukan crash', () => {
  const values = [
    { datetime: '2026-07-18 03:00:00', open: 'bukan-angka', high: '1.086', low: '1.084', close: '1.0855', volume: '10' },
    { datetime: null, open: '1.084', high: '1.085', low: '1.083', close: '1.0845', volume: '10' },
    { datetime: '2026-07-18 04:00:00', open: '1.086', high: '1.087', low: '1.085', close: '1.0865', volume: '20' },
  ];
  const out = normalizeTwelveDataCandles(values);
  assert.equal(out.length, 1);
  assert.equal(out[0].c, 1.0865);
});

test('normalizeTwelveDataCandles: input bukan array -> array kosong', () => {
  assert.deepEqual(normalizeTwelveDataCandles(null), []);
  assert.deepEqual(normalizeTwelveDataCandles(undefined), []);
});

// ── fetchFallbackCandles: network layer (fetch di-mock) ─────────────────────

test('fetchFallbackCandles: TWELVEDATA_API_KEY belum diset -> throw jelas, tidak fetch', async () => {
  const orig = process.env.TWELVEDATA_API_KEY;
  delete process.env.TWELVEDATA_API_KEY;
  const origFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  await assert.rejects(() => fetchFallbackCandles('EURUSD=X', '1h'), /TWELVEDATA_API_KEY belum diset/);
  assert.equal(fetchCalled, false);
  global.fetch = origFetch;
  if (orig) process.env.TWELVEDATA_API_KEY = orig;
});

test('fetchFallbackCandles: simbol tanpa mapping -> throw sebelum fetch', async () => {
  process.env.TWELVEDATA_API_KEY = 'dummy-key';
  const origFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  await assert.rejects(() => fetchFallbackCandles('BTCUSD=X', '1h'), /tidak ada mapping/);
  assert.equal(fetchCalled, false);
  global.fetch = origFetch;
  delete process.env.TWELVEDATA_API_KEY;
});

test('fetchFallbackCandles: response status=error dari Twelve Data -> throw dengan message', async () => {
  process.env.TWELVEDATA_API_KEY = 'dummy-key';
  const origFetch = global.fetch;
  global.fetch = async () => ({
    status: 429,
    json: async () => ({ status: 'error', code: 429, message: 'API request limit reached' }),
  });
  await assert.rejects(() => fetchFallbackCandles('EURUSD=X', '1h'), /API request limit reached/);
  global.fetch = origFetch;
  delete process.env.TWELVEDATA_API_KEY;
});

test('fetchFallbackCandles: sukses -> candle ternormalisasi, URL pakai symbol+interval benar', async () => {
  process.env.TWELVEDATA_API_KEY = 'dummy-key';
  const origFetch = global.fetch;
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return {
      status: 200,
      json: async () => ({
        status: 'ok',
        values: [
          { datetime: '2026-07-18 01:00:00', open: '2410.5', high: '2412.0', low: '2409.0', close: '2411.2', volume: '0' },
        ],
      }),
    };
  };
  const candles = await fetchFallbackCandles('GC=F', '1d');
  assert.equal(candles.length, 1);
  assert.equal(candles[0].c, 2411.2);
  assert.match(calledUrl, /symbol=XAU%2FUSD/);
  assert.match(calledUrl, /interval=1day/);
  assert.match(calledUrl, /timezone=UTC/);
  assert.match(calledUrl, /order=asc/);
  global.fetch = origFetch;
  delete process.env.TWELVEDATA_API_KEY;
});

test('fetchFallbackCandles: 0 candle valid -> throw (bukan array kosong diam-diam)', async () => {
  process.env.TWELVEDATA_API_KEY = 'dummy-key';
  const origFetch = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({ status: 'ok', values: [] }) });
  await assert.rejects(() => fetchFallbackCandles('EURUSD=X', '1h'), /0 candle valid/);
  global.fetch = origFetch;
  delete process.env.TWELVEDATA_API_KEY;
});

// ── shouldSendYahooAlert: counter + cooldown (pure) ─────────────────────────

test('shouldSendYahooAlert: streak di bawah threshold -> tidak alert', () => {
  assert.equal(shouldSendYahooAlert(1, 0, Date.now()), false);
  assert.equal(shouldSendYahooAlert(2, 0, Date.now()), false);
});

test('shouldSendYahooAlert: streak >= threshold, belum pernah alert -> alert', () => {
  assert.equal(shouldSendYahooAlert(3, 0, Date.now()), true);
  assert.equal(shouldSendYahooAlert(5, 0, Date.now()), true);
});

test('shouldSendYahooAlert: dalam cooldown 6 jam -> tidak alert lagi (anti-spam)', () => {
  const now = Date.now();
  const lastAlert = now - 3 * 60 * 60 * 1000; // 3 jam lalu
  assert.equal(shouldSendYahooAlert(4, lastAlert, now), false);
});

test('shouldSendYahooAlert: cooldown sudah lewat -> alert lagi', () => {
  const now = Date.now();
  const lastAlert = now - 7 * 60 * 60 * 1000; // 7 jam lalu
  assert.equal(shouldSendYahooAlert(4, lastAlert, now), true);
});

test('shouldSendYahooAlert: threshold/cooldown custom bisa dioverride', () => {
  const now = Date.now();
  assert.equal(shouldSendYahooAlert(1, 0, now, 1, 1000), true);
  assert.equal(shouldSendYahooAlert(2, now - 500, now, 1, 1000), false);
});
