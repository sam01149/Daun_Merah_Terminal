// test/journal_ai.test.js
// Unit test journal.js aiCall() — Gemini flash satu-satunya provider (SambaNova akun2
// diputus kontrak 2026-08-12, billing lapse tak terpulihkan meski ganti API key, lihat
// daun_merah_vendor.md; Cerebras/Groq diputus kontraknya 2026-07-25). Nemotron 3 Ultra
// via OpenCode Zen SEMPAT dipasang 2026-08-25, DIBATALKAN hari yang sama — ToS resmi
// OpenCode Zen sendiri: Nemotron Free "Trial use only — do not submit personal or
// confidential data" + wajib setuju NVIDIA API Trial ToS (blocker sama yang sudah
// menolak Nemotron 2026-08-11, lihat daun_merah_vendor.md §2). Redis tidak dikonfigurasi
// di test ini, jadi circuit breaker/budget guard fail-open (lihat guards.test.js) — test
// ini fokus ke HTTP-level, bukan skip akibat circuit OPEN.
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

test('aiCall: Gemini gagal di percobaan 1, sukses di percobaan 2 -> retry menyelamatkan (2026-08-25 fix)', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return calls === 1 ? errResponse(503) : okResponse('hasil percobaan kedua');
    }, async () => {
      const out = await aiCall([{ role: 'user', content: 'hi' }], 500);
      assert.strictEqual(out, 'hasil percobaan kedua');
    });
    assert.strictEqual(calls, 2, 'harus retry tepat 1x (total 2 fetch call), bukan langsung menyerah di percobaan pertama');
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
