// Fetchers for each free BTC data source, used by both backfill and incremental sync.
'use strict';

const { fetchJson } = require('./btc-data');

const SYMBOL = 'BTCUSDT';
// data-api.binance.vision is Binance's official market-data-only mirror — unlike api.binance.com
// it isn't subject to the HTTP 451 geo-block that affects fapi.binance.com (futures) from US IPs
// such as GitHub Actions runners.
const SPOT_BASE = 'https://data-api.binance.vision';

const INTERVAL_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3 };

// Binance spot klines, paginated by startTime/endTime, max 1000 candles per request.
// Returns rows: [openTime, date_iso, open, high, low, close, volume]
async function fetchOhlcv(interval, startTime, endTime = Date.now()) {
  const rows = [];
  let cursor = startTime;
  const step = INTERVAL_MS[interval];
  while (cursor < endTime) {
    const url = `${SPOT_BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const batch = await fetchJson(url);
    if (!batch.length) break;
    for (const k of batch) {
      const openTime = k[0];
      if (openTime >= endTime) continue;
      rows.push([openTime, new Date(openTime).toISOString(), k[1], k[2], k[3], k[4], k[5]]);
    }
    const lastOpenTime = batch[batch.length - 1][0];
    if (batch.length < 1000) break;
    cursor = lastOpenTime + step;
  }
  return rows;
}

// alternative.me Fear & Greed Index, daily granularity. limit=0 returns full history.
// Returns rows: [timestamp, date_iso, value, classification]
async function fetchFearGreed(limit = 0) {
  const url = `https://api.alternative.me/fng/?limit=${limit}&format=json`;
  const json = await fetchJson(url);
  return json.data
    .map(d => {
      const ts = Number(d.timestamp) * 1000;
      return [ts, new Date(ts).toISOString(), d.value, d.value_classification];
    })
    .sort((a, b) => a[0] - b[0]);
}

module.exports = { fetchOhlcv, fetchFearGreed };
