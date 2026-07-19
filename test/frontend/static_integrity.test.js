// test/static_integrity.test.js
// Regression test untuk 2 kelas insiden nyata:
// - Session 181: teks liar sebelum <!DOCTYPE> di index.html lolos ke production
//   (tampil sebagai judul halaman palsu) karena tidak ada test yang mengecek isi
//   di luar tag <script>.
// - Pola lupa bump versi cache-buster: NEWSCAT_VERSION dipakai berpasangan di
//   index.html (<script src="/newscat.js?v=X">) dan sw.js (importScripts
//   ('/newscat.js?v=' + NEWSCAT_VERSION)) — kalau salah satu di-bump tapi yang
//   lain tidak, browser lama & SW baru bisa memuat newscat.js versi berbeda.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', '..', 'sw.js'), 'utf8');

test('index.html: baris 1 persis "<!DOCTYPE html>", tanpa teks nyasar sebelum/sesudahnya', () => {
  const firstLine = html.split('\n')[0].replace(/\r$/, '');
  assert.strictEqual(firstLine, '<!DOCTYPE html>');

  const doctypeIdx = html.indexOf('<!DOCTYPE');
  assert.strictEqual(doctypeIdx, 0, 'harus tidak ada karakter apa pun sebelum <!DOCTYPE');

  const htmlEndIdx = html.lastIndexOf('</html>');
  assert.ok(htmlEndIdx !== -1, 'harus ada penutup </html>');
  const afterHtml = html.slice(htmlEndIdx + '</html>'.length);
  assert.strictEqual(afterHtml.trim(), '', 'tidak boleh ada teks non-whitespace setelah </html>');
});

test('newscat.js: versi ?v= di index.html sinkron dengan NEWSCAT_VERSION di sw.js', () => {
  const swVerMatch = sw.match(/NEWSCAT_VERSION\s*=\s*'([^']+)'/);
  assert.ok(swVerMatch, 'NEWSCAT_VERSION harus terdefinisi di sw.js');
  const swVer = swVerMatch[1];

  const htmlVerMatch = html.match(/newscat\.js\?v=([^"']+)"/);
  assert.ok(htmlVerMatch, 'index.html harus punya <script src="/newscat.js?v=...">');
  const htmlVer = htmlVerMatch[1];

  assert.strictEqual(htmlVer, swVer,
    `versi newscat.js beda: index.html=${htmlVer} vs sw.js=${swVer} — salah satu lupa di-bump`);
});

test('APP_VERSION: terdefinisi dan berformat non-kosong', () => {
  const m = html.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m, 'APP_VERSION harus terdefinisi di index.html');
  assert.ok(m[1].length > 0);
});
