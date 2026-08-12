// test/journal_ai.test.js
// Unit test journal.js aiCall() — Gemini flash satu-satunya provider (SambaNova akun2
// diputus kontrak 2026-08-12, billing lapse tak terpulihkan meski ganti API key, lihat
// daun_merah_vendor.md; Cerebras/Groq diputus kontraknya 2026-07-25). Redis tidak
// dikonfigurasi di test ini, jadi circuit breaker/budget guard fail-open (lihat
// guards.test.js) — test ini fokus ke HTTP-level, bukan skip akibat circuit OPEN.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const ENV_KEYS = ['GEMINI_API_KEY'];

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const k of ENV_KEYS) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

async function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

function okResponse(text) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

function errResponse(status) {
  return { ok: false, status, json: async () => ({ error: { message: `boom ${status}` } }) };
}

// Force fresh require so module-level state (none here, but future-proof) is clean
delete require.cache[require.resolve('../../api/journal.js')];
const { _aiCall: aiCall } = require('../../api/journal.js');

test('aiCall: Gemini sukses — 1 fetch call, gemini-flash-latest, reasoning_effort low', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('hasil gemini');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil gemini');
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('generativelanguage.googleapis.com'));
    assert.strictEqual(calls[0].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[0].body.reasoning_effort, 'low');
  });
});

test('aiCall: Gemini gagal -> melempar error agregat', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    await withFetch(async () => errResponse(500), async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed/);
    });
  });
});

test('aiCall: tanpa API key sama sekali -> melempar tanpa network call', async () => {
  await withEnv({}, async () => {
    let fetchCalled = false;
    await withFetch(async () => { fetchCalled = true; return okResponse('x'); }, async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed or none configured/);
    });
    assert.strictEqual(fetchCalled, false);
  });
});
