// test/lib/news_translate.test.js
// Translate NEWS ke Bahasa Indonesia (S272, 2026-08-02, api/_news_translate.js).
// Cakupan: parsing respons Gemini (format ketat), pengecualian kategori econ-data,
// skip item yang sudah pernah diterjemahkan, dan fail-open tanpa GEMINI_API_KEY/Redis.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { translateNewItems, getTranslations, parseResponse, buildPrompt } = require('../../api/_news_translate');

// ── parseResponse (pure, no I/O) ────────────────────────────────────────────

test('parseResponse: format lengkap (judul + isi) terparsing benar', () => {
  const raw = 'JUDUL_ID: Fed pertahankan suku bunga\nISI_ID: Powell mengatakan bank sentral akan tetap sabar.';
  const r = parseResponse(raw, true);
  assert.deepEqual(r, { title_id: 'Fed pertahankan suku bunga', desc_id: 'Powell mengatakan bank sentral akan tetap sabar.' });
});

test('parseResponse: hasDesc=false — desc_id selalu string kosong, tidak parse ISI_ID', () => {
  const raw = 'JUDUL_ID: Fed pertahankan suku bunga';
  const r = parseResponse(raw, false);
  assert.deepEqual(r, { title_id: 'Fed pertahankan suku bunga', desc_id: '' });
});

test('parseResponse: JUDUL_ID kosong/hilang → null (dianggap gagal, bukan terjemahan kosong)', () => {
  assert.equal(parseResponse('', true), null);
  assert.equal(parseResponse('cuma teks acak tanpa format', true), null);
  assert.equal(parseResponse('JUDUL_ID: \nISI_ID: ada isi', true), null);
});

test('parseResponse: model nambah teks di luar format tetap terparsing bagian JUDUL_ID/ISI_ID-nya', () => {
  // Prompt strict minta TANPA penjelasan tambahan, tapi parser tetap toleran
  // kalau model melanggar — asal marker JUDUL_ID/ISI_ID masih ada.
  const raw = 'Berikut hasil terjemahannya:\nJUDUL_ID: Harga emas naik\nISI_ID: Didorong oleh pelemahan dolar AS.\n\nSemoga membantu!';
  const r = parseResponse(raw, true);
  assert.equal(r.title_id, 'Harga emas naik');
  assert.equal(r.desc_id, 'Didorong oleh pelemahan dolar AS.\n\nSemoga membantu!');
});

test('buildPrompt: instruksi ketat "hanya terjemahan" selalu ada, ISI cuma disertakan kalau desc tidak kosong', () => {
  const withDesc = buildPrompt('Fed holds rates', 'Powell speaks at press conference');
  assert.match(withDesc, /HANYA keluarkan hasil terjemahan/);
  assert.match(withDesc, /ISI:\nPowell speaks at press conference/);
  assert.match(withDesc, /ISI_ID:/);

  const withoutDesc = buildPrompt('Fed holds rates', '');
  assert.doesNotMatch(withoutDesc, /ISI:/);
  assert.doesNotMatch(withoutDesc, /ISI_ID:/);
});

// ── translateNewItems / getTranslations (mock Redis + mock Gemini fetch) ────

function mockRedis() {
  const kv = new Map();
  return {
    kv,
    fetch: async (url, opts) => {
      const args = JSON.parse(opts.body);
      const [cmd, ...rest] = args;
      let result = null;
      if (cmd === 'SET') {
        const key = rest[0], val = rest[1];
        kv.set(key, val);
        result = 'OK';
      } else if (cmd === 'GET') {
        result = kv.has(rest[0]) ? kv.get(rest[0]) : null;
      } else if (cmd === 'MGET') {
        result = rest.map(k => (kv.has(k) ? kv.get(k) : null));
      } else if (cmd === 'INCR') {
        const key = rest[0];
        const n = (parseInt(kv.get(key), 10) || 0) + 1;
        kv.set(key, String(n));
        result = n;
      } else if (cmd === 'EXPIRE' || cmd === 'DEL') {
        result = 1;
      }
      return { json: async () => ({ result }) };
    },
  };
}

// redisCmd sederhana yang langsung dipakai module (bukan lewat fetch) — translateNewItems/
// getTranslations menerima redisCmd sebagai parameter (DI, sama seperti autoUpdateFundamentals
// di api/feeds.js), jadi cukup mock fungsinya langsung tanpa perlu env Upstash.
function makeRedisCmd(store) {
  return async (...args) => {
    const [cmd, ...rest] = args;
    if (cmd === 'SET') { store.set(rest[0], rest[1]); return 'OK'; }
    if (cmd === 'GET') { return store.has(rest[0]) ? store.get(rest[0]) : null; }
    if (cmd === 'MGET') { return rest.map(k => (store.has(k) ? store.get(k) : null)); }
    return null;
  };
}

function withEnv(vars, fn) {
  return async (...a) => {
    const prev = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
    try { await fn(...a); } finally {
      for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  };
}

test('translateNewItems: tanpa GEMINI_API_KEY → no-op, tidak crash, tidak ada yang tersimpan', withEnv({}, async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const store = new Map();
  await assert.doesNotReject(translateNewItems([{ title: 'Some headline', guid: 'x1', description: '' }], makeRedisCmd(store)));
  assert.equal(store.size, 0);
}));

test('translateNewItems: array kosong/invalid → no-op', async () => {
  const store = new Map();
  await assert.doesNotReject(translateNewItems([], makeRedisCmd(store)));
  await assert.doesNotReject(translateNewItems(null, makeRedisCmd(store)));
});

test('translateNewItems: kategori econ-data DIKECUALIKAN dari translate (permintaan user S272)', withEnv({
  GEMINI_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  let geminiCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'JUDUL_ID: Terjemahan\nISI_ID: Isi' } }] }) };
    }
    // Circuit breaker & ai_guard sama-sama fetch ke Upstash REST langsung —
    // fail-open (return no-result) supaya tidak memblokir alur test ini.
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const store = new Map();
    const items = [
      // Format rilis kalender FinancialJuice klasik ("Actual X Forecast Y") — HARD RULE econ-data di newscat.js
      { title: 'US CPI m/m Actual 0.3% Forecast 0.2% Previous 0.1%', guid: 'econ-1', description: '' },
      { title: 'Trump says trade deal with China is close', guid: 'geo-1', description: '' },
    ];
    await translateNewItems(items, makeRedisCmd(store));
    assert.equal(geminiCalls, 1, 'cuma item non-econ-data yang boleh manggil Gemini');
    assert.equal(store.has('news_tr:econ-1'), false, 'econ-data TIDAK PERNAH punya entri terjemahan');
    assert.equal(store.has('news_tr:geo-1'), true);
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: item yang sudah ada news_tr:<guid> di-skip, tidak manggil Gemini lagi', withEnv({
  GEMINI_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  let geminiCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'JUDUL_ID: X' } }] }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const store = new Map();
    store.set('news_tr:already-1', JSON.stringify({ title_id: 'Sudah diterjemahkan', desc_id: '' }));
    await translateNewItems([{ title: 'Some ordinary headline', guid: 'already-1', description: '' }], makeRedisCmd(store));
    assert.equal(geminiCalls, 0, 'item yang sudah punya cache tidak boleh ditembak ulang ke Gemini');
  } finally { global.fetch = realFetch; }
}));

// ── getTranslations (lookup read-only) ──────────────────────────────────────

test('getTranslations: baca cuma guid yang diminta & yang tersedia, abaikan yang kosong', async () => {
  const store = new Map();
  store.set('news_tr:g1', JSON.stringify({ title_id: 'Judul 1', desc_id: '' }));
  store.set('news_tr:g2', JSON.stringify({ title_id: 'Judul 2', desc_id: 'Isi 2' }));
  const out = await getTranslations(['g1', 'g2', 'g3-belum-ada'], makeRedisCmd(store));
  assert.deepEqual(out, {
    g1: { title_id: 'Judul 1', desc_id: '' },
    g2: { title_id: 'Judul 2', desc_id: 'Isi 2' },
  });
  assert.equal('g3-belum-ada' in out, false);
});

test('getTranslations: array guid kosong → objek kosong, tidak manggil redisCmd', async () => {
  let called = false;
  const redisCmd = async () => { called = true; return null; };
  const out = await getTranslations([], redisCmd);
  assert.deepEqual(out, {});
  assert.equal(called, false);
});
