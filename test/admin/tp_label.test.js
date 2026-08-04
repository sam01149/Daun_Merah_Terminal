// test/admin/tp_label.test.js — 2026-08-04 ("jurnal end-to-end", rapat user)
// Unit test _detectTpLabel (api/admin.js): mirror _detectLossLabel (ta_struct.test.js)
// tapi untuk transisi open->tp — sebelum ini TP kena tidak punya klasifikasi nuansa
// sama sekali (SL sudah 3 kategori: teknikal/fundamental_shock/fakeout_sl). File
// terpisah dari ta_struct.test.js secara sengaja (menghindari edit bersamaan file itu).
const { test } = require('node:test');
const assert = require('node:assert');
const { _detectTpLabel, _evaluateSetups } = require('../../api/admin.js');

const mkC = (t, o, h, l, c) => ({ t, o, h, l, c, v: 0 });
const T0 = 1000000000; // detik
const MS0 = T0 * 1000;

test('_detectTpLabel: grazed_tp — bearish, harga balik ke zona entry DAN sentuh SL asli dalam 4 jam setelah TP', () => {
  const closedT = T0;
  const candles = [
    mkC(closedT + 3600, 4000, 4038, 3998, 4030), // reentry ke zona [4030,4040]
    mkC(closedT + 7200, 4030, 4070, 4025, 4060), // h 4070 >= sl 4065 -> SL asli tersentuh
  ];
  const label = _detectTpLabel({ closedT, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, candles);
  assert.deepStrictEqual(label, { tp_label: 'grazed_tp', reason: 'harga kembali ke zona entry dan mencapai SL asli dalam 4 jam setelah TP' });
});

test('_detectTpLabel: bullish — mirror arah, grazed_tp juga terdeteksi', () => {
  const closedT = T0;
  const candles = [
    mkC(closedT + 3600, 4100, 4102, 4062, 4070), // reentry ke zona [4050,4070]... l 4062<=4070 & h 4102>=4050 -> overlap
    mkC(closedT + 7200, 4070, 4075, 3995, 4000), // l 3995 <= sl 4000 -> SL asli tersentuh
  ];
  const label = _detectTpLabel({ closedT, eLo: 4050, eHi: 4070, sl: 4000, bias: 'bullish' }, candles);
  assert.strictEqual(label.tp_label, 'grazed_tp');
});

test('_detectTpLabel: hanya reentry TANPA sentuh SL -> tidak dilabel (kriteria ketat, sama seperti fakeout_sl)', () => {
  const closedT = T0;
  const candles = [
    mkC(closedT + 3600, 4000, 4038, 3998, 4035), // reentry zona, tapi tidak naik ke SL
  ];
  assert.strictEqual(_detectTpLabel({ closedT, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, candles), null);
});

test('_detectTpLabel: hanya sentuh SL TANPA reentry zona -> tidak dilabel', () => {
  const closedT = T0;
  const candles = [
    mkC(closedT + 3600, 4070, 4075, 4066, 4068), // langsung ke SL tanpa lewat zona (gap up)
  ];
  assert.strictEqual(_detectTpLabel({ closedT, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, candles), null);
});

test('_detectTpLabel: reentry+SL di luar window 4 jam -> tidak dilabel', () => {
  const closedT = T0;
  const candles = [
    mkC(closedT + 5 * 3600, 4000, 4038, 3998, 4030), // reentry, tapi > 4 jam
    mkC(closedT + 6 * 3600, 4030, 4070, 4025, 4060), // SL tersentuh, tapi juga > 4 jam
  ];
  assert.strictEqual(_detectTpLabel({ closedT, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, candles), null);
});

test('_detectTpLabel: tanpa candle setelah closedT -> tidak dilabel (fail-open)', () => {
  assert.strictEqual(_detectTpLabel({ closedT: T0, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, []), null);
  assert.strictEqual(_detectTpLabel({ closedT: T0, eLo: 4030, eHi: 4040, sl: 4065, bias: 'bearish' }, null), null);
});

// ── Integrasi lewat _evaluateSetups (transisi open->tp menulis tp_label) ─────────

test('_evaluateSetups: transisi open->tp bersih (tanpa reentry+SL) -> tp_label tidak diisi (default/clean, konsisten pola loss_label)', () => {
  const setups = [{ id: 'X:1', symbol: 'GC=F', bias: 'bullish', entry_zone: '4050', tp: '4100', sl: '4000', horizon_days: 5, ts: MS0, status: 'pending' }];
  const candles = { 'GC=F': [
    mkC(T0 + 3600, 4050, 4060, 4040, 4050), // fill
    mkC(T0 + 7200, 4050, 4110, 4040, 4100), // TP kena, bersih (tidak reentry+SL sesudahnya)
  ] };
  _evaluateSetups(setups, candles, MS0 + 3 * 3600 * 1000, [], []);
  assert.strictEqual(setups[0].status, 'tp');
  assert.strictEqual(setups[0].tp_label, undefined);
  assert.strictEqual(setups[0].tp_label_reason, undefined);
});

test('_evaluateSetups: transisi open->tp diikuti reentry+SL dalam 4 jam -> tp_label grazed_tp tersimpan', () => {
  const setups = [{ id: 'X:2', symbol: 'GC=F', bias: 'bullish', entry_zone: '4050', tp: '4100', sl: '4000', horizon_days: 5, ts: MS0, status: 'pending' }];
  const candles = { 'GC=F': [
    mkC(T0 + 3600, 4050, 4060, 4040, 4050),  // fill
    mkC(T0 + 7200, 4050, 4110, 4040, 4100),  // TP kena
    mkC(T0 + 10800, 4100, 4060, 4045, 4050), // reentry zona [4050? single price] -- lihat catatan di bawah
    mkC(T0 + 14400, 4050, 4055, 3990, 3995), // l <= sl 4000 -> SL asli tersentuh
  ] };
  _evaluateSetups(setups, candles, MS0 + 5 * 3600 * 1000, [], []);
  assert.strictEqual(setups[0].status, 'tp');
  assert.strictEqual(setups[0].tp_label, 'grazed_tp');
  assert.strictEqual(setups[0].tp_label_reason, 'harga kembali ke zona entry dan mencapai SL asli dalam 4 jam setelah TP');
});
