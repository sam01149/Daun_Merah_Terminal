// Incremental sync: appends only the rows newer than what's already stored.
// Meant to run on a schedule (GitHub Action). Safe to run repeatedly — idempotent per source.
// Usage: node scripts/btc-sync.js
'use strict';

const { appendCsv, lastTimestamp, rowCount } = require('./lib/btc-data');
const { fetchOhlcv, fetchFundingRate, fetchOpenInterest, fetchFearGreed } = require('./lib/btc-sources');

const OHLCV_START   = Date.parse('2017-08-17T00:00:00Z');
const FUNDING_START = Date.parse('2019-09-08T00:00:00Z');

async function syncOhlcv(interval) {
  const key = `ohlcv_${interval}`;
  const last = lastTimestamp(key);
  const start = last !== null ? last + 1 : OHLCV_START;
  const rows = await fetchOhlcv(interval, start);
  appendCsv(key, rows);
  console.log(`${key}: +${rows.length} rows (total ${rowCount(key)})`);
}

async function syncFundingRate() {
  const last = lastTimestamp('funding_rate');
  const start = last !== null ? last + 1 : FUNDING_START;
  const rows = await fetchFundingRate(start);
  appendCsv('funding_rate', rows);
  console.log(`funding_rate: +${rows.length} rows (total ${rowCount('funding_rate')})`);
}

async function syncOpenInterest() {
  // Binance only exposes ~30d of history for this endpoint; dedupe against the last stored timestamp.
  const last = lastTimestamp('open_interest');
  const batch = await fetchOpenInterest('1h', 500);
  const fresh = last !== null ? batch.filter(r => r[0] > last) : batch;
  appendCsv('open_interest', fresh);
  console.log(`open_interest: +${fresh.length} rows (total ${rowCount('open_interest')})`);
}

async function syncFearGreed() {
  const last = lastTimestamp('fear_greed');
  // alternative.me has no startTime param; pull a small recent window and dedupe.
  const batch = await fetchFearGreed(30);
  const fresh = last !== null ? batch.filter(r => r[0] > last) : batch;
  appendCsv('fear_greed', fresh);
  console.log(`fear_greed: +${fresh.length} rows (total ${rowCount('fear_greed')})`);
}

async function main() {
  console.log('BTC sync starting...');
  await syncOhlcv('1h');
  await syncOhlcv('4h');
  await syncOhlcv('1d');
  await syncFundingRate();
  await syncOpenInterest();
  await syncFearGreed();
  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
