const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEventScenarios,
  buildAcademyShadow,
  mergeAcademyShadow,
  evaluateEventReaction,
  applyCompletedEventReactions,
  rankAcademyCohort,
} = require('../../api/_aatas_academy');

const decisionMs = Date.parse('2026-10-13T00:00:00Z');
const event = (overrides = {}) => ({
  date: '2026-10-13', time_wib: '08:30 WIB', currency: 'USD', impact: 'High',
  event: 'Nonfarm Payrolls', forecast_raw: 100, previous_raw: 90, actual_raw: null,
  ...overrides,
});
const candle = (iso, o, h, l, c) => ({ t: Date.parse(iso) / 1000, o, h, l, c });

test('Academy scenario didaftarkan as-of tanpa menyalin actual masa depan', () => {
  const scenarios = buildEventScenarios([event({ actual_raw: 150 })], 'EUR/USD', decisionMs);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].actual_as_of_decision, null);
  assert.equal(scenarios[0].experiment_id, 'academy_event_v1');
  assert.equal(scenarios[0].branches.above_forecast.expected_pair_direction, 'bearish');
  assert.equal(scenarios[0].quality, 'registered');
  assert.match(scenarios[0].input_hash, /^[a-f0-9]{20}$/);
});

test('Academy tidak mengarang arah untuk event ambigu atau forecast hilang', () => {
  const [scenario] = buildEventScenarios([
    event({ event: 'Federal Reserve Interest Rate Decision', forecast_raw: null }),
  ], 'XAU/USD', decisionMs);
  assert.equal(scenario.quality, 'forecast_missing');
  assert.equal(scenario.branches.above_forecast.expected_pair_direction, 'unknown');
});

test('Academy membaca decimal comma tanpa mengubah 1,000 menjadi satu', () => {
  const scenarios = buildEventScenarios([
    event({ event: 'GDP', forecast: '0,4%', forecast_raw: null }),
    event({ event: 'Employment Change', time_wib: '09:30 WIB', forecast: '1,000K', forecast_raw: null }),
  ], 'EUR/USD', decisionMs);
  assert.equal(scenarios[0].forecast, 0.4);
  assert.equal(scenarios[1].forecast, 1_000_000);
});

test('Reaction memakai candle dasar yang selesai sebelum rilis dan menandai confounder', () => {
  const [scenario] = buildEventScenarios([event()], 'EUR/USD', decisionMs);
  const candles = [];
  for (let hour = 0; hour < 10; hour++) {
    candles.push(candle(`2026-10-12T${String(11 + hour).padStart(2, '0')}:00:00Z`, 100, 100.2, 99.8, 100));
  }
  candles.push(candle('2026-10-12T21:00:00Z', 100, 100.2, 99.8, 100));
  candles.push(candle('2026-10-12T22:00:00Z', 100, 100.2, 99.8, 100));
  candles.push(candle('2026-10-12T23:00:00Z', 100, 100.2, 99.8, 100));
  candles.push(candle('2026-10-13T00:00:00Z', 100, 100.2, 99.8, 100));
  candles.push(candle('2026-10-13T01:00:00Z', 100, 100.1, 98.8, 99));
  candles.push(candle('2026-10-13T02:00:00Z', 99, 99.1, 97.8, 98));
  candles.push(candle('2026-10-13T03:00:00Z', 98, 98.1, 96.8, 97));
  const calendar = [event({ actual_raw: 150 }), event({ event: 'Unemployment Rate', time_wib: '09:00 WIB', actual_raw: 5, forecast_raw: 4 })];
  const reaction = evaluateEventReaction(scenario, candles, calendar, Date.parse('2026-10-13T05:00:00Z'));
  assert.equal(reaction.status, 'complete');
  assert.equal(reaction.outcome, 'confirm');
  assert.equal(reaction.confounded, true);
  assert.equal(reaction.shadow_readout, 'wait');
  assert.equal(reaction.causation_claimed, false);
  assert.ok(reaction.max_up_excursion_pct > 0);
  assert.ok(reaction.max_down_excursion_pct < 0);
  assert.ok(reaction.expected_favorable_excursion_pct > 0);
  assert.ok(reaction.base_candle_t * 1000 + 3600000 <= Date.parse(scenario.event_at));
});

test('Reaction belum ditulis sebelum jendela selesai dan lalu hanya ditempel ke envelope shadow', () => {
  const setup = {
    symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bullish', entry_zone: '1.0', sl: '0.9', tp: '1.2',
    regime_check: {}, gate_validitas_driver: { pass: true }, gate_risk_management: { pass: true },
    fundamental_bias: { arah: 'bullish', driver: 'Fed dovish dan inflasi', strong_vs_weak: true }, technical: {}, final_validation: {},
  };
  const shadow = buildAcademyShadow({ setup, events: [event()], decisionMs, slotId: 'slot-a' });
  const source = [{ ...setup, academy_shadow: shadow }];
  const early = applyCompletedEventReactions(source, { 'EURUSD=X': [] }, [event()], Date.parse('2026-10-13T02:00:00Z'));
  assert.equal(early.changed, false);
  assert.equal(early.records[0], source[0]);
  assert.equal(shadow.h1_confirmation.fill, 'next_h1_open');
  assert.equal(shadow.h1_confirmation.min_rr, 2);
  assert.match(shadow.h1_confirmation.config_hash, /^[a-f0-9]{20}$/);
});

test('Ranking cohort memasukkan setup, reject, dan skip tanpa memaksa top-N', () => {
  const fullSetup = {
    symbol: 'EURUSD=X', label: 'EUR/USD', entry_zone: '1', sl: '0.9', tp: '1.2', conflict: 'none', status: 'pending',
    fundamental_bias: { driver: 'Fed dovish dan inflasi' },
    academy_slot_id: 'slot-a',
    academy_shadow: { academy_slot_id: 'slot-a', input_hash: 'a', decision_quality: { comparable: true, fields_present: 6, fields_expected: 6, missing_fields: [] } },
  };
  const reject = {
    symbol: 'GC=F', label: 'XAU/USD', reason: 'data kurang', record_kind: 'aatas_reject', academy_slot_id: 'slot-a',
    fundamental_bias: { driver: 'Fed hawkish' },
    academy_shadow: { academy_slot_id: 'slot-a', input_hash: 'b', decision_quality: { comparable: false, fields_present: 4, fields_expected: 6, missing_fields: ['technical', 'final_validation'] } },
  };
  const skip = { pair: 'frxAUDNZD', label: 'AUD/NZD', reason: 'hard_news', record_kind: 'pre_ai_skip', academy_slot_id: 'slot-a' };
  const ranked = rankAcademyCohort([fullSetup, reject, skip], 'slot-a', ['EUR/USD', 'XAU/USD', 'AUD/NZD']);
  assert.equal(ranked.complete_cohort, true);
  assert.equal(ranked.candidates.length, 3);
  assert.equal(ranked.candidates[0].label, 'EUR/USD');
  assert.equal(ranked.candidates.every(item => item.selected === false), true);
  assert.equal(ranked.top_n_forced, false);
  assert.equal(ranked.experiment_id, 'academy_ranking_v1');
  assert.equal(ranked.candidates.find(item => item.label === 'XAU/USD').source, 'aatas_reject');
  assert.equal(ranked.candidates.find(item => item.label === 'AUD/NZD').missing_reason, 'academy_decision_envelope_missing');
  assert.equal(ranked.candidates.find(item => item.label === 'EUR/USD').driver_overlap_count, 1);
});

test('Refine mempertahankan skenario yang terdaftar lebih awal dan jejak keputusan lama', () => {
  const setup = { symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bullish' };
  const first = buildAcademyShadow({ setup, events: [event({ forecast_raw: 100 })], decisionMs, slotId: 'slot-a' });
  const second = buildAcademyShadow({ setup, events: [event({ forecast_raw: 120 })], decisionMs: decisionMs + 60000, slotId: 'slot-b' });
  const merged = mergeAcademyShadow(first, second);
  assert.equal(merged.academy_slot_id, 'slot-b');
  assert.equal(merged.event_scenarios.length, 1);
  assert.equal(merged.event_scenarios[0].forecast, 100);
  assert.equal(merged.revisions[0].academy_slot_id, 'slot-a');
});
