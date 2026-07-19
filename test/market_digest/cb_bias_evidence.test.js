// test/cb_bias_evidence.test.js
// Regression test untuk fix "Dasar AI" evidence trail (lihat daun_merah.md): sebelumnya
// cb_bias.source_headlines ditimpa penuh tiap siklus Call 2 — begitu headline substantif
// yang jadi dasar bias asli keluar dari window 36h news_history, jejaknya hilang dan
// digantikan headline generik apa pun yang kebetulan match keyword di siklus berikutnya.
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeSourceHeadlines } = require('../../api/market-digest.js');
const { isCbHeadline, stripHtml, kwTest, CB_KW } = require('../../api/_cb_keywords.js');

test('mergeSourceHeadlines: headline lama (format string, pra-fix) tetap dipertahankan saat siklus baru cuma nemu headline generik', () => {
  const prev = ['RBNZ hikes 25bps, Orr signals more tightening ahead'];
  const fresh = [{ title: 'RBNZ Interest Rate Probabilities', description: null, matched_at: '2026-07-12T00:00:00.000Z' }];
  const merged = mergeSourceHeadlines(prev, fresh);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].title, 'RBNZ Interest Rate Probabilities');
  assert.strictEqual(merged[1].title, 'RBNZ hikes 25bps, Orr signals more tightening ahead');
  // Entry lama yang di-normalize dari string tidak boleh punya description palsu
  assert.strictEqual(merged[1].description, null);
});

test('mergeSourceHeadlines: dedupe judul identik, tidak digandakan', () => {
  const prev = [{ title: 'ECB holds rates, Lagarde cautious', description: null, matched_at: '2026-07-01T00:00:00.000Z' }];
  const fresh = [{ title: 'ECB holds rates, Lagarde cautious', description: 'full text', matched_at: '2026-07-12T00:00:00.000Z' }];
  const merged = mergeSourceHeadlines(prev, fresh);
  assert.strictEqual(merged.length, 1);
  // Versi fresh (dengan description) yang menang, bukan versi prev yang lebih tipis
  assert.strictEqual(merged[0].description, 'full text');
});

test('mergeSourceHeadlines: dibatasi maksimal 8 entri, prioritas ke yang terbaru', () => {
  const prev = Array.from({ length: 7 }, (_, i) => ({ title: `old headline ${i}`, description: null, matched_at: '2026-07-01T00:00:00.000Z' }));
  const fresh = [
    { title: 'new headline A', description: null, matched_at: '2026-07-12T00:00:00.000Z' },
    { title: 'new headline B', description: null, matched_at: '2026-07-12T00:00:00.000Z' },
    { title: 'new headline C', description: null, matched_at: '2026-07-12T00:00:00.000Z' },
  ];
  const merged = mergeSourceHeadlines(prev, fresh);
  assert.strictEqual(merged.length, 8);
  assert.deepStrictEqual(merged.slice(0, 3).map(h => h.title), ['new headline A', 'new headline B', 'new headline C']);
});

test('mergeSourceHeadlines: prevList kosong/undefined tidak crash', () => {
  const fresh = [{ title: 'x', description: null, matched_at: '2026-07-12T00:00:00.000Z' }];
  assert.deepStrictEqual(mergeSourceHeadlines(undefined, fresh), fresh);
  assert.deepStrictEqual(mergeSourceHeadlines(null, fresh), fresh);
  assert.deepStrictEqual(mergeSourceHeadlines([], fresh), fresh);
});

test('isCbHeadline: kata kunci bank sentral (termasuk headline generik tanpa arah jelas) match', () => {
  assert.strictEqual(isCbHeadline('RBNZ Interest Rate Probabilities'), true);
  assert.strictEqual(isCbHeadline('Fed Chair Powell speaks on inflation outlook'), true);
  assert.strictEqual(isCbHeadline('Apple stock rises on earnings beat'), false);
});

test('isCbHeadline: word-boundary tetap konsisten dengan kwTest asli (mis. "orr" bukan "worrying")', () => {
  assert.strictEqual(kwTest('markets worrying about growth', 'orr'), false);
  assert.strictEqual(isCbHeadline('markets worrying about growth'), false);
  assert.strictEqual(kwTest('rbnz governor orr speaks', 'orr'), true);
});

test('stripHtml: buang tag tapi pertahankan teksnya, aman untuk input kosong/null', () => {
  assert.strictEqual(stripHtml('<li><strong>EUR:</strong> 1.0800 (500m)</li>'), 'EUR: 1.0800 (500m)');
  assert.strictEqual(stripHtml(null), '');
  assert.strictEqual(stripHtml(''), '');
  assert.strictEqual(stripHtml('plain text, no tags'), 'plain text, no tags');
});

test('CB_KW: semua 8 mata uang major ada, tidak sengaja terhapus saat dipindah ke module shared', () => {
  assert.deepStrictEqual(Object.keys(CB_KW).sort(), ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD']);
});
