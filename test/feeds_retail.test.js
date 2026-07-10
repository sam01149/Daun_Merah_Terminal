// test/feeds_retail.test.js
// Regresi untuk bug parseRetailPositions (Session 152): parser lama mengambil
// angka pertama di baris (kolom "Currency difference") sebagai long_pct,
// padahal kolom yang benar adalah "Percentage long" (indeks ke-2, 0-based).
// Fixture di bawah meniru struktur <thead>/<tr> asli forexbenchmark.com/quant/retail_positions/
// (diverifikasi manual 2026-07-10): Symbol | Currency difference | Percentage long | ...

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetailPositions } = require('../api/feeds.js');

const FIXTURE_HTML = `
<table>
<thead>
<tr><th>Symbol</th><th>Currency difference</th><th>Percentage long</th><th>Percentage / max</th><th>Volume / max</th><th>Price distance / max</th></tr>
</thead>
<tbody>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/EURUSD">EURUSD</a></b></td><td style="color:#dd5050">-48.6</td><td style="color:#dd5050">19.6</td><td>0.82</td><td>0.04</td><td>0.43</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/AUDUSD">AUDUSD</a></b></td><td>-90.0</td><td>5.2</td><td>0.99</td><td>0.02</td><td>0.61</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/USDCHF">USDCHF</a></b></td><td>85.8</td><td>92.9</td><td>0.99</td><td>0.03</td><td>0.70</td></tr>
<tr><td><b><a href="https://www.myfxbook.com/community/outlook/XAUUSD">XAUUSD</a></b></td><td>-6.0</td><td>44.0</td><td>0.61</td><td>0.05</td><td>0.58</td></tr>
</tbody>
</table>
`;

test('parseRetailPositions: membaca kolom "Percentage long", bukan "Currency difference"', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  assert.equal(positions.EURUSD.long_pct, 19.6, 'EURUSD long_pct harus 19.6 (bukan 48.6 dari kolom Currency difference)');
  assert.equal(positions.XAUUSD.long_pct, 44.0, 'XAUUSD long_pct harus 44.0 (bukan 6.0)');
});

test('parseRetailPositions: sinyal kontrarian dihitung dari long_pct yang benar', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  // AUDUSD long_pct sebenarnya 5.2 (retail mayoritas short) → harus CONTRARIAN_LONG,
  // parser lama malah membaca -90.0 → 90 → CONTRARIAN_SHORT (arah terbalik).
  assert.equal(positions.AUDUSD.signal, 'CONTRARIAN_LONG');
  assert.equal(positions.USDCHF.signal, 'CONTRARIAN_SHORT');
  // XAUUSD long_pct 44.0 ada di zona netral (35-65) → tidak boleh trigger sinyal apa pun,
  // parser lama membaca 6.0 dan salah men-trigger CONTRARIAN_LONG.
  assert.equal(positions.XAUUSD.signal, 'NEUTRAL');
});

test('parseRetailPositions: short_pct = 100 - long_pct', () => {
  const positions = parseRetailPositions(FIXTURE_HTML);
  assert.equal(positions.EURUSD.short_pct, 80.4);
});

test('parseRetailPositions: baris tanpa pair dikenal diabaikan, tidak crash', () => {
  const positions = parseRetailPositions('<table><tbody><tr><td>Foo</td><td>1</td><td>2</td></tr></tbody></table>');
  assert.deepEqual(positions, {});
});
