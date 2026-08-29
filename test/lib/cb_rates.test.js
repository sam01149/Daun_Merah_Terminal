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

// ── Parser CSV FRED & BIS (audit S336, 2026-08-29) ───────────────────────────
// Regresi untuk dua bug yang bikin 6 dari 8 suku bunga bank sentral mati diam-diam.

const { _parseFredCsvLatest, _parseBisCbpol, _splitCsvLine } = require('../../api/_cb_rates.js');

test('FRED CSV: header baru `observation_date` tidak ikut terbaca sebagai data (bug S336 #1)', () => {
  // Header LAMA `DATE,...` dibuang oleh filter startsWith('DATE'); header BARU tidak —
  // itu yang bikin parseFloat('DFEDTARU') = NaN dan scrapeUSD selalu throw.
  const csv = 'observation_date,DFEDTARU\n2026-08-27,3.75\n2026-08-28,3.75';
  const r = _parseFredCsvLatest(csv, 'DFEDTARU');
  assert.equal(r.rate, 3.75);
  assert.equal(r.date, '2026-08-28');
});

test('FRED CSV: ambil observasi TERBARU (baris terakhir), bukan tertua (bug S336 #2)', () => {
  // fredgraph.csv mengabaikan sort_order=desc dan selalu kirim ASCENDING —
  // parser lama mengambil lines[0] = observasi paling tua (2008!).
  const csv = 'observation_date,DFEDTARU\n2008-12-16,0.25\n2020-03-16,0.25\n2026-08-29,3.75';
  const r = _parseFredCsvLatest(csv, 'DFEDTARU');
  assert.equal(r.rate, 3.75);
  assert.equal(r.date, '2026-08-29');
});

test('FRED CSV: baris kosong bertanda titik dilewati, mundur ke observasi valid', () => {
  const csv = 'observation_date,DGS10\n2026-08-26,4.65\n2026-08-27,4.67\n2026-08-28,.\n2026-08-29,.';
  const r = _parseFredCsvLatest(csv, 'DGS10');
  assert.equal(r.rate, 4.67);
  assert.equal(r.date, '2026-08-27');
});

test('FRED CSV: seri tanpa observasi valid -> throw (bukan diam-diam mengembalikan header)', () => {
  assert.throws(() => _parseFredCsvLatest('observation_date,X\n2026-01-01,.', 'X'), /tidak ada observasi valid/);
  assert.throws(() => _parseFredCsvLatest('', 'X'), /CSV FRED kosong/);
});

test('_splitCsvLine: menghormati koma di dalam tanda kutip', () => {
  assert.deepEqual(_splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(_splitCsvLine('a,"say ""hi"", ok",d'), ['a', 'say "hi", ok', 'd']);
  assert.deepEqual(_splitCsvLine('a,,b'), ['a', '', 'b']);
});

test('BIS CBPOL: memetakan REF_AREA ke currency + membawa tanggal observasi', () => {
  // Baris CH sengaja memuat koma di dalam kutip (kolom TITLE asli BIS memang begitu) —
  // kalau parser pakai split(',') polos, kolomnya bergeser dan nilainya salah.
  const csv = [
    'FREQ,REF_AREA,TITLE,TIME_PERIOD,OBS_VALUE',
    'D,JP,"Policy rate, Japan",2026-08-25,1',
    'D,NZ,"Policy rate, New Zealand",2026-08-21,2.5',
    'D,AU,"Policy rate, Australia",2026-08-06,4.35',
    'D,CH,"Policy rate, Switzerland",2026-08-25,0',
    'D,BR,"Policy rate, Brazil",2026-08-25,10.5',
  ].join('\n');
  const out = _parseBisCbpol(csv);
  assert.deepEqual(out.JPY, { rate: 1, date: '2026-08-25' });
  assert.deepEqual(out.NZD, { rate: 2.5, date: '2026-08-21' });
  assert.deepEqual(out.AUD, { rate: 4.35, date: '2026-08-06' });
  assert.deepEqual(out.CHF, { rate: 0, date: '2026-08-25' });
  assert.equal(Object.keys(out).length, 4, 'REF_AREA di luar 4 currency (BR) diabaikan');
});

test('BIS CBPOL: rate 0 (SNB) tidak hilang gara-gara dianggap falsy', () => {
  const out = _parseBisCbpol('FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nD,CH,2026-08-25,0');
  assert.equal(out.CHF.rate, 0);
});

test('BIS CBPOL: format berubah (kolom hilang) -> throw, bukan mengembalikan objek kosong diam-diam', () => {
  assert.throws(() => _parseBisCbpol('FREQ,TITLE\nD,x'), /REF_AREA/);
  assert.throws(() => _parseBisCbpol(''), /CSV kosong/);
});
