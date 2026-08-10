// test/admin_fundamental.test.js
// Unit test fundamentalAnalysisHandler (api/admin.js): Gemini flash = satu-satunya
// provider (2026-08-10, permintaan eksplisit user — jangan pakai model
// DeepSeek/SambaNova di fitur ini; dulu 2-tier SambaNova primary -> Gemini fallback).
// Redis/APP_KEY tidak dikonfigurasi -> semua guard fail-open (lihat guards.test.js),
// jadi test ini murni memverifikasi pemanggilan HTTP lewat handler penuh.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.APP_KEY;
delete process.env.CRON_SECRET;

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

test('fundamental_analysis: Gemini sukses — 1 fetch call ke generativelanguage.googleapis.com model gemini-flash-latest', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('ranking gemini');
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking gemini');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.strictEqual(calls[0].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[0].body.reasoning_effort, 'low');
  });
});

test('fundamental_analysis: SambaNova key ada tapi TIDAK dipakai (Gemini satu-satunya provider) — tidak ada fetch ke sambanova.ai', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('ranking gemini');
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.length, 1);
    assert.ok(!calls[0].url.includes('sambanova.ai'));
  });
});

test('fundamental_analysis: Gemini gagal -> 500 "Gemini failed"', async () => {
  await withEnv({ GEMINI_API_KEY: 'sk-gm' }, async () => {
    const { req, res } = fakeReqRes();
    await withFetch(async () => errResponse(500), async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /Gemini failed/);
  });
});

// ── Helper murni prompt fundamental (2026-07-19): umur rilis + previous ────────
const { _fundAgeDays, _fundSeedAgeDays, _formatFundDataLine, _stripMarkdown } = require('../../api/admin.js');
const NOW_MS = new Date('2026-07-19T12:00:00Z').getTime();

// ── _stripMarkdown (2026-08-10): Gemini tetap menulis markdown walau prompt sudah
// eksplisit melarang — output ditampilkan via textContent (plain text), jadi asterisk
// dkk harus dibuang di kode, bukan cuma diminta lewat instruksi prompt (temuan live). ──

test('_stripMarkdown: bold/italic/kode inline dibuang, teks di dalamnya dipertahankan', () => {
  assert.strictEqual(_stripMarkdown('**USD** kuat karena *inflasi* dan `Core PCE`'), 'USD kuat karena inflasi dan Core PCE');
});

test('_stripMarkdown: header "### Judul" -> "Judul"', () => {
  assert.strictEqual(_stripMarkdown('### TEMA MAKRO\nIsi'), 'TEMA MAKRO\nIsi');
});

test('_stripMarkdown: baris pemisah "---"/"***" dibuang total, sisa baris kosong dirapikan', () => {
  assert.strictEqual(_stripMarkdown('Baris A\n\n---\n\nBaris B'), 'Baris A\n\nBaris B');
});

test('_stripMarkdown: bullet "- "/"* " di awal baris dibuang, sisa teks tetap', () => {
  assert.strictEqual(_stripMarkdown('- AUD kuat\n* CHF lemah'), 'AUD kuat\nCHF lemah');
});

test('_stripMarkdown: angka negatif/persen TIDAK ikut kepotong (bukan salah dikira bullet/italic)', () => {
  assert.strictEqual(_stripMarkdown('NFP -23K, CPI -0.1%, RBA 4.35%'), 'NFP -23K, CPI -0.1%, RBA 4.35%');
});

test('_stripMarkdown: kosong/null -> dikembalikan apa adanya, tidak crash', () => {
  assert.strictEqual(_stripMarkdown(''), '');
  assert.strictEqual(_stripMarkdown(null), null);
});

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

// ── Plan W-3 (2026-08-03): hint umur SEJAK SEED saat `date` masih '—' ──────────

test('_fundSeedAgeDays: seededAt valid -> selisih hari; hari sama -> 0; kosong/rusak -> null', () => {
  assert.strictEqual(_fundSeedAgeDays('2026-07-16T00:00:00.000Z', NOW_MS), 3);
  assert.strictEqual(_fundSeedAgeDays('2026-07-19T12:00:00.000Z', NOW_MS), 0);
  assert.strictEqual(_fundSeedAgeDays(null, NOW_MS), null);
  assert.strictEqual(_fundSeedAgeDays(undefined, NOW_MS), null);
  assert.strictEqual(_fundSeedAgeDays('not-a-date', NOW_MS), null);
});

test('_formatFundDataLine: date "—" TAPI seeded_at ada -> hint umur sejak seed (bukan silently kosong)', () => {
  const line = _formatFundDataLine('GDP QoQ', { actual: '0.3%', period: 'Q1 2026', date: '—', source: 'seed', seeded_at: '2026-07-16T00:00:00.000Z' }, NOW_MS);
  assert.strictEqual(line, '  GDP QoQ: 0.3% (Q1 2026) [berdasar data seed, belum terkonfirmasi update — sejak 3 hari lalu]');
});

test('_formatFundDataLine: date "—" DAN seeded_at TIDAK ada (data lama pra-fix) -> tetap format lama, tanpa hint (regresi)', () => {
  const line = _formatFundDataLine('NFP', { actual: '178K', period: 'Apr 2026', date: '—', source: 'seed' }, NOW_MS);
  assert.strictEqual(line, '  NFP: 178K (Apr 2026)');
});

test('_formatFundDataLine: date valid (bukan seed) menang atas seeded_at (age rilis dipakai, bukan age seed)', () => {
  const line = _formatFundDataLine('CPI YoY', { actual: '3.3%', period: 'Jun 2026', date: '2026-07-16', seeded_at: '2020-01-01T00:00:00.000Z' }, NOW_MS);
  assert.strictEqual(line, '  CPI YoY: 3.3% (Jun 2026) [rilis 3 hari lalu]');
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

test('fundamental_refresh: calendar layer menulis update dan muncul di response', async () => {
  const prevRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  try {
    const req = {
      method: 'GET',
      query: { action: 'fundamental_refresh' },
      headers: { 'x-vercel-cron': '1' },
      url: '/api/admin?action=fundamental_refresh',
    };
    const res = {
      setHeader: () => {},
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; },
      end() { return this; },
    };

    await withFetch(async (url, opts) => {
      if (url === 'https://www.financialjuice.com/feed.ashx?xy=rss') {
        return { ok: true, text: async () => '<rss><channel></channel></rss>' };
      }
      const args = JSON.parse(opts.body);
      const [cmd, key] = args;
      if (cmd === 'GET' && key === 'calendar_v1') {
        return { json: async () => ({ result: JSON.stringify({ events: [{
          date: '2026-08-03', time_wib: '14:00 WIB', currency: 'JPY', event: 'Retail Sales YoY', impact: 'High',
          forecast: '1.8%', previous: '1.7%', actual: '1.9%',
        }] }) }) };
      }
      if (cmd === 'GET' && key === 'calendar_next_v1') {
        return { json: async () => ({ result: null }) };
      }
      if (cmd === 'ZREVRANGE') {
        return { json: async () => ({ result: [] }) };
      }
      if (cmd === 'HMGET' && key === 'fundamental:JPY') {
        return { json: async () => ({ result: [null] }) };
      }
      if (cmd === 'HGET') {
        return { json: async () => ({ result: null }) };
      }
      if (cmd === 'HSET') {
        return { json: async () => ({ result: 1 }) };
      }
      return { json: async () => ({ result: null }) };
    }, async () => {
      await handler(req, res);
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.updated, { JPY: ['Retail Sales YoY'] });
    assert.deepStrictEqual(res.body.calendar_updated, { JPY: ['Retail Sales YoY'] });
    assert.strictEqual(res.body.headlines, 0);
  } finally {
    if (prevRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevRedisUrl;
    if (prevRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevRedisToken;
  }
});
