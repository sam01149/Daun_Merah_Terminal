// api/cb-status.js — Live CB rates + bias (6h Redis cache, scraped from official sources)
// Rate scraping/caching logic lives in ./_cb_rates.js (shared with admin.js
// fundamental_get, so the Fundamental tab's "{Bank} Rate" row stays in sync
// with this endpoint instead of drifting from a static seed).
//
// Sources:
//   USD → FRED API (DFEDTARU – upper target)
//   EUR → ECB Data Portal API (Main Refinancing Rate)
//   GBP → Bank of England website
//   JPY → Bank of Japan website
//   CAD → Bank of Canada Valet API
//   AUD → Reserve Bank of Australia website
//   NZD → Reserve Bank of New Zealand website
//   CHF → Swiss National Bank website

const { getLiveCbRates } = require('./_cb_rates');
const rateLimit = require('./_ratelimit');

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  if (await rateLimit(req, res, { limit: 20, windowSecs: 60, endpoint: 'cb-status' })) return;

  let biasData = {};
  try {
    const biasRaw = await redisCmd('GET', 'cb_bias');
    if (biasRaw) biasData = JSON.parse(biasRaw);
  } catch(e) { console.warn('cb_bias load failed:', e.message); }

  const rates = await getLiveCbRates();
  const result = rates.map(r => ({
    ...r,
    bias:               biasData[r.currency]?.bias               || null,
    confidence:         biasData[r.currency]?.confidence         || null,
    bias_updated:       biasData[r.currency]?.updated_at         || null,
    source_headlines:   biasData[r.currency]?.source_headlines   || [],
    divergence_warning: biasData[r.currency]?.divergence_warning || null,
  }));

  const rateSource = result.find(r => r.rate_source !== 'fallback')?.rate_source || 'fallback';

  return res.status(200).json({
    banks: result,
    fetched_at: new Date().toISOString(),
    rate_source: rateSource,
  });
};
