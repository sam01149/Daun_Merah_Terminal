// test/vps/position_review.test.js — Plan U-5b (vps/daemon.js): trigger review
// posisi event-driven + heuristik UNCONFIRMED. Cakupan pure functions saja
// (bagian async/Redis/HTTP dites via simulasi lokal manual, bukan node:test —
// pola sama U-3, lihat test/vps/auto_entry.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectCurrencyLegs, isCorroborated, posReviewSignificantTokens, POSREVIEW_CURRENCY_KEYWORDS,
} = require('../../vps/daemon.js');
const apiPositionReview = require('../../api/_position_review.js');

// ── detectCurrencyLegs ───────────────────────────────────────────────────────

test('detectCurrencyLegs: headline Fed match USD', () => {
  assert.deepEqual(detectCurrencyLegs('Fed Chair Powell signals rate pause'), ['USD']);
});

test('detectCurrencyLegs: headline gold match XAU', () => {
  assert.deepEqual(detectCurrencyLegs('Gold prices surge on safe-haven demand'), ['XAU']);
});

test('detectCurrencyLegs: headline dua currency (ECB vs USD) -> dua leg', () => {
  const legs = detectCurrencyLegs('ECB rate decision looms as dollar weakens');
  assert.ok(legs.includes('EUR'));
  assert.ok(legs.includes('USD'));
});

test('detectCurrencyLegs: tidak match currency apa pun -> array kosong (fail-closed)', () => {
  assert.deepEqual(detectCurrencyLegs('Local football team wins championship'), []);
});

test('detectCurrencyLegs: semua 9 currency di POSREVIEW_CURRENCY_KEYWORDS punya keyword non-kosong', () => {
  const keys = Object.keys(POSREVIEW_CURRENCY_KEYWORDS);
  assert.equal(keys.length, 9);
  for (const k of keys) assert.ok(POSREVIEW_CURRENCY_KEYWORDS[k].length > 0);
});

// ── isCorroborated ──────────────────────────────────────────────────────────

test('isCorroborated: market-moving selalu corroborated by default', () => {
  assert.equal(isCorroborated({ cat: 'market-moving', title: 'NFP data released', pubDate: '2026-07-20T10:00:00Z' }, []), true);
});

test('isCorroborated: geopolitical satu item sendirian -> false (unconfirmed)', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  assert.equal(isCorroborated(item, [item]), false);
});

test('isCorroborated: geopolitical + item lain guid beda, overlap >=2 token dalam 30 menit -> true', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T10:15:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), true);
});

test('isCorroborated: item lain di luar jendela 30 menit -> false', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T11:00:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), false);
});

test('isCorroborated: item lain overlap token <2 -> false', () => {
  const item = { cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' };
  const other = { title: 'Stock market rallies on earnings', pubDate: '2026-07-20T10:05:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), false);
});

test('isCorroborated: kategori lain (bukan market-moving/geopolitical) -> false', () => {
  assert.equal(isCorroborated({ cat: 'lainnya', title: 'x', pubDate: '2026-07-20T10:00:00Z' }, []), false);
});

// ── Behavioral drift-guard: isCorroborated daemon.js vs api/_position_review.js ──
// Duplikasi SADAR (Docker vps/ terisolasi, lihat catatan kepala vps/daemon.js) —
// byte-diff seperti newscat.js tidak praktis karena function ini menyatu di file
// besar, jadi disini dites PERILAKU identik untuk sweep kasus yang sama.
test('drift-guard: isCorroborated daemon.js vs api/_position_review.js berperilaku identik', () => {
  const cases = [
    [{ cat: 'market-moving', title: 'x', pubDate: '2026-07-20T10:00:00Z' }, []],
    [{ cat: 'geopolitical', title: 'Border clash reported near capital', pubDate: '2026-07-20T10:00:00Z', guid: 'a' },
      [{ cat: 'geopolitical', title: 'Border clash reported near capital', pubDate: '2026-07-20T10:00:00Z', guid: 'a' }]],
    [{ cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' },
      [{ title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T10:15:00Z', guid: 'b' }]],
    [{ cat: 'geopolitical', title: 'Border clash reported near capital city', pubDate: '2026-07-20T10:00:00Z', guid: 'a' },
      [{ title: 'Military border clash near capital confirmed', pubDate: '2026-07-20T11:00:00Z', guid: 'b' }]],
    [{ cat: 'lainnya', title: 'x', pubDate: '2026-07-20T10:00:00Z' }, []],
  ];
  for (const [item, recent] of cases) {
    assert.equal(isCorroborated(item, recent), apiPositionReview.isCorroborated(item, recent),
      `hasil beda untuk item "${item.title}"`);
  }
});

// ── posReviewSignificantTokens ───────────────────────────────────────────────

test('posReviewSignificantTokens: buang stopword & token pendek (<=3 huruf), lowercase', () => {
  const tokens = posReviewSignificantTokens('The Border Clash Is On Capital City');
  assert.ok(tokens.includes('border'));
  assert.ok(tokens.includes('clash'));
  assert.ok(tokens.includes('capital'));
  assert.ok(!tokens.includes('the')); // stopword
  assert.ok(!tokens.includes('is')); // <=3 huruf
  assert.ok(!tokens.includes('on')); // <=3 huruf
});
