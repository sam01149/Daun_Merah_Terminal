// test/frontend/ringkasan_sources.test.js
// Daftar "Headline sumber" di tab Ringkasan (2026-08-31). User bertanya "apakah
// headline-nya diberikan ke saya?" — dulu tidak: tab itu cuma menampilkan hitungan
// "N berita" tanpa satu pun judul, jadi tidak ada cara memeriksa berita besar yang
// terlewat. Tes ini mengunci tiga hal yang gampang rusak diam-diam: escaping judul,
// jujur soal "N dari total", dan payload lama (tanpa field ini) tidak boleh bikin
// kotak kosong.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function grab(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s !== -1, `marker awal tidak ketemu: ${startMarker}`);
  const e = html.indexOf(endMarker, s);
  assert.ok(e !== -1, `marker akhir tidak ketemu: ${endMarker}`);
  return html.slice(s, e);
}

const src = [
  grab('function decodeHtmlEntities', '\nfunction escJs'),
  grab('function renderRingkasanSources', '\nfunction renderRingkasan()'),
].join('\n');

const { renderRingkasanSources } = new Function(src + '\nreturn { renderRingkasanSources };')();

const H = (title, at) => ({ title, at });

test('kosong / field tidak ada → tidak merender apa-apa (payload cache lama)', () => {
  assert.equal(renderRingkasanSources(undefined, undefined), '');
  assert.equal(renderRingkasanSources(null, 80), '');
  assert.equal(renderRingkasanSources([], 80), '');
});

test('judul dirender sebagai teks, bukan link — headline FinancialJuice dilarang diklik', () => {
  const out = renderRingkasanSources([H('Trump: Kharg Island being destroyed', '2026-08-31T02:19:31Z')], 80);
  assert.ok(out.includes('Trump: Kharg Island being destroyed'));
  assert.ok(!/<a\s/i.test(out), 'tidak boleh ada anchor/link di daftar headline');
  assert.ok(!/onclick/i.test(out), 'tidak boleh ada handler klik');
});

test('judul di-escape (feed pihak ketiga tidak boleh menyuntik HTML)', () => {
  const out = renderRingkasanSources([H('<img src=x onerror=alert(1)> "AT&T"', '2026-08-31T02:00:00Z')], 80);
  assert.ok(!out.includes('<img'), 'tag mentah dari judul harus ter-escape');
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('&amp;'));
});

test('jam ditampilkan dalam WIB (UTC+7), bukan UTC', () => {
  const out = renderRingkasanSources([H('Iran: drone MQ-9 ditembak jatuh', '2026-08-31T03:22:14Z')], 80);
  assert.ok(out.includes('10:22'), '03:22Z harus tampil sebagai 10:22 WIB');
});

test('tanggal rusak/absen → placeholder, bukan "Invalid Date" atau crash', () => {
  const out = renderRingkasanSources([H('Judul tanpa tanggal', null), H('Tanggal rusak', 'bukan-tanggal')], 80);
  assert.ok(!/Invalid Date|NaN/.test(out));
  assert.equal((out.match(/--:--/g) || []).length, 2);
});

test('menyebut "N dari total" — daftar cuma sebagian dari yang dibaca AI', () => {
  const items = Array.from({ length: 25 }, (_, i) => H('Headline ' + i, '2026-08-31T03:00:00Z'));
  const out = renderRingkasanSources(items, 80);
  assert.ok(out.includes('25 dari 80'), 'header harus jujur bahwa ini sebagian dari 80');
  assert.ok(out.includes('sisanya tetap dibaca AI'),
    'catatan wajib menjelaskan headline di luar daftar tetap dilihat AI — kalau tidak, user salah menyimpulkan berita itu terlewat');
});

test('total tidak dikirim / lebih kecil dari jumlah item → jatuh ke jumlah item, bukan angka aneh', () => {
  const items = [H('A', '2026-08-31T03:00:00Z'), H('B', '2026-08-31T03:00:00Z')];
  assert.ok(renderRingkasanSources(items, undefined).includes('2 dari 2'));
  assert.ok(renderRingkasanSources(items, 1).includes('2 dari 2'));
});

test('disembunyikan saat cetak PDF (kelas no-print + aturan @media print)', () => {
  const out = renderRingkasanSources([H('X', '2026-08-31T03:00:00Z')], 80);
  assert.ok(out.includes('no-print'));
  assert.ok(/\.ringkasan-sources,/.test(html), 'CSS print harus menyembunyikan .ringkasan-sources');
});
