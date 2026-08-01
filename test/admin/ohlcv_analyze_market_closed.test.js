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

// Session 271 (2026-08-01): bug asli — cache ohlcv_analysis:<symbol> di-SET dengan TTL
// 6 jam, jadi analisa terakhir Jumat hangus dari Redis jauh sebelum market buka lagi
// Minggu malam/Senin, dan gate market_closed di atas jatuh ke cabang "belum ada cache"
// sepanjang sisa weekend. Guard di bawah memastikan TTL cukup panjang (>= 3 hari, lebih
// pendek dari itu tidak menutupi weekend penuh Jumat 21:00 UTC - Minggu 22:00 UTC).
test('ohlcv_analyze: TTL cache ohlcv_analysis cukup panjang untuk bertahan sepanjang weekend', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/admin.js'), 'utf8');
  const m = src.match(/redisCmd\('SET', `ohlcv_analysis:\$\{symbol\}`, JSON\.stringify\(resultPayload\), 'EX', (\d+)\)/);
  assert.ok(m, 'pola SET ohlcv_analysis tidak ditemukan di admin.js — cek apakah kode dipindah/diganti nama');
  const ttlSeconds = Number(m[1]);
  const THREE_DAYS = 3 * 24 * 3600;
  assert.ok(ttlSeconds >= THREE_DAYS, `TTL ${ttlSeconds}s < 3 hari — analisa Jumat bisa hangus sebelum market buka Senin`);
});

// mode=cached (dipakai auto-load XAU/USD, _autoLoadXauAnalysis di index.html) harus ikut
// menyertakan flag market_closed — sebelumnya hanya dihitung di jalur generate/manual,
// jadi auto-load tidak pernah tahu kapan harus menampilkan banner "pasar tutup".
test('ohlcv_analyze: mode=cached menyertakan market_closed:true saat pasar tutup', withMarketClosed(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const fakeAnalysis = { commentary: 'komentar penutupan Jumat', structured: null, model: 'sambanova', loaded_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ result: JSON.stringify(fakeAnalysis) }) });

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', mode: 'cached' } }, res);

    assert.equal(res.body.cached, true);
    assert.equal(res.body.market_closed, true);
    assert.equal(res.body.commentary, 'komentar penutupan Jumat');
  } finally {
    global.fetch = origFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}));

test('ohlcv_analyze: mode=cached market_closed:false saat pasar buka', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const fakeAnalysis = { commentary: 'komentar terkini', structured: null, model: 'sambanova', loaded_at: new Date().toISOString() };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ result: JSON.stringify(fakeAnalysis) }) });
  const marketHoursMod = require('../../api/_market_hours.js');
  const origIsOpen = marketHoursMod.isFxMarketOpen;
  marketHoursMod.isFxMarketOpen = () => true;

  try {
    delete require.cache[require.resolve('../../api/admin.js')];
    const handler = require('../../api/admin.js');
    const res = fakeRes();
    await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', mode: 'cached' } }, res);

    assert.equal(res.body.cached, true);
    assert.equal(res.body.market_closed, false);
  } finally {
    global.fetch = origFetch;
    marketHoursMod.isFxMarketOpen = origIsOpen;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
