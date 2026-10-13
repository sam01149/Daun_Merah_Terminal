const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputFromSnapshot, replayRecord, runReplay, summarize } = require('../../scripts/aatas_replay.cjs');
const { _evaluateSetups } = require('../../api/admin');

const base = { id: 'a', symbol: 'EURUSD=X', bias: 'bullish', entry_zone: '100', sl: '90', tp: '120', ts: 0, spread_price_estimate: 1 };
const c = (t, o, h, l, close) => ({ t, o, h, l, c: close });

test('replay baseline: hanya candle setelah keputusan, dua batas satu bar ambigu, dan biaya dihitung satu kali', () => {
  const r = replayRecord(base, [c(0, 100, 121, 89, 100), c(1, 101, 121, 99, 120)], { spreadMultiplier: 1 });
  assert.equal(r.status, 'tp');
  assert.equal(r.filled_t, 1);
  assert.equal(r.net_r, 1.9);
  assert.equal(replayRecord(base, [c(1, 100, 121, 89, 100)]).status, 'ambiguous');
});

test('replay shadow H1 confirmation: memakai close sesudah touch lalu open candle berikutnya, bukan harga retroaktif zona', () => {
  const confirmed = { ...base, tp: '140' };
  const r = replayRecord(confirmed, [c(1, 102, 103, 99, 101), c(2, 101, 105, 100, 104), c(3, 104, 141, 103, 140)], { strategy: 'h1_confirmation', minRr: 2 });
  assert.equal(r.status, 'tp');
  assert.equal(r.touch_t, 1);
  assert.equal(r.filled_t, 3);
  assert.equal(r.entry, 104);
});

test('replay: gap/missing coverage tidak berubah jadi hasil pasti; rerun identik dan metadata hash tersedia', () => {
  assert.equal(replayRecord(base, [c(1, 102, 103, 99, 101), c(7205, 100, 121, 99, 120)]).status, 'unavailable');
  assert.equal(replayRecord({ ...base, ts: 1 }, [c(7205, 100, 121, 99, 120)]).status, 'unavailable');
  assert.equal(replayRecord({ ...base, filled_t: 2 }, [c(1, 100, 121, 99, 120)]).reason, 'missing_recorded_fill_bar');
  const input = { records: [base], candlesBySymbol: { 'EURUSD=X': [c(1, 100, 121, 99, 120)] }, config: { strategy: 'baseline_touch' } };
  assert.deepEqual(runReplay(input), runReplay(input));
  assert.match(runReplay(input).config_hash, /^[a-f0-9]{16}$/);
  assert.equal(
    runReplay({ ...input, config: { strategy: 'baseline_touch', minRr: 2 } }).config_hash,
    runReplay({ ...input, config: { minRr: 2, strategy: 'baseline_touch' } }).config_hash,
    'hash config tidak boleh berubah hanya karena urutan key object',
  );
});

test('replay: snapshot Redis current/archive digabung dengan current menang dan candle H1 dipetakan tanpa fetch', () => {
  const input = inputFromSnapshot({
    'setup_log_auto_archive:v1': [{ ...base, id: 'same', tp: '119' }, { ...base, id: 'archive' }],
    'setup_log_auto:v1': [{ ...base, id: 'same', tp: '120' }],
    'ohlcv:EURUSD=X:1h': [c(1, 100, 121, 99, 120)],
  });
  assert.equal(input.records.length, 2);
  assert.equal(input.records.find(r => r.id === 'same').tp, '120');
  assert.equal(input.candlesBySymbol['EURUSD=X'].length, 1);
});

test('replay: record canceled tidak diubah menjadi outcome replay baru', () => {
  const result = replayRecord({ ...base, status: 'canceled' }, [c(1, 100, 121, 99, 120)]);
  assert.deepEqual(result, {
    id: 'a', status: 'skipped', reason: 'record_canceled', source_status: 'canceled',
    accounting: 'terminal_source_not_counterfactual',
  });
});

test('replay parity: level_set_at, calendar wait dan fresh-touch sama dengan evaluator produksi', () => {
  const start = Date.parse('2026-10-12T00:00:00Z');
  const t = seconds => start / 1000 + seconds;
  const setup = {
    id: 'fresh', symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bullish', entry_zone: '99-100', sl: '90', tp: '120',
    status: 'pending', ts: start, level_set_at: start, entry_wait_until: start + 3600_000,
    entry_execution: 'zone_touch_after_calendar', horizon_days: 3,
  };
  const candles = [
    c(t(3600), 105, 106, 99, 101),
    c(t(7200), 105, 106, 99, 101),
    c(t(10800), 101, 121, 100, 120),
  ];
  const production = structuredClone(setup);
  _evaluateSetups([production], { 'EURUSD=X': candles }, start + 4 * 3600_000, []);
  const replay = replayRecord(setup, candles, { maxGapSeconds: 4000 });
  assert.equal(production.status, 'tp');
  assert.equal(replay.status, production.status);
  assert.equal(replay.filled_t, production.filled_t);
  assert.equal(replay.closed_t, production.closed_t);
  assert.equal(replay.entry, 100, 'fresh touch bullish memakai batas zona yang pertama tersentuh dari atas');
  assert.equal(replay.excursion.quality, 'ohlcv_bound_intrabar_order_unknown');
});

test('replay parity: invalidated-before-fill tidak direkayasa menjadi loss', () => {
  const start = Date.parse('2026-10-12T00:00:00Z');
  const candle = c(start / 1000 + 3600, 89, 101, 88, 95);
  const setup = {
    id: 'invalidated', symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bullish', entry_zone: '99-100', sl: '90', tp: '120',
    status: 'pending', ts: start, level_set_at: start, entry_execution: 'zone_touch_after_calendar', horizon_days: 3,
  };
  const production = structuredClone(setup);
  _evaluateSetups([production], { 'EURUSD=X': [candle] }, start + 2 * 3600_000, []);
  const replay = replayRecord(setup, [candle]);
  assert.equal(production.status, 'canceled');
  assert.equal(replay.status, 'canceled');
  assert.equal(replay.reason, production.canceled_reason);
});

test('replay parity: bearish fresh-touch dan level sebelum revision tidak dipakai', () => {
  const start = Date.parse('2026-10-12T00:00:00Z');
  const t = seconds => start / 1000 + seconds;
  const setup = {
    id: 'bearish', symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish', entry_zone: '100-101', sl: '110', tp: '80',
    status: 'pending', ts: start - 7200_000, level_set_at: start, entry_execution: 'zone_touch_after_calendar', horizon_days: 3,
  };
  const candles = [
    c(t(-3600), 99, 101, 98, 100), // touch sebelum level_set_at: wajib diabaikan
    c(t(3600), 99, 102, 98, 101),  // fresh touch dari bawah
    c(t(7200), 99, 100, 79, 80),
  ];
  const production = structuredClone(setup);
  _evaluateSetups([production], { 'EURUSD=X': candles }, start + 3 * 3600_000, []);
  const replay = replayRecord(setup, candles, { maxGapSeconds: 4000 });
  assert.equal(replay.status, production.status);
  assert.equal(replay.filled_t, production.filled_t);
  assert.equal(replay.closed_t, production.closed_t);
  assert.equal(replay.entry, 100);
});

test('replay: kontrak level yang drift dan posisi open tanpa fill coverage ditandai unavailable', () => {
  const drift = {
    ...base,
    execution_contract: {
      v: 1, anchor_id: 'bullish_sl_1', anchor_price: 91, invalidation_side: 'below', selected_tp_id: 'bullish_tp_1',
    },
    selected_sl_id: 'bullish_sl_1', selected_tp_id: 'bullish_tp_1',
  };
  assert.match(replayRecord(drift, [c(1, 100, 121, 99, 120)]).reason, /^execution_contract_/);
  const open = { ...base, status: 'open', filled_t: 10 };
  assert.equal(replayRecord(open, [c(11, 100, 121, 99, 120)]).reason, 'missing_recorded_fill_bar');
});

test('replay: conflicting duplicate candle, expiry dan horizon arah dilaporkan eksplisit', () => {
  const duplicate = replayRecord(base, [c(1, 101, 110, 99, 105), c(1, 101, 111, 99, 106)]);
  assert.equal(duplicate.reason, 'conflicting_duplicate_candles');

  const old = { ...base, ts: 1000, horizon_days: 2 };
  const expired = replayRecord(old, [c(2, 101, 102, 101, 101)], {
    maxGapSeconds: 10, evaluationAsOfMs: 1000 + 4 * 86400000,
  });
  assert.equal(expired.status, 'expired');

  const horizon = replayRecord({ ...base, spread_price_estimate: undefined }, [
    c(1, 101, 105, 99, 101), c(2, 101, 110, 100, 109), c(3, 109, 121, 108, 120),
  ], { directionHorizonSeconds: 1 });
  assert.equal(horizon.direction_at_horizon.status, 'correct');
  assert.equal(horizon.cost_quality, 'unavailable');
  assert.equal(horizon.gross_r, 2);
  assert.equal(horizon.net_r, null, 'biaya tidak tersedia tidak boleh diasumsikan nol');
});

test('replay summary: cashflow diurutkan closed_t dan PF tanpa loss tetap undefined', () => {
  const out = summarize([
    { status: 'tp', closed_t: 3, net_r: 2 },
    { status: 'sl', closed_t: 1, net_r: -1 },
    { status: 'tp', closed_t: 2, net_r: 2 },
    { status: 'pending' },
  ]);
  assert.equal(out.total_net_r, 3);
  assert.equal(out.closed_cost_known, 3);
  assert.equal(out.closed_cost_unknown, 0);
  assert.equal(out.realized_cashflow_max_drawdown_r, -1);
  assert.equal(out.mean_net_r_per_opportunity, null);
  assert.equal(summarize([{ status: 'tp', closed_t: 1, net_r: 2 }]).profit_factor, null);
  const unknownCost = summarize([{ status: 'tp', closed_t: 1, gross_r: 2, net_r: null }]);
  assert.equal(unknownCost.total_net_r, null);
  assert.equal(unknownCost.closed_cost_unknown, 1);
});
