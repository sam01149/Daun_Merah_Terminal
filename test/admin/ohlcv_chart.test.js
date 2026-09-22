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
    assert.equal(res.body.last_candle_t, 1000, 'umur chart selalu diturunkan dari candle 1H');
    assert.equal(res.body.stale, true, 'snapshot tua harus ditandai, bukan tampak seperti chart live');
  } finally { global.fetch = origFetch; }
});

test('ohlcv_chart: cache Deriv basi memakai Twelve Data untuk TAMPILAN saja tanpa menulis cache evaluator', async () => {
  const staleCandles = [{ t: 1000, o: 4300, h: 4305, l: 4295, c: 4302, v: 0 }];
  const store = makeStore({
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': JSON.stringify(staleCandles),
  });
  const currentHour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const origFetch = global.fetch, oldKey = process.env.TWELVEDATA_API_KEY;
  process.env.TWELVEDATA_API_KEY = 'display-only-test-key';
  global.fetch = async (url, opts) => {
    if (String(url).includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      return { ok: true, json: async () => ({ values: [{ datetime: currentHour, open: '4350', high: '4355', low: '4348', close: '4352' }] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'GC=F', tf: '1h' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.live_source, 'Twelve Data');
    assert.equal(res.body.stale, false);
    assert.equal(res.body.candles.at(-1).c, 4352);
    assert.equal(store.strings['ohlcv:GC=F:1h'], JSON.stringify(staleCandles), 'cache Deriv evaluator tidak boleh ditimpa');
  } finally {
    global.fetch = origFetch;
    if (oldKey === undefined) delete process.env.TWELVEDATA_API_KEY; else process.env.TWELVEDATA_API_KEY = oldKey;
  }
});

test('ohlcv_read: cache Deriv kosong memakai Twelve Data hanya untuk kartu Analisa', async () => {
  const store = makeStore({ 'ohlcv_fresh:GC=F': '1' });
  const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
  const dayStart = Math.floor(Date.now() / 86400000) * 86400000;
  const hourly = Array.from({ length: 120 }, (_, i) => ({
    datetime: new Date(hourStart - (119 - i) * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    open: String(4300 + i), high: String(4302 + i), low: String(4298 + i), close: String(4301 + i),
  }));
  const daily = Array.from({ length: 140 }, (_, i) => ({
    datetime: new Date(dayStart - (139 - i) * 86400000).toISOString().slice(0, 19).replace('T', ' '),
    open: String(4100 + i), high: String(4103 + i), low: String(4097 + i), close: String(4101 + i),
  }));
  const displayTtls = {};
  const origFetch = global.fetch, oldKey = process.env.TWELVEDATA_API_KEY;
  process.env.TWELVEDATA_API_KEY = 'display-only-test-key';
  global.fetch = async (url, opts) => {
    if (String(url).includes('fake-upstash.test')) {
      const args = JSON.parse(opts.body);
      if (args[0] === 'SET' && String(args[1]).startsWith('ohlcv_display:')) displayTtls[args[1]] = args.at(-1);
      return redisFetchStub(store)(url, opts);
    }
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      return { ok: true, json: async () => ({ values: String(url).includes('interval=1day') ? daily : hourly }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_read', query: { symbol: 'GC=F', label: 'XAU/USD' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.d1.available, true);
    assert.equal(res.body.h4.available, true);
    assert.equal(res.body.h1.available, true);
    assert.deepEqual(res.body.display_source, {
      h1: 'Twelve Data (tampilan)', h4: 'Twelve Data (tampilan)', d1: 'Twelve Data (tampilan)',
    });
    assert.equal(store.strings['ohlcv:GC=F:1h'], undefined, 'candle tampilan tidak boleh masuk cache evaluator');
    assert.equal(store.strings['ohlcv:GC=F:1d'], undefined, 'daily tampilan tidak boleh masuk cache evaluator');
    assert.equal(displayTtls['ohlcv_display:twelvedata:GC=F:1h'], '300', 'cache H1 harus membatasi beban vendor');
    assert.equal(displayTtls['ohlcv_display:twelvedata:GC=F:1d'], '21600', 'daily tidak perlu ditarik ulang tiap refresh');
  } finally {
    global.fetch = origFetch;
    if (oldKey === undefined) delete process.env.TWELVEDATA_API_KEY; else process.env.TWELVEDATA_API_KEY = oldKey;
  }
});

test('ohlcv_dashboard: cache Deriv kosong tetap mengisi delapan chip publik dari Twelve Data display-only', async () => {
  const store = makeStore();
  const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
  const hourly = Array.from({ length: 8 }, (_, i) => ({
    datetime: new Date(hourStart - (7 - i) * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    open: String(1 + i / 1000), high: String(1.001 + i / 1000), low: String(.999 + i / 1000), close: String(1.0005 + i / 1000),
  }));
  const origFetch = global.fetch, oldKey = process.env.TWELVEDATA_API_KEY;
  let twelveDataCalls = 0;
  process.env.TWELVEDATA_API_KEY = 'display-only-test-key';
  global.fetch = async (url, opts) => {
    if (String(url).includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      twelveDataCalls++;
      return { ok: true, json: async () => ({ values: hourly }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_dashboard' });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pairs.length, 8, 'dashboard hanya memuat delapan pair yang dirender');
    assert.ok(res.body.pairs.every(p => p.available && p.display_only && p.source === 'Twelve Data (tampilan)'));
    assert.equal(twelveDataCalls, 8, 'satu cold load berada tepat pada batas kuota 8 RPM');
    assert.equal(store.strings['ohlcv:GC=F:1h'], undefined, 'fallback tampilan tidak boleh menulis cache evaluator');
  } finally {
    global.fetch = origFetch;
    if (oldKey === undefined) delete process.env.TWELVEDATA_API_KEY; else process.env.TWELVEDATA_API_KEY = oldKey;
  }
});

test('ohlcv_read: key H4 hilang dibentuk ulang dari candle H1 Deriv yang sama', async () => {
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const nowDay = Math.floor(Date.now() / 86400000) * 86400000;
  const h1 = Array.from({ length: 120 }, (_, i) => ({
    t: Math.floor((nowHour - (119 - i) * 3600000) / 1000), o: 4300 + i, h: 4302 + i, l: 4298 + i, c: 4301 + i, v: 0,
  }));
  const d1 = Array.from({ length: 30 }, (_, i) => ({
    t: Math.floor((nowDay - (29 - i) * 86400000) / 1000), o: 4100 + i, h: 4103 + i, l: 4097 + i, c: 4101 + i, v: 0,
  }));
  const store = makeStore({
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': JSON.stringify(h1),
    'ohlcv:GC=F:1d': JSON.stringify(d1),
    // Key ohlcv:GC=F:4h sengaja tidak ada.
  });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_read', query: { symbol: 'GC=F', label: 'XAU/USD' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.h1.available, true);
    assert.equal(res.body.h4.available, true);
    assert.equal(res.body.display_source, undefined, 'H4 turunan H1 tetap data Deriv, bukan fallback vendor');
  } finally { global.fetch = origFetch; }
});

test('ohlcv_read: snapshot Redis korup tidak membuat respons gagal; display fallback tetap jalan', async () => {
  const store = makeStore({
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': '{bukan-json',
    'ohlcv:GC=F:1d': '[]}',
  });
  const currentHour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const currentDay = new Date(Math.floor(Date.now() / 86400000) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const origFetch = global.fetch, oldKey = process.env.TWELVEDATA_API_KEY;
  process.env.TWELVEDATA_API_KEY = 'display-only-test-key';
  global.fetch = async (url, opts) => {
    if (String(url).includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      const values = String(url).includes('interval=1day')
        ? Array.from({ length: 30 }, (_, i) => ({ datetime: new Date(Date.parse(currentDay + 'Z') - (29 - i) * 86400000).toISOString().slice(0, 19).replace('T', ' '), open: '4300', high: '4302', low: '4298', close: '4301' }))
        : Array.from({ length: 120 }, (_, i) => ({ datetime: new Date(Date.parse(currentHour + 'Z') - (119 - i) * 3600000).toISOString().slice(0, 19).replace('T', ' '), open: '4300', high: '4302', low: '4298', close: '4301' }));
      return { ok: true, json: async () => ({ values }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_read', query: { symbol: 'GC=F', label: 'XAU/USD' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.d1.available, true);
    assert.equal(res.body.h4.available, true);
    assert.equal(res.body.h1.available, true);
  } finally {
    global.fetch = origFetch;
    if (oldKey === undefined) delete process.env.TWELVEDATA_API_KEY; else process.env.TWELVEDATA_API_KEY = oldKey;
  }
});

test('ohlcv_chart: snapshot korup tidak menghasilkan 500 dan tetap memakai fallback tampilan', async () => {
  const store = makeStore({
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': '{broken',
  });
  const currentHour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const origFetch = global.fetch, oldKey = process.env.TWELVEDATA_API_KEY;
  process.env.TWELVEDATA_API_KEY = 'display-only-test-key';
  global.fetch = async (url, opts) => {
    if (String(url).includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      return { ok: true, json: async () => ({ values: [{ datetime: currentHour, open: '4350', high: '4355', low: '4348', close: '4352' }] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const handler = loadHandler();
    const { req, res } = fakeReqRes({ action: 'ohlcv_chart', query: { symbol: 'GC=F', tf: '1h' } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.live_source, 'Twelve Data');
    assert.equal(res.body.candles.at(-1).c, 4352);
  } finally {
    global.fetch = origFetch;
    if (oldKey === undefined) delete process.env.TWELVEDATA_API_KEY; else process.env.TWELVEDATA_API_KEY = oldKey;
  }
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
