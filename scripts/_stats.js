// scripts/_stats.js — statistik generik reusable: bootstrap CI, permutation
// test, Wilcoxon rank-sum (Mann-Whitney U), Brier score & Expected Calibration
// Error. Tanpa dependency eksternal, pure function (node:test-able).
//
// Dibangun 2026-07-22 (Fase 1 — respons riset Scopus AI soal metodologi
// evaluasi sinyal trading AI: bootstrap/permutation/Wilcoxon untuk
// significance testing, Brier/ECE untuk kalibrasi confidence — lihat
// Dokumentasi/daun_merah_riset.md). Konsumen pertama: scripts/backtest_confluence.js
// (dataset zona konfluensi existing n=369). Dirancang reusable untuk Plan U
// item #6 (kalibrasi antar-provider) & #8 (conviction sizing) begitu sampel
// setup_log_auto:v1 cukup.

// PRNG seeded (mulberry32) — supaya bootstrap/permutation deterministik dan
// bisa diuji dengan assert exact, bukan cuma "masuk akal".
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(arr) {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Percentile bootstrap CI untuk statistik apa pun (default: mean/proporsi).
// sample: array angka (mis. 0/1 untuk outcome bounce). statFn: (arr) => number.
function bootstrapCI(sample, { iterations = 2000, alpha = 0.05, statFn = mean, seed = 42 } = {}) {
  const n = sample.length;
  if (n === 0) return { estimate: NaN, lo: NaN, hi: NaN, n: 0, iterations };
  const rng = mulberry32(seed);
  const stats = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    const resample = new Array(n);
    for (let i = 0; i < n; i++) resample[i] = sample[Math.floor(rng() * n)];
    stats[it] = statFn(resample);
  }
  stats.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * iterations);
  const hiIdx = Math.ceil((1 - alpha / 2) * iterations) - 1;
  return {
    estimate: statFn(sample),
    lo: stats[Math.max(0, loIdx)],
    hi: stats[Math.min(iterations - 1, hiIdx)],
    n, iterations,
  };
}

// Permutation test dua-sampel independen: H0 = tidak ada beda mean/proporsi
// antara sampleA & sampleB. Return p-value dua-sisi.
function permutationTest(sampleA, sampleB, { iterations = 2000, seed = 42 } = {}) {
  const nA = sampleA.length, nB = sampleB.length;
  if (!nA || !nB) return { pValue: NaN, observedDiff: NaN, nA, nB, iterations };
  const observedDiff = mean(sampleA) - mean(sampleB);
  const pooled = sampleA.concat(sampleB);
  const rng = mulberry32(seed);
  let countExtreme = 0;
  for (let it = 0; it < iterations; it++) {
    const shuffled = pooled.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    const diff = mean(shuffled.slice(0, nA)) - mean(shuffled.slice(nA));
    if (Math.abs(diff) >= Math.abs(observedDiff) - 1e-12) countExtreme++;
  }
  return { pValue: countExtreme / iterations, observedDiff, nA, nB, iterations };
}

function normalCdf(x) {
  // Aproksimasi Abramowitz-Stegun (error <7.5e-8) — cukup akurat untuk p-value.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Wilcoxon rank-sum / Mann-Whitney U (aproksimasi normal — cocok untuk n per
// sisi cukup besar, mis. ≥10). Pelengkap non-parametrik permutationTest,
// tidak butuh resampling.
function wilcoxonRankSum(sampleA, sampleB) {
  const nA = sampleA.length, nB = sampleB.length;
  if (!nA || !nB) return { z: NaN, pValue: NaN, uA: NaN, nA, nB };
  const combined = sampleA.map(v => ({ v, g: 'A' })).concat(sampleB.map(v => ({ v, g: 'B' })));
  combined.sort((a, b) => a.v - b.v);
  const ranks = new Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumA = 0;
  for (let k = 0; k < combined.length; k++) if (combined[k].g === 'A') rankSumA += ranks[k];
  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const muU = (nA * nB) / 2;
  const sigmaU = Math.sqrt((nA * nB * (nA + nB + 1)) / 12);
  const z = sigmaU ? (uA - muU) / sigmaU : 0;
  const pValue = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { z, pValue, uA, nA, nB };
}

// Brier score: rata-rata (confidence - outcome)^2, confidence 0..1, outcome
// 0/1. Semakin kecil semakin terkalibrasi (0 = sempurna, 0.25 = tebak acak
// pada confidence konstan 0.5).
function brierScore(pairs) {
  if (!pairs.length) return NaN;
  let sum = 0;
  for (const { confidence, outcome } of pairs) sum += (confidence - outcome) ** 2;
  return sum / pairs.length;
}

// Expected Calibration Error: bagi confidence ke `bins` bucket, bandingkan
// rata-rata confidence vs win-rate aktual per bucket, weighted rata-rata
// |gap| berdasar jumlah sampel per bucket. Detail per-bucket dikembalikan
// supaya bisa dipakai sebagai reliability diagram.
function expectedCalibrationError(pairs, { bins = 10 } = {}) {
  if (!pairs.length) return { ece: NaN, buckets: [] };
  const buckets = Array.from({ length: bins }, () => ({ n: 0, confSum: 0, outcomeSum: 0 }));
  for (const { confidence, outcome } of pairs) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(confidence * bins)));
    const b = buckets[idx];
    b.n++; b.confSum += confidence; b.outcomeSum += outcome;
  }
  let ece = 0;
  const detail = buckets.map((b, idx) => {
    if (!b.n) return { bucket: idx, n: 0, avgConfidence: null, avgOutcome: null, gap: null };
    const avgConfidence = b.confSum / b.n;
    const avgOutcome = b.outcomeSum / b.n;
    const gap = Math.abs(avgConfidence - avgOutcome);
    ece += (b.n / pairs.length) * gap;
    return { bucket: idx, n: b.n, avgConfidence, avgOutcome, gap };
  });
  return { ece, buckets: detail };
}

module.exports = {
  mean, bootstrapCI, permutationTest, wilcoxonRankSum, normalCdf, brierScore, expectedCalibrationError,
};
