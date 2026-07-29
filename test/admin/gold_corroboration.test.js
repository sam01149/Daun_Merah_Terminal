// test/admin/gold_corroboration.test.js — korroborasi sumber kedua (Twelve Data
// XAU/USD) sebelum finalisasi transisi tp/sl GC=F (2026-07-29, diskusi user, insiden
// GC=F:1785244513683 — lihat daun_merah.md Session 260-261). GC=F (COMEX futures)
// rawan basis blowout vs spot mendekati expiry kontrak (bukan cuma bad print) — kalau
// spot TIDAK korroborasi breach, status HARUS ditahan di 'open' (bukan tp/sl final)
// supaya statistik win-rate tidak rusak oleh divergensi instrumen, bukan pasar riil.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
process.env.TWELVEDATA_API_KEY = 'fake-td-key';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

const { _breachDirection, _corroborateLevel, _corroborateGoldTransitions, _finalizeSetupTransitions } = loadHandler();

// ── _breachDirection (pure) ──────────────────────────────────────────────────

test('_breachDirection: bearish sl -> above; bearish tp -> below', () => {
  assert.equal(_breachDirection('bearish', 'sl'), 'above');
  assert.equal(_breachDirection('bearish', 'tp'), 'below');
});

test('_breachDirection: bullish sl -> below; bullish tp -> above', () => {
  assert.equal(_breachDirection('bullish', 'sl'), 'below');
  assert.equal(_breachDirection('bullish', 'tp'), 'above');
});

test('_breachDirection: status ambiguous -> null (di luar scope guard)', () => {
  assert.equal(_breachDirection('bearish', 'ambiguous'), null);
});

// ── _corroborateLevel (pure) ─────────────────────────────────────────────────

const mkSpotC = (t, h, l) => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 100 });
const T = 1785308400; // detik, sama dengan insiden asli

test('_corroborateLevel: direction above, spot high tembus level -> true (terkonfirmasi)', () => {
  const ok = _corroborateLevel(4065, 'above', [mkSpotC(T, 4070, 4040)], T * 1000);
  assert.equal(ok, true);
});

test('_corroborateLevel: direction above, spot high JAUH di bawah level -> false (divergensi, insiden asli)', () => {
  // Persis insiden asli: GC=F H 4106.70 vs Twelve Data XAU/USD H cuma 4047.76 jam yang sama
  const ok = _corroborateLevel(4065, 'above', [mkSpotC(T, 4047.76, 4040.89)], T * 1000);
  assert.equal(ok, false);
});

test('_corroborateLevel: dalam toleransi basis (15 USD) -> tetap true', () => {
  const ok = _corroborateLevel(4065, 'above', [mkSpotC(T, 4055, 4040)], T * 1000); // 4055 >= 4065-15
  assert.equal(ok, true);
});

test('_corroborateLevel: direction below, spot low tembus level -> true', () => {
  const ok = _corroborateLevel(3960, 'below', [mkSpotC(T, 3965, 3955)], T * 1000);
  assert.equal(ok, true);
});

test('_corroborateLevel: tidak ada candle spot jam yang cocok -> null (fail-open, bukan false)', () => {
  const ok = _corroborateLevel(4065, 'above', [mkSpotC(T + 100000, 4070, 4040)], T * 1000);
  assert.equal(ok, null);
});

test('_corroborateLevel: array candle spot kosong/invalid -> null', () => {
  assert.equal(_corroborateLevel(4065, 'above', [], T * 1000), null);
  assert.equal(_corroborateLevel(4065, 'above', null, T * 1000), null);
});

// ── _corroborateGoldTransitions / _finalizeSetupTransitions (integrasi + fetch stub) ──

function twelveDataStub(values) {
  return async (url) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) throw new Error('unexpected redis call di stub Twelve Data-only');
    if (u.includes('api.twelvedata.com')) return { ok: true, json: async () => ({ status: 'ok', values }) };
    throw new Error('unexpected network call di test: ' + u);
  };
}

function td(datetime, open, high, low, close) { return { datetime, open: String(open), high: String(high), low: String(low), close: String(close), volume: '100' }; }

test('_corroborateGoldTransitions: GC=F sl TIDAK dikonfirmasi Twelve Data -> revert ke open + divergence_hold', async () => {
  const setup = {
    id: 'GC=F:1', symbol: 'GC=F', bias: 'bearish', label: 'XAU/USD',
    entry_zone: '4044.35', sl: '4065.00', tp: '3968.97',
    status: 'sl', closed_t: T, loss_label: null,
  };
  const log = [setup];
  const store = { 'setup_log_auto:v1': JSON.stringify(log) };
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) {
      const args = JSON.parse(opts.body);
      const [cmd, key, ...rest] = args;
      if (cmd === 'GET') return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null }) };
      if (cmd === 'SET') {
        const flags = rest.slice(1).map(v => String(v).toUpperCase());
        if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(store, key)) return { ok: true, json: async () => ({ result: null }) };
        store[key] = rest[0];
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      if (cmd === 'DEL') { delete store[key]; return { ok: true, json: async () => ({ result: 1 }) }; }
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (u.includes('api.twelvedata.com')) {
      // Persis insiden asli: spot cuma H 4047.76 jam yang sama, jauh di bawah SL 4065
      return { ok: true, json: async () => ({ status: 'ok', values: [td('2026-07-29 07:00:00', 4041.75, 4047.76, 4040.89, 4043.65)] }) };
    }
    throw new Error('unexpected network call: ' + u);
  };
  try {
    const flagged = await _corroborateGoldTransitions(log, [setup]);
    assert.equal(flagged.length, 1);
    assert.equal(setup.status, 'open');
    assert.equal(setup.closed_t, undefined);
    assert.equal(setup.loss_label, null);
    assert.equal(setup.divergence_hold.would_be_status, 'sl');
    assert.equal(setup.divergence_hold.reason, 'gc_f_vs_spot_divergence');
    // Redis benar-benar ditulis ulang mencerminkan revert
    const persisted = JSON.parse(store['setup_log_auto:v1']);
    assert.equal(persisted[0].status, 'open');
  } finally { global.fetch = orig; }
});

test('_corroborateGoldTransitions: GC=F sl DIKONFIRMASI Twelve Data -> status sl tetap final, TIDAK direvert', async () => {
  const setup = {
    id: 'GC=F:2', symbol: 'GC=F', bias: 'bearish', label: 'XAU/USD',
    entry_zone: '4044.35', sl: '4065.00', tp: '3968.97',
    status: 'sl', closed_t: T, loss_label: null,
  };
  const log = [setup];
  global.fetch = twelveDataStub([td('2026-07-29 07:00:00', 4060, 4075, 4058, 4070)]); // high 4075 >= sl 4065 -> konfirmasi
  // Redis tidak akan dipanggil sama sekali kalau tidak ada yang direvert -> tidak perlu stub redis di sini,
  // TAPI kalau kode salah tetap coba revert, panggilan redis akan throw (fake-upstash) -> test gagal, ketahuan.
  const orig = global.fetch;
  try {
    const flagged = await _corroborateGoldTransitions(log, [setup]);
    assert.equal(flagged.length, 0);
    assert.equal(setup.status, 'sl'); // tidak disentuh
    assert.equal(setup.closed_t, T);
  } finally { global.fetch = orig; }
});

test('_corroborateGoldTransitions: symbol non-GC=F -> tidak pernah fetch Twelve Data, lolos apa adanya', async () => {
  const setup = { id: 'EURUSD=X:1', symbol: 'EURUSD=X', bias: 'bearish', sl: '1.2850', tp: '1.2700', status: 'sl', closed_t: T };
  const log = [setup];
  const orig = global.fetch;
  global.fetch = async (url) => { throw new Error('tidak boleh ada network call untuk simbol di luar CORROBORATION_SYMBOLS: ' + url); };
  try {
    const flagged = await _corroborateGoldTransitions(log, [setup]);
    assert.equal(flagged.length, 0);
    assert.equal(setup.status, 'sl');
  } finally { global.fetch = orig; }
});

test('_corroborateGoldTransitions: Twelve Data gagal/timeout -> fail-open, status sl tetap dipercaya (bukan revert)', async () => {
  const setup = { id: 'GC=F:3', symbol: 'GC=F', bias: 'bearish', label: 'XAU/USD', sl: '4065.00', tp: '3968.97', status: 'sl', closed_t: T };
  const log = [setup];
  const orig = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) throw new Error('network down (test)');
    throw new Error('unexpected call: ' + url);
  };
  try {
    const flagged = await _corroborateGoldTransitions(log, [setup]);
    assert.equal(flagged.length, 0);
    assert.equal(setup.status, 'sl'); // fail-open: tetap dipercaya, TIDAK direvert
  } finally { global.fetch = orig; }
});

test('_finalizeSetupTransitions: tidak ada transisi baru -> tidak ada network call sama sekali', async () => {
  const setup = { id: 'GC=F:4', symbol: 'GC=F', bias: 'bearish', sl: '4065.00', tp: '3968.97', status: 'open' };
  const log = [setup];
  const statusBeforeById = new Map([['GC=F:4', 'open']]); // sama seperti status sekarang -> bukan transisi
  const orig = global.fetch;
  global.fetch = async (url) => { throw new Error('tidak boleh ada network call kalau tidak ada transisi: ' + url); };
  try {
    await _finalizeSetupTransitions(log, statusBeforeById);
    assert.equal(setup.status, 'open');
  } finally { global.fetch = orig; }
});
