// test/frontend/fj_image_type.test.js
// Regression test untuk deteksi toggle gambar/tabel FinancialJuice (fjImageType).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

const start = html.indexOf('function fjImageType(title)');
assert.ok(start !== -1, 'fungsi fjImageType harus ada di index.html');
const end = html.indexOf('\n}', start) + 2;
const fjImageType = eval(`(${html.slice(start, end).trim()})`);

test('fjImageType: mengembalikan "table" untuk post Implied Volatility / Implied Vol', () => {
  assert.strictEqual(fjImageType('Commodities Implied Volatility'), 'table');
  assert.strictEqual(fjImageType('FX Implied Volatility'), 'table');
  assert.strictEqual(fjImageType('US Index Futures Implied Volatility'), 'table');
  assert.strictEqual(fjImageType('Top S&P 500 Stock Names Implied Volatility'), 'table');
  assert.strictEqual(fjImageType('FX Implied Vol'), 'table');
});

test('fjImageType: mengembalikan "table" untuk probabilities, matrix, heatmap', () => {
  assert.strictEqual(fjImageType('SNB Interest Rate Probabilities'), 'table');
  assert.strictEqual(fjImageType('Fed Rate Cut Probability'), 'table');
  assert.strictEqual(fjImageType('90-Day Correlation Matrix'), 'table');
  assert.strictEqual(fjImageType('Currency Heatmap Overview'), 'table');
});

test('fjImageType: mengembalikan "chart" untuk headline chart & CFTC positions', () => {
  assert.strictEqual(fjImageType('EUR/USD Technical Chart'), 'chart');
  assert.strictEqual(fjImageType('USD CFTC Positions Week Ended July 20th'), 'chart');
});

test('fjImageType: mengembalikan null untuk berita teks biasa tanpa gambar', () => {
  assert.strictEqual(fjImageType("Fed's Chair Warsh: volatility is down, yields are down"), null);
  assert.strictEqual(fjImageType('Oil market volatility rises sharply amid geopolitical tension'), null);
  assert.strictEqual(fjImageType('CFTC Positions in the Week Ended June 30th'), null);
  assert.strictEqual(fjImageType('Powell speaks on monetary policy'), null);
});
