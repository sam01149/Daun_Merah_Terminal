// api/correlations.js
// Fetches 60-day daily closes via Yahoo Finance and computes
// rolling 20-day correlation matrix. Flags pairs deviating >0.4 from 60d norm.
// Also returns dedicated gold_correlations section (always computed, not just anomalies).
// Redis cache: correlations, TTL 24 hours (86400s).

const rateLimit = require('./_ratelimit');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const CACHE_KEY = 'correlations_v2';
const CACHE_TTL = 86400;

// Yahoo Finance symbols.
// All FX quoted as X/USD (X stronger = higher value).
// JPY: fetched as USDJPY=X then inverted (1/close) so JPY stronger = higher value.
const INSTRUMENTS = {
  // Dollar
  DXY:    'DX-Y.NYB',
  // Major FX — all X/USD direction (currency stronger = price up)
  EUR:    'EURUSD=X',
  GBP:    'GBPUSD=X',
  JPY:    'USDJPY=X',   // inverted post-fetch → JPY stronger = higher
  AUD:    'AUDUSD=X',
  // Precious metals
  Gold:   'GC=F',
  Silver: 'SI=F',
  // Industrial metals (growth/risk proxy)
  Copper: 'HG=F',
  // Energy
  WTI:    'CL=F',
  // Equities & risk
  SPX:    '^GSPC',
  VIX:    '^VIX',
  // Rates
  US10Y:  '^TNX',
};

// Instruments whose raw price must be inverted (1/close) so direction is consistent
const INVERT = new Set(['JPY']);

// Gold's key cross-asset relationships — always shown even without anomaly
const GOLD_CORR_ASSETS = ['DXY', 'Silver', 'Copper', 'WTI', 'US10Y', 'SPX', 'VIX', 'JPY', 'AUD', 'EUR'];

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()).result;
}

async function fetchYahoo(symbol, interval = '1d', range = '3mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${symbol}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo no result for ${symbol}`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];
  const prices = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    const volume = volumes[i] || 0;
    if (close == null || isNaN(close) || close <= 0) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    prices.push({ date, close, volume });
  }
  if (prices.length < 10) throw new Error(`Yahoo insufficient data for ${symbol}: ${prices.length} rows`);
  return prices;
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i]*y[i];
    sx2 += x[i]*x[i]; sy2 += y[i]*y[i];
  }
  const num = n*sxy - sx*sy;
  const den = Math.sqrt((n*sx2 - sx*sx) * (n*sy2 - sy*sy));
  return den === 0 ? null : Math.round((num / den) * 1000) / 1000;
}

// --- Kalkulator Indikator Teknikal (Pure JS) ---
function calcSMA(data, period, key = 'close') {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val[key], 0);
  return sum / period;
}

function calcRSI(data, period = 14) {
  if (data.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = data[i].close - data[i-1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i].close - data[i-1].close;
    avgGain = ((avgGain * (period - 1)) + (change > 0 ? change : 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function alignSeries(a, b) {
  const bMap = {};
  b.forEach(p => { bMap[p.date] = p.close; });
  const xa = [], xb = [];
  for (const p of a) {
    if (bMap[p.date] != null) {
      xa.push(p.close);
      xb.push(bMap[p.date]);
    }
  }
  return [xa, xb];
}

function lastN(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- ENDPOINT TEKNIKAL ANALISIS (TA) ---
  if (req.query.action === 'ta') {
    if (await rateLimit(req, res, { limit: 5, windowSecs: 60, endpoint: 'correlations' })) return;

    const symbol   = req.query.symbol   || 'GC=F';
    const interval = req.query.interval || '1d';

    // Range caps per interval — Yahoo rejects out-of-bounds combinations
    const RANGE_MAP = { '5m':'5d', '15m':'60d', '30m':'60d', '1h':'60d', '4h':'60d', '1d':'1y', '1wk':'5y' };
    const range = RANGE_MAP[interval] || '1y';

    // FX OTC pairs have meaningless volume from Yahoo — only show for futures/equities
    const isFxPair = /=[Xx]$/.test(symbol);

    const cacheKey = `ta:${symbol}:${interval}`;
    const cacheTTL = interval === '1d' ? 1800 : 600; // 30min daily, 10min intraday

    try {
      // Serve Redis cache if fresh
      const cached = await redisCmd('GET', cacheKey);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.computed_at).getTime() < cacheTTL * 1000) {
          return res.status(200).json({ ...d, from_cache: true });
        }
      }

      const prices  = await fetchYahoo(symbol, interval, range);
      const current = prices[prices.length - 1];
      const rsi14   = calcRSI(prices, 14);
      const sma50   = calcSMA(prices, 50,  'close');
      const sma200  = calcSMA(prices, 200, 'close');
      const volSma20 = isFxPair ? null : calcSMA(prices, 20, 'volume');

      const payload = {
        symbol, interval, range,
        current_price:  +current.close.toFixed(5),
        rsi_14:         rsi14  != null ? Math.round(rsi14  * 100) / 100 : null,
        sma_50:         sma50  != null ? Math.round(sma50  * 100) / 100 : null,
        sma_200:        sma200 != null ? Math.round(sma200 * 100) / 100 : null,
        price_vs_sma50:  sma50  != null ? (current.close > sma50  ? 'above' : 'below') : null,
        price_vs_sma200: sma200 != null ? (current.close > sma200 ? 'above' : 'below') : null,
        // Volume — only for futures/equities (not FX OTC)
        current_volume:  isFxPair ? null : (current.volume || null),
        volume_sma_20:   isFxPair ? null : (volSma20 != null ? Math.round(volSma20) : null),
        volume_status:   isFxPair ? null : (
          volSma20 == null ? null :
          current.volume > volSma20 * 1.5 ? 'High' :
          current.volume < volSma20 * 0.7 ? 'Low' : 'Normal'
        ),
        computed_at: new Date().toISOString(),
      };

      await redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', cacheTTL);
      return res.status(200).json({ ...payload, from_cache: false });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (await rateLimit(req, res, { limit: 5, windowSecs: 60, endpoint: 'correlations' })) return;

  // --- SIZING RATES: live FX rates for accurate cross-pair pip value calculation ---
  if (req.query.action === 'rates') {
    const RATES_KEY = 'sizing_rates';
    const RATES_TTL = 300; // 5 minutes
    try {
      const cached = await redisCmd('GET', RATES_KEY);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.fetched_at).getTime() < RATES_TTL * 1000)
          return res.status(200).json({ rates: d.rates, from_cache: true });
      }
    } catch(e) {}

    try {
      const symbols = 'EURUSD=X,GBPUSD=X,AUDUSD=X,NZDUSD=X,USDJPY=X,USDCAD=X,USDCHF=X';
      const r = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
      const d = await r.json();
      const rates = {};
      (d.quoteResponse?.result || []).forEach(q => {
        if (q.regularMarketPrice) rates[q.symbol.replace('=X', '')] = q.regularMarketPrice;
      });
      if (Object.keys(rates).length === 0) throw new Error('Yahoo returned no rates');
      const payload = { rates, fetched_at: new Date().toISOString() };
      await redisCmd('SET', RATES_KEY, JSON.stringify(payload), 'EX', RATES_TTL);
      return res.status(200).json({ rates, from_cache: false });
    } catch(e) {
      // Serve stale cache rather than hard error
      try {
        const stale = await redisCmd('GET', RATES_KEY);
        if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
      } catch(_) {}
      return res.status(500).json({ error: e.message });
    }
  }

  // Try Redis cache first
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const d = JSON.parse(cached);
      const age = Date.now() - new Date(d.computed_at).getTime();
      if (age < CACHE_TTL * 1000) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json({ ...d, stale: false });
      }
    }
  } catch(e) {
    console.warn('correlations cache read failed:', e.message);
  }

  // Fetch all instruments in parallel from Yahoo Finance
  const names = Object.keys(INSTRUMENTS);
  const fetches = names.map(name =>
    fetchYahoo(INSTRUMENTS[name])
      .then(prices => {
        // Invert JPY so direction matches X/USD format (JPY stronger = higher)
        if (INVERT.has(name)) {
          prices = prices.map(p => ({ date: p.date, close: 1 / p.close }));
        }
        return { name, prices, ok: true };
      })
      .catch(e => { console.warn(`correlations: ${name} failed:`, e.message); return { name, prices: [], ok: false }; })
  );
  const results = await Promise.all(fetches);

  const series = {};
  results.forEach(({ name, prices }) => {
    if (prices.length >= 10) series[name] = prices;
  });

  console.log(`correlations: got data for ${Object.keys(series).length}/${names.length} instruments:`, Object.keys(series).join(', '));

  if (Object.keys(series).length < 3) {
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) return res.status(200).json({ ...JSON.parse(cached), stale: true });
    } catch(e) {}
    return res.status(500).json({ error: 'Insufficient data for correlation computation' });
  }

  // Compute 20-day and 60-day correlations for all instrument pairs
  const pairNames = names.filter(n => series[n]);
  const matrix20 = {}, matrix60 = {};
  const anomalies = [];

  for (let i = 0; i < pairNames.length; i++) {
    for (let j = i + 1; j < pairNames.length; j++) {
      const a = pairNames[i], b = pairNames[j];
      const [xa, xb] = alignSeries(series[a], series[b]);
      const r20 = pearson(lastN(xa, 20), lastN(xb, 20));
      const r60 = pearson(xa, xb);
      const key = `${a}|${b}`;
      matrix20[key] = r20;
      matrix60[key] = r60;

      if (r20 !== null && r60 !== null && Math.abs(r20 - r60) > 0.4) {
        anomalies.push({
          pair: key,
          r20,
          r60,
          delta: Math.round((r20 - r60) * 1000) / 1000,
          label: `${a} vs ${b}`,
        });
      }
    }
  }

  anomalies.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Gold correlation table — always computed regardless of anomaly threshold
  const goldCorr = {};
  if (series['Gold']) {
    for (const asset of GOLD_CORR_ASSETS) {
      if (!series[asset]) continue;
      const [xg, xa] = alignSeries(series['Gold'], series[asset]);
      const r20 = pearson(lastN(xg, 20), lastN(xa, 20));
      const r60 = pearson(xg, xa);
      if (r20 !== null || r60 !== null) {
        goldCorr[asset] = {
          r20,
          r60,
          delta: (r20 !== null && r60 !== null) ? Math.round((r20 - r60) * 1000) / 1000 : null,
        };
      }
    }
  }

  const data = {
    instruments: pairNames,
    matrix_20d: matrix20,
    matrix_60d: matrix60,
    anomalies: anomalies.slice(0, 10),
    gold_correlations: goldCorr,
    computed_at: new Date().toISOString(),
  };

  try {
    await redisCmd('SET', CACHE_KEY, JSON.stringify(data), 'EX', CACHE_TTL);
  } catch(e) {
    console.warn('correlations cache write failed:', e.message);
  }

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ ...data, stale: false });
};
