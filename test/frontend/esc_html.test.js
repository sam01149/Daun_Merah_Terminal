// test/esc_html.test.js
// Regression test: escHtml(s) di index.html sempat throw "(s || "").replace is not a function"
// saat dipanggil dengan nilai truthy non-string (angka, boolean, array) — kasus nyata:
// field AI JSON seperti structured.sl/tp/entry_zone kadang dikembalikan sebagai number.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

const deStart = html.indexOf('function decodeHtmlEntities(s)');
assert.ok(deStart !== -1, 'fungsi decodeHtmlEntities harus ada di index.html');
const deEnd = html.indexOf('\n}', deStart) + 2;
const decodeHtmlEntities = eval(`(${html.slice(deStart, deEnd).trim()})`);

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

// _renderStructuredAi juga memanggil _renderAiMarkdownSafe (2026-08-10, fix bug
// asterisk markdown mentah di panel AI) — sama alasan seperti _makroAgeLabel di atas.
const mdStart = html.indexOf('function _renderAiMarkdownSafe(');
assert.ok(mdStart !== -1, 'fungsi _renderAiMarkdownSafe harus ada di index.html');
const mdEnd = html.indexOf('\n}', mdStart) + 2;
const _renderAiMarkdownSafe = eval(`(${html.slice(mdStart, mdEnd).trim()})`);

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

// ── _renderAiMarkdownSafe (2026-08-10) — Journal AI Coach & Diagnosa Perilaku sempat
// tampilkan markdown mentah (**tebal**, ### header, dsb) dari Gemini/SambaNova; versi
// lama juga escHtml teks SETELAH convert **bold** (celah XSS kalau teks AI kebetulan
// mengandung <, >, & literal) — fix-nya escape DULU baru sisipkan tag markdown sendiri. ──

test('_renderAiMarkdownSafe: escape HTML DULU sebelum sisip tag markdown (cegah XSS dari teks AI)', () => {
  const out = _renderAiMarkdownSafe('R < 2 tapi **bagus**, bukan <script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), 'tidak boleh ada tag <script> asli lolos ke HTML');
  assert.ok(out.includes('&lt;script&gt;'), 'tag berbahaya harus ke-escape jadi entity');
  assert.ok(out.includes('<strong>bagus</strong>'), 'bold dari AI tetap dirender jadi <strong> asli');
});

test('_renderAiMarkdownSafe: bold/italic/kode-inline jadi tag HTML asli', () => {
  assert.strictEqual(_renderAiMarkdownSafe('**USD** kuat karena *inflasi* dan `Core PCE`'), '<strong>USD</strong> kuat karena <em>inflasi</em> dan <code>Core PCE</code>');
});

test('_renderAiMarkdownSafe: header "### Judul" jadi <strong>, bullet "- " jadi bullet char', () => {
  assert.strictEqual(_renderAiMarkdownSafe('### Ringkasan\n- Poin A\n- Poin B'), '<strong>Ringkasan</strong>\n• Poin A\n• Poin B');
});

test('_renderAiMarkdownSafe: baris pemisah "---" dibuang, angka negatif/persen tidak ikut rusak', () => {
  assert.strictEqual(_renderAiMarkdownSafe('NFP -23K\n\n---\n\nCPI -0.1%'), 'NFP -23K\n\nCPI -0.1%');
});

test('_renderAiMarkdownSafe: kosong -> string kosong, tidak crash', () => {
  assert.strictEqual(_renderAiMarkdownSafe(''), '');
  assert.strictEqual(_renderAiMarkdownSafe(null), '');
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
