// api/economic-data.js
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// type:
//   'raw'  — value IS already the metric (rate, index). limit=2
//   'qoq'  — value is a level; compute QoQ % change. limit=3
//   'nfp'  — level; compute monthly change. limit=3
const SERIES = [
  // USD — A191RL1Q225SBEA is already a % growth rate
  ['CPIAUCSL',           'USD', 'cpi',          'raw'],
  ['A191RL1Q225SBEA',    'USD', 'gdp_growth',   'raw'],
  ['UNRATE',             'USD', 'unemployment', 'raw'],
  ['PAYEMS',             'USD', 'nfp',          'nfp'],

  // EUR
  ['CP0000EZ19M086NEST', 'EUR', 'cpi',          'raw'],
  ['EURGDPNQDSMEI',      'EUR', 'gdp_growth',   'qoq'],
  ['LRHUTTTTEZM156S',    'EUR', 'unemployment', 'raw'],

  // GBP
  ['GBRCPIALLMINMEI',    'GBP', 'cpi',          'raw'],
  ['CLVMNACSCAB1GQUK',   'GBP', 'gdp_growth',   'qoq'],
  ['LRHUTTTTGBM156S',    'GBP', 'unemployment', 'raw'],

  // JPY — JPNCPIALLMINMEI sometimes lags; JPNRGDPNQDSMEI is the OECD quarterly level
  ['JPNCPIALLMINMEI',    'JPY', 'cpi',          'raw'],
  ['JPNRGDPNQDSMEI',     'JPY', 'gdp_growth',   'qoq'],
  ['LRHUTTTTJPM156S',    'JPY', 'unemployment', 'raw'],

  // CAD
  ['CANCPIALLMINMEI',    'CAD', 'cpi',          'raw'],
  ['CANGDPNQDSMEI',      'CAD', 'gdp_growth',   'qoq'],
  ['LRHUTTTTCAM156S',    'CAD', 'unemployment', 'raw'],

  // AUD
  ['AUSCPIALLQINMEI',    'AUD', 'cpi',          'raw'],
  ['AUSGDPNQDSMEI',      'AUD', 'gdp_growth',   'qoq'],
  ['LRHUTTTTAUM156S',    'AUD', 'unemployment', 'raw'],

  // NZD
  ['NZLCPIALLQINMEI',    'NZD', 'cpi',          'raw'],
  ['NZLGDPNQDSMEI',      'NZD', 'gdp_growth',   'qoq'],
  ['LRHUTTTTNZM156S',    'NZD', 'unemployment', 'raw'],

  // CHF
  ['CHECPIALLMINMEI',    'CHF', 'cpi',          'raw'],
  ['CHEGDPNQDSMEI',      'CHF', 'gdp_growth',   'qoq'],
  ['LRHUTTTTCHM156S',    'CHF', 'unemployment', 'raw'],
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const FRED_KEY = process.env.FRED_API_KEY;
  const force = req.query?.force === '1';

  if (!force) {
    try {
      const cached = await redisCmd('GET', 'economic_data_v2');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - new Date(parsed.fetched_at).getTime() < CACHE_TTL) {
          return res.status(200).json(parsed);
        }
      }
    } catch(e) {}
  }

  if (!FRED_KEY) {
    try {
      const stale = await redisCmd('GET', 'economic_data_v2');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
    } catch(e) {}
    return res.status(200).json({ error: 'FRED_API_KEY not configured', data: {}, fetched_at: null });
  }

  const results = await Promise.allSettled(
    SERIES.map(([seriesId, , , type]) => {
      const limit = type === 'raw' ? 2 : 3;
      return fetch(
        `${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_KEY}&limit=${limit}&sort_order=desc&file_type=json`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
      ).then(r => r.json());
    })
  );

  const data = {};

  results.forEach((result, i) => {
    const [seriesId, currency, metric, type] = SERIES[i];
    if (result.status !== 'fulfilled') {
      console.warn('FRED fetch failed:', seriesId, result.reason?.message);
      return;
    }
    const json = result.value;
    if (json.error_code || !Array.isArray(json.observations)) {
      console.warn('FRED error for', seriesId, json.error_message || json.error_code);
      return;
    }

    const obs = json.observations.filter(o => o.value && o.value !== '.' && o.value !== 'NA');
    if (!data[currency]) data[currency] = {};

    if (type === 'nfp') {
      if (obs.length < 3) return;
      const [v0, v1, v2] = obs.map(o => parseFloat(o.value));
      if ([v0, v1, v2].some(isNaN)) return;
      data[currency][metric] = {
        value: Math.round(v0 - v1), previous: Math.round(v1 - v2),
        date: obs[0].date, unit: 'K',
      };

    } else if (type === 'qoq') {
      // Quarter-over-quarter % change from level series
      if (obs.length < 3) return;
      const [v0, v1, v2] = obs.map(o => parseFloat(o.value));
      if ([v0, v1, v2].some(isNaN) || v1 === 0 || v2 === 0) return;
      const currGrowth = ((v0 - v1) / Math.abs(v1)) * 100;
      const prevGrowth = ((v1 - v2) / Math.abs(v2)) * 100;
      data[currency][metric] = {
        value:    Math.round(currGrowth * 100) / 100,
        previous: Math.round(prevGrowth * 100) / 100,
        date: obs[0].date, unit: '%',
      };

    } else {
      // 'raw' — use value directly
      if (obs.length < 2) return;
      const [v0, v1] = obs.map(o => parseFloat(o.value));
      if (isNaN(v0) || isNaN(v1)) return;
      data[currency][metric] = {
        value:    Math.round(v0 * 100) / 100,
        previous: Math.round(v1 * 100) / 100,
        date: obs[0].date, unit: metric === 'cpi' ? 'Index' : '%',
      };
    }
  });

  const payload = { data, fetched_at: new Date().toISOString() };
  redisCmd('SET', 'economic_data_v2', JSON.stringify(payload)).catch(() => {});
  return res.status(200).json(payload);
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}
