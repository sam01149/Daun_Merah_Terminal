// test/vps/auto_entry.test.js — Plan U-3 (vps/daemon.js): scheduler auto-entry
// virtual, filter berita keras, uji konsistensi LLM. Cakupan pure functions
// saja (bagian async/Redis/HTTP dites via simulasi lokal manual, bukan node:test
// — lihat catatan Kriteria Selesai di daun_merah_plan.md §Plan U-3).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  legsFromLabel, calEventMsWib, findHardNewsEvent, firstNumber,
  levelsWithinTolerance, computeConsistency, AUTO_ENTRY_SYMBOL_MAP,
} = require('../../vps/daemon.js');

// ── legsFromLabel ────────────────────────────────────────────────────────────

test('legsFromLabel: split label pair jadi 2 currency', () => {
  assert.deepEqual(legsFromLabel('XAU/USD'), ['XAU', 'USD']);
  assert.deepEqual(legsFromLabel('eur/usd'), ['EUR', 'USD']);
});

test('legsFromLabel: input kosong/null -> array kosong, bukan crash', () => {
  assert.deepEqual(legsFromLabel(null), []);
  assert.deepEqual(legsFromLabel(''), []);
});

// ── calEventMsWib ─────────────────────────────────────────────────────────────

test('calEventMsWib: parse tanggal+jam WIB jadi epoch ms', () => {
  const ms = calEventMsWib('2026-07-23', '19:15 WIB');
  assert.equal(new Date(ms).toISOString(), '2026-07-23T12:15:00.000Z');
});

test('calEventMsWib: "Tentative" atau field kosong -> null', () => {
  assert.equal(calEventMsWib('2026-07-23', 'Tentative'), null);
  assert.equal(calEventMsWib(null, '19:15 WIB'), null);
  assert.equal(calEventMsWib('2026-07-23', null), null);
  assert.equal(calEventMsWib('2026-07-23', 'bukan-jam'), null);
});

// ── findHardNewsEvent ─────────────────────────────────────────────────────────

test('findHardNewsEvent: event High-impact currency cocok dalam window -> ditemukan', () => {
  const nowMs = Date.parse('2026-07-23T10:00:00.000Z');
  const events = [
    { impact: 'High', currency: 'EUR', event: 'ECB Rate', date: '2026-07-23', time_wib: '19:15 WIB' }, // 12:15Z, 2h15m dari now
  ];
  const hit = findHardNewsEvent(events, ['EUR', 'USD'], nowMs, 4 * 3600 * 1000);
  assert.equal(hit && hit.event, 'ECB Rate');
});

test('findHardNewsEvent: currency tidak cocok -> null', () => {
  const nowMs = Date.parse('2026-07-23T10:00:00.000Z');
  const events = [{ impact: 'High', currency: 'JPY', event: 'BOJ', date: '2026-07-23', time_wib: '19:15 WIB' }];
  assert.equal(findHardNewsEvent(events, ['EUR', 'USD'], nowMs, 4 * 3600 * 1000), null);
});

test('findHardNewsEvent: impact Medium/Low diabaikan walau currency cocok', () => {
  const nowMs = Date.parse('2026-07-23T10:00:00.000Z');
  const events = [{ impact: 'Medium', currency: 'EUR', event: 'PMI', date: '2026-07-23', time_wib: '19:15 WIB' }];
  assert.equal(findHardNewsEvent(events, ['EUR', 'USD'], nowMs, 4 * 3600 * 1000), null);
});

test('findHardNewsEvent: event di luar window (>4 jam ke depan atau sudah lewat) -> null', () => {
  const nowMs = Date.parse('2026-07-23T10:00:00.000Z');
  const tooFar = [{ impact: 'High', currency: 'EUR', event: 'ECB', date: '2026-07-24', time_wib: '19:15 WIB' }];
  assert.equal(findHardNewsEvent(tooFar, ['EUR'], nowMs, 4 * 3600 * 1000), null);
  const past = [{ impact: 'High', currency: 'EUR', event: 'ECB', date: '2026-07-23', time_wib: '09:00 WIB' }];
  assert.equal(findHardNewsEvent(past, ['EUR'], nowMs, 4 * 3600 * 1000), null);
});

test('findHardNewsEvent: array events kosong/bukan array -> null, bukan crash', () => {
  assert.equal(findHardNewsEvent([], ['EUR'], Date.now()), null);
  assert.equal(findHardNewsEvent(null, ['EUR'], Date.now()), null);
});

// ── firstNumber ───────────────────────────────────────────────────────────────

test('firstNumber: ekstrak angka pertama dari string level', () => {
  assert.equal(firstNumber('1.1712'), 1.1712);
  assert.equal(firstNumber('1.1700 - 1.1720'), 1.17);
  assert.equal(firstNumber(null), null);
  assert.equal(firstNumber(undefined), null);
  assert.equal(firstNumber('null'), null);
});

// ── levelsWithinTolerance ──────────────────────────────────────────────────────

test('levelsWithinTolerance: 3 nilai rapat (<0.5%) -> true', () => {
  assert.equal(levelsWithinTolerance([1.1700, 1.1703, 1.1698]), true);
});

test('levelsWithinTolerance: 3 nilai melompat jauh -> false', () => {
  assert.equal(levelsWithinTolerance([1.1700, 1.2000, 1.1650]), false);
});

test('levelsWithinTolerance: semua null (no-trade konsisten di 3 call) -> true', () => {
  assert.equal(levelsWithinTolerance([null, null, null]), true);
});

test('levelsWithinTolerance: sebagian ada level sebagian tidak -> false (tidak konsisten)', () => {
  assert.equal(levelsWithinTolerance([1.17, null, 1.171]), false);
});

// ── computeConsistency ─────────────────────────────────────────────────────────

test('computeConsistency: 3 call identik bias + level rapat -> bias_identical & levels_within_tolerance true', () => {
  const calls = [
    { bias: 'bullish', entry_zone: '1.1700', sl: '1.1650', tp: '1.1800' },
    { bias: 'bullish', entry_zone: '1.1702', sl: '1.1651', tp: '1.1799' },
    { bias: 'bullish', entry_zone: '1.1699', sl: '1.1649', tp: '1.1801' },
  ];
  const r = computeConsistency(calls);
  assert.equal(r.bias_identical, true);
  assert.equal(r.levels_within_tolerance, true);
});

test('computeConsistency: bias beda antar call -> bias_identical false', () => {
  const calls = [
    { bias: 'bullish', entry_zone: '1.17', sl: '1.16', tp: '1.18' },
    { bias: 'bearish', entry_zone: '1.17', sl: '1.18', tp: '1.16' },
    { bias: 'bullish', entry_zone: '1.17', sl: '1.16', tp: '1.18' },
  ];
  assert.equal(computeConsistency(calls).bias_identical, false);
});

test('computeConsistency: call gagal (null) dihitung sebagai tidak konsisten', () => {
  const calls = [
    { bias: 'bullish', entry_zone: '1.17', sl: '1.16', tp: '1.18' },
    null,
    { bias: 'bullish', entry_zone: '1.17', sl: '1.16', tp: '1.18' },
  ];
  const r = computeConsistency(calls);
  assert.equal(r.bias_identical, false);
  assert.equal(r.levels_within_tolerance, false);
});

// ── AUTO_ENTRY_SYMBOL_MAP ───────────────────────────────────────────────────────

test('AUTO_ENTRY_SYMBOL_MAP: default pairs (frxXAUUSD, frxEURUSD) terpetakan', () => {
  assert.deepEqual(AUTO_ENTRY_SYMBOL_MAP.frxXAUUSD, { symbol: 'GC=F', label: 'XAU/USD' });
  assert.deepEqual(AUTO_ENTRY_SYMBOL_MAP.frxEURUSD, { symbol: 'EURUSD=X', label: 'EUR/USD' });
});
