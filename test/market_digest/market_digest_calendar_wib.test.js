// test/market_digest/market_digest_calendar_wib.test.js
// S255 (2026-07-29) — regresi bug: convertToWIB dulu cuma konversi JAM (modulo 24),
// tanggal dari XML ForexFactory dipakai apa adanya. Event dengan jam raw >=17:00
// (mis. FOMC 18:00 = 2pm ET) menyeberang tengah malam WIB (jadi 01:00 WIB) tapi
// tanggalnya TIDAK ikut maju — date & time_wib jadi merujuk ke dua hari WIB
// berbeda. _calEventStatusTag() lalu salah hitung event yang BELUM terjadi
// sebagai "sudah rilis ~14 jam lalu" (persis selisih 1 hari). Ketahuan lewat
// live-test FOMC 30 Juli yang dinarasikan AI seolah sudah terjadi "tadi malam".
// toWIB() sekarang menurunkan date DAN time_wib dari SATU epoch WIB yang sama.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toWIB, parseFFXML } = require('../../api/market-digest.js');

test('toWIB: jam yang menyeberang tengah malam WIB memajukan tanggal (bug FOMC 18:00 UTC)', () => {
  const r = toWIB('2026', '07', '29', '6:00pm');
  assert.equal(r.date, '2026-07-30');
  assert.equal(r.time_wib, '01:00 WIB');
});

test('toWIB: jam yang tidak menyeberang tengah malam mempertahankan tanggal asli', () => {
  const r = toWIB('2026', '07', '29', '2:00pm');
  assert.equal(r.date, '2026-07-29');
  assert.equal(r.time_wib, '21:00 WIB');
});

test('toWIB: All Day / Tentative tidak diproses sebagai jam', () => {
  assert.deepEqual(toWIB('2026', '07', '29', 'All Day'), { date: '2026-07-29', time_wib: 'Tentative' });
  assert.deepEqual(toWIB('2026', '07', '29', 'Tentative'), { date: '2026-07-29', time_wib: 'Tentative' });
});

test('toWIB: am/pm edge case 12am dan 12pm', () => {
  assert.equal(toWIB('2026', '07', '29', '12:00am').time_wib, '07:00 WIB');
  assert.equal(toWIB('2026', '07', '29', '12:00pm').time_wib, '19:00 WIB');
});

test('parseFFXML: event date+time_wib konsisten di hari WIB yang sama (tidak split)', () => {
  const xml = `<weeklyevents><event>
    <title>Federal Funds Rate</title>
    <country><![CDATA[USD]]></country>
    <date><![CDATA[07-29-2026]]></date>
    <time><![CDATA[6:00pm]]></time>
    <impact><![CDATA[High]]></impact>
    <forecast><![CDATA[3.75%]]></forecast>
    <previous><![CDATA[3.75%]]></previous>
  </event></weeklyevents>`;
  const [ev] = parseFFXML(xml);
  assert.equal(ev.date, '2026-07-30');
  assert.equal(ev.time_wib, '01:00 WIB');
  assert.equal(ev.currency, 'USD');
});
