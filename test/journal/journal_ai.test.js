// test/journal_ai.test.js
// Unit test journal.js aiCall() 2-tier fallback: SambaNova akun2 primary -> Gemini
// flash fallback (Cerebras/Groq diputus kontraknya 2026-07-25). Redis tidak
// dikonfigurasi di test ini, jadi circuit breaker/budget guard fail-open (lihat
// guards.test.js) — test ini fokus ke urutan fallback HTTP-level, bukan skip akibat
// circuit OPEN.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const ENV_KEYS = ['SAMBANOVA_API_KEY_CALL1', 'GEMINI_API_KEY'];

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

test('aiCall: SambaNova primary sukses — cuma 1 fetch call, ke api.sambanova.ai dengan model DeepSeek-V3.2', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('hasil sambanova');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil sambanova');
    });
    assert.strictEqual(calls.length, 1, 'harus berhenti di tier pertama, tidak lanjut fallback');
    assert.strictEqual(calls[0].url, 'https://api.sambanova.ai/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'DeepSeek-V3.2');
  });
});

test('aiCall: SambaNova gagal (HTTP 500) -> fallback Gemini flash (gemini-flash-latest, reasoning_effort low)', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('sambanova.ai')) return errResponse(500);
      if (url.includes('generativelanguage.googleapis.com')) return okResponse('hasil gemini');
      throw new Error('should not reach ' + url);
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil gemini');
    });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].url.includes('generativelanguage.googleapis.com'));
    assert.strictEqual(calls[1].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[1].body.reasoning_effort, 'low');
  });
});

test('aiCall: kedua tier gagal -> melempar error agregat', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    await withFetch(async () => errResponse(500), async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed/);
    });
  });
});

test('aiCall: tanpa GEMINI_API_KEY, SambaNova gagal -> tetap melempar (tier Gemini di-skip)', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s' }, async () => {
    const calls = [];
    await withFetch(async (url) => { calls.push(url); return errResponse(429); }, async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed/);
    });
    assert.strictEqual(calls.length, 1, 'Gemini tidak boleh ikut dipanggil tanpa key');
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

test('aiCall: SAMBANOVA_API_KEY_CALL1 kosong -> langsung ke Gemini (skip tier 1 tanpa error)', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push(url);
      return okResponse('hasil gemini');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil gemini');
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('generativelanguage.googleapis.com'));
  });
});
