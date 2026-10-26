const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function grab(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `marker awal tidak ketemu: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end !== -1, `marker akhir tidak ketemu: ${endMarker}`);
  return html.slice(start, end);
}

const deriveSrc = grab('function szDerivePriceSetup(', '\n\nfunction szAutoComputePips');
const { szDerivePriceSetup } = new Function(`${deriveSrc}; return { szDerivePriceSetup };`)();

test('mode harga meminta Entry, SL, dan TP lalu menghitung R:R otomatis', () => {
  const form = grab('<!-- SIZING PANEL -->', '<!-- JURNAL PANEL -->');
  assert.match(form, /id="szEntryPrice"/);
  assert.match(form, /id="szSLPrice"/);
  assert.match(form, /id="szTPPrice"/);
  assert.match(form, /id="szComputedRRInfo"/);
  assert.match(form, /id="szRRRow">Target R:R \(menentukan TP\)/);
  assert.match(html, /rrRow\.style\.display\s*=\s*mode === 'pips'\s*\? 'flex' : 'none'/);
});

test('R:R long diturunkan dari jarak Entry-SL dan Entry-TP', () => {
  const result = szDerivePriceSetup(1.1000, 1.0950, 1.1100, 'long', 0.0001);
  assert.equal(result.valid, true);
  assert.equal(result.stopPips, 50);
  assert.ok(Math.abs(result.rrTarget - 2) < 1e-10);
});

test('R:R short diturunkan dari jarak Entry-SL dan Entry-TP', () => {
  const result = szDerivePriceSetup(150.000, 150.500, 149.000, 'short', 0.01);
  assert.equal(result.valid, true);
  assert.equal(result.stopPips, 50);
  assert.ok(Math.abs(result.rrTarget - 2) < 1e-10);
});

test('level harga yang terbalik terhadap arah trade ditolak', () => {
  assert.deepEqual(
    szDerivePriceSetup(1.1000, 1.1050, 1.0900, 'long', 0.0001),
    { valid: false, reason: 'direction' },
  );
  assert.deepEqual(
    szDerivePriceSetup(1.1000, 1.0950, 1.1100, 'short', 0.0001),
    { valid: false, reason: 'direction' },
  );
});

test('TP dari Analisa dan Rencana diteruskan ke Sizing, bukan dibuang', () => {
  const analisaRoute = grab('function analisaGoToSizing(symbol)', '\nlet _pendingSizingSetup');
  const checklistRoute = grab('function ckGoToSizing()', '\nfunction ckShowMt5ModalAction');
  assert.match(analisaRoute, /document\.getElementById\('szTPPrice'\)\.value = tpPrice/);
  assert.match(checklistRoute, /document\.getElementById\('szTPPrice'\)\.value = setup\.tpPrice/);
});

test('risk percent dijelaskan sebagai batas rugi terpisah dari level harga', () => {
  const form = grab('<!-- SIZING PANEL -->', '<!-- JURNAL PANEL -->');
  assert.match(form, /Maksimum rugi dari equity \(%\)/);
  assert.match(form, /id="szRiskInfo"/);
  const riskFn = grab('function szUpdateRiskInfo()', '\n\nfunction szUpdatePipInfo');
  assert.match(riskFn, /bukan dihitung dari Entry, SL, atau TP/);
  assert.match(riskFn, /Entry dan SL menentukan lot; TP hanya menentukan R:R/);
});
