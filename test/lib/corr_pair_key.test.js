// test/lib/corr_pair_key.test.js
// Regresi audit S336 (2026-08-29): endpoint `?action=atr` membalas 400 "Unknown pair"
// untuk SEMUA pair yang dikirim tab Teknikal, karena `tekPair` (index.html) memakai
// format tanpa garis miring (`EURUSD`) sementara YAHOO_SYMBOL_MAP/PIP_SIZE_MAP
// ber-key garis miring (`EUR/USD`). Errornya ditelan .catch() di frontend sehingga
// panel Range/ATR diam-diam kosong dan tidak pernah kelihatan sebagai error.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePairKey } = require('../../api/correlations.js');

test('format tanpa garis miring (tab Teknikal) dinormalisasi ke bentuk kanonik', () => {
  assert.equal(normalizePairKey('EURUSD'), 'EUR/USD');
  assert.equal(normalizePairKey('XAUUSD'), 'XAU/USD');
  assert.equal(normalizePairKey('CHFJPY'), 'CHF/JPY');
  assert.equal(normalizePairKey('AUDNZD'), 'AUD/NZD');
});

test('format garis miring (Sizing Calculator & Jurnal) dibiarkan apa adanya', () => {
  assert.equal(normalizePairKey('EUR/USD'), 'EUR/USD');
  assert.equal(normalizePairKey('XAU/USD'), 'XAU/USD');
});

test('huruf kecil dan spasi ikut dibereskan', () => {
  assert.equal(normalizePairKey('eurusd'), 'EUR/USD');
  assert.equal(normalizePairKey(' eur/usd '), 'EUR/USD');
  assert.equal(normalizePairKey('xau usd'), 'XAU/USD');
});

test('input tidak dikenal dikembalikan apa adanya supaya caller tetap bisa menolak 400', () => {
  // Penting: normalisasi TIDAK boleh mengarang pair. `EURUSDX` bukan 6 huruf,
  // jadi harus tetap gagal lookup di caller, bukan diam-diam jadi `EUR/USD`.
  assert.equal(normalizePairKey('EURUSDX'), 'EURUSDX');
  assert.equal(normalizePairKey('NGACO'), 'NGACO');
  assert.equal(normalizePairKey(''), '');
  assert.equal(normalizePairKey(null), '');
  assert.equal(normalizePairKey(undefined), '');
});

test('pip size gold ikut benar setelah normalisasi (bug turunan)', () => {
  // Kalau normalisasi cuma dipasang di YAHOO_SYMBOL_MAP dan bukan sebelum
  // PIP_SIZE_MAP, `XAUUSD` jatuh ke pip default 0.0001 (bukan 0.01) dan
  // atr_pips gold meleset 100x. Test ini mengunci bentuk key yang dipakai keduanya.
  const PIP_SIZE_MAP = { 'USD/JPY': 0.01, 'CHF/JPY': 0.01, 'XAU/USD': 0.01 };
  assert.equal(PIP_SIZE_MAP[normalizePairKey('XAUUSD')], 0.01);
  assert.equal(PIP_SIZE_MAP[normalizePairKey('CHFJPY')], 0.01);
  assert.equal(PIP_SIZE_MAP[normalizePairKey('EURUSD')] || 0.0001, 0.0001);
});
