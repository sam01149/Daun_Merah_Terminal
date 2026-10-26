const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  releaseSignal, buildGrowth, buildInflation, buildCentralBank,
  extractBankStances, buildBanks, buildPositioning, buildOverall,
} = require('../../api/_smart_bias');

const NOW = Date.parse('2026-10-24T12:00:00Z');

function item(actual, forecast, date = '2026-10-20', source = 'calendar') {
  return { actual, forecast, previous: forecast, date, source };
}

test('Smart Bias: seed dan rilis stale tidak pernah menjadi sinyal', () => {
  assert.equal(releaseSignal('GDP QoQ', item('0.5%', '0.3%', '2026-10-20', 'seed'), NOW), null);
  assert.equal(releaseSignal('Manufacturing PMI', item('52', '50', '2025-01-01'), NOW), null);
});

test('Smart Bias: Growth memerlukan activity dan labour yang konsisten', () => {
  const bullish = buildGrowth({
    'GDP QoQ': item('0.5%', '0.3%'),
    'Manufacturing PMI': item('53', '51'),
    'Employment Change': item('45K', '20K'),
  }, NOW);
  assert.equal(bullish.state, 'bullish');

  const conflict = buildGrowth({
    'GDP QoQ': item('0.5%', '0.3%'),
    'Manufacturing PMI': item('53', '51'),
    'Unemployment Rate': item('5.0%', '4.5%'),
  }, NOW);
  assert.equal(conflict.state, 'mixed');
});

test('Smart Bias: inflation directional hanya saat konteks kebijakan selaras', () => {
  const cb = buildCentralBank({
    bias: 'hawkish', confidence: 'high', bias_updated: '2026-10-20',
    source_headlines: [{ title: 'Bank maintains restrictive guidance' }],
  }, NOW);
  const inflation = buildInflation({
    'CPI YoY': item('3.2%', '3.0%'),
    'Core CPI YoY': item('3.3%', '3.1%'),
  }, cb, NOW);
  assert.equal(inflation.state, 'bullish');
  assert.equal(inflation.policy_context, 'bullish');
});

test('Smart Bias Banks: seminar ditolak dan outlook pair dipecah secara konsisten', () => {
  const stances = extractBankStances([
    { title: 'MUFG webinar and seminar on EUR/USD outlook', pubDate: '2026-10-23T10:00:00Z' },
    { guid: 'a', title: 'MUFG expects EUR/USD to rise next week', description: 'The pair should gain.', pubDate: '2026-10-23T10:00:00Z' },
  ], NOW);
  assert.deepEqual(stances.map(x => [x.currency, x.direction]), [['EUR', 'bullish'], ['USD', 'bearish']]);
});

test('Smart Bias Banks: artikel berulang dari institusi yang sama hanya satu suara', () => {
  const result = buildBanks('EUR', [
    { institution:'MUFG', currency:'EUR', direction:'bullish', published_at:'2026-10-20T00:00:00Z' },
    { institution:'MUFG', currency:'EUR', direction:'bullish', published_at:'2026-10-23T00:00:00Z' },
  ]);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.state, 'bullish');
});

test('Smart Bias Positioning: Asset Manager dan Leveraged Funds konflik menjadi mixed', () => {
  const result = buildPositioning('EUR', {
    report_date:'2026-10-20', positions:{ EUR:{ am_net_pct_oi:8, lev_net_pct_oi:-9 } },
  }, {}, NOW);
  assert.equal(result.institutional.asset_manager.state, 'bullish');
  assert.equal(result.institutional.leveraged_funds.state, 'bearish');
  assert.equal(result.institutional.state, 'mixed');
  assert.equal('retail' in result, false);
});

test('Smart Bias Overall: tier pendukung tidak dapat membalik arah inti', () => {
  const layer = state => ({ state });
  const core = { growth:layer('bullish'), inflation:{ state:'bullish', policy_context:'neutral' }, central_bank:layer('neutral') };
  const result = buildOverall({ ...core, banks:layer('bearish'), positioning:layer('bearish') });
  assert.equal(result.state, 'bullish');
  assert.deepEqual(result.conflicts, ['banks', 'positioning']);
});

test('Smart Bias Overall: Inflation yang bergantung pada CB tidak dihitung dua kali tanpa Growth', () => {
  const layer = state => ({ state });
  const result = buildOverall({
    growth:layer('insufficient'),
    inflation:{ state:'bullish', policy_context:'bullish' },
    central_bank:layer('bullish'), banks:layer('insufficient'), positioning:layer('insufficient'),
  });
  assert.equal(result.state, 'insufficient');
  assert.ok(result.rationale_codes.includes('core_independence_low'));
});

test('Smart Bias Overall: Pandangan Marc tidak memengaruhi kesimpulan sebelum track record layak', () => {
  const layer = state => ({ state });
  const result = buildOverall({
    growth:layer('bullish'), inflation:{ state:'bullish', policy_context:'neutral' }, central_bank:layer('neutral'),
    banks:{ state:'bearish', eligible_for_overall:false }, positioning:layer('insufficient'),
  });
  assert.equal(result.state, 'bullish');
  assert.deepEqual(result.conflicts, []);
});
