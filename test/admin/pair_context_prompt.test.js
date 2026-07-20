// test/admin/pair_context_prompt.test.js — PLAN U-2 (2026-07-20)
// Integrasi ohlcvAnalyzeHandler (api/admin.js) dengan api/_pair_context.js:
// - blok [KONTEKS REZIM & KEKUATAN MATA UANG] tersuntik ke prompt AI saat data cukup
// - field baru `conflict`/`conflict_note` dinormalisasi & dipetakan ke setup_log.alignment
// - flag auto=1 menandai source:'auto' HANYA kalau request terautentikasi cron (CRON_SECRET),
//   mencegah publik men-spoof integritas statistik gate-live auto-entry
// - response ohlcv_analyze mengikutkan pair_context (regime+strength)
//
// Semua fetch Yahoo/Deriv DIHINDARI lewat throttle `ohlcv_fresh:<symbol>` (dibaca
// PALING AWAL oleh refreshOhlcvFromYahoo, admin.js) — di-set truthy di fixture supaya
// loadOhlcvData langsung baca snapshot Redis yang kita siapkan, tanpa network nyata.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');

// close flat 100 (t dalam DETIK, pola admin.js) — TR = h-l murni, dipakai supaya
// rezim volatilitas pasti "bergejolak" (histori tenang -> baru-baru ini melebar).
function mkRegimeCandles(n, rangeFn) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const half = rangeFn(i) / 2;
    arr.push({ t: i * 3600, o: 100, h: 100 + half, l: 100 - half, c: 100 });
  }
  return arr;
}
// close bergerak linear — dipakai untuk leg currency strength selain EUR.
function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

const EURUSD_CANDLES = mkRegimeCandles(100, i => (i < 70 ? 0.2 : 2.0)); // -> bergejolak, close flat 100

const REDIS_FIXTURES = {
  'ohlcv_fresh:EURUSD=X': '1', // skip refreshOhlcvFromYahoo sama sekali — tanpa network
  'ohlcv:EURUSD=X:1h': JSON.stringify(EURUSD_CANDLES),
  'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
  'ohlcv:USDJPY=X:1h': JSON.stringify(mkTrendCandles(150, 152)),
  'ohlcv:AUDUSD=X:1h': JSON.stringify(mkTrendCandles(0.65, 0.64)),
  'ohlcv:USDCAD=X:1h': JSON.stringify(mkTrendCandles(1.35, 1.37)),
  'ohlcv:NZDUSD=X:1h': JSON.stringify(mkTrendCandles(0.60, 0.59)),
};

// bearish setup konsisten dengan nowPrice=100 (close flat EURUSD=X) — lolos
// sanity-check arah/RR di ohlcvAnalyzeHandler (lihat admin.js ~3400an).
const AI_JSON = {
  bias: 'bearish',
  entry_zone: '100.02-100.05', entry_basis: 'cluster S/R 100.03 (2x sentuh)',
  sl: '100.10', tp: '99.90',
  trigger: 'tunggu rejection H1 di 100.03',
  invalidation_condition: 'close H4 di atas 100.15',
  time_horizon_days: 3,
  makro_alignment: null, makro_alignment_reason: null,
  conflict: 'arah', conflict_note: 'COT USD net long besar melawan bias bearish EUR/USD',
};
const AI_RAW_TEXT = `${JSON.stringify(AI_JSON)}\n===COMMENTARY===\nParagraf satu dengan angka 100.03 dan 0.4%. Paragraf dua dengan 1.0850 dan 2x. Paragraf tiga dengan 100 dan 3 hari. Paragraf empat dengan 2 struktur dan 100.10.\n\nKESIMPULAN: bearish menengah, tunggu rejection di 100.03, batal kalau tembus 100.15.`;

function makeFetchStub({ redisFixtures = {}, captured }) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-redis.test')) {
      const args = JSON.parse(opts.body);
      const [cmd, key] = args;
      if (cmd === 'GET') {
        const has = Object.prototype.hasOwnProperty.call(redisFixtures, key);
        return { ok: true, json: async () => ({ result: has ? redisFixtures[key] : null }) };
      }
      if (cmd === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
      return { ok: true, json: async () => ({ result: 'OK' }) }; // SET/EXPIRE/dst
    }
    if (u.includes('api.deepseek.com')) {
      captured.deepseekBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    }
    throw new Error('unexpected network call di test (harus lewat ohlcv_fresh throttle): ' + u);
  };
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

async function withEnv(vars, fn) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.CRON_SECRET;
  }
}

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

test('ohlcv_analyze manual: prompt memuat blok [KONTEKS REZIM & KEKUATAN MATA UANG], response.pair_context terisi, conflict->alignment konflik, source manual', async () => {
  await withEnv({}, async () => {
    const captured = {};
    const origFetch = global.fetch;
    global.fetch = makeFetchStub({ redisFixtures: REDIS_FIXTURES, captured });
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'EURUSD=X', label: 'EUR/USD' } }, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body, 'response harus ada body');
      assert.ok(res.body.structured, JSON.stringify(res.body));
      assert.equal(res.body.structured.conflict, 'arah');
      assert.equal(res.body.structured.conflict_note, AI_JSON.conflict_note);

      // Prompt yang dikirim ke AI harus memuat blok konteks baru
      const userMsg = captured.deepseekBody.messages.find(m => m.role === 'user').content;
      assert.ok(userMsg.includes('[KONTEKS REZIM & KEKUATAN MATA UANG]'), 'blok pair-context harus ada di prompt');
      assert.ok(userMsg.includes('Rezim volatilitas EUR/USD: BERGEJOLAK'), userMsg.slice(0, 400));
      assert.ok(userMsg.includes('Currency strength'), 'blok currency strength harus ada (6 pair valid tersedia)');
      // System prompt harus minta field conflict/conflict_note
      const sysMsg = captured.deepseekBody.messages.find(m => m.role === 'system').content;
      assert.ok(sysMsg.includes('"conflict"') && sysMsg.includes('"conflict_note"'));

      // response.pair_context (U-2 langkah 4)
      assert.ok(res.body.pair_context.regime, 'regime harus terisi di response');
      assert.equal(res.body.pair_context.regime.regime, 'bergejolak');
      assert.ok(res.body.pair_context.strength, 'strength harus terisi di response');
    } finally { global.fetch = origFetch; }
  });
});

test('ohlcv_analyze: source=manual default (tanpa auto=1); alignment setup_log mengikuti conflict (bukan makro_alignment)', async () => {
  await withEnv({}, async () => {
    const captured = {};
    const origFetch = global.fetch;
    const redisLog = { value: null };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-redis.test')) {
        const args = JSON.parse(opts.body);
        const [cmd, key, val] = args;
        if (key === 'setup_log:v1') {
          if (cmd === 'GET') return { ok: true, json: async () => ({ result: redisLog.value }) };
          if (cmd === 'SET') { redisLog.value = val; return { ok: true, json: async () => ({ result: 'OK' }) }; }
        }
        if (cmd === 'GET') {
          const has = Object.prototype.hasOwnProperty.call(REDIS_FIXTURES, key);
          return { ok: true, json: async () => ({ result: has ? REDIS_FIXTURES[key] : null }) };
        }
        if (cmd === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (u.includes('api.deepseek.com')) {
        captured.deepseekBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
      }
      throw new Error('unexpected network call: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'EURUSD=X', label: 'EUR/USD' } }, res);

      assert.ok(redisLog.value, 'setup_log:v1 harus ditulis (entry_zone/sl/tp lengkap)');
      const log = JSON.parse(redisLog.value);
      assert.equal(log.length, 1);
      assert.equal(log[0].source, 'manual');
      assert.equal(log[0].alignment, 'konflik', 'conflict=arah harus dipetakan ke alignment=konflik walau makro_alignment null');
    } finally { global.fetch = origFetch; }
  });
});

test('ohlcv_analyze: auto=1 TANPA CRON_SECRET valid -> tetap source manual (anti-spoof)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const captured = {};
    const redisLog = { value: null };
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-redis.test')) {
        const args = JSON.parse(opts.body);
        const [cmd, key, val] = args;
        if (key === 'setup_log:v1') {
          if (cmd === 'GET') return { ok: true, json: async () => ({ result: redisLog.value }) };
          if (cmd === 'SET') { redisLog.value = val; return { ok: true, json: async () => ({ result: 'OK' }) }; }
        }
        if (cmd === 'GET') {
          const has = Object.prototype.hasOwnProperty.call(REDIS_FIXTURES, key);
          return { ok: true, json: async () => ({ result: has ? REDIS_FIXTURES[key] : null }) };
        }
        if (cmd === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (u.includes('api.deepseek.com')) {
        captured.deepseekBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
      }
      throw new Error('unexpected network call: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      // TANPA header x-cron-secret -> isCronCall=false -> auto=1 di query TIDAK dihitung
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'EURUSD=X', label: 'EUR/USD', auto: '1' } }, res);

      assert.ok(redisLog.value);
      const log = JSON.parse(redisLog.value);
      assert.equal(log[0].source, 'manual', 'auto=1 tanpa autentikasi cron TIDAK BOLEH menghasilkan source auto');
    } finally { global.fetch = origFetch; }
  });
});

test('ohlcv_analyze: auto=1 DENGAN x-cron-secret valid -> source auto, masuk setup_log_auto:v1 (PLAN U-7, bukan setup_log:v1)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const captured = {};
    const redisLogAuto = { value: null };
    let manualLogSetCalled = false, cacheSetCalled = false;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-redis.test')) {
        const args = JSON.parse(opts.body);
        const [cmd, key, val] = args;
        if (key === 'setup_log_auto:v1') {
          if (cmd === 'GET') return { ok: true, json: async () => ({ result: redisLogAuto.value }) };
          if (cmd === 'SET') { redisLogAuto.value = val; return { ok: true, json: async () => ({ result: 'OK' }) }; }
        }
        if (key === 'setup_log:v1' && cmd === 'SET') manualLogSetCalled = true;
        if (key === 'ohlcv_analysis:EURUSD=X' && cmd === 'SET') cacheSetCalled = true;
        // ohlcv_analysis:<symbol> GET dipakai cron-dedup check — kosongkan (bukan cache fresh)
        if (cmd === 'GET') {
          const has = Object.prototype.hasOwnProperty.call(REDIS_FIXTURES, key);
          return { ok: true, json: async () => ({ result: has ? REDIS_FIXTURES[key] : null }) };
        }
        if (cmd === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (u.includes('api.deepseek.com')) {
        captured.deepseekBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
      }
      throw new Error('unexpected network call: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'EURUSD=X', label: 'EUR/USD', auto: '1' },
      }, res);

      assert.ok(redisLogAuto.value, 'PLAN U-7: setup call auto harus masuk setup_log_auto:v1');
      const log = JSON.parse(redisLogAuto.value);
      assert.equal(log[0].source, 'auto');
      assert.equal(manualLogSetCalled, false, 'PLAN U-7: setup_log:v1 (manual) TIDAK BOLEH tersentuh oleh call auto');
      assert.equal(cacheSetCalled, false, 'PLAN U-7: cache ohlcv_analysis TIDAK BOLEH ditulis oleh call auto (isolasi senyap)');
    } finally { global.fetch = origFetch; }
  });
});

test('ohlcv_analyze: data pair-context kosong (symbol tanpa candle, fx legs tanpa data) -> blok tidak muncul di prompt (fail-open)', async () => {
  await withEnv({}, async () => {
    const captured = {};
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-redis.test')) {
        const args = JSON.parse(opts.body);
        const [cmd, key] = args;
        if (cmd === 'GET') {
          if (key === 'ohlcv_fresh:GBPUSD=X') return { ok: true, json: async () => ({ result: '1' }) };
          if (key === 'ohlcv:GBPUSD=X:1h') return { ok: true, json: async () => ({ result: JSON.stringify(mkTrendCandles(1.30, 1.28, 10)) }) }; // >=6 tapi <16 -> regime null, currency strength juga <6 pair
          return { ok: true, json: async () => ({ result: null }) };
        }
        if (cmd === 'INCR') return { ok: true, json: async () => ({ result: 1 }) };
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (u.includes('api.deepseek.com')) {
        captured.deepseekBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
      }
      throw new Error('unexpected network call: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);

      const userMsg = captured.deepseekBody.messages.find(m => m.role === 'user').content;
      assert.ok(!userMsg.includes('[KONTEKS REZIM & KEKUATAN MATA UANG]'), 'blok TIDAK BOLEH muncul kalau data pair-context kosong');
      assert.deepEqual(res.body.pair_context, { regime: null, strength: null });
    } finally { global.fetch = origFetch; }
  });
});
