// test/admin/ohlcv_analyze_market_closed.test.js — PLAN T-1 langkah 3 (2026-07-19):
// gate market-tutup di ohlcvAnalyzeHandler harus menyajikan cache ohlcv_analysis:<symbol>
// (atau pesan jelas kalau belum ada cache) TANPA memanggil AI, meliputi cron GH Actions,
// daemon VPS, maupun klik manual (semuanya lewat handler yang sama).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours.js');

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

function withMarketClosed(fn) {
  return async () => {
    const origIsOpen = marketHours.isFxMarketOpen;
    marketHours.isFxMarketOpen = () => false;
    try { await fn(); } finally { marketHours.isFxMarketOpen = origIsOpen; }
  };
}

test('ohlcv_analyze: pasar tutup + ada cache -> cache disajikan, market_closed:true, TANPA fetch AI', withMarketClosed(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const fakeAnalysis = { commentary: 'komentar penutupan Jumat', structured: null, model: 'sambanova', loaded_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ result: JSON.stringify(fakeAnalysis) }) };
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    // x-vercel-cron: bypass rate-limit Redis round-trip yang tidak relevan buat test ini
    // (gate market-tutup sendiri tidak peduli cron/manual, lihat kode admin.js).
    await handler({ headers: { 'x-vercel-cron': '1' }, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD' } }, res);

    assert.equal(res.body.market_closed, true);
    assert.equal(res.body.cached, true);
    assert.equal(res.body.commentary, 'komentar penutupan Jumat');
    assert.equal(calls.length, 1, 'hanya 1x GET Redis — tidak boleh lanjut ke loadOhlcvData/AI');
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}));

test('ohlcv_analyze: pasar tutup + belum ada cache -> pesan jelas, bukan silent fail', withMarketClosed(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ result: null }) };
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ headers: { 'x-vercel-cron': '1' }, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'EUR/USD', label: 'EUR/USD' } }, res);

    assert.equal(res.body.market_closed, true);
    assert.equal(res.body.cached, false);
    assert.equal(res.body.commentary, null);
    assert.ok(res.body.error && res.body.error.length > 0, 'harus ada pesan error, bukan silent fail');
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}));
