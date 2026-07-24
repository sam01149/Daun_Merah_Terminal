// test/frontend/corr_sparkline.test.js
// Plan I Fase 2 (2026-07-24): sparkline drift korelasi historis di panel TEK.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `fungsi ${name} harus ada di index.html`);
  const end = html.indexOf('\n}', start) + 2;
  return html.slice(start, end).trim();
}

// corrColor dipakai internal oleh _corrSparkline untuk memilih warna garis.
const corrColorSrc = extractFn('corrColor');
const histForSrc = extractFn('_histFor');
const sparklineSrc = extractFn('_corrSparkline');
const corrColor = eval(`(${corrColorSrc})`);
const _histFor = eval(`(${histForSrc})`);
// eslint-disable-next-line no-unused-vars -- dipakai via closure saat eval _corrSparkline
const _corrSparkline = eval(`(${sparklineSrc})`);

test('_histFor: cari key A|B, fallback ke B|A, null kalau tidak ada histori', () => {
  const hist = { series: { 'Gold|DXY': [1, 2, 3] } };
  assert.deepStrictEqual(_histFor(hist, 'Gold', 'DXY'), [1, 2, 3]);
  assert.deepStrictEqual(_histFor(hist, 'DXY', 'Gold'), [1, 2, 3]);
  assert.strictEqual(_histFor(hist, 'Gold', 'EUR'), null);
  assert.strictEqual(_histFor(null, 'Gold', 'DXY'), null);
  assert.strictEqual(_histFor({}, 'Gold', 'DXY'), null);
});

test('_corrSparkline: kurang dari 2 titik valid -> string kosong (anti-noise)', () => {
  assert.strictEqual(_corrSparkline(null), '');
  assert.strictEqual(_corrSparkline([]), '');
  assert.strictEqual(_corrSparkline([0.5]), '');
  assert.strictEqual(_corrSparkline([null, null, 0.5]), '');
});

test('_corrSparkline: >=2 titik valid -> render svg dengan path & warna sesuai titik terakhir', () => {
  const svgPos = _corrSparkline([0.2, 0.4, 0.7]);
  assert.match(svgPos, /<svg/);
  assert.match(svgPos, /<path/);
  assert.match(svgPos, /class="corr-pos"/); // titik terakhir 0.7 > 0.3

  const svgNeg = _corrSparkline([0.2, -0.5]);
  assert.match(svgNeg, /class="corr-neg"/); // titik terakhir -0.5 < -0.3

  const svgNeu = _corrSparkline([0.5, 0.1]);
  assert.match(svgNeu, /class="corr-neu"/); // titik terakhir 0.1 dalam rentang netral
});

test('_corrSparkline: celah null di tengah deret tidak membuat crash / path tetap terbentuk', () => {
  const svg = _corrSparkline([0.3, null, 0.6, 0.5]);
  assert.match(svg, /<path/);
});
