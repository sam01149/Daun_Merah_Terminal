// One-time full historical backfill for BTC data collection.
// Usage: node scripts/btc-backfill.js
'use strict';

const { writeCsv, rowCount } = require('./lib/btc-data');
const { fetchOhlcv, fetchFundingRate, fetchOpenInterest, fetchFearGreed } = require('./lib/btc-sources');

const OHLCV_START   = Date.parse('2017-08-17T00:00:00Z'); // BTCUSDT spot listing on Binance
const FUNDING_START = Date.parse('2019-09-08T00:00:00Z'); // BTCUSDT perpetual futures launch

async function main() {
  console.log('BTC backfill starting...');

  for (const interval of ['1h', '4h', '1d']) {
    const rows = await fetchOhlcv(interval, OHLCV_START);
    writeCsv(`ohlcv_${interval}`, rows);
    console.log(`ohlcv_${interval}: ${rows.length} candles`);
  }

  const funding = await fetchFundingRate(FUNDING_START);
  writeCsv('funding_rate', funding);
  console.log(`funding_rate: ${funding.length} rows`);

  const oi = await fetchOpenInterest('1h', 500);
  writeCsv('open_interest', oi);
  console.log(`open_interest: ${oi.length} rows (Binance only retains ~30d history for this endpoint)`);

  const fng = await fetchFearGreed(0);
  writeCsv('fear_greed', fng);
  console.log(`fear_greed: ${fng.length} rows`);

  console.log('Backfill complete:');
  for (const key of ['ohlcv_1h', 'ohlcv_4h', 'ohlcv_1d', 'funding_rate', 'open_interest', 'fear_greed']) {
    console.log(`  ${key}: ${rowCount(key)} rows`);
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
