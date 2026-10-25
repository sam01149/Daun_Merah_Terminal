'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MACRO_HISTORY_INDEX_KEY,
  MACRO_HISTORY_DATA_KEY,
  classifyMacroRelease,
  normalizeMacroRelease,
  standardizeMacroHistory,
  buildMacroPillarScores,
  assessMacroScoreStability,
  buildCftcFoundation,
  persistMacroReleases,
} = require('../../api/_macro_surprise');

test('macro classifier keeps currency-area data and rejects EUR national releases', () => {
  assert.deepEqual(classifyMacroRelease('Euro Area Composite PMI', 'EUR'), {
    pillar: 'growth', family: 'activity_survey', series: 'composite_pmi:level', inverse: false, cadence: 'monthly',
  });
  assert.equal(classifyMacroRelease('German CPI YoY', 'EUR'), null);
  assert.equal(classifyMacroRelease('ECB President Speaks', 'EUR'), null);
  assert.equal(classifyMacroRelease('GDP QoQ Final', 'USD'), null);
  assert.ok(classifyMacroRelease('GDP QoQ Advance', 'USD'));
});

test('normalization requires actual and forecast and preserves inverse semantics', () => {
  const row = normalizeMacroRelease({
    currency: 'USD', title: 'Initial Jobless Claims', date: '2026-10-22T12:30:00Z',
    actualRaw: 194000, forecastRaw: 200000, previousRaw: 205000, period: 'Oct/17',
  });
  assert.equal(row.series, 'jobless_claims:level');
  assert.equal(row.inverse, true);
  assert.equal(row.actual, 194000);
  assert.equal(normalizeMacroRelease({ currency: 'USD', title: 'GDP QoQ', date: '2026-10-22T12:30:00Z', actualRaw: 2.1 }), null);
});

test('standardization uses only prior forecast errors and needs 12 observations', () => {
  const base = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: String(i), currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: base + i * 86400000,
  }));
  const scored = standardizeMacroHistory(rows);
  assert.equal(scored[11].standardized_surprise, null);
  assert.equal(scored[12].prior_n, 12);
  assert.ok(Number.isFinite(scored[12].standardized_surprise));
  // Adding a huge future error cannot alter an already-computed older score.
  const older = scored[12].standardized_surprise;
  rows.push({ ...rows[0], id: 'future', actual: 1000, time_ms: base + 99 * 86400000 });
  assert.equal(standardizeMacroHistory(rows)[12].standardized_surprise, older);
});

test('pillar score weights economic families equally, not the number of releases', () => {
  const asOf = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  for (const [series, family, latestError] of [
    ['services_pmi:level', 'activity_survey', 1],
    ['manufacturing_pmi:level', 'activity_survey', 1],
    ['gdp:qoq', 'output', -1],
  ]) {
    rows.push(
      { id: `${series}-a`, currency: 'USD', series, pillar: 'growth', family, actual: -1, forecast: 0, inverse: false, time_ms: asOf - 4 * 86400000 },
      { id: `${series}-b`, currency: 'USD', series, pillar: 'growth', family, actual: 1, forecast: 0, inverse: false, time_ms: asOf - 3 * 86400000 },
      { id: `${series}-c`, currency: 'USD', series, pillar: 'growth', family, actual: latestError, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
    );
  }
  const result = buildMacroPillarScores(rows, { asOfMs: asOf, minPriorErrors: 2, halfLifeDays: 1000 });
  const growth = result.currencies.USD.growth;
  assert.equal(growth.family_count, 2);
  assert.equal(growth.series_count, 3);
  assert.ok(Math.abs(growth.score) < 1e-12, `expected equal-family cancellation, got ${growth.score}`);
});

test('sensitivity returns no direction when reasonable decay choices disagree', () => {
  const asOf = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  // Old positive surprise and very recent negative surprise deliberately make
  // short and long decay choices disagree.
  for (let i = 0; i < 12; i++) rows.push({
    id: `prior-${i}`, currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: asOf - (180 - i) * 86400000,
  });
  for (let i = 0; i < 12; i++) rows.push({
    id: `survey-prior-${i}`, currency: 'USD', series: 'composite_pmi:level', pillar: 'growth', family: 'activity_survey',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: asOf - (180 - i) * 86400000,
  });
  rows.push(
    { id: 'old-positive', currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output', actual: 3, forecast: 0, inverse: false, time_ms: asOf - 100 * 86400000 },
    { id: 'recent-negative', currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output', actual: -0.5, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
    { id: 'survey-flat', currency: 'USD', series: 'composite_pmi:level', pillar: 'growth', family: 'activity_survey', actual: 0, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
  );
  const result = assessMacroScoreStability(rows, { asOfMs: asOf, halfLives: [10, 200] });
  assert.equal(result.currencies.USD.growth.direction, null);
  assert.equal(result.currencies.USD.growth.stable, false);
});

test('CFTC direction follows Leveraged Funds while AM conflict lowers quality', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const cot = {
    report_date: '2026-10-20', release_date: '2026-10-23',
    positions: { EUR: { lev_net: 12000, lev_change_net: 1500, lev_net_pct_oi: 4.2, am_net: -30000, am_change_net: -2000 } },
    percentiles: { EUR: { lev_pctile: 72 } },
  };
  const result = buildCftcFoundation('EUR', cot, now);
  assert.equal(result.direction, 'up');
  assert.equal(result.asset_manager.confirms, false);
  assert.equal(result.quality, 'reduced');
});

test('CFTC stale or missing data never becomes a neutral direction', () => {
  const result = buildCftcFoundation('JPY', { report_date: '2026-09-01', positions: { JPY: { lev_net: -20 } } }, Date.parse('2026-10-25T00:00:00Z'));
  assert.equal(result.direction, null);
  assert.equal(result.quality, 'unavailable');
});

test('history persistence uses deterministic hash plus sorted-set index', async () => {
  const calls = [];
  const redis = async (...args) => { calls.push(args); return 1; };
  const result = await persistMacroReleases([
    { currency: 'USD', event: 'GDP QoQ', date: '2026-10-22', time_wib: '19:30 WIB', actual_raw: 2.2, forecast_raw: 2.0, period: 'Q3' },
    { currency: 'EUR', event: 'German CPI YoY', date: '2026-10-22', time_wib: '15:00 WIB', actual_raw: 2.1, forecast_raw: 2.0, period: 'Sep' },
  ], redis);
  assert.equal(result.stored, 1);
  assert.equal(calls[0][0], 'HSET');
  assert.equal(calls[0][1], MACRO_HISTORY_DATA_KEY);
  assert.equal(calls[1][0], 'ZADD');
  assert.equal(calls[1][1], MACRO_HISTORY_INDEX_KEY);
});
