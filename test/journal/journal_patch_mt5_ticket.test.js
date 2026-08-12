// test/journal/journal_patch_mt5_ticket.test.js
// PATCH ?id= sekarang bisa menulis ulang mt5_ticket — dipakai jnReconcilePendingOrders()
// (index.html) saat MT5 memberi POSITION ticket yang berbeda dari ORDER ticket pending
// semula pada aktivasi (kasus nyata: EUR/AUD sudah OPEN di MT5 tapi jurnal macet
// "PENDING" karena ticket lama tidak pernah match ke posisi barunya).
const test = require('node:test');
const assert = require('node:assert/strict');
const journalHandler = require('../../api/journal.js');

function mockRedis() {
  const kv = new Map();
  return {
    kv,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, key, ...rest] = args;
      let result = null;
      if (cmd === 'SET') { kv.set(key, rest[0]); result = 'OK'; }
      else if (cmd === 'GET') { result = kv.has(key) ? kv.get(key) : null; }
      return { json: async () => ({ result }) };
    },
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

function withMockRedis(fn) {
  return async () => {
    const realFetch = global.fetch;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevAppKey = process.env.APP_KEY;
    delete process.env.APP_KEY;
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    const redis = mockRedis();
    global.fetch = redis.fetch;
    try { await fn(redis); }
    finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
      if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
    }
  };
}

const DEVICE = 'testdevice1';

function seedOpenEntry(redis, id, extra) {
  const key = `journal:${DEVICE}:${id}`;
  redis.kv.set(key, JSON.stringify({
    id, device_id: DEVICE, status: 'open', pair: 'EUR/AUD', direction: 'long',
    fill_state: 'pending', mt5_ticket: 111111, size_lots: 0.1,
    ...extra,
  }));
}

test('PATCH: mt5_ticket ikut ditulis ulang bareng fill_state (fallback match ganti ticket)', withMockRedis(async (redis) => {
  seedOpenEntry(redis, '1');
  const res = mockRes();
  await journalHandler({
    method: 'PATCH',
    query: { device_id: DEVICE, id: '1' },
    headers: {},
    body: { fill_state: 'filled', mt5_ticket: 222222 },
  }, res);
  assert.equal(res.statusCode, 200);
  const stored = JSON.parse(redis.kv.get(`journal:${DEVICE}:1`));
  assert.equal(stored.fill_state, 'filled');
  assert.equal(stored.mt5_ticket, 222222);
}));

test('PATCH: mt5_ticket tidak diikutkan di body -> ticket lama tetap dipertahankan', withMockRedis(async (redis) => {
  seedOpenEntry(redis, '2');
  const res = mockRes();
  await journalHandler({
    method: 'PATCH',
    query: { device_id: DEVICE, id: '2' },
    headers: {},
    body: { fill_state: 'cancelled' },
  }, res);
  assert.equal(res.statusCode, 200);
  const stored = JSON.parse(redis.kv.get(`journal:${DEVICE}:2`));
  assert.equal(stored.fill_state, 'cancelled');
  assert.equal(stored.mt5_ticket, 111111);
}));
