// test/admin/ohlcv_sync_cron_dedup.test.js — Plan V-2 (2026-07-20): ohlcv_sync
// dipicu 2x/jam tanpa saling tahu — GH Actions ohlcv-sync.yml (menit :00) DAN
// Railway daemon Q-6 (menit :05) — keduanya full fetch Deriv+Yahoo/TwelveData
// ~15 pair + Redis write + TA-warm, sia-sia karena datanya identik. Test ini
// membuktikan pemicu KEDUA dalam window 45 menit jadi no-op murah (nol fetch),
// pemicu di luar window/gagal tetap sync penuh seperti sebelumnya (fail-open).
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

function redisBody(opts) { return JSON.parse(opts.body); }

test('ohlcv_sync: cron kedua dalam window 45 menit -> skip total, TIDAK ada fetch lain', async () => {
  process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  const freshTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    const body = redisBody(opts);
    if (body[0] === 'GET' && body[1] === 'ohlcv_sync:last_run_at') {
      return { json: async () => ({ result: freshTs }) };
    }
    throw new Error('unhandled call in test mock: ' + JSON.stringify(body));
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ method: 'GET', query: { action: 'ohlcv_sync' }, headers: { 'x-vercel-cron': '1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.reason, 'cron_dedup');
    assert.equal(res.body.synced_at, freshTs);
    assert.equal(calls.length, 1, 'harus berhenti setelah 1x GET ohlcv_sync:last_run_at — tidak boleh lanjut fetch Yahoo/Deriv/TA-warm');
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test('ohlcv_sync: last_run_at basi (>45 menit) -> sync penuh jalan & marker baru ditulis', async () => {
  process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.TWELVEDATA_API_KEY = 'dummy-key-test';
  const staleTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const setCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === 'https://fake-redis.test') {
      const body = redisBody(opts);
      if (body[0] === 'GET' && body[1] === 'ohlcv_sync:last_run_at') return { json: async () => ({ result: staleTs }) };
      if (body[0] === 'SET' && body[1] === 'ohlcv_sync:last_run_at') { setCalls.push(body[2]); return { json: async () => ({ result: 'OK' }) }; }
      return { json: async () => ({ result: null }) }; // latest_thesis GET, ohlcv:*:1h/4h/1d/source SET
    }
    if (u.includes('query1.finance.yahoo.com')) throw new Error('simulated Yahoo outage');
    if (u.includes('api.twelvedata.com')) {
      return {
        status: 200,
        json: async () => ({
          status: 'ok',
          values: [
            { datetime: '2026-07-20 01:00:00', open: '1.0850', high: '1.0860', low: '1.0840', close: '1.0855', volume: '100' },
            { datetime: '2026-07-20 02:00:00', open: '1.0855', high: '1.0865', low: '1.0845', close: '1.0860', volume: '120' },
          ],
        }),
      };
    }
    if (u.includes('/api/correlations')) throw new Error('ta-warm fan-out — allSettled, boleh gagal di test ini');
    throw new Error('unhandled URL in test mock: ' + u);
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ method: 'GET', query: { action: 'ohlcv_sync' }, headers: { 'x-vercel-cron': '1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!res.body.skipped, 'marker basi tidak boleh memicu skip');
    assert.ok(res.body.synced.length > 0, 'harus ada pair yang berhasil sync via fallback Twelve Data');
    assert.equal(setCalls.length, 1, 'marker ohlcv_sync:last_run_at harus ditulis ulang setelah sync sukses');
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.TWELVEDATA_API_KEY;
  }
});

test('ohlcv_sync: GET ohlcv_sync:last_run_at gagal (Redis error) -> fail-open, tetap sync', async () => {
  process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.TWELVEDATA_API_KEY = 'dummy-key-test';

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === 'https://fake-redis.test') {
      const body = redisBody(opts);
      if (body[0] === 'GET' && body[1] === 'ohlcv_sync:last_run_at') throw new Error('simulated Redis GET failure');
      return { json: async () => ({ result: null }) };
    }
    if (u.includes('query1.finance.yahoo.com')) throw new Error('simulated Yahoo outage');
    if (u.includes('api.twelvedata.com')) {
      return {
        status: 200,
        json: async () => ({ status: 'ok', values: [
          { datetime: '2026-07-20 01:00:00', open: '1.0850', high: '1.0860', low: '1.0840', close: '1.0855', volume: '100' },
          { datetime: '2026-07-20 02:00:00', open: '1.0855', high: '1.0865', low: '1.0845', close: '1.0860', volume: '120' },
        ] }),
      };
    }
    if (u.includes('/api/correlations')) throw new Error('ta-warm fan-out — allSettled, boleh gagal di test ini');
    throw new Error('unhandled URL in test mock: ' + u);
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ method: 'GET', query: { action: 'ohlcv_sync' }, headers: { 'x-vercel-cron': '1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!res.body.skipped, 'cek dedup yang error sendiri tidak boleh menahan sync (fail-open)');
    assert.ok(res.body.synced.length > 0);
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.TWELVEDATA_API_KEY;
  }
});

test('ohlcv_sync: Yahoo+TwelveData mati untuk pair non-Deriv, pair Deriv di-skip (bukan fallback) -> hanya pair non-Deriv yang gagal', async () => {
  // REVISI 2026-08-13 (Session 313): dulu test ini simulasi "gagal total semua pair"
  // (synced kosong) karena Deriv gagal -> Yahoo gagal -> TwelveData gagal, satu rantai
  // panjang yang semuanya throw. Sekarang pair primary Deriv (9 dari 11 di
  // OHLCV_FIXED_PAIRS) TIDAK LAGI fallback ke Yahoo/TwelveData kalau Deriv gagal —
  // mereka di-skip (cache lama dipakai, tidak throw, tetap masuk `synced` dengan
  // `skipped:true`). Hanya AUD/NZD & CHF/JPY (Yahoo-only, tidak ada di Deriv map)
  // yang benar-benar gagal total di skenario Yahoo+TwelveData mati ini.
  process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete process.env.TWELVEDATA_API_KEY; // fetchFallbackCandles langsung throw tanpa key
  delete process.env.DERIV_APP_ID; // fetchDerivCandles langsung throw tanpa app_id -> semua pair Deriv di-skip

  const setCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === 'https://fake-redis.test') {
      const body = redisBody(opts);
      if (body[0] === 'GET' && body[1] === 'ohlcv_sync:last_run_at') return { json: async () => ({ result: null }) };
      if (body[0] === 'SET' && body[1] === 'ohlcv_sync:last_run_at') setCalls.push(body[2]);
      return { json: async () => ({ result: null }) };
    }
    if (u.includes('query1.finance.yahoo.com')) throw new Error('simulated Yahoo outage');
    throw new Error('simulated total outage: ' + u); // Binance PAXG (GC=F) & lainnya juga gagal
  };

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ method: 'GET', query: { action: 'ohlcv_sync' }, headers: { 'x-vercel-cron': '1' } }, res);

    assert.equal(res.statusCode, 200);
    // 9 pair primary Deriv di-skip (bukan gagal) -> masuk synced dengan skipped:true.
    const skipped = res.body.synced.filter(s => s.skipped);
    assert.equal(skipped.length, 9, '9 pair primary Deriv harus di-skip, bukan fallback ke Yahoo/TwelveData');
    assert.ok(skipped.every(s => s.source1h === 'skipped_deriv_down'));
    // AUD/NZD & CHF/JPY (Yahoo-only) benar-benar gagal karena Yahoo DAN TwelveData mati.
    assert.equal(res.body.failed.length, 2);
    assert.deepEqual(res.body.failed.map(f => f.symbol).sort(), ['AUDNZD=X', 'CHFJPY=X']);
    assert.equal(setCalls.length, 1, 'ada 9 pair yang "synced" (walau cuma skip) -> marker tetap ditulis');
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
