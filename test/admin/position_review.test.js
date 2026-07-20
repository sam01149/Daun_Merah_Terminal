// test/admin/position_review.test.js
// Unit test PLAN U-5a: review posisi VIRTUAL (api/_position_review.js pure functions
// + handler position_review di api/admin.js). Pola sama dengan setup_override.test.js
// (fakeReqRes + upstashStub) + ta_struct.test.js (fixture candle).
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { validateTightenSl, _evaluateManaged, _aggManagementStats, isCorroborated } = require('../../api/_position_review.js');
const handler = require('../../api/admin.js');

// ── validateTightenSl ───────────────────────────────────────────────────────

test('validateTightenSl: bearish — SL lebih ketat (turun) & belum tersentuh & tetap di atas zona entry -> valid', () => {
  const ok = validateTightenSl({ bias: 'bearish', slOld: 4065, newSl: 4050, closeLast: 4020, eLo: 4030, eHi: 4040 });
  assert.equal(ok, true);
});

test('validateTightenSl: bearish — SL melebar (naik, bukan turun) -> ditolak', () => {
  const ok = validateTightenSl({ bias: 'bearish', slOld: 4065, newSl: 4070, closeLast: 4020, eLo: 4030, eHi: 4040 });
  assert.equal(ok, false);
});

test('validateTightenSl: bearish — SL baru sudah tertembus harga sekarang -> ditolak', () => {
  const ok = validateTightenSl({ bias: 'bearish', slOld: 4065, newSl: 4015, closeLast: 4020, eLo: 4030, eHi: 4040 });
  assert.equal(ok, false);
});

test('validateTightenSl: bearish — SL baru menyalip ke dalam/di bawah zona entry -> ditolak', () => {
  const ok = validateTightenSl({ bias: 'bearish', slOld: 4065, newSl: 4035, closeLast: 4020, eLo: 4030, eHi: 4040 });
  assert.equal(ok, false);
});

test('validateTightenSl: bullish — SL lebih ketat (naik) & belum tersentuh & tetap di bawah zona entry -> valid', () => {
  const ok = validateTightenSl({ bias: 'bullish', slOld: 1.1650, newSl: 1.1680, closeLast: 1.1720, eLo: 1.1700, eHi: 1.1710 });
  assert.equal(ok, true);
});

test('validateTightenSl: bullish — SL melebar (turun) -> ditolak', () => {
  const ok = validateTightenSl({ bias: 'bullish', slOld: 1.1650, newSl: 1.1600, closeLast: 1.1720, eLo: 1.1700, eHi: 1.1710 });
  assert.equal(ok, false);
});

test('validateTightenSl: bullish — SL baru menyalip ke dalam/di atas zona entry -> ditolak', () => {
  const ok = validateTightenSl({ bias: 'bullish', slOld: 1.1650, newSl: 1.1705, closeLast: 1.1720, eLo: 1.1700, eHi: 1.1710 });
  assert.equal(ok, false);
});

test('validateTightenSl: input non-finite / bias tak dikenal -> ditolak, bukan crash', () => {
  assert.equal(validateTightenSl({ bias: 'bearish', slOld: NaN, newSl: 4050, closeLast: 4020 }), false);
  assert.equal(validateTightenSl({ bias: 'sideways', slOld: 4065, newSl: 4050, closeLast: 4020 }), false);
});

// ── _evaluateManaged ─────────────────────────────────────────────────────────

const DAY = 86400;
const mkC = (i, o, h, l, c) => ({ t: i * 3600, o, h, l, c, v: 0 });

test('_evaluateManaged: tighten_sl bearish, new_sl tersentuh duluan -> managed_status sl', () => {
  const setups = [{
    symbol: 'GC=F', bias: 'bearish', tp: '3960',
    intervention: { type: 'tighten_sl', t: 5 * 3600, new_sl: 4050 },
    managed_status: null,
  }];
  const candles = { 'GC=F': [mkC(6, 4020, 4055, 4015, 4018), mkC(7, 4018, 4019, 3950, 3955)] };
  _evaluateManaged(setups, candles);
  assert.equal(setups[0].managed_status, 'sl');
  assert.equal(setups[0].managed_closed_t, 6 * 3600);
});

test('_evaluateManaged: tighten_sl bearish, TP asli tersentuh duluan -> managed_status tp', () => {
  const setups = [{
    symbol: 'GC=F', bias: 'bearish', tp: '3960',
    intervention: { type: 'tighten_sl', t: 5 * 3600, new_sl: 4050 },
    managed_status: null,
  }];
  const candles = { 'GC=F': [mkC(6, 4018, 4019, 3955, 3958)] };
  _evaluateManaged(setups, candles);
  assert.equal(setups[0].managed_status, 'tp');
});

test('_evaluateManaged: new_sl & TP tersentuh di candle sama -> ambiguous', () => {
  const setups = [{
    symbol: 'GC=F', bias: 'bearish', tp: '3960',
    intervention: { type: 'tighten_sl', t: 5 * 3600, new_sl: 4050 },
    managed_status: null,
  }];
  const candles = { 'GC=F': [mkC(6, 4020, 4055, 3950, 3958)] };
  _evaluateManaged(setups, candles);
  assert.equal(setups[0].managed_status, 'ambiguous');
});

test('_evaluateManaged: belum tersentuh -> managed_status tetap null (bukan crash)', () => {
  const setups = [{
    symbol: 'GC=F', bias: 'bearish', tp: '3960',
    intervention: { type: 'tighten_sl', t: 5 * 3600, new_sl: 4050 },
    managed_status: null,
  }];
  const candles = { 'GC=F': [mkC(6, 4020, 4030, 4010, 4018)] };
  _evaluateManaged(setups, candles);
  assert.equal(setups[0].managed_status, null);
});

test('_evaluateManaged: sudah punya managed_status -> tidak dievaluasi ulang', () => {
  const setups = [{
    symbol: 'GC=F', bias: 'bearish', tp: '3960',
    intervention: { type: 'tighten_sl', t: 5 * 3600, new_sl: 4050 },
    managed_status: 'sl', managed_closed_t: 6 * 3600,
  }];
  const candles = { 'GC=F': [mkC(9, 4018, 4019, 3950, 3958)] }; // andai dievaluasi ulang harusnya jadi tp
  _evaluateManaged(setups, candles);
  assert.equal(setups[0].managed_status, 'sl');
});

test('_evaluateManaged: intervention close_early (bukan tighten_sl) -> diabaikan, tidak diutak-atik', () => {
  const setups = [{ symbol: 'GC=F', bias: 'bearish', tp: '3960', intervention: { type: 'close_early', t: 0 }, managed_status: 'closed_early' }];
  _evaluateManaged(setups, { 'GC=F': [mkC(6, 4018, 4019, 3950, 3958)] });
  assert.equal(setups[0].managed_status, 'closed_early');
});

test('_evaluateManaged: entri lama tanpa field intervention/managed_status -> aman, tidak crash', () => {
  const setups = [{ symbol: 'GC=F', bias: 'bearish', status: 'open' }, null, {}];
  assert.doesNotThrow(() => _evaluateManaged(setups, { 'GC=F': [mkC(6, 4018, 4019, 3950, 3958)] }));
});

// ── _aggManagementStats ────────────────────────────────────────────────────────

test('_aggManagementStats: reviews/hold/tighten/close_early + saved/cost dari ghost status apa adanya', () => {
  const arr = [
    { review_count: 1, intervention: null, status: 'tp' }, // HOLD (reviewed, no intervention)
    { review_count: 1, intervention: { type: 'tighten_sl' }, status: 'sl' }, // tighten_saved (ghost=sl)
    { review_count: 1, intervention: { type: 'tighten_sl' }, status: 'tp' }, // tighten_cost (ghost=tp)
    { review_count: 1, intervention: { type: 'close_early' }, status: 'sl' }, // close_early_saved
    { review_count: 1, intervention: { type: 'close_early' }, status: 'tp' }, // close_early_cost
    { review_count: 1, intervention: { type: 'close_early' }, status: 'open' }, // close_early_ghost_pending
    { review_count: 0, intervention: null, status: 'pending' }, // belum pernah direview
  ];
  const m = _aggManagementStats(arr);
  assert.equal(m.reviews, 6);
  assert.equal(m.tighten_sl, 2);
  assert.equal(m.close_early, 3);
  assert.equal(m.hold, 1);
  assert.equal(m.tighten_saved, 1);
  assert.equal(m.tighten_cost, 1);
  assert.equal(m.close_early_saved, 1);
  assert.equal(m.close_early_cost, 1);
  assert.equal(m.close_early_ghost_pending, 1);
});

test('_aggManagementStats: array kosong -> semua nol, bukan crash', () => {
  const m = _aggManagementStats([]);
  assert.deepEqual(m, {
    reviews: 0, hold: 0, tighten_sl: 0, close_early: 0,
    close_early_saved: 0, close_early_cost: 0, close_early_ghost_pending: 0,
    tighten_saved: 0, tighten_cost: 0,
  });
});

// ── isCorroborated ──────────────────────────────────────────────────────────

test('isCorroborated: market-moving selalu corroborated by default', () => {
  assert.equal(isCorroborated({ cat: 'market-moving', title: 'Fed hikes rates', pubDate: '2026-07-20T10:00:00Z' }, []), true);
});

test('isCorroborated: geopolitical satu item sendirian -> false (unconfirmed)', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  assert.equal(isCorroborated(item, [item]), false);
});

test('isCorroborated: geopolitical + item lain guid beda, overlap >=2 token, dalam 30 menit -> true', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T10:15:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), true);
});

test('isCorroborated: item lain di luar jendela 30 menit -> false', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T11:00:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), false);
});

test('isCorroborated: item lain overlap token <2 -> false', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Stock market rallies on earnings', pubDate: '2026-07-20T10:05:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), false);
});

test('isCorroborated: kategori lain (bukan market-moving/geopolitical) -> false', () => {
  assert.equal(isCorroborated({ cat: 'lainnya', title: 'x', pubDate: '2026-07-20T10:00:00Z' }, []), false);
});

// ── Handler position_review (api/admin.js) ──────────────────────────────────

function fakeReqRes({ method = 'POST', headers = {}, body = '' } = {}) {
  const resHeaders = {};
  const req = {
    method,
    query: { action: 'position_review' },
    headers,
    url: '/api/admin?action=position_review',
    on(event, cb) {
      if (event === 'data' && body) cb(body);
      if (event === 'end') cb();
    },
  };
  const res = {
    setHeader: (k, v) => { resHeaders[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
  return { req, res };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, APP_KEY: process.env.APP_KEY, SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.APP_KEY; delete process.env.SAMBANOVA_API_KEY; delete process.env.GROQ_API_KEY;
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally {
    delete process.env.CRON_SECRET; delete process.env.APP_KEY; delete process.env.SAMBANOVA_API_KEY; delete process.env.GROQ_API_KEY;
    for (const k of Object.keys(prev)) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

async function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = orig; }
}

// Stub gabungan: Upstash Redis REST (setup_log_auto/candle/calendar/circuit/budget) +
// SambaNova AI. `log` di-mutate in-place oleh SET supaya assertion baca state akhir.
// PLAN U-7 (REVISI VISIBILITAS 2026-07-20): position_review HANYA melayani setup
// eksperimen di `setup_log_auto:v1` (dulu `setup_log:v1` sebelum revisi) — fixture
// `log` di sini merepresentasikan log EKSPERIMEN, bukan log manual pengguna.
function combinedStub({ log, candles = [], calThis = { events: [] }, calNext = { events: [] }, aiJson, aiFail = false }) {
  return async (url, opts) => {
    if (typeof url === 'string' && url.includes('sambanova.ai')) {
      if (aiFail || aiJson === undefined) throw new Error('AI down (test)');
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(aiJson) } }] }) };
    }
    const args = JSON.parse(opts.body);
    if (args[0] === 'GET') {
      const key = args[1];
      if (key === 'setup_log_auto:v1') return { ok: true, json: async () => ({ result: JSON.stringify(log) }) };
      if (key === 'setup_log:v1') return { ok: true, json: async () => ({ result: null }) }; // log manual kosong di test ini
      if (String(key).startsWith('ohlcv:')) return { ok: true, json: async () => ({ result: candles.length ? JSON.stringify(candles) : null }) };
      if (key === 'calendar_v1') return { ok: true, json: async () => ({ result: JSON.stringify(calThis) }) };
      if (key === 'calendar_next_v1') return { ok: true, json: async () => ({ result: JSON.stringify(calNext) }) };
      return { ok: true, json: async () => ({ result: null }) }; // circuit state dll -> fail-open
    }
    if (args[0] === 'SET') {
      if (args[1] === 'setup_log_auto:v1') { log.length = 0; log.push(...JSON.parse(args[2])); }
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (args[0] === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
    return { ok: true, json: async () => ({ result: 'OK' }) }; // LPUSH/LTRIM/EXPIRE dll
  };
}

const openSetup = { id: 'GC=F:1', symbol: 'GC=F', label: 'XAU/USD', bias: 'bearish', entry_zone: '4030-4040', sl: '4065', tp: '3960', status: 'open', ts: 1000, filled_t: 1500, review_count: 0, intervention: null, managed_status: null, managed_closed_t: null };

test('position_review: tanpa secret -> 401', async () => {
  await withEnv({}, async () => {
    const { req, res } = fakeReqRes({ headers: {}, body: JSON.stringify({ id: 'x', trigger: { guid: 'g', title: 't' } }) });
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test('position_review: method GET -> 405', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ method: 'GET', headers: { 'x-cron-secret': 'rahasia' } });
    await handler(req, res);
    assert.equal(res.statusCode, 405);
  });
});

test('position_review: tanpa trigger.guid/title -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'x' }) });
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });
});

test('position_review: id tidak ditemukan -> 404', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'tidak-ada', trigger: { guid: 'g', title: 't' } }) });
    await withFetch(combinedStub({ log }), async () => { await handler(req, res); });
    assert.equal(res.statusCode, 404);
  });
});

test('position_review: setup status bukan open (sudah tp) -> skip not_open, TANPA call AI', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...openSetup, status: 'tp' }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't' } }) });
    // aiJson undefined -> stub throw kalau sampai dipanggil -> test gagal kalau AI benar2 dipanggil
    await withFetch(combinedStub({ log }), async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, 'not_open');
  });
});

test('position_review: sudah punya intervention -> skip already_managed, TANPA call AI', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...openSetup, intervention: { type: 'tighten_sl', t: 1, new_sl: 4050 } }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't' } }) });
    await withFetch(combinedStub({ log }), async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, 'already_managed');
  });
});

test('position_review: AI HOLD -> review_count naik, tidak ada intervention', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)], aiJson: { decision: 'HOLD', new_sl: null, reason: 'aman', confidence: 'sedang' } }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'HOLD');
    assert.equal(res.body.setup.review_count, 1);
    assert.equal(res.body.setup.intervention, null);
  });
});

test('position_review: AI TIGHTEN_SL valid -> intervention tersimpan, data mentah tidak berubah', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)], aiJson: { decision: 'TIGHTEN_SL', new_sl: 4050, reason: 'risk naik', confidence: 'tinggi' } }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'TIGHTEN_SL');
    assert.equal(res.body.setup.intervention.type, 'tighten_sl');
    assert.equal(res.body.setup.intervention.new_sl, 4050);
    // Data mentah TIDAK disentuh
    assert.equal(res.body.setup.sl, '4065');
    assert.equal(res.body.setup.status, 'open');
  });
});

test('position_review: AI TIGHTEN_SL dengan new_sl melebar -> downgrade ke HOLD, intervention tetap null', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)], aiJson: { decision: 'TIGHTEN_SL', new_sl: 4070, reason: 'x', confidence: 'tinggi' } }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'HOLD');
    assert.equal(res.body.downgraded, true);
    assert.equal(res.body.setup.intervention, null);
  });
});

test('position_review: AI CLOSE_EARLY valid -> managed_status closed_early, price dari close candle terakhir (bukan karangan AI)', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018.5)], aiJson: { decision: 'CLOSE_EARLY', new_sl: null, reason: 'tesis batal', confidence: 'tinggi' } }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'CLOSE_EARLY');
    assert.equal(res.body.setup.managed_status, 'closed_early');
    assert.equal(res.body.setup.intervention.price, 4018.5);
    assert.equal(res.body.setup.status, 'open'); // ghost/status pasif tidak disentuh -> tetap dievaluasi normal
  });
});

test('position_review: AI down (timeout/offline) -> downgrade HOLD, TIDAK ada intervensi tanpa output valid', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)], aiFail: true }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'HOLD');
    assert.equal(res.body.downgraded, true);
    assert.equal(res.body.setup.intervention, null);
  });
});

test('position_review: output AI JSON tak patuh skema -> downgrade HOLD, bukan crash', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const log = [{ ...openSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    const stub = combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)] });
    const badStub = async (url, opts) => {
      if (typeof url === 'string' && url.includes('sambanova.ai')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'bukan json' } }] }) };
      }
      return stub(url, opts);
    };
    await withFetch(badStub, async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, 'HOLD');
    assert.equal(res.body.downgraded, true);
  });
});

test('position_review: setup lama tanpa field U-5a (intervention/review_count undefined) -> tetap diproses aman', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const oldSetup = { id: 'GC=F:2', symbol: 'GC=F', label: 'XAU/USD', bias: 'bearish', entry_zone: '4030-4040', sl: '4065', tp: '3960', status: 'open', ts: 1000, filled_t: 1500 };
    const log = [oldSetup];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:2', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }) });
    await withFetch(combinedStub({ log, candles: [mkC(1, 4020, 4025, 4015, 4018)], aiJson: { decision: 'HOLD', new_sl: null, reason: 'aman', confidence: 'sedang' } }),
      async () => { await handler(req, res); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.setup.review_count, 1);
  });
});
