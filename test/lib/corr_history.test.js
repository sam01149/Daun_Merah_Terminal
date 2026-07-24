// test/lib/corr_history.test.js
// Plan I Fase 2 (2026-07-24): mergeCorrHistory (api/correlations.js) — snapshot r20
// harian yang jadi sumber data sparkline drift korelasi di tab TEK.
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeCorrHistory } = require('../../api/correlations');

test('mergeCorrHistory: histori kosong -> titik pertama untuk semua pair', () => {
  const out = mergeCorrHistory({ dates: [], series: {} }, '2026-07-20', { 'A|B': 0.5, 'A|C': -0.2 }, 10);
  assert.deepStrictEqual(out.dates, ['2026-07-20']);
  assert.deepStrictEqual(out.series, { 'A|B': [0.5], 'A|C': [-0.2] });
});

test('mergeCorrHistory: hari baru -> append, pair lama tanpa data hari ini diisi null', () => {
  const prev = { dates: ['2026-07-20'], series: { 'A|B': [0.5], 'A|C': [-0.2] } };
  const out = mergeCorrHistory(prev, '2026-07-21', { 'A|B': 0.6 }, 10); // A|C gagal fetch hari ini
  assert.deepStrictEqual(out.dates, ['2026-07-20', '2026-07-21']);
  assert.deepStrictEqual(out.series['A|B'], [0.5, 0.6]);
  assert.deepStrictEqual(out.series['A|C'], [-0.2, null]);
});

test('mergeCorrHistory: pair baru muncul di tengah histori -> dipadding null sebelum titik pertamanya', () => {
  const prev = { dates: ['2026-07-20', '2026-07-21'], series: { 'A|B': [0.5, 0.6] } };
  const out = mergeCorrHistory(prev, '2026-07-22', { 'A|B': 0.4, 'D|E': 0.9 }, 10);
  assert.deepStrictEqual(out.series['A|B'], [0.5, 0.6, 0.4]);
  assert.deepStrictEqual(out.series['D|E'], [null, null, 0.9]);
});

test('mergeCorrHistory: tanggal sama dengan entri terakhir -> overwrite slot, bukan titik baru', () => {
  const prev = { dates: ['2026-07-20', '2026-07-21'], series: { 'A|B': [0.5, 0.6] } };
  const out = mergeCorrHistory(prev, '2026-07-21', { 'A|B': 0.65 }, 10);
  assert.deepStrictEqual(out.dates, ['2026-07-20', '2026-07-21']);
  assert.deepStrictEqual(out.series['A|B'], [0.5, 0.65]);
});

test('mergeCorrHistory: cap maxPoints -> buang titik tertua, semua seri tetap sejajar', () => {
  const prev = { dates: ['d1', 'd2', 'd3'], series: { 'A|B': [1, 2, 3], 'A|C': [null, 5, 6] } };
  const out = mergeCorrHistory(prev, 'd4', { 'A|B': 4, 'A|C': 7 }, 3);
  assert.deepStrictEqual(out.dates, ['d2', 'd3', 'd4']);
  assert.deepStrictEqual(out.series['A|B'], [2, 3, 4]);
  assert.deepStrictEqual(out.series['A|C'], [5, 6, 7]);
});
