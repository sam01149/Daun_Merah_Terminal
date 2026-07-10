// test/market_digest_thesis.test.js
// Unit test validasi schema thesis Call 3 (api/market-digest.js). Fokus: mencegah
// invalidation_condition mengutip currency di luar pair yang direkomendasikan — bug
// nyata yang tertangkap manual (thesis USD/JPY SHORT dengan invalidation trigger CAD
// Employment Change, padahal CAD bukan bagian pair USD/JPY sama sekali).
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const {
  validateThesis, thesisPairCurrencies, thesisInvalidationCurrencyConsistent,
} = require('../api/market-digest.js');

function baseThesis(overrides = {}) {
  return {
    dominant_regime: 'neutral',
    strongest_currency: 'USD',
    weakest_currency: 'JPY',
    pair_recommendation: 'USD/JPY',
    direction: 'short',
    confidence_1_to_5: 3,
    invalidation_condition: 'Rilis data ketenagakerjaan AS jauh lebih kuat dari ekspektasi',
    time_horizon_days: 5,
    catalyst_dependency: 'Divergensi kebijakan Fed vs BoJ',
    xau_bias: 'bearish',
    xau_dominant_driver: 'usd_strength',
    xau_driver_evidence: 'Real yield AS 2.33%',
    xau_key_trigger: 'Tidak ada trigger jelas dalam 24 jam',
    xau_confidence: 3,
    ...overrides,
  };
}

test('thesisPairCurrencies: parse pair standar', () => {
  assert.deepStrictEqual(thesisPairCurrencies('USD/JPY'), ['USD', 'JPY']);
  assert.deepStrictEqual(thesisPairCurrencies(' usd/jpy '), ['USD', 'JPY']);
});

test('thesisPairCurrencies: reject format rusak / currency sama / bukan major', () => {
  assert.strictEqual(thesisPairCurrencies('USDJPY'), null);
  assert.strictEqual(thesisPairCurrencies('USD/USD'), null);
  assert.strictEqual(thesisPairCurrencies('USD/XXX'), null);
  assert.strictEqual(thesisPairCurrencies(null), null);
  assert.strictEqual(thesisPairCurrencies(undefined), null);
});

test('thesisInvalidationCurrencyConsistent: lolos kalau invalidation cuma sebut currency di dalam pair', () => {
  const t = baseThesis({ invalidation_condition: 'Data NFP AS jauh di atas ekspektasi, USD menguat tajam' });
  assert.strictEqual(thesisInvalidationCurrencyConsistent(t), true);
});

test('thesisInvalidationCurrencyConsistent: GAGAL kalau invalidation sebut currency di luar pair (bug asli — CAD di thesis USD/JPY)', () => {
  const t = baseThesis({
    invalidation_condition: 'Pengumuman CAD Employment Change dan Unemployment Rate dalam 2 jam ke depan',
  });
  assert.strictEqual(thesisInvalidationCurrencyConsistent(t), false);
  assert.strictEqual(validateThesis(t), false);
});

test('thesisInvalidationCurrencyConsistent: no_trade selalu lolos (tak ada pair yang benar-benar ditradingkan)', () => {
  const t = baseThesis({ direction: 'no_trade', pair_recommendation: 'GARBAGE', invalidation_condition: 'CAD apa saja' });
  assert.strictEqual(thesisInvalidationCurrencyConsistent(t), true);
});

test('thesisInvalidationCurrencyConsistent: pair_recommendation rusak pada direction aktif -> gagal', () => {
  const t = baseThesis({ pair_recommendation: 'USDJPY' });
  assert.strictEqual(thesisInvalidationCurrencyConsistent(t), false);
});

test('validateThesis: thesis valid lengkap tetap lolos (no regression)', () => {
  assert.strictEqual(validateThesis(baseThesis()), true);
});

test('validateThesis: field lain tetap divalidasi seperti sebelumnya', () => {
  assert.strictEqual(validateThesis(baseThesis({ dominant_regime: 'bullish' })), false);
  assert.strictEqual(validateThesis(baseThesis({ confidence_1_to_5: 9 })), false);
  assert.strictEqual(validateThesis(baseThesis({ xau_bias: 'up' })), false);
});
