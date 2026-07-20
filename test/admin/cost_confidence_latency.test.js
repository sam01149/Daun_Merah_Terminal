// test/admin/cost_confidence_latency.test.js
// Unit test 3 fungsi murni baru (2026-07-20, diskusi user pasca-Plan U — item #2/#4/#5):
// - _costAdjustedR / _aggCostExpectancy: expectancy R gross vs net-biaya spread estimasi.
// - _confidenceCalibration: win-rate per level confidence AI (tinggi/sedang/rendah).
// - _summarizeLatency: ringkas calendar_actual_latency_log:v1 (avg/median/min/max menit).
// Juga tes integrasi ohlcv_analyze: field `confidence` dinormalisasi & masuk setup_log.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const admin = require('../../api/admin.js');
const { _costAdjustedR, _aggCostExpectancy, _confidenceCalibration, _summarizeLatency } = admin;

// ── _costAdjustedR / _aggCostExpectancy ─────────────────────────────────────

test('_costAdjustedR: status bukan tp/sl -> null', () => {
  assert.equal(_costAdjustedR({ status: 'pending', label: 'EUR/USD' }), null);
  assert.equal(_costAdjustedR({ status: 'open', label: 'EUR/USD' }), null);
});

test('_costAdjustedR: pair tanpa spread di tabel -> null (fail-open)', () => {
  const r = _costAdjustedR({ status: 'tp', label: 'PAIR/TAKDIKENAL', entry_zone: '1.10', sl: '1.09', tp: '1.12', rr: 2 });
  assert.equal(r, null);
});

test('_costAdjustedR: TP menang -> grossR = rr, netR dikurangi spread/risk', () => {
  // EUR/USD spread 0.00012. entry 1.1000, sl 1.0950 -> risk 0.0050. rr=2.
  const r = _costAdjustedR({ status: 'tp', label: 'EUR/USD', entry_zone: '1.1000', sl: '1.0950', tp: '1.1100', rr: 2 });
  assert.equal(r.grossR, 2);
  const expectedCost = 0.00012 / 0.0050;
  assert.ok(Math.abs(r.netR - (2 - expectedCost)) < 1e-9);
  assert.ok(r.netR < r.grossR, 'net harus lebih kecil dari gross setelah biaya');
});

test('_costAdjustedR: SL kalah -> grossR = -1, netR lebih negatif (biaya menambah kerugian)', () => {
  const r = _costAdjustedR({ status: 'sl', label: 'EUR/USD', entry_zone: '1.1000', sl: '1.0950', tp: '1.1100', rr: 2 });
  assert.equal(r.grossR, -1);
  assert.ok(r.netR < -1, 'biaya spread harus memperburuk kerugian, bukan memperbaiki');
});

test('_costAdjustedR: rr kosong -> dihitung ulang dari tp/entry/sl', () => {
  const r = _costAdjustedR({ status: 'tp', label: 'XAU/USD', entry_zone: '2000', sl: '1990', tp: '2020' });
  assert.equal(r.grossR, 2); // risk 10, reward 20 -> RR 2
});

test('_aggCostExpectancy: array kosong / semua tak terhitung -> n 0, avg null', () => {
  assert.deepEqual(_aggCostExpectancy([]), { n: 0, avg_r_gross: null, avg_r_net: null });
  assert.deepEqual(_aggCostExpectancy([{ status: 'pending', label: 'EUR/USD' }]), { n: 0, avg_r_gross: null, avg_r_net: null });
});

test('_aggCostExpectancy: rata-rata gross vs net lintas beberapa setup closed', () => {
  const arr = [
    { status: 'tp', label: 'EUR/USD', entry_zone: '1.1000', sl: '1.0950', tp: '1.1100', rr: 2 },
    { status: 'sl', label: 'EUR/USD', entry_zone: '1.1000', sl: '1.0950', tp: '1.1100', rr: 2 },
    { status: 'pending', label: 'EUR/USD' }, // diskip, bukan closed
  ];
  const agg = _aggCostExpectancy(arr);
  assert.equal(agg.n, 2);
  assert.equal(agg.avg_r_gross, +((2 + -1) / 2).toFixed(2));
  assert.ok(agg.avg_r_net < agg.avg_r_gross);
});

// ── _confidenceCalibration ───────────────────────────────────────────────────

test('_confidenceCalibration: win-rate dipecah per level, hanya closed yang dihitung', () => {
  const arr = [
    { status: 'tp', confidence: 'tinggi' }, { status: 'tp', confidence: 'tinggi' }, { status: 'sl', confidence: 'tinggi' },
    { status: 'sl', confidence: 'sedang' }, { status: 'sl', confidence: 'sedang' },
    { status: 'pending', confidence: 'rendah' }, // diskip, bukan closed
  ];
  const cal = _confidenceCalibration(arr);
  assert.equal(cal.tinggi.n, 3);
  assert.equal(cal.tinggi.win_rate, 67);
  assert.equal(cal.sedang.n, 2);
  assert.equal(cal.sedang.win_rate, 0);
  assert.equal(cal.rendah.n, 0);
  assert.equal(cal.rendah.win_rate, null);
});

test('_confidenceCalibration: confidence null (model tidak patuh skema) tidak masuk bucket manapun', () => {
  const arr = [{ status: 'tp', confidence: null }, { status: 'sl', confidence: null }];
  const cal = _confidenceCalibration(arr);
  assert.equal(cal.tinggi.n, 0);
  assert.equal(cal.sedang.n, 0);
  assert.equal(cal.rendah.n, 0);
});

// ── _summarizeLatency ─────────────────────────────────────────────────────────

test('_summarizeLatency: array kosong -> semua null', () => {
  assert.deepEqual(_summarizeLatency([]), { n: 0, avg_min: null, median_min: null, min_min: null, max_min: null });
  assert.deepEqual(_summarizeLatency(null), { n: 0, avg_min: null, median_min: null, min_min: null, max_min: null });
});

test('_summarizeLatency: hitung avg/median/min/max dalam menit, abaikan entry tanpa latency_ms valid', () => {
  const entries = [
    { latency_ms: 5 * 60000 }, { latency_ms: 10 * 60000 }, { latency_ms: 15 * 60000 },
    { latency_ms: -1 }, { foo: 'bar' }, null,
  ];
  const s = _summarizeLatency(entries);
  assert.equal(s.n, 3);
  assert.equal(s.avg_min, 10);
  assert.equal(s.median_min, 10);
  assert.equal(s.min_min, 5);
  assert.equal(s.max_min, 15);
});

// ── Integrasi: field confidence dinormalisasi & masuk setup_log ─────────────

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

function makeStore(seed = {}) { return { strings: { ...seed }, lists: {} }; }
function redisFetchStub(store) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const [cmd, key, ...rest] = args;
    if (cmd === 'GET') return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
    if (cmd === 'SET') { store.strings[key] = rest[0]; return { ok: true, json: async () => ({ result: 'OK' }) }; }
    if (cmd === 'DEL') { delete store.strings[key]; return { ok: true, json: async () => ({ result: 1 }) }; }
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
}

async function withEnv(vars, fn) {
  const prev = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { delete process.env.DEEPSEEK_API_KEY; if (prev.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = prev.DEEPSEEK_API_KEY; }
}

test('ohlcv_analyze: confidence "tinggi" dari AI -> masuk setup_log apa adanya', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const aiJson = {
      bias: 'bearish', entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
      sl: '1.2850', tp: '1.2700', trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
      time_horizon_days: 3, makro_alignment: null, makro_alignment_reason: null,
      conflict: 'none', conflict_note: null, confidence: 'tinggi',
    };
    const rawText = `${JSON.stringify(aiJson)}\n===COMMENTARY===\nKomentar singkat untuk tes confidence.`;
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
      if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: rawText } }] }) };
      throw new Error('unexpected network call: ' + u);
    };
    try {
      delete require.cache[require.resolve('../../api/admin.js')];
      const handler = require('../../api/admin.js');
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.confidence, 'tinggi');
      const log = JSON.parse(store.strings['setup_log:v1']);
      assert.equal(log[0].confidence, 'tinggi');
    } finally { global.fetch = origFetch; }
  });
});

test('ohlcv_analyze: confidence tidak valid dari AI -> dinormalisasi jadi null (bukan dipaksa satu nilai)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const aiJson = {
      bias: 'bearish', entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
      sl: '1.2850', tp: '1.2700', trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
      time_horizon_days: 3, makro_alignment: null, makro_alignment_reason: null,
      conflict: 'none', conflict_note: null, confidence: 'sangat yakin sekali',
    };
    const rawText = `${JSON.stringify(aiJson)}\n===COMMENTARY===\nKomentar singkat untuk tes confidence invalid.`;
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisFetchStub(store)(url, opts);
      if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: rawText } }] }) };
      throw new Error('unexpected network call: ' + u);
    };
    try {
      delete require.cache[require.resolve('../../api/admin.js')];
      const handler = require('../../api/admin.js');
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.confidence, null);
      const log = JSON.parse(store.strings['setup_log:v1']);
      assert.equal(log[0].confidence, null);
    } finally { global.fetch = origFetch; }
  });
});
