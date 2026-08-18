// test/admin/ohlcv_chart.test.js
// Revamp dashboard Professional LLM Trader (dev-auto-entry.html, 2026-08-18): chart
// per-pair butuh candle mentah, bukan metrik turunan ohlcv_read. Handler baru
// (?action=ohlcv_chart) baca langsung snapshot ohlcv:<symbol>:<tf> dari Redis.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

function fakeReqRes({ action, method = 'GET', headers = {}, query = {} } = {}) {
  const req = {
    method,
    query: { action, ...query },
    headers,
    url: `/api/admin?action=${action}`,
    on(event, cb) { if (event === 'end') cb(); },
  };
  return { req, res: fakeRes() };
}

function makeStore(seed = {}) {
  return { strings: { ...seed } };
}
function redisFetchStub(store) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const [cmd, key] = args;
    if (cmd === 'GET') {
      return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
    }
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
}

test('ohlcv_chart: symbol wajib diisi -> 400', async () => {
  const handler = loadHandler();
  const { req, res } = fakeReqRes({ action: 'ohlcv_chart' });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('ohlcv_chart: mengembalikan candle mentah dari snapshot ohlcv:<symbol>:1h (default tf)', async () => {
  const candles = [{ t: 1000, o: 1.1, h: 1.2, l: 1.0, c: 1.15, v: 0 }];
  const store = makeStore({
    'ohlcv_fresh:EURUSD=X': '1', // throttle aktif -> skip fetch vendor, langsung baca snapshot
    'ohlcv:EURUSD=X:1h': JSON.stringify(candles),
  });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'EURUSD=X' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.symbol, 'EURUSD=X');
    assert.equal(res.body.tf, '1h');
    assert.deepEqual(res.body.candles, candles);
  } finally { global.fetch = origFetch; }
});

test('ohlcv_chart: tf tidak dikenal -> fallback ke 1h', async () => {
  const store = makeStore({ 'ohlcv_fresh:GC=F': '1', 'ohlcv:GC=F:1h': JSON.stringify([]) });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'GC=F', tf: 'weekly' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.tf, '1h');
  } finally { global.fetch = origFetch; }
});

test('ohlcv_chart: tf=4h membaca key ohlcv:<symbol>:4h', async () => {
  const candles4h = [{ t: 2000, o: 2, h: 2.1, l: 1.9, c: 2.05, v: 0 }];
  const store = makeStore({
    'ohlcv_fresh:GBPUSD=X': '1',
    'ohlcv:GBPUSD=X:4h': JSON.stringify(candles4h),
  });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'GBPUSD=X', tf: '4h' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.candles, candles4h);
  } finally { global.fetch = origFetch; }
});

test('ohlcv_chart: snapshot kosong (belum pernah sync) -> candles array kosong, bukan error', async () => {
  const store = makeStore({ 'ohlcv_fresh:NZDUSD=X': '1' });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'NZDUSD=X' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.candles, []);
  } finally { global.fetch = origFetch; }
});
