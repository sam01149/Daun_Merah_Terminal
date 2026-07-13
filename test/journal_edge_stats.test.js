// test/journal_edge_stats.test.js
// "Edge per Kondisi Checklist" (session 162) — jawab "kondisi checklist mana yang
// beneran ngasih edge?" dari data trade closed asli. Dua hal diregresi-test:
// 1. sanitizeChecklistSnapshot: whitelist ketat atas payload client (bukan objek/array
//    liar, cap 40 key, key panjang, coerce ke boolean) — mencegah payload malformed
//    merusak agregasi atau membengkak storage.
// 2. GET ?action=edge_stats: win-rate/expectancy per kondisi checklist (tercentang vs
//    tidak), gate sampel minimum (MIN_TOTAL/MIN_BUCKET), dan urutan hasil (delta
//    expectancy terbesar dulu).
const test = require('node:test');
const assert = require('node:assert/strict');
const journalHandler = require('../api/journal.js');
const { _sanitizeChecklistSnapshot: sanitizeChecklistSnapshot } = journalHandler;

// ── sanitizeChecklistSnapshot: pure function ──────────────────────────────

test('sanitizeChecklistSnapshot: null/non-object/array -> null', () => {
  assert.equal(sanitizeChecklistSnapshot(null), null);
  assert.equal(sanitizeChecklistSnapshot(undefined), null);
  assert.equal(sanitizeChecklistSnapshot('rc1'), null);
  assert.equal(sanitizeChecklistSnapshot(['rc1']), null);
  assert.equal(sanitizeChecklistSnapshot({}), null);
});

test('sanitizeChecklistSnapshot: coerce ke boolean, drop key kosong/kepanjangan', () => {
  const out = sanitizeChecklistSnapshot({
    rc1: true, rc2: false, rc3: 'truthy-string', rc4: 0,
    '': true, // key kosong, ditolak
    ['x'.repeat(41)]: true, // key >40 char, ditolak
  });
  assert.deepEqual(out, { rc1: true, rc2: false, rc3: true, rc4: false });
});

test('sanitizeChecklistSnapshot: cap di 40 key', () => {
  const input = {};
  for (let i = 0; i < 60; i++) input[`item${i}`] = true;
  const out = sanitizeChecklistSnapshot(input);
  assert.equal(Object.keys(out).length, 40);
});

// ── GET ?action=edge_stats: mock Redis (pola sama dengan test/news_history.test.js) ──

function mockRedis() {
  const kv = new Map();
  const zsets = new Map();
  return {
    kv, zsets,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, key, ...rest] = args;
      let result = null;
      if (cmd === 'SET') {
        kv.set(key, rest[0]);
        result = 'OK';
      } else if (cmd === 'GET') {
        result = kv.has(key) ? kv.get(key) : null;
      } else if (cmd === 'MGET') {
        result = [key, ...rest].map(k => (kv.has(k) ? kv.get(k) : null));
      } else if (cmd === 'ZADD') {
        const [score, member] = rest;
        const z = zsets.get(key) || [];
        const existing = z.find(e => e.member === member);
        if (existing) existing.score = Number(score); else z.push({ score: Number(score), member });
        zsets.set(key, z);
        result = existing ? 0 : 1;
      } else if (cmd === 'ZRANGE') {
        const [startRaw, stopRaw, revFlag] = rest;
        let z = (zsets.get(key) || []).slice().sort((a, b) => a.score - b.score);
        if (revFlag === 'REV') z = z.reverse();
        const start = Number(startRaw), stop = Number(stopRaw);
        const end = stop === -1 ? z.length : stop + 1;
        result = z.slice(start, end).map(e => e.member);
      } else if (cmd === 'SADD') {
        result = 1; // not exercised by these tests
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
  res.end = () => res;
  return res;
}

function withMockRedis(fn) {
  return async () => {
    const realFetch = global.fetch;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevAppKey = process.env.APP_KEY;
    delete process.env.APP_KEY; // gate fail-open — lihat api/_app_key.js
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    const redis = mockRedis();
    global.fetch = redis.fetch;
    try {
      await fn(redis);
    } finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
      if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
    }
  };
}

const DEVICE = 'testdevice1';

// Seed a closed journal entry directly into the mock store — bypasses POST/PATCH
// lifecycle to keep the aggregation test focused on edge_stats math itself.
function seedClosedEntry(redis, id, { checklistSnapshot, rActual }) {
  const key = `journal:${DEVICE}:${id}`;
  redis.kv.set(key, JSON.stringify({
    id, device_id: DEVICE, status: 'closed', r_actual: rActual,
    checklist_snapshot: checklistSnapshot,
  }));
  const zkey = `journal_index:${DEVICE}`;
  const z = redis.zsets.get(zkey) || [];
  z.push({ score: Number(id), member: id });
  redis.zsets.set(zkey, z);
}

test('edge_stats: kurang dari MIN_TOTAL (5) trade closed+checklist -> insufficient_data', withMockRedis(async (redis) => {
  seedClosedEntry(redis, '1', { checklistSnapshot: { rc1: true }, rActual: 1 });
  seedClosedEntry(redis, '2', { checklistSnapshot: { rc1: false }, rActual: -1 });

  const res = mockRes();
  await journalHandler({ method: 'GET', query: { device_id: DEVICE, action: 'edge_stats' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.insufficient_data, true);
  assert.equal(res.body.sample_count, 2);
}));

test('edge_stats: kondisi dengan sampel cukup di kedua sisi -> win-rate/avg_r/delta benar, sorted by |delta| desc', withMockRedis(async (redis) => {
  // rc1 tercentang: 3 win besar (avg +2R) | rc1 tidak: 3 loss (avg -1R) -> delta besar
  seedClosedEntry(redis, '1', { checklistSnapshot: { rc1: true,  rc2: true  }, rActual: 2 });
  seedClosedEntry(redis, '2', { checklistSnapshot: { rc1: true,  rc2: false }, rActual: 2 });
  seedClosedEntry(redis, '3', { checklistSnapshot: { rc1: true,  rc2: true  }, rActual: 2 });
  seedClosedEntry(redis, '4', { checklistSnapshot: { rc1: false, rc2: false }, rActual: -1 });
  seedClosedEntry(redis, '5', { checklistSnapshot: { rc1: false, rc2: true  }, rActual: -1 });
  seedClosedEntry(redis, '6', { checklistSnapshot: { rc1: false, rc2: false }, rActual: -1 });
  // rc2 tercentang: [2,2,-1] avg 1R | rc2 tidak: [2,-1,-1] avg 0R -> delta kecil dari rc1

  const res = mockRes();
  await journalHandler({ method: 'GET', query: { device_id: DEVICE, action: 'edge_stats' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.insufficient_data, false);
  assert.equal(res.body.sample_count, 6);
  assert.equal(res.body.conditions.length, 2);

  // rc1 harus di urutan pertama (|delta| lebih besar)
  assert.equal(res.body.conditions[0].id, 'rc1');
  assert.deepEqual(res.body.conditions[0].checked,   { n: 3, win_rate: 100, avg_r: 2 });
  assert.deepEqual(res.body.conditions[0].unchecked, { n: 3, win_rate: 0,   avg_r: -1 });
  assert.equal(res.body.conditions[0].avg_r_delta, 3);
  assert.equal(res.body.conditions[0].win_rate_delta, 100);

  assert.equal(res.body.conditions[1].id, 'rc2');
}));

test('edge_stats: kondisi dengan salah satu sisi < MIN_BUCKET (3) -> dikecualikan dari hasil', withMockRedis(async (redis) => {
  // rc1: 4 tercentang, 1 tidak -> sisi "tidak" cuma n=1, harus dibuang dari conditions
  seedClosedEntry(redis, '1', { checklistSnapshot: { rc1: true }, rActual: 1 });
  seedClosedEntry(redis, '2', { checklistSnapshot: { rc1: true }, rActual: 1 });
  seedClosedEntry(redis, '3', { checklistSnapshot: { rc1: true }, rActual: 1 });
  seedClosedEntry(redis, '4', { checklistSnapshot: { rc1: true }, rActual: 1 });
  seedClosedEntry(redis, '5', { checklistSnapshot: { rc1: false }, rActual: -1 });

  const res = mockRes();
  await journalHandler({ method: 'GET', query: { device_id: DEVICE, action: 'edge_stats' }, headers: {} }, res);
  assert.equal(res.body.insufficient_data, false);
  assert.equal(res.body.conditions.length, 0);
}));

test('edge_stats: entry closed tanpa checklist_snapshot diabaikan (bukan trade dari tab Checklist)', withMockRedis(async (redis) => {
  seedClosedEntry(redis, '1', { checklistSnapshot: { rc1: true },  rActual: 1 });
  seedClosedEntry(redis, '2', { checklistSnapshot: { rc1: true },  rActual: 1 });
  seedClosedEntry(redis, '3', { checklistSnapshot: { rc1: false }, rActual: -1 });
  seedClosedEntry(redis, '4', { checklistSnapshot: { rc1: false }, rActual: -1 });
  // Entri manual "+ BARU" tanpa checklist_snapshot sama sekali
  redis.kv.set(`journal:${DEVICE}:5`, JSON.stringify({ id: '5', device_id: DEVICE, status: 'closed', r_actual: 1, checklist_snapshot: null }));
  const zkey = `journal_index:${DEVICE}`;
  const z = redis.zsets.get(zkey) || [];
  z.push({ score: 5, member: '5' });
  redis.zsets.set(zkey, z);

  const res = mockRes();
  await journalHandler({ method: 'GET', query: { device_id: DEVICE, action: 'edge_stats' }, headers: {} }, res);
  // sample_count harus 4 (entri #5 dibuang), bukan 5
  assert.equal(res.body.sample_count, 4);
}));

// ── POST: checklist_snapshot ikut tersimpan (sanitized) lewat siklus hidup normal ──

test('POST + GET list: checklist_snapshot tersimpan ter-sanitasi', withMockRedis(async () => {
  const postRes = mockRes();
  await journalHandler({
    method: 'POST',
    query: { device_id: DEVICE },
    headers: {},
    body: {
      pair: 'EUR/USD', direction: 'long', thesis_text: 'test thesis',
      checklist_snapshot: { rc1: true, rc2: 'yes', '': true },
      checklist_playbook: 'smc_ict',
      checklist_pct: 150, // out-of-range, harus diclamp ke 100
    },
  }, postRes);
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.ok, true);

  const listRes = mockRes();
  await journalHandler({ method: 'GET', query: { device_id: DEVICE, status: 'all' }, headers: {} }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.entries.length, 1);
  const saved = listRes.body.entries[0];
  assert.deepEqual(saved.checklist_snapshot, { rc1: true, rc2: true });
  assert.equal(saved.checklist_playbook, 'smc_ict');
  assert.equal(saved.checklist_pct, 100);
}));
