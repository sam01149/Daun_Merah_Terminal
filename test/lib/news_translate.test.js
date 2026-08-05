// test/lib/news_translate.test.js
// Translate NEWS ke Bahasa Indonesia (S272, 2026-08-02, api/_news_translate.js;
// redesign batch 2026-08-02 lanj. — balik ke Mistral, satu panggilan API menerjemahkan
// sampai BATCH_SIZE headline sekaligus, bukan satu-satu — lihat catatan BATCH
// REDESIGN di api/_news_translate.js untuk kronologi lengkap).
// Cakupan: parsing respons Mistral (format single-item & batch), pengecualian
// kategori econ-data, skip item yang sudah pernah diterjemahkan, anti-starvation
// batch kedua = tertua, dan fail-open tanpa MISTRAL_API_KEY/Redis.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { translateNewItems, getTranslations, parseResponse, buildPrompt, buildBatchPrompt, parseBatchResponse } = require('../../api/_news_translate');

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

// ── buildBatchPrompt / parseBatchResponse (pure, no I/O) ────────────────────

test('buildBatchPrompt: tiap item diberi label [N], ISI cuma muncul kalau desc tidak kosong', () => {
  const p = buildBatchPrompt([
    { title: 'Fed holds rates', description: 'Powell speaks' },
    { title: 'Gold rises', description: '' },
  ]);
  assert.match(p, /\[1\]\nJUDUL: Fed holds rates\nISI: Powell speaks/);
  assert.match(p, /\[2\]\nJUDUL: Gold rises/);
  assert.doesNotMatch(p, /\[2\][^[]*ISI:/);
  assert.match(p, /SEMUA 2 nomor|2 headline/);
});

test('parseBatchResponse: batch lengkap, urutan sesuai, ISI ikut kepetakan', () => {
  const raw = '[1]\nJUDUL_ID: Fed pertahankan suku bunga\n\n[2]\nJUDUL_ID: Emas naik\nISI_ID: Didorong dolar lemah';
  const out = parseBatchResponse(raw, 2);
  assert.deepEqual(out[0], { title_id: 'Fed pertahankan suku bunga', desc_id: '' });
  assert.deepEqual(out[1], { title_id: 'Emas naik', desc_id: 'Didorong dolar lemah' });
});

test('parseBatchResponse: nomor yang dilewati model tetap null (bukan crash, bukan salah petak)', () => {
  const raw = '[1]\nJUDUL_ID: Item satu\n\n[3]\nJUDUL_ID: Item tiga';
  const out = parseBatchResponse(raw, 3);
  assert.equal(out[0].title_id, 'Item satu');
  assert.equal(out[1], null, 'nomor 2 dilewati model, harus null bukan ketiban isi nomor lain');
  assert.equal(out[2].title_id, 'Item tiga');
});

test('parseBatchResponse: respons kosong/tanpa marker sama sekali → semua null', () => {
  assert.deepEqual(parseBatchResponse('', 3), [null, null, null]);
  assert.deepEqual(parseBatchResponse('cuma teks acak', 2), [null, null]);
});

// ── translateNewItems / getTranslations (mock Redis + mock Mistral fetch) ─

function makeRedisCmd(store) {
  return async (...args) => {
    const [cmd, ...rest] = args;
    if (cmd === 'SET') { store.set(rest[0], rest[1]); return 'OK'; }
    if (cmd === 'GET') { return store.has(rest[0]) ? store.get(rest[0]) : null; }
    if (cmd === 'MGET') { return rest.map(k => (store.has(k) ? store.get(k) : null)); }
    if (cmd === 'INCR') { const v = (parseInt(store.get(rest[0]), 10) || 0) + 1; store.set(rest[0], v); return v; }
    if (cmd === 'EXPIRE') { return 1; }
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

// Mock Mistral yang membaca ulang [N]\nJUDUL: <title> dari prompt batch dan membalas
// format [N]\nJUDUL_ID: <title> yang sama persis (echo) — cukup untuk verifikasi
// item mana yang benar-benar ditembak & tersimpan, tanpa perlu terjemahan asli.
function mockMistralEchoWithBody(calledBatches) {
  return async (url, opts) => {
    if (String(url).includes('api.mistral.ai')) {
      const body = JSON.parse(opts.body);
      const prompt = body.messages[0].content;
      const matches = [...prompt.matchAll(/\[(\d+)\]\nJUDUL: (.*)/g)];
      calledBatches.push(matches.map(mm => mm[2]));
      const content = matches.map(mm => `[${mm[1]}]\nJUDUL_ID: ${mm[2]}`).join('\n');
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    // Circuit breaker & ai_guard sama-sama fetch ke Upstash REST langsung —
    // fail-open (return no-result) supaya tidak memblokir alur test ini.
    return { ok: true, json: async () => ({ result: null }) };
  };
}

test('translateNewItems: tanpa MISTRAL_API_KEY → no-op, tidak crash, tidak ada yang tersimpan', withEnv({}, async () => {
  delete process.env.MISTRAL_API_KEY;
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
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = mockMistralEchoWithBody(calledBatches);
  try {
    const store = new Map();
    const items = [
      // Format rilis kalender FinancialJuice klasik ("Actual X Forecast Y") — HARD RULE econ-data di newscat.js
      { title: 'US CPI m/m Actual 0.3% Forecast 0.2% Previous 0.1%', guid: 'econ-1', description: '' },
      { title: 'Trump says trade deal with China is close', guid: 'geo-1', description: '' },
    ];
    await translateNewItems(items, makeRedisCmd(store));
    assert.equal(calledBatches.length, 1, 'satu batch call untuk semua item non-econ-data');
    assert.equal(calledBatches[0].length, 1, 'cuma item non-econ-data yang boleh masuk batch ke Mistral');
    assert.equal(store.has('news_tr:econ-1'), false, 'econ-data TIDAK PERNAH punya entri terjemahan');
    assert.equal(store.has('news_tr:geo-1'), true);
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: item yang sudah ada news_tr:<guid> di-skip, tidak manggil Mistral lagi', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = mockMistralEchoWithBody(calledBatches);
  try {
    const store = new Map();
    store.set('news_tr:already-1', JSON.stringify({ title_id: 'Sudah diterjemahkan', desc_id: '' }));
    await translateNewItems([{ title: 'Some ordinary headline', guid: 'already-1', description: '' }], makeRedisCmd(store));
    assert.equal(calledBatches.length, 0, 'item yang sudah punya cache tidak boleh ditembak ulang ke Mistral');
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: todo <= BATCH_SIZE (20) -> SATU panggilan API untuk semua item', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = mockMistralEchoWithBody(calledBatches);
  try {
    const store = new Map();
    const items = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, guid: `g${i}`, description: '' }));
    await translateNewItems(items, makeRedisCmd(store));
    assert.equal(calledBatches.length, 1, '12 headline (di bawah BATCH_SIZE 20) harus jadi 1 panggilan API, bukan 12');
    assert.equal(calledBatches[0].length, 12);
    for (let i = 0; i < 12; i++) assert.equal(store.has(`news_tr:g${i}`), true, `g${i} seharusnya sudah diterjemahkan`);
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: todo > BATCH_SIZE -> dipecah jadi beberapa panggilan, batch kedua ambil dari ujung tertua (anti-starvation)', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = mockMistralEchoWithBody(calledBatches);
  try {
    const store = new Map();
    // urutan feed asli: index 0 = headline TERBARU ... index 44 = TERTUA (45 item, > 2x BATCH_SIZE 20)
    const items = Array.from({ length: 45 }, (_, i) => ({ title: `t${i}`, guid: `g${i}`, description: '' }));
    await translateNewItems(items, makeRedisCmd(store), 60000); // budget besar supaya semua batch kebagian giliran
    assert.equal(calledBatches.length, 3, '45 item / 20 per batch = 3 panggilan');
    assert.deepEqual(calledBatches[0], Array.from({ length: 20 }, (_, i) => `t${i}`), 'batch pertama = 20 headline terbaru');
    assert.deepEqual(calledBatches[1], Array.from({ length: 5 }, (_, i) => `t${40 + i}`), 'batch KEDUA = ujung tertua (anti-starvation), bukan batch tengah');
    assert.deepEqual(calledBatches[2], Array.from({ length: 20 }, (_, i) => `t${20 + i}`), 'batch ketiga = sisa tengah');
    for (let i = 0; i < 45; i++) assert.equal(store.has(`news_tr:g${i}`), true, `g${i} seharusnya sudah diterjemahkan`);
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: budget habis -> panggilan berikutnya benar-benar DIBATALKAN (AbortSignal), tidak orphaned di background', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.mistral.ai')) {
      // Simulasikan network 100ms per panggilan, TAPI hormati AbortSignal seperti fetch
      // asli — supaya test ini benar-benar menguji bahwa translateBatch's timeoutMs
      // (sisa budget) MEMBATALKAN panggilan yang kelewat lambat, bukan cuma diabaikan.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 100);
        const onAbort = () => { clearTimeout(t); reject(new Error('This operation was aborted')); };
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
      const body = JSON.parse(opts.body);
      const matches = [...body.messages[0].content.matchAll(/\[(\d+)\]\nJUDUL: (.*)/g)];
      calledBatches.push(matches.map(mm => mm[2]));
      const content = matches.map(mm => `[${mm[1]}]\nJUDUL_ID: ${mm[2]}`).join('\n');
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const store = new Map();
    const items = Array.from({ length: 45 }, (_, i) => ({ title: `t${i}`, guid: `g${i}`, description: '' }));
    // Budget 150ms: batch pertama (~100ms) sempat selesai, sisa budget utk batch kedua
    // cuma ~50ms (< 100ms delay simulasi) -> AbortSignal batch kedua fire duluan.
    await translateNewItems(items, makeRedisCmd(store), 150);
    assert.equal(calledBatches.length, 1, 'batch kedua dibatalkan AbortSignal sebelum sempat selesai, tidak ikut tersimpan');
    for (let i = 20; i < 45; i++) assert.equal(store.has(`news_tr:g${i}`), false, `g${i} belum diterjemahkan gelombang ini`);
  } finally { global.fetch = realFetch; }
}));

test('buildBatchPrompt: deskripsi outlier (>1200 char) dipotong, deskripsi normal tidak', () => {
  const longDesc = 'x'.repeat(2000);
  const shortDesc = 'y'.repeat(500);
  const p = buildBatchPrompt([
    { title: 'Snapshot raksasa', description: longDesc },
    { title: 'Berita biasa', description: shortDesc },
  ]);
  assert.match(p, new RegExp(`ISI: x{1200}(?!x)`));
  assert.match(p, new RegExp(`ISI: y{500}(?!y)`));
});

test('translateNewItems: item yang gagal >MAX_FAIL_ATTEMPTS(5) kali dilewati permanen, tidak terus memblokir antrean', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  const calledBatches = [];
  global.fetch = mockMistralEchoWithBody(calledBatches);
  try {
    const store = new Map();
    store.set('news_tr_fail:poison-1', '5'); // sudah gagal 5x sebelumnya
    const items = [
      { title: 'Item macet berkali-kali', guid: 'poison-1', description: '' },
      { title: 'Headline baru normal', guid: 'ok-1', description: '' },
    ];
    await translateNewItems(items, makeRedisCmd(store));
    assert.equal(calledBatches.length, 1);
    assert.deepEqual(calledBatches[0], ['Headline baru normal'], 'item poison tidak ikut dikirim ke Mistral');
    assert.equal(store.has('news_tr:poison-1'), false);
    assert.equal(store.has('news_tr:ok-1'), true);
  } finally { global.fetch = realFetch; }
}));

test('translateNewItems: kegagalan batch menaikkan counter news_tr_fail per guid', withEnv({
  MISTRAL_API_KEY: 'fake-key',
  UPSTASH_REDIS_REST_URL: 'https://mock-redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'mock-token',
}, async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.mistral.ai')) throw new Error('simulasi gagal');
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const store = new Map();
    await translateNewItems([{ title: 'Gagal terus', guid: 'fail-1', description: '' }], makeRedisCmd(store));
    assert.equal(store.get('news_tr_fail:fail-1'), 1);
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
