// test/api/_auto_entry_guard.test.js
// Unit test audit celah "kesalahan trader" auto-entry (2026-07-28) — pure functions
// api/_auto_entry_guard.js. Pola sama test/admin/position_review.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRollingR,
  isDrawdownHalted,
  isRegimeConfidenceBlocked,
  isCorrelatedExposureBlocked,
} = require('../../api/_auto_entry_guard.js');

// ── computeRollingR / isDrawdownHalted (Gate B) ─────────────────────────────

test('computeRollingR: tp pakai rr kalau ada, sl selalu -1', () => {
  const closed = [
    { status: 'tp', rr: 2 },
    { status: 'sl' },
    { status: 'tp' }, // rr tidak ada -> fallback +1
  ];
  assert.equal(computeRollingR(closed), 2 - 1 + 1);
});

test('computeRollingR: cuma pakai window 10 terakhir, entri lebih lama diabaikan', () => {
  const oldLosses = Array.from({ length: 20 }, () => ({ status: 'sl' }));
  // 10 terakhir semua sl -> -10, meski total 20 entri
  assert.equal(computeRollingR(oldLosses), -10);
});

test('computeRollingR: status selain tp/sl (pending/open/canceled) diabaikan', () => {
  const closed = [{ status: 'pending' }, { status: 'open' }, { status: 'canceled' }, { status: 'tp', rr: 1.5 }];
  assert.equal(computeRollingR(closed), 1.5);
});

test('isDrawdownHalted: risk_off ambang paling ketat (-2R)', () => {
  const closed = [{ status: 'sl' }, { status: 'sl' }];
  const r = isDrawdownHalted({ closedSetups: closed, regime: 'risk_off' });
  assert.equal(r.rollingR, -2);
  assert.equal(r.threshold, -2);
  assert.equal(r.halted, true);
});

test('isDrawdownHalted: risk_on ambang paling longgar (-6R), -2R belum halt', () => {
  const closed = [{ status: 'sl' }, { status: 'sl' }];
  const r = isDrawdownHalted({ closedSetups: closed, regime: 'risk_on' });
  assert.equal(r.halted, false);
});

test('isDrawdownHalted: regime null/tak dikenal -> perlakukan seketat neutral (-5R)', () => {
  const closed4loss = Array.from({ length: 4 }, () => ({ status: 'sl' }));
  assert.equal(isDrawdownHalted({ closedSetups: closed4loss, regime: null }).halted, false);
  const closed5loss = Array.from({ length: 5 }, () => ({ status: 'sl' }));
  assert.equal(isDrawdownHalted({ closedSetups: closed5loss, regime: 'regime_aneh' }).halted, true);
});

test('isDrawdownHalted: array kosong -> rollingR 0, tidak pernah halted', () => {
  const r = isDrawdownHalted({ closedSetups: [], regime: 'risk_off' });
  assert.equal(r.rollingR, 0);
  assert.equal(r.halted, false);
});

// ── isRegimeConfidenceBlocked (Gate C) ──────────────────────────────────────

test('isRegimeConfidenceBlocked: confidence rendah + risk_off -> blocked', () => {
  assert.equal(isRegimeConfidenceBlocked({ regime: 'risk_off', confidence: 'rendah' }), true);
});

test('isRegimeConfidenceBlocked: confidence rendah + elevated -> blocked', () => {
  assert.equal(isRegimeConfidenceBlocked({ regime: 'elevated', confidence: 'rendah' }), true);
});

test('isRegimeConfidenceBlocked: confidence rendah + risk_on/neutral -> TIDAK blocked', () => {
  assert.equal(isRegimeConfidenceBlocked({ regime: 'risk_on', confidence: 'rendah' }), false);
  assert.equal(isRegimeConfidenceBlocked({ regime: 'neutral', confidence: 'rendah' }), false);
  assert.equal(isRegimeConfidenceBlocked({ regime: null, confidence: 'rendah' }), false);
});

test('isRegimeConfidenceBlocked: confidence sedang/tinggi TIDAK PERNAH blocked walau risk_off', () => {
  assert.equal(isRegimeConfidenceBlocked({ regime: 'risk_off', confidence: 'sedang' }), false);
  assert.equal(isRegimeConfidenceBlocked({ regime: 'risk_off', confidence: 'tinggi' }), false);
});

// ── isCorrelatedExposureBlocked (Gate D) ────────────────────────────────────

test('isCorrelatedExposureBlocked: GC=F bullish baru, EUR/USD bullish sudah open -> blocked (sama-sama USD lemah)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open }), true);
});

test('isCorrelatedExposureBlocked: GC=F bearish baru, EUR/USD bearish sudah open -> blocked (sama-sama USD kuat)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bearish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bearish', openPositions: open }), true);
});

test('isCorrelatedExposureBlocked: GC=F bullish baru, EUR/USD bearish sudah open -> TIDAK blocked (pandangan USD berlawanan)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bearish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open }), false);
});

test('isCorrelatedExposureBlocked: partner pending (belum open) -> TIDAK blocked', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'pending' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open }), false);
});

test('isCorrelatedExposureBlocked: pair tanpa mapping korelasi (AUD/NZD, EUR/GBP) -> selalu false', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'AUDNZD=X', bias: 'bullish', openPositions: open }), false);
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'EURGBP=X', bias: 'bullish', openPositions: open }), false);
});

test('isCorrelatedExposureBlocked: tidak ada posisi open sama sekali -> false', () => {
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: [] }), false);
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: null }), false);
});

test('isCorrelatedExposureBlocked: EUR/USD baru, GC=F open searah -> simetris (arah cek dari kedua sisi)', () => {
  const open = [{ symbol: 'GC=F', bias: 'bearish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'EURUSD=X', bias: 'bearish', openPositions: open }), true);
});
