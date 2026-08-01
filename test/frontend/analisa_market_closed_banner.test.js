// test/frontend/analisa_market_closed_banner.test.js — Session 271 (2026-08-01):
// _analisaMarketClosedBanner (index.html) adalah teks yang trader lihat Sabtu/Minggu
// menggantikan analisa real-time — wording & keberadaan timestamp penting (lihat
// permintaan user asli: "Pasar forex sedang tutup ... berikut catatan analisa terakhir
// yang dianalisa pada {tgl, jam analisa}"), jadi dites langsung dari index.html, bukan
// cuma dipercaya dari baca kode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function extractFn(name, html) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `fungsi ${name} harus ada di index.html`);
  const end = html.indexOf('\n}', start) + 2;
  return eval(`(${html.slice(start, end).trim()})`);
}

const fmtCBTime = extractFn('fmtCBTime', html);
const _analisaMarketClosedBanner = extractFn('_analisaMarketClosedBanner', html);

test('_analisaMarketClosedBanner: menyertakan wording dan timestamp analisa terakhir', () => {
  const analyzedAt = new Date(Date.now() - 20 * 3600 * 1000).toISOString(); // 20 jam lalu (khas: analisa Jumat dilihat Sabtu/Minggu)
  const out = _analisaMarketClosedBanner(analyzedAt);
  assert.match(out, /Pasar forex sedang tutup \(Sabtu\/Minggu\)/);
  assert.match(out, /berikut catatan analisa terakhir yang dianalisa pada/);
  assert.ok(out.includes(fmtCBTime(analyzedAt)), 'timestamp harus dari fmtCBTime yang sama dipakai di tempat lain (termasuk tanggal kalau >12 jam basi)');
});

test('_analisaMarketClosedBanner: tanpa analyzedAt tetap tidak crash / tidak nulis "pada" kosong', () => {
  const out = _analisaMarketClosedBanner(null);
  assert.match(out, /Pasar forex sedang tutup \(Sabtu\/Minggu\)/);
  assert.ok(!/ pada \./.test(out), 'tidak boleh ada "pada ." kosong kalau analyzedAt null');
});

// Regression: banner harus persisten lewat siklus save/restore localStorage
// (analisaAiCache -> _analisaSaveAi -> _restoreAiResult), bukan cuma nempel sekali di
// innerHTML lalu hilang begitu user pindah tab lalu balik lagi (bug lama sebelum fix ini).
test('_restoreAiResult: field marketClosed di analisaAiCache membuat banner ikut tampil lagi', () => {
  const rsStart = html.indexOf('function _restoreAiResult(');
  const rsEnd = html.indexOf('\nfunction analisaGoToSizing(');
  assert.ok(rsStart !== -1 && rsEnd !== -1, 'fungsi _restoreAiResult harus ada di index.html');
  const body = html.slice(rsStart, rsEnd);
  assert.match(body, /cached\.marketClosed/, '_restoreAiResult harus membaca field marketClosed dari cache, bukan cuma jalur render langsung');
  assert.match(body, /_analisaMarketClosedBanner\(/);
});
