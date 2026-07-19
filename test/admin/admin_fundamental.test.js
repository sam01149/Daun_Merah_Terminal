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

const handler = require('../../api/admin.js');

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

test('fundamental_analysis: Cerebras + SambaNova + Groq gagal -> fallback3 Gemini flash (2026-07-19)', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('generativelanguage.googleapis.com')) return okResponse('ranking gemini');
      return errResponse(500);
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking gemini');
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(calls[3].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[3].body.reasoning_effort, 'low');
  });
});

test('fundamental_analysis: semua provider gagal -> 500 "All providers failed"', async () => {
  await withEnv({ CEREBRAS_API_KEY: 'sk-c', SAMBANOVA_API_KEY_CALL1: 'sk-s', GROQ_API_KEY: 'sk-g', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const { req, res } = fakeReqRes();
    await withFetch(async () => errResponse(500), async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /All providers failed/);
  });
});

// ── Helper murni prompt fundamental (2026-07-19): umur rilis + previous ────────
const { _fundAgeDays, _formatFundDataLine } = require('../../api/admin.js');
const NOW_MS = new Date('2026-07-19T12:00:00Z').getTime();

test('_fundAgeDays: YYYY-MM-DD valid -> selisih hari; hari sama -> 0', () => {
  assert.strictEqual(_fundAgeDays('2026-07-16', NOW_MS), 3);
  assert.strictEqual(_fundAgeDays('2026-07-19', NOW_MS), 0);
});

test('_fundAgeDays: seed "—", null, tanggal masa depan, format rusak -> null', () => {
  assert.strictEqual(_fundAgeDays('—', NOW_MS), null);
  assert.strictEqual(_fundAgeDays(null, NOW_MS), null);
  assert.strictEqual(_fundAgeDays('2026-07-25', NOW_MS), null);
  assert.strictEqual(_fundAgeDays('Apr 2026', NOW_MS), null);
});

test('_formatFundDataLine: lengkap -> baris dengan umur rilis + sebelumnya', () => {
  const line = _formatFundDataLine('CPI YoY', { actual: '3.3%', period: 'Jun 2026', date: '2026-07-16', previous: '3.0%' }, NOW_MS);
  assert.strictEqual(line, '  CPI YoY: 3.3% (Jun 2026) [rilis 3 hari lalu; sebelumnya 3.0%]');
});

test('_formatFundDataLine: seed tanpa date/previous -> format lama tanpa bracket', () => {
  const line = _formatFundDataLine('NFP', { actual: '178K', period: 'Apr 2026', date: '—' }, NOW_MS);
  assert.strictEqual(line, '  NFP: 178K (Apr 2026)');
});

test('_formatFundDataLine: previous sama dengan actual atau "—" -> tidak ditulis', () => {
  const a = _formatFundDataLine('GDP QoQ', { actual: '0.8%', period: 'Q1', date: '2026-07-19', previous: '0.8%' }, NOW_MS);
  assert.strictEqual(a, '  GDP QoQ: 0.8% (Q1) [rilis hari ini]');
  const b = _formatFundDataLine('GDP QoQ', { actual: '0.8%', period: 'Q1', date: '—', previous: '—' }, NOW_MS);
  assert.strictEqual(b, '  GDP QoQ: 0.8% (Q1)');
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
