// test/lib/rate_path_fomc.test.js
// Plan W-1 (2026-08-03): getNextFOMCMeetings tadinya murni tabel manual `known`
// yang berakhir di 2027-04-29 (silent degradation setelah tanggal itu). Sekarang
// terima calendarEvents opsional (calendar_v1/calendar_next_v1, TradingView) —
// live diutamakan, tabel manual tetap ada sebagai fallback untuk slot yang tidak
// ketemu live (calendar_v1 cuma cache minggu berjalan).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getNextFOMCMeetings, _liveFomcMeetingDates } = require('../../api/rate-path.js');

// Default time_wib '14:00' (siang WIB) -> TIDAK kena normalisasi shift, jadi
// `date` yang dipakai di fixture langsung jadi tanggal rapat hasil akhir — lebih
// gampang dibaca test merge/dedup di bawah. Shift '<07:00' dites terpisah di
// suite _liveFomcMeetingDates (FOMC beneran selalu shift, lihat komentar di
// rate-path.js: 19:00 UTC = 02:00 WIB hari berikutnya).
function fomcEvent({ date, time_wib = '14:00', currency = 'USD', impact = 'High', event = 'Interest Rate Decision' }) {
  return { date, time_wib, currency, impact, event };
}

// ── _liveFomcMeetingDates (pure filter) ────────────────────────────────────

test('_liveFomcMeetingDates: match currency USD + impact High + judul rate decision', () => {
  const events = [
    fomcEvent({ date: '2026-09-18', time_wib: '01:00' }), // dini hari WIB -> mundur 1 hari
    { date: '2026-09-17', currency: 'USD', impact: 'High', event: 'Fed Chair Press Conference' }, // bukan rate decision
    { date: '2026-09-17', currency: 'EUR', impact: 'High', event: 'ECB Interest Rate Decision' }, // bukan USD
    { date: '2026-09-17', currency: 'USD', impact: 'Medium', event: 'FOMC Interest Rate Decision' }, // bukan High
  ];
  const dates = _liveFomcMeetingDates(events);
  assert.deepEqual(dates, ['2026-09-17']);
});

test('_liveFomcMeetingDates: time_wib siang hari TIDAK dimundurkan (bukan pola shift FOMC)', () => {
  const events = [fomcEvent({ date: '2026-09-17', time_wib: '14:00' })];
  assert.deepEqual(_liveFomcMeetingDates(events), ['2026-09-17']);
});

test('_liveFomcMeetingDates: input bukan array / event rusak -> array kosong, tidak crash', () => {
  assert.deepEqual(_liveFomcMeetingDates(null), []);
  assert.deepEqual(_liveFomcMeetingDates([null, {}, { date: '2026-09-17' }]), []);
});

// ── getNextFOMCMeetings (merge live + manual) ──────────────────────────────

const FROM = new Date('2026-08-03T00:00:00Z');

test('live ketemu semua slot yang diminta -> pakai live (bukan tabel manual)', () => {
  // Kedua tanggal live ini SEBELUM entri manual pertama (2026-09-17) supaya
  // hasil count=2 murni dari live, tidak tercampur entri manual di antaranya.
  const events = [
    fomcEvent({ date: '2026-08-06' }),
    fomcEvent({ date: '2026-08-20' }),
  ];
  const r = getNextFOMCMeetings(FROM, 2, events);
  assert.deepEqual(r, ['2026-08-06', '2026-08-20']);
});

test('live ketemu sebagian -> gabung live+manual tanpa duplikat, terurut', () => {
  // 2026-09-17 sama persis dengan salah satu tanggal manual -> harus dedup jadi 1.
  const events = [fomcEvent({ date: '2026-09-17' })];
  const r = getNextFOMCMeetings(FROM, 3, events);
  assert.deepEqual(r, ['2026-09-17', '2026-11-05', '2026-12-17']);
  assert.equal(new Set(r).size, r.length, 'tidak boleh ada tanggal duplikat');
});

// Kasus WIB-shift nyata: rapat manual '2026-09-17' (konvensi tanggal AS/UTC)
// muncul di calendar_v1 dengan `date` '2026-09-18' + time_wib dini hari (~19:00
// UTC = 02:00 WIB HARI BERIKUTNYA) — normalisasi harus balikkan ke '2026-09-17'
// supaya dedup dengan tabel manual, bukan muncul sebagai 2 tanggal berbeda.
test('live dengan WIB-shift (event dini hari) tetap dedup dengan tabel manual', () => {
  const events = [fomcEvent({ date: '2026-09-18', time_wib: '02:00' })];
  const r = getNextFOMCMeetings(FROM, 3, events);
  assert.deepEqual(r, ['2026-09-17', '2026-11-05', '2026-12-17']);
  assert.equal(new Set(r).size, r.length, 'tidak boleh ada tanggal duplikat');
});

test('live kosong/gagal fetch -> fallback tabel manual penuh (TIDAK REGRESI dari perilaku lama)', () => {
  const r = getNextFOMCMeetings(FROM, 3, []);
  assert.deepEqual(r, ['2026-09-17', '2026-11-05', '2026-12-17']);
  // Tanpa parameter ke-3 sama sekali (caller lama) harus identik.
  const rNoParam = getNextFOMCMeetings(FROM, 3);
  assert.deepEqual(rNoParam, r);
});

test('tanggal FOMC di masa lalu (<= from) terfilter keluar dari live maupun manual', () => {
  const events = [
    fomcEvent({ date: '2026-07-30' }), // sudah lewat FROM
    fomcEvent({ date: '2026-09-17' }),
  ];
  const r = getNextFOMCMeetings(FROM, 5, events);
  assert.ok(!r.includes('2026-07-30'), 'tanggal lampau tidak boleh muncul');
  assert.ok(r.includes('2026-09-17'));
});

test('live membawa tanggal BARU di luar tabel manual (mengatasi silent degradation setelah 2027-04-29)', () => {
  const events = [fomcEvent({ date: '2027-06-16' })];
  const from2027 = new Date('2027-05-01T00:00:00Z');
  const r = getNextFOMCMeetings(from2027, 3, events);
  assert.deepEqual(r, ['2027-06-16']);
});
