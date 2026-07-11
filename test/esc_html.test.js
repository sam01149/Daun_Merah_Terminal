// test/esc_html.test.js
// Regression test: escHtml(s) di index.html sempat throw "(s || "").replace is not a function"
// saat dipanggil dengan nilai truthy non-string (angka, boolean, array) — kasus nyata:
// field AI JSON seperti structured.sl/tp/entry_zone kadang dikembalikan sebagai number.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function escHtml(s)');
assert.ok(start !== -1, 'fungsi escHtml harus ada di index.html');
const end = html.indexOf('\n}', start) + 2;
const escHtml = eval(`(${html.slice(start, end).trim()})`);

// _renderStructuredAi (dites di bawah) memanggil _makroAgeLabel — didefinisikan
// terpisah di index.html (dipakai bareng oleh downloadAnalisaPdf), jadi perlu
// di-extract juga supaya eval-nya nggak ReferenceError.
const mrStart = html.indexOf('function _makroAgeLabel(');
assert.ok(mrStart !== -1, 'fungsi _makroAgeLabel harus ada di index.html');
const mrEnd = html.indexOf('\n}', mrStart) + 2;
const _makroAgeLabel = eval(`(${html.slice(mrStart, mrEnd).trim()})`);

test('escHtml: tidak throw untuk number/boolean/array (bug asli)', () => {
  assert.strictEqual(escHtml(4155.5), '4155.5');
  assert.strictEqual(escHtml(0), '0');
  assert.strictEqual(escHtml(true), 'true');
  assert.strictEqual(escHtml(false), 'false');
  assert.strictEqual(escHtml(['x', 'y']), 'x,y');
});

test('escHtml: null/undefined/string kosong tetap jadi string kosong', () => {
  assert.strictEqual(escHtml(null), '');
  assert.strictEqual(escHtml(undefined), '');
  assert.strictEqual(escHtml(''), '');
});

test('escHtml: escape & < > tetap benar untuk string normal', () => {
  assert.strictEqual(escHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

// Reproduksi bug asli end-to-end: AI kadang balikin sl/tp/entry_zone sebagai number
// (bukan string) di JSON terstruktur — _renderStructuredAi memanggil escHtml(structured.sl)
// dkk langsung tanpa String(), jadi ini crash di _renderStructuredAi sebelum fix escHtml,
// tertangkap catch(e) di analyzeOhlcvAi() dan tampil sebagai "Error: (s || "").replace is not a function".
test('_renderStructuredAi: tidak crash saat sl/tp/entry_zone dari AI berupa number', () => {
  const rsStart = html.indexOf('function _renderStructuredAi(');
  const rsEnd = html.indexOf('function _restoreAiResult(');
  assert.ok(rsStart !== -1 && rsEnd !== -1, 'fungsi _renderStructuredAi harus ada di index.html');
  const _renderStructuredAi = eval(`(${html.slice(rsStart, rsEnd).trim()})`);

  const structured = {
    bias: 'bullish',
    trigger: 'Breakout di atas 4187',
    entry_zone: 4166.00,
    sl: 4155.50,
    tp: 4210.00,
    risk_reward: 2.3,
    time_horizon_days: 3,
    makro_alignment: 'searah',
    makro_alignment_reason: 'DXY melemah sejalan bias bullish XAU',
    entry_basis: 'S/R cluster + fib 61.8',
    invalidation_condition: 'Close di bawah 4150',
    commentary: 'Momentum bullish terjaga.',
  };
  const out = _renderStructuredAi(structured, '', 'qwen-3-32b', true, false, true, '2026-07-06T10:00:00Z');
  assert.ok(out.includes('4166') && out.includes('4155.5') && out.includes('4210'));
});
