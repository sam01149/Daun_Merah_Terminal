// test/vps/auto_entry.test.js — Plan U-3 (vps/daemon.js): scheduler auto-entry
// virtual, filter berita keras, uji konsistensi LLM. Cakupan pure functions
// saja (bagian async/Redis/HTTP dites via simulasi lokal manual, bukan node:test
// — lihat catatan Kriteria Selesai di daun_merah_plan.md §Plan U-3).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  legsFromLabel, calEventMsWib, findHardNewsEvent, findRecentHardNewsEvent, firstNumber,
  levelsWithinTolerance, computeConsistency, AUTO_ENTRY_SYMBOL_MAP,
  AUTO_ENTRY_PAIRS, BREAKING_NEWS_SKIP_WINDOW_MS,
  computeSurpriseRatio, findSurpriseEvent, SURPRISE_RATIO_THRESHOLD, SURPRISE_CURRENCIES,
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

// ── findRecentHardNewsEvent (audit S277, 2026-08-04 — companion ke findHardNewsEvent,
// cek ke BELAKANG: event High-impact yang baru saja rilis masih dianggap berisiko) ──

test('findRecentHardNewsEvent: event High-impact currency cocok, rilis 30 menit lalu -> ditemukan', () => {
  const nowMs = Date.parse('2026-07-23T12:30:00.000Z');
  const events = [
    { impact: 'High', currency: 'EUR', event: 'ECB Rate', date: '2026-07-23', time_wib: '19:00 WIB' }, // 12:00Z, 30 menit lalu
  ];
  const hit = findRecentHardNewsEvent(events, ['EUR', 'USD'], nowMs, 60 * 60 * 1000);
  assert.equal(hit && hit.event, 'ECB Rate');
});

test('findRecentHardNewsEvent: event rilis PERSIS di luar window (>1 jam lalu) -> null', () => {
  const nowMs = Date.parse('2026-07-23T13:01:00.000Z');
  const events = [
    { impact: 'High', currency: 'EUR', event: 'ECB Rate', date: '2026-07-23', time_wib: '19:00 WIB' }, // 12:00Z, 1 jam 1 menit lalu
  ];
  assert.equal(findRecentHardNewsEvent(events, ['EUR'], nowMs, 60 * 60 * 1000), null);
});

test('findRecentHardNewsEvent: event BELUM rilis (masih di masa depan) -> null (bukan tugas fungsi ini)', () => {
  const nowMs = Date.parse('2026-07-23T10:00:00.000Z');
  const events = [
    { impact: 'High', currency: 'EUR', event: 'ECB Rate', date: '2026-07-23', time_wib: '19:15 WIB' }, // 12:15Z, akan datang
  ];
  assert.equal(findRecentHardNewsEvent(events, ['EUR'], nowMs, 60 * 60 * 1000), null);
});

test('findRecentHardNewsEvent: currency tidak cocok -> null', () => {
  const nowMs = Date.parse('2026-07-23T12:30:00.000Z');
  const events = [{ impact: 'High', currency: 'JPY', event: 'BOJ', date: '2026-07-23', time_wib: '19:00 WIB' }];
  assert.equal(findRecentHardNewsEvent(events, ['EUR', 'USD'], nowMs, 60 * 60 * 1000), null);
});

test('findRecentHardNewsEvent: impact Medium/Low diabaikan walau currency cocok & baru rilis', () => {
  const nowMs = Date.parse('2026-07-23T12:30:00.000Z');
  const events = [{ impact: 'Medium', currency: 'EUR', event: 'PMI', date: '2026-07-23', time_wib: '19:00 WIB' }];
  assert.equal(findRecentHardNewsEvent(events, ['EUR'], nowMs, 60 * 60 * 1000), null);
});

test('findRecentHardNewsEvent: default window = BREAKING_NEWS_SKIP_WINDOW_MS (1 jam)', () => {
  const nowMs = Date.parse('2026-07-23T12:30:00.000Z');
  const events = [{ impact: 'High', currency: 'EUR', event: 'ECB Rate', date: '2026-07-23', time_wib: '19:00 WIB' }];
  const hit = findRecentHardNewsEvent(events, ['EUR'], nowMs); // windowMs tidak dipassing
  assert.equal(hit && hit.event, 'ECB Rate');
  assert.equal(BREAKING_NEWS_SKIP_WINDOW_MS, 60 * 60 * 1000);
});

test('findRecentHardNewsEvent: array events kosong/bukan array -> null, bukan crash', () => {
  assert.equal(findRecentHardNewsEvent([], ['EUR'], Date.now()), null);
  assert.equal(findRecentHardNewsEvent(null, ['EUR'], Date.now()), null);
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

test('AUTO_ENTRY_PAIRS: default redesain independensi 4 pair (tanpa env var override)', () => {
  assert.deepEqual(AUTO_ENTRY_PAIRS, ['frxXAUUSD', 'frxEURUSD', 'frxAUDNZD', 'frxEURGBP']);
  for (const pair of AUTO_ENTRY_PAIRS) {
    assert.ok(AUTO_ENTRY_SYMBOL_MAP[pair], `${pair} harus terpetakan di AUTO_ENTRY_SYMBOL_MAP`);
  }
});

test('AUTO_ENTRY_SYMBOL_MAP: AUD/NZD & EUR/GBP (pengganti GBP/USD) terpetakan', () => {
  assert.deepEqual(AUTO_ENTRY_SYMBOL_MAP.frxAUDNZD, { symbol: 'AUDNZD=X', label: 'AUD/NZD' });
  assert.deepEqual(AUTO_ENTRY_SYMBOL_MAP.frxEURGBP, { symbol: 'EURGBP=X', label: 'EUR/GBP' });
});

// ── Plan X (2026-08-04): computeSurpriseRatio ────────────────────────────────

test('computeSurpriseRatio: surprise normal (actual jauh dari forecast -> ratio tinggi)', () => {
  // Kasus asli audit S277: AUD Household Spending actual 0.8 vs forecast 0.2 -> beat 4x
  const ratio = computeSurpriseRatio({ actualRaw: 0.8, forecastRaw: 0.2, previousRaw: 0.1 });
  assert.ok(ratio >= SURPRISE_RATIO_THRESHOLD, `ratio ${ratio} harusnya >= ambang ${SURPRISE_RATIO_THRESHOLD}`);
  assert.ok(Math.abs(ratio - 3) < 1e-9);
});

test('computeSurpriseRatio: forecast_raw=0 fallback ke previous_raw sebagai basis', () => {
  const ratio = computeSurpriseRatio({ actualRaw: 5, forecastRaw: 0, previousRaw: 2 });
  assert.equal(ratio, 2.5); // |5-0| / |2|
});

test('computeSurpriseRatio: actual_raw belum ada -> null (bukan 0)', () => {
  assert.equal(computeSurpriseRatio({ actualRaw: null, forecastRaw: 0.2, previousRaw: 0.1 }), null);
  assert.equal(computeSurpriseRatio({ actualRaw: undefined, forecastRaw: 0.2, previousRaw: 0.1 }), null);
});

test('computeSurpriseRatio: forecast DAN previous sama-sama tidak ada -> null', () => {
  assert.equal(computeSurpriseRatio({ actualRaw: 5, forecastRaw: 0, previousRaw: 0 }), null);
  assert.equal(computeSurpriseRatio({ actualRaw: 5, forecastRaw: null, previousRaw: null }), null);
});

test('computeSurpriseRatio: forecast_raw null (bukan 0) TIDAK fallback ke previous -> null', () => {
  assert.equal(computeSurpriseRatio({ actualRaw: 5, forecastRaw: null, previousRaw: 2 }), null);
});

// ── Plan X (2026-08-04): findSurpriseEvent ───────────────────────────────────

test('findSurpriseEvent: event dalam window 1 jam & ratio >= ambang -> ditemukan', () => {
  const nowMs = Date.parse('2026-08-04T01:30:00.000Z'); // 08:30 WIB
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  const hit = findSurpriseEvent(events, ['AUD', 'NZD'], nowMs);
  assert.equal(hit && hit.event, 'Household Spending MoM');
  assert.ok(hit.ratio >= SURPRISE_RATIO_THRESHOLD);
});

test('findSurpriseEvent: event di luar window (>1 jam lalu) -> null', () => {
  const nowMs = Date.parse('2026-08-04T02:30:00.000Z'); // 09:30 WIB, event 08:00 WIB = 1.5 jam lalu
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  assert.equal(findSurpriseEvent(events, ['AUD'], nowMs), null);
});

test('findSurpriseEvent: event belum rilis (masih di masa depan) -> null', () => {
  const nowMs = Date.parse('2026-08-04T00:30:00.000Z'); // 07:30 WIB, event 08:00 WIB belum terjadi
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  assert.equal(findSurpriseEvent(events, ['AUD'], nowMs), null);
});

test('findSurpriseEvent: currency tidak cocok -> null', () => {
  const nowMs = Date.parse('2026-08-04T01:30:00.000Z');
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  assert.equal(findSurpriseEvent(events, ['USD', 'JPY'], nowMs), null);
});

test('findSurpriseEvent: ratio di bawah ambang -> null', () => {
  const nowMs = Date.parse('2026-08-04T01:30:00.000Z');
  const events = [{
    currency: 'AUD', event: 'CPI QoQ', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 1.0, previous_raw: 0.9, actual_raw: 1.05, // ratio 0.05, jauh di bawah 1.0
  }];
  assert.equal(findSurpriseEvent(events, ['AUD'], nowMs), null);
});

test('findSurpriseEvent: actual_raw belum terisi -> null (bukan dianggap tidak-surprise)', () => {
  const nowMs = Date.parse('2026-08-04T01:30:00.000Z');
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: null,
  }];
  assert.equal(findSurpriseEvent(events, ['AUD'], nowMs), null);
});

test('findSurpriseEvent: array kosong/bukan array -> null, bukan crash', () => {
  assert.equal(findSurpriseEvent([], ['AUD'], Date.now()), null);
  assert.equal(findSurpriseEvent(null, ['AUD'], Date.now()), null);
});

test('findSurpriseEvent: default window = BREAKING_NEWS_SKIP_WINDOW_MS (1 jam)', () => {
  const nowMs = Date.parse('2026-08-04T01:30:00.000Z');
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:00 WIB',
    forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  const hit = findSurpriseEvent(events, ['AUD'], nowMs); // windowMs tidak dipassing
  assert.ok(hit);
});

// ── Plan X (2026-08-04): SURPRISE_CURRENCIES ─────────────────────────────────

test('SURPRISE_CURRENCIES: persis {USD,EUR,GBP,AUD,NZD}, diturunkan dari AUTO_ENTRY_PAIRS aktif', () => {
  assert.deepEqual([...SURPRISE_CURRENCIES].sort(), ['AUD', 'EUR', 'GBP', 'NZD', 'USD']);
});

// ── Plan X (2026-08-04): replay retroaktif kasus AUD/NZD (audit S277) ────────

test('Plan X replay: Household Spending AUD beat 4x (actual 0.8 vs forecast 0.2) memicu surprise skip retroaktif', () => {
  // Data historis: rilis 2026-08-04 01:30 UTC (08:30 WIB), importance:-1 (Low) di
  // TradingView -> findSurpriseEvent TIDAK peduli impact, murni rasio numerik.
  const events = [{
    currency: 'AUD', event: 'Household Spending MoM', date: '2026-08-04', time_wib: '08:30 WIB',
    impact: 'Low', forecast_raw: 0.2, previous_raw: 0.1, actual_raw: 0.8,
  }];
  const nowMs = Date.parse('2026-08-04T02:00:00.000Z'); // 30 menit setelah rilis
  const legs = legsFromLabel('AUD/NZD');
  const hit = findSurpriseEvent(events, legs, nowMs);
  assert.ok(hit, 'seharusnya terdeteksi sebagai surprise walau impact Low di vendor');
  assert.ok(hit.ratio >= SURPRISE_RATIO_THRESHOLD);
});
