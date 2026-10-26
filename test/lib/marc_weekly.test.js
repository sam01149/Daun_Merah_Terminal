'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMarcFeed, extractArticleText, weekWindow, validateClaims,
  evaluateClaim, aggregateClaims, summarizeTracker, currentStances,
} = require('../../api/_marc_weekly');

test('Marc weekly: feed memilih Week Ahead terbaru dan link alternate', () => {
  const xml = `<feed>
    <entry><title>Daily Note</title><published>2026-10-25T10:00:00Z</published><link rel="alternate" href="https://x/daily"/></entry>
    <entry><title>Week Ahead: Five Central Banks Meet</title><published>2026-10-24T10:00:00Z</published><link rel="self" href="https://x/feed"/><link rel="alternate" href="https://www.marctomarket.com/week"/></entry>
  </feed>`;
  const rows = parseMarcFeed(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, 'https://www.marctomarket.com/week');
});

test('Marc weekly: body artikel dipisahkan dari sidebar dan window dikunci Senin-Jumat', () => {
  const html = `<aside>noise</aside><div class="post-body entry-content"><p>Drivers &amp; Prices</p><p>Dollar likely rises.</p></div><div class="post-footer">share</div>`;
  assert.equal(extractArticleText(html), 'Drivers & Prices\nDollar likely rises.');
  assert.deepEqual(weekWindow('2026-10-24T10:00:00Z'), {
    start: '2026-10-26T00:00:00.000Z', end: '2026-10-31T00:00:00.000Z',
  });
});

test('Marc weekly: validator menolak pair yang tidak memuat currency dan hanya satu klaim per currency', () => {
  const claims = validateClaims({ claims: [
    { currency:'EUR', pair:'USD/JPY', direction:'bullish', layer:'policy', confidence:'high', reason:'ECB remains restrictive', quote:'We expect the euro to strengthen next week.' },
    { currency:'EUR', pair:'EUR/USD', direction:'bullish', layer:'policy', confidence:'high', reason:'ECB remains restrictive', quote:'We expect the euro to strengthen next week.' },
    { currency:'EUR', pair:'EUR/USD', direction:'bearish', layer:'risk', confidence:'low', reason:'Later duplicate', quote:'The euro may reverse lower in the week.' },
  ]}, { snapshot_id:'abc' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].pair, 'EUR/USD');
  assert.equal(claims[0].institution, 'Marc to Market');
});

test('Marc weekly: outcome pair dinilai dari sudut currency, dengan zona noise dan baseline', () => {
  const hour = 3600;
  const candles = [];
  const prevStart = Date.parse('2026-10-19T00:00:00Z') / 1000;
  for (let i = 0; i < 5 * 24; i++) candles.push({ t:prevStart + i*hour, o:1, c:1 + i*0.00003 });
  const start = Date.parse('2026-10-26T00:00:00Z') / 1000;
  for (let i = 0; i < 5 * 24; i++) candles.push({ t:start + i*hour, o:1.01, c:1.01 + i*0.00005 });
  const result = evaluateClaim({ currency:'EUR', pair:'EUR/USD', direction:'bullish' }, { 'EURUSD=X':candles }, {
    start:'2026-10-26T00:00:00Z', end:'2026-10-31T00:00:00Z',
  });
  assert.equal(result.outcome.status, 'hit');
  assert.equal(result.outcome.baseline_direction, 'bullish');
  assert.equal(result.outcome.baseline_hit, true);
  assert.equal(Number.isFinite(result.outcome.vol_adjusted_return), true);
});

test('Marc weekly: n kecil selalu belum cukup dan tidak boleh memengaruhi kesimpulan', () => {
  const claims = Array.from({ length: 29 }, (_, i) => ({ currency:'USD', outcome:{ status:i < 20 ? 'hit' : 'miss', signed_return_pct:i < 20 ? 0.3 : -0.2, baseline_hit:false } }));
  assert.equal(aggregateClaims(claims).quality, 'belum_cukup');
  const now = Date.parse('2026-10-26T12:00:00Z');
  const tracker = [{ id:'x', status:'open', published_at:'2026-10-24T00:00:00Z', window:{ start:'2026-10-26T00:00:00Z', end:'2026-10-31T00:00:00Z' }, claims:[{ currency:'USD', direction:'bullish', conditional:false }] }];
  const report = summarizeTracker(tracker, now);
  const stance = currentStances(report)[0];
  assert.equal(stance.track_record_eligible, false);
});

test('Marc weekly: snapshot terlambat boleh tampil tetapi tidak pernah masuk scoring', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const tracker = [{ id:'late', status:'excluded_late_snapshot', published_at:'2026-10-24T00:00:00Z', eligible_for_scoring:false, window:{ start:'2026-10-26T00:00:00Z', end:'2026-10-31T00:00:00Z' }, claims:[{ currency:'EUR', direction:'bullish', conditional:false }] }];
  const report = summarizeTracker(tracker, now);
  assert.equal(report.current.id, 'late');
  assert.equal(report.overall.n, 0);
  assert.equal(currentStances(report)[0].track_record_eligible, false);
});
