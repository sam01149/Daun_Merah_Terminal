// test/ta_struct.test.js
// Unit test helper struktur teknikal untuk AI Analisa (api/admin.js):
// swing keep-N, klasifikasi struktur HH/HL, cluster S/R, fibonacci, pivot harian,
// prev-week H/L, deteksi pola candle, RSI-14, dan rendering buildOhlcvText.
const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const {
  _findSwings, _classifyStructure, _clusterSrLevels, _fibLevels,
  _dailyPivots, _prevWeekHighLow, _detectCandlePatterns, _rsi14, buildOhlcvText,
} = require('../api/admin.js');

const DAY = 86400;
// Candle sintetis: o=c=(h+l)/2 kecuali dioverride
const mk = (h, l, i, extra = {}) => ({ t: i * DAY, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 0, ...extra });

// Deret zigzag 20 candle: pivot high ~110 di i=2,7,12,17; pivot low 85 di i=4,9,15
const zigzagHighs = [95, 100, 110, 100, 95, 95.2, 100, 110.2, 100, 95, 95.1, 100, 109.9, 100, 95, 95, 100, 110.1, 100, 95];
const zigzag = zigzagHighs.map((h, i) => mk(h, h - 10, i));

// ── _findSwings keep param ───────────────────────────────────────────────────

test('_findSwings: keep=4 mengembalikan hingga 4 swing, keep=2 tetap 2 (backward compat)', () => {
  const s4 = _findSwings(zigzag, 2, 4);
  assert.strictEqual(s4.swing_highs.length, 4);
  assert.deepStrictEqual(s4.swing_highs.map(s => s.price), [110, 110.2, 109.9, 110.1]);
  const s2 = _findSwings(zigzag, 2); // default keep=2
  assert.strictEqual(s2.swing_highs.length, 2);
  assert.deepStrictEqual(s2.swing_highs.map(s => s.price), [109.9, 110.1]);
  assert.strictEqual(s2.last_swing_high.price, 110.1);
});

// ── _classifyStructure ───────────────────────────────────────────────────────

test('_classifyStructure: HH+HL = bullish, LH+LL = bearish, campuran = mixed', () => {
  const b = _classifyStructure([{ price: 100 }, { price: 105 }], [{ price: 95 }, { price: 98 }], 104, 2);
  assert.match(b.label, /Bullish \(HH \+ HL\)/);
  assert.strictEqual(b.bos, null); // 104 belum menembus 105

  const be = _classifyStructure([{ price: 105 }, { price: 102 }], [{ price: 98 }, { price: 95 }], 96, 2);
  assert.match(be.label, /Bearish \(LH \+ LL\)/);

  const m = _classifyStructure([{ price: 100 }, { price: 105 }], [{ price: 98 }, { price: 95 }], 100, 2);
  assert.match(m.label, /Mixed/);
});

test('_classifyStructure: BOS terdeteksi saat close menembus swing terakhir', () => {
  const up = _classifyStructure([{ price: 100 }, { price: 105 }], [{ price: 95 }, { price: 98 }], 106, 2);
  assert.match(up.bos, /break of structure bullish/);
  assert.match(up.bos, /105\.00/);
  const dn = _classifyStructure([{ price: 105 }, { price: 102 }], [{ price: 98 }, { price: 95 }], 94, 2);
  assert.match(dn.bos, /break of structure bearish/);
});

test('_classifyStructure: null kalau swing kurang dari 2', () => {
  assert.strictEqual(_classifyStructure([{ price: 100 }], [{ price: 95 }, { price: 98 }], 100, 2), null);
  assert.strictEqual(_classifyStructure(null, [], 100, 2), null);
});

// ── _clusterSrLevels ─────────────────────────────────────────────────────────

test('_clusterSrLevels: pivot berdekatan digabung jadi satu cluster dengan hitungan sentuhan', () => {
  const sr = _clusterSrLevels(zigzag, null, 100, 1, 2);
  assert.ok(sr, 'harus mengembalikan cluster');
  // 4 pivot high 109.9–110.2 (jarak ≤ tol 1) → SATU cluster resistance ~110
  assert.strictEqual(sr.above.length, 1);
  assert.ok(Math.abs(sr.above[0].price - 110.05) < 0.2, `center ~110.05, dapat ${sr.above[0].price}`);
  assert.ok(sr.above[0].touches >= 4, `touches >= 4, dapat ${sr.above[0].touches}`);
  // pivot low 85 → satu cluster support, semua di bawah now
  assert.ok(sr.below.length >= 1);
  for (const l of sr.below) assert.ok(l.price < 100);
  for (const l of sr.above) assert.ok(l.price >= 100);
});

test('_clusterSrLevels: cluster terdekat ke harga selalu ikut walau sentuhannya sedikit', () => {
  // 3 zona jauh dengan banyak sentuhan (110/115/120) + 1 zona dekat lemah (101);
  // top-3 by sentuhan akan memilih zona jauh semua — 101 harus tetap masuk.
  const peaks = [120, 120.2, 119.8, 115, 115.1, 114.9, 110, 110.2, 109.9, 101];
  const candles = [];
  peaks.forEach(pk => {
    for (const h of [95, 98, pk, 98, 95]) candles.push(mk(h, h - 10, candles.length));
  });
  const sr = _clusterSrLevels(candles, null, 100, 1, 2);
  assert.ok(sr && sr.above.length === 3, `3 resistance, dapat ${sr?.above?.length}`);
  assert.ok(sr.above.some(l => Math.abs(l.price - 101) < 1), `zona terdekat ~101 harus ikut: ${JSON.stringify(sr.above)}`);
});

test('_clusterSrLevels: null saat data kurang / tolerance tidak valid', () => {
  assert.strictEqual(_clusterSrLevels(zigzag.slice(0, 5), null, 100, 1, 2), null);
  assert.strictEqual(_clusterSrLevels(zigzag, null, 100, 0, 2), null);
  assert.strictEqual(_clusterSrLevels(null, null, 100, 1, 2), null);
});

// ── _fibLevels ───────────────────────────────────────────────────────────────

test('_fibLevels: leg naik (low duluan) → retracement di bawah high', () => {
  const c = [];
  for (let i = 0; i < 12; i++) c.push(mk(100 + i * 0.5, 99 + i * 0.5, i));
  c[1] = mk(91, 90, 1);   // low ekstrem duluan
  c[8] = mk(110, 109, 8); // high ekstrem belakangan
  const fib = _fibLevels(c, 2);
  assert.strictEqual(fib.direction, 'naik');
  assert.strictEqual(fib.swing_low, 90);
  assert.strictEqual(fib.swing_high, 110);
  assert.strictEqual(fib.f382, +(110 - 0.382 * 20).toFixed(2)); // 102.36
  assert.strictEqual(fib.f500, 100);
  assert.strictEqual(fib.f618, +(110 - 0.618 * 20).toFixed(2)); // 97.64
});

test('_fibLevels: leg turun (high duluan) → retracement di atas low', () => {
  const c = [];
  for (let i = 0; i < 12; i++) c.push(mk(110 - i, 109 - i, i));
  c[1] = mk(120, 119, 1); // high duluan
  c[9] = mk(96, 95, 9);   // low belakangan
  const fib = _fibLevels(c, 2);
  assert.strictEqual(fib.direction, 'turun');
  assert.strictEqual(fib.f500, +(95 + 0.5 * 25).toFixed(2)); // 107.5
  assert.ok(fib.f382 < fib.f500 && fib.f500 < fib.f618);
});

test('_fibLevels: null saat data kurang', () => {
  assert.strictEqual(_fibLevels([], 2), null);
  assert.strictEqual(_fibLevels(zigzag.slice(0, 5), 2), null);
});

// ── _dailyPivots ─────────────────────────────────────────────────────────────

test('_dailyPivots: rumus pivot klasik', () => {
  const p = _dailyPivots({ h: 110, l: 90, c: 100 }, 2);
  assert.deepStrictEqual(p, { p: 100, r1: 110, s1: 90, r2: 120, s2: 80 });
});

test('_dailyPivots: null untuk input tidak valid', () => {
  assert.strictEqual(_dailyPivots(null, 2), null);
  assert.strictEqual(_dailyPivots({ h: 110, l: NaN, c: 100 }, 2), null);
});

// ── _prevWeekHighLow ─────────────────────────────────────────────────────────

test('_prevWeekHighLow: ambil H/L minggu kalender sebelumnya (Senin-start)', () => {
  // weekIdx = floor((day+3)/7): day 4-10 = minggu 1, day 11-17 = minggu 2
  const candles = [];
  for (let d = 4; d <= 12; d++) candles.push(mk(100, 99, d));
  candles[2] = mk(115, 99, 6);  // day 6 (minggu 1) — high minggu lalu
  candles[4] = mk(100, 88, 8);  // day 8 (minggu 1) — low minggu lalu
  const pw = _prevWeekHighLow(candles, 2); // candle terakhir day 12 → minggu 2, prev = minggu 1
  assert.deepStrictEqual(pw, { high: 115, low: 88 });
});

test('_prevWeekHighLow: null kalau tidak ada bar minggu sebelumnya', () => {
  const sameWeek = [4, 5, 6, 7, 8, 9, 10].map(d => mk(100, 99, d)); // semua minggu 1
  assert.strictEqual(_prevWeekHighLow(sameWeek, 2), null);
});

// ── _detectCandlePatterns ────────────────────────────────────────────────────

test('_detectCandlePatterns: bullish engulfing terdeteksi', () => {
  const c = [
    { t: 0, o: 100, h: 101, l: 94.5, c: 95 },      // bearish
    { t: DAY, o: 94.5, h: 101.5, l: 94, c: 101 },   // bullish menelan body sebelumnya
  ];
  const pats = _detectCandlePatterns(c, 2, 2);
  assert.ok(pats.some(p => p.label === 'Bullish Engulfing'), JSON.stringify(pats));
  assert.strictEqual(pats[pats.length - 1].running, true); // candle terakhir ditandai berjalan
});

test('_detectCandlePatterns: pin bar bawah (hammer)', () => {
  const c = [
    { t: 0, o: 100, h: 101, l: 99, c: 100.2 },
    { t: DAY, o: 100, h: 100.7, l: 97, c: 100.5 }, // lower wick 3 >= 2x body 0.5, upper 0.2
  ];
  const pats = _detectCandlePatterns(c, 1, 2);
  assert.ok(pats.some(p => /Pin Bar bawah/.test(p.label)), JSON.stringify(pats));
});

test('_detectCandlePatterns: inside bar + doji', () => {
  const c = [
    { t: 0, o: 98, h: 105, l: 95, c: 102 },
    { t: DAY, o: 100, h: 101, l: 99, c: 100.05 }, // di dalam range prev + body 0.05 <= 10% range 2
  ];
  const pats = _detectCandlePatterns(c, 1, 2);
  assert.ok(pats.some(p => p.label === 'Inside Bar'), JSON.stringify(pats));
  assert.ok(pats.some(p => p.label === 'Doji'), JSON.stringify(pats));
});

test('_detectCandlePatterns: tidak crash untuk data kosong / candle flat', () => {
  assert.deepStrictEqual(_detectCandlePatterns([], 3, 2), []);
  assert.deepStrictEqual(_detectCandlePatterns([{ t: 0, o: 1, h: 1, l: 1, c: 1 }, { t: DAY, o: 1, h: 1, l: 1, c: 1 }], 2, 2), []);
});

// ── _rsi14 ───────────────────────────────────────────────────────────────────

test('_rsi14: naik terus → 100, turun terus → 0, data kurang → null', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const dn = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.strictEqual(_rsi14(up), 100);
  assert.ok(_rsi14(dn) < 0.001);
  assert.strictEqual(_rsi14(up.slice(0, 14)), null);
});

test('_rsi14: seri campuran menghasilkan nilai 0-100', () => {
  const mixed = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const v = _rsi14(mixed);
  assert.ok(v > 0 && v < 100, `RSI ${v}`);
});

// ── buildOhlcvText ───────────────────────────────────────────────────────────

function fullData() {
  return {
    label: 'EUR/USD', dec: 5, is_xau: false,
    d1: { available: true, high: 1.18, low: 1.15, current: 1.17, change_pct: 1.2, trend: 'Uptrend', resistance: [1.18, 1.179], support: [1.15, 1.151], vol: null },
    h4: {
      available: true, high: 1.178, low: 1.16, current: 1.17, change_pct: 0.5, trend: 'Uptrend',
      swing_high: { price: 1.178, t: 100 * DAY }, swing_low: { price: 1.16, t: 99 * DAY },
      swing_highs: [{ price: 1.175, t: 98 * DAY }, { price: 1.178, t: 100 * DAY }],
      swing_lows: [{ price: 1.158, t: 97 * DAY }, { price: 1.16, t: 99 * DAY }],
      candles12: [{ t: 100 * DAY, o: 1.169, h: 1.171, l: 1.168, c: 1.17, v: 0 }],
    },
    h1: { available: true, high: 1.172, low: 1.165, current: 1.17, change_pct: 0.1, trend: 'Sideways', candles24: [{ t: 100 * DAY, o: 1.1695, h: 1.1701, l: 1.169, c: 1.17, v: 0 }], vol_avg: 0 },
    indicators: { available: true, rsi_14: 55, rsi_label: 'Bullish', sma_50: 1.16, sma_200: 1.14, vs_sma50: 'above', vs_sma200: 'above' },
    macd: { available: true, macd: 0.001, signal: 0.0005, histogram: 0.0005, status: 'Bullish' },
    atr: { available: true, atr_h1: 0.0012, atr_pips: 12 },
    d1_ext: { available: true, high_6m: 1.19, low_6m: 1.08, pos_pct: 82, chg_6m_pct: 5.5, dist_high_pct: -1.68, atr_d: 0.008, bars: 130 },
    structure: { available: true, label: 'Bullish (HH + HL)', detail: 'swing high 1.17500 → 1.17800, swing low 1.15800 → 1.16000', bos: null },
    sr_levels: { available: true, above: [{ price: 1.178, touches: 5 }], below: [{ price: 1.16, touches: 7 }] },
    fib: { available: true, direction: 'naik', swing_low: 1.16, swing_high: 1.178, f382: 1.17112, f500: 1.169, f618: 1.16688 },
    ref_levels: { available: true, pivots: { p: 1.169, r1: 1.172, s1: 1.166, r2: 1.175, s2: 1.163 }, prev_day: { high: 1.171, low: 1.166, close: 1.17 }, prev_week: { high: 1.176, low: 1.158 } },
    patterns: { available: true, h4: [{ t: 100 * DAY, label: 'Bullish Engulfing', close: 1.17, running: true }], d1: [] },
    rsi_h4: { available: true, value: 58.2, direction: 'naik' },
  };
}

test('buildOhlcvText: semua blok struktur baru dirender', () => {
  const txt = buildOhlcvText(fullData());
  for (const marker of [
    '[KONTEKS 6 BULAN — Daily 130 bar]', 'Posisi now: 82% dari range',
    '[STRUKTUR H4] Bullish (HH + HL)',
    '[LEVEL S/R', 'Resistance (di atas Now): 1.17800 (5x sentuh)', 'Support (di bawah Now): 1.16000 (7x sentuh)',
    '[FIBONACCI leg 4H naik', '61.8%: 1.16688',
    '[PIVOT HARIAN klasik', 'S1: 1.16600',
    '[LEVEL REFERENSI] Prev Day H/L/C: 1.17100/1.16600/1.17000 | Prev Week H/L: 1.17600/1.15800',
    '[POLA CANDLE terdeteksi dari OHLC]', 'Bullish Engulfing', '[candle berjalan, belum close]',
    '[RSI-14 H4] 58.2 (naik vs 3 candle lalu)',
    'candle H4 terakhir', 'candle 1H terakhir',
  ]) {
    assert.ok(txt.includes(marker), `harus memuat "${marker}"\n---\n${txt}`);
  }
});

test('buildOhlcvText: data legacy (tanpa field struktur baru) tetap jalan tanpa blok baru', () => {
  const d = fullData();
  delete d.d1_ext; delete d.structure; delete d.sr_levels; delete d.fib;
  delete d.ref_levels; delete d.patterns; delete d.rsi_h4; delete d.h4.candles12;
  const txt = buildOhlcvText(d);
  assert.ok(txt.includes('EUR/USD MULTI-TIMEFRAME'));
  for (const marker of ['[KONTEKS 6 BULAN', '[STRUKTUR H4]', '[LEVEL S/R', '[FIBONACCI', '[PIVOT HARIAN', '[POLA CANDLE', '[RSI-14 H4]', 'candle H4 terakhir']) {
    assert.ok(!txt.includes(marker), `tidak boleh memuat "${marker}" untuk data legacy`);
  }
  // Raw 1H tetap dirender (candles24 sudah ada sejak lama di payload ohlcv_read)
  assert.ok(txt.includes('candle 1H terakhir'));
});

// ── _confluenceZones + _formatConfluenceBlock (session 166) ──────────────────

const { _confluenceZones, _formatConfluenceBlock } = require('../api/admin.js');

test('_confluenceZones: deterministik — dua panggilan data sama hasil identik', () => {
  const a = _confluenceZones(fullData(), []);
  const b = _confluenceZones(fullData(), []);
  assert.deepStrictEqual(a, b);
});

test('_confluenceZones: cluster struktur bertumpuk & ranking skor', () => {
  const z = _confluenceZones(fullData(), []);
  assert.ok(z, 'zona harus terhitung');
  assert.strictEqual(z.now, 1.17);
  assert.ok(z.above.length >= 1 && z.above.length <= 3);
  assert.ok(z.below.length >= 1 && z.below.length <= 3);
  // Semua zona di sisi yang benar relatif ke Now
  for (const zz of z.above) assert.ok(zz.center >= z.now, `above ${zz.center} < now`);
  for (const zz of z.below) assert.ok(zz.center < z.now, `below ${zz.center} >= now`);
  // Ranking menurun by skor
  for (let i = 1; i < z.above.length; i++) assert.ok(z.above[i - 1].score >= z.above[i].score);
  for (let i = 1; i < z.below.length; i++) assert.ok(z.below[i - 1].score >= z.below[i].score);
  // Zona terkuat bawah = area 1.158-1.16 (S/R 7x sentuh + swing low + SMA50 + prev week low bertumpuk)
  assert.ok(z.below[0].score > 5, `skor B1 ${z.below[0].score} harus > 5`);
  assert.ok(Math.abs(z.below[0].center - 1.159) < 0.002, `center B1 ${z.below[0].center} harus ~1.159`);
  assert.ok(z.below[0].members.some(m => m.includes('S/R')), 'B1 harus memuat S/R');
  assert.ok(z.below[0].members.some(m => m.includes('SMA50')), 'B1 harus memuat SMA50');
  // Zona terkuat atas = area 1.175-1.178 (pivot R2 + swing highs + prev week high + S/R 5x)
  assert.ok(z.above[0].score >= 5, `skor A1 ${z.above[0].score} harus >= 5`);
  assert.ok(Math.abs(z.above[0].center - 1.1764) < 0.002, `center A1 ${z.above[0].center} harus ~1.1764`);
});

test('_confluenceZones: option expiry ikut dihitung dengan bobot setengah', () => {
  const tanpa = _confluenceZones(fullData(), []);
  const dengan = _confluenceZones(fullData(), [{ num: 1.17, level: '1.1700', size: '1.2B' }]);
  // expiry 1.17 = tepat di Now → masuk salah satu zona (atau zona baru) sisi atas (center >= now)
  const all = [...dengan.above, ...dengan.below];
  assert.ok(all.some(zz => zz.members.some(m => m.includes('option expiry 1.1700'))), 'expiry harus jadi member zona');
  // Total skor naik 0.5 dibanding tanpa expiry
  const sum = zs => [...zs.above, ...zs.below].reduce((s, zz) => s + zz.score, 0);
  assert.ok(sum(dengan) >= sum(tanpa), 'skor total dengan expiry tidak boleh berkurang');
});

test('_confluenceZones: null kalau h1 tidak tersedia atau tidak ada kandidat', () => {
  const d = fullData();
  d.h1 = { available: false };
  assert.strictEqual(_confluenceZones(d, []), null);
  const d2 = fullData();
  delete d2.sr_levels; delete d2.fib; delete d2.ref_levels; delete d2.indicators;
  d2.h4.swing_highs = []; d2.h4.swing_lows = [];
  assert.strictEqual(_confluenceZones(d2, []), null);
});

test('_confluenceZones: tanpa ATR Daily pakai fallback tolerance 0.15% dari Now', () => {
  const d = fullData();
  d.d1_ext = { available: false };
  const z = _confluenceZones(d, []);
  assert.ok(z, 'tetap jalan tanpa atr_d');
  assert.ok(Math.abs(z.tolerance - 1.17 * 0.0015) < 0.0001);
});

test('_formatConfluenceBlock: render header + ID zona A1/B1', () => {
  const z = _confluenceZones(fullData(), []);
  const txt = _formatConfluenceBlock(z, 5);
  assert.ok(txt.includes('[ZONA KONFLUENSI'));
  assert.ok(txt.includes('A1.'));
  assert.ok(txt.includes('B1.'));
  assert.ok(txt.includes('Di ATAS Now'));
  assert.ok(txt.includes('Di BAWAH Now'));
  assert.ok(txt.includes('skor'));
  // Kosong kalau zona null
  assert.strictEqual(_formatConfluenceBlock(null, 5), '');
});

// ── _evaluateSetups + _aggSetupStats (Tier 1 outcome logging, session 166) ────

const { _evaluateSetups, _aggSetupStats, _formatTrackRecordBlock, _calEventMsWib } = require('../api/admin.js');

// Candle 1H sintetis: t dalam detik epoch
const mkC = (t, o, h, l, c) => ({ t, o, h, l, c, v: 0 });
const T0 = 1000000000; // detik
const MS0 = T0 * 1000;

function mkSetup(over = {}) {
  return {
    id: 'GC=F:1', symbol: 'GC=F', bias: 'bearish',
    entry_zone: '4030-4040', sl: '4065', tp: '3960',
    horizon_days: 5, ts: MS0, status: 'pending', ...over,
  };
}

test('_evaluateSetups: bearish fill lalu TP duluan → status tp', () => {
  const setups = [mkSetup()];
  const candles = {
    'GC=F': [
      mkC(T0 + 3600, 4000, 4010, 3995, 4005),   // belum sentuh zona
      mkC(T0 + 7200, 4005, 4035, 4000, 4020),   // h 4035 >= 4030 → fill
      mkC(T0 + 10800, 4020, 4030, 3955, 3960),  // l 3955 <= 3960 → TP
    ],
  };
  _evaluateSetups(setups, candles, MS0 + 4 * 3600 * 1000);
  assert.strictEqual(setups[0].status, 'tp');
  assert.strictEqual(setups[0].filled_t, T0 + 7200);
  assert.strictEqual(setups[0].closed_t, T0 + 10800);
});

test('_evaluateSetups: bearish fill lalu SL duluan → status sl', () => {
  const setups = [mkSetup()];
  const candles = {
    'GC=F': [
      mkC(T0 + 3600, 4000, 4035, 3995, 4030),   // fill
      mkC(T0 + 7200, 4030, 4070, 4025, 4060),   // h 4070 >= 4065 → SL
    ],
  };
  _evaluateSetups(setups, candles, MS0 + 3 * 3600 * 1000);
  assert.strictEqual(setups[0].status, 'sl');
});

test('_evaluateSetups: TP & SL di candle sama → ambiguous (bukan menang/kalah)', () => {
  const setups = [mkSetup()];
  const candles = {
    'GC=F': [
      mkC(T0 + 3600, 4000, 4035, 3995, 4030),          // fill
      mkC(T0 + 7200, 4030, 4070, 3955, 4000),          // h>=SL dan l<=TP di bar sama
    ],
  };
  _evaluateSetups(setups, candles, MS0 + 3 * 3600 * 1000);
  assert.strictEqual(setups[0].status, 'ambiguous');
});

test('_evaluateSetups: bullish mirror — fill di low, TP di high', () => {
  const setups = [mkSetup({ bias: 'bullish', entry_zone: '3960-3970', sl: '3940', tp: '4030' })];
  const candles = {
    'GC=F': [
      mkC(T0 + 3600, 4000, 4005, 3968, 3980),   // l 3968 <= 3970 → fill
      mkC(T0 + 7200, 3980, 4035, 3975, 4030),   // h 4035 >= 4030 → TP
    ],
  };
  _evaluateSetups(setups, candles, MS0 + 3 * 3600 * 1000);
  assert.strictEqual(setups[0].status, 'tp');
});

test('_evaluateSetups: pending kadaluarsa (> horizon x1.5) → expired; belum → tetap pending', () => {
  const far = [mkSetup()];
  _evaluateSetups(far, { 'GC=F': [mkC(T0 + 3600, 4000, 4005, 3995, 4000)] }, MS0 + 8 * 86400000); // 8 hari > 5*1.5
  assert.strictEqual(far[0].status, 'expired');
  const recent = [mkSetup()];
  _evaluateSetups(recent, { 'GC=F': [mkC(T0 + 3600, 4000, 4005, 3995, 4000)] }, MS0 + 2 * 86400000);
  assert.strictEqual(recent[0].status, 'pending');
});

test('_evaluateSetups: gap data (candle tertua >24 jam setelah setup) → stale, bukan mengarang hasil', () => {
  const setups = [mkSetup()];
  const candles = { 'GC=F': [mkC(T0 + 2 * 86400, 4000, 4100, 3900, 4000)] }; // mulai 2 hari kemudian
  _evaluateSetups(setups, candles, MS0 + 3 * 86400000);
  assert.strictEqual(setups[0].status, 'stale');
});

test('_evaluateSetups: level tidak bisa diparse / bias aneh → invalid; status final tidak disentuh', () => {
  const bad = [mkSetup({ entry_zone: null }), mkSetup({ bias: 'mixed' }), mkSetup({ status: 'tp' })];
  _evaluateSetups(bad, {}, MS0);
  assert.strictEqual(bad[0].status, 'invalid');
  assert.strictEqual(bad[1].status, 'invalid');
  assert.strictEqual(bad[2].status, 'tp'); // sudah final, jangan dievaluasi ulang
});

test('_aggSetupStats: win-rate hanya dari TP vs SL, ambiguous tidak masuk pembagi', () => {
  const arr = [
    { status: 'tp' }, { status: 'tp' }, { status: 'sl' },
    { status: 'ambiguous' }, { status: 'pending' }, { status: 'open' }, { status: 'expired' },
  ];
  const a = _aggSetupStats(arr);
  assert.strictEqual(a.total, 7);
  assert.strictEqual(a.tp, 2);
  assert.strictEqual(a.sl, 1);
  assert.strictEqual(a.win_rate, 67); // 2/3
  const empty = _aggSetupStats([]);
  assert.strictEqual(empty.win_rate, null);
});

// ── _formatTrackRecordBlock (Plan I item 2, session 180) ──────────────────────

test('_formatTrackRecordBlock: sampel < 5 (tp+sl) → string kosong, jangan disuap ke AI', () => {
  const log = [
    { symbol: 'EURUSD', status: 'tp' }, { symbol: 'EURUSD', status: 'tp' },
    { symbol: 'EURUSD', status: 'sl' }, { symbol: 'EURUSD', status: 'sl' },
  ]; // cuma 4
  assert.strictEqual(_formatTrackRecordBlock(log, 'EURUSD'), '');
});

test('_formatTrackRecordBlock: sampel >= 5 → format blok benar + saran konservatif kalau win-rate < 50%', () => {
  const log = [
    { symbol: 'EURUSD', status: 'tp' }, { symbol: 'EURUSD', status: 'tp' },
    { symbol: 'EURUSD', status: 'sl' }, { symbol: 'EURUSD', status: 'sl' },
    { symbol: 'EURUSD', status: 'sl' },
  ]; // 2 TP / 3 SL = win 40%
  const block = _formatTrackRecordBlock(log, 'EURUSD');
  assert.match(block, /\[TRACK RECORD setup AI pair ini\]/);
  assert.match(block, /5 setup selesai/);
  assert.match(block, /2 TP \/ 3 SL/);
  assert.match(block, /win rate 40%/);
  assert.match(block, /WAJIB lebih konservatif/); // win-rate < 50%
});

test('_formatTrackRecordBlock: ambiguous/expired/stale/pending/open TIDAK dihitung sebagai menang/kalah', () => {
  const log = [
    { symbol: 'EURUSD', status: 'tp' }, { symbol: 'EURUSD', status: 'tp' }, { symbol: 'EURUSD', status: 'tp' },
    { symbol: 'EURUSD', status: 'sl' }, { symbol: 'EURUSD', status: 'sl' },
    { symbol: 'EURUSD', status: 'ambiguous' }, { symbol: 'EURUSD', status: 'expired' },
    { symbol: 'EURUSD', status: 'stale' }, { symbol: 'EURUSD', status: 'pending' }, { symbol: 'EURUSD', status: 'open' },
  ]; // 3 TP / 2 SL = 5 decided, win 60% — status lain diabaikan
  const block = _formatTrackRecordBlock(log, 'EURUSD');
  assert.match(block, /5 setup selesai/);
  assert.match(block, /win rate 60%/);
  assert.doesNotMatch(block, /WAJIB lebih konservatif/); // win-rate >= 50%, tidak ada saran ekstra
});

test('_formatTrackRecordBlock: symbol lain / log kosong / korup → string kosong', () => {
  const log = Array.from({ length: 6 }, () => ({ symbol: 'GC=F', status: 'tp' }));
  assert.strictEqual(_formatTrackRecordBlock(log, 'EURUSD'), ''); // symbol tidak cocok
  assert.strictEqual(_formatTrackRecordBlock([], 'EURUSD'), ''); // log kosong
  assert.strictEqual(_formatTrackRecordBlock(null, 'EURUSD'), ''); // korup (bukan array)
  assert.strictEqual(_formatTrackRecordBlock(log, null), ''); // symbol kosong
});

// ── _calEventMsWib (AI Kritikus, Plan I item 3, session 180) ──────────────────

test('_calEventMsWib: "HH:MM WIB" terkonversi ke epoch ms yang benar (WIB = UTC+7)', () => {
  const ms = _calEventMsWib('2026-07-20', '14:30 WIB');
  const d = new Date(ms);
  assert.strictEqual(d.getUTCHours(), 7); // 14:30 WIB - 7 jam = 07:30 UTC
  assert.strictEqual(d.getUTCMinutes(), 30);
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 6); // Juli = index 6
  assert.strictEqual(d.getUTCDate(), 20);
});

test('_calEventMsWib: "Tentative" atau input kosong/korup → null, jangan dihitung jaraknya', () => {
  assert.strictEqual(_calEventMsWib('2026-07-20', 'Tentative'), null);
  assert.strictEqual(_calEventMsWib(null, '14:30 WIB'), null);
  assert.strictEqual(_calEventMsWib('2026-07-20', null), null);
  assert.strictEqual(_calEventMsWib('2026-07-20', 'garbage'), null);
});
