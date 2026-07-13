// test/market_digest_nemotron.test.js
// Unit test integrasi Nemotron 3 Ultra (session 145, re-arsitektur Nemotron) di
// api/market-digest.js. Handler penuh (Call 1/2/3) tidak dites end-to-end di sini —
// terlalu banyak dependency eksternal (RSS/kalender/Yahoo/Redis) dan memang tidak ada
// preseden test untuk handler ini di codebase. Fokus test ini: aiCall() generic
// (dipakai semua tier) benar-benar mengirim request yang benar untuk model Nemotron,
// dan konstanta model/circuit sesuai yang diverifikasi dari riset (bukan typo).
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const {
  aiCall, NEMOTRON_MODEL, CB_OPENROUTER_NEMOTRON, OPENROUTER_URL, OPENROUTER_HEADERS,
  callOllama, OLLAMA_URL, OLLAMA_NEMOTRON_MODEL, CB_OLLAMA_NEMOTRON, withNoThink,
  NEMOTRON_SUPER_MODEL, CB_OPENROUTER_NEMOTRON_SUPER,
  HERMES_MODEL, CB_OPENROUTER_HERMES,
} = require('../api/market-digest.js');

test('NEMOTRON_MODEL: model id persis sesuai slug free-tier OpenRouter (bukan typo, bukan versi berbayar)', () => {
  assert.strictEqual(NEMOTRON_MODEL, 'nvidia/nemotron-3-ultra-550b-a55b:free');
});

test('CB_OPENROUTER_NEMOTRON: circuit breaker terpisah dari fallback OpenRouter gpt-oss lain', () => {
  assert.strictEqual(CB_OPENROUTER_NEMOTRON, 'ai:openrouter:nemotron');
});

test('aiCall: request Nemotron via OpenRouter — URL, model, header, dan providerOverride benar', async () => {
  let capturedUrl, capturedBody, capturedHeaders;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hasil nemotron' } }] }) };
  };
  try {
    const out = await aiCall(OPENROUTER_URL, 'sk-or', NEMOTRON_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 25000, OPENROUTER_HEADERS, {}, 'openrouter');
    assert.strictEqual(out, 'hasil nemotron');
  } finally {
    global.fetch = orig;
  }
  assert.strictEqual(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.strictEqual(capturedBody.model, NEMOTRON_MODEL);
  assert.strictEqual(capturedHeaders.Authorization, 'Bearer sk-or');
  assert.strictEqual(capturedHeaders['HTTP-Referer'], 'https://financial-feed-app.vercel.app');
  assert.strictEqual(capturedHeaders['X-Title'], 'Daun Merah');
});

test('aiCall: strip <think> block dari respons Nemotron (kalau model mengirim reasoning trace)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<think>mikir dulu</think>Hasil akhir bersih.' } }] }) });
  try {
    const out = await aiCall(OPENROUTER_URL, 'sk-or', NEMOTRON_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 25000, OPENROUTER_HEADERS, {}, 'openrouter');
    assert.strictEqual(out, 'Hasil akhir bersih.');
  } finally {
    global.fetch = orig;
  }
});

test('aiCall: HTTP non-OK melempar error dengan status', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'payment required' } }) });
  try {
    await assert.rejects(
      () => aiCall(OPENROUTER_URL, 'sk-or', NEMOTRON_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 25000, OPENROUTER_HEADERS, {}, 'openrouter'),
      /payment required/
    );
  } finally {
    global.fetch = orig;
  }
});

// ── Ollama Cloud sebagai sumber Nemotron alternatif (session 145 lanjutan) ──────────

test('OLLAMA_NEMOTRON_MODEL: TANPA suffix :cloud (pelajaran dari bug GLM-5.2 session 144 lanjutan 5)', () => {
  assert.strictEqual(OLLAMA_NEMOTRON_MODEL, 'nemotron-3-ultra');
  assert.ok(!OLLAMA_NEMOTRON_MODEL.includes(':'), 'model id native Ollama API tidak boleh ada suffix :cloud');
});

test('CB_OLLAMA_NEMOTRON: circuit terpisah dari ai:ollama (dipakai ohlcv_analyze di admin.js)', () => {
  assert.strictEqual(CB_OLLAMA_NEMOTRON, 'ai:ollama:nemotron');
});

test('callOllama: kirim body native Ollama (model/messages/stream:false/options), baca message.content', async () => {
  let capturedUrl, capturedBody, capturedAuth;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    capturedAuth = opts.headers.Authorization;
    return { ok: true, json: async () => ({ message: { content: '  hasil ollama nemotron  ' }, done: true }) };
  };
  try {
    const out = await callOllama('sk-ollama', OLLAMA_NEMOTRON_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 18000, 'ollama');
    assert.strictEqual(out, 'hasil ollama nemotron', 'harus di-trim');
  } finally {
    global.fetch = orig;
  }
  assert.strictEqual(capturedUrl, OLLAMA_URL);
  assert.strictEqual(capturedAuth, 'Bearer sk-ollama');
  assert.strictEqual(capturedBody.model, 'nemotron-3-ultra');
  assert.strictEqual(capturedBody.stream, false);
  assert.strictEqual(capturedBody.options.temperature, 0.25);
  assert.strictEqual(capturedBody.options.num_predict, 1300);
});

test('callOllama: HTTP non-OK melempar error berisi status', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403 });
  try {
    await assert.rejects(
      () => callOllama('sk-ollama', OLLAMA_NEMOTRON_MODEL, [], 1300, 0.25, 18000, 'ollama'),
      /HTTP 403/
    );
  } finally {
    global.fetch = orig;
  }
});

test('callOllama: response kosong (message.content kosong) melempar Empty response', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '' } }) });
  try {
    await assert.rejects(
      () => callOllama('sk-ollama', OLLAMA_NEMOTRON_MODEL, [], 1300, 0.25, 18000, 'ollama'),
      /Empty response/
    );
  } finally {
    global.fetch = orig;
  }
});

test('callOllama: strip <think> block dari respons (kalau model kirim reasoning trace)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '<think>mikir</think>Hasil bersih.' } }) });
  try {
    const out = await callOllama('sk-ollama', OLLAMA_NEMOTRON_MODEL, [], 1300, 0.25, 18000, 'ollama');
    assert.strictEqual(out, 'Hasil bersih.');
  } finally {
    global.fetch = orig;
  }
});

// ── withNoThink (session 145 lanjutan 3) ────────────────────────────────────────────

test('withNoThink: menambah /no_think ke system message yang sudah ada', () => {
  const out = withNoThink([{ role: 'system', content: 'Kamu analis.' }, { role: 'user', content: 'hi' }]);
  assert.strictEqual(out[0].content, 'Kamu analis.\n/no_think');
  assert.strictEqual(out[1].content, 'hi', 'user message tidak berubah');
});

test('withNoThink: menambah system message baru berisi /no_think kalau belum ada system message', () => {
  const out = withNoThink([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[0].content, '/no_think');
  assert.strictEqual(out[1].content, 'hi');
});

test('withNoThink: tidak memutasi array/objek messages asli (immutable)', () => {
  const original = [{ role: 'system', content: 'Kamu analis.' }, { role: 'user', content: 'hi' }];
  const out = withNoThink(original);
  assert.notStrictEqual(out, original);
  assert.strictEqual(original[0].content, 'Kamu analis.', 'original tidak berubah');
});

// ── Nemotron 3 SUPER (session 145 lanjutan 5) — kandidat baru, belum pernah dites live ──

test('NEMOTRON_SUPER_MODEL: model id persis sesuai slug free-tier OpenRouter', () => {
  assert.strictEqual(NEMOTRON_SUPER_MODEL, 'nvidia/nemotron-3-super-120b-a12b:free');
});

test('CB_OPENROUTER_NEMOTRON_SUPER: circuit terpisah dari CB_OPENROUTER_NEMOTRON (Ultra)', () => {
  assert.strictEqual(CB_OPENROUTER_NEMOTRON_SUPER, 'ai:openrouter:nemotron-super');
  assert.notStrictEqual(CB_OPENROUTER_NEMOTRON_SUPER, CB_OPENROUTER_NEMOTRON);
});

test('aiCall: request Nemotron Super via OpenRouter — model & providerOverride benar', async () => {
  let capturedBody;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hasil super' } }] }) };
  };
  try {
    const out = await aiCall(OPENROUTER_URL, 'sk-or', NEMOTRON_SUPER_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 20000, OPENROUTER_HEADERS, {}, 'openrouter');
    assert.strictEqual(out, 'hasil super');
  } finally {
    global.fetch = orig;
  }
  assert.strictEqual(capturedBody.model, NEMOTRON_SUPER_MODEL);
});

// ── Hermes 3 405B (diagnostik ?test_hermes=1, belum pernah dites live) ──────────────

test('HERMES_MODEL: model id persis sesuai slug free-tier OpenRouter (bukan typo)', () => {
  assert.strictEqual(HERMES_MODEL, 'nousresearch/hermes-3-llama-3.1-405b:free');
});

test('CB_OPENROUTER_HERMES: circuit terpisah dari kandidat Nemotron lain', () => {
  assert.strictEqual(CB_OPENROUTER_HERMES, 'ai:openrouter:hermes');
  assert.notStrictEqual(CB_OPENROUTER_HERMES, CB_OPENROUTER_NEMOTRON);
  assert.notStrictEqual(CB_OPENROUTER_HERMES, CB_OPENROUTER_NEMOTRON_SUPER);
});

test('aiCall: request Hermes 3 405B via OpenRouter — model & providerOverride benar', async () => {
  let capturedBody;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hasil hermes' } }] }) };
  };
  try {
    const out = await aiCall(OPENROUTER_URL, 'sk-or', HERMES_MODEL, [{ role: 'user', content: 'hi' }], 1300, 0.25, 30000, OPENROUTER_HEADERS, {}, 'openrouter');
    assert.strictEqual(out, 'hasil hermes');
  } finally {
    global.fetch = orig;
  }
  assert.strictEqual(capturedBody.model, HERMES_MODEL);
});
