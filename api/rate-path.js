// api/rate-path.js
// Market-implied rate path from Fed Funds futures via CME FedWatch HTML scrape.
// Falls back to FRED FEDFUNDS history + forward guidance heuristic if CME is blocked.
// Redis cache: rate_path, TTL 4 hours (14400s).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const CACHE_KEY = 'rate_path';
const CACHE_TTL = 14400; // 4 hours

// CME FedWatch hidden API — powers the FedWatch tool directly, returns per-meeting probabilities
const CME_FEDWATCH_URL = 'https://www.cmegroup.com/CmeWS/mvc/FedWatch/tool/get/{DATE}?startDate=2024-01-01';
// CME 30-Day Fed Funds Futures (ZQ) settlement — fallback if FedWatch API blocked
const CME_ZQ_URL = 'https://www.cmegroup.com/CmeWS/mvc/Settlements/futures/tradeDate/{DATE}/productCode/ZQ';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

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

// Fetch from CME FedWatch hidden API — returns per-meeting probabilities directly
async function fetchCMEFedWatch() {
  const dateStr = lastBusinessDay().replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'); // YYYY-MM-DD
  const url = CME_FEDWATCH_URL.replace('{DATE}', dateStr);
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

  return { meetings, trade_date: dateStr };
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
    console.warn('rate-path: CME ZQ fetch also failed:', e.message, '— falling back to heuristic');
  }

  // Step 3: heuristic fallback using DFF-based currentRate already fetched above
  const probCut25 = currentRate > 4.0 ? 0.25 : currentRate > 3.0 ? 0.35 : 0.20;
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

  // Try Redis cache first
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const d = JSON.parse(cached);
      // Check if cache is fresh enough
      const age = Date.now() - new Date(d.computed_at).getTime();
      if (age < CACHE_TTL * 1000) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json({ ...d, stale: false });
      }
    }
  } catch(e) {
    console.warn('rate-path cache read failed:', e.message);
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
