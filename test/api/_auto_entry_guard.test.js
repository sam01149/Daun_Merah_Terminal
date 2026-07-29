// test/api/_auto_entry_guard.test.js
// Unit test audit celah "kesalahan trader" auto-entry (2026-07-28) — pure functions
// api/_auto_entry_guard.js. Pola sama test/admin/position_review.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRollingR,
  isDrawdownHalted,
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

test('isDrawdownHalted: risk_off ambang paling ketat (-2R), sampel cukup (>=5)', () => {
  const closed = [{ status: 'tp', rr: 1 }, { status: 'tp', rr: 1 }, { status: 'sl' }, { status: 'sl' }, { status: 'sl' }];
  const r = isDrawdownHalted({ closedSetups: closed, regime: 'risk_off' });
  assert.equal(r.rollingR, -1);
  assert.equal(r.threshold, -2);
  assert.equal(r.halted, false); // -1 > -2, belum ketat cukup
});

test('isDrawdownHalted: risk_on ambang paling longgar (-6R), -2R belum halt', () => {
  const closed = Array.from({ length: 5 }, () => ({ status: 'sl' })); // -5R, sampel cukup
  const r = isDrawdownHalted({ closedSetups: closed, regime: 'risk_on' });
  assert.equal(r.halted, false); // threshold risk_on -6R, -5R belum sekeras itu
});

// [2026-07-28, audit lanjutan] Ambang minimum sampel — tanpa ini, di awal umur sistem
// (rolling window 10 = seluruh riwayat yang ada) 2 SL beruntun saat risk_off bisa
// membekukan semua pair, padahal itu cuma variance dari sampel kecil.
test('isDrawdownHalted: sampel < 5 -> TIDAK PERNAH halted walau rollingR sudah lewat ambang', () => {
  const closed2loss = [{ status: 'sl' }, { status: 'sl' }]; // -2R, persis ambang risk_off
  const r = isDrawdownHalted({ closedSetups: closed2loss, regime: 'risk_off' });
  assert.equal(r.rollingR, -2);
  assert.equal(r.sampleSize, 2);
  assert.equal(r.halted, false); // sampel belum cukup (< DRAWDOWN_MIN_SAMPLE)
});

test('isDrawdownHalted: sampel PERSIS 5 -> ambang minimum terpenuhi, boleh halted', () => {
  const closed5loss = Array.from({ length: 5 }, () => ({ status: 'sl' })); // -5R
  const r = isDrawdownHalted({ closedSetups: closed5loss, regime: 'neutral' });
  assert.equal(r.sampleSize, 5);
  assert.equal(r.halted, true); // -5R <= ambang neutral -5R, sampel cukup
});

// BUG DITEMUKAN & DIFIX (2026-07-29, audit lanjutan): dulu regime null/tak dikenal
// diperlakukan seketat 'neutral' (-5R) — mencampur "regime memang netral" dgn "regime
// tidak diketahui sama sekali" (data hilang, bukan sinyal tenang). Sekarang seketat
// 'risk_off' (-2R, paling konservatif) + `regime_known:false` dilaporkan eksplisit.
test('isDrawdownHalted: regime null/tak dikenal -> KETAT seperti risk_off (-2R), bukan neutral (-5R)', () => {
  // 2 SL murni (rollingR = -2 persis) + 3 entri status lain (diabaikan computeRollingR,
  // cuma buat memenuhi DRAWDOWN_MIN_SAMPLE=5).
  const closed = [
    { status: 'sl' }, { status: 'sl' }, { status: 'pending' }, { status: 'open' }, { status: 'canceled' },
  ];
  const rNull = isDrawdownHalted({ closedSetups: closed, regime: null });
  assert.equal(rNull.rollingR, -2);
  assert.equal(rNull.regime_known, false);
  assert.equal(rNull.threshold, -2, 'threshold utk regime tidak diketahui HARUS -2 (risk_off), bukan -5 (neutral)');
  assert.equal(rNull.halted, true, 'rollingR -2 <= -2 (risk_off) -> halted, walau -2 > -5 (neutral, TIDAK akan halted kalau salah pakai default lama)');

  const rUnknownStr = isDrawdownHalted({ closedSetups: closed, regime: 'regime_aneh' });
  assert.equal(rUnknownStr.regime_known, false);
  assert.equal(rUnknownStr.threshold, -2);

  const rNeutral = isDrawdownHalted({ closedSetups: closed, regime: 'neutral' });
  assert.equal(rNeutral.regime_known, true);
  assert.equal(rNeutral.threshold, -5, 'regime neutral ASLI tetap -5R, tidak ikut berubah');
  assert.equal(rNeutral.halted, false, 'rollingR -2 > -5 (neutral asli) -> belum halted, beda dari kasus regime tidak diketahui di atas');
});

test('isDrawdownHalted: array kosong -> rollingR 0, tidak pernah halted', () => {
  const r = isDrawdownHalted({ closedSetups: [], regime: 'risk_off' });
  assert.equal(r.rollingR, 0);
  assert.equal(r.halted, false);
});

// Gate C (isRegimeConfidenceBlocked) DIHAPUS 2026-07-28 (sesi sama dengan pembuatannya)
// — buta arah (blok confidence rendah saat regime stres tanpa cek align bias vs regime),
// keputusan user. Lihat api/_auto_entry_guard.js.

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
