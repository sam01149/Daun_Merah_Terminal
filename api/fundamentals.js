// api/fundamentals.js
// Fetches ForexFactory actuals directly, caches in Redis for 15 minutes

const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

const INDICATORS = {
  'CPI y/y':           ['cpi y/y'],
  'Core CPI y/y':      ['core cpi y/y'],
  'CPI q/q':           ['cpi q/q'],
  'CPI m/m':           ['cpi m/m'],
  'Unemployment Rate': ['unemployment rate'],
  'Non-Farm Payrolls': ['non-farm payrolls', 'nonfarm payroll'],
  'Employment Change': ['employment change'],
  'GDP q/q':           ['gdp q/q'],
  'GDP m/m':           ['gdp m/m'],
  'Retail Sales m/m':  ['retail sales m/m'],
  'Trade Balance':     ['trade balance'],
  'Manufacturing PMI': ['manufacturing pmi', 'ism manufacturing'],
  'Services PMI':      ['services pmi', 'ism services', 'composite pmi'],
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // Check Redis cache first
  try {
    const cached = await redisCmd('GET', 'fundamental_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - new Date(parsed.fetched_at).getTime() < CACHE_TTL_MS) {
        return res.status(200).json(parsed);
      }
    }
  } catch(e) {}

  // Fetch fresh from ForexFactory
  const [r1, r2] = await Promise.allSettled([
    fetch(FF_THIS_WEEK, { headers:{'User-Agent':'Mozilla/5.0 (compatible; FJFeed/1.0)'}, signal:AbortSignal.timeout(12000) }),
    fetch(FF_NEXT_WEEK, { headers:{'User-Agent':'Mozilla/5.0 (compatible; FJFeed/1.0)'}, signal:AbortSignal.timeout(12000) }),
  ]);

  let events = [];
  for (const r of [r1, r2]) {
    if (r.status === 'fulfilled' && r.value.ok) {
      const xml = await r.value.text();
      events = events.concat(parseFFXML(xml));
    }
  }

  // Build snapshot from events with actual values
  const snapshot = {};
  for (const ev of events) {
    if (!ev.actual || !MAJOR_CURRENCIES.has(ev.currency)) continue;
    const name = ev.event.toLowerCase();
    for (const [indicator, kws] of Object.entries(INDICATORS)) {
      if (kws.some(kw => name.includes(kw))) {
        if (!snapshot[ev.currency]) snapshot[ev.currency] = {};
        const existing = snapshot[ev.currency][indicator];
        if (!existing || ev.date >= existing.date) {
          snapshot[ev.currency][indicator] = {
            actual:   ev.actual,
            previous: ev.previous || null,
            forecast: ev.forecast || null,
            date:     ev.date,
            event:    ev.event,
          };
        }
        break;
      }
    }
  }

  const payload = { snapshot, fetched_at: new Date().toISOString() };

  // Save to Redis cache (best-effort, no TTL needed — we check timestamp ourselves)
  redisCmd('SET', 'fundamental_cache', JSON.stringify(payload)).catch(() => {});

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

function parseFFXML(xml) {
  const events = [], re = /<event>([\s\S]*?)<\/event>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(b); if (!r) return ''; return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); };
    const title = get('title'), country = get('country').toUpperCase(), date = get('date');
    const actual = get('actual'), previous = get('previous'), forecast = get('forecast');
    if (!title || !country) continue;
    const dp = date.match(/(\d{2})-(\d{2})-(\d{4})/); if (!dp) continue;
    events.push({ date:`${dp[3]}-${dp[1]}-${dp[2]}`, currency:country, event:title, actual, previous, forecast });
  }
  return events;
}
