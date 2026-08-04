// test/admin/tech_invalidation.test.js — Track 1 (Road to Professional LLM Trader,
// 2026-08-04): _evaluateTechInvalidation (api/admin.js), loop yang menyambungkan
// isInvalidationTriggered (api/_auto_entry_guard.js) ke setup_log_auto/setup_log —
// pola sama test/admin/position_review.test.js (_evaluateManaged).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _evaluateTechInvalidation } = require('../../api/admin.js');

const mkC = (i, o, h, l, c) => ({ t: i * 3600, o, h, l, c, v: 0 });

test('_evaluateTechInvalidation: trigger tersentuh (status open) -> intervention tech_invalidation + managed_status tech_invalidated, status MENTAH tidak ditimpa', () => {
  const setups = [{
    symbol: 'EURUSD=X', status: 'open', ts: 0,
    invalidation_trigger: { type: 'ma_break', level: 1.1000, timeframe: '1h', direction: 'below' },
    intervention: null, managed_status: null,
  }];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1060, 1.1040, 1.1045), mkC(2, 1.1045, 1.1046, 1.0990, 1.0995)] };
  _evaluateTechInvalidation(setups, candles);
  assert.equal(setups[0].status, 'open', 'status mentah tidak boleh ditimpa (prinsip U-5a)');
  assert.equal(setups[0].intervention.type, 'tech_invalidation');
  assert.equal(setups[0].intervention.t, 2 * 3600 * 1000);
  assert.equal(setups[0].managed_status, 'tech_invalidated');
  assert.equal(setups[0].managed_closed_t, 2 * 3600);
});

test('_evaluateTechInvalidation: status pending, trigger tersentuh SEBELUM fill -> tetap terdeteksi (thesis batal sebelum fill)', () => {
  const setups = [{
    symbol: 'EURUSD=X', status: 'pending', ts: 0,
    invalidation_trigger: { type: 'price_level', level: 1.1000, timeframe: '1h', direction: 'below' },
    intervention: null, managed_status: null,
  }];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1055, 1.0980, 1.0990)] };
  _evaluateTechInvalidation(setups, candles);
  assert.equal(setups[0].intervention.type, 'tech_invalidation');
  assert.equal(setups[0].status, 'pending');
});

test('_evaluateTechInvalidation: invalidation_trigger null -> diabaikan, tidak crash', () => {
  const setups = [{ symbol: 'EURUSD=X', status: 'open', ts: 0, invalidation_trigger: null, intervention: null }];
  assert.doesNotThrow(() => _evaluateTechInvalidation(setups, { 'EURUSD=X': [mkC(1, 1.1050, 1.1060, 1.0990, 1.0995)] }));
  assert.equal(setups[0].intervention, null);
});

test('_evaluateTechInvalidation: sudah punya intervention lain (mis. close_early AI) -> tidak ditimpa', () => {
  const setups = [{
    symbol: 'EURUSD=X', status: 'open', ts: 0,
    invalidation_trigger: { type: 'ma_break', level: 1.1000, timeframe: '1h', direction: 'below' },
    intervention: { type: 'close_early', t: 1000, reason: 'berita' }, managed_status: 'closed_early',
  }];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1060, 1.0980, 1.0990)] };
  _evaluateTechInvalidation(setups, candles);
  assert.equal(setups[0].intervention.type, 'close_early', '1 intervensi per posisi — jangan timpa keputusan AI yang sudah ada');
});

// Prioritas TP/SL asli (diskusi user): kalau _evaluateSetups sudah meresolusi status
// ke sl/tp dan menulis closed_t, invalidasi cuma dihitung utk candle SEBELUM closed_t.
test('_evaluateTechInvalidation: status sudah "sl" (closed_t di candle SAMA dgn level trigger) -> TIDAK dianggap invalidasi (TP/SL asli menang)', () => {
  const setups = [{
    symbol: 'EURUSD=X', status: 'sl', ts: 0, closed_t: 2 * 3600,
    invalidation_trigger: { type: 'ma_break', level: 1.1000, timeframe: '1h', direction: 'below' },
    intervention: null, managed_status: null,
  }];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1055, 1.1040, 1.1045), mkC(2, 1.1045, 1.1046, 1.0980, 1.0990)] };
  _evaluateTechInvalidation(setups, candles);
  assert.equal(setups[0].intervention, null);
});

test('_evaluateTechInvalidation: status sudah "sl" tapi level trigger tersentuh di candle LEBIH AWAL dari closed_t -> tetap tercatat sebagai invalidasi', () => {
  const setups = [{
    symbol: 'EURUSD=X', status: 'sl', ts: 0, closed_t: 3 * 3600,
    invalidation_trigger: { type: 'ma_break', level: 1.1000, timeframe: '1h', direction: 'below' },
    intervention: null, managed_status: null,
  }];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1055, 1.0980, 1.0990), mkC(3, 1.0990, 1.0992, 1.0900, 1.0910)] };
  _evaluateTechInvalidation(setups, candles);
  assert.equal(setups[0].intervention.type, 'tech_invalidation');
  assert.equal(setups[0].intervention.t, 1 * 3600 * 1000);
  assert.equal(setups[0].status, 'sl', 'status mentah TETAP sl (ghost/counterfactual, prinsip U-5a)');
});

test('_evaluateTechInvalidation: status expired/canceled/invalid -> tidak dievaluasi', () => {
  const trig = { type: 'ma_break', level: 1.1000, timeframe: '1h', direction: 'below' };
  const setups = [
    { symbol: 'EURUSD=X', status: 'expired', ts: 0, invalidation_trigger: trig, intervention: null },
    { symbol: 'EURUSD=X', status: 'canceled', ts: 0, invalidation_trigger: trig, intervention: null },
    { symbol: 'EURUSD=X', status: 'invalid', ts: 0, invalidation_trigger: trig, intervention: null },
  ];
  const candles = { 'EURUSD=X': [mkC(1, 1.1050, 1.1055, 1.0980, 1.0990)] };
  _evaluateTechInvalidation(setups, candles);
  for (const s of setups) assert.equal(s.intervention, null);
});

test('_evaluateTechInvalidation: entri null/tanpa field -> aman, tidak crash', () => {
  assert.doesNotThrow(() => _evaluateTechInvalidation([null, {}, { symbol: 'EURUSD=X', status: 'open' }], {}));
});
