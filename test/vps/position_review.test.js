// test/vps/position_review.test.js — Plan U-5b (vps/daemon.js): trigger review
// posisi event-driven + heuristik UNCONFIRMED. Cakupan pure functions saja
// (bagian async/Redis/HTTP dites via simulasi lokal manual, bukan node:test —
// pola sama U-3, lihat test/vps/auto_entry.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectCurrencyLegs, isCorroborated, posReviewSignificantTokens, POSREVIEW_CURRENCY_KEYWORDS,
  legsFromLabel, findBreakingNewsMatch, shouldPersistNewsBufferItem, filterFreshBufferItems,
  POSREVIEW_NEWS_BUFFER_MS, BREAKING_NEWS_SKIP_WINDOW_MS,
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

// Audit S218 (2026-07-23): headline guncangan pasokan energi Teluk (Iran mengancam
// tutup arus minyak Hormuz) relevan ke XAU via rantai safe-haven/inflasi, tapi
// sebelum ini cuma cocok kalau literally sebut "gold"/"xau"/"bullion" — headline
// nyata "Iran will stop all Gulf oil flow..." lolos tanpa terdeteksi sama sekali.
test('detectCurrencyLegs: headline guncangan pasokan minyak Teluk (tanpa kata "gold") match XAU', () => {
  const title = "Iran's Top Joint Military Command: If the US acts on threats, Iran will stop all Gulf oil flow and target oil, gas, electricity and economic infrastructure in the region - State Media";
  assert.deepEqual(detectCurrencyLegs(title), ['XAU']);
});

test('detectCurrencyLegs: "hormuz"/"opec" bare juga match XAU', () => {
  assert.deepEqual(detectCurrencyLegs('Tensions rise near Strait of Hormuz'), ['XAU']);
  assert.deepEqual(detectCurrencyLegs('OPEC+ considers emergency production cut'), ['XAU']);
});

// BUG DITEMUKAN & DIFIX (audit S277, 2026-08-04): matching sebelumnya substring
// polos (`t.includes(kw)`) — "Saudi official..." salah match leg AUD gara-gara
// kata "Saudi" mengandung substring "aud". Ditemukan live saat audit trade AUD/NZD
// (guid 9705618 salah match). Word-boundary regex sekarang mencegah ini.
test('detectCurrencyLegs: "Saudi" TIDAK salah match leg AUD (substring "aud" di tengah kata)', () => {
  assert.deepEqual(detectCurrencyLegs("Iran's General Rezaei: Saudi official denies involvement"), []);
});

test('detectCurrencyLegs: kata whole-word "aud"/"AUD" tetap match leg AUD seperti biasa', () => {
  // "AUD/USD" mengandung dua whole-word currency sekaligus (dipisah "/") -> dua leg,
  // beda dari kasus "Saudi" di atas (substring "aud" DI TENGAH kata, bukan whole-word).
  assert.deepEqual(detectCurrencyLegs('AUD/USD rallies on strong retail sales'), ['USD', 'AUD']);
  // "dollar" juga keyword USD yang sah (bukan bug) — "Aussie dollar" secara wajar
  // relevan kedua leg, ganti contoh yang murni AUD saja.
  assert.deepEqual(detectCurrencyLegs('RBA holds rates steady amid inflation concerns'), ['AUD']);
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

test('isCorroborated: kategori lain (bukan market-moving/geopolitical/energy) -> false', () => {
  assert.equal(isCorroborated({ cat: 'lainnya', title: 'x', pubDate: '2026-07-20T10:00:00Z' }, []), false);
});

// Audit S218 (2026-07-23): 'energy' sekarang ikut disyaratkan korroborasi, sama
// seperti 'geopolitical' — sebelum ini kategori selain market-moving/geopolitical
// lolos TANPA korroborasi sama sekali (celah).
test('isCorroborated: energy satu item sendirian -> false (unconfirmed, sama seperti geopolitical)', () => {
  const item = { cat: 'energy', title: 'Oil surges after Iran strikes tanker near Hormuz', pubDate: '2026-07-23T01:45:00Z', guid: 'a' };
  assert.equal(isCorroborated(item, [item]), false);
});

test('isCorroborated: energy + item lain guid beda, overlap >=2 token dalam 30 menit -> true', () => {
  const item = { cat: 'energy', title: 'Oil surges after Iran strikes tanker near Hormuz', pubDate: '2026-07-23T01:45:00Z', guid: 'a' };
  const other = { title: "Iran's military strikes tanker in Hormuz, oil jumps", pubDate: '2026-07-23T01:46:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), true);
});

// Audit S274 (2026-08-03): 'macro' (pidato bank sentral, Powell/Lagarde/dst) sekarang
// ikut disyaratkan korroborasi, sama seperti geopolitical/energy — sebelum ini BUG
// (bukan cuma "belum disyaratkan"): tryTriggerPosReview (vps/daemon.js) memanggil
// isCorroborated tapi gate-nya cuma cek geopolitical/energy, jadi 'macro' lolos
// TANPA korroborasi sama sekali padahal isCorroborated sendiri sudah return false.
test('isCorroborated: macro satu item sendirian -> false (unconfirmed, sama seperti geopolitical/energy)', () => {
  const item = { cat: 'macro', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z', guid: 'a' };
  assert.equal(isCorroborated(item, [item]), false);
});

test('isCorroborated: macro + item lain guid beda, overlap >=2 token dalam 30 menit -> true', () => {
  const item = { cat: 'macro', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z', guid: 'a' };
  const other = { title: 'Fed chair Powell hints emergency policy shift coming soon', pubDate: '2026-08-03T01:50:00Z', guid: 'b' };
  assert.equal(isCorroborated(item, [item, other]), true);
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
    [{ cat: 'energy', title: 'Oil surges after Iran strikes tanker near Hormuz', pubDate: '2026-07-23T01:45:00Z', guid: 'a' },
      [{ title: "Iran's military strikes tanker in Hormuz, oil jumps", pubDate: '2026-07-23T01:46:00Z', guid: 'b' }]],
    [{ cat: 'macro', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z', guid: 'a' }, []],
    [{ cat: 'macro', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z', guid: 'a' },
      [{ title: 'Fed chair Powell hints emergency policy shift coming soon', pubDate: '2026-08-03T01:50:00Z', guid: 'b' }]],
  ];
  for (const [item, recent] of cases) {
    assert.equal(isCorroborated(item, recent), apiPositionReview.isCorroborated(item, recent),
      `hasil beda untuk item "${item.title}"`);
  }
});

// ── posReviewSignificantTokens ───────────────────────────────────────────────

// ── findBreakingNewsMatch (Lapis 1b, audit S218 2026-07-23) ──────────────────
// Skenario nyata yang memicu perbaikan ini: dua headline "Iran's Top Joint
// Military Command" 1 menit berbeda (01:45/01:46, 23 Jul) soal ancaman menutup
// arus minyak Gulf/Hormuz. Headline pertama match XAU via kata kunci minyak/Gulf
// baru (bukan literally "gold"), headline kedua jadi partner korroborasi.
const IRAN_OIL_THREAT = {
  cat: 'geopolitical', guid: 'iran-1',
  title: "Iran's Top Joint Military Command: If the US acts on threats, Iran will stop all Gulf oil flow and target oil, gas, electricity and economic infrastructure in the region - State Media",
  pubDate: '2026-07-23T01:45:00Z',
};
const IRAN_WAR_EXPANSION = {
  cat: 'geopolitical', guid: 'iran-2',
  title: "Iran's Top Joint Military Command: Trump's repeated threats will only lead to expansion of war in the region and beyond - State Media",
  pubDate: '2026-07-23T01:46:00Z',
};

// nowMs dekat pubDate fixture (beberapa menit setelahnya) — findBreakingNewsMatch
// sekarang punya window recency eksplisit (default 1 jam, audit S277), jadi harus
// dites relatif terhadap waktu fixture, bukan Date.now() nyata saat test jalan.
const IRAN_NOW_MS = Date.parse('2026-07-23T01:50:00Z');

test('findBreakingNewsMatch: skenario nyata Iran-Gulf oil (2 headline berdekatan) -> match untuk pair XAU/USD', () => {
  const pairLegs = legsFromLabel('XAU/USD');
  const buffer = [IRAN_OIL_THREAT, IRAN_WAR_EXPANSION];
  const match = findBreakingNewsMatch(pairLegs, buffer, IRAN_NOW_MS);
  assert.ok(match, 'harus ketemu match — headline oil-threat relevan XAU dan terkorroborasi headline kedua');
  assert.equal(match.guid, 'iran-1');
});

test('findBreakingNewsMatch: headline sendirian tanpa korroborasi -> tidak match (belum terkonfirmasi)', () => {
  const pairLegs = legsFromLabel('XAU/USD');
  assert.equal(findBreakingNewsMatch(pairLegs, [IRAN_OIL_THREAT], IRAN_NOW_MS), null);
});

test('findBreakingNewsMatch: pair tidak relevan (GBP/USD, tidak ada leg XAU) -> tidak match', () => {
  const pairLegs = legsFromLabel('GBP/USD');
  const buffer = [IRAN_OIL_THREAT, IRAN_WAR_EXPANSION];
  assert.equal(findBreakingNewsMatch(pairLegs, buffer, IRAN_NOW_MS), null);
});

test('findBreakingNewsMatch: item relevan tapi di luar window recency (>1 jam sejak pubDate) -> tidak match', () => {
  const pairLegs = legsFromLabel('XAU/USD');
  const buffer = [IRAN_OIL_THREAT, IRAN_WAR_EXPANSION];
  const farFuture = IRAN_NOW_MS + BREAKING_NEWS_SKIP_WINDOW_MS + 60000; // 1 menit lewat window
  assert.equal(findBreakingNewsMatch(pairLegs, buffer, farFuture), null);
});

test('findBreakingNewsMatch: kategori di luar geopolitical/energy/macro/market-moving -> diabaikan', () => {
  const pairLegs = legsFromLabel('XAU/USD');
  const item = { cat: 'commodities', guid: 'c1', title: 'Gold demand rises in India festival season', pubDate: '2026-07-23T01:45:00Z' };
  const other = { cat: 'commodities', guid: 'c2', title: 'Gold jewelry demand strong in India festival', pubDate: '2026-07-23T01:46:00Z' };
  assert.equal(findBreakingNewsMatch(pairLegs, [item, other]), null);
});

// Audit S274 (2026-08-03): 'macro' (pidato bank sentral) sekarang ikut dicek Lapis 1b —
// sebelumnya headline sekelas ini TIDAK PERNAH bikin skip entry baru sama sekali.
test('findBreakingNewsMatch: macro terkorroborasi (pidato bank sentral, 2 headline berdekatan) -> match', () => {
  const pairLegs = legsFromLabel('EUR/USD');
  const buffer = [
    { cat: 'macro', guid: 'p1', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z' },
    { cat: 'macro', guid: 'p2', title: 'Fed chair Powell hints emergency policy shift coming soon', pubDate: '2026-08-03T01:50:00Z' },
  ];
  const match = findBreakingNewsMatch(pairLegs, buffer, Date.parse('2026-08-03T01:55:00Z'));
  assert.ok(match, 'harus ketemu match — pidato Fed terkorroborasi 2 headline');
  assert.equal(match.guid, 'p1');
});

test('findBreakingNewsMatch: macro sendirian tanpa korroborasi -> tidak match', () => {
  const pairLegs = legsFromLabel('EUR/USD');
  const item = { cat: 'macro', guid: 'p1', title: 'Powell signals surprise emergency policy shift ahead', pubDate: '2026-08-03T01:45:00Z' };
  assert.equal(findBreakingNewsMatch(pairLegs, [item]), null);
});

test('findBreakingNewsMatch: buffer/legs kosong -> null, tidak throw', () => {
  assert.equal(findBreakingNewsMatch([], [IRAN_OIL_THREAT]), null);
  assert.equal(findBreakingNewsMatch(['XAU'], []), null);
  assert.equal(findBreakingNewsMatch(null, null), null);
});

// ── Persist buffer korroborasi ke Redis (S218/S219 lanjutan, 2026-07-23) ─────
// Menutup celah "amnesia" korroborasi tiap daemon restart — cuma kategori yang
// benar-benar dipakai isCorroborated/gate yang di-persist (budget Redis).

test('shouldPersistNewsBufferItem: geopolitical/energy/macro/market-moving -> true', () => {
  assert.equal(shouldPersistNewsBufferItem({ cat: 'geopolitical' }), true);
  assert.equal(shouldPersistNewsBufferItem({ cat: 'energy' }), true);
  // 'macro' ditambah audit S274 (2026-08-03) — sekarang ikut disyaratkan korroborasi
  // (isCorroborated), jadi butuh persist buffer juga (survive restart), sama seperti
  // geopolitical/energy.
  assert.equal(shouldPersistNewsBufferItem({ cat: 'macro' }), true);
  assert.equal(shouldPersistNewsBufferItem({ cat: 'market-moving' }), true);
});

test('shouldPersistNewsBufferItem: kategori lain/null -> false', () => {
  assert.equal(shouldPersistNewsBufferItem({ cat: 'econ-data' }), false);
  assert.equal(shouldPersistNewsBufferItem({ cat: 'forex' }), false);
  assert.equal(shouldPersistNewsBufferItem(null), false);
});

test('filterFreshBufferItems: item segar dipertahankan, item basi (lewat POSREVIEW_NEWS_BUFFER_MS) dibuang', () => {
  const now = Date.parse('2026-07-23T02:00:00Z');
  const raw = [
    JSON.stringify({ title: 'fresh', pubDate: new Date(now - 15 * 60000).toISOString() }),
    JSON.stringify({ title: 'stale', pubDate: new Date(now - (POSREVIEW_NEWS_BUFFER_MS + 60000)).toISOString() }),
  ];
  const result = filterFreshBufferItems(raw, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'fresh');
});

// Audit S277 (2026-08-04): bug fix inti — retensi sekarang berbasis `_seenAt`
// (kapan daemon PERTAMA KALI memproses item), bukan `pubDate` (kapan berita
// dipublikasikan). Kasus nyata yang jadi pemicu fix ini: backlog pemrosesan ~89
// menit membuat item yang BARU SAJA tiba di sistem langsung dianggap basi dan
// di-prune berdasarkan pubDate — walau baru diproses beberapa detik lalu.
test('filterFreshBufferItems: item dengan pubDate LAMA tapi _seenAt BARU -> tetap dipertahankan (fix bug backlog)', () => {
  const now = Date.parse('2026-08-04T02:59:07Z');
  const raw = [
    // pubDate 89 menit sebelum now (jauh lewat window kalau dihitung dari pubDate),
    // tapi _seenAt persis "now" (baru saja diproses) -> harus tetap masuk.
    JSON.stringify({ title: 'backlog-tapi-baru-diproses', pubDate: '2026-08-04T01:30:20Z', _seenAt: now }),
  ];
  const result = filterFreshBufferItems(raw, now);
  assert.equal(result.length, 1, 'item harus dipertahankan berdasar _seenAt, bukan dibuang berdasar pubDate basi');
  assert.equal(result[0].title, 'backlog-tapi-baru-diproses');
});

test('filterFreshBufferItems: item TANPA _seenAt (data lama pra-fix) -> fallback ke pubDate, tidak crash', () => {
  const now = Date.parse('2026-07-23T02:00:00Z');
  const raw = [
    JSON.stringify({ title: 'legacy-fresh', pubDate: new Date(now - 15 * 60000).toISOString() }),
    JSON.stringify({ title: 'legacy-stale', pubDate: new Date(now - (POSREVIEW_NEWS_BUFFER_MS + 60000)).toISOString() }),
  ];
  const result = filterFreshBufferItems(raw, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'legacy-fresh');
});

test('filterFreshBufferItems: JSON korup dilewati diam-diam, tidak throw', () => {
  const now = Date.now();
  const raw = ['{bukan json valid', JSON.stringify({ title: 'ok', pubDate: new Date(now).toISOString() })];
  const result = filterFreshBufferItems(raw, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'ok');
});

test('filterFreshBufferItems: input null/kosong -> array kosong, tidak throw', () => {
  assert.deepEqual(filterFreshBufferItems(null, Date.now()), []);
  assert.deepEqual(filterFreshBufferItems([], Date.now()), []);
});

test('posReviewSignificantTokens: buang stopword & token pendek (<=3 huruf), lowercase', () => {
  const tokens = posReviewSignificantTokens('The Border Clash Is On Capital City');
  assert.ok(tokens.includes('border'));
  assert.ok(tokens.includes('clash'));
  assert.ok(tokens.includes('capital'));
  assert.ok(!tokens.includes('the')); // stopword
  assert.ok(!tokens.includes('is')); // <=3 huruf
  assert.ok(!tokens.includes('on')); // <=3 huruf
});
