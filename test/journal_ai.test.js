// test/journal_ai.test.js
// Unit test journal.js aiCall() 4-tier fallback (session 145 re-arsitektur Nemotron,
// + Gemini 2026-07-19): dulu Groq-only tanpa fallback sama sekali, sekarang Cerebras
// gpt-oss-120b primary -> SambaNova akun2 fallback1 -> Groq fallback2 -> Gemini flash
// fallback3. Redis tidak dikonfigurasi di test ini, jadi circuit breaker/budget guard
// fail-open (lihat guards.test.js) — test ini fokus ke urutan fallback HTTP-level,
// bukan skip akibat circuit OPEN.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const ENV_KEYS = ['CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY_CALL1', 'GROQ_API_KEY', 'GEMINI_API_KEY'];

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
delete require.cache[require.resolve('../api/journal.js')];
const { _aiCall: aiCall } = require('../api/journal.js');

test('aiCall: Cerebras primary sukses — cuma 1 fetch call, ke api.cerebras.ai dengan model gpt-oss-120b', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('hasil cerebras');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil cerebras');
    });
    assert.strictEqual(calls.length, 1, 'harus berhenti di tier pertama, tidak lanjut fallback');
    assert.strictEqual(calls[0].url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'gpt-oss-120b');
  });
});

test('aiCall: Cerebras gagal (HTTP 500) -> fallback1 SambaNova akun2 (DeepSeek-V3.2)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('cerebras.ai')) return errResponse(500);
      if (url.includes('sambanova.ai')) return okResponse('hasil sambanova');
      throw new Error('should not reach ' + url);
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil sambanova');
    });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].url.includes('sambanova.ai'));
    assert.strictEqual(calls[1].body.model, 'DeepSeek-V3.2');
  });
});

test('aiCall: Cerebras + SambaNova gagal -> fallback2 Groq (llama-3.3-70b-versatile)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('cerebras.ai'))  return errResponse(500);
      if (url.includes('sambanova.ai')) return errResponse(503);
      if (url.includes('groq.com'))     return okResponse('hasil groq');
      throw new Error('should not reach ' + url);
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil groq');
    });
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[2].body.model, 'llama-3.3-70b-versatile');
  });
});

test('aiCall: Cerebras + SambaNova + Groq gagal -> fallback3 Gemini flash (gemini-flash-latest, reasoning_effort low)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('generativelanguage.googleapis.com')) return okResponse('hasil gemini');
      return errResponse(500);
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil gemini');
    });
    assert.strictEqual(calls.length, 4);
    assert.ok(calls[3].url.includes('generativelanguage.googleapis.com'));
    assert.strictEqual(calls[3].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[3].body.reasoning_effort, 'low');
  });
});

test('aiCall: semua 4 tier gagal -> melempar error agregat (bukan error Groq mentah)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g', GEMINI_API_KEY: 'sk-gm' }, async () => {
    await withFetch(async () => errResponse(500), async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed/);
    });
  });
});

test('aiCall: tanpa GEMINI_API_KEY, Groq gagal -> tetap melempar (tier Gemini di-skip)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    await withFetch(async (url) => { calls.push(url); return errResponse(429); }, async () => {
      await assert.rejects(() => aiCall([{ role: 'user', content: 'hi' }], 500), /All AI providers failed/);
    });
    assert.strictEqual(calls.length, 3, 'Gemini tidak boleh ikut dipanggil tanpa key');
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

test('aiCall: CEREBRAS_API_KEY kosong -> langsung ke SambaNova (skip tier 1 tanpa error)', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s' }, async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
      calls.push(url);
      return okResponse('hasil sambanova');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil sambanova');
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('sambanova.ai'));
  });
});
