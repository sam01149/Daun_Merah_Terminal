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

const { aiCall, NEMOTRON_MODEL, CB_OPENROUTER_NEMOTRON, OPENROUTER_URL, OPENROUTER_HEADERS } = require('../api/market-digest.js');

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
