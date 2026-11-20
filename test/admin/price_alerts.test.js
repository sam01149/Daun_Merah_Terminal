// test/admin/price_alerts.test.js — PLAN AJ: validasi + I/O Redis alert harga.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const pa = require('../../api/_price_alerts.js');

function fakeRedis(initial) {
  const store = new Map();
  if (initial !== undefined) store.set(pa.PRICE_ALERTS_KEY, JSON.stringify(initial));
  const calls = [];
  const cmd = async (...args) => {
    calls.push(args);
    const [op, key, val] = args;
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'SET') { store.set(key, val); return 'OK'; }
    return null;
  };
  return { cmd, calls, store };
}

// ── Sanitasi input ───────────────────────────────────────────────────────────

test('sanitizePair: menerima format longgar, menolak yang bukan FX/XAU', () => {
  assert.equal(pa.sanitizePair('eur/usd'), 'EURUSD');
  assert.equal(pa.sanitizePair(' xauusd '), 'XAUUSD');
  assert.equal(pa.sanitizePair('GBPJPY'), 'GBPJPY');
  assert.equal(pa.sanitizePair('BTCUSD'), null, 'kripto bukan cakupan feed frx*');
  assert.equal(pa.sanitizePair('US10Y'), null);
  assert.equal(pa.sanitizePair('EURUSDX'), null);
  assert.equal(pa.sanitizePair('EURJPY=X'), null, 'format simbol Yahoo bukan masukan yang sah di sini');
  assert.equal(pa.sanitizePair(null), null);
});

test('roundPrice: desimal mengikuti instrumen (FX 5, JPY 3, XAU 2)', () => {
  assert.equal(pa.roundPrice('EURUSD', 1.085051), 1.08505);
  assert.equal(pa.roundPrice('USDJPY', 154.2496), 154.25);
  assert.equal(pa.roundPrice('XAUUSD', 2650.456), 2650.46);
  assert.equal(pa.roundPrice('EURUSD', 0), null);
  assert.equal(pa.roundPrice('EURUSD', 'bukan angka'), null);
  assert.equal(pa.roundPrice('EURUSD', -5), null);
});

test('sanitizeNote: buang karakter kontrol, rapikan spasi, potong 120 karakter', () => {
  assert.equal(pa.sanitizeNote('  Retest\nS/R  '), 'Retest S/R');
  assert.equal(pa.sanitizeNote(null), '');
  const long = pa.sanitizeNote('a'.repeat(200));
  assert.equal(long.length, pa.MAX_NOTE_LEN);
});

test('normalizeDirection: hanya touch/cross_up/cross_down (default touch)', () => {
  assert.equal(pa.normalizeDirection(''), null);
  assert.equal(pa.normalizeDirection('CROSS_UP'), 'cross_up');
  assert.equal(pa.normalizeDirection('touch'), 'touch');
  assert.equal(pa.normalizeDirection('tembus'), null);
});

// ── Validasi alert ───────────────────────────────────────────────────────────

test('validateAlertInput: alert valid dibulatkan dan dicatat lengkap', () => {
  const res = pa.validateAlertInput({
    pair: 'eurusd', target_price: 1.085051, direction: 'cross_up', note: 'Retest S/R',
  }, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.alert, {
    pair: 'EURUSD', target_price: 1.08505, direction: 'cross_up', note: 'Retest S/R', initial_price: null,
  });
});

test('validateAlertInput: menolak pair/direction/harga tidak valid', () => {
  assert.equal(pa.validateAlertInput({ pair: 'BTCUSD', target_price: 100 }).ok, false);
  assert.equal(pa.validateAlertInput({ pair: 'EURUSD', target_price: 0 }).ok, false);
  assert.equal(pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.1, direction: 'tembus' }).ok, false);
  assert.equal(pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.1, initial_price: -1 }).ok, false);
});

test('validateAlertInput: dedupe pair+arah+level yang berimpit (< 0.5 pip)', () => {
  const existing = [{
    id: 'pa_1', pair: 'EURUSD', target_price: 1.08500, direction: 'cross_up', note: '',
  }];
  const dup = pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.08502, direction: 'cross_up' }, existing);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /sudah ada/);
  // arah berbeda = alert berbeda (level yang sama dipantau dua arah)
  const other = pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.08502, direction: 'cross_down' }, existing);
  assert.equal(other.ok, true);
});

test('validateAlertInput: batas per pair dan batas total', () => {
  const perPair = Array.from({ length: pa.MAX_ALERTS_PER_PAIR }, (_, i) => ({
    id: `pa_${i}`, pair: 'EURUSD', target_price: 1.08 + i / 1000, direction: 'touch',
  }));
  const res = pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.2 }, perPair);
  assert.equal(res.ok, false);
  assert.match(res.error, /maksimal/);

  const many = Array.from({ length: pa.MAX_ALERTS_TOTAL }, (_, i) => ({
    id: `pa_${i}`, pair: 'GBPUSD', target_price: 1.2 + i / 1000, direction: 'touch',
  }));
  const total = pa.validateAlertInput({ pair: 'EURUSD', target_price: 1.2 }, many);
  assert.equal(total.ok, false);
  assert.match(total.error, /alert aktif/);
});

// ── I/O Redis ────────────────────────────────────────────────────────────────

test('addActiveAlert: menyimpan alert dengan id, status active, created_at ISO', async () => {
  const redis = fakeRedis([]);
  const now = Date.UTC(2026, 10, 20, 13, 5);
  const res = await pa.addActiveAlert(redis.cmd, { pair: 'XAUUSD', target_price: 2650.456, direction: 'touch', note: 'Supply H4' }, { now });
  assert.equal(res.ok, true);
  assert.match(res.alert.id, /^pa_\d+_[0-9a-f]+$/);
  assert.equal(res.alert.status, 'active');
  assert.equal(res.alert.created_at, new Date(now).toISOString());
  assert.equal(res.alert.target_price, 2650.46);

  const stored = await pa.getActiveAlerts(redis.cmd);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pair, 'XAUUSD');
});

test('addActiveAlert: JSON Rusak di Redis tidak menjatuhkan pembacaan', async () => {
  const redis = fakeRedis();
  redis.store.set(pa.PRICE_ALERTS_KEY, '{bukan-json');
  assert.deepEqual(await pa.getActiveAlerts(redis.cmd), []);
  const res = await pa.addActiveAlert(redis.cmd, { pair: 'EURUSD', target_price: 1.1 });
  assert.equal(res.ok, true);
  assert.equal((await pa.getActiveAlerts(redis.cmd)).length, 1);
});

test('removeActiveAlert: menghapus berdasarkan id, id asing = error 404-an', async () => {
  const redis = fakeRedis([
    { id: 'pa_1', pair: 'EURUSD', target_price: 1.085, direction: 'touch', note: '' },
    { id: 'pa_2', pair: 'GBPUSD', target_price: 1.27, direction: 'touch', note: '' },
  ]);
  const removed = await pa.removeActiveAlert(redis.cmd, 'pa_1');
  assert.equal(removed.ok, true);
  const left = await pa.getActiveAlerts(redis.cmd);
  assert.deepEqual(left.map(a => a.id), ['pa_2']);

  const missing = await pa.removeActiveAlert(redis.cmd, 'pa_999');
  assert.equal(missing.ok, false);
  assert.equal((await pa.removeActiveAlert(redis.cmd, '')).ok, false);
});

test('parseAlerts: membuang entri tanpa pair / target tidak masuk akal', () => {
  assert.deepEqual(pa.parseAlerts(null), []);
  assert.deepEqual(pa.parseAlerts('null'), []);
  assert.deepEqual(
    pa.parseAlerts(JSON.stringify([
      { pair: 'EURUSD', target_price: 1.1 },
      { pair: '', target_price: 1.1 },
      { pair: 'GBPUSD', target_price: 'x' },
      null,
    ])).map(a => a.pair),
    ['EURUSD']
  );
});
