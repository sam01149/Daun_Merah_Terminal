// test/api/calendar.test.js — Plan X (2026-08-04): api/calendar.js dedupeCalendarEvents
// (payload calendar_v1/calendar_next_v1, LOGIKA TIDAK DIUBAH, cuma diekstrak jadi pure
// function supaya testable) + buildSurpriseEvents (cache kedua BARU, calendar_surprise_v1/
// calendar_surprise_next_v1). Bagian async/HTTP/Redis dari calendarHandler tidak dites di
// sini (pola sama semua handler api/*.js lain), fokus regresi logika filter/dedup/sort.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeCalendarEvents, buildSurpriseEvents, SURPRISE_CURRENCIES } = require('../../api/calendar.js');

function ev(overrides) {
  return {
    date: '2026-08-04', time_wib: '19:30 WIB', currency: 'USD', event: 'CPI YoY',
    impact: 'High', forecast: '3.2%', previous: '3.1%', actual: null,
    forecast_raw: 3.2, previous_raw: 3.1, actual_raw: null,
    period: 'Jul', comment: 'Consumer prices', url: 'https://example.com',
    ...overrides,
  };
}

// ── dedupeCalendarEvents (payload calendar_v1/calendar_next_v1 — TIDAK BOLEH berubah) ──

test('dedupeCalendarEvents: High/Medium impact currency utama lolos, Low dibuang', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [
    ev({ event: 'A', impact: 'High' }),
    ev({ event: 'B', impact: 'Medium' }),
    ev({ event: 'C', impact: 'Low' }),
  ];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['A', 'B']);
});

test('dedupeCalendarEvents: currency di luar MAJOR_CURRENCIES dibuang', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [ev({ event: 'A', currency: 'USD' }), ev({ event: 'B', currency: 'SEK' })];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['A']);
});

test('dedupeCalendarEvents: tanggal di luar dateRange dibuang', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [ev({ event: 'A', date: '2026-08-04' }), ev({ event: 'B', date: '2026-08-05' })];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['A']);
});

test('dedupeCalendarEvents: dedup by date|time_wib|currency|event, item duplikat dibuang', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [ev({ event: 'A' }), ev({ event: 'A' }), ev({ event: 'A' })];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.equal(out.length, 1);
});

test('dedupeCalendarEvents: event recurring bulanan (nama sama, tanggal beda) TIDAK dianggap duplikat', () => {
  const dateRange = new Set(['2026-07-04', '2026-08-04']);
  const events = [
    ev({ event: 'Household Spending MoM', date: '2026-07-04' }),
    ev({ event: 'Household Spending MoM', date: '2026-08-04' }),
  ];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.equal(out.length, 2);
});

test('dedupeCalendarEvents: sort by date+time_wib ascending, Tentative di akhir', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [
    ev({ event: 'Late', time_wib: '23:00 WIB' }),
    ev({ event: 'Tentative', time_wib: 'Tentative' }),
    ev({ event: 'Early', time_wib: '01:00 WIB' }),
  ];
  const out = dedupeCalendarEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['Early', 'Late', 'Tentative']);
});

test('dedupeCalendarEvents: payload item tidak dimutasi/dipangkas (kontrak UI existing, field lengkap)', () => {
  const dateRange = new Set(['2026-08-04']);
  const out = dedupeCalendarEvents([ev({ event: 'A' })], dateRange);
  assert.equal(out[0].forecast, '3.2%');
  assert.equal(out[0].comment, 'Consumer prices');
  assert.equal(out[0].url, 'https://example.com');
});

// ── buildSurpriseEvents (cache BARU calendar_surprise_v1/next_v1, Plan X) ──────

test('buildSurpriseEvents: seluruh 8 major currency termasuk CAD lolos', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [
    ev({ event: 'A', currency: 'USD' }), ev({ event: 'B', currency: 'JPY' }),
    ev({ event: 'C', currency: 'CAD' }), ev({ event: 'D', currency: 'CHF' }),
  ];
  const out = buildSurpriseEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['A', 'B', 'C', 'D']);
});

test('buildSurpriseEvents: impact Low TETAP lolos (beda dari dedupeCalendarEvents)', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [ev({ event: 'A', currency: 'AUD', impact: 'Low' })];
  const out = buildSurpriseEvents(events, dateRange);
  assert.deepEqual(out.map(e => e.event), ['A']);
});

test('buildSurpriseEvents: display numbers omitted, source metadata kept for macro history', () => {
  const dateRange = new Set(['2026-08-04']);
  const out = buildSurpriseEvents([ev({ event: 'A', currency: 'USD' })], dateRange);
  assert.deepEqual(Object.keys(out[0]).sort(), [
    'actual_raw', 'currency', 'date', 'event', 'forecast_raw', 'impact', 'period', 'previous_raw',
    'reference_date', 'reference_period', 'released_at', 'source_country', 'source_event_id',
    'source_indicator', 'source_unit', 'time_wib', 'url',
  ]);
});

test('buildSurpriseEvents: source identity/cadence survives low-impact cache ingestion', () => {
  const input = ev({impact:'Low',source_event_id:'original-id',source_country:'AU',currency:'AUD',source_unit:'%',source_indicator:'CPI YY SA *',reference_date:'2026-07-31',reference_period:'Jul 2026',released_at:'2026-08-04T12:30:00Z'});
  const [output] = buildSurpriseEvents([input],new Set([input.date]));
  for(const key of ['source_event_id','source_country','source_unit','source_indicator','reference_date','reference_period','released_at','url']) assert.equal(output[key],input[key]);
});

test('buildSurpriseEvents: dedup by date|time_wib|currency|event, sama pola dedupeCalendarEvents', () => {
  const dateRange = new Set(['2026-08-04']);
  const events = [ev({ event: 'A', currency: 'USD' }), ev({ event: 'A', currency: 'USD' })];
  const out = buildSurpriseEvents(events, dateRange);
  assert.equal(out.length, 1);
});

test('SURPRISE_CURRENCIES: persis delapan major currency', () => {
  assert.deepEqual([...SURPRISE_CURRENCIES].sort(), ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD']);
});
