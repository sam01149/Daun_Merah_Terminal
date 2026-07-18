// test/cron_dedup.test.js — Plan Q-6 fix (2026-07-18 lanjutan 4): market-digest
// & ohlcv_analyze diasumsikan "cron cuma 1 sumber" sebelum vps/daemon.js ikut
// memicu keduanya paralel dengan GitHub Actions. Tanpa dedup ini, AI dipanggil
// 2x per slot + push notifikasi dobel. api/_cron_dedup.js diekstrak supaya
// logikanya bisa dites tanpa mock Redis/handler penuh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCronCall, isCronDedupFresh } = require('../api/_cron_dedup.js');

function fakeReq(headers) { return { headers }; }

// ── isCronCall ───────────────────────────────────────────────────────────────

test('isCronCall: x-vercel-cron selalu dianggap cron, tanpa perlu CRON_SECRET', () => {
  delete process.env.CRON_SECRET;
  assert.equal(isCronCall(fakeReq({ 'x-vercel-cron': '1' })), true);
});

test('isCronCall: x-cron-secret / x-admin-secret cocok CRON_SECRET -> true', () => {
  process.env.CRON_SECRET = 'rahasia-cron';
  assert.equal(isCronCall(fakeReq({ 'x-cron-secret': 'rahasia-cron' })), true);
  assert.equal(isCronCall(fakeReq({ 'x-admin-secret': 'rahasia-cron' })), true);
  delete process.env.CRON_SECRET;
});

test('isCronCall: secret salah atau CRON_SECRET belum diset -> false (bukan crash)', () => {
  process.env.CRON_SECRET = 'rahasia-cron';
  assert.equal(isCronCall(fakeReq({ 'x-cron-secret': 'salah' })), false);
  delete process.env.CRON_SECRET;
  assert.equal(isCronCall(fakeReq({ 'x-cron-secret': 'apa-saja' })), false, 'tanpa CRON_SECRET server, tidak ada yang bisa cocok');
  assert.equal(isCronCall(fakeReq({})), false);
});

// ── isCronDedupFresh ─────────────────────────────────────────────────────────

test('isCronDedupFresh: umur di dalam window -> true (sumber cron kedua di-dedup)', () => {
  const now = 1_000_000_000_000;
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  assert.equal(isCronDedupFresh(fiveMinAgo, now, 30 * 60 * 1000), true);
});

test('isCronDedupFresh: umur di luar window -> false (generate ulang, bukan dedup)', () => {
  const now = 1_000_000_000_000;
  const fortyMinAgo = new Date(now - 40 * 60 * 1000).toISOString();
  assert.equal(isCronDedupFresh(fortyMinAgo, now, 30 * 60 * 1000), false);
});

test('isCronDedupFresh: tepat di batas window -> false (window eksklusif, age < windowMs bukan <=)', () => {
  const now = 1_000_000_000_000;
  const exactlyAtWindow = new Date(now - 30 * 60 * 1000).toISOString();
  assert.equal(isCronDedupFresh(exactlyAtWindow, now, 30 * 60 * 1000), false);
});

test('isCronDedupFresh: timestamp kosong/null/rusak -> false, bukan crash', () => {
  const now = 1_000_000_000_000;
  assert.equal(isCronDedupFresh(null, now, 30 * 60 * 1000), false);
  assert.equal(isCronDedupFresh(undefined, now, 30 * 60 * 1000), false);
  assert.equal(isCronDedupFresh('bukan-tanggal-valid', now, 30 * 60 * 1000), false);
  assert.equal(isCronDedupFresh('', now, 30 * 60 * 1000), false);
});

test('isCronDedupFresh: timestamp di MASA DEPAN (clock skew/data korup) -> false, bukan diam-diam dianggap fresh', () => {
  const now = 1_000_000_000_000;
  const futureTs = new Date(now + 60 * 1000).toISOString();
  assert.equal(isCronDedupFresh(futureTs, now, 30 * 60 * 1000), false);
});

// ── Integrasi: handler asli benar-benar short-circuit saat cache masih fresh ──
// (Skenario "cache basi -> lanjut generate" SENGAJA tidak diuji di sini — itu
// jalur kode existing yang tidak diubah patch ini, butuh mock RSS/AI provider
// penuh untuk ditelusuri sampai selesai; cakupannya ada di test lain yang
// sudah menguji alur generate market-digest/ohlcv_analyze secara normal.)

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

test('integrasi market-digest: cron kedua dengan latest_article masih fresh -> cron_dedup, TIDAK ada fetch lain', async () => {
  delete process.env.APP_KEY; // gate APP_KEY fail-open, tidak relevan buat test ini
  process.env.CRON_SECRET = 'rahasia-cron';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const fakeArticle = { article: 'artikel lama', method: 'sambanova', generated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ result: JSON.stringify(fakeArticle) }) };
  };

  try {
    const handler = require('../api/market-digest.js');
    const res = fakeRes();
    await handler({ headers: { 'x-cron-secret': 'rahasia-cron' }, method: 'GET', query: {} }, res);

    assert.equal(res.body.from_cache, 'cron_dedup');
    assert.equal(res.body.article, 'artikel lama');
    assert.equal(res.body.thesis_alerts, null);
    assert.equal(calls.length, 1, 'harus berhenti setelah 1x GET latest_article — tidak boleh lanjut ke RSS/AI (itu tandanya dedup gagal short-circuit)');
  } finally {
    global.fetch = origFetch;
    delete process.env.CRON_SECRET;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test('integrasi ohlcv_analyze: cron kedua dengan ohlcv_analysis:<symbol> masih fresh -> cron dedup, TIDAK ada fetch lain', async () => {
  delete process.env.APP_KEY;
  process.env.CRON_SECRET = 'rahasia-cron';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  const fakeAnalysis = { commentary: 'komentar lama', structured: null, model: 'sambanova', loaded_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ result: JSON.stringify(fakeAnalysis) }) };
  };

  try {
    const handler = require('../api/admin.js');
    const res = fakeRes();
    await handler({ headers: { 'x-cron-secret': 'rahasia-cron' }, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD' } }, res);

    assert.equal(res.body.from_cron_dedup, true);
    assert.equal(res.body.commentary, 'komentar lama');
    assert.equal(calls.length, 1, 'harus berhenti setelah 1x GET ohlcv_analysis:<symbol> — tidak boleh lanjut ke loadOhlcvData/AI');
  } finally {
    global.fetch = origFetch;
    delete process.env.CRON_SECRET;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
