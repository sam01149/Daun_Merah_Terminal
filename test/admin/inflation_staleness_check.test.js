// test/admin/inflation_staleness_check.test.js
// Reminder mingguan (2026-08-15, audit efisiensi Redis) — admin.js?action=
// inflation_staleness_check membaca INFLATION_EXPECTATIONS (real-yields.js),
// alert Telegram begitu ada currency lewat ambang stale 90 hari, dedup per as_of.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  delete require.cache[require.resolve('../../api/real-yields.js')];
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

function fakeReqRes(headers = {}) {
  const req = { method: 'GET', query: { action: 'inflation_staleness_check' }, headers, url: '/api/admin?action=inflation_staleness_check' };
  return { req, res: fakeRes() };
}

// Bedakan target Redis (Upstash) vs Telegram lewat URL — dua-duanya lewat global.fetch.
function fetchStub(store, telegramCalls) {
  return async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      telegramCalls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const args = JSON.parse(opts.body);
    const [cmd, key, value] = args;
    if (cmd === 'GET') return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null }) };
    if (cmd === 'SET') { store[key] = value; return { ok: true, json: async () => ({ result: 'OK' }) }; }
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
}

async function withEnv(fn) {
  const keys = ['CRON_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.CRON_SECRET = 'test-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat-id';
  try { return await fn(); } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('inflation_staleness_check: tanpa x-cron-secret -> 401', async () => {
  const handler = loadHandler();
  const { req, res } = fakeReqRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('inflation_staleness_check: currency lewat 90 hari -> masuk daftar stale + alert + dedup tersimpan', async () => {
  await withEnv(async () => {
    const handler = loadHandler();
    const store = {};
    const telegramCalls = [];
    const origFetch = global.fetch;
    global.fetch = fetchStub(store, telegramCalls);
    try {
      const { req, res } = fakeReqRes({ 'x-cron-secret': 'test-secret' });
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      // GBP/AUD sudah lewat 90 hari per data hardcoded saat ini (as_of Mei 2026, jauh di belakang "sekarang").
      assert.ok(res.body.stale.includes('GBP'), `GBP harus terdeteksi stale, dapat: ${JSON.stringify(res.body.stale)}`);
      assert.ok(res.body.alerted.includes('GBP'), 'GBP harus masuk daftar alerted (belum pernah dialert)');
      assert.equal(telegramCalls.length, 1, 'harus kirim tepat 1 pesan Telegram gabungan, bukan per-currency');
      assert.ok(store['inflation_stale_alerted:GBP'], 'dedup key harus tersimpan setelah alert');
    } finally { global.fetch = origFetch; }
  });
});

test('inflation_staleness_check: as_of sama sudah pernah dialert -> tidak alert ulang', async () => {
  await withEnv(async () => {
    const handler = loadHandler();
    const { INFLATION_EXPECTATIONS } = require('../../api/real-yields.js');
    const store = { 'inflation_stale_alerted:GBP': INFLATION_EXPECTATIONS.GBP.as_of };
    const telegramCalls = [];
    const origFetch = global.fetch;
    global.fetch = fetchStub(store, telegramCalls);
    try {
      const { req, res } = fakeReqRes({ 'x-cron-secret': 'test-secret' });
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.stale.includes('GBP'), 'GBP tetap terhitung stale di ringkasan');
      assert.ok(!res.body.alerted.includes('GBP'), 'GBP TIDAK boleh masuk alerted karena as_of sama sudah pernah dicatat');
    } finally { global.fetch = origFetch; }
  });
});
