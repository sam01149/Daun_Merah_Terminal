// One-off connectivity test for Deribit's public API (DVOL implied volatility index).
// Local dev network has this blocked (ISP-level DNS redirect, same pattern as Binance) — this
// script exists to verify whether GitHub Actions runners can reach it instead.
// Usage: node scripts/test-deribit.js
'use strict';

async function main() {
  const url = 'https://www.deribit.com/api/v2/public/get_volatility_index_data'
    + '?currency=BTC&start_timestamp=1700000000000&end_timestamp=1700086400000&resolution=3600';
  console.log(`Fetching: ${url}`);
  const r = await fetch(url);
  console.log(`HTTP status: ${r.status}`);
  const text = await r.text();
  console.log(`Response (first 1000 chars):\n${text.slice(0, 1000)}`);
  if (!r.ok) process.exit(1);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
