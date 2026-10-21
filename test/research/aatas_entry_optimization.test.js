'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPERIMENT_ID,
  EXPERIMENT_FORWARD_END_AT,
  EXPERIMENT_HARD_END_AT,
  SPREAD_PRICE_ESTIMATE,
  classifyEnvironment,
  buildEntryOptimizationShadow,
  evaluateEntryOptimizationShadow,
  applyEntryOptimizationShadow,
  mergeEntryOptimizationShadow,
  resample,
} = require('../../api/_aatas_entry_optimization');
const { SPREAD_PRICE_ESTIMATE: PRODUCTION_SPREAD_PRICE_ESTIMATE } = require('../../api/admin');
const { runMatchedEntryOptimizationReplay } = require('../../scripts/aatas_replay.cjs');

function candle(t, o, h, l, c) { return { t, o, h, l, c, v: 0 }; }
function series(n, stepSeconds, start, drift, range = 0.2) {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * drift;
    const c = o + drift * 0.5;
    return candle(1_700_000_000 + i * stepSeconds, o, Math.max(o, c) + range, Math.min(o, c) - range, c);
  });
}

test('classifier: trend aligned hanya ketika Daily, H4, strength, dan struktur searah', () => {
  const h1 = series(420, 3600, 100, 0.01, 0.03);
  const h4 = series(110, 14400, 100, 0.8, 0.05);
  const d1 = series(220, 86400, 100, 1, 0.1);
  const out = classifyEnvironment({
    setup: { bias: 'bullish', technical: { struktur_vs_bias: 'selaras' } },
    candles1h: h1, candles4h: h4, candles1d: d1,
  });
  assert.equal(out.environment, 'trend_aligned');
  assert.equal(out.direction, 'bullish');
  assert.equal(out.strength, 'strong');
  assert.ok(out.reason_codes.includes('daily_ema200_aligned'));
});

test('classifier: histori kurang menjadi unknown, tidak mengarang fallback', () => {
  const out = classifyEnvironment({
    setup: { bias: 'bearish' },
    candles1h: series(20, 3600, 100, 0), candles4h: [], candles1d: [],
  });
  assert.equal(out.environment, 'unknown');
  assert.ok(out.reason_codes.includes('insufficient_trend_history'));
  assert.equal(out.input_coverage.h1_bars, 20);
});

test('builder: range tetap observe-only dan tidak dapat menjadi entry shadow', () => {
  const h1 = Array.from({ length: 250 }, (_, i) => {
    const o = 100 + Math.sin(i / 5);
    return candle(1_700_000_000 + i * 3600, o, o + 0.2, o - 0.2, o + Math.cos(i / 5) * 0.05);
  });
  const shadow = buildEntryOptimizationShadow({
    setup: { label: 'EUR/USD', bias: 'bullish', entry_zone: '99.9-100.1', sl: 99, tp: 103 },
    marketData: { candles1h: h1, candles4h: [], candles1d: [] },
    decisionMs: Date.UTC(2026, 9, 22),
  });
  assert.equal(shadow.experiment_id, EXPERIMENT_ID);
  assert.equal(shadow.environment, 'range');
  assert.equal(shadow.state, 'observe_only');
  assert.equal(shadow.mode, 'shadow_no_entry_effect');
  assert.equal(shadow.collection_window.new_candidate_cutoff_at, EXPERIMENT_FORWARD_END_AT);
});

test('builder: cutoff 30 hari pasar menolak kandidat baru secara otomatis', () => {
  const h1 = series(420, 3600, 100, 0.01, 0.03);
  const h4 = series(110, 14400, 100, 0.8, 0.05);
  const d1 = series(220, 86400, 100, 1, 0.1);
  const shadow = buildEntryOptimizationShadow({
    setup: { label: 'EUR/USD', bias: 'bullish', entry_zone: '99.9-100.1', sl: 99, tp: 103, technical: { struktur_vs_bias: 'selaras' } },
    marketData: { candles1h: h1, candles4h: h4, candles1d: d1 },
    decisionMs: Date.parse(EXPERIMENT_FORWARD_END_AT),
  });
  assert.equal(shadow.state, 'not_eligible');
  assert.equal(shadow.rejection_reason, 'experiment_window_closed');
});

function liveRecord(overrides = {}) {
  return {
    id: 'EURUSD=X:1', symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bullish',
    entry_zone: '100.00-100.05', sl: 99.90, tp: 101.10,
    ts: Date.UTC(2026, 9, 19, 0), level_set_at: Date.UTC(2026, 9, 19, 0), horizon_days: 7,
    status: 'pending',
    entry_optimization_shadow: {
      experiment_id: EXPERIMENT_ID, version: 1, mode: 'shadow_no_entry_effect',
      state: 'waiting_zone', eligible_sessions: ['london', 'overlap', 'ny'],
      environment: 'trend_aligned', direction: 'bullish', strength: 'strong',
      reason_codes: [], input_coverage: {}, cost_estimate: {},
    },
    ...overrides,
  };
}

function lifecycleCandles({ close = 100.175, fill = 100.30, outcome = 'tp', base = Date.UTC(2026, 9, 19, 8) / 1000 } = {}) {
  const history = Array.from({ length: 96 }, (_, i) => candle(base - (96 - i) * 3600, 100.10, 100.15, 100.06, 100.11));
  const trigger = candle(base, 100.10, Math.max(100.20, close), 100.02, close);
  const fillCandle = candle(base + 3600, fill, fill + 0.10, fill - 0.05, fill + 0.02);
  const resolved = outcome === 'tp'
    ? candle(base + 7200, fill, 101.20, fill - 0.02, 101.00)
    : outcome === 'sl'
      ? candle(base + 7200, fill, fill + 0.02, 99.80, 100.00)
      : candle(base + 7200, fill, fill + 0.04, fill - 0.02, fill + 0.01);
  return [...history, trigger, fillCandle, resolved];
}

test('lifecycle bullish: rejection H1, next-open fill, RR, biaya dan TP shadow tercatat', () => {
  const rows = lifecycleCandles();
  const out = evaluateEntryOptimizationShadow(liveRecord(), rows, (rows.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'tp');
  assert.equal(out.raw_outcome, 'tp');
  assert.equal(out.proposed_fill.price, 100.30);
  assert.equal(out.proposed_fill.session, 'london');
  assert.equal(out.effective_rr, 2);
  assert.ok(out.net_r <= 2 && out.net_r > 1.9);
  assert.ok(out.cost_estimate.spread_r > 0);
  assert.equal(out.trigger_metrics.direction_ok, true);
  assert.equal(out.trigger_metrics.wick_ok, true);
});

test('lifecycle: first touch tanpa rejection ditolak dan tidak menunggu touch pilihan berikutnya', () => {
  const rows = lifecycleCandles({ close: 100.04 });
  const out = evaluateEntryOptimizationShadow(liveRecord(), rows, (rows.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'rejected');
  assert.equal(out.rejection_reason, 'first_touch_no_rejection');
  assert.equal(out.proposed_fill, undefined);
});

test('lifecycle: fill yang menurunkan RR di bawah 2 menjadi no_fill', () => {
  const rows = lifecycleCandles({ fill: 100.50 });
  const out = evaluateEntryOptimizationShadow(liveRecord(), rows, (rows.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'no_fill');
  assert.equal(out.no_fill_reason, 'effective_rr_below_2');
});

test('lifecycle: trigger di luar sesi eligible ditolak', () => {
  const rows = lifecycleCandles();
  const out = evaluateEntryOptimizationShadow({
    ...liveRecord(),
    entry_optimization_shadow: { ...liveRecord().entry_optimization_shadow, eligible_sessions: ['tokyo'] },
  }, rows, (rows.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'rejected');
  assert.equal(out.rejection_reason, 'trigger_outside_eligible_session');
});

test('lifecycle bearish adalah cermin bullish dan menghasilkan TP shadow', () => {
  const base = Date.UTC(2026, 9, 19, 8) / 1000;
  const history = Array.from({ length: 96 }, (_, i) => candle(base - (96 - i) * 3600, 99.95, 99.99, 99.90, 99.94));
  const rows = [
    ...history,
    candle(base, 99.95, 100.02, 99.80, 99.875),
    candle(base + 3600, 99.70, 99.75, 99.60, 99.65),
    candle(base + 7200, 99.65, 99.70, 98.80, 99.00),
  ];
  const record = liveRecord({ bias: 'bearish', sl: 100.10, tp: 98.90 });
  record.entry_optimization_shadow.direction = 'bearish';
  const out = evaluateEntryOptimizationShadow(record, rows, (rows.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'tp');
  assert.equal(out.trigger_metrics.direction_ok, true);
  assert.equal(out.effective_rr, 2);
});

test('calendar wait membuang touch lama dan mensyaratkan trigger baru sesudah wait', () => {
  const rows = lifecycleCandles();
  const triggerT = rows.at(-3).t;
  const record = liveRecord({ entry_wait_until: (triggerT + 1800) * 1000 });
  const laterTrigger = rows.map(c => ({ ...c }));
  laterTrigger.push(candle(triggerT + 3 * 3600, 100.10, 100.22, 100.02, 100.20));
  laterTrigger.push(candle(triggerT + 4 * 3600, 100.30, 100.40, 100.20, 100.35));
  laterTrigger.push(candle(triggerT + 5 * 3600, 100.35, 101.20, 100.30, 101.00));
  const out = evaluateEntryOptimizationShadow(record, laterTrigger, (laterTrigger.at(-1).t + 3600) * 1000);
  assert.equal(out.state, 'tp');
  assert.equal(out.trigger_candle.t, triggerT + 3 * 3600);
});

test('candle konflik dan gap intraperiode menjadi unavailable, bukan outcome karangan', () => {
  const rows = lifecycleCandles();
  const conflict = [...rows, { ...rows.at(-3), c: rows.at(-3).c + 0.01 }];
  const outConflict = evaluateEntryOptimizationShadow(liveRecord(), conflict, (rows.at(-1).t + 3600) * 1000);
  assert.equal(outConflict.state, 'unavailable');
  assert.equal(outConflict.rejection_reason, 'conflicting_duplicate_candles');
  const gap = rows.filter((_, i) => i < 91 || i > 92);
  const outGap = evaluateEntryOptimizationShadow(liveRecord(), gap, (rows.at(-1).t + 3600) * 1000);
  assert.equal(outGap.state, 'unavailable');
  assert.equal(outGap.rejection_reason, 'gap_candle_coverage');
});

test('apply shadow tidak memutasi status, fill, SL, TP produksi dan idempotent pada waktu sama', () => {
  const record = liveRecord();
  const before = JSON.parse(JSON.stringify(record));
  const rows = lifecycleCandles();
  const now = (rows.at(-1).t + 3600) * 1000;
  const first = applyEntryOptimizationShadow([record], { 'EURUSD=X': rows }, now);
  assert.deepEqual(record, before);
  assert.equal(first.records[0].status, 'pending');
  assert.equal(first.records[0].sl, 99.90);
  assert.equal(first.records[0].tp, 101.10);
  const second = applyEntryOptimizationShadow(first.records, { 'EURUSD=X': rows }, now);
  assert.equal(second.changed, false);
});

test('outcome terminal tetap immutable ketika candle lama sudah terpotong dari retensi', () => {
  const terminal = liveRecord({
    entry_optimization_shadow: {
      ...liveRecord().entry_optimization_shadow,
      state: 'tp',
      raw_outcome: 'tp',
      net_r: 1.998,
      evaluated_at: '2026-10-20T00:00:00.000Z',
    },
  });
  const out = evaluateEntryOptimizationShadow(terminal, lifecycleCandles().slice(-2), Date.UTC(2026, 10, 20));
  assert.deepEqual(out, terminal.entry_optimization_shadow);
});

test('hard deadline delapan minggu menutup shadow filled yang belum selesai', () => {
  const base = Date.UTC(2026, 11, 2, 8) / 1000;
  const rows = lifecycleCandles({ base, outcome: 'open' });
  const record = liveRecord({
    ts: Date.UTC(2026, 11, 2, 0),
    level_set_at: Date.UTC(2026, 11, 2, 0),
  });
  const out = evaluateEntryOptimizationShadow(record, rows, Date.parse(EXPERIMENT_HARD_END_AT) + 86400000);
  assert.equal(out.state, 'expired');
  assert.equal(out.no_fill_reason, 'experiment_hard_deadline_reached');
  assert.equal(out.evaluated_at, EXPERIMENT_HARD_END_AT);
});

test('estimasi spread shadow sama dengan tabel biaya produksi', () => {
  for (const [pair, spread] of Object.entries(SPREAD_PRICE_ESTIMATE)) {
    assert.equal(spread, PRODUCTION_SPREAD_PRICE_ESTIMATE[pair], pair);
  }
});

test('merge refinement menyimpan revision lama dan mengganti kontrak aktif', () => {
  const prev = { experiment_id: EXPERIMENT_ID, decision_as_of: 'old', input_hash: 'a', environment: 'trend_aligned', state: 'waiting_zone', rejection_reason: null };
  const next = { experiment_id: EXPERIMENT_ID, decision_as_of: 'new', input_hash: 'b', environment: 'transition', state: 'not_eligible', rejection_reason: 'environment_transition' };
  const out = mergeEntryOptimizationShadow(prev, next);
  assert.equal(out.decision_as_of, 'new');
  assert.equal(out.revisions.length, 1);
  assert.equal(out.revisions[0].input_hash, 'a');
});

test('resample menjaga urutan dan tidak mencampur bucket', () => {
  const base = Date.UTC(2026, 9, 19, 0) / 1000;
  const rows = [candle(base, 1, 2, 0, 1.5), candle(base + 3600, 1.5, 3, 1, 2.5), candle(base + 6 * 3600, 2.5, 4, 2, 3.5)];
  const out = resample(rows, 6);
  assert.equal(out.length, 2);
  assert.equal(out[0].h, 3);
  assert.equal(out[1].c, 3.5);
});

test('matched replay memakai opportunity dan candle yang sama serta tidak backfill envelope lama', () => {
  const rows = lifecycleCandles();
  const record = liveRecord();
  const report = runMatchedEntryOptimizationReplay({
    records: [record, { ...record, id: 'legacy', entry_optimization_shadow: undefined }],
    candlesBySymbol: { 'EURUSD=X': rows },
    config: { evaluationAsOfMs: (rows.at(-1).t + 3600) * 1000, requireRecordedBars: false },
  });
  assert.equal(report.experiment_id, EXPERIMENT_ID);
  assert.equal(report.coverage.candidates, 2);
  assert.equal(report.coverage.matched_terminal, 1);
  assert.equal(report.coverage.missing_shadow, 1);
  assert.equal(report.rows[0].baseline.status, 'tp');
  assert.equal(report.rows[0].hybrid.status, 'tp');
});
