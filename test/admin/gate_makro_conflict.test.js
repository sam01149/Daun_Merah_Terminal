// test/admin/gate_makro_conflict.test.js — Gate makro_conflict (2026-08-10)
//
// Audit CHF/JPY + pola berulang di pair lain (diskusi user): setup dengan
// makro_alignment="konflik" tetap lolos jadi pending/live walau instruksi prompt
// ("kalau makro_alignment konflik, null-kan entry_zone/sl/tp") sudah ada sejak
// awal — instruksi itu TIDAK PERNAH code-enforced, cuma permintaan teks yang model
// sering tidak patuhi (kemungkinan root cause: entry_zone/sl/tp diminta LEBIH DULU
// dari makro_alignment di skema JSON, jadi levelnya sudah ter-commit sebelum model
// "memutuskan" konflik di field belakangnya).
//
// Fix: gate baru `makro_conflict` di jalur autoGuardConsidered (api/admin.js,
// ohlcvAnalyzeHandler) — pola SAMA PERSIS correlation_cap/drawdown (bukan mutasi
// `structured` langsung), supaya kandidat yang ditahan tetap ke-ghost-track
// (canceled_reason:'gate_makro_conflict', masuk GHOST_TRACKED_CANCEL_REASONS) alih-alih
// hilang senyap. HANYA auto — manual TIDAK disentuh (autoGuardConsidered selalu false
// untuk isAutoCall false), makro_alignment tetap tampil apa adanya ke pembaca manual.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

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
    switch (cmd) {
      case 'GET':
        return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
      case 'SET': {
        const flags = rest.slice(1).map(v => String(v).toUpperCase());
        if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(store.strings, key)) {
          return { ok: true, json: async () => ({ result: null }) };
        }
        store.strings[key] = rest[0];
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'DEL': delete store.strings[key]; return { ok: true, json: async () => ({ result: 1 }) };
      case 'INCR': {
        const n = (parseInt(store.strings[key] || '0', 10)) + 1;
        store.strings[key] = String(n);
        return { ok: true, json: async () => ({ result: n }) };
      }
      default: return { ok: true, json: async () => ({ result: 'OK' }) };
    }
  };
}

// Reasoning SAH (bukan kontradiktif secara teks — lolos _detectAlignmentReasonContradiction)
// tapi model sendiri sudah menyimpulkan konflik nyata, pola sama kasus CHF/JPY asli.
const AI_JSON_CONFLICT = {
  bias: 'bullish',
  entry_zone: '195.500-195.700', entry_basis: 'cluster S/R + fib 61.8%',
  sl: '195.100', tp: '197.827',
  trigger: 'tunggu breakout H4 di atas 195.700', invalidation_condition: 'close H4 di bawah 194.188',
  time_horizon_days: 3,
  makro_alignment: 'konflik',
  makro_alignment_reason: 'Bias BoJ hawkish dan COT JPY net short crowded mengindikasikan JPY berpotensi menguat, berlawanan dengan bias bullish CHF/JPY.',
  conflict: 'arah', conflict_note: 'Fundamental JPY hawkish berlawanan dengan bias bullish.',
  confidence: 'rendah',
};
const AI_RAW_TEXT_CONFLICT = `${JSON.stringify(AI_JSON_CONFLICT)}\n===COMMENTARY===\nParagraf teknikal menjelaskan struktur H4 bullish CHF/JPY di 195.6 dengan 3 hari horizon.`;

function makeAnalyzeFetchStub(store, rawText) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: rawText } }] }) };
    // SENGAJA tidak menangani api.sambanova.ai (Gate A/Kritikus) — kalau kode
    // sampai memanggilnya, test gagal dengan error ini, membuktikan Gate A
    // TIDAK PERNAH dipanggil untuk kandidat yang sudah ditahan makro_conflict
    // (needsGateA harus false begitu autoGuardReason='makro_conflict' terisi).
    throw new Error('unexpected network call di test (Gate A seharusnya tidak pernah dipanggil): ' + u);
  };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
    for (const k of Object.keys(prev)) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

function baseStore() {
  return makeStore({
    'ohlcv_fresh:CHFJPY=X': '1',
    'ohlcv:CHFJPY=X:1h': JSON.stringify(mkTrendCandles(194.0, 195.6)),
    'setup_log_auto:v1': JSON.stringify([]),
    // WAJIB diisi supaya fundBlock non-kosong — tanpa ini `makro_alignment` di-null-kan
    // paksa oleh normalisasi (badge UI hanya tampil kalau ada sumber makro/fundamental
    // nyata di prompt), terlepas dari apa yang dikatakan AI. Bukan bagian yang diaudit
    // sesi ini — cukup satu leg confidence High supaya blok fundamental terisi.
    'cb_bias': JSON.stringify({
      JPY: { bias: 'Hawkish', confidence: 'High', updated_at: new Date().toISOString() },
    }),
  });
}

test('auto + makro_alignment konflik: TIDAK jadi pending, tersimpan canceled/gate_makro_conflict, Gate A dilewati', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, AI_RAW_TEXT_CONFLICT);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'CHFJPY=X', label: 'CHF/JPY', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.makro_alignment, 'konflik');
      // Response ke caller TETAP menampilkan level asli AI (fail-open, respons API
      // bukan yang dibatasi — cuma penyimpanan setup_log_auto yang digate).
      assert.equal(res.body.structured.entry_zone, AI_JSON_CONFLICT.entry_zone);

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1);
      assert.equal(log[0].status, 'canceled');
      assert.equal(log[0].canceled_reason, 'gate_makro_conflict');
      assert.equal(log[0].entry_zone, AI_JSON_CONFLICT.entry_zone, 'level asli tetap direkam di ghost entry untuk counterfactual');
      assert.ok(log.every(x => x.status !== 'pending' && x.status !== 'open'), 'makro_conflict tidak pernah jadi entri live');
      assert.equal(store.strings['auto_guard_stats:makro_conflict'], '1');
      assert.equal(store.strings['auto_guard_stats:saved'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('manual (bukan auto=1) + makro_alignment konflik: TIDAK digate — tetap pending dengan level asli (perilaku manual tidak berubah)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, AI_RAW_TEXT_CONFLICT);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'CHFJPY=X', label: 'CHF/JPY' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.makro_alignment, 'konflik');
      assert.equal(res.body.structured.entry_zone, AI_JSON_CONFLICT.entry_zone);

      const log = JSON.parse(store.strings['setup_log:v1']);
      assert.equal(log.length, 1);
      assert.equal(log[0].status, 'pending');
      assert.equal(log[0].source, 'manual');
      assert.equal(log[0].entry_zone, AI_JSON_CONFLICT.entry_zone);
      assert.equal(store.strings['auto_guard_stats:makro_conflict'], undefined, 'gate makro_conflict cuma berlaku jalur auto');
    } finally { global.fetch = origFetch; }
  });
});

test('GHOST_TRACKED_CANCEL_REASONS mencakup gate_makro_conflict', () => {
  const { GHOST_TRACKED_CANCEL_REASONS } = require('../../api/admin.js');
  assert.ok(GHOST_TRACKED_CANCEL_REASONS.has('gate_makro_conflict'));
});
