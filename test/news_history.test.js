// test/news_history.test.js
// Fitur "Muat Berita Lebih Lama" (tab NEWS) — load-more read-only atas archive
// 'news_history' yang SUDAH ADA dan dipakai juga oleh market-digest.js Call 2 (CB bias).
// Dua hal yang diregresi-test di sini:
// 1. parseRSSItems sekarang menyimpan <description> untuk SEMUA item, bukan cuma
//    headline bank-sentral/option-expiry seperti versi sebelumnya (session 158) —
//    supaya berita lama yang di-load-more juga tampil dengan isi, bukan cuma judul.
// 2. newsHistoryHandler: pagination mundur (cursor `before`, urutan terbaru-dulu per
//    halaman) tidak overlap/kehilangan data saat dipanggil berulang sampai archive habis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRSSItems, storeNewsHistory, newsHistoryHandler } = require('../api/feeds.js');

function fixtureItem({ title, guid, pubDate, desc }) {
  return `<item><title>${title}</title><guid>${guid}</guid><pubDate>${pubDate}</pubDate><link>https://example.com/${guid}</link>${desc ? `<description>${desc}</description>` : ''}</item>`;
}

test('parseRSSItems: description disimpan untuk headline biasa (bukan cuma CB/option-expiry)', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'Apple stock rises on earnings beat',
    guid: '1001',
    pubDate: 'Sun, 12 Jul 2026 09:00:00 GMT',
    desc: 'Apple shares climbed 3% after Q3 results topped analyst estimates.',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Apple shares climbed 3% after Q3 results topped analyst estimates.');
});

test('parseRSSItems: item tanpa <description> di XML tetap tersimpan (title-only, description string kosong)', () => {
  const xml = `<rss><channel>${fixtureItem({ title: 'Some headline', guid: '1002', pubDate: 'Sun, 12 Jul 2026 09:05:00 GMT' })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].description, '');
});

// ── newsHistoryHandler: mock Redis (pola sama dengan test/feeds_retail.test.js) ────

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
        const nx = rest.includes('NX');
        if (nx && kv.has(key)) result = null;
        else { kv.set(key, rest[0]); result = 'OK'; }
      } else if (cmd === 'ZADD') {
        // storeNewsHistory sends ONE ZADD with multiple score/member pairs after the
        // 'NX' flag (['NX', score1, member1, score2, member2, ...]) — must loop all
        // pairs, not just the first (real Redis ZADD supports this natively).
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
    try {
      await fn(redis);
    } finally {
      global.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
    }
  };
}

test('newsHistoryHandler: load-more mundur — 2 halaman berturutan tidak overlap, mencakup semua item', withMockRedis(async (redis) => {
  const now = new Date('2026-07-12T09:00:00Z').getTime();
  // 5 item, 10 menit terpisah satu sama lain, dalam window 36 jam
  const xml = `<rss><channel>${
    Array.from({ length: 5 }, (_, i) => fixtureItem({
      title: `Headline ${i}`,
      guid: `g${i}`,
      pubDate: new Date(now - i * 10 * 60 * 1000).toUTCString(),
      desc: `Body text for headline ${i}`,
    })).join('')
  }</channel></rss>`;
  await storeNewsHistory(xml, now);
  assert.equal(redis.zsets.get('news_history').length, 5);

  // Halaman 1: limit=3, before=now+1 (eksklusif, jadi g0 yg score=now ikut kebaca) → g0,g1,g2
  const res1 = mockRes();
  await newsHistoryHandler({ query: { before: String(now + 1), limit: '3' } }, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.count, 3);
  assert.deepEqual(res1.body.items.map(i => i.guid), ['g0', 'g1', 'g2']);
  assert.equal(res1.body.has_more, true);
  assert.equal(res1.body.items[0].description, 'Body text for headline 0');

  // Halaman 2: lanjut dari next_before halaman 1 → g3,g4, tidak overlap sama sekali
  const res2 = mockRes();
  await newsHistoryHandler({ query: { before: String(res1.body.next_before), limit: '3' } }, res2);
  assert.equal(res2.body.count, 2);
  assert.deepEqual(res2.body.items.map(i => i.guid), ['g3', 'g4']);
  assert.equal(res2.body.has_more, false, 'kurang dari limit → sudah ujung archive');

  // Halaman 3: sudah di ujung, tidak ada lagi
  const res3 = mockRes();
  await newsHistoryHandler({ query: { before: String(res2.body.next_before), limit: '3' } }, res3);
  assert.equal(res3.body.count, 0);
  assert.equal(res3.body.has_more, false);
  assert.equal(res3.body.next_before, null);
}));

test('newsHistoryHandler: before tidak valid → 400', withMockRedis(async () => {
  const res = mockRes();
  await newsHistoryHandler({ query: { before: 'bukan-angka' } }, res);
  assert.equal(res.statusCode, 400);
}));

test('newsHistoryHandler: limit dibatasi maksimal 100 meski diminta lebih besar', withMockRedis(async (redis) => {
  const now = new Date('2026-07-12T09:00:00Z').getTime();
  const xml = `<rss><channel>${
    Array.from({ length: 5 }, (_, i) => fixtureItem({
      title: `Headline ${i}`, guid: `h${i}`, pubDate: new Date(now - i * 60000).toUTCString(),
    })).join('')
  }</channel></rss>`;
  await storeNewsHistory(xml, now);
  const res = mockRes();
  await newsHistoryHandler({ query: { before: String(now + 1), limit: '9999' } }, res);
  assert.equal(res.body.count, 5); // cuma 5 data yg ada, bukan error krn limit kegedean
}));
