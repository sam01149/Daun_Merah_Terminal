// api/calendar.js
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
const CACHE_KEY = 'calendar_v1';
const CACHE_TTL = 6 * 3600; // Redis key TTL — long survival window for stale-serve fallback
const FRESH_TTL = 60;       // normal serve window — frontend polls every 90s; this previously
                             // had NO freshness gate at all (every single request re-fetched
                             // ForexFactory unconditionally, worst offender for stampede risk)
const { withSingleFlight } = require('./_fetch_lock');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Serve Redis cache if still fresh — every open tab polls this every 90s,
  // so without this gate every poll re-hits ForexFactory regardless of age.
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (Date.now() - new Date(obj.fetched_at).getTime() < FRESH_TTL * 1000) {
        res.setHeader('Cache-Control', 'max-age=60');
        return res.status(200).json({ ...obj, stale: false });
      }
    }
  } catch(_) {}

  // Cache stale/missing — single-flight lock so concurrent tabs/users hitting
  // this at the same moment don't all fan out to ForexFactory simultaneously.
  const sf = await withSingleFlight(redisCmd, {
    lockKey: 'lock:calendar',
    cacheKey: CACHE_KEY,
    isFresh: (raw) => {
      try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < FRESH_TTL * 1000; }
      catch(e) { return false; }
    },
  });
  if (!sf.gotLock && sf.fresh) {
    res.setHeader('Cache-Control', 'max-age=60');
    return res.status(200).json({ ...JSON.parse(sf.fresh), stale: false });
  }

  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(12000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(12000) }),
    ]);

    let allEvents = [];
    let anyFetchSucceeded = false;
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        anyFetchSucceeded = true;
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }
    // Only fall back if both fetches completely failed — empty event list is valid (weekend/no high-impact)
    if (!anyFetchSucceeded) throw new Error('Both ForexFactory XML fetches failed');

    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 4; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));

    const seen = new Set();
    const deduped = allEvents
      .filter(e => dateRange.has(e.date) && (e.impact === 'High' || e.impact === 'Medium') && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => {
        const k = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => {
        const ka = a.date + (a.time_wib === 'Tentative' ? '99:99' : a.time_wib || '99:99');
        const kb = b.date + (b.time_wib === 'Tentative' ? '99:99' : b.time_wib || '99:99');
        return ka.localeCompare(kb);
      });

    const payload = { events: deduped, count: deduped.length, fetched_at: new Date().toISOString() };
    try { await redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL); } catch(_) {}
    if (sf.gotLock) sf.release();
    res.setHeader('Cache-Control', 'max-age=300');
    return res.status(200).json({ ...payload, stale: false });
  } catch(e) {
    if (sf.gotLock) sf.release();
    console.error('Calendar error:', e.message);
    // ForexFactory/Cloudflare block or outage — serve last known-good calendar rather than nothing
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).json({ ...JSON.parse(cached), stale: true, stale_reason: e.message });
      }
    } catch(_) {}
    return res.status(500).json({ error: e.message });
  }
};

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function parseFFXML(xml) {
  const events = [];
  const re = /<event>([\s\S]*?)<\/event>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      if (!r) return '';
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();
    };
    const title    = get('title');
    const country  = get('country').toUpperCase();
    const date     = get('date');
    const time     = get('time');
    const impact   = get('impact');
    const forecast = get('forecast');
    const previous = get('previous');
    const actual   = get('actual');
    if (!title || !country) continue;
    const dp = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dp) continue;
    const wib = convertToWIB(time, `${dp[3]}-${dp[1]}-${dp[2]}`);
    events.push({
      date:     wib.date,
      time_wib: wib.time_wib,
      currency: country,
      event:    title,
      impact,
      forecast: forecast || null,
      previous: previous || null,
      actual:   actual   || null,
    });
  }
  return events;
}

// nfs.faireconomy.media XML stores event times in UTC. WIB = UTC+7.
function convertToWIB(timeStr, dateStr) {
  if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') return { time_wib: 'Tentative', date: dateStr };
  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return { time_wib: timeStr, date: dateStr };
  let hour = parseInt(m[1]);
  const min = parseInt(m[2]), ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const wibHour = hour + 7;
  let dateOut = dateStr;
  if (wibHour >= 24) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    dateOut = toDateStr(d);
  }
  return { time_wib: `${String(wibHour % 24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`, date: dateOut };
}
