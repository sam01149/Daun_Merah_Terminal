const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mean, bootstrapCI, permutationTest, wilcoxonRankSum, normalCdf,
  brierScore, expectedCalibrationError,
} = require('../../scripts/_stats.js');

// ── mean ──────────────────────────────────────────────────────────────────

test('mean: rata-rata biasa, array kosong -> NaN', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(mean([])));
});

// ── bootstrapCI ───────────────────────────────────────────────────────────

test('bootstrapCI: proporsi 0/1, interval memuat estimate, deterministik (seed sama)', () => {
  const sample = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]; // proporsi 0.3
  const r1 = bootstrapCI(sample, { seed: 7 });
  const r2 = bootstrapCI(sample, { seed: 7 });
  assert.equal(r1.estimate, 0.3);
  assert.equal(r1.n, 10);
  assert.ok(r1.lo <= r1.estimate && r1.estimate <= r1.hi);
  assert.deepEqual(r1, r2, 'seed sama harus hasil identik');
});

test('bootstrapCI: sample kosong -> semua NaN, tidak throw', () => {
  const r = bootstrapCI([]);
  assert.ok(Number.isNaN(r.estimate));
  assert.equal(r.n, 0);
});

test('bootstrapCI: sample besar konsisten (proporsi tinggi) -> CI sempit di sekitar estimate', () => {
  const sample = Array(200).fill(1).concat(Array(20).fill(0)); // proporsi ~0.909
  const r = bootstrapCI(sample, { seed: 1, iterations: 3000 });
  assert.ok(r.hi - r.lo < 0.15, `CI harus cukup sempit untuk n=220, dapat ${r.hi - r.lo}`);
});

// ── permutationTest ───────────────────────────────────────────────────────

test('permutationTest: dua sampel identik distribusinya -> p-value tinggi (tidak signifikan)', () => {
  const a = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
  const b = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  const r = permutationTest(a, b, { seed: 3 });
  assert.ok(r.pValue > 0.3, `p-value harus tinggi untuk distribusi identik, dapat ${r.pValue}`);
});

test('permutationTest: beda proporsi ekstrem (semua 1 vs semua 0) -> p-value sangat kecil', () => {
  const a = Array(20).fill(1);
  const b = Array(20).fill(0);
  const r = permutationTest(a, b, { seed: 3 });
  assert.ok(r.pValue < 0.01, `p-value harus sangat kecil, dapat ${r.pValue}`);
  assert.equal(r.observedDiff, 1);
});

test('permutationTest: sampel kosong -> NaN, tidak throw', () => {
  const r = permutationTest([], [1, 2]);
  assert.ok(Number.isNaN(r.pValue));
});

// ── wilcoxonRankSum ───────────────────────────────────────────────────────

test('wilcoxonRankSum: dua sampel yang jelas terpisah -> |z| besar, p-value kecil', () => {
  const a = [10, 11, 12, 13, 14];
  const b = [1, 2, 3, 4, 5];
  const r = wilcoxonRankSum(a, b);
  assert.ok(Math.abs(r.z) > 2, `|z| harus besar, dapat ${r.z}`);
  assert.ok(r.pValue < 0.05);
});

test('wilcoxonRankSum: dua sampel identik -> z mendekati 0, p-value tinggi', () => {
  const a = [1, 2, 3, 4, 5, 6];
  const b = [1, 2, 3, 4, 5, 6];
  const r = wilcoxonRankSum(a, b);
  assert.ok(Math.abs(r.z) < 0.5, `z harus dekat 0, dapat ${r.z}`);
  assert.ok(r.pValue > 0.5);
});

test('wilcoxonRankSum: sampel kosong -> NaN, tidak throw', () => {
  const r = wilcoxonRankSum([], [1, 2]);
  assert.ok(Number.isNaN(r.pValue));
});

// ── normalCdf ─────────────────────────────────────────────────────────────

test('normalCdf: nilai standar (0 -> 0.5, jauh positif -> ~1, jauh negatif -> ~0)', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(normalCdf(5) > 0.999);
  assert.ok(normalCdf(-5) < 0.001);
});

// ── brierScore ────────────────────────────────────────────────────────────

test('brierScore: prediksi sempurna -> 0', () => {
  const pairs = [{ confidence: 1, outcome: 1 }, { confidence: 0, outcome: 0 }];
  assert.equal(brierScore(pairs), 0);
});

test('brierScore: prediksi selalu salah total -> 1', () => {
  const pairs = [{ confidence: 1, outcome: 0 }, { confidence: 0, outcome: 1 }];
  assert.equal(brierScore(pairs), 1);
});

test('brierScore: confidence konstan 0.5 (tebak acak) -> 0.25', () => {
  const pairs = [{ confidence: 0.5, outcome: 1 }, { confidence: 0.5, outcome: 0 }];
  assert.equal(brierScore(pairs), 0.25);
});

test('brierScore: array kosong -> NaN', () => {
  assert.ok(Number.isNaN(brierScore([])));
});

// ── expectedCalibrationError ─────────────────────────────────────────────

test('expectedCalibrationError: kalibrasi sempurna per bucket -> ece 0', () => {
  const pairs = [
    { confidence: 0.9, outcome: 1 }, { confidence: 0.9, outcome: 1 },
    { confidence: 0.9, outcome: 1 }, { confidence: 0.9, outcome: 1 },
    { confidence: 0.9, outcome: 1 }, { confidence: 0.9, outcome: 1 },
    { confidence: 0.9, outcome: 1 }, { confidence: 0.9, outcome: 1 },
    { confidence: 0.9, outcome: 1 }, { confidence: 0.9, outcome: 0 }, // 9/10 menang = 0.9
  ];
  const r = expectedCalibrationError(pairs, { bins: 10 });
  assert.ok(r.ece < 1e-9, `ece harus ~0 untuk kalibrasi sempurna, dapat ${r.ece}`);
});

test('expectedCalibrationError: overconfident (confidence tinggi, outcome jarang menang) -> ece besar', () => {
  const pairs = Array(10).fill(null).map((_, i) => ({ confidence: 0.95, outcome: i < 3 ? 1 : 0 })); // win-rate aktual 0.3
  const r = expectedCalibrationError(pairs, { bins: 10 });
  assert.ok(r.ece > 0.5, `ece harus besar untuk overconfidence parah, dapat ${r.ece}`);
});

test('expectedCalibrationError: array kosong -> ece NaN, buckets kosong', () => {
  const r = expectedCalibrationError([]);
  assert.ok(Number.isNaN(r.ece));
  assert.deepEqual(r.buckets, []);
});
