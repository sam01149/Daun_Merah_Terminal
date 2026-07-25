// test/market_digest_aicall.test.js
// Unit test generik aiCall() (api/market-digest.js) — helper OpenAI-compat dipakai
// bersama oleh DeepSeek/SambaNova/Gemini/Mistral. Nemotron/Hermes (OpenRouter) dan
// Nemotron Ultra (Ollama Cloud) DIHAPUS 2026-07-25 bersama kontrak vendornya — file
// ini dulu bernama market_digest_nemotron.test.js, ganti nama karena isinya sekarang
// murni generik, bukan spesifik Nemotron.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { aiCall } = require('../../api/market-digest.js');

const FAKE_URL = 'https://api.example.com/v1/chat/completions';
const FAKE_MODEL = 'fake-model';

test('aiCall: request terkirim dengan URL, model, dan Authorization header benar', async () => {
  let capturedUrl, capturedBody, capturedHeaders;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hasil' } }] }) };
  };
  try {
    const out = await aiCall(FAKE_URL, 'sk-x', FAKE_MODEL, [{ role: 'user', content: 'hi' }], 500, 0.25, 25000, {}, {}, null);
    assert.strictEqual(out, 'hasil');
  } finally {
    global.fetch = orig;
  }
  assert.strictEqual(capturedUrl, FAKE_URL);
  assert.strictEqual(capturedBody.model, FAKE_MODEL);
  assert.strictEqual(capturedHeaders.Authorization, 'Bearer sk-x');
});

test('aiCall: strip <think> block dari respons (kalau model mengirim reasoning trace)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<think>mikir dulu</think>Hasil akhir bersih.' } }] }) });
  try {
    const out = await aiCall(FAKE_URL, 'sk-x', FAKE_MODEL, [{ role: 'user', content: 'hi' }], 500, 0.25, 25000);
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
      () => aiCall(FAKE_URL, 'sk-x', FAKE_MODEL, [{ role: 'user', content: 'hi' }], 500, 0.25, 25000),
      /payment required/
    );
  } finally {
    global.fetch = orig;
  }
});

test('aiCall: error shape flat (Cerebras-style {message}) tetap terbaca, bukan jatuh ke "HTTP xxx" generik', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: 'context length exceeded' }) });
  try {
    await assert.rejects(
      () => aiCall(FAKE_URL, 'sk-x', FAKE_MODEL, [{ role: 'user', content: 'hi' }], 500, 0.25, 25000),
      /context length exceeded/
    );
  } finally {
    global.fetch = orig;
  }
});
