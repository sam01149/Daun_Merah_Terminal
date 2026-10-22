// Transparansi skor Fundamental: distribusi di UI wajib memakai perhitungan yang
// sama dengan ranking/card, bukan implementasi kedua yang bisa drift.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const start = html.indexOf('const FUND_SCORE_RULES =');
const end = html.indexOf('\nasync function fetchFundamental', start);
assert.ok(start !== -1 && end !== -1, 'blok perhitungan fundamental harus ada di index.html');

const context = { result: null };
vm.runInNewContext(`${html.slice(start, end)}\nresult = { buildFundWeightDistribution, formatFundWeight };`, context);
const { buildFundWeightDistribution, formatFundWeight } = context.result;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

test('distribusi poin: bobot kepentingan dikali bobot umur, lalu dipisah bullish/bearish', () => {
  const distribution = buildFundWeightDistribution({
    'Fed Rate': { actual: '4.00%' },
    'CPI YoY': { actual: '3.0%', previous: '2.8%', date: isoDaysAgo(0) },       // bullish: 2 × 1 = 2
    'ISM Services': { actual: '51', previous: '50', date: isoDaysAgo(20) },    // bullish: 1 × 0.5 = 0.5
    'Housing Starts': { actual: '-1%', previous: '1%', date: isoDaysAgo(0) },  // bearish: 0.5 × 1 = 0.5
    'Mystery Index': { actual: '10', previous: '9', date: isoDaysAgo(0) },     // arah tak dikenal: tidak dihitung
  }, 'Fed Rate');

  assert.strictEqual(distribution.totalWeight, 3);
  assert.strictEqual(distribution.bullWeight, 2.5);
  assert.strictEqual(distribution.bearWeight, 0.5);
  assert.strictEqual(distribution.bullPct, 83);
  assert.strictEqual(distribution.bearPct, 17);
  assert.strictEqual(distribution.unscoredCount, 1);
  assert.deepStrictEqual(Array.from(distribution.unscoredKeys), ['Mystery Index']);
  assert.strictEqual(distribution.rows.length, 3);
  assert.strictEqual(distribution.rows[0].key, 'CPI YoY');
  assert.strictEqual(distribution.rows[0].effectiveWeight, 2);
  assert.strictEqual(distribution.rows[0].sharePct, 66.7);
});

test('distribusi poin: seed tanpa tanggal tetap masuk dengan bobot umur 0.25', () => {
  const distribution = buildFundWeightDistribution({
    'GDP QoQ': { actual: '0.5%', previous: '0.4%', date: '—' },
  }, null);
  assert.strictEqual(distribution.totalWeight, 0.5);
  assert.strictEqual(distribution.bullWeight, 0.5);
  assert.strictEqual(distribution.bullPct, 100);
  assert.strictEqual(distribution.rows[0].importance, 2);
  assert.strictEqual(distribution.rows[0].recencyWeight, 0.25);
});

test('distribusi poin: data kosong tidak menghasilkan persentase palsu', () => {
  const distribution = buildFundWeightDistribution({}, null);
  assert.strictEqual(distribution.totalWeight, 0);
  assert.strictEqual(distribution.bullPct, null);
  assert.strictEqual(distribution.bearPct, null);
  assert.deepStrictEqual(Array.from(distribution.rows), []);
});

test('format poin: presisi ringkas tanpa nol tidak perlu', () => {
  assert.strictEqual(formatFundWeight(2), '2');
  assert.strictEqual(formatFundWeight(0.5), '0.5');
  assert.strictEqual(formatFundWeight(0.25), '0.25');
});
