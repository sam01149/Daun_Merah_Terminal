// test/admin_fundamental.test.js
// Unit test fundamentalAnalysisHandler (api/admin.js): SambaNova akun 2 = primary,
// Gemini = fallback (2026-08-11, keputusan eksplisit user — Gemini dianggap model
// lemah/kurang worth walau gratis, didemote ke fallback saja. Sempat 1 hari jadi
// satu-satunya provider 2026-08-10 sebelum HTTP 500 di produksi memicu switch ini).
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

test('fundamental_analysis: SambaNova akun2 sukses — 1 fetch call ke api.sambanova.ai model DeepSeek-V3.2, Gemini tidak disentuh', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return okResponse('ranking sambanova');
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking sambanova');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.sambanova.ai/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'DeepSeek-V3.2');
  });
});

test('fundamental_analysis: SambaNova akun2 gagal (2x) -> fallback ke Gemini, tetap 200', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push(url);
      if (url.includes('sambanova.ai')) return errResponse(503);
      return okResponse('ranking gemini fallback');
    }, async () => {
      await handler(req, res);
    });
    // 2x retry SambaNova + 1x Gemini fallback
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0], 'https://api.sambanova.ai/v1/chat/completions');
    assert.strictEqual(calls[1], 'https://api.sambanova.ai/v1/chat/completions');
    assert.strictEqual(calls[2], 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking gemini fallback');
  });
});

test('fundamental_analysis: hanya Gemini key tersedia (tanpa SambaNova) — langsung pakai Gemini', async () => {
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
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.strictEqual(calls[0].body.model, 'gemini-flash-latest');
    assert.strictEqual(calls[0].body.reasoning_effort, 'low');
  });
});

test('fundamental_analysis: SambaNova akun2 (retry 1x) + Gemini semua gagal -> 500', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const { req, res } = fakeReqRes();
    await withFetch(async () => errResponse(500), async () => {
      await handler(req, res);
    });
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /All AI providers failed/);
  });
});

// Regresi bug 2026-08-11 (laporan user — HTTP 500 di produksi saat Gemini masih
// satu-satunya provider): 5xx transient direproduksi live saat diagnosa (percobaan
// ulang identik langsung sukses). Retry 1x di primary (sekarang SambaNova akun2)
// supaya satu blip tidak langsung jatuh ke fallback/gagal total.
test('fundamental_analysis: SambaNova akun2 percobaan 1 gagal (503), percobaan 2 sukses -> 200, tanpa sentuh Gemini', async () => {
  await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s', GEMINI_API_KEY: 'sk-gm' }, async () => {
    const calls = [];
    const { req, res } = fakeReqRes();
    await withFetch(async (url, opts) => {
      calls.push(url);
      if (calls.length === 1) return errResponse(503);
      return okResponse('ranking sambanova retry');
    }, async () => {
      await handler(req, res);
    });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls.every(u => u.includes('sambanova.ai')));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.analysis, 'ranking sambanova retry');
  });
});

// Integrasi penuh fitur "pergerakan ranking vs update sebelumnya" (2026-08-11) —
// simulasikan Redis lewat stub fetch generik (semua modul cb/_ai_guard/redisCmd di
// admin.js pakai pola POST(['CMD',...args]) yang sama ke base URL yang sama) supaya
// previousObj benar-benar terbaca dari "cache lama", bukan cuma dites di isolasi
// lewat unit test helper murni di atas.
test('fundamental_analysis: cache lama ada ranking -> delta ditempel ke analysis + ranking baru ikut tersimpan', async () => {
  const REDIS_URL = 'https://fake-redis.example.com';
  const prevObj = {
    analysis: 'analisa lama', generated_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    ranking: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'],
  };
  const newAnalysisText = [
    'TEMA MAKRO LINTAS-CURRENCY:', 'Isi tema.', '',
    'RANKING KEKUATAN FUNDAMENTAL:',
    '1. AUD — a', '2. USD — b', '3. GBP — c', '4. JPY — d', '5. CAD — e', '6. EUR — f', '7. NZD — g', '8. CHF — h', '',
    'TERKUAT: AUD', 'Isi.',
  ].join('\n');

  let setBody = null;
  const prevEnv = { UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN };
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  try {
    await withEnv({ SAMBANOVA_API_KEY_CALL1: 'sk-s' }, async () => {
      const { req, res } = fakeReqRes();
      await withFetch(async (url, opts) => {
        if (url === REDIS_URL) {
          const cmd = JSON.parse(opts.body);
          if (cmd[0] === 'GET' && cmd[1] === 'fundamental_analysis') return { json: async () => ({ result: JSON.stringify(prevObj) }) };
          if (cmd[0] === 'SET' && cmd[1] === 'fundamental_analysis') { setBody = JSON.parse(cmd[2]); }
          return { json: async () => ({ result: null }) };
        }
        return okResponse(newAnalysisText);
      }, async () => {
        await handler(req, res);
      });
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.body.analysis, /PERGERAKAN RANKING VS UPDATE SEBELUMNYA \(~6 jam lalu\):/);
      assert.match(res.body.analysis, /AUD naik ke #1 \(dari #6\)/);
      assert.match(res.body.analysis, /USD turun ke #2 \(dari #1\)/);
      assert.deepStrictEqual(res.body.ranking, ['AUD', 'USD', 'GBP', 'JPY', 'CAD', 'EUR', 'NZD', 'CHF']);
      assert.deepStrictEqual(setBody.ranking, ['AUD', 'USD', 'GBP', 'JPY', 'CAD', 'EUR', 'NZD', 'CHF']);
    });
  } finally {
    for (const k of Object.keys(prevEnv)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  }
});

// ── Helper murni prompt fundamental (2026-07-19): umur rilis + previous ────────
const { _fundAgeDays, _fundSeedAgeDays, _formatFundDataLine, _stripMarkdown, _parseFundRankingOrder, _formatFundRankingDelta } = require('../../api/admin.js');
const NOW_MS = new Date('2026-07-19T12:00:00Z').getTime();

// ── _parseFundRankingOrder / _formatFundRankingDelta (2026-08-11) — fitur "pergerakan
// ranking vs update sebelumnya": delta dihitung DI KODE dari ranking yang sudah
// di-generate, bukan diminta AI menghitung sendiri (rawan salah/hallucinate). ──
const SAMPLE_RANKING_TEXT = `TEMA MAKRO LINTAS-CURRENCY:
Isi tema.

RANKING KEKUATAN FUNDAMENTAL:
1. AUD — alasan
2. CAD — alasan
3. USD — alasan
4. GBP — alasan
5. EUR — alasan
6. NZD — alasan
7. JPY — alasan
8. CHF — alasan

TERKUAT: AUD
Isi.`;

test('_parseFundRankingOrder: section standar -> array 8 currency berurutan', () => {
  const r = _parseFundRankingOrder(SAMPLE_RANKING_TEXT);
  assert.deepStrictEqual(r, ['AUD', 'CAD', 'USD', 'GBP', 'EUR', 'NZD', 'JPY', 'CHF']);
});

test('_parseFundRankingOrder: section tidak ada -> null', () => {
  assert.strictEqual(_parseFundRankingOrder('Teks tanpa section ranking sama sekali.'), null);
});

test('_parseFundRankingOrder: currency kurang dari 8 (format AI menyimpang) -> null', () => {
  const bad = 'RANKING KEKUATAN FUNDAMENTAL:\n1. AUD — a\n2. CAD — b\n\nTERKUAT: AUD';
  assert.strictEqual(_parseFundRankingOrder(bad), null);
});

test('_parseFundRankingOrder: null/kosong -> null, tidak crash', () => {
  assert.strictEqual(_parseFundRankingOrder(null), null);
  assert.strictEqual(_parseFundRankingOrder(''), null);
});

test('_formatFundRankingDelta: naik/turun/tetap terhitung benar', () => {
  const prev = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'];
  const next = ['AUD', 'USD', 'GBP', 'JPY', 'CAD', 'EUR', 'NZD', 'CHF']; // AUD naik #6->#1, EUR turun #2->#6, sisanya tetap
  const r = _formatFundRankingDelta(prev, next, '~6 jam lalu');
  assert.match(r, /^PERGERAKAN RANKING VS UPDATE SEBELUMNYA \(~6 jam lalu\):/);
  assert.match(r, /AUD naik ke #1 \(dari #6\)/);
  assert.match(r, /USD turun ke #2 \(dari #1\)/);
  assert.match(r, /EUR turun ke #6 \(dari #2\)/);
  assert.match(r, /GBP tetap #3/);
  assert.match(r, /CHF tetap #8/);
});

test('_formatFundRankingDelta: array bukan 8 currency atau null -> null (fail-open)', () => {
  assert.strictEqual(_formatFundRankingDelta(null, ['USD'], '~6 jam lalu'), null);
  assert.strictEqual(_formatFundRankingDelta(['USD'], ['USD'], '~6 jam lalu'), null);
});

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
