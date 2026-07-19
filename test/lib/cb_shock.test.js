// test/cb_shock.test.js
// Plan G6 — FOMC/CB Shock Detector: classifier rule-based (tanpa AI) + reaksi
// per-jam + narasi deterministik. 4 kelas: policy_shock / information_shock /
// no_shock / insufficient_data.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOISE_BAND_PCT,
  computeHourlyReaction,
  classifyCbShock,
  buildShockNarrative,
  announceTsFromMeetingDate,
  CB_SHOCK_PROXY,
} = require('../../api/_cb_shock.js');

// ── classifyCbShock: 4 kelas ─────────────────────────────────────────────────

test('policy_shock: cut 25bps + currency melemah (searah keputusan)', () => {
  // AUD (bukan invert): pair turun 0.6% = AUD melemah, cut = arah negatif → searah
  const r = classifyCbShock({ changed: true, rateChangeBps: -25, pairMovePct: -0.6, invert: false });
  assert.equal(r.classification, 'policy_shock');
  assert.equal(r.currencyMovePct, -0.6);
});

test('policy_shock: hike 25bps + currency menguat', () => {
  const r = classifyCbShock({ changed: true, rateChangeBps: 25, pairMovePct: 0.5, invert: false });
  assert.equal(r.classification, 'policy_shock');
});

test('information_shock: keputusan berubah tapi harga BERLAWANAN arah', () => {
  // Cut tapi currency malah menguat (pasar baca "cut terakhir / hawkish cut")
  const r = classifyCbShock({ changed: true, rateChangeBps: -25, pairMovePct: 0.7, invert: false });
  assert.equal(r.classification, 'information_shock');
});

test('information_shock: hold tapi harga bergerak signifikan (guidance/presser)', () => {
  const r = classifyCbShock({ changed: false, rateChangeBps: 0, pairMovePct: 0.9, invert: false });
  assert.equal(r.classification, 'information_shock');
});

test('information_shock: cut lebih kecil dari yang di-price-in walau harga searah', () => {
  // Priced-in -50bps, keputusan cuma -25bps → efektif hawkish relatif ekspektasi
  const r = classifyCbShock({ changed: true, rateChangeBps: -25, expectedChangeBps: -50, pairMovePct: -0.6, invert: false });
  assert.equal(r.classification, 'information_shock');
});

test('no_shock: pergerakan dalam band noise ±0.3%', () => {
  assert.equal(classifyCbShock({ changed: true, rateChangeBps: -25, pairMovePct: 0.2, invert: false }).classification, 'no_shock');
  assert.equal(classifyCbShock({ changed: false, rateChangeBps: 0, pairMovePct: -0.29, invert: false }).classification, 'no_shock');
  assert.equal(NOISE_BAND_PCT, 0.3, 'heuristik tahap pertama ±0.3% (perlu kalibrasi live)');
});

test('insufficient_data: pairMovePct null/NaN → jangan menebak', () => {
  assert.equal(classifyCbShock({ changed: true, rateChangeBps: -25, pairMovePct: null }).classification, 'insufficient_data');
  assert.equal(classifyCbShock({ changed: true, rateChangeBps: -25, pairMovePct: NaN }).classification, 'insufficient_data');
});

test('invert: currency di sisi quote — arah pair dibalik (USD via EUR/USD)', () => {
  // Fed hike 25bps, EUR/USD turun 0.8% = USD MENGUAT → policy_shock utk USD
  const r = classifyCbShock({ changed: true, rateChangeBps: 25, pairMovePct: -0.8, invert: true });
  assert.equal(r.classification, 'policy_shock');
  assert.equal(r.currencyMovePct, 0.8);
});

// ── computeHourlyReaction ────────────────────────────────────────────────────

const T0 = Math.floor(Date.parse('2026-07-08T00:00:00Z') / 1000);
function mkCandles(startTs, closes) {
  return closes.map((c, i) => ({ t: startTs + i * 3600, o: c, h: c, l: c, c, v: 0 }));
}

test('computeHourlyReaction: % dari close pre-announce ke close +3 jam', () => {
  // Candle per jam 15:00..22:00 UTC. Announce 19:00 → baseline = candle 18:00
  // (candle terakhir SEBELUM announce, close 1.0); target = announce+3 jam =
  // candle 22:00 (close 1.02) → reaksi +2.0%.
  const candles = mkCandles(T0 + 15 * 3600, [1.0, 1.0, 1.0, 1.0, 1.005, 1.008, 1.010, 1.02]); // 15..22 UTC
  const announceTs = T0 + 19 * 3600;
  assert.equal(computeHourlyReaction(candles, announceTs, 3), 2.0);
  // Jendela lebih pendek (1 jam): target = candle 20:00 close 1.008 → +0.8%
  assert.equal(computeHourlyReaction(candles, announceTs, 1), 0.8);
});

test('computeHourlyReaction: baseline terlalu jauh (>3 jam, gap libur) → null', () => {
  const candles = mkCandles(T0, [1.0, 1.0]); // hanya 00:00-01:00 UTC
  const announceTs = T0 + 19 * 3600;
  assert.equal(computeHourlyReaction(candles, announceTs, 3), null);
});

test('computeHourlyReaction: tidak ada candle sesudah announce → null; input kosong → null', () => {
  const candles = mkCandles(T0 + 17 * 3600, [1.0, 1.0]); // 17:00, 18:00 saja
  assert.equal(computeHourlyReaction(candles, T0 + 19 * 3600, 3), null);
  assert.equal(computeHourlyReaction([], T0, 3), null);
  assert.equal(computeHourlyReaction(null, T0, 3), null);
});

// ── announceTsFromMeetingDate ────────────────────────────────────────────────

test('announceTsFromMeetingDate: FOMC (USD) = 19:00 UTC; tanggal rusak → null', () => {
  const ts = announceTsFromMeetingDate('2026-07-30', 'USD');
  assert.equal(new Date(ts * 1000).toISOString(), '2026-07-30T19:00:00.000Z');
  assert.equal(announceTsFromMeetingDate('30/07/2026', 'USD'), null);
  assert.equal(announceTsFromMeetingDate(null, 'USD'), null);
  assert.equal(announceTsFromMeetingDate('2026-07-30', 'XXX'), null);
});

// ── Narasi deterministik ─────────────────────────────────────────────────────

test('narasi: setiap kelas menghasilkan template Bahasa Indonesia yang sesuai', () => {
  const pol = buildShockNarrative({ classification: 'policy_shock', bank: 'Federal Reserve', currency: 'USD', rateChangeBps: -25, currencyMovePct: -0.8 });
  assert.match(pol, /policy shock/);
  assert.match(pol, /memangkas suku bunga 25bps/);

  const infoOpp = buildShockNarrative({ classification: 'information_shock', bank: 'Federal Reserve', currency: 'USD', rateChangeBps: -25, currencyMovePct: 0.7 });
  assert.match(infoOpp, /information shock/);
  assert.match(infoOpp, /justru menguat/);

  const infoHold = buildShockNarrative({ classification: 'information_shock', bank: 'ECB', currency: 'EUR', rateChangeBps: 0, currencyMovePct: 0.9 });
  assert.match(infoHold, /menahan suku bunga/);
  assert.match(infoHold, /guidance\/konferensi pers/);

  const none = buildShockNarrative({ classification: 'no_shock', bank: 'BoE', currency: 'GBP', rateChangeBps: 0, currencyMovePct: 0.1 });
  assert.match(none, /band noise/);

  const insuf = buildShockNarrative({ classification: 'insufficient_data', bank: 'BoJ', currency: 'JPY', rateChangeBps: 0, currencyMovePct: null });
  assert.match(insuf, /belum tersedia/);
});

// ── Proxy map: semua 8 currency major ter-cover ──────────────────────────────

test('CB_SHOCK_PROXY: 8 currency lengkap, arah invert benar utk quote currency', () => {
  for (const cur of ['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']) {
    assert.ok(CB_SHOCK_PROXY[cur], `proxy ${cur} harus ada`);
  }
  assert.equal(CB_SHOCK_PROXY.USD.invert, true,  'USD quote di EUR/USD');
  assert.equal(CB_SHOCK_PROXY.JPY.invert, true,  'JPY quote di USD/JPY');
  assert.equal(CB_SHOCK_PROXY.AUD.invert, false, 'AUD base di AUD/USD');
});
