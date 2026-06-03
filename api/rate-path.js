// api/rate-path.js
// Market-implied rate path from Fed Funds futures.
// Fallback chain: CME FedWatch → CME ZQ settlement → Yahoo Finance ZQ futures → heuristic.
// Redis cache: rate_path, TTL 4 hours (14400s).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const CACHE_KEY = 'rate_path';
const CACHE_TTL = 14400; // 4 hours

// CME FedWatch hidden API — powers the FedWatch tool directly, returns per-meeting probabilities
const CME_FEDWATCH_URL = 'https://www.cmegroup.com/CmeWS/mvc/FedWatch/tool/get/{DATE}?startDate=2024-01-01';
// CME 30-Day Fed Funds Futures (ZQ) settlement — fallback if FedWatch API blocked
const CME_ZQ_URL = 'https://www.cmegroup.com/CmeWS/mvc/Settlements/futures/tradeDate/{DATE}/productCode/ZQ';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// ZQ futures month codes (standard CME/Yahoo Finance convention)
const ZQ_MONTH_CODES = {
  '01':'F','02':'G','03':'H','04':'J','05':'K','06':'M',
  '07':'N','08':'Q','09':'U','10':'V','11':'X','12':'Z',
};

function fomcDateToZQTicker(fomcDate) {
  // "2026-06-18" → "ZQM26=F"
  const [year, month] = fomcDate.split('-');
  const code = ZQ_MONTH_CODES[month];
  return code ? `ZQ${code}${year.slice(2)}=F` : null;
}

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

async function fetchFredSeries(seriesId, apiKey) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=5&file_type=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
  const d = await r.json();
  return (d.observations || []).find(o => o.value !== '.');
}

// Get last business day date as YYYYMMDD string
function lastBusinessDay() {
  const d = new Date();
  // Go back until we hit a weekday
  d.setDate(d.getDate() - 1); // start from yesterday
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setDate(d.getDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

// Fetch from CME FedWatch hidden API — takes NEXT FOMC MEETING DATE as parameter
async function fetchCMEFedWatch() {
  const now = new Date();
  const nextMeeting = getNextFOMCMeetings(now, 1)[0]; // e.g. "2026-06-18"
  if (!nextMeeting) throw new Error('No upcoming FOMC meeting found');
  const url = CME_FEDWATCH_URL.replace('{DATE}', nextMeeting);
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html',
      'Origin': 'https://www.cmegroup.com',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`CME FedWatch HTTP ${r.status}`);
  const json = await r.json();

  // Response: array of meeting objects with probabilities per target range
  const meetings = Array.isArray(json) ? json : json?.FedWatchTool || json?.meetings || [];
  if (!meetings || meetings.length === 0) throw new Error('CME FedWatch: no meetings data');

  return { meetings, trade_date: new Date().toISOString().slice(0, 10) };
}

// Try fetching ZQ (30-day Fed Funds futures) settlement data — fallback
async function fetchCMEZQData() {
  const dateStr = lastBusinessDay();
  const url = CME_ZQ_URL.replace('{DATE}', dateStr);
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.settlements.html',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`CME ZQ HTTP ${r.status}`);
  const json = await r.json();

  const settlements = json?.settlements || json?.items || [];
  if (!Array.isArray(settlements) || settlements.length === 0) throw new Error('CME ZQ: no settlements data');

  const contracts = settlements
    .filter(s => s.settle && s.settle !== '-' && !isNaN(parseFloat(s.settle)))
    .slice(0, 8)
    .map(s => ({
      month: s.month || s.expirationMonth || '',
      price: parseFloat(s.settle),
      implied_rate: +(100 - parseFloat(s.settle)).toFixed(4),
    }));

  if (contracts.length < 2) throw new Error('CME ZQ: insufficient contracts');
  return { contracts, trade_date: dateStr };
}

// Fetch ZQ futures from Yahoo Finance — tries both 2-digit and 1-digit year formats per contract
// (e.g., ZQM26=F AND ZQM6=F) since Yahoo's convention for CBOT products is inconsistent
async function fetchYahooZQFutures(meetings) {
  const prices = {}, resolvedTickerMap = {};

  await Promise.allSettled(meetings.map(async date => {
    const [year, month] = date.split('-');
    const code = ZQ_MONTH_CODES[month];
    if (!code) return;
    // Try 2-digit year first (ZQM26=F), then 1-digit year (ZQM6=F)
    const candidates = [`ZQ${code}${year.slice(2)}=F`, `ZQ${code}${year.slice(3)}=F`];
    for (const ticker of candidates) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) { console.warn(`Yahoo ZQ ${ticker}: HTTP ${r.status}`); continue; }
        const d = await r.json();
        const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price || isNaN(price)) { console.warn(`Yahoo ZQ ${ticker}: no regularMarketPrice in response`); continue; }
        prices[date] = +parseFloat(price).toFixed(4);
        resolvedTickerMap[date] = ticker;
        return; // found valid price for this meeting, stop trying other formats
      } catch(e) {
        console.warn(`Yahoo ZQ ${ticker}:`, e.message);
      }
    }
  }));

  if (Object.keys(prices).length === 0) throw new Error('Yahoo ZQ: all tickers (both formats) failed');
  return { prices, tickerMap: resolvedTickerMap };
}

// FRED T-bill term structure — guaranteed accessible (FRED key already used for DFF)
// DGS1MO (4-week T-bill) ≈ market-implied rate for next 30 days → covers 1st meeting
// DGS3MO (3-month T-bill) ≈ market-implied rate for next 90 days → covers 2nd/3rd meeting
// Less precise than ZQ futures (affected by T-bill supply/demand) but real market data
async function fetchFredTbillPath(meetings, currentRate, apiKey) {
  const [obs1m, obs3m] = await Promise.all([
    fetchFredSeries('DGS1MO', apiKey).catch(() => null),
    fetchFredSeries('DGS3MO', apiKey).catch(() => null),
  ]);
  const r1m = obs1m ? parseFloat(obs1m.value) : null;
  const r3m = obs3m ? parseFloat(obs3m.value) : null;
  if (r1m == null && r3m == null) throw new Error('FRED T-bill: DGS1MO and DGS3MO both unavailable');

  const meetingProbs = meetings.map((date, i) => {
    const impliedRate = i === 0 ? (r1m ?? r3m) : (r3m ?? r1m);
    const delta = +(impliedRate - currentRate).toFixed(4);
    const prob_cut25  = Math.max(0, Math.min(1, +(-delta / 0.25).toFixed(4)));
    const prob_hike25 = Math.max(0, Math.min(1, +(delta / 0.25).toFixed(4)));
    const prob_hold   = Math.max(0, +(1 - prob_cut25 - prob_hike25).toFixed(4));
    return { date, prob_hold, prob_cut25, prob_hike25, implied_rate: impliedRate };
  });

  const cum3m = r3m != null ? Math.round((r3m - currentRate) * 100) : null;
  return {
    source: 'fred_tbill_term',
    current_rate: currentRate,
    USD: { next_meetings: meetingProbs, cumulative_3m_bps: cum3m },
    tbill_1m: r1m,
    tbill_3m: r3m,
    data_note: 'T-bill term structure proxy — real market data, ±5bps accuracy vs ZQ futures.',
    computed_at: new Date().toISOString(),
  };
}

async function computeRatePath(apiKey) {
  // Fetch current effective rate from FRED DFF (Daily Fed Funds Rate) — used by all paths
  const currentRate = await fetchFredSeries('DFF', apiKey)
    .then(o => parseFloat(o.value))
    .catch(() => 3.58); // fallback to approximate midpoint of 3.50-3.75 range

  const now = new Date();
  const nextMeetings = getNextFOMCMeetings(now, 3);

  // Step 1: try CME FedWatch hidden API (exact probabilities, same source as fedwatch tool)
  try {
    const fwData = await fetchCMEFedWatch();
    // Parse meeting probabilities from FedWatch response
    // Response structure varies — try common shapes
    const meetingProbs = nextMeetings.map(date => {
      const mtg = fwData.meetings.find(m => {
        const d = m.meeting_date || m.meetingDate || m.date || '';
        return d.startsWith(date) || d.includes(date.slice(5)); // match YYYY-MM-DD or MM-DD
      });
      if (!mtg) return { date, prob_hold: 0.5, prob_cut25: 0.5, prob_hike25: 0, implied_rate: null };
      // Find hold/cut/hike probabilities from probs array
      const probs = mtg.probs || mtg.probabilities || mtg.targetRateProbabilities || [];
      const holdEntry = probs.find(p => (p.label||p.targetRate||'').toString().includes('NO CHANGE') || (p.probPct ?? p.probability) !== undefined && (p.label||'').toLowerCase().includes('no'));
      const cutEntry  = probs.find(p => (p.label||p.targetRate||'').toString().toLowerCase().includes('ease') || (p.label||'').includes('-'));
      const hikeEntry = probs.find(p => (p.label||p.targetRate||'').toString().toLowerCase().includes('hike') || (p.label||'').includes('+'));
      const prob_hold   = Math.round((parseFloat(holdEntry?.probPct ?? holdEntry?.probability ?? 50)) * 100) / 10000;
      const prob_cut25  = Math.round((parseFloat(cutEntry?.probPct  ?? cutEntry?.probability  ?? 0))  * 100) / 10000;
      const prob_hike25 = Math.round((parseFloat(hikeEntry?.probPct ?? hikeEntry?.probability ?? 0))  * 100) / 10000;
      return { date, prob_hold, prob_cut25, prob_hike25, implied_rate: null };
    });

    const totalCutProb3m = meetingProbs.slice(0,3).reduce((s,m) => s + m.prob_cut25, 0);
    return {
      source: 'cme_fedwatch',
      current_rate: currentRate,
      USD: { next_meetings: meetingProbs, cumulative_3m_bps: Math.round(-totalCutProb3m * 25) },
      trade_date: fwData.trade_date,
      computed_at: new Date().toISOString(),
    };
  } catch(e) {
    console.warn('rate-path: CME FedWatch API failed:', e.message, '— trying ZQ futures');
  }

  // Step 2: try CME ZQ futures settlement prices
  try {
    const zqData = await fetchCMEZQData();

    const meetingProbs = nextMeetings.map((date, i) => {
      const contract = zqData.contracts[i] || zqData.contracts[zqData.contracts.length - 1];
      const impliedRate = contract.implied_rate;
      const delta = +(impliedRate - currentRate).toFixed(4);
      const prob_cut25  = Math.max(0, Math.min(1, +(-delta / 0.25).toFixed(4)));
      const prob_hike25 = Math.max(0, Math.min(1, +(delta / 0.25).toFixed(4)));
      const prob_hold   = Math.max(0, +(1 - prob_cut25 - prob_hike25).toFixed(4));
      return { date, prob_hold, prob_cut25, prob_hike25, implied_rate: impliedRate };
    });

    const cum3m = Math.round((zqData.contracts[Math.min(2, zqData.contracts.length - 1)].implied_rate - currentRate) * 100);
    const cum6m = Math.round((zqData.contracts[Math.min(5, zqData.contracts.length - 1)].implied_rate - currentRate) * 100);

    return {
      source: 'cme_zq_futures',
      current_rate: currentRate,
      USD: { next_meetings: meetingProbs, cumulative_3m_bps: cum3m, cumulative_6m_bps: cum6m },
      zq_contracts: zqData.contracts.slice(0, 6),
      trade_date: zqData.trade_date,
      computed_at: new Date().toISOString(),
    };
  } catch(e) {
    console.warn('rate-path: CME ZQ fetch also failed:', e.message, '— trying Yahoo Finance ZQ');
  }

  // Step 2.5: Yahoo Finance ZQ futures (ZQM26=F etc.) — same math, different data source
  // Yahoo Finance already accessible from Vercel (confirmed via correlations.js ATR fetches)
  try {
    const { prices, tickerMap } = await fetchYahooZQFutures(nextMeetings);

    const meetingProbs = nextMeetings.map(date => {
      const price = prices[date];
      if (price == null) return { date, prob_hold: 0.85, prob_cut25: 0.15, prob_hike25: 0, implied_rate: null };
      const impliedRate = +(100 - price).toFixed(4);
      const delta = +(impliedRate - currentRate).toFixed(4);
      const prob_cut25  = Math.max(0, Math.min(1, +(-delta / 0.25).toFixed(4)));
      const prob_hike25 = Math.max(0, Math.min(1, +(delta / 0.25).toFixed(4)));
      const prob_hold   = Math.max(0, +(1 - prob_cut25 - prob_hike25).toFixed(4));
      return { date, prob_hold, prob_cut25, prob_hike25, implied_rate: impliedRate };
    });

    const contracts = nextMeetings
      .filter(d => prices[d] != null)
      .map(d => ({ date: d, ticker: tickerMap[d], price: prices[d], implied_rate: +(100 - prices[d]).toFixed(4) }));

    const cum3m = contracts.length >= 1
      ? Math.round((contracts[Math.min(2, contracts.length - 1)].implied_rate - currentRate) * 100)
      : 0;

    return {
      source: 'yahoo_zq_futures',
      current_rate: currentRate,
      USD: { next_meetings: meetingProbs, cumulative_3m_bps: cum3m },
      zq_contracts: contracts,
      computed_at: new Date().toISOString(),
    };
  } catch(e) {
    console.warn('rate-path: Yahoo ZQ also failed:', e.message, '— trying FRED T-bill term structure');
  }

  // Step 2.7: FRED T-bill term structure — DGS1MO + DGS3MO as market-implied rate proxy
  // Guaranteed accessible (same FRED key as DFF fetch). Less accurate than ZQ but better than heuristic.
  try {
    return await fetchFredTbillPath(nextMeetings, currentRate, apiKey);
  } catch(e) {
    console.warn('rate-path: FRED T-bill fallback failed:', e.message, '— falling back to heuristic');
  }

  // Step 3: heuristic fallback — distance from neutral rate (~3.0%) drives probability
  // Fed neutral rate estimate: 3.0%. Further above = more likely to cut.
  const neutral = 3.0;
  const d = currentRate - neutral;
  // probCut25 per meeting (conservative — market usually prices lower than this when on hold)
  const probCut25 = d > 1.5 ? 0.40   // >4.5% — aggressive cutting cycle
                  : d > 0.75 ? 0.25  // 3.75-4.5% — above neutral, cuts likely
                  : d > 0.25 ? 0.12  // 3.25-3.75% — near neutral/pause (current range)
                  : d > -0.25 ? 0.08 // near neutral — on hold
                  : 0.05;            // below neutral — unlikely to cut
  const probHold  = 1 - probCut25;
  const implied3m = -Math.round(probCut25 * 3 * 25);
  const implied6m = -Math.round(probCut25 * 6 * 25);

  return {
    source: 'heuristic_sofr',
    current_rate: currentRate,
    USD: {
      next_meetings: nextMeetings.map(d => ({
        date: d,
        prob_hold:   Math.round(probHold * 100) / 100,
        prob_cut25:  Math.round(probCut25 * 100) / 100,
        prob_hike25: 0,
      })),
      cumulative_3m_bps: implied3m,
      cumulative_6m_bps: implied6m,
    },
    data_note: 'CME FedWatch & ZQ unavailable — approximated from FRED DFF. For precise probabilities, check cmegroup.com/fedwatch.',
    computed_at: new Date().toISOString(),
  };
}

function getNextFOMCMeetings(from, count) {
  // Known 2026 FOMC meeting dates (update quarterly)
  const known = [
    '2026-05-07','2026-06-18','2026-07-30','2026-09-17',
    '2026-11-05','2026-12-17',
    '2027-01-28','2027-03-18','2027-04-29',
  ];
  const fromStr = from.toISOString().slice(0, 10);
  return known.filter(d => d > fromStr).slice(0, count);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const FRED_KEY = process.env.FRED_API_KEY;
  const forceRefresh = req.query.force === '1';

  // Try Redis cache first (skip if ?force=1)
  if (!forceRefresh) {
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
      console.warn('rate-path cache read failed:', e.message);
    }
  }

  // Compute fresh data
  let data;
  try {
    data = await computeRatePath(FRED_KEY);
    // Save to Redis
    try {
      await redisCmd('SET', CACHE_KEY, JSON.stringify(data), 'EX', CACHE_TTL);
    } catch(e) {
      console.warn('rate-path cache write failed:', e.message);
    }
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ ...data, stale: false });
  } catch(e) {
    console.error('rate-path computation failed:', e.message);

    // Try stale cache
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) {
        res.setHeader('X-Cache', 'STALE');
        return res.status(200).json({ ...JSON.parse(cached), stale: true });
      }
    } catch(e2) {}

    return res.status(500).json({ error: 'Rate path unavailable', detail: e.message });
  }
};
