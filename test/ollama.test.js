// test/ollama.test.js
// Unit test _callOllama (api/admin.js) — Ollama Cloud dipakai sebagai fallback
// tambahan sebelum Groq di ohlcv_analyze (session 144 lanjutan 5). API-nya format
// native Ollama (/api/chat, message.content), BUKAN format OpenAI seperti provider
// lain — test ini memastikan parsing request/response-nya benar tanpa network asli.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { _callOllama } = require('../api/admin.js');

function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  return fn().finally(() => { global.fetch = orig; });
}

test('_callOllama: sukses — kirim body native (model/messages/stream:false/options), baca message.content', async () => {
  let capturedUrl, capturedBody, capturedAuth;
  await withFetch(async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    capturedAuth = opts.headers.Authorization;
    return { ok: true, json: async () => ({ message: { role: 'assistant', content: '  hasil analisa  ' }, done: true }) };
  }, async () => {
    const out = await _callOllama('sk-test', 'deepseek-v3.2:cloud', [{ role: 'user', content: 'halo' }], 1500, 0.3, 15000);
    assert.strictEqual(out, 'hasil analisa', 'harus di-trim');
  });
  assert.strictEqual(capturedUrl, 'https://ollama.com/api/chat');
  assert.strictEqual(capturedAuth, 'Bearer sk-test');
  assert.strictEqual(capturedBody.model, 'deepseek-v3.2:cloud');
  assert.strictEqual(capturedBody.stream, false);
  assert.strictEqual(capturedBody.options.temperature, 0.3);
  assert.strictEqual(capturedBody.options.num_predict, 1500);
  assert.strictEqual(capturedBody.think, undefined, 'think tidak dikirim kalau parameter ke-7 tidak diisi');
});

test('_callOllama: parameter think dikirim di top-level body (bukan di dalam options) kalau diisi', async () => {
  let capturedBody;
  await withFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) };
  }, async () => {
    await _callOllama('sk-test', 'glm-5.2:cloud', [], 1500, 0.3, 15000, 'high');
  });
  assert.strictEqual(capturedBody.think, 'high');
  assert.strictEqual(capturedBody.options.think, undefined, 'think bukan bagian dari options');
});

test('_callOllama: think:false (deepthink dimatikan) tetap terkirim, bukan ke-drop seperti default null', async () => {
  let capturedBody;
  await withFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) };
  }, async () => {
    await _callOllama('sk-test', 'glm-5.2:cloud', [], 1500, 0.3, 30000, false);
  });
  assert.strictEqual(capturedBody.think, false, 'false != null jadi harus tetap terkirim eksplisit');
});

test('_callOllama: HTTP non-OK melempar error dengan status di pesan', async () => {
  await withFetch(async () => ({ ok: false, status: 429 }), async () => {
    await assert.rejects(
      () => _callOllama('sk-test', 'deepseek-v3.2:cloud', [], 1500, 0.3, 15000),
      /HTTP 429/
    );
  });
});

test('_callOllama: response tanpa message.content (kosong) melempar error', async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({ message: { content: '' }, done: true }) }), async () => {
    await assert.rejects(
      () => _callOllama('sk-test', 'deepseek-v3.2:cloud', [], 1500, 0.3, 15000),
      /Empty response/
    );
  });
});

test('_callOllama: response tanpa field message sama sekali tidak melempar TypeError (optional chaining)', async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({}) }), async () => {
    await assert.rejects(
      () => _callOllama('sk-test', 'deepseek-v3.2:cloud', [], 1500, 0.3, 15000),
      /Empty response/
    );
  });
});
