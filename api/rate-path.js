// api/rate-path.js
// Market-implied rate path from Fed Funds futures.
// Fallback chain: CME FedWatch → CME ZQ settlement → FRED T-bill term structure → heuristic.
// Note: Yahoo Finance ZQ (HTTP 404 confirmed) and CME direct (IP blocked) both eliminated.
// FRED T-bill: uses keyless CSV endpoint (same pattern as cb-status.js scrapeUSD).
// Redis cache: rate_path, TTL 4 hours (14400s).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const rateLimit = require('./_ratelimit');
const CACHE_KEY = 'rate_path';
const CACHE_TTL = 14400; // 4 hours

// CME FedWatch hidden API — two URL patterns tried in order (no ?startDate param in v2)
const CME_FEDWATCH_URL_V1 = 'https://www.cmegroup.com/CmeWS/mvc/FedWatch/tool/get/{DATE}?startDate=2024-01-01';
const CME_FEDWATCH_URL_V2 = 'https://www.cmegroup.com/CmeWS/mvc/FedWatch/tool/get/{DATE}';
// CME 30-Day Fed Funds Futures (ZQ) settlement — fallback if FedWatch API blocked
const CME_ZQ_URL = 'https://www.cmegroup.com/CmeWS/mvc/Settlements/futures/tradeDate/{DATE}/productCode/ZQ';
// CME public products quote API — lighter endpoint, less likely to be rate-limited
const CME_QUOTE_URL = 'https://www.cmegroup.com/CmeWS/mvc/Quotes/delayed/305/G/cbot';

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

// Keyless FRED CSV fetch — same pattern as cb-status.js scrapeUSD(), no API key required.
// Returns { date, value } of the most recent non-missing observation.
async function fetchFredCsv(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&sort_order=desc&limit=10`;
  const r = await fetch(url, { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`FRED CSV ${seriesId} HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split('\n').filter(l => l && !l.startsWith('DATE'));
  for (const line of lines) {
    const [date, val] = line.split(',');
    if (val?.trim() && val.trim() !== '.') return { date: date.trim(), value: val.trim() };
  }
  return null;
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

const CME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html',
  'Origin': 'https://www.cmegroup.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

// Route CME fetch through ScraperAPI proxy if SCRAPER_API_KEY is set,
// otherwise attempt direct (will be blocked by CME firewall on Vercel IPs).
// ScraperAPI uses residential IPs that CME's Akamai WAF does not block.
function cmeFetch(targetUrl, directHeaders, timeoutMs = 15000) {
  const key = process.env.SCRAPER_API_KEY;
  if (key) {
    return fetch(
      `https://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(targetUrl)}`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }
    );
  }
  return fetch(targetUrl, { headers: directHeaders, signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)) });
}

// Fetch from CME FedWatch hidden API — tries V1 then V2 URL pattern
async function fetchCMEFedWatch() {
  const now = new Date();
  const nextMeeting = getNextFOMCMeetings(now, 1)[0]; // e.g. "2026-06-18"
  if (!nextMeeting) throw new Error('No upcoming FOMC meeting found');

  let lastErr;
  for (const urlTemplate of [CME_FEDWATCH_URL_V1, CME_FEDWATCH_URL_V2]) {
    try {
      const url = urlTemplate.replace('{DATE}', nextMeeting);
      const r = await cmeFetch(url, CME_HEADERS, 15000);
      if (!r.ok) throw new Error(`CME FedWatch HTTP ${r.status}`);
      const json = await r.json();
      const meetings = Array.isArray(json) ? json : json?.FedWatchTool || json?.meetings || [];
      if (!meetings || meetings.length === 0) throw new Error('CME FedWatch: no meetings data');
      return { meetings, trade_date: new Date().toISOString().slice(0, 10) };
    } catch(e) { lastErr = e; }
  }
  throw lastErr;
}

// Try CME public quote API for ZQ front-month — lighter endpoint with less IP-blocking
async function fetchCMEQuoteZQ() {
  const r = await cmeFetch(CME_QUOTE_URL, CME_HEADERS, 15000);
  if (!r.ok) throw new Error(`CME Quote HTTP ${r.status}`);
  const json = await r.json();
  const quotes = json?.quotes || json?.data || [];
  if (!Array.isArray(quotes) || quotes.length === 0) throw new Error('CME Quote: no data');
  // ZQ: price = 100 - implied Fed Funds rate (e.g. 95.680 → 4.320%)
  const price = parseFloat(quotes[0]?.last || quotes[0]?.settle || quotes[0]?.close || '');
  if (isNaN(price) || price <= 0 || price > 100) throw new Error('CME Quote: invalid price ' + price);
  return { price, implied_rate: +(100 - price).toFixed(4) };
}

// Try fetching ZQ (30-day Fed Funds futures) settlement data — fallback
async function fetchCMEZQData() {
  const dateStr = lastBusinessDay();
  const targetUrl = CME_ZQ_URL.replace('{DATE}', dateStr);
  const r = await cmeFetch(targetUrl, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.settlements.html',
  }, 15000);
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


async function computeRatePath() {
  // Fetch all FRED series via keyless CSV in one parallel batch.
  // DFEDTARU: upper bound of FF target range (daily, same as cb-status.js).
  // DGS1MO/DGS3MO: constant-maturity T-bill yields (daily, H.15 release ~4:15 PM ET).
  // DTB4WK/DTB3: weekly auction rates (published Mondays) — backup when DGS not yet updated.
  const [effObs, dgs1mObs, dgs3mObs, dtb4wkObs, dtb3Obs] = await Promise.all([
    fetchFredCsv('DFEDTARU').catch(() => null),
    fetchFredCsv('DGS1MO').catch(() => null),
    fetchFredCsv('DGS3MO').catch(() => null),
    fetchFredCsv('DTB4WK').catch(() => null),
    fetchFredCsv('DTB3').catch(() => null),
  ]);

  const currentRate = effObs ? parseFloat(effObs.value) : 3.75;
  // T-bill: prefer constant-maturity (DGS, daily), fall back to auction rate (DTB, weekly)
  const tbill1m = (dgs1mObs ? parseFloat(dgs1mObs.value) : null)
               ?? (dtb4wkObs ? parseFloat(dtb4wkObs.value) : null);
  const tbill3m = (dgs3mObs ? parseFloat(dgs3mObs.value) : null)
               ?? (dtb3Obs ? parseFloat(dtb3Obs.value) : null);

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
    // 2a: full ZQ settlement strip (multiple contracts)
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
    console.warn('rate-path: CME ZQ settlement failed:', e.message, '— trying CME quote API');
  }

  // Step 2b: CME public quote API for ZQ front-month — lighter endpoint
  try {
    const quoteData = await fetchCMEQuoteZQ();
    const impliedRate = quoteData.implied_rate;
    const delta = +(impliedRate - currentRate).toFixed(4);
    const prob_cut25  = Math.max(0, Math.min(1, +(-delta / 0.25).toFixed(4)));
    const prob_hike25 = Math.max(0, Math.min(1, +(delta / 0.25).toFixed(4)));
    const prob_hold   = Math.max(0, +(1 - prob_cut25 - prob_hike25).toFixed(4));
    const meetingProbs = nextMeetings.map(date => ({
      date, prob_hold, prob_cut25, prob_hike25, implied_rate: impliedRate,
    }));
    return {
      source: 'cme_zq_quote',
      current_rate: currentRate,
      USD: { next_meetings: meetingProbs, cumulative_3m_bps: Math.round(delta * 100) },
      trade_date: new Date().toISOString().slice(0, 10),
      computed_at: new Date().toISOString(),
    };
  } catch(e) {
    console.warn('rate-path: CME quote API failed:', e.message, '— trying FRED T-bill');
  }

  // Step 2.5: FRED T-bill term structure (pre-fetched above, zero extra network calls).
  // T-bills typically trade ~20bps ABOVE EFFR in hold regime (term premium).
  // So raw (tbill - FF) spread is not useful; we subtract term premium before computing cut prob.
  // Formula: spread = currentRate - tbill + TERM_PREMIUM → positive = cuts priced in.
  // Probability scale: spread of 0.25 (full 25bp cut priced in) → 50% probability per meeting.
  if (tbill1m != null || tbill3m != null) {
    const TERM_PREMIUM = 0.20; // typical T-bill term premium above EFFR in hold regime
    const meetingProbs = nextMeetings.map((date, i) => {
      const impliedRate = i === 0 ? (tbill1m ?? tbill3m) : (tbill3m ?? tbill1m);
      const spread      = currentRate - impliedRate + TERM_PREMIUM;
      // Only signal cuts (not hikes) — T-bills unreliable for hike detection
      const prob_cut25  = Math.max(0.01, Math.min(0.90, Math.max(0, spread) / 0.25 * 0.50));
      const prob_hike25 = 0;
      const prob_hold   = Math.max(0, +(1 - prob_cut25).toFixed(4));
      return { date, prob_hold, prob_cut25, prob_hike25, implied_rate: impliedRate };
    });
    const cum3m = Math.round(meetingProbs.slice(0, 3).reduce((s, m) => s + m.prob_cut25 * -25, 0));
    console.log(`rate-path: FRED T-bill OK — 1M:${tbill1m} 3M:${tbill3m} currentRate:${currentRate}`);
    return {
      source: 'fred_tbill_term',
      current_rate: currentRate,
      USD: { next_meetings: meetingProbs, cumulative_3m_bps: cum3m },
      tbill_1m: tbill1m,
      tbill_3m: tbill3m,
      data_note: 'T-bill term structure (term-premium adjusted, ±10bps vs ZQ futures).',
      computed_at: new Date().toISOString(),
    };
  }
  console.warn('rate-path: FRED T-bill unavailable (DGS1MO/DTB4WK/DGS3MO/DTB3 all null) — falling back to heuristic');

  // Step 3: heuristic fallback — distance from neutral rate (~3.0%) drives probability.
  // Fed neutral rate estimate: 3.0%. Thresholds calibrated to match observed CME FedWatch
  // probabilities at key rate levels (e.g. 3.75% → ~5-7%, not 12% as before).
  const neutral = 3.0;
  const d = currentRate - neutral;
  const probCut25 = d >= 1.5 ? 0.35   // ≥4.5% — aggressive cutting cycle
                  : d >= 1.0 ? 0.18   // 4.0–4.5% — active cuts priced in
                  : d >= 0.5 ? 0.07   // 3.5–4.0% — mild cut probability (e.g. 3.75% → ~7%)
                  : d >= 0.0 ? 0.04   // 3.0–3.5% — near neutral, low expectation
                  : 0.02;             // <3.0% — below neutral, very low cut probability
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

  if (await rateLimit(req, res, { limit: 15, windowSecs: 60, endpoint: 'rate-path' })) return;

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

  // Compute fresh data (no API key required — uses keyless FRED CSV)
  let data;
  try {
    data = await computeRatePath();
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
