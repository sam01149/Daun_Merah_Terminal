// test/admin/sistem_hakim.test.js — [SISTEM HAKIM] aktivasi jalur cron auto-entry
// (2026-07-29, diskusi user). Sebelum ini, cbDir HANYA datang dari body request
// manual (index.html POST) — trigger cron auto-entry (vps/daemon.js) adalah GET
// tanpa body, jadi guard veto "Sistem Hakim" diam-diam TIDAK PERNAH menyala di jalur
// otomatis. Perubahan: _computeCbDirServerSide menghitung cbDir dari cache cb_bias/
// thesis XAU yang SUDAH difetch untuk fundBlock, HANYA dipakai sebagai fallback saat
// isAutoCall && !cbDir (manual tidak disentuh sama sekali). Syarat kekuatan bukti
// SENGAJA lebih ketat dari versi client (index.html _ckInferDirFromCbBias, yang tidak
// cek confidence sama sekali): confidence kedua leg harus 'High' (FX) / xau_confidence
// >=4 (XAU), tanpa divergence_warning — supaya Sistem Hakim tidak memaksa veto dari
// sinyal makro yang sendiri lemah/disputed (permintaan user: "jangan jadi pembuat
// keputusan, sesuaikan syaratnya"). Pengukuran dampak: field BARU murni aditif
// (`sistem_hakim`, `conflict_source`) di setup_log_auto + `sistem_hakim_calibration`
// di setup_stats — tidak menyentuh field/kalibrasi yang sudah ada (confidence,
// conflict, makro_alignment, drawdown, cost_expectancy tetap identik).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

const { _computeCbDirServerSide, _sistemHakimCalibration } = loadHandler();

// ── _computeCbDirServerSide (pure) ──────────────────────────────────────────

test('_computeCbDirServerSide XAU: tanpa thesis -> null', () => {
  assert.equal(_computeCbDirServerSide({ isXau: true, xauThesis: null }), null);
});

test('_computeCbDirServerSide XAU: xau_confidence < 4 -> null (bukti terlalu lemah)', () => {
  assert.equal(_computeCbDirServerSide({ isXau: true, xauThesis: { xau_bias: 'bullish', xau_confidence: 3 } }), null);
});

test('_computeCbDirServerSide XAU: xau_confidence >= 4 -> ikuti xau_bias', () => {
  assert.equal(_computeCbDirServerSide({ isXau: true, xauThesis: { xau_bias: 'bullish', xau_confidence: 4 } }), 'long');
  assert.equal(_computeCbDirServerSide({ isXau: true, xauThesis: { xau_bias: 'bearish', xau_confidence: 5 } }), 'short');
});

test('_computeCbDirServerSide FX: label bukan 2 leg -> null', () => {
  assert.equal(_computeCbDirServerSide({ label: 'XAUUSD', isXau: false, cbBiasObj: {} }), null);
});

test('_computeCbDirServerSide FX: salah satu leg tidak ada bias -> null', () => {
  const cbBiasObj = { GBP: { bias: 'hawkish', confidence: 'High' } };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj }), null);
});

test('_computeCbDirServerSide FX: confidence bukan High di salah satu leg -> null (syarat kekuatan bukti)', () => {
  const cbBiasObj = {
    GBP: { bias: 'hawkish', confidence: 'Medium' },
    USD: { bias: 'dovish', confidence: 'High' },
  };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj }), null);
});

test('_computeCbDirServerSide FX: divergence_warning aktif -> null (sinyal masih disputed)', () => {
  const cbBiasObj = {
    GBP: { bias: 'hawkish', confidence: 'High', divergence_warning: { suggested_bias: 'dovish' } },
    USD: { bias: 'dovish', confidence: 'High' },
  };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj }), null);
});

test('_computeCbDirServerSide FX: level sama -> null (tidak ada divergensi)', () => {
  const cbBiasObj = {
    GBP: { bias: 'neutral', confidence: 'High' },
    USD: { bias: 'on hold', confidence: 'High' },
  };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj }), null);
});

test('_computeCbDirServerSide FX: kedua leg High confidence + divergen -> arah sesuai leg yang lebih hawkish', () => {
  const cbBiasObj = {
    GBP: { bias: 'hawkish', confidence: 'High' },
    USD: { bias: 'dovish', confidence: 'High' },
  };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj }), 'long');
  const cbBiasObjRev = {
    GBP: { bias: 'dovish', confidence: 'High' },
    USD: { bias: 'hawkish', confidence: 'High' },
  };
  assert.equal(_computeCbDirServerSide({ label: 'GBP/USD', isXau: false, cbBiasObj: cbBiasObjRev }), 'short');
});

// ── _sistemHakimCalibration (pure) — pola sama _confidenceCalibration ───────

test('_sistemHakimCalibration: win-rate dipecah fired vs clear, hanya closed dihitung', () => {
  const arr = [
    { status: 'tp', sistem_hakim: 'fired' }, { status: 'sl', sistem_hakim: 'fired' }, { status: 'sl', sistem_hakim: 'fired' },
    { status: 'tp', sistem_hakim: 'clear' }, { status: 'tp', sistem_hakim: 'clear' },
    { status: 'pending', sistem_hakim: 'fired' }, // diskip, bukan closed
    { status: 'tp', sistem_hakim: null }, // diskip, tidak masuk bucket manapun
  ];
  const cal = _sistemHakimCalibration(arr);
  assert.equal(cal.fired.n, 3);
  assert.equal(cal.fired.win_rate, 33);
  assert.equal(cal.clear.n, 2);
  assert.equal(cal.clear.win_rate, 100);
});

test('_sistemHakimCalibration: array kosong -> n 0, win_rate null di kedua bucket', () => {
  const cal = _sistemHakimCalibration([]);
  assert.deepEqual(cal, { fired: { n: 0, win_rate: null }, clear: { n: 0, win_rate: null } });
});

// ── Integrasi ohlcv_analyze (auto-entry cron) ───────────────────────────────

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

// Bias teknikal AI: bearish (short) — dibuat berlawanan dgn cbDir 'long' (GBP hawkish
// vs USD dovish, keduanya High confidence) supaya Sistem Hakim seharusnya nyala.
const AI_JSON_BEARISH = {
  bias: 'bearish',
  entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
  sl: '1.2850', tp: '1.2700',
  trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
  time_horizon_days: 3, makro_alignment: null, makro_alignment_reason: null,
  conflict: 'none', conflict_note: null,
};
const AI_RAW_TEXT = `${JSON.stringify(AI_JSON_BEARISH)}\n===COMMENTARY===\nKomentar singkat untuk tes Sistem Hakim.`;

function makeAnalyzeFetchStub(store) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    throw new Error('unexpected network call di test: ' + u);
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

const STRONG_CB_BIAS = JSON.stringify({
  GBP: { bias: 'hawkish', confidence: 'High', updated_at: new Date().toISOString() },
  USD: { bias: 'dovish', confidence: 'High', updated_at: new Date().toISOString() },
});

test('SISTEM HAKIM cron: auto=1 tanpa body + cb_bias divergen kuat (High/High) -> cbDir dihitung server-side, veto nyala, entri ditandai fired', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'cb_bias': STRONG_CB_BIAS,
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.conflict, 'arah', 'Sistem Hakim harus memaksa conflict=arah');
      assert.equal(res.body.structured.makro_alignment, 'konflik');

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].sistem_hakim, 'fired');
      assert.equal(log[0].conflict_source, 'sistem_hakim');

      assert.equal(store.strings['sistem_hakim_stats:considered'], '1');
      assert.equal(store.strings['sistem_hakim_stats:fired'], '1');
    } finally { global.fetch = origFetch; }
  });
});

test('SISTEM HAKIM cron: cb_bias divergen tapi confidence Medium -> fallback TIDAK aktif, tag sistem_hakim null', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'cb_bias': JSON.stringify({
        GBP: { bias: 'hawkish', confidence: 'Medium', updated_at: new Date().toISOString() },
        USD: { bias: 'dovish', confidence: 'High', updated_at: new Date().toISOString() },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.conflict, 'none', 'confidence lemah -> Sistem Hakim diam, conflict apa adanya dari AI');

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].sistem_hakim, null);
      assert.equal(log[0].conflict_source, null);
      assert.equal(store.strings['sistem_hakim_stats:considered'], undefined, 'considered TIDAK naik kalau cbDir gagal dihitung (evidence lemah)');
    } finally { global.fetch = origFetch; }
  });
});

test('SISTEM HAKIM manual (bukan cron/auto): cb_bias divergen kuat tersedia TAPI tidak dipakai — perilaku manual tidak berubah', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'cb_bias': STRONG_CB_BIAS,
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      // Tanpa header cron & tanpa auto=1 & tanpa cbDir di body -> isAutoCall false,
      // fallback _computeCbDirServerSide TIDAK dipanggil sama sekali.
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.conflict, 'none');
      const log = JSON.parse(store.strings['setup_log:v1']);
      assert.equal(log[0].sistem_hakim, null);
      assert.equal(store.strings['sistem_hakim_stats:considered'], undefined);
    } finally { global.fetch = origFetch; }
  });
});
