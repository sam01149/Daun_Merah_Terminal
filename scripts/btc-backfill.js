// One-time full historical backfill for BTC data collection.
// Usage: node scripts/btc-backfill.js
'use strict';

const { writeCsv, rowCount } = require('./lib/btc-data');
const { fetchOhlcv, fetchFearGreed } = require('./lib/btc-sources');
const { fetchCotBitcoinAll } = require('./lib/cot-bitcoin');
const { fetchBtcDominanceNow, fetchStablecoinSupply, fetchHashrate } = require('./lib/extra-sources');

const OHLCV_START = Date.parse('2017-08-17T00:00:00Z'); // BTCUSDT spot listing on Binance

async function main() {
  console.log('BTC backfill starting...');

  for (const interval of ['1h', '4h', '1d']) {
    const rows = await fetchOhlcv(interval, OHLCV_START);
    writeCsv(`ohlcv_${interval}`, rows);
    console.log(`ohlcv_${interval}: ${rows.length} candles`);
  }

  const cot = await fetchCotBitcoinAll(2018);
  writeCsv('cot_bitcoin', cot);
  console.log(`cot_bitcoin: ${cot.length} weekly rows (CME Bitcoin futures, since 2018)`);

  const fng = await fetchFearGreed(0);
  writeCsv('fear_greed', fng);
  console.log(`fear_greed: ${fng.length} rows`);

  const stable = await fetchStablecoinSupply(365);
  writeCsv('stablecoin_supply', stable);
  console.log(`stablecoin_supply: ${stable.length} rows (CoinGecko free tier caps history at 365 days)`);

  const hashrate = await fetchHashrate('all');
  writeCsv('hashrate', hashrate);
  console.log(`hashrate: ${hashrate.length} rows`);

  const dominance = await fetchBtcDominanceNow();
  writeCsv('btc_dominance', [dominance]);
  console.log('btc_dominance: 1 row (no free historical source — accumulates going forward only)');

  console.log('Backfill complete:');
  for (const key of ['ohlcv_1h', 'ohlcv_4h', 'ohlcv_1d', 'cot_bitcoin', 'fear_greed', 'stablecoin_supply', 'hashrate', 'btc_dominance']) {
    console.log(`  ${key}: ${rowCount(key)} rows`);
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
