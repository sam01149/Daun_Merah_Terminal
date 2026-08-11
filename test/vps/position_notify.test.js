// test/vps/position_notify.test.js — Notifikasi Telegram posisi manual open
// (rapat user, 2026-08-11): headline yang menyentuh currency kaki pair yang
// sedang open di jurnal manual (setup_log:v1), plus rilis kalender ekonomi
// impact High. Cakupan pure functions saja (bagian async/Redis/Telegram dites
// via simulasi lokal manual, bukan node:test — pola sama position_review.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pairToLegs, matchOpenPairsToHeadline, isDuplicateHeadline, detectEconCountryCurrency,
  POSNOTIFY_DEDUP_WINDOW_MS, POSNOTIFY_OVERLAP_THRESHOLD,
} = require('../../vps/daemon.js');

// ── pairToLegs ───────────────────────────────────────────────────────────────

test('pairToLegs: "EUR/USD" -> ["EUR","USD"]', () => {
  assert.deepEqual(pairToLegs('EUR/USD'), ['EUR', 'USD']);
});

test('pairToLegs: lowercase & whitespace dinormalisasi', () => {
  assert.deepEqual(pairToLegs(' eur / usd '), ['EUR', 'USD']);
});

test('pairToLegs: input kosong/null -> array kosong', () => {
  assert.deepEqual(pairToLegs(''), []);
  assert.deepEqual(pairToLegs(null), []);
});

// ── matchOpenPairsToHeadline ─────────────────────────────────────────────────

test('matchOpenPairsToHeadline: headline USD match pair EUR/USD yang open', () => {
  const matched = matchOpenPairsToHeadline(['EUR/USD'], ['USD']);
  assert.deepEqual(matched, ['EUR/USD']);
});

test('matchOpenPairsToHeadline: >1 posisi share currency yang sama -> semua digabung (keputusan rapat)', () => {
  const matched = matchOpenPairsToHeadline(['EUR/USD', 'GBP/USD', 'EUR/JPY'], ['USD']);
  assert.deepEqual(matched, ['EUR/USD', 'GBP/USD']);
});

test('matchOpenPairsToHeadline: tidak ada posisi open yang match -> array kosong', () => {
  assert.deepEqual(matchOpenPairsToHeadline(['EUR/JPY'], ['USD']), []);
});

test('matchOpenPairsToHeadline: tidak ada posisi open sama sekali -> array kosong', () => {
  assert.deepEqual(matchOpenPairsToHeadline([], ['USD']), []);
});

test('matchOpenPairsToHeadline: headline tidak match currency apa pun -> array kosong', () => {
  assert.deepEqual(matchOpenPairsToHeadline(['EUR/USD'], []), []);
});

test('matchOpenPairsToHeadline: XAU/USD open, headline gold (leg XAU) -> match', () => {
  assert.deepEqual(matchOpenPairsToHeadline(['XAU/USD'], ['XAU']), ['XAU/USD']);
});

// ── isDuplicateHeadline (anti wire re-hash, BUKAN korroborasi) ───────────────

test('isDuplicateHeadline: overlap token >= threshold dalam window -> duplikat', () => {
  const now = Date.now();
  const recentSent = [{ tokens: new Set(['powell', 'rate', 'cuts', 'likely']), sentAt: now - 60000 }];
  const newTokens = new Set(['powell', 'rate', 'cuts', 'this', 'year']);
  assert.equal(isDuplicateHeadline(newTokens, recentSent, now), true);
});

test('isDuplicateHeadline: overlap di bawah threshold -> bukan duplikat (cerita berbeda)', () => {
  const now = Date.now();
  const recentSent = [{ tokens: new Set(['powell', 'rate', 'cuts']), sentAt: now - 60000 }];
  const newTokens = new Set(['ecb', 'lagarde', 'inflation']);
  assert.equal(isDuplicateHeadline(newTokens, recentSent, now), false);
});

test('isDuplicateHeadline: overlap tinggi tapi SUDAH lewat window -> bukan duplikat lagi', () => {
  const now = Date.now();
  const recentSent = [{ tokens: new Set(['powell', 'rate', 'cuts', 'likely']), sentAt: now - (POSNOTIFY_DEDUP_WINDOW_MS + 1000) }];
  const newTokens = new Set(['powell', 'rate', 'cuts', 'likely']);
  assert.equal(isDuplicateHeadline(newTokens, recentSent, now), false);
});

test('isDuplicateHeadline: recentSent kosong -> tidak pernah duplikat', () => {
  assert.equal(isDuplicateHeadline(new Set(['a', 'b', 'c']), [], Date.now()), false);
});

test('isDuplicateHeadline: threshold sesuai kesepakatan rapat (3, lebih ketat dari korroborasi 2)', () => {
  assert.equal(POSNOTIFY_OVERLAP_THRESHOLD, 3);
});

// ── detectEconCountryCurrency ────────────────────────────────────────────────

test('detectEconCountryCurrency: headline rilis kalender US -> USD', () => {
  assert.equal(detectEconCountryCurrency('US Nonfarm Payrolls Actual 147K (Forecast 110K, Previous 139K)'), 'USD');
});

test('detectEconCountryCurrency: headline rilis kalender UK -> GBP', () => {
  assert.equal(detectEconCountryCurrency('UK GDP Actual 0.2% (Forecast 0.1%, Previous 0.0%)'), 'GBP');
});

test('detectEconCountryCurrency: headline rilis kalender Eurozone -> EUR', () => {
  assert.equal(detectEconCountryCurrency('Eurozone CPI Actual 2.1% (Forecast 2.0%, Previous 1.9%)'), 'EUR');
});

test('detectEconCountryCurrency: headline rilis kalender Australia -> AUD', () => {
  assert.equal(detectEconCountryCurrency('Australia Retail Sales Actual -0.2% (Forecast 0.3%, Previous 0.5%)'), 'AUD');
});

test('detectEconCountryCurrency: nama negara di TENGAH judul (bukan prefix) -> tidak match (hindari false positive "us" sbg pronoun)', () => {
  assert.equal(detectEconCountryCurrency('Analysts tell us Japan GDP beat forecast'), null);
});

test('detectEconCountryCurrency: headline non-kalender apa pun -> null', () => {
  assert.equal(detectEconCountryCurrency('Fed Chair Powell signals rate pause'), null);
});
