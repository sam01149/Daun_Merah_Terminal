// test/api/_auto_entry_guard.test.js
// Unit test audit celah "kesalahan trader" auto-entry (2026-07-28) — pure functions
// api/_auto_entry_guard.js. Pola sama test/admin/position_review.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRollingR,
  isDrawdownHalted,
  isCorrelatedExposureBlocked,
  isTimingConflictBlocked,
  isInvalidationTriggered,
  EXPOSURE_BINDING_STATUSES,
  POLICY_EPOCHS,
  POLICY_VERSION,
  policyVersionForTs,
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

// PERILAKU SENGAJA DIUBAH 2026-08-18 (audit menyeluruh, disetujui user — riset.md
// folder professional_llm_trader §Audit menyeluruh 2026-08-18 poin A1). Test ini DULU
// menegaskan "partner pending -> TIDAK blocked"; itu justru celahnya: semua entry
// sistem ini limit order, jadi 'pending' adalah state yang paling lama dihuni dan dua
// setup korelatif bisa terisi bersamaan tanpa cap pernah menyala. Ekspektasi dibalik,
// BUKAN dihapus — supaya kalau suatu saat perilaku ini balik lagi ke lama, ketahuan
// sebagai perubahan sadar, bukan regresi diam-diam.
test('isCorrelatedExposureBlocked: partner pending searah -> BLOCKED (dulu tidak, diubah 2026-08-18)', () => {
  const positions = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'pending' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: positions }), true);
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

// CHF/JPY ditambah 2026-08-08 — korelasi r=0,373 ke EUR/USD, TANPA kaki USD sama
// sekali (jadi model "USD view" lama tidak bisa dipakai, dicek langsung via bias).
test('isCorrelatedExposureBlocked: CHF/JPY bullish baru, EUR/USD bullish sudah open -> blocked (korelasi positif r=0,373)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'CHFJPY=X', bias: 'bullish', openPositions: open }), true);
});

test('isCorrelatedExposureBlocked: CHF/JPY bearish baru, EUR/USD bullish sudah open -> TIDAK blocked (arah berlawanan)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'CHFJPY=X', bias: 'bearish', openPositions: open }), false);
});

test('isCorrelatedExposureBlocked: EUR/USD baru, CHF/JPY open searah -> simetris', () => {
  const open = [{ symbol: 'CHFJPY=X', bias: 'bearish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'EURUSD=X', bias: 'bearish', openPositions: open }), true);
});

test('isCorrelatedExposureBlocked: CHF/JPY tidak punya mapping korelasi ke GC=F -> false (cuma dicap ke EUR/USD)', () => {
  const open = [{ symbol: 'GC=F', bias: 'bullish', status: 'open' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'CHFJPY=X', bias: 'bullish', openPositions: open }), false);
});

test('isCorrelatedExposureBlocked: EUR/USD baru dengan GC=F DAN CHF/JPY open searah sekaligus -> blocked oleh salah satu partner', () => {
  const open = [
    { symbol: 'GC=F', bias: 'bearish', status: 'open' },
    { symbol: 'CHFJPY=X', bias: 'bullish', status: 'open' }, // arah beda, tidak trigger sendirian
  ];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'EURUSD=X', bias: 'bearish', openPositions: open }), true);
});

// ── isCorrelatedExposureBlocked: liveSign override (audit 2026-08-16) ───────
test('isCorrelatedExposureBlocked: liveSign flip ke negative -> arah blocking terbalik dari tabel statis', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  // Statis: GC=F|EURUSD=X positive -> bias sama = blocked. Live bilang sudah negative
  // (regime berubah) -> sekarang bias sama justru TIDAK blocked, bias BERLAWANAN yang blocked.
  const liveSign = { 'GC=F|EURUSD=X': 'negative' };
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open, liveSign }), false);
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bearish', openPositions: open, liveSign }), true);
});

test('isCorrelatedExposureBlocked: liveSign tidak punya entry untuk pasangan ini -> fallback ke sign statis', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  const liveSign = { 'AUDUSD=X|NZDUSD=X': 'positive' }; // pasangan lain, tidak relevan
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open, liveSign }), true);
});

test('isCorrelatedExposureBlocked: liveSign null/undefined -> perilaku identik tanpa param (backward compatible)', () => {
  const open = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'open' }];
  assert.equal(
    isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open }),
    isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: open, liveSign: null }),
  );
});

// ── isTimingConflictBlocked (Gate E, audit S277 2026-08-04) ─────────────────

test('isTimingConflictBlocked: conflict "waktu" -> blocked', () => {
  assert.equal(isTimingConflictBlocked('waktu'), true);
});

test('isTimingConflictBlocked: conflict "arah"/"none"/null/undefined -> tidak blocked', () => {
  assert.equal(isTimingConflictBlocked('arah'), false);
  assert.equal(isTimingConflictBlocked('none'), false);
  assert.equal(isTimingConflictBlocked(null), false);
  assert.equal(isTimingConflictBlocked(undefined), false);
});

// ── isInvalidationTriggered (Track 1, Road to Professional LLM Trader, 2026-08-04) ──

const mkC = (i, o, h, l, c) => ({ t: i * 3600, o, h, l, c, v: 0 });

test('isInvalidationTriggered: direction "below" — close balik di bawah level -> triggered', () => {
  const trig = { type: 'ma_break', level: 4000, timeframe: '1h', direction: 'below' };
  const candles = [mkC(1, 4010, 4015, 4005, 4008), mkC(2, 4008, 4009, 3990, 3995)];
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 0, boundaryMs: Infinity });
  assert.equal(r.triggered, true);
  assert.equal(r.at, 2 * 3600);
});

test('isInvalidationTriggered: direction "above" — close balik di atas level -> triggered', () => {
  const trig = { type: 'price_level', level: 4000, timeframe: '1h', direction: 'above' };
  const candles = [mkC(1, 3990, 3995, 3985, 3992), mkC(2, 3992, 4010, 3991, 4005)];
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 0, boundaryMs: Infinity });
  assert.equal(r.triggered, true);
  assert.equal(r.at, 2 * 3600);
});

test('isInvalidationTriggered: level tidak pernah tersentuh -> triggered false, bukan crash', () => {
  const trig = { type: 'swing_break', level: 3800, timeframe: '1h', direction: 'below' };
  const candles = [mkC(1, 4010, 4015, 4005, 4008), mkC(2, 4008, 4009, 3990, 3995)];
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 0, boundaryMs: Infinity });
  assert.equal(r.triggered, false);
});

test('isInvalidationTriggered: candle sebelum startMs (mis. sebelum ts setup) diabaikan', () => {
  const trig = { type: 'ma_break', level: 4000, timeframe: '1h', direction: 'below' };
  const candles = [mkC(1, 4010, 4015, 4005, 3995)]; // close di bawah level, TAPI sebelum startMs
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 1 * 3600 * 1000, boundaryMs: Infinity });
  assert.equal(r.triggered, false);
});

// Prioritas TP/SL asli (diskusi user) — invalidasi hanya dihitung untuk candle SEBELUM
// boundaryMs (closed_t asli). Candle yang menyentuh level SAMA/SETELAH boundary diabaikan.
test('isInvalidationTriggered: boundaryMs (closed_t TP/SL asli) membatasi — candle setelah/sama boundary diabaikan', () => {
  const trig = { type: 'ma_break', level: 4000, timeframe: '1h', direction: 'below' };
  const candles = [mkC(2, 4008, 4009, 3990, 3995)]; // t = 2*3600, close di bawah level
  const boundaryMs = 2 * 3600 * 1000; // TP/SL asli tersentuh PERSIS di candle yang sama
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 0, boundaryMs });
  assert.equal(r.triggered, false, 'TP/SL asli menang kalau tersentuh di candle sama/lebih dulu');
});

test('isInvalidationTriggered: candle invalidasi LEBIH AWAL dari boundaryMs -> tetap triggered (invalidasi menang)', () => {
  const trig = { type: 'ma_break', level: 4000, timeframe: '1h', direction: 'below' };
  const candles = [mkC(1, 4008, 4009, 3990, 3995), mkC(3, 3995, 3998, 3900, 3910)];
  const boundaryMs = 3 * 3600 * 1000; // TP/SL asli baru tersentuh di candle ke-3
  const r = isInvalidationTriggered({ invalidation_trigger: trig, candles, startMs: 0, boundaryMs });
  assert.equal(r.triggered, true);
  assert.equal(r.at, 1 * 3600);
});

test('isInvalidationTriggered: invalidation_trigger null/tipe tak dikenal/level bukan angka -> null (fail-open)', () => {
  const candles = [mkC(1, 4010, 4015, 4005, 3995)];
  assert.equal(isInvalidationTriggered({ invalidation_trigger: null, candles, startMs: 0 }), null);
  assert.equal(isInvalidationTriggered({ invalidation_trigger: { type: 'aneh', level: 4000, direction: 'below' }, candles, startMs: 0 }), null);
  assert.equal(isInvalidationTriggered({ invalidation_trigger: { type: 'ma_break', level: 'bukan-angka', direction: 'below' }, candles, startMs: 0 }), null);
  assert.equal(isInvalidationTriggered({ invalidation_trigger: { type: 'ma_break', level: 4000, direction: 'sideways' }, candles, startMs: 0 }), null);
});

test('isInvalidationTriggered: candles kosong/bukan array -> triggered false, bukan crash', () => {
  const trig = { type: 'ma_break', level: 4000, direction: 'below' };
  assert.equal(isInvalidationTriggered({ invalidation_trigger: trig, candles: [], startMs: 0 }).triggered, false);
  assert.equal(isInvalidationTriggered({ invalidation_trigger: trig, candles: null, startMs: 0 }).triggered, false);
});

// ── Gate D: pending ikut mengikat exposure (2026-08-18, audit menyeluruh) ───────

test('isCorrelatedExposureBlocked: partner PENDING searah ikut memblokir (bukan cuma open)', () => {
  const positions = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'pending' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', positions }), true);
});

test('isCorrelatedExposureBlocked: partner pending BERLAWANAN arah tetap lolos (sign positive)', () => {
  const positions = [{ symbol: 'EURUSD=X', bias: 'bearish', status: 'pending' }];
  assert.equal(isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', positions }), false);
});

test('isCorrelatedExposureBlocked: status yang TIDAK mengikat exposure diabaikan (canceled/tp/sl/expired)', () => {
  for (const status of ['canceled', 'tp', 'sl', 'expired', 'stale', 'invalid', 'ambiguous']) {
    const positions = [{ symbol: 'EURUSD=X', bias: 'bullish', status }];
    assert.equal(
      isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', positions }),
      false,
      `status ${status} seharusnya tidak mengikat exposure`,
    );
  }
});

test('isCorrelatedExposureBlocked: nama parameter lama `openPositions` tetap diterima (backward-compatible)', () => {
  const list = [{ symbol: 'EURUSD=X', bias: 'bullish', status: 'pending' }];
  assert.equal(
    isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', openPositions: list }),
    isCorrelatedExposureBlocked({ symbol: 'GC=F', bias: 'bullish', positions: list }),
  );
});

test('EXPOSURE_BINDING_STATUSES: tepat open + pending, tidak lebih', () => {
  assert.deepEqual([...EXPOSURE_BINDING_STATUSES].sort(), ['open', 'pending']);
});

// ── Stempel versi kebijakan (POLICY_EPOCHS / policyVersionForTs) ────────────────

test('POLICY_EPOCHS: urut naik, tanggal valid & monoton, tiap epoch punya label+impact', () => {
  const IMPACTS = new Set(['baseline', 'entry', 'pair_set', 'levels', 'exit', 'context', 'eval']);
  const KINDS = new Set(['policy', 'fix', 'mixed']);
  let prevV = 0, prevMs = -Infinity;
  for (const e of POLICY_EPOCHS) {
    assert.equal(e.v, prevV + 1, `versi harus berurutan tanpa lompat (ketemu v=${e.v} setelah ${prevV})`);
    const ms = Date.parse(e.from);
    assert.ok(Number.isFinite(ms), `tanggal epoch v${e.v} tidak valid: ${e.from}`);
    assert.ok(ms >= prevMs, `tanggal epoch v${e.v} mundur dari versi sebelumnya`);
    assert.ok(e.label && e.label.length > 10, `epoch v${e.v} wajib punya label deskriptif`);
    assert.ok(IMPACTS.has(e.impact), `impact epoch v${e.v} tidak dikenal: ${e.impact}`);
    assert.ok(KINDS.has(e.kind), `kind epoch v${e.v} tidak dikenal: ${e.kind} (wajib policy/fix/mixed)`);
    prevV = e.v; prevMs = ms;
  }
});

test('POLICY_VERSION: selalu sama dengan versi epoch terakhir', () => {
  assert.equal(POLICY_VERSION, POLICY_EPOCHS[POLICY_EPOCHS.length - 1].v);
});

test('policyVersionForTs: memetakan ts ke epoch yang berlaku saat itu', () => {
  const v1 = POLICY_EPOCHS[0];
  // tepat di batas epoch -> epoch itu sendiri (bukan sebelumnya)
  assert.equal(policyVersionForTs(Date.parse(v1.from)), v1.v);
  // satu milidetik sebelum epoch pertama -> null, jangan mengarang versi
  assert.equal(policyVersionForTs(Date.parse(v1.from) - 1), null);
  // jauh setelah epoch terakhir -> versi terakhir
  assert.equal(policyVersionForTs(Date.parse('2099-01-01T00:00:00Z')), POLICY_VERSION);
  // di antara dua epoch -> epoch yang lebih tua
  const a = POLICY_EPOCHS[3], b = POLICY_EPOCHS[4];
  const mid = Math.floor((Date.parse(a.from) + Date.parse(b.from)) / 2);
  assert.equal(policyVersionForTs(mid), a.v);
});

test('policyVersionForTs: input tidak valid -> null (fail-open, bukan crash)', () => {
  assert.equal(policyVersionForTs(null), null);
  assert.equal(policyVersionForTs(undefined), null);
  assert.equal(policyVersionForTs('bukan-angka'), null);
  assert.equal(policyVersionForTs(NaN), null);
});
