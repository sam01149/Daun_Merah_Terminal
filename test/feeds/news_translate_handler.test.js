// test/feeds/news_translate_handler.test.js
// Endpoint GET /api/feeds?type=news_translate&guids=... (S272, 2026-08-02) — baca-saja,
// MGET hasil translate yang sudah siap (lihat api/_news_translate.js untuk translate-nya
// sendiri, yang jalan fire-and-forget dari rssHandler, bukan endpoint ini).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newsTranslateHandler, newsHistoryHandler, storeNewsHistory } = require('../../api/feeds.js');

function mockRedis() {
  const kv = new Map();
  const zsets = new Map();
  return {
    kv, zsets,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, key, ...rest] = args;
      let result = null;
      if (cmd === 'MGET') result = [key, ...rest].map(k => (kv.has(k) ? kv.get(k) : null));
      else if (cmd === 'GET') result = kv.has(key) ? kv.get(key) : null;
      else if (cmd === 'SET') { kv.set(key, rest[0]); result = 'OK'; }
      else if (cmd === 'ZADD') {
        const pairs = rest[0] === 'NX' ? rest.slice(1) : rest;
        const z = zsets.get(key) || [];
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          const score = pairs[i], member = pairs[i + 1];
          if (!z.some(e => e.member === member)) { z.push({ score: Number(score), member }); added++; }
        }
        zsets.set(key, z);
        result = added;
      } else if (cmd === 'ZREMRANGEBYSCORE') {
        const [, max] = rest;
        const z = zsets.get(key) || [];
        const kept = z.filter(e => e.score > Number(max));
        zsets.set(key, kept);
        result = z.length - kept.length;
      } else if (cmd === 'ZREVRANGEBYSCORE') {
        const [maxRaw, minRaw, limitFlag, offsetRaw, countRaw] = rest;
        const exclusive = typeof maxRaw === 'string' && maxRaw.startsWith('(');
        const maxVal = maxRaw === '+inf' ? Infinity : Number(exclusive ? maxRaw.slice(1) : maxRaw);
        const minVal = minRaw === '-inf' ? -Infinity : Number(minRaw);
        let z = (zsets.get(key) || []).filter(e => e.score >= minVal && (exclusive ? e.score < maxVal : e.score <= maxVal));
        z = z.slice().sort((a, b) => b.score - a.score);
        if (limitFlag === 'LIMIT') {
          const offset = Number(offsetRaw), count = Number(countRaw);
          z = z.slice(offset, offset + count);
        }
        result = z.map(e => e.member);
      }
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

// ── newsHistoryHandler ikut translate item arsip (S272 lanj., 2026-08-02) ───
// Item yang sudah lewat dari jendela live RSS tidak pernah sempat diterjemahkan
// (lihat api/_news_translate.js) — "Muat Berita Lebih Lama" sekarang jadi
// kesempatan kedua supaya arsip 36 jam juga ikut tercover, bukan cuma live feed.
test('newsHistoryHandler: item arsip yang belum diterjemahkan ikut ditembak ke Gemini', withMockRedis(async (redis) => {
  const realFetch = global.fetch;
  let geminiCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'JUDUL_ID: Terjemahan arsip' } }] }) };
    }
    return redis.fetch(url, opts);
  };
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-key';
  try {
    const now = new Date('2026-08-02T09:00:00Z').getTime();
    const xml = `<rss><channel><item><title>Old archived headline about trade talks</title><guid>hist-1</guid><pubDate>${new Date(now).toUTCString()}</pubDate><link>https://example.com/hist-1</link></item></channel></rss>`;
    await storeNewsHistory(xml, now);

    const res = mockRes();
    await newsHistoryHandler({ query: { before: String(now + 1), limit: '10' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items[0].guid, 'hist-1');
    assert.equal(geminiCalls, 1, 'item arsip yang belum punya news_tr:<guid> harus ditembak ke Gemini');
    assert.equal(redis.kv.has('news_tr:hist-1'), true, 'hasil translate arsip harus tersimpan sama seperti live feed');
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey;
  }
}));

test('newsHistoryHandler: item arsip yang SUDAH punya terjemahan tidak ditembak ulang', withMockRedis(async (redis) => {
  const realFetch = global.fetch;
  let geminiCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) { geminiCalls++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'JUDUL_ID: X' } }] }) }; }
    return redis.fetch(url, opts);
  };
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-key';
  try {
    const now = new Date('2026-08-02T09:00:00Z').getTime();
    const xml = `<rss><channel><item><title>Already translated archived headline</title><guid>hist-2</guid><pubDate>${new Date(now).toUTCString()}</pubDate><link>https://example.com/hist-2</link></item></channel></rss>`;
    await storeNewsHistory(xml, now);
    redis.kv.set('news_tr:hist-2', JSON.stringify({ title_id: 'Sudah diterjemahkan', desc_id: '' }));

    const res = mockRes();
    await newsHistoryHandler({ query: { before: String(now + 1), limit: '10' } }, res);
    assert.equal(geminiCalls, 0);
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey;
  }
}));
