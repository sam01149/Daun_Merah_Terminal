// Incremental sync: appends only the rows newer than what's already stored.
// Meant to run on a schedule (GitHub Action). Safe to run repeatedly — idempotent per source.
// Usage: node scripts/btc-sync.js
'use strict';

const { appendCsv, lastTimestamp, rowCount } = require('./lib/btc-data');
const { fetchOhlcv, fetchFearGreed } = require('./lib/btc-sources');
const { fetchCotBitcoinYear } = require('./lib/cot-bitcoin');
const { fetchBtcDominanceNow, fetchStablecoinSupply, fetchHashrate } = require('./lib/extra-sources');

const OHLCV_START = Date.parse('2017-08-17T00:00:00Z');
const DAY_MS = 86400e3;

async function syncOhlcv(interval) {
  const key = `ohlcv_${interval}`;
  const last = lastTimestamp(key);
  const start = last !== null ? last + 1 : OHLCV_START;
  const rows = await fetchOhlcv(interval, start);
  appendCsv(key, rows);
  console.log(`${key}: +${rows.length} rows (total ${rowCount(key)})`);
}

async function syncCotBitcoin() {
  // CFTC publishes weekly (Fridays); the annual zip is cumulative for the current year, so
  // re-download it and dedupe against the last stored timestamp. Also check the prior year in
  // case the as-of date just rolled over (year boundary).
  const last = lastTimestamp('cot_bitcoin');
  const year = new Date().getUTCFullYear();
  const batch = [...(await fetchCotBitcoinYear(year - 1)), ...(await fetchCotBitcoinYear(year))];
  const fresh = (last !== null ? batch.filter(r => r[0] > last) : batch).sort((a, b) => a[0] - b[0]);
  appendCsv('cot_bitcoin', fresh);
  console.log(`cot_bitcoin: +${fresh.length} rows (total ${rowCount('cot_bitcoin')})`);
}

async function syncFearGreed() {
  const last = lastTimestamp('fear_greed');
  // alternative.me has no startTime param; pull a small recent window and dedupe.
  const batch = await fetchFearGreed(30);
  const fresh = last !== null ? batch.filter(r => r[0] > last) : batch;
  appendCsv('fear_greed', fresh);
  console.log(`fear_greed: +${fresh.length} rows (total ${rowCount('fear_greed')})`);
}

async function syncStablecoinSupply() {
  const last = lastTimestamp('stablecoin_supply');
  const batch = await fetchStablecoinSupply(30);
  const fresh = last !== null ? batch.filter(r => r[0] > last) : batch;
  appendCsv('stablecoin_supply', fresh);
  console.log(`stablecoin_supply: +${fresh.length} rows (total ${rowCount('stablecoin_supply')})`);
}

async function syncHashrate() {
  const last = lastTimestamp('hashrate');
  const batch = await fetchHashrate('3m');
  const fresh = last !== null ? batch.filter(r => r[0] > last) : batch;
  appendCsv('hashrate', fresh);
  console.log(`hashrate: +${fresh.length} rows (total ${rowCount('hashrate')})`);
}

async function syncBtcDominance() {
  // This is a point-in-time snapshot (no historical source), so cap it at one row per UTC day
  // rather than piling up a row every hourly run.
  const last = lastTimestamp('btc_dominance');
  const lastDay = last !== null ? Math.floor(last / DAY_MS) : null;
  const today = Math.floor(Date.now() / DAY_MS);
  if (lastDay === today) {
    console.log('btc_dominance: already recorded today, skipping');
    return;
  }
  const row = await fetchBtcDominanceNow();
  appendCsv('btc_dominance', [row]);
  console.log(`btc_dominance: +1 row (total ${rowCount('btc_dominance')})`);
}

async function main() {
  console.log('BTC sync starting...');
  await syncOhlcv('1h');
  await syncOhlcv('4h');
  await syncOhlcv('1d');
  await syncCotBitcoin();
  await syncFearGreed();
  await syncStablecoinSupply();
  await syncHashrate();
  await syncBtcDominance();
  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
