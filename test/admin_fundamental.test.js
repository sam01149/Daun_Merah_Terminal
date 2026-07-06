// test/admin_fundamental.test.js
// Unit test fundamentalAnalysisHandler (api/admin.js) 3-tier fallback (session 145,
// re-arsitektur Nemotron): dulu Groq primary -> SambaNova akun1 fallback, sekarang
// Cerebras gpt-oss-120b primary -> SambaNova akun2 fallback1 -> Groq fallback2.
// Redis/APP_KEY tidak dikonfigurasi -> semua guard fail-open (lihat guards.test.js),
// jadi test ini murni memverifikasi urutan fallback HTTP-level lewat handler penuh.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.APP_KEY;
delete process.env.CRON_SECRET;

const ENV_KEYS = ['CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY_CALL1', 'GROQ_API_KEY'];

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

function fakeReqRes() {
  const headers = {};
  const req = { method: 'GET', query: { action: 'fundamental_analysis', force: 'true' }, headers: {}, url: '/api/admin?action=fundamental_analysis' };
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
  return { req, res, headers };
}

const handler = require('../api/admin.js');

test('fundamental_analysis: Cerebras primary sukses — 1 fetch call ke api.cerebras.ai model gpt-oss-120b', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('ranking cerebras');
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking cerebras');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'gpt-oss-120b');
  });
});

test('fundamental_analysis: Cerebras gagal -> fallback1 SambaNova akun2 (DeepSeek-V3.2)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('cerebras.ai'))  return errResponse(500);
      if (url.includes('sambanova.ai')) return okResponse('ranking sambanova');
      throw new Error('should not reach ' + url);
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking sambanova');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].body.model, 'DeepSeek-V3.2');
    // Fallback1 harus pakai SAMBANOVA_API_KEY_CALL1 (akun 2), bukan SAMBANOVA_API_KEY (akun 1)
    assert.strictEqual(calls[1].url, 'https://api.sambanova.ai/v1/chat/completions');
  });
});

test('fundamental_analysis: Cerebras + SambaNova gagal -> fallback2 Groq (last resort)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('cerebras.ai'))  return errResponse(500);
      if (url.includes('sambanova.ai')) return errResponse(503);
      if (url.includes('groq.com'))     return okResponse('ranking groq');
      throw new Error('should not reach ' + url);
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking groq');
    assert.strictEqual(calls.length, 3);
  });
});

test('fundamental_analysis: semua provider gagal -> 500 "All providers failed"', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g' }, async () => {
    const { req, res } = fakeReqRes();
    await withFetch(async () => errResponse(500), async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /All providers failed/);
  });
});

test('fundamental_analysis: tanpa API key sama sekali -> 500 tanpa network call', async () => {
  await withEnv({}, async () => {
    const { req, res } = fakeReqRes();
    let fetchCalled = false;
    await withFetch(async () => { fetchCalled = true; return okResponse('x'); }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(fetchCalled, false);
  });
});
