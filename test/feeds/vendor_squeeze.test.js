// test/vendor_squeeze.test.js — eksekusi audit kurasan vendor (2026-07-12):
// 1. COT: parse Open Interest + baris "Percent of Open Interest" (feeds.js)
// 2. COT: percentile rank 3 tahun (feeds.js)
// Sampel teks COT diambil dari fetch LIVE financial_lof.htm 2026-07-12 (market
// #090741) — bukan karangan, sesuai pelajaran audit S158 lanjutan 4.
//
// FedWatch bucket-aggregation test dihapus 2026-07-24 bersama _aggregateFedwatchProbs
// (rate-path.js) — CME mematikan endpoint hidden API yang jadi satu-satunya pemanggil
// fungsi itu (lihat header comment rate-path.js).

const { test } = require('node:test');
const assert = require('node:assert');

const { _parseOpenInterest, _parseCotPercentLine, _pctileRank } = require('../../api/feeds.js');

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
