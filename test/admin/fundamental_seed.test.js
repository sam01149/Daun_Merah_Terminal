// test/admin/fundamental_seed.test.js
// Plan W-3/W-4 temuan 3 (2026-08-03): fundamentalSeedHandler dulu SELALU full-reseed
// semua currency — aman dipakai pertama kali, tapi berbahaya dipakai menambal 1
// field yang drift (mis. AUD.GDP QoQ) karena akan menimpa balik indikator LAIN di
// currency yang sama yang sudah ter-update live dari berita asli. Test ini
// memverifikasi: (1) tanpa param tetap full-reseed (backward-compatible), (2)
// dengan ?currency=&key= HANYA field itu yang ditulis, (3) seeded_at selalu
// disuntik supaya _fundSeedAgeDays (Plan W-3) bisa menghitung umur data seed.
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

function fakeReqRes({ action, method = 'POST', headers = {}, query = {} } = {}) {
  const req = { method, query: { action, ...query }, headers, url: `/api/admin?action=${action}` };
  return { req, res: fakeRes() };
}

async function withEnv(vars, fn) {
  const keys = ['CRON_SECRET'];
  const prev = {};
  for (const k of keys) { prev[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally {
    for (const k of keys) { delete process.env[k]; if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

function redisFetchStub(calls) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args);
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
}

test('fundamental_seed: tanpa param -> full reseed semua currency (backward-compatible)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(calls);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({ action: 'fundamental_seed', headers: { 'x-admin-secret': 'topsecret' } });
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.scoped, false);
      assert.ok(res.body.seeded.length > 5, 'harus menulis banyak currency (full reseed)');
      const audCall = calls.find(a => a[1] === 'fundamental:AUD');
      assert.ok(audCall, 'AUD harus ikut ditulis saat full reseed');
      assert.ok(audCall.length > 4, 'HSET AUD harus bawa banyak field (bukan cuma 1)');
    } finally { global.fetch = origFetch; }
  });
});

test('fundamental_seed: ?currency=AUD&key=GDP QoQ -> HANYA field itu yang ditulis (tidak sentuh indikator AUD lain)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(calls);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({
        action: 'fundamental_seed',
        headers: { 'x-admin-secret': 'topsecret' },
        query: { currency: 'AUD', key: 'GDP QoQ' },
      });
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.scoped, true);
      assert.deepEqual(res.body.seeded, ['AUD']);
      assert.equal(calls.length, 1, 'cuma 1 panggilan HSET (1 currency)');
      const [cmd, hashKey, field, valueJson] = calls[0];
      assert.equal(cmd, 'HSET');
      assert.equal(hashKey, 'fundamental:AUD');
      assert.equal(field, 'GDP QoQ');
      const value = JSON.parse(valueJson);
      assert.equal(value.actual, '0.3%');
      assert.ok(value.seeded_at, 'seeded_at harus disuntik ke value yang ditulis');
    } finally { global.fetch = origFetch; }
  });
});

test('fundamental_seed: currency lain (bukan yang di-scope) TIDAK ikut ditulis', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(calls);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({
        action: 'fundamental_seed',
        headers: { 'x-admin-secret': 'topsecret' },
        query: { currency: 'AUD', key: 'GDP QoQ' },
      });
      await handler(req, res);
      assert.equal(calls.some(a => a[1] !== 'fundamental:AUD'), false);
    } finally { global.fetch = origFetch; }
  });
});

test('fundamental_seed: tanpa secret -> 401, tidak ada HSET terpanggil', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(calls);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({ action: 'fundamental_seed', headers: {} });
      await handler(req, res);
      assert.equal(res.statusCode, 401);
      assert.equal(calls.length, 0);
    } finally { global.fetch = origFetch; }
  });
});
