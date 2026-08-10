// test/admin/alignment_contradiction.test.js — [CEK KONTRADIKSI] (2026-08-10), lihat
// _detectAlignmentReasonContradiction di api/admin.js. Kasus nyata yang memicu ini:
// setup CHF/JPY bullish, makro_alignment_reason AI menulis "...mendukung penguatan JPY
// vs CHF, searah dengan bias bullish CHF/JPY karena JPY... yang melemah" — JPY diklaim
// menguat DAN melemah sekaligus di kalimat yang sama. Sistem Hakim (_computeCbDirServerSide)
// tidak menyala waktu itu karena bias bank sentral CHF (SNB) tidak confidence High, jadi
// setup ini lolos tanpa penjaga apa pun. Guard ini independen dari cbDir — murni pola teks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

const { _detectAlignmentReasonContradiction } = loadHandler();

// ── _detectAlignmentReasonContradiction (pure) ──────────────────────────────

test('_detectAlignmentReasonContradiction: kasus nyata CHF/JPY -> true (JPY menguat & melemah di kalimat sama)', () => {
  const reason = 'Bias BoJ Hawkish (confidence High) dan COT JPY net short -63.6K (persentil P1, crowded short) mendukung penguatan JPY vs CHF, searah dengan bias bullish CHF/JPY karena JPY adalah quote currency yang melemah.';
  assert.equal(_detectAlignmentReasonContradiction(reason), true);
});

test('_detectAlignmentReasonContradiction: dua currency BEDA dengan arah berbeda -> false (wajar, bukan kontradiksi)', () => {
  const reason = 'Bias SNB hawkish mendukung penguatan CHF, sementara BoJ dovish membuat JPY melemah — searah dengan bias bullish CHF/JPY.';
  assert.equal(_detectAlignmentReasonContradiction(reason), false);
});

test('_detectAlignmentReasonContradiction: satu currency, satu arah konsisten -> false', () => {
  const reason = 'Bias Fed Dovish + COT USD net short searah dengan bias bearish USD/JPY karena USD melemah.';
  assert.equal(_detectAlignmentReasonContradiction(reason), false);
});

test('_detectAlignmentReasonContradiction: null/kosong/tanpa currency code -> false', () => {
  assert.equal(_detectAlignmentReasonContradiction(null), false);
  assert.equal(_detectAlignmentReasonContradiction(''), false);
  assert.equal(_detectAlignmentReasonContradiction('Sinyal makro campur, tidak ada arah jelas.'), false);
});

test('_detectAlignmentReasonContradiction: currency sama disebut ulang dengan arah sama -> false', () => {
  const reason = 'JPY menguat didorong BoJ hawkish; penguatan JPY ini juga dikonfirmasi COT net short crowded, searah dengan bias bearish CHF/JPY.';
  assert.equal(_detectAlignmentReasonContradiction(reason), false);
});

// Regresi (2026-08-10, ditemukan user dari audit setup EUR/GBP nyata id
// EURGBP=X:1785744976162): reasoning ini SAH & TIDAK kontradiktif — "Intervensi JPY
// menguatkan JPY dan melemahkan USD" menyebut DUA currency beda (JPY & USD) dengan
// arah masing-masing SEKALI, lalu "EUR dan GBP sama-sama menguat TERHADAP USD" — USD
// di situ cuma pembanding (bukan subjek yang bergerak). Versi awal guard (index-to-index,
// tanpa exclude "terhadap") salah nangkep ini sebagai kontradiksi karena JPY yang
// disebut berulang ("Intervensi JPY menguatkan JPY") kebetulan lebih dekat secara index
// mentah ke "melemahkan" dibanding USD yang jadi objek sebenarnya.
test('_detectAlignmentReasonContradiction: kasus nyata EUR/GBP (reasoning SAH, bukan kontradiksi) -> false', () => {
  const reason = 'Intervensi JPY menguatkan JPY dan melemahkan USD, tetapi dampak langsung ke EUR/GBP tidak jelas karena kedua leg (EUR dan GBP) sama-sama menguat terhadap USD; fundamental EUR Cautious Dovish vs GBP Data Dependent tidak memberikan arah dominan.';
  assert.equal(_detectAlignmentReasonContradiction(reason), false);
});

// ── Integrasi ohlcv_analyze (auto-entry cron) — cbDir TIDAK tersedia (tanpa cb_bias),
// jadi Sistem Hakim diam; guard kontradiksi harus tetap nyala dari teks reasoning saja ──

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

const AI_JSON_CONTRADICTORY = {
  bias: 'bullish',
  entry_zone: '195.400-195.700', entry_basis: 'cluster S/R',
  sl: '195.100', tp: '197.827',
  trigger: 'tunggu candle H4 close di atas 195.700', invalidation_condition: 'close H4 di bawah 194.188',
  time_horizon_days: 3,
  makro_alignment: 'searah',
  makro_alignment_reason: 'Bias BoJ Hawkish (confidence High) dan COT JPY net short -63.6K (persentil P1, crowded short) mendukung penguatan JPY vs CHF, searah dengan bias bullish CHF/JPY karena JPY adalah quote currency yang melemah.',
  conflict: 'none', conflict_note: null,
};
const AI_RAW_TEXT_CONTRADICTORY = `${JSON.stringify(AI_JSON_CONTRADICTORY)}\n===COMMENTARY===\nKomentar singkat untuk tes CEK KONTRADIKSI.`;

function makeAnalyzeFetchStub(store, rawText) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: rawText } }] }) };
    throw new Error('unexpected network call di test: ' + u);
  };
}

test('CEK KONTRADIKSI cron: bias CHF tidak tersedia (cbDir null, Sistem Hakim diam) + reasoning kontradiktif -> tetap dikoreksi jadi konflik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:CHFJPY=X': '1',
      'ohlcv:CHFJPY=X:1h': JSON.stringify(mkTrendCandles(195.0, 195.6)),
      // cb_bias HANYA berisi leg JPY (confidence High) — bikin FUNDAMENTAL TERSTRUKTUR
      // terisi (hasFund true, jadi makro_alignment AI tidak dinolkan oleh normalisasi),
      // tapi leg CHF sengaja TIDAK ADA supaya _computeCbDirServerSide (butuh KEDUA leg
      // confidence High) tetap null -> Sistem Hakim tidak boleh evaluasi sama sekali.
      // Ini meniru situasi nyata CHF/JPY: bias SNB untuk CHF tidak tersedia/tidak High.
      'cb_bias': JSON.stringify({
        JPY: { bias: 'hawkish', confidence: 'High', updated_at: new Date().toISOString() },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, AI_RAW_TEXT_CONTRADICTORY);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'CHFJPY=X', label: 'CHF/JPY', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.makro_alignment, 'konflik', 'guard kontradiksi harus mengoreksi searah -> konflik');
      assert.equal(res.body.structured.conflict, 'arah');
      assert.match(res.body.structured.makro_alignment_reason, /CEK KONTRADIKSI/);

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].sistem_hakim, null, 'Sistem Hakim tidak boleh ikut nyala (cbDir null, tanpa cb_bias)');
      assert.equal(log[0].conflict_source, 'contradiction_guard');
      assert.equal(store.strings['contradiction_guard_stats:fired'], '1');
    } finally { global.fetch = origFetch; }
  });
});

test('CEK KONTRADIKSI cron: reasoning konsisten (tanpa kontradiksi) -> tidak disentuh, tetap searah', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const cleanJson = {
      ...AI_JSON_CONTRADICTORY,
      makro_alignment_reason: 'Bias SNB hawkish mendukung penguatan CHF, searah dengan bias bullish CHF/JPY.',
    };
    const rawText = `${JSON.stringify(cleanJson)}\n===COMMENTARY===\nKomentar singkat.`;
    const store = makeStore({
      'ohlcv_fresh:CHFJPY=X': '1',
      'ohlcv:CHFJPY=X:1h': JSON.stringify(mkTrendCandles(195.0, 195.6)),
      'cb_bias': JSON.stringify({
        JPY: { bias: 'hawkish', confidence: 'High', updated_at: new Date().toISOString() },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawText);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'CHFJPY=X', label: 'CHF/JPY', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.makro_alignment, 'searah');
      assert.equal(res.body.structured.conflict, 'none');

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].conflict_source, null);
      assert.equal(store.strings['contradiction_guard_stats:fired'], undefined);
    } finally { global.fetch = origFetch; }
  });
});
