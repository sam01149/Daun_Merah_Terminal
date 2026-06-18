// Fetchers for each free BTC data source, used by both backfill and incremental sync.
'use strict';

const { fetchJson } = require('./btc-data');

const SYMBOL = 'BTCUSDT';
const SPOT_BASE    = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

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

// Binance futures funding rate history (8h interval), paginated, max 1000 per request.
// Returns rows: [fundingTime, date_iso, fundingRate]
async function fetchFundingRate(startTime, endTime = Date.now()) {
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FUTURES_BASE}/fapi/v1/fundingRate?symbol=${SYMBOL}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const batch = await fetchJson(url);
    if (!batch.length) break;
    for (const f of batch) {
      rows.push([f.fundingTime, new Date(f.fundingTime).toISOString(), f.fundingRate]);
    }
    const lastTime = batch[batch.length - 1].fundingTime;
    if (batch.length < 1000 || lastTime <= cursor) break;
    cursor = lastTime + 1;
  }
  return rows;
}

// Binance futures open interest history. NOTE: Binance only retains ~30 days of history for this
// endpoint regardless of startTime — older data cannot be backfilled, only accumulated going forward.
// Returns rows: [timestamp, date_iso, openInterest, openInterestValue]
async function fetchOpenInterest(period = '1h', limit = 500) {
  const url = `${FUTURES_BASE}/futures/data/openInterestHist?symbol=${SYMBOL}&period=${period}&limit=${limit}`;
  const batch = await fetchJson(url);
  return batch.map(o => [o.timestamp, new Date(o.timestamp).toISOString(), o.sumOpenInterest, o.sumOpenInterestValue]);
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

module.exports = { SYMBOL, fetchOhlcv, fetchFundingRate, fetchOpenInterest, fetchFearGreed };
