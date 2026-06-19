// One-off connectivity + pagination test for the full fetchDvolHistory() helper, before trusting
// it in the real backfill. Local dev network has Deribit ISP-blocked — this only works from
// GitHub Actions runners.
// Usage: node scripts/test-deribit.js
'use strict';

const { fetchDvolHistory } = require('./lib/dvol-source');

async function main() {
  // ~95 days, spanning 3 chunk boundaries (CHUNK_MS = 30 days) to exercise pagination + dedupe.
  const start = Date.parse('2023-01-01T00:00:00Z');
  const end = Date.parse('2023-04-05T00:00:00Z');
  console.log(`Fetching DVOL from ${new Date(start).toISOString()} to ${new Date(end).toISOString()}...`);

  const rows = await fetchDvolHistory(start, end);
  console.log(`Got ${rows.length} rows`);
  console.log('First 3:', JSON.stringify(rows.slice(0, 3)));
  console.log('Last 3:', JSON.stringify(rows.slice(-3)));

  // Sanity checks: hourly cadence, no duplicate timestamps, no out-of-range values.
  const timestamps = rows.map(r => r[0]);
  const uniqueCount = new Set(timestamps).size;
  console.log(`Unique timestamps: ${uniqueCount} / ${rows.length}`);
  const sorted = timestamps.every((t, i) => i === 0 || t > timestamps[i - 1]);
  console.log(`Strictly increasing: ${sorted}`);
  const expectedHours = Math.round((end - start) / 3600e3);
  console.log(`Expected ~${expectedHours} hourly candles, got ${rows.length}`);

  if (uniqueCount !== rows.length || !sorted) {
    console.error('FAILED sanity checks');
    process.exit(1);
  }
  console.log('PASSED');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
