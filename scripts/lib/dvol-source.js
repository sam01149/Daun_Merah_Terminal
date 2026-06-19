// Deribit DVOL (BTC implied volatility index) — free, public, no API key. Confirmed reachable
// from GitHub Actions runners (local dev network has it ISP-blocked, same as Binance/Deribit
// pattern found earlier — see scripts/test-deribit.js).
'use strict';

const { fetchJson } = require('./btc-data');

const BASE = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const RESOLUTION_SEC = 3600; // hourly — native granularity, forward-filled onto 4h/1d grids same as COT/fear&greed
const CHUNK_MS = 30 * 86400e3; // 30-day windows per request, conservative against any pagination limit

// Returns rows: [timestamp, date_iso, open, high, low, close]
async function fetchDvolHistory(startTime, endTime = Date.now()) {
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const chunkEnd = Math.min(cursor + CHUNK_MS, endTime);
    const url = `${BASE}?currency=BTC&start_timestamp=${cursor}&end_timestamp=${chunkEnd}&resolution=${RESOLUTION_SEC}`;
    const json = await fetchJson(url);
    const data = json.result && json.result.data ? json.result.data : [];
    for (const [ts, open, high, low, close] of data) {
      if (ts < chunkEnd) rows.push([ts, new Date(ts).toISOString(), open, high, low, close]);
    }
    cursor = chunkEnd;
  }
  // De-dupe in case chunk boundaries overlap on a shared timestamp.
  const seen = new Set();
  return rows.filter(r => {
    if (seen.has(r[0])) return false;
    seen.add(r[0]);
    return true;
  });
}

module.exports = { fetchDvolHistory };
