const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const {
  _computePrimeManualDirection,
  _enforceManualAcademyContract,
  MANUAL_ANALYSIS_POLICY_VERSION,
  MANUAL_MIN_RR,
} = require('../../api/admin.js');

test('manual Prime direction: butuh dua tingkat, confidence Medium+, dan data tidak disputed', () => {
  const cb = {
    EUR: { bias: 'Dovish', confidence: 'High' },
    USD: { bias: 'Cautious Hawkish', confidence: 'Medium' },
  };
  assert.strictEqual(_computePrimeManualDirection({ label: 'EUR/USD', cbBiasObj: cb }), 'bearish');
  assert.strictEqual(_computePrimeManualDirection({ label: 'USD/EUR', cbBiasObj: cb }), 'bullish');
  assert.strictEqual(_computePrimeManualDirection({ label: 'EUR/USD', cbBiasObj: { ...cb, EUR: { bias: 'Neutral', confidence: 'High' } } }), null);
  assert.strictEqual(_computePrimeManualDirection({ label: 'EUR/USD', cbBiasObj: { ...cb, EUR: { ...cb.EUR, confidence: 'Low' } } }), null);
  assert.strictEqual(_computePrimeManualDirection({ label: 'EUR/USD', cbBiasObj: { ...cb, EUR: { ...cb.EUR, divergence_warning: {} } } }), null);
  assert.strictEqual(MANUAL_MIN_RR, 2);
});

test('manual Prime direction: XAU hanya dikunci oleh thesis confidence tinggi', () => {
  assert.strictEqual(_computePrimeManualDirection({ isXau: true, xauThesis: { xau_bias: 'bullish', xau_confidence: 4 } }), 'bullish');
  assert.strictEqual(_computePrimeManualDirection({ isXau: true, xauThesis: { xau_bias: 'bearish', xau_confidence: 3 } }), null);
});

test('manual Academy contract: momentum searah lolos dengan trigger deterministik', () => {
  const out = _enforceManualAcademyContract({
    strategy_id: 'momentum', macro_direction: 'bearish', macro_reason: 'ECB dovish vs Fed hawkish',
    bias: 'bearish', entry_zone: '1.1000-1.1010', entry_basis: 'resistance', sl: '1.1050', tp: '1.0900',
  }, { lockedDirection: 'bearish' });
  assert.strictEqual(out.analysis_policy_v, MANUAL_ANALYSIS_POLICY_VERSION);
  assert.strictEqual(out.academy_contract_status, 'passed');
  assert.strictEqual(out.entry_zone, '1.1000-1.1010');
  assert.deepStrictEqual(out.trigger_contract, {
    timeframe: '1h', session: 'london_or_new_york', rejection_required: true,
    breakout_allowed: false, min_rr: 2, body_atr_min: 0.5, body_atr_max: 1,
    stop_rule: 'beyond_rejection_wick',
  });
});

test('manual Academy contract: momentum melawan makro atau strategy tidak valid menolak level', () => {
  const base = { macro_direction: 'bearish', bias: 'bullish', entry_zone: '1.1000', entry_basis: 'x', sl: '1.0900', tp: '1.1200' };
  const conflict = _enforceManualAcademyContract({ ...base, strategy_id: 'momentum' });
  assert.strictEqual(conflict.academy_contract_status, 'rejected');
  assert.strictEqual(conflict.strategy_id, 'no_trade');
  assert.strictEqual(conflict.trigger_contract, null);
  assert.strictEqual(conflict.entry_zone, null);
  assert.match(conflict.academy_reject_reason, /tidak boleh melawan/);

  const unknown = _enforceManualAcademyContract({ ...base, strategy_id: 'breakout' });
  assert.strictEqual(unknown.strategy_id, 'no_trade');
  assert.strictEqual(unknown.trigger_contract, null);
  assert.strictEqual(unknown.sl, null);
});

test('manual Academy contract: range/fade eksplisit boleh berbeda dari arah besar', () => {
  const range = _enforceManualAcademyContract({ strategy_id: 'range', macro_direction: 'mixed', macro_reason: 'Kebijakan kedua kaki campuran', bias: 'bullish', entry_zone: '100', sl: '98', tp: '104' });
  assert.strictEqual(range.academy_contract_status, 'passed');
  assert.strictEqual(range.trigger_contract.body_atr_min, null);
  assert.strictEqual(range.trigger_contract.rsi14_h1_divergence, 'recommended_optional');
  assert.strictEqual(range.trigger_contract.atr_timeframe, '6h');
  assert.strictEqual(range.trigger_contract.stop_atr, 1);
  assert.strictEqual(range.trigger_contract.target_atr, 2);

  const fade = _enforceManualAcademyContract({ strategy_id: 'tactical_fade', macro_direction: 'bearish', macro_reason: 'Arah besar bearish, kenaikan hanya overreaction', bias: 'bullish', entry_zone: '100', sl: '98', tp: '104' });
  assert.strictEqual(fade.academy_contract_status, 'passed');
  assert.strictEqual(fade.trigger_contract.overreaction_story, 'thin_or_unconfirmed');
  assert.strictEqual(fade.trigger_contract.macro_view_must_remain_unchanged, true);
});

test('manual Academy contract: setup aktif tanpa entry/SL/TP lengkap menjadi no-trade rejection', () => {
  const out = _enforceManualAcademyContract({
    strategy_id: 'momentum', macro_direction: 'bullish', macro_reason: 'USD hawkish vs EUR dovish', bias: 'bullish',
    entry_zone: '1.1000', sl: null, tp: '1.1200',
  });
  assert.strictEqual(out.academy_contract_status, 'rejected');
  assert.strictEqual(out.strategy_id, 'no_trade');
  assert.match(out.academy_reject_reason, /entry, stop loss, dan take profit/);
  assert.strictEqual(out.entry_zone, null);
});

test('manual Academy contract: setup aktif tanpa arah trade tegas ditolak sebagai no_trade', () => {
  const out = _enforceManualAcademyContract({
    strategy_id: 'range', macro_direction: 'mixed', macro_reason: 'Makro campuran dan harga berada dalam range',
    bias: 'mixed', entry_zone: '100', sl: '98', tp: '104',
  });
  assert.strictEqual(out.academy_contract_status, 'rejected');
  assert.strictEqual(out.strategy_id, 'no_trade');
  assert.strictEqual(out.trigger_contract, null);
  assert.match(out.academy_reject_reason, /arah trade bullish atau bearish/);
});
