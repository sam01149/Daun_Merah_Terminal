// Fetchers for supplementary free BTC context data: dominance, stablecoin supply, hashrate.
'use strict';

const { fetchJson, fetchJsonPatient, sleep } = require('./btc-data');

// CoinGecko /global only exposes the *current* dominance snapshot for free — there's no free
// historical endpoint (that's Pro-only). So this can only be collected going forward, one row
// per run, same limitation pattern as Binance's 30-day open-interest window.
// Returns a single row: [timestamp, date_iso, btc_dominance_pct]
async function fetchBtcDominanceNow() {
  const json = await fetchJsonPatient('https://api.coingecko.com/api/v3/global');
  const ts = json.data.updated_at * 1000;
  return [ts, new Date(ts).toISOString(), json.data.market_cap_percentage.btc];
}

// CoinGecko market_chart market caps for USDT + USDC, daily granularity. NOTE: CoinGecko's free
// tier caps public historical queries at 365 days back (HTTP 401 / error_code 10012 beyond that)
// — full history since USDT/USDC launch isn't available without a paid plan.
// Returns rows: [timestamp, date_iso, usdt_market_cap, usdc_market_cap, total_stablecoin_cap]
async function fetchStablecoinSupply(days = 365) {
  const usdtJson = await fetchJsonPatient(`https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=${days}`);
  await sleep(2000); // stay under CoinGecko's free-tier rate limit between calls
  const usdcJson = await fetchJsonPatient(`https://api.coingecko.com/api/v3/coins/usd-coin/market_chart?vs_currency=usd&days=${days}`);

  // CoinGecko buckets by day but timestamps aren't perfectly aligned between coins — snap to
  // the UTC day boundary so USDT and USDC rows merge correctly.
  const byDay = new Map();
  const dayKey = ts => Math.floor(ts / 86400e3) * 86400e3;
  for (const [ts, cap] of usdtJson.market_caps) {
    byDay.set(dayKey(ts), { usdt: cap, usdc: null });
  }
  for (const [ts, cap] of usdcJson.market_caps) {
    const k = dayKey(ts);
    const existing = byDay.get(k) || { usdt: null, usdc: null };
    existing.usdc = cap;
    byDay.set(k, existing);
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, { usdt, usdc }]) => [ts, new Date(ts).toISOString(), usdt, usdc, (usdt || 0) + (usdc || 0)]);
}

// mempool.space network hashrate, daily granularity. period='all' returns full history since 2009.
// Returns rows: [timestamp, date_iso, avgHashrate]
async function fetchHashrate(period = 'all') {
  const json = await fetchJson(`https://mempool.space/api/v1/mining/hashrate/${period}`);
  return json.hashrates.map(h => {
    const ts = h.timestamp * 1000;
    return [ts, new Date(ts).toISOString(), h.avgHashrate];
  });
}

module.exports = { fetchBtcDominanceNow, fetchStablecoinSupply, fetchHashrate };
