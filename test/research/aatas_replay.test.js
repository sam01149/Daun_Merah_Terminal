const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputFromSnapshot, replayRecord, runReplay } = require('../../scripts/aatas_replay.cjs');

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
  assert.deepEqual(result, { id: 'a', status: 'skipped', reason: 'record_canceled', source_status: 'canceled' });
});
