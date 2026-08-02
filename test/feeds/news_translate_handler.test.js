// test/feeds/news_translate_handler.test.js
// Endpoint GET /api/feeds?type=news_translate&guids=... (S272, 2026-08-02) — baca-saja,
// MGET hasil translate yang sudah siap (lihat api/_news_translate.js untuk translate-nya
// sendiri, yang jalan fire-and-forget dari rssHandler, bukan endpoint ini).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newsTranslateHandler } = require('../../api/feeds.js');

function mockRedis() {
  const kv = new Map();
  return {
    kv,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, ...rest] = args;
      let result = null;
      if (cmd === 'MGET') result = rest.map(k => (kv.has(k) ? kv.get(k) : null));
      else if (cmd === 'GET') result = kv.has(rest[0]) ? kv.get(rest[0]) : null;
      return { json: async () => ({ result }) };
    },
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function withMockRedis(fn) {
  return async () => {
    const realFetch = global.fetch;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    const redis = mockRedis();
    global.fetch = redis.fetch;
    try { await fn(redis); } finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
    }
  };
}

test('newsTranslateHandler: kembalikan cuma guid yang ada cache-nya', withMockRedis(async (redis) => {
  redis.kv.set('news_tr:g1', JSON.stringify({ title_id: 'Judul satu', desc_id: '' }));
  const res = mockRes();
  await newsTranslateHandler({ query: { guids: 'g1,g2' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.translations, { g1: { title_id: 'Judul satu', desc_id: '' } });
  assert.equal('g2' in res.body.translations, false);
}));

test('newsTranslateHandler: guids kosong/tidak ada → objek kosong, tetap 200', withMockRedis(async () => {
  const res = mockRes();
  await newsTranslateHandler({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.translations, {});
}));

test('newsTranslateHandler: guids dibatasi 100 meski diminta lebih banyak (konsisten dengan cap client 100 item)', withMockRedis(async (redis) => {
  const guids = Array.from({ length: 150 }, (_, i) => `g${i}`);
  for (const g of guids) redis.kv.set(`news_tr:${g}`, JSON.stringify({ title_id: g, desc_id: '' }));
  const res = mockRes();
  await newsTranslateHandler({ query: { guids: guids.join(',') } }, res);
  assert.equal(Object.keys(res.body.translations).length, 100);
}));
