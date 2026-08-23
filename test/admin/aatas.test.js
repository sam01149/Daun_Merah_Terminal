// test/admin/aatas.test.js — AATAS ("Auto AI to Auto System", 2026-08-22).
// Porting checklist SMC/ICT manual ke jalur auto-entry: urutan keputusan dibalik jadi
// MAKRO DULU (REGIME CHECK + gate driver/fundamental), teknikal cuma presisi timing.
//
// Yang dikunci test ini:
//  (a) blok checklist hanya masuk prompt jalur auto; jalur manual publik tidak berubah;
//  (b) cabang XAU/USD beda dari FX (real yield dibuang dari pre-gate FX, hard-stop gold);
//  (c) normalisasi field baru (checklist_pct/verdict/gate/...) fail-safe ke null;
//  (d) GATE benar-benar mengikat di KODE (bukan cuma imbauan prompt) — setup batal lahir;
//  (e) field checklist tersimpan ke setup_log_auto:v1, TERMASUK reasoning_note naratif;
//  (f) statistik agregat dashboard direset ke populasi policy_v >= AATAS_EPOCH, sementara
//      tabel Riwayat Setup (`recent`) tetap menampilkan histori lama penuh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');
const { AATAS_EPOCH } = require('../../api/_auto_entry_guard');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

const {
  _buildAatasChecklistBlock, _normalizeAatasFields, _aatasRejectReason,
  _goldYieldCorrAnomaly, _formatAatasCriticLine, _statsPayloadFromLog, AATAS_PROMPT_VERSION,
} = loadHandler();

// ── (b) blok checklist: cabang FX vs XAU ─────────────────────────────────────

test('AATAS block FX: makro jadi urutan pertama, real yield BUKAN pre-gate, RSI/MACD dibuang dari keputusan', () => {
  const b = _buildAatasChecklistBlock({ label: 'EUR/USD', isXau: false, goldCorr: null });
  assert.match(b, /MAKRO DULU, TEKNIKAL BELAKANGAN/);
  assert.match(b, /STEP 0 REGIME CHECK \(PRE-GATE\):/);
  assert.match(b, /Real yield differential TIDAK dipakai sebagai pre-gate di pair FX/);
  assert.match(b, /COT & retail sentiment TIDAK dipakai di sini — dipindah ke Step 8/);
  assert.match(b, /RSI, MACD, SMA, dan pivot TIDAK BOLEH memengaruhi arah/);
  // Delta sizing: flat 2%, tidak ada half-size saat konflik (bug checklist manual lama).
  assert.match(b, /FLAT 2% tanpa pengecualian/);
  assert.match(b, /TIDAK PERNAH mengecilkan ukuran posisi/);
  // Delta Fibonacci: zona, bukan titik tunggal 0,618.
  assert.match(b, /ZONA 0,382-0,618, bukan titik tunggal 0,618/);
  // Delta pre-market: aturan "maksimal 2 pair/hari" dibuang untuk sistem otomatis.
  assert.doesNotMatch(b, /Maksimal 2 pair/i);
  // Cabang gold tidak boleh bocor ke FX.
  assert.doesNotMatch(b, /unanimous/);
});

test('AATAS block XAU: real yield+DXY+regime wajib 3/3, korelasi live jadi arbitrase, angka korelasi ikut dikirim', () => {
  const b = _buildAatasChecklistBlock({
    label: 'XAU/USD', isXau: true, goldCorr: { r20: -0.11, r60: -0.72, anomaly: true },
  });
  assert.match(b, /STEP 0 REGIME CHECK \(PRE-GATE, cabang XAU\/USD\)/);
  assert.match(b, /Ketiganya WAJIB sepakat \(3\/3\)/);
  assert.match(b, /r20 -0\.11 vs r60 -0\.72/, 'angka korelasi live wajib dikutip, bukan cuma label');
  assert.match(b, /ANOMALI/);
  assert.match(b, /TIDAK ENTRY sama sekali/);
  assert.match(b, /Option Expiry|option expiry/i);
});

test('AATAS block XAU: korelasi tidak tersedia -> dinyatakan apa adanya, bukan diasumsikan normal', () => {
  const b = _buildAatasChecklistBlock({ label: 'XAU/USD', isXau: true, goldCorr: null });
  assert.match(b, /data tidak tersedia saat ini/);
  assert.doesNotMatch(b, /status: NORMAL/);
});

// ── _goldYieldCorrAnomaly: ambang tervalidasi, bukan r20 mentah ──────────────

test('_goldYieldCorrAnomaly: |r20-r60| > 0,4 -> anomali; di bawah ambang -> normal; data kurang -> null', () => {
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: -0.1, r60: -0.7 } } }), true);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: -0.5, r60: -0.7 } } }), false);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: null, r60: -0.7 } } }), null);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: {} }), null);
  assert.equal(_goldYieldCorrAnomaly(null), null);
});

// ── (c) normalisasi field baru ───────────────────────────────────────────────

test('_normalizeAatasFields: verdict dinormalkan ke label ckGetVerdict, pct dibulatkan & di-clamp', () => {
  const out = _normalizeAatasFields({
    checklist_pct: 87.6, verdict: 'siap trade',
    reasoning_note: '  Driver ECB hawkish sudah tercermin di harga.  ',
  });
  assert.equal(out.checklist_pct, 88);
  assert.equal(out.verdict, 'SIAP TRADE');
  assert.equal(out.reasoning_note, 'Driver ECB hawkish sudah tercermin di harga.');

  assert.equal(_normalizeAatasFields({ checklist_pct: 140 }).checklist_pct, 100);
  assert.equal(_normalizeAatasFields({ checklist_pct: -5 }).checklist_pct, 0);
  assert.equal(_normalizeAatasFields({ checklist_pct: 'entah' }).checklist_pct, null);
  assert.equal(_normalizeAatasFields({ verdict: 'NO_TRADE' }).verdict, 'NO TRADE');
  assert.equal(_normalizeAatasFields({ verdict: 'mantap' }).verdict, null, 'label ngawur -> null, jangan dipaksa ke salah satu');
});

test('_normalizeAatasFields: gate dinormalkan {pass,note}; pass non-boolean -> null (fail-open, bukan false)', () => {
  const out = _normalizeAatasFields({
    gate_validitas_driver: { pass: true, note: 'CPI aktual di atas forecast' },
    gate_risk_management: { pass: 'ya', note: '' },
  });
  assert.deepEqual(out.gate_validitas_driver, { pass: true, note: 'CPI aktual di atas forecast' });
  assert.deepEqual(out.gate_risk_management, { pass: null, note: null },
    'pass yang bukan boolean TIDAK boleh dibaca sebagai gagal — itu akan memblokir setup tanpa dasar');
  assert.equal(_normalizeAatasFields({}).gate_validitas_driver, null);
});

test('_normalizeAatasFields: objek per-step non-objek (string/array) dibuang jadi null', () => {
  const out = _normalizeAatasFields({
    regime_check: 'risk_off', fundamental_bias: ['bullish'], technical: { bos: 'ada' },
  });
  assert.equal(out.regime_check, null);
  assert.equal(out.fundamental_bias, null);
  assert.deepEqual(out.technical, { bos: 'ada' });
});

// ── (d) GATE mengikat di kode ────────────────────────────────────────────────

test('_aatasRejectReason: gold hard-stop menang duluan, lalu gate driver, gate risk, baru verdict', () => {
  assert.equal(_aatasRejectReason({ goldBlocked: true, verdict: 'ENTRY' }), 'gold_regime_split_corr_anomali');
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: false }, verdict: 'ENTRY' }), 'gate_validitas_driver');
  assert.equal(_aatasRejectReason({ gate_risk_management: { pass: false }, verdict: 'ENTRY' }), 'gate_risk_management');
  assert.equal(_aatasRejectReason({ verdict: 'NO TRADE' }), 'verdict_no_trade');
});

test('_aatasRejectReason: fail-open — gate tidak dilaporkan / verdict null -> setup TIDAK diblokir', () => {
  assert.equal(_aatasRejectReason({}), null);
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: null }, gate_risk_management: null, verdict: null }), null);
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: true }, verdict: 'PERTIMBANGKAN' }), null);
});

// ── fact sheet Gate A (AI Kritikus) ──────────────────────────────────────────

test('_formatAatasCriticLine: kirim hasil penilaian per-step, bukan label makro_alignment lama', () => {
  const line = _formatAatasCriticLine({
    checklist_pct: 72, verdict: 'PERTIMBANGKAN',
    regime_check: { regime: 'risk_off', cb_source_conflict: true, event_wait: true, event_note: 'NFP 5 jam lagi' },
    fundamental_bias: { arah: 'bearish', driver: 'Fed dovish' },
    technical: { bos: 'ada', area: '1.1710', fib_zone: '0.5' },
    final_validation: { cot: 'melawan', retail: 'netral' },
    reasoning_note: 'Skor turun karena dua sumber CB bias berbeda.',
  });
  assert.match(line, /Checklist AATAS: 72% \(PERTIMBANGKAN\)/);
  assert.match(line, /CB bias dua sumber BERBEDA/);
  assert.match(line, /menunggu event \(NFP 5 jam lagi\)/);
  assert.match(line, /Fundamental bias: bearish/);
  assert.match(line, /Catatan analis: Skor turun/);
  assert.equal(_formatAatasCriticLine({}), null);
  assert.equal(_formatAatasCriticLine(null), null);
});

// ── (f) reset statistik dashboard ────────────────────────────────────────────

test('_statsPayloadFromLog: agregat HANYA dari policy_v >= AATAS_EPOCH, Riwayat Setup tetap penuh', () => {
  const lama    = { id: 'A', symbol: 'GC=F', status: 'sl', ts: 1786000000000, policy_v: 20 };
  const lamaTp  = { id: 'B', symbol: 'GC=F', status: 'tp', ts: 1786000000001, policy_v: 21 };
  const aatas   = { id: 'C', symbol: 'GC=F', status: 'tp', ts: 1786500000000, policy_v: AATAS_EPOCH };
  const out = _statsPayloadFromLog([aatas, lamaTp, lama]);

  assert.equal(out.global.total, 1, 'hanya setup AATAS yang dihitung agregat');
  assert.equal(out.global.tp, 1);
  assert.equal(out.global.sl, 0);
  assert.equal(out.global.win_rate_raw, 100, 'win rate lama tidak boleh nyampur ke populasi baru');
  assert.equal(out.symbols['GC=F'].total, 1);
  assert.equal(out.symbols['GC=F'].history.length, 3, 'histori per-pair TIDAK difilter');
  assert.equal(out.recent.length, 3, 'tabel Riwayat Setup wajib tetap menampilkan entri lama apa adanya');
  assert.equal(out.stats_from_policy_v, AATAS_EPOCH);
});

test('_statsPayloadFromLog: entri lama tanpa policy_v dinilai lewat policy_v_est, entri tanpa ts valid tidak ikut agregat', () => {
  // ts 2026-07-21 -> epoch v2/v3 (jauh sebelum AATAS) -> keluar dari agregat.
  const tanpaStempel = { id: 'D', symbol: 'EURUSD=X', status: 'tp', ts: Date.parse('2026-07-21T00:00:00Z') };
  const tsKorup      = { id: 'E', symbol: 'EURUSD=X', status: 'tp', ts: 'bukan-angka' };
  const out = _statsPayloadFromLog([tanpaStempel, tsKorup]);
  assert.equal(out.global.total, 0);
  assert.equal(out.recent.length, 2);
  assert.ok(out.recent.find(x => x.id === 'D').policy_v_est != null, 'estimasi tetap dihitung untuk transparansi');
});

// ── (a)(d)(e) end-to-end jalur auto vs manual ────────────────────────────────

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

function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

// Level konsisten dengan close terakhir 1.28 (bearish) supaya lolos sanity-check RR.
const BASE_JSON = {
  bias: 'bearish',
  entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
  sl: '1.2850', tp: '1.2700',
  trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
  time_horizon_days: 3,
  conflict: 'none', conflict_note: null,
};

const AATAS_JSON = {
  ...BASE_JSON,
  regime_check: {
    regime: 'risk_off',
    cb_bias: { GBP: 'dovish', USD: 'hawkish' },
    cb_source_conflict: false, event_wait: false, event_note: null, gold: null,
  },
  gate_validitas_driver: { pass: true, note: 'BoE dovish, statement resmi, sudah tercermin di harga' },
  fundamental_bias: { score_pct: 80, arah: 'bearish', driver: 'divergensi BoE-Fed', konfirmasi: ['CPI UK melandai', 'BoE dovish'], konflik: null, strong_vs_weak: true },
  technical: { score_pct: 70, bos: 'ada', area: '1.2800', fib_zone: '0.382', fib_reason: 'tren kuat, retracement dangkal', liquidity_context: null, ranging: false },
  gate_risk_management: { pass: true, note: 'RR 1:2, SL di atas swing H4' },
  final_validation: { cot: 'searah', retail: 'netral', efek: 'skor naik sedikit' },
  checklist_pct: 82, verdict: 'SIAP TRADE',
  reasoning_note: 'Driver BoE dovish sudah tercermin di harga; struktur H4 LH+LL mengonfirmasi arah fundamental.',
};

function rawFrom(json) {
  return `${JSON.stringify(json)}\n===COMMENTARY===\nParagraf komentar untuk test AATAS.`;
}

function makeAnalyzeFetchStub(store, rawText, capture) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      if (capture) capture.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: rawText } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

function baseStore() {
  return makeStore({
    'ohlcv_fresh:GBPUSD=X': '1',
    'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
  });
}

test('AATAS e2e: prompt jalur auto membawa blok checklist + field baru; jalur manual TIDAK berubah', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const capAuto = [];
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON), capAuto);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }

    const autoUser = capAuto[0].messages[1].content;
    const autoSys  = capAuto[0].messages[0].content;
    assert.match(autoUser, /\[CHECKLIST AATAS/);
    assert.match(autoUser, /- checklist_pct:/);
    assert.match(autoUser, /- reasoning_note:/);
    assert.doesNotMatch(autoUser, /- makro_alignment:/, 'field lama tidak boleh diminta lagi di jalur auto');
    assert.doesNotMatch(autoUser, /- confidence:/);
    assert.match(autoSys, /"checklist_pct"/);
    assert.doesNotMatch(autoSys, /"makro_alignment"/);
  });

  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const capManual = [];
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(BASE_JSON), capManual);
    try {
      const handler = loadHandler();
      await handler({
        headers: {}, method: 'POST', body: {},
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }

    const manualUser = capManual[0].messages[1].content;
    const manualSys  = capManual[0].messages[0].content;
    assert.doesNotMatch(manualUser, /CHECKLIST AATAS/, 'isolasi Opsi A: fitur publik tidak boleh kena porting ini');
    assert.match(manualUser, /- makro_alignment:/);
    assert.match(manualUser, /- confidence:/);
    assert.match(manualUser, /Isi paragraf pertama \(tanpa header\) — bias & posisi makro harga/);
    assert.match(manualSys, /"makro_alignment"/);
  });
});

test('AATAS e2e: field checklist (termasuk reasoning_note) tersimpan ke setup_log_auto:v1 + stempel policy_v/aatas_v', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const st = log[0];
      assert.equal(st.checklist_pct, 82);
      assert.equal(st.verdict, 'SIAP TRADE');
      assert.match(st.reasoning_note, /BoE dovish/);
      assert.equal(st.regime_check.regime, 'risk_off');
      assert.deepEqual(st.gate_validitas_driver.pass, true);
      assert.equal(st.technical.fib_zone, '0.382');
      assert.equal(st.final_validation.cot, 'searah');
      assert.equal(st.aatas_v, AATAS_PROMPT_VERSION);
      assert.ok(st.policy_v >= AATAS_EPOCH, 'setup AATAS wajib membawa stempel epoch baru');
      // Field execution-critical TETAP ADA (dibaca gate/evaluasi existing).
      assert.equal(st.bias, 'bearish');
      assert.equal(st.conflict, 'none');
      // Field lama yang digantikan.
      assert.equal(st.makro_alignment, null);
      assert.equal(st.confidence, null);
      assert.equal(st.sistem_hakim, null);
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS e2e: GATE gagal (validitas driver) -> setup TIDAK pernah lahir, level dinolkan', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const gagal = {
      ...AATAS_JSON,
      gate_validitas_driver: { pass: false, note: 'driver cuma ekspektasi, belum ada rilis' },
      checklist_pct: 40, verdict: 'NO TRADE',
    };
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(gagal));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.entry_zone, null, 'GATE wajib mengikat di kode, bukan cuma imbauan prompt');
      assert.equal(res.body.structured.sl, null);
      assert.equal(res.body.structured.tp, null);
      assert.equal(res.body.structured.aatas_reject_reason, 'gate_validitas_driver');
      assert.equal(store.strings['setup_log_auto:v1'], undefined, 'tidak ada setup yang boleh tersimpan');
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS e2e: verdict NO TRADE saja (gate lolos) juga membatalkan setup', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom({ ...AATAS_JSON, checklist_pct: 45, verdict: 'NO TRADE' }));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.aatas_reject_reason, 'verdict_no_trade');
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS e2e: model tidak melaporkan gate/verdict sama sekali -> fail-open, setup tetap lahir', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(BASE_JSON)); // tanpa field AATAS sama sekali
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.aatas_reject_reason, null);
      assert.ok(store.strings['setup_log_auto:v1'], 'skema tidak dipatuhi bukan alasan menggagalkan setup');
      const st = JSON.parse(store.strings['setup_log_auto:v1'])[0];
      assert.equal(st.checklist_pct, null);
      assert.equal(st.verdict, null);
    } finally { global.fetch = origFetch; }
  });
});

// ── hard-stop Step 0 cabang XAU/USD (end-to-end) ─────────────────────────────
// Satu-satunya hard-block baru AATAS. `unanimous` datang dari laporan model,
// FAKTA anomali korelasinya dihitung kode dari cache correlations_v3 — dua sumber
// terpisah, supaya angka tidak ikut dikarang model.

const XAU_JSON_BASE = {
  bias: 'bullish',
  entry_zone: '3990-3995', entry_basis: 'cluster S/R',
  sl: '3960', tp: '4060',
  trigger: 'tunggu rejection H1 di 3990', invalidation_condition: 'close H4 di bawah 3950',
  time_horizon_days: 3, conflict: 'none', conflict_note: null,
  gate_validitas_driver: { pass: true, note: 'real yield turun, data rilis resmi' },
  gate_risk_management: { pass: true, note: 'RR 1:2, SL di bawah swing' },
  checklist_pct: 80, verdict: 'SIAP TRADE',
  reasoning_note: 'Real yield turun mendukung emas; struktur H4 HH+HL.',
};

function xauStore(corrPayload) {
  const seed = {
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': JSON.stringify(mkTrendCandles(3900, 4000)),
  };
  if (corrPayload) seed['correlations_v3'] = JSON.stringify(corrPayload);
  return makeStore(seed);
}

const CORR_ANOMALI = { gold_correlations: { RealYield: { r20: -0.05, r60: -0.75 } }, anomalies: [] };
const CORR_NORMAL  = { gold_correlations: { RealYield: { r20: -0.60, r60: -0.75 } }, anomalies: [] };

async function runXau(store, json) {
  const origFetch = global.fetch;
  global.fetch = makeAnalyzeFetchStub(store, rawFrom(json));
  try {
    const handler = loadHandler();
    const res = fakeRes();
    await handler({
      headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
      query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', auto: '1' },
    }, res);
    return res;
  } finally { global.fetch = origFetch; }
}

test('AATAS e2e XAU: real yield/DXY/regime TIDAK bulat + korelasi live anomali -> setup dibatalkan (hard-stop)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_ANOMALI);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'neutral', gold: { real_yield: 'bullish', dxy: 'bearish', risk_regime: 'netral', unanimous: false } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.structured.aatas_reject_reason, 'gold_regime_split_corr_anomali');
    assert.equal(res.body.structured.entry_zone, null);
    assert.equal(store.strings['setup_log_auto:v1'], undefined);
  });
});

test('AATAS e2e XAU: TIDAK bulat tapi korelasi NORMAL -> setup tetap lahir (real yield jadi penentu)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_NORMAL);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'neutral', gold: { real_yield: 'bullish', dxy: 'bearish', risk_regime: 'netral', unanimous: false } },
    });
    assert.equal(res.body.structured.aatas_reject_reason, null);
    assert.ok(store.strings['setup_log_auto:v1'], 'korelasi normal bukan alasan memblokir');
  });
});

test('AATAS e2e XAU: bulat 3/3 -> setup lahir walau korelasi sedang anomali', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_ANOMALI);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'risk_off', gold: { real_yield: 'bullish', dxy: 'bullish', risk_regime: 'bullish', unanimous: true } },
    });
    assert.equal(res.body.structured.aatas_reject_reason, null);
    assert.ok(store.strings['setup_log_auto:v1']);
  });
});

// ── Gate B (drawdown circuit breaker) ikut discope ke populasi AATAS ─────────
// Kalau tidak, kerugian arsitektur LAMA langsung menyalakan rem di menit pertama
// arsitektur baru hidup — sistem yang dibuat untuk memperbaiki kerugian itu tidak
// pernah dapat kesempatan membuktikan diri.

const { _isAatasEpochSetup } = loadHandler();

test('_isAatasEpochSetup: policy_v > est > rekonstruksi dari ts; versi tak tentu -> BUKAN populasi AATAS', () => {
  assert.equal(_isAatasEpochSetup({ policy_v: AATAS_EPOCH }), true);
  assert.equal(_isAatasEpochSetup({ policy_v: AATAS_EPOCH - 1 }), false);
  assert.equal(_isAatasEpochSetup({ policy_v_est: AATAS_EPOCH }), true);
  assert.equal(_isAatasEpochSetup({ ts: Date.parse('2026-07-21T00:00:00Z') }), false);
  assert.equal(_isAatasEpochSetup({ ts: 'bukan-angka' }), false);
  assert.equal(_isAatasEpochSetup(null), false);
});

test('Gate B: rentetan SL arsitektur LAMA tidak lagi memblokir kandidat AATAS', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // 6 SL beruntun dari kebijakan lama (rolling R = -6, jauh di bawah ambang manapun)
    // dan tidak ada posisi pending/open (katup darurat waktu belum tentu terbuka).
    const slLama = [];
    for (let i = 0; i < 6; i++) {
      slLama.push({
        id: `EURUSD=X:${1786100000000 + i}`, symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish',
        entry_zone: '1.1700', sl: '1.1750', tp: '1.1600', rr: 2, status: 'sl',
        ts: 1786100000000 + i, closed_t: 1786200000000 + i, source: 'auto', policy_v: 25,
      });
    }
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify(slLama),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const baru = log.find(x => x.symbol === 'GBPUSD=X');
      assert.ok(baru, 'kandidat AATAS harus tetap lahir — rem diukur dari populasi kebijakan yang sekarang');
      assert.equal(baru.status, 'pending', 'harus jadi setup LIVE, bukan ghost hasil gate');
      assert.equal(baru.canceled_reason, undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('Gate B: rentetan SL dari populasi AATAS sendiri TETAP memblokir (rem tidak dimatikan, cuma discope)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // ts SENGAJA baru (beberapa jam lalu): katup darurat waktu (>=3 hari sejak entri
    // real terakhir) harus TERTUTUP supaya yang diuji benar-benar Gate B, bukan valve.
    const now = Date.now();
    const slBaru = [];
    for (let i = 0; i < 6; i++) {
      const ts = now - (i + 1) * 3600000;
      slBaru.push({
        id: `EURUSD=X:${ts}`, symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish',
        entry_zone: '1.1700', sl: '1.1750', tp: '1.1600', rr: 2, status: 'sl',
        ts, closed_t: ts + 60000, source: 'auto', policy_v: AATAS_EPOCH,
      });
    }
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify(slBaru),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const baru = log.find(x => x.symbol === 'GBPUSD=X');
      // Kandidat yang ditahan gate TETAP dicatat sebagai ghost (canceled) — itu memang
      // desainnya (ghost-tracking gate_reject), yang penting dia tidak jadi posisi live.
      assert.ok(baru, 'kandidat yang ditahan tetap direkam sebagai ghost, bukan hilang tanpa jejak');
      assert.equal(baru.status, 'canceled',
        'kalau kerugian datang dari arsitektur yang sekarang, Gate B wajib tetap menahan');
      assert.equal(baru.canceled_reason, 'gate_drawdown_circuit_breaker');
    } finally { global.fetch = origFetch; }
  });
});

// ── Step 0 gold: rate path Fed implied (konteks tambahan, non-blocking) ──────

const { _formatRatePathBlock } = loadHandler();

test('_formatRatePathBlock: arah pemangkasan/kenaikan dieja jelas; data kosong -> string kosong (bukan blok kosong di prompt)', () => {
  const cut = _formatRatePathBlock({ USD: { cumulative_3m_bps: -50, cumulative_6m_bps: -75 } });
  assert.match(cut, /50bps PEMANGKASAN sudah diharga/);
  assert.match(cut, /6 bulan: 75bps PEMANGKASAN/);
  const hike = _formatRatePathBlock({ USD: { cumulative_3m_bps: 25 } });
  assert.match(hike, /25bps KENAIKAN sudah diharga/);
  assert.doesNotMatch(hike, /6 bulan/);
  assert.equal(_formatRatePathBlock({ USD: {} }), '');
  assert.equal(_formatRatePathBlock(null), '');
});

test('AATAS e2e XAU: rate path masuk prompt jalur auto; pair FX & jalur manual TIDAK menariknya', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const cap = [];
    const store = xauStore(CORR_NORMAL);
    store.strings['rate_path'] = JSON.stringify({ USD: { cumulative_3m_bps: -50 } });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom({
      ...XAU_JSON_BASE,
      regime_check: { regime: 'risk_off', gold: { real_yield: 'bullish', dxy: 'bullish', risk_regime: 'bullish', unanimous: true } },
    }), cap);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }
    assert.match(cap[0].messages[1].content, /RATE PATH FED/);
  });

  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const cap = [];
    const store = baseStore();
    store.strings['rate_path'] = JSON.stringify({ USD: { cumulative_3m_bps: -50 } });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON), cap);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }
    assert.doesNotMatch(cap[0].messages[1].content, /RATE PATH FED/, 'rate path itu delta cabang gold, bukan FX');
  });
});

// ── Konsistensi LLM ikut discope, latensi pipeline TIDAK ─────────────────────
// Konsistensi = properti PROMPT (prompt jalur auto diganti total oleh AATAS, jadi
// sampel lama menjawab pertanyaan tentang prompt yang sudah tidak dipakai).
// Latensi = murni infrastruktur kalender, tidak ada hubungannya dengan keputusan AI.

test('_consistencySummary: agregat hanya dari populasi AATAS, `recent` tetap penuh; latensi tidak difilter', async () => {
  const tsLama  = Date.parse('2026-08-10T10:45:00Z'); // arsitektur lama
  const tsBaru  = Date.now();                          // pasca-AATAS
  const konsistensi = [
    { ts: tsBaru, pair: 'frxXAUUSD', bias_identical: true },
    { ts: tsLama, pair: 'frxXAUUSD', bias_identical: false },
    { ts: tsLama - 1000, pair: 'frxXAUUSD', bias_identical: false },
  ].map(o => JSON.stringify(o));
  const latensi = [
    { ts: tsLama, latency_ms: 600000 },
    { ts: tsLama - 1000, latency_ms: 1200000 },
  ].map(o => JSON.stringify(o));

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const [cmd, key] = JSON.parse(opts.body);
    if (cmd === 'LRANGE' && key === 'consistency_log:v1') return { ok: true, json: async () => ({ result: konsistensi }) };
    if (cmd === 'LRANGE' && key === 'calendar_actual_latency_log:v1') return { ok: true, json: async () => ({ result: latensi }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const { _consistencySummary, _summarizeLatency } = loadHandler();
    const c = await _consistencySummary();
    assert.equal(c.total, 1, 'cuma sampel pasca-AATAS yang dihitung');
    assert.equal(c.bias_identical, 1);
    assert.equal(c.bias_identical_pct, 100, 'sampel prompt lama tidak boleh menyeret angka prompt baru');
    assert.equal(c.recent.length, 3, 'riwayat mentah tetap bisa dibaca');
    assert.equal(c.from_policy_v, AATAS_EPOCH);

    // Latensi: entri LAMA tetap dihitung — ini data infrastruktur yang masih berlaku.
    const l = _summarizeLatency([{ latency_ms: 600000 }, { latency_ms: 1200000 }]);
    assert.equal(l.n, 2, 'latensi pipeline TIDAK ikut direset');
  } finally { global.fetch = origFetch; }
});
