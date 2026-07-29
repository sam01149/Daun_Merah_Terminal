// test/lib/cb_rates.test.js
// mergeCbRate() — logika prioritas gabungan live rate / cb_decisions (dec) / CB_FALLBACK.
// Regression guard untuk bug 2026-07-29: heuristik diff (live vs CB_FALLBACK statis)
// dulu SELALU menang kalau selisih >=5bps, walau `dec` (hasil parse headline resmi,
// paling akurat) sudah ada dan valid — lihat daun_merah.md Session 255/256.

const test = require('node:test');
const assert = require('node:assert/strict');
const { CB_FALLBACK, mergeCbRate } = require('../../api/_cb_rates.js');

const fb = CB_FALLBACK.EUR; // rate:2.15, last_meeting:'2026-04-30', last_decision:'hold', last_bps:0

test('dec menang walau diff live vs fallback >=5bps (bug lama: heuristik yang menang)', () => {
  const live = { rate: 2.40 }; // diff = +25bps vs fallback 2.15 -> rateChanged true
  const dec  = { last_meeting: '2026-06-15', last_decision: 'hike', last_bps: 25 };
  const r = mergeCbRate('EUR', fb, live, dec, 'live_fresh');
  assert.equal(r.last_decision, 'hike');
  assert.equal(r.last_bps, 25);
  assert.equal(r.last_meeting, '2026-06-15'); // dari dec, bukan fb.last_meeting
  assert.equal(r.rate, 2.40); // rate tetap dari live scrape
});

test('dec dengan angka BEDA dari diff live vs fallback tetap menang (bukan ditimpa heuristik)', () => {
  // Live drift 50bps (2 kali cut 25bps sejak fallback terakhir diupdate manual),
  // tapi dec (parse headline resmi) cuma catat keputusan TERAKHIR: cut 25bps.
  const live = { rate: 1.65 }; // diff = -50bps vs fallback 2.15
  const dec  = { last_meeting: '2026-06-15', last_decision: 'cut', last_bps: -25 };
  const r = mergeCbRate('EUR', fb, live, dec, 'live_fresh');
  assert.equal(r.last_decision, 'cut');
  assert.equal(r.last_bps, -25); // BUKAN -50 (angka heuristik diff)
});

test('tanpa dec sama sekali + diff besar -> heuristik jadi fallback darurat', () => {
  const live = { rate: 2.40 }; // diff = +25bps
  const r = mergeCbRate('EUR', fb, live, undefined, 'live_fresh');
  assert.equal(r.last_decision, 'hike');
  assert.equal(r.last_bps, 25);
  assert.equal(r.last_meeting, fb.last_meeting); // tidak ada dec -> tetap pakai fallback
});

test('tanpa dec, diff kecil (<5bps) -> tetap pakai fallback statis apa adanya', () => {
  const live = { rate: 2.17 }; // diff = +2bps, di bawah ambang 5bps
  const r = mergeCbRate('EUR', fb, live, undefined, 'live_fresh');
  assert.equal(r.last_decision, fb.last_decision);
  assert.equal(r.last_bps, fb.last_bps);
});

test('tidak ada live rate sama sekali -> full fallback ke CB_FALLBACK', () => {
  const r = mergeCbRate('EUR', fb, undefined, undefined, 'fallback');
  assert.equal(r.rate, fb.rate);
  assert.equal(r.last_decision, fb.last_decision);
  assert.equal(r.last_bps, fb.last_bps);
  assert.equal(r.rate_source, 'fallback');
});

test('dec.last_bps 0 (hold tercatat) tidak keliru fallback ke heuristik (?? bukan ||)', () => {
  const live = { rate: 2.40 }; // diff besar, tapi dec eksplisit bilang hold/0bps
  const dec  = { last_meeting: '2026-06-15', last_decision: 'hold', last_bps: 0 };
  const r = mergeCbRate('EUR', fb, live, dec, 'live_fresh');
  assert.equal(r.last_decision, 'hold');
  assert.equal(r.last_bps, 0);
});

test('output tidak lagi punya field rate_stale (dihapus, sudah tidak dipakai)', () => {
  const r = mergeCbRate('EUR', fb, { rate: 2.40 }, undefined, 'live_fresh');
  assert.equal('rate_stale' in r, false);
});
