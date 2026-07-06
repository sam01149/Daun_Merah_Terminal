// api/correlations.js
// Fetches 60-day daily closes via Yahoo Finance and computes
// rolling 20-day correlation matrix. Flags pairs deviating >0.4 from 60d norm.
// Also returns dedicated gold_correlations section (always computed, not just anomalies).
// Redis cache: correlations, TTL 24 hours (86400s).

const rateLimit = require('./_ratelimit');
const { withSingleFlight } = require('./_fetch_lock');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const CACHE_KEY = 'correlations_v3';
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
  CAD:    'USDCAD=X',   // inverted post-fetch → CAD stronger = higher
  NZD:    'NZDUSD=X',
  CHF:    'USDCHF=X',   // inverted post-fetch → CHF stronger = higher
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
  // Real yield proxy — TIP (iShares TIPS Bond ETF) price moves inversely with
  // the real yield priced into TIPS, i.e. positively with Gold's actual #1 driver
  // (real yield), unlike US10Y which is nominal and can diverge from it. (COR-D)
  RealYield: 'TIP',
  // Crypto — debasement/macro-liquidity proxy (COR-G)
  BTC:    'BTC-USD',
};

// Instruments whose raw price must be inverted (1/close) so direction is consistent
const INVERT = new Set(['JPY', 'CAD', 'CHF']);

// Gold's key cross-asset relationships — always shown even without anomaly
// BTC (debasement co-movement), GoldSilverRatio (stretch gauge), GoldCopperRatio (safe-haven vs growth) added per COR-G
const GOLD_CORR_ASSETS = ['DXY', 'Silver', 'Copper', 'WTI', 'US10Y', 'RealYield', 'SPX', 'VIX', 'JPY', 'AUD', 'EUR', 'BTC', 'GoldSilverRatio', 'GoldCopperRatio'];

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

function resample4h(candles1h) {
  const bucket = 4 * 3600;
  const map = new Map();
  for (const c of candles1h) {
    const key = Math.floor(c.time / bucket) * bucket;
    if (!map.has(key)) {
      map.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      const b = map.get(key);
      b.high  = Math.max(b.high, c.high);
      b.low   = Math.min(b.low, c.low);
      b.close = c.close;
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- OHLCV CANDLE DATA FOR CHART ---
  if (req.query.action === 'ohlcv') {
    if (await rateLimit(req, res, { limit: 10, windowSecs: 60, endpoint: 'correlations' })) return;

    const symbol = req.query.symbol || 'GC=F';
    const tf     = req.query.tf     || '1d'; // '1d','4h','1h','15m'

    const fetchInterval = tf === '4h' ? '1h' : tf;
    const rangeMap = { '15m': '5d', '1h': '30d', '4h': '60d', '1d': '1y' };
    const range = rangeMap[tf] || '60d';

    // Key SENGAJA beda dari `ohlcv:{symbol}:{tf}` milik admin.js (ohlcv_sync/refresh):
    // payload di sini object {symbol,tf,candles:[{time,open,...}],fetched_at} dengan TTL
    // pendek, sedangkan admin menyimpan array [{t,o,h,l,c,v}] TTL 25h — kalau share key,
    // satu call endpoint ini menimpa snapshot Analisa/Jurnal/Digest dengan shape yang salah.
    const cacheKey = `ohlcv_chart:${symbol}:${tf}`;
    const cacheTTL = tf === '1d' ? 1800 : 300;

    let sf;
    try {
      const cached = await redisCmd('GET', cacheKey);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.fetched_at).getTime() < cacheTTL * 1000)
          return res.status(200).json({ ...d, from_cache: true });
      }

      sf = await withSingleFlight(redisCmd, {
        lockKey: `lock:ohlcv_chart:${symbol}:${tf}`,
        cacheKey,
        isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < cacheTTL * 1000; } catch(e) { return false; } },
      });
      if (!sf.gotLock && sf.fresh) return res.status(200).json({ ...JSON.parse(sf.fresh), from_cache: true });

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${fetchInterval}&range=${range}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('Yahoo no result');

      const timestamps = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      let candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
        candles.push({ time: timestamps[i], open: +o.toFixed(6), high: +h.toFixed(6), low: +l.toFixed(6), close: +c.toFixed(6) });
      }

      if (tf === '4h') candles = resample4h(candles);
      if (candles.length === 0) throw new Error('No candle data returned');

      const payload = { symbol, tf, candles, fetched_at: new Date().toISOString() };
      await redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', cacheTTL);
      if (sf?.gotLock) sf.release();
      return res.status(200).json({ ...payload, from_cache: false });
    } catch(e) {
      if (sf?.gotLock) sf.release();
      return res.status(500).json({ error: e.message });
    }
  }

  // --- ENDPOINT TEKNIKAL ANALISIS (TA) ---
  if (req.query.action === 'ta') {
    const isCronWarm = req.headers['x-cron-secret'] && req.headers['x-cron-secret'] === process.env.CRON_SECRET;
    if (!isCronWarm && await rateLimit(req, res, { limit: 5, windowSecs: 60, endpoint: 'correlations' })) return;

    const symbol   = req.query.symbol   || 'GC=F';
    const interval = req.query.interval || '1d';

    // Range caps per interval — Yahoo rejects out-of-bounds combinations
    const RANGE_MAP = { '5m':'5d', '15m':'60d', '30m':'60d', '1h':'60d', '4h':'60d', '1d':'1y', '1wk':'5y' };
    const range = RANGE_MAP[interval] || '1y';

    // FX OTC pairs have meaningless volume from Yahoo — only show for futures/equities
    const isFxPair = /=[Xx]$/.test(symbol);

    const cacheKey = `ta:${symbol}:${interval}`;
    const cacheTTL = interval === '1d' ? 1800 : 600; // 30min daily, 10min intraday

    let sf;
    try {
      // Serve Redis cache if fresh
      const cached = await redisCmd('GET', cacheKey);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.computed_at).getTime() < cacheTTL * 1000) {
          return res.status(200).json({ ...d, from_cache: true });
        }
      }

      sf = await withSingleFlight(redisCmd, {
        lockKey: `lock:ta:${symbol}:${interval}`,
        cacheKey,
        isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < cacheTTL * 1000; } catch(e) { return false; } },
      });
      if (!sf.gotLock && sf.fresh) return res.status(200).json({ ...JSON.parse(sf.fresh), from_cache: true });

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
      if (sf?.gotLock) sf.release();
      return res.status(200).json({ ...payload, from_cache: false });
    } catch(e) {
      if (sf?.gotLock) sf.release();
      return res.status(500).json({ error: e.message });
    }
  }

  // --- ATR + 1-day VaR for sizing calculator ---
  if (req.query.action === 'atr') {
    const pairInput = req.query.pair || 'EUR/USD';

    const YAHOO_SYMBOL_MAP = {
      'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'AUD/USD': 'AUDUSD=X',
      'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
      'USD/JPY': 'USDJPY=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
      'AUD/JPY': 'AUDJPY=X', 'NZD/JPY': 'NZDJPY=X', 'CAD/JPY': 'CADJPY=X',
      'CHF/JPY': 'CHFJPY=X', 'EUR/GBP': 'EURGBP=X', 'EUR/CAD': 'EURCAD=X',
      'EUR/AUD': 'EURAUD=X', 'EUR/NZD': 'EURNZD=X', 'EUR/CHF': 'EURCHF=X',
      'GBP/CAD': 'GBPCAD=X', 'GBP/AUD': 'GBPAUD=X', 'GBP/NZD': 'GBPNZD=X',
      'GBP/CHF': 'GBPCHF=X', 'AUD/CAD': 'AUDCAD=X', 'AUD/NZD': 'AUDNZD=X',
      'AUD/CHF': 'AUDCHF=X', 'NZD/CAD': 'NZDCAD=X', 'NZD/CHF': 'NZDCHF=X',
      'CAD/CHF': 'CADCHF=X', 'XAU/USD': 'GC=F',
    };
    // XAU: 0.01 — HARUS sama dengan konvensi pip Sizing Calculator di index.html
    // (calcSizing/szAutoComputePips pakai 0.01 untuk gold). Sebelumnya 0.1 → atr_pips
    // gold 10× lebih kecil dari satuan pip yang diketik user di form sizing, sehingga
    // warning "SL < ATR" dan VaR gold salah 10×.
    const PIP_SIZE_MAP = {
      'USD/JPY': 0.01, 'EUR/JPY': 0.01, 'GBP/JPY': 0.01, 'AUD/JPY': 0.01,
      'NZD/JPY': 0.01, 'CAD/JPY': 0.01, 'CHF/JPY': 0.01, 'XAU/USD': 0.01,
    };
    const pipSize = PIP_SIZE_MAP[pairInput] || 0.0001;
    const symbol = YAHOO_SYMBOL_MAP[pairInput];
    if (!symbol) return res.status(400).json({ error: 'Unknown pair' });

    // v2: bust cache lama yang masih menyimpan atr_pips XAU dengan pip 0.1
    const cacheKey = `atr_v2:${symbol}`;
    const cacheTTL = 14400;

    let sf;
    try {
      const cached = await redisCmd('GET', cacheKey);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.computed_at).getTime() < cacheTTL * 1000)
          return res.status(200).json({ ...d, from_cache: true });
      }

      sf = await withSingleFlight(redisCmd, {
        lockKey: `lock:atr:${symbol}`,
        cacheKey,
        isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < cacheTTL * 1000; } catch(e) { return false; } },
      });
      if (!sf.gotLock && sf.fresh) return res.status(200).json({ ...JSON.parse(sf.fresh), from_cache: true });

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No result');

      const q = result.indicators?.quote?.[0] || {};
      const highs  = q.high  || [];
      const lows   = q.low   || [];
      const closes = q.close || [];

      const candles = [];
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] == null || highs[i] == null || lows[i] == null) continue;
        candles.push({ high: highs[i], low: lows[i], close: closes[i] });
      }
      if (candles.length < 15) throw new Error('Insufficient data');

      const trValues = [];
      for (let i = 1; i < candles.length; i++) {
        const { high, low } = candles[i];
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trValues.push(tr);
      }
      const atr14 = trValues.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trValues.length);
      const atrPips = Math.round(atr14 / pipSize);

      const returns = [];
      for (let i = 1; i < candles.length; i++) {
        returns.push(Math.log(candles[i].close / candles[i - 1].close));
      }
      const recentReturns = returns.slice(-20);
      const meanR = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
      const variance = recentReturns.reduce((acc, r) => acc + (r - meanR) ** 2, 0) / recentReturns.length;
      const dailySigma = Math.sqrt(variance);

      const payload = {
        pair: pairInput, symbol,
        atr_14d: +atr14.toFixed(6),
        atr_pips: atrPips,
        daily_sigma: +dailySigma.toFixed(6),
        pip_size: pipSize,
        computed_at: new Date().toISOString(),
      };
      await redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', cacheTTL);
      if (sf?.gotLock) sf.release();
      return res.status(200).json({ ...payload, from_cache: false });

    } catch(e) {
      if (sf?.gotLock) sf.release();
      try {
        const stale = await redisCmd('GET', cacheKey);
        if (stale) return res.status(200).json({ ...JSON.parse(stale), from_cache: true, stale: true });
      } catch(_) {}
      return res.status(500).json({ error: e.message });
    }
  }

  // --- FX RISK REVERSALS (25-delta implied vol skew) ---
  // Positive RR → call premium > put premium → market biased upside (institution hedge short).
  // Negative RR → put premium > call premium → market fears downside.
  // Sources (tried in order): CME CVOL Skew → Barchart OnDemand → unavailable message.
  if (req.query.action === 'risk-reversal') {
    const RR_CACHE_KEY = 'rr_cache_v2'; // v2: new /services/cvol endpoint + 6 pairs incl XAU
    const RR_CACHE_TTL = 3600;

    try {
      const cached = await redisCmd('GET', RR_CACHE_KEY);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.computed_at).getTime() < RR_CACHE_TTL * 1000)
          return res.status(200).json({ ...d, from_cache: true });
      }
    } catch(_) {}

    const rrSf = await withSingleFlight(redisCmd, {
      lockKey: 'lock:risk-reversal',
      cacheKey: RR_CACHE_KEY,
      isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < RR_CACHE_TTL * 1000; } catch(e) { return false; } },
    });
    if (!rrSf.gotLock && rrSf.fresh) return res.status(200).json({ ...JSON.parse(rrSf.fresh), from_cache: true });

    // New endpoint: /services/cvol (replaces deprecated /CmeWS/mvc/Volatility/historical)
    // Symbols confirmed via direct browser test 2026-06-05.
    // NZD/USD + USD/CHF: CME returns ok but no skew field (options too illiquid — not available).
    const CME_CVOL_PAIRS = {
      'EUR/USD': 'EUVL',
      'GBP/USD': 'GBVL',
      'USD/JPY': 'JPVL',
      'AUD/USD': 'ADVL',
      'USD/CAD': 'CAVL',  // fix: CDVL has no skew data
      'XAU/USD': 'GCVL',  // Gold CVOL
    };
    const CME_HDR = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.cmegroup.com/markets/fx/g10/euro-fx.html',
    };

    let pairs = {}, source = null, cmeFailedReasons = [];
    const scraperKey = process.env.SCRAPER_API_KEY;

    // Attempt 1: CME CVOL /services endpoint — via ScraperAPI proxy if key set, else direct
    // Response: array [{ skew: "-0.4020", atmInd, cvolPrice, ... }]
    try {
      const settled = await Promise.allSettled(
        Object.entries(CME_CVOL_PAIRS).map(async ([pair, code]) => {
          const targetUrl = `https://www.cmegroup.com/services/cvol?symbol=${code}&isProtected&_t=${Date.now()}`;
          const fetchUrl = scraperKey
            ? `https://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}`
            : targetUrl;
          const fetchHeaders = scraperKey ? { 'Accept': 'application/json' } : CME_HDR;
          const r = await fetch(fetchUrl, { headers: fetchHeaders, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`CME CVOL ${code} HTTP ${r.status}`);
          const json = await r.json();
          // Response is array or single object — normalize to single entry
          const entry = Array.isArray(json) ? json[0] : json;
          if (!entry) throw new Error(`CME CVOL ${code}: empty response`);
          const skew = parseFloat(entry.skew ?? entry.SkewDiff ?? entry.skewDiff ?? entry.value ?? 'x');
          if (isNaN(skew)) throw new Error(`CME CVOL ${code}: no parseable skew (keys: ${Object.keys(entry).join(',')})`);
          return { pair, rr_value: +skew.toFixed(3), source: 'CME CVOL' };
        })
      );
      const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
      const failed = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message);
      cmeFailedReasons = failed;
      if (failed.length) console.warn('risk-reversal: CME CVOL partial failures:', failed);
      if (ok.length >= 3) {
        ok.forEach(d => { pairs[d.pair] = { rr_value: d.rr_value, source: d.source }; });
        source = 'cme_cvol';
      } else {
        throw new Error(`Only ${ok.length}/6 CME CVOL pairs returned data`);
      }
    } catch(e) {
      console.warn('risk-reversal: CME CVOL failed:', e.message);
    }

    // Attempt 2: Barchart OnDemand (requires BARCHART_API_KEY env var — free signup)
    if (!source && process.env.BARCHART_API_KEY) {
      const BARCHART_MAP = {
        'EUR/USD': '6E', 'GBP/USD': '6B', 'USD/JPY': '6J',
        'AUD/USD': '6A', 'USD/CAD': '6C', 'NZD/USD': '6N', 'USD/CHF': '6S',
      };
      try {
        const settled = await Promise.allSettled(
          Object.entries(BARCHART_MAP).map(async ([pair, root]) => {
            const url = `https://ondemand.websol.barchart.com/getFuturesOptionsEOD.json?apikey=${process.env.BARCHART_API_KEY}&root=${root}&fields=impliedVolatility,delta,type&orderDir=asc&limit=200`;
            const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`Barchart ${root} HTTP ${r.status}`);
            const json = await r.json();
            const opts = json?.results || [];
            const calls = opts.filter(o => o.type === 'Call' && Math.abs((+o.delta || 0) - 0.25) <= 0.06)
              .sort((a, b) => Math.abs(+a.delta - 0.25) - Math.abs(+b.delta - 0.25));
            const puts  = opts.filter(o => o.type === 'Put'  && Math.abs((+o.delta || 0) + 0.25) <= 0.06)
              .sort((a, b) => Math.abs(+a.delta + 0.25) - Math.abs(+b.delta + 0.25));
            if (!calls.length || !puts.length) throw new Error(`Barchart ${root}: no 25d options`);
            const call_iv = +parseFloat(calls[0].impliedVolatility).toFixed(3);
            const put_iv  = +parseFloat(puts[0].impliedVolatility).toFixed(3);
            if (isNaN(call_iv) || isNaN(put_iv)) throw new Error(`Barchart ${root}: NaN IV`);
            return { pair, rr_value: +(call_iv - put_iv).toFixed(3), call_iv, put_iv, source: 'Barchart OnDemand' };
          })
        );
        const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
        if (ok.length >= 3) {
          ok.forEach(d => { pairs[d.pair] = { rr_value: d.rr_value, call_iv: d.call_iv, put_iv: d.put_iv, source: d.source }; });
          source = 'barchart';
        }
      } catch(e) {
        console.warn('risk-reversal: Barchart failed:', e.message);
      }
    }

    if (!source) {
      if (rrSf.gotLock) rrSf.release();
      const cme404 = cmeFailedReasons.some(m => m?.includes('HTTP 404'));
      const hint = cme404
        ? 'CME CVOL endpoint returned 404 — URL has been removed/moved by CME. Needs new endpoint URL.'
        : scraperKey
          ? 'ScraperAPI active but CME CVOL returned no parseable data.'
          : 'CME CVOL blocked from Vercel IPs. Add SCRAPER_API_KEY env var to enable proxy bypass.';
      return res.status(200).json({ available: false, reason: hint, computed_at: new Date().toISOString() });
    }

    const payload = { available: true, pairs, source, computed_at: new Date().toISOString() };
    redisCmd('SET', RR_CACHE_KEY, JSON.stringify(payload), 'EX', RR_CACHE_TTL).catch(() => {});
    if (rrSf.gotLock) rrSf.release();
    return res.status(200).json({ ...payload, from_cache: false });
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

    const ratesSf = await withSingleFlight(redisCmd, {
      lockKey: 'lock:sizing_rates',
      cacheKey: RATES_KEY,
      isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < RATES_TTL * 1000; } catch(e) { return false; } },
    });
    if (!ratesSf.gotLock && ratesSf.fresh) return res.status(200).json({ rates: JSON.parse(ratesSf.fresh).rates, from_cache: true });

    try {
      // v7/finance/quote (batched, single request) increasingly returns 401
      // without a session crumb/cookie Yahoo now requires for that endpoint.
      // v8/finance/chart doesn't need one and is already used successfully
      // elsewhere in this file (ohlcv/ta/atr/daily-snapshot) — costs one
      // request per symbol instead of one batched call, but works.
      const symbols = ['EURUSD=X', 'GBPUSD=X', 'AUDUSD=X', 'NZDUSD=X', 'USDJPY=X', 'USDCAD=X', 'USDCHF=X'];
      const fetchOne = async (sym) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${sym}`);
        const json = await r.json();
        const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price) throw new Error(`no price for ${sym}`);
        return { sym, price };
      };
      const settled = await Promise.allSettled(symbols.map(fetchOne));
      const rates = {};
      settled.forEach(s => {
        if (s.status === 'fulfilled') rates[s.value.sym.replace('=X', '')] = s.value.price;
        else console.warn('sizing rates:', s.reason?.message);
      });
      if (Object.keys(rates).length === 0) throw new Error('Yahoo v8 chart returned no rates');
      const payload = { rates, fetched_at: new Date().toISOString() };
      await redisCmd('SET', RATES_KEY, JSON.stringify(payload), 'EX', RATES_TTL);
      if (ratesSf.gotLock) ratesSf.release();
      return res.status(200).json({ rates, from_cache: false });
    } catch(e) {
      if (ratesSf.gotLock) ratesSf.release();
      // Serve stale cache rather than hard error
      try {
        const stale = await redisCmd('GET', RATES_KEY);
        if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
      } catch(_) {}
      return res.status(500).json({ error: e.message });
    }
  }

  // --- DAILY PULSE: FX % change today + 10Y yield moves ---
  if (req.query.action === 'daily-snapshot') {
    const SNAP_KEY = 'daily_snapshot';
    const SNAP_TTL = 300; // 5 minutes

    try {
      const cached = await redisCmd('GET', SNAP_KEY);
      if (cached) {
        const d = JSON.parse(cached);
        if (Date.now() - new Date(d.fetched_at).getTime() < SNAP_TTL * 1000)
          return res.status(200).json({ ...d, from_cache: true });
      }
    } catch(_) {}

    const snapSf = await withSingleFlight(redisCmd, {
      lockKey: 'lock:daily_snapshot',
      cacheKey: SNAP_KEY,
      isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < SNAP_TTL * 1000; } catch(e) { return false; } },
    });
    if (!snapSf.gotLock && snapSf.fresh) return res.status(200).json({ ...JSON.parse(snapSf.fresh), from_cache: true });

    // Use v8/finance/chart (same endpoint as main correlations — confirmed working from Vercel).
    // v7/finance/quote can be blocked for certain calls; v8/chart is more reliable.
    const fetchDailyChart = async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('no chart result');
      const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0);
      if (closes.length < 2) throw new Error(`only ${closes.length} closes`);
      return { price: closes[closes.length - 1], prev: closes[closes.length - 2] };
    };

    // invert:true → USD/xxx pair: higher price = xxx weaker, so negate pct for currency strength
    const FX_MAP = {
      EUR: { sym: 'EURUSD=X', invert: false },
      GBP: { sym: 'GBPUSD=X', invert: false },
      AUD: { sym: 'AUDUSD=X', invert: false },
      NZD: { sym: 'NZDUSD=X', invert: false },
      JPY: { sym: 'USDJPY=X', invert: true  },
      CAD: { sym: 'USDCAD=X', invert: true  },
      CHF: { sym: 'USDCHF=X', invert: true  },
    };
    // ^TNX confirmed in INSTRUMENTS. Others: ^GDBR10 (DE), ^JN10Y (JP), ^TMBMKGB-10Y (GB).
    // Yields quoted in % so (price - prev) * 100 = change in bps.
    const YIELD_MAP = {
      US: '^TNX',
      DE: '^GDBR10',
      JP: '^JN10Y',
      GB: '^TMBMKGB-10Y',
    };

    try {
      const allEntries = [
        ...Object.entries(FX_MAP).map(([cur, { sym, invert }]) => ({ type: 'fx',    key: cur, sym, invert })),
        ...Object.entries(YIELD_MAP).map(([key, sym])           => ({ type: 'yield', key,     sym         })),
      ];

      const results = await Promise.allSettled(
        allEntries.map(async (entry) => ({ ...entry, data: await fetchDailyChart(entry.sym) }))
      );

      const fx = {}, yields = {};
      results.forEach((r, i) => {
        const entry = allEntries[i];
        if (r.status !== 'fulfilled') {
          console.warn(`daily-snapshot: ${entry.sym} failed: ${r.reason?.message}`);
          return;
        }
        const { price, prev } = r.value.data;
        if (entry.type === 'fx') {
          const raw = +((price - prev) / prev * 100).toFixed(3);
          fx[entry.key] = { pct: entry.invert ? -raw : raw };
        } else {
          // yield quoted in % — difference in pp * 100 = bps
          yields[entry.key] = {
            level:      +price.toFixed(3),
            change_bps: Math.round((price - prev) * 100),
          };
        }
      });

      if (Object.keys(fx).length === 0) throw new Error('all FX fetches failed');
      const payload = { fx, yields, fetched_at: new Date().toISOString() };
      redisCmd('SET', SNAP_KEY, JSON.stringify(payload), 'EX', SNAP_TTL).catch(() => {});
      if (snapSf.gotLock) snapSf.release();
      return res.status(200).json({ ...payload, from_cache: false });
    } catch(e) {
      if (snapSf.gotLock) snapSf.release();
      try {
        const stale = await redisCmd('GET', SNAP_KEY);
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

  const mainSf = await withSingleFlight(redisCmd, {
    lockKey: 'lock:correlations',
    cacheKey: CACHE_KEY,
    isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < CACHE_TTL * 1000; } catch(e) { return false; } },
  });
  if (!mainSf.gotLock && mainSf.fresh) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ ...JSON.parse(mainSf.fresh), stale: false });
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

  // COR-G: Compute synthetic ratio series from aligned Gold/Silver/Copper closes
  // GoldSilverRatio (debasement stretch gauge — high = gold expensive vs silver, possible reversion)
  if (series['Gold'] && series['Silver']) {
    const silverMap = {};
    series['Silver'].forEach(p => { silverMap[p.date] = p.close; });
    const ratioGS = series['Gold']
      .filter(p => silverMap[p.date] != null && silverMap[p.date] > 0)
      .map(p => ({ date: p.date, close: p.close / silverMap[p.date] }));
    if (ratioGS.length >= 10) series['GoldSilverRatio'] = ratioGS;
  }
  // GoldCopperRatio (safe-haven vs growth gauge — rising = haven demand overwhelming growth signal)
  if (series['Gold'] && series['Copper']) {
    const copperMap = {};
    series['Copper'].forEach(p => { copperMap[p.date] = p.close; });
    const ratioGC = series['Gold']
      .filter(p => copperMap[p.date] != null && copperMap[p.date] > 0)
      .map(p => ({ date: p.date, close: p.close / copperMap[p.date] }));
    if (ratioGC.length >= 10) series['GoldCopperRatio'] = ratioGC;
  }

  console.log(`correlations: got data for ${Object.keys(series).length}/${names.length} instruments:`, Object.keys(series).join(', '));

  if (Object.keys(series).length < 3) {
    if (mainSf.gotLock) mainSf.release();
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) return res.status(200).json({ ...JSON.parse(cached), stale: true });
    } catch(e) {}
    return res.status(500).json({ error: 'Insufficient data for correlation computation' });
  }

  // Compute 20-day and 60-day correlations for all instrument pairs
  // Include synthetic series (GoldSilverRatio, GoldCopperRatio) which are not in INSTRUMENTS
  const syntheticNames = Object.keys(series).filter(n => !names.includes(n));
  const pairNames = [...names.filter(n => series[n]), ...syntheticNames];
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
  if (mainSf.gotLock) mainSf.release();

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ ...data, stale: false });
};
