// test/feeds_retail.test.js
// Regresi untuk bug parseRetailPositions (Session 152): parser lama mengambil
// angka pertama di baris (kolom "Currency difference") sebagai long_pct,
// padahal kolom yang benar adalah "Percentage long" (indeks ke-2, 0-based).
// Fixture di bawah meniru struktur <thead>/<tr> asli forexbenchmark.com/quant/retail_positions/
// (diverifikasi manual 2026-07-10): Symbol | Currency difference | Percentage long | ...

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetailPositions, storeRetailHistory, retailHistoryHandler } = require('../api/feeds.js');

const FIXTURE_HTML = `
<table>
<thead>
<tr><th>Symbol</th><th>Currency difference</th><th>Percentage long</th><th>Percentage / max</th><th>Volume / max</th><th>Price distance / max</th></tr>
</thead>
<tbody>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/EURUSD">EURUSD</a></b></td><td style="color:#dd5050">-48.6</td><td style="color:#dd5050">19.6</td><td>0.82</td><td>0.04</td><td>0.43</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/AUDUSD">AUDUSD</a></b></td><td>-90.0</td><td>5.2</td><td>0.99</td><td>0.02</td><td>0.61</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/USDCHF">USDCHF</a></b></td><td>85.8</td><td>92.9</td><td>0.99</td><td>0.03</td><td>0.70</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/XAUUSD">XAUUSD</a></b></td><td>-6.0</td><td>44.0</td><td>0.61</td><td>0.05</td><td>0.58</td></tr>
</tbody>
</table>
`;

test('parseRetailPositions: membaca kolom "Percentage long", bukan "Currency difference"', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  assert.equal(positions.EURUSD.long_pct, 19.6, 'EURUSD long_pct harus 19.6 (bukan 48.6 dari kolom Currency difference)');
  assert.equal(positions.XAUUSD.long_pct, 44.0, 'XAUUSD long_pct harus 44.0 (bukan 6.0)');
});

test('parseRetailPositions: sinyal kontrarian dihitung dari long_pct yang benar', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  // AUDUSD long_pct sebenarnya 5.2 (retail mayoritas short) → harus CONTRARIAN_LONG,
  // parser lama malah membaca -90.0 → 90 → CONTRARIAN_SHORT (arah terbalik).
  assert.equal(positions.AUDUSD.signal, 'CONTRARIAN_LONG');
  assert.equal(positions.USDCHF.signal, 'CONTRARIAN_SHORT');
  // XAUUSD long_pct 44.0 ada di zona netral (35-65) → tidak boleh trigger sinyal apa pun,
  // parser lama membaca 6.0 dan salah men-trigger CONTRARIAN_LONG.
  assert.equal(positions.XAUUSD.signal, 'NEUTRAL');
});

test('parseRetailPositions: short_pct = 100 - long_pct', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  assert.equal(positions.EURUSD.short_pct, 80.4);
});

test('parseRetailPositions: baris tanpa pair dikenal diabaikan, tidak crash', () => {
  const positions = parseRetailPositions('<table><tbody><tr><td>Foo</td><td>1</td><td>2</td></tr></tbody></table>');
  assert.deepEqual(positions, {});
});

// ── retail_history (plan G2): round-trip store→read dengan mock Redis ─────────
// redisCmd bicara ke Upstash REST via fetch(REDIS_URL, {body: JSON [cmd,...]}) —
// mock in-memory di bawah meniru subset perintah yang dipakai (SET NX EX, ZADD NX,
// ZREMRANGEBYSCORE, ZRANGE WITHSCORES).

function mockRedis() {
  const kv = new Map();     // string keys (locks)
  const zsets = new Map();  // key → [{score, member}]
  return {
    kv, zsets,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, key, ...rest] = args;
      let result = null;
      if (cmd === 'SET') {
        const nx = rest.includes('NX');
        if (nx && kv.has(key)) result = null;
        else { kv.set(key, rest[0]); result = 'OK'; }
      } else if (cmd === 'ZADD') {
        // bentuk: ZADD key NX score member
        const [, score, member] = rest;
        const z = zsets.get(key) || [];
        if (!z.some(e => e.member === member)) z.push({ score: Number(score), member });
        zsets.set(key, z);
        result = 1;
      } else if (cmd === 'ZREMRANGEBYSCORE') {
        const [, max] = rest;
        const z = zsets.get(key) || [];
        const kept = z.filter(e => e.score > Number(max));
        zsets.set(key, kept);
        result = z.length - kept.length;
      } else if (cmd === 'ZRANGE') {
        const z = (zsets.get(key) || []).slice().sort((a, b) => a.score - b.score);
        result = z.flatMap(e => [e.member, String(e.score)]);
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

test('retail_history: round-trip store→read, lock harian mencegah duplikat', async () => {
  const realFetch = global.fetch;
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  const redis = mockRedis();
  global.fetch = redis.fetch;
  try {
    const positions = { EURUSD: { long_pct: 19.6, short_pct: 80.4, signal: 'CONTRARIAN_LONG' } };
    const day1 = new Date('2026-07-10T08:00:00Z').getTime();

    await storeRetailHistory(positions, day1);
    // Snapshot kedua di HARI YANG SAMA → lock menahan, tidak ada entry kedua
    await storeRetailHistory({ EURUSD: { long_pct: 25, short_pct: 75, signal: 'CONTRARIAN_LONG' } }, day1 + 3600000);
    assert.equal(redis.zsets.get('retail_history').length, 1, 'lock harian harus mencegah duplikat');

    // Hari berikutnya → entry baru masuk
    const day2 = new Date('2026-07-11T08:00:00Z').getTime();
    await storeRetailHistory(positions, day2);
    assert.equal(redis.zsets.get('retail_history').length, 2);

    const res = mockRes();
    await retailHistoryHandler({ query: { n: '5' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 2);
    assert.equal(res.body.history[0].day, '20260710', 'ascending: entry tertua duluan');
    assert.equal(res.body.history[1].day, '20260711');
    assert.equal(res.body.history[0].positions.EURUSD.long_pct, 19.6);
  } finally {
    global.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
  }
});

test('retail_history: rolling window 90 hari menghapus entry lama', async () => {
  const realFetch = global.fetch;
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  const redis = mockRedis();
  global.fetch = redis.fetch;
  try {
    const positions = { EURUSD: { long_pct: 50, short_pct: 50, signal: 'NEUTRAL' } };
    const old = new Date('2026-03-01T08:00:00Z').getTime();  // >90 hari sebelum "now"
    const now = new Date('2026-07-10T08:00:00Z').getTime();
    await storeRetailHistory(positions, old);
    await storeRetailHistory(positions, now);
    const members = redis.zsets.get('retail_history');
    assert.equal(members.length, 1, 'entry >90 hari harus terhapus saat store berikutnya');
    assert.equal(JSON.parse(members[0].member).day, '20260710');
  } finally {
    global.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
  }
});

test('retail_history: positions kosong → tidak menyimpan apa pun', async () => {
  const realFetch = global.fetch;
  const redis = mockRedis();
  global.fetch = redis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  try {
    await storeRetailHistory({});
    await storeRetailHistory(null);
    assert.equal(redis.zsets.size, 0);
    assert.equal(redis.kv.size, 0, 'lock pun tidak boleh dibuat utk data kosong');
  } finally {
    global.fetch = realFetch;
  }
});
