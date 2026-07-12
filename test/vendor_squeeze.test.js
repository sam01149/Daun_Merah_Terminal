// test/vendor_squeeze.test.js — eksekusi audit kurasan vendor (2026-07-12):
// 1. COT: parse Open Interest + baris "Percent of Open Interest" (feeds.js)
// 2. COT: percentile rank 3 tahun (feeds.js)
// 3. FedWatch: agregasi bucket probabilitas tanpa fabrikasi (rate-path.js)
// Sampel teks COT diambil dari fetch LIVE financial_lof.htm 2026-07-12 (market
// #090741) — bukan karangan, sesuai pelajaran audit S158 lanjutan 4.

const { test } = require('node:test');
const assert = require('node:assert');

const { _parseOpenInterest, _parseCotPercentLine, _pctileRank } = require('../api/feeds.js');
const { _aggregateFedwatchProbs } = require('../api/rate-path.js');

// ── Sampel blok COT asli (dipangkas) ──────────────────────────────────────────
const COT_BLOCK_REAL = [
  'Canadian Dollar - CHICAGO MERCANTILE EXCHANGE',
  'CFTC Code #090741                                                    Open Interest is   384,498',
  'Positions',
  '   222,519     30,762      8,301     40,174    148,470      8,900     36,099    123,945     19,741     14,785      2,625        393     33,584     41,361',
  '',
  'Changes from May 27, 2025',
  '     1,000      2,000        300      1,500      2,500        100        900      1,100        200        100         50         10        400        500',
  '',
  'Percent of Open Interest Represented by Each Category of Trader',
  '      57.9        8.0        2.2       10.4       38.6        2.3        9.4       32.2        5.1        3.8        0.7        0.1        8.7       10.8',
].join('\n');

test('COT: _parseOpenInterest membaca "Open Interest is X" dari blok asli', () => {
  assert.strictEqual(_parseOpenInterest(COT_BLOCK_REAL), 384498);
});

test('COT: _parseOpenInterest null saat tidak ada / input aneh', () => {
  assert.strictEqual(_parseOpenInterest('Positions\n1,000 2,000'), null);
  assert.strictEqual(_parseOpenInterest(''), null);
  assert.strictEqual(_parseOpenInterest(null), null);
});

test('COT: _parseCotPercentLine — kolom persen sejajar baris Positions (AM idx 3/4, Lev idx 6/7)', () => {
  const { amNetPctOi, levNetPctOi } = _parseCotPercentLine(COT_BLOCK_REAL.split('\n'));
  // AM: 10.4 long − 38.6 short = −28.2 · Lev: 9.4 − 32.2 = −22.8
  assert.strictEqual(amNetPctOi, -28.2);
  assert.strictEqual(levNetPctOi, -22.8);
});

test('COT: _parseCotPercentLine null saat heading tidak ada atau baris angka rusak', () => {
  assert.deepStrictEqual(_parseCotPercentLine(['Positions', '1 2 3']), { amNetPctOi: null, levNetPctOi: null });
  assert.deepStrictEqual(_parseCotPercentLine(['Percent of Open Interest Represented', 'bukan angka sama sekali']), { amNetPctOi: null, levNetPctOi: null });
  assert.deepStrictEqual(_parseCotPercentLine(null), { amNetPctOi: null, levNetPctOi: null });
});

test('COT: _pctileRank menghitung posisi relatif inklusif', () => {
  const vals = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.strictEqual(_pctileRank(vals, 95), 95);
  assert.strictEqual(_pctileRank(vals, 1), 1);
  assert.strictEqual(_pctileRank(vals, 100), 100);
  assert.strictEqual(_pctileRank(vals, -50), 0);   // lebih rendah dari semua
});

test('COT: _pctileRank null saat sampel terlalu kecil / input invalid', () => {
  assert.strictEqual(_pctileRank([1, 2, 3], 2), null);       // <20 minggu
  assert.strictEqual(_pctileRank(null, 5), null);
  assert.strictEqual(_pctileRank(Array(30).fill(1), null), null);
});

// ── FedWatch bucket aggregation ───────────────────────────────────────────────

test('FedWatch: label range bps ("350-375") — hold/cut terklasifikasi via upper bound', () => {
  const agg = _aggregateFedwatchProbs([
    { label: '350-375', probPct: 85 },
    { label: '325-350', probPct: 15 },
  ], 3.75);
  assert.strictEqual(agg.prob_hold, 0.85);
  assert.strictEqual(agg.prob_cut, 0.15);
  assert.strictEqual(agg.prob_hike, 0);
  // 0.15 × −25 = −3.75 → Math.round(−37.5)/10 = −3.7 (round-half-toward-+∞ JS)
  assert.strictEqual(agg.expected_move_bps, -3.7);
});

test('FedWatch: label range persen ("3.50-3.75") + probabilitas skala 0-1', () => {
  const agg = _aggregateFedwatchProbs([
    { label: '3.50-3.75', probability: 0.6 },
    { label: '3.25-3.50', probability: 0.4 },
  ], 3.75);
  assert.strictEqual(agg.prob_hold, 0.6);
  assert.strictEqual(agg.prob_cut, 0.4);
  assert.strictEqual(agg.expected_move_bps, -10);
});

test('FedWatch: bucket -50bp dijumlah penuh (bukan cuma bucket ease pertama seperti parser lama)', () => {
  const agg = _aggregateFedwatchProbs([
    { label: '350-375', probPct: 70 },
    { label: '325-350', probPct: 20 },
    { label: '300-325', probPct: 10 },
  ], 3.75);
  assert.strictEqual(agg.prob_cut, 0.3);                    // 0.2 + 0.1 — parser lama cuma ambil satu
  assert.strictEqual(agg.expected_move_bps, -10);           // 0.2×−25 + 0.1×−50
});

test('FedWatch: label kata kunci (NO CHANGE / EASE / HIKE) tetap didukung', () => {
  const agg = _aggregateFedwatchProbs([
    { label: 'NO CHANGE', probPct: 70 },
    { label: 'EASE', probPct: 25 },
    { label: 'HIKE', probPct: 5 },
  ], 3.75);
  assert.strictEqual(agg.prob_hold, 0.7);
  assert.strictEqual(agg.prob_cut, 0.25);
  assert.strictEqual(agg.prob_hike, 0.05);
});

test('FedWatch: tidak ada entry valid → null (bukan fabrikasi 50/50)', () => {
  assert.strictEqual(_aggregateFedwatchProbs([], 3.75), null);
  assert.strictEqual(_aggregateFedwatchProbs(null, 3.75), null);
  assert.strictEqual(_aggregateFedwatchProbs([{ label: '???', probPct: 'x' }], 3.75), null);
  assert.strictEqual(_aggregateFedwatchProbs([{ label: 'label aneh tanpa makna', probPct: 50 }], 3.75), null);
});
