// One-time full historical backfill for BTC data collection.
// Usage: node scripts/btc-backfill.js
'use strict';

const { writeCsv, rowCount } = require('./lib/btc-data');
const { fetchOhlcv, fetchFearGreed } = require('./lib/btc-sources');
const { fetchCotBitcoinAll } = require('./lib/cot-bitcoin');

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

  console.log('Backfill complete:');
  for (const key of ['ohlcv_1h', 'ohlcv_4h', 'ohlcv_1d', 'cot_bitcoin', 'fear_greed']) {
    console.log(`  ${key}: ${rowCount(key)} rows`);
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
