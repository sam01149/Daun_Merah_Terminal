const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function petunjukMarkup() {
  const from = html.indexOf('<!-- PETUNJUK PANEL -->');
  const to = html.indexOf('<!-- TEKNIKAL PANEL -->', from);
  assert.notEqual(from, -1, 'marker awal Petunjuk tidak ditemukan');
  assert.notEqual(to, -1, 'marker akhir Petunjuk tidak ditemukan');
  return html.slice(from, to);
}

test('Petunjuk menjelaskan Bias sebagai data mata uang, bukan keputusan entry', () => {
  const guide = petunjukMarkup();
  assert.match(guide, /Panduan Membaca Data/);
  assert.match(guide, /ARAH MATA UANG MINGGU INI/);
  assert.match(guide, /Bias bukan perintah entry/);
  assert.match(guide, /Naik[\s\S]*Turun[\s\S]*Campur[\s\S]*data belum cukup/);
  assert.match(guide, /Arah pair tetap harus mempertimbangkan kedua mata uang/);
  assert.match(guide, /Tabel Bias dan panel harga adalah dua pembacaan berbeda/);
});

test('Petunjuk mengikuti alur fitur aktif dan batas data saat ini', () => {
  const guide = petunjukMarkup();
  for (const label of ['DASHBOARD', 'CAL', 'RINGKASAN', 'NEWS', 'ANALISA', 'RENCANA', 'SIZING', 'JURNAL']) {
    assert.match(guide, new RegExp(`>${label}<`));
  }
  assert.match(guide, /close D1 terhadap EMA200/);
  assert.match(guide, /EMA gap EMA21\/EMA100 H4/);
  assert.match(guide, /ATR14 H6/);
  assert.match(guide, /Pandangan ekonom belum memengaruhi Bias sebelum rapor forward memiliki sampel yang cukup/);
  assert.match(guide, /headline terkait, tetapi daftar itu bukan jejak sitasi lengkap/);
});

test('Petunjuk tidak membawa klaim lama yang terlalu pasti atau simbol dekoratif', () => {
  const guide = petunjukMarkup();
  assert.doesNotMatch(guide, /5-15 detik head start|80\+ headline|valid ~4 jam|Risk max 2%|berlaku untuk minggu depan|bukan perkiraan/);
  assert.doesNotMatch(guide, /[👋⚡⚙✓✗⌨]/u);
  assert.doesNotMatch(guide, /pt-flow-arrow|pt-rule-icon/);
});
