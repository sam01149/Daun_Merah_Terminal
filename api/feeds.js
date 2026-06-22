// api/feeds.js — consolidated feeds endpoint
// GET /api/feeds?type=rss            → FinancialJuice RSS XML (50s cache)
// GET /api/feeds?type=cot            → CFTC COT JSON (6h cache)
// GET /api/feeds?type=research       → CB speeches/publications + macro research JSON (6h cache)
// GET /api/feeds?type=options        → Investinglive FX option expiries JSON (4h cache)
// GET /api/feeds?type=aftek&pair=EUR/USD → ActionForex per-pair technical outlook (4h cache)
// GET /api/feeds?type=retail         → ForexBenchmark retail positioning JSON (2h cache)

const { autoUpdateFundamentals } = require('./_fundamental_parser');

module.exports = async function handler(req, res) {
  const type = req.query.type;
  if (type === 'rss')         return rssHandler(req, res);
  if (type === 'cot')         return cotHandler(req, res);
  if (type === 'cot_history') return cotHistoryHandler(req, res);
  if (type === 'research')    return researchHandler(req, res);
  if (type === 'options')     return optionsHandler(req, res);
  if (type === 'aftek')       return aftekHandler(req, res);
  if (type === 'retail')      return retailHandler(req, res);
  return res.status(400).json({ error: 'Missing ?type= — use rss, cot, cot_history, research, options, aftek, or retail' });
};

// ── Shared Redis helper ────────────────────────────────────────────────────────

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

// ── RSS handler (was api/rss.js) ──────────────────────────────────────────────

// No module-level in-memory cache — cold-start safe, Redis is the only cache layer
const RSS_CACHE_TTL_MS = 50 * 1000;
const RSS_CACHE_KEY    = 'rss_cache';
const RSS_URL          = 'https://www.financialjuice.com/feed.ashx?xy=rss';
// Fallback when FinancialJuice is down/blocked — standard WordPress RSS, same
// macro/forex news genre, guid/title/pubDate/link/description shape already
// compatible with parseRSSItems() / frontend parseRSS().
const RSS_FALLBACK_URL = 'https://investinglive.com/feed/news/';
const RSS_USER_AGENTS  = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  'NewsBlur Feed Fetcher - 1000000 subscribers',
];

async function rssHandler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();

  try {
    const cached = await redisCmd('GET', RSS_CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (now - obj.fetchedAt < RSS_CACHE_TTL_MS) {
        res.setHeader('X-Cache-Source', 'REDIS');
        return res.status(200).send(obj.xml);
      }
    }
  } catch(e) {
    console.warn('RSS Redis GET failed:', e.message);
  }

  const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
  let xml = null, fetchError = null, sourceUsed = 'financialjuice';

  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*', 'Referer': 'https://www.financialjuice.com/', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) { const t = await r.text(); if (t.includes('<rss')) xml = t; else fetchError = 'NOT_RSS'; }
    else fetchError = 'HTTP_' + r.status;
  } catch(e) { fetchError = e.message; }

  // Primary source down/blocked — try fallback source before resorting to stale cache
  if (!xml) {
    console.warn('FinancialJuice RSS failed:', fetchError, '— trying fallback (Investinglive)');
    try {
      const r2 = await fetch(RSS_FALLBACK_URL, {
        headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*' },
        signal: AbortSignal.timeout(12000),
      });
      if (r2.ok) {
        const t2 = await r2.text();
        if (t2.includes('<rss') && t2.includes('<item>')) { xml = t2; sourceUsed = 'investinglive_fallback'; }
      }
    } catch(e2) {
      console.warn('Fallback RSS (Investinglive) also failed:', e2.message);
    }
  }

  if (!xml) {
    try {
      const stale = await redisCmd('GET', RSS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        res.setHeader('X-Cache-Source', 'STALE');
        return res.status(200).send(obj.xml);
      }
    } catch(e2) {}
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Upstream fetch failed (primary + fallback)', detail: fetchError });
  }

  const payload = JSON.stringify({ xml, fetchedAt: now, source: sourceUsed });
  try { await redisCmd('SET', RSS_CACHE_KEY, payload, 'EX', 60); } catch(e3) {
    console.warn('RSS Redis SET failed:', e3.message);
  }

  // Fire-and-forget: persist items to 36h rolling history for market-digest
  storeNewsHistory(xml, now).catch(() => {});

  res.setHeader('X-Cache-Source', sourceUsed === 'financialjuice' ? 'UPSTREAM' : 'FALLBACK');
  res.setHeader('X-News-Source', sourceUsed);
  return res.status(200).send(xml);
}

async function storeNewsHistory(xml, now) {
  // Throttle: max once per 5 minutes to keep Upstash command usage low
  const lock = await redisCmd('SET', 'news_history_lock', '1', 'EX', 300, 'NX');
  if (!lock) return;

  const items = parseRSSItems(xml);
  if (items.length === 0) return;
  const cutoff = now - 36 * 60 * 60 * 1000;
  const args = ['ZADD', 'news_history', 'NX'];
  for (const item of items) {
    const ts = new Date(item.pubDate).getTime();
    if (!isNaN(ts) && ts > cutoff) args.push(ts, JSON.stringify(item));
  }
  if (args.length > 3) await redisCmd(...args);
  await redisCmd('ZREMRANGEBYSCORE', 'news_history', '-inf', cutoff);

  // Update fundamental data from latest headlines (fire-and-forget)
  autoUpdateFundamentals(items.slice(0, 50), redisCmd).catch(() => {});
}

function parseRSSItems(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title = get('title').replace(/^FinancialJuice:\s*/i,'').trim();
    const guid = get('guid'), pubDate = get('pubDate');
    const link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

// ── COT handler (was api/cot.js) ──────────────────────────────────────────────

const CFTC_URL      = 'https://www.cftc.gov/dea/options/financial_lof.htm';
const COT_CACHE_TTL = 6 * 60 * 60 * 1000;

const MARKET_MARKERS = {
  USD: ['u.s. dollar index', 'dollar index'],
  EUR: ['euro fx'],
  GBP: ['british pound'],
  JPY: ['japanese yen'],
  CAD: ['canadian dollar'],
  AUD: ['australian dollar'],
  NZD: ['new zealand dollar', 'nz dollar'],
  CHF: ['swiss franc'],
};

async function cotHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const cached = await redisCmd('GET', 'cot_cache_v2');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - new Date(parsed.fetched_at).getTime() < COT_CACHE_TTL) {
        return res.status(200).json(parsed);
      }
    }
  } catch(e) {}

  let preText = '';
  try {
    const r = await fetch(CFTC_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!preMatch) throw new Error('No <pre> block in CFTC response');
    preText = preMatch[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  } catch(e) {
    console.error('CFTC fetch failed:', e.message);
    try {
      const stale = await redisCmd('GET', 'cot_cache_v2');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
    } catch(e2) {}
    return res.status(502).json({ error: 'CFTC unavailable: ' + e.message });
  }

  const dateMatch = preText.match(/Positions as of\s+([A-Za-z]+ \d+,?\s*\d{4})/i);
  const reportDate = dateMatch ? dateMatch[1].trim() : null;

  const positions = {};
  const textLower = preText.toLowerCase();

  for (const [currency, markers] of Object.entries(MARKET_MARKERS)) {
    let blockStart = -1;
    for (const marker of markers) {
      const idx = textLower.indexOf(marker);
      if (idx !== -1) { blockStart = idx; break; }
    }
    if (blockStart === -1) continue;

    const firstCode = textLower.indexOf('cftc code #', blockStart);
    if (firstCode === -1) continue;
    const nextCode  = textLower.indexOf('cftc code #', firstCode + 50);
    const block = preText.slice(blockStart, nextCode !== -1 ? nextCode - 50 : blockStart + 3000);
    const lines = block.split('\n');

    let posIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*Positions\s*$/i.test(lines[i])) { posIdx = i; break; }
    }

    let dataLine = '';
    if (posIdx !== -1) {
      for (let i = posIdx + 1; i < Math.min(posIdx + 4, lines.length); i++) {
        if (/[\d,]{3,}/.test(lines[i])) { dataLine = lines[i]; break; }
      }
    }
    if (!dataLine) {
      for (const line of lines) {
        const n = line.trim().split(/\s+/).filter(s => /^-?[\d,]+$/.test(s));
        if (n.length >= 10) { dataLine = line; break; }
      }
    }
    if (!dataLine) continue;

    const nums = dataLine.trim().split(/\s+/)
      .map(s => parseInt(s.replace(/,/g, '')))
      .filter(n => !isNaN(n));
    if (nums.length < 8) continue;

    const amLong   = nums[3];
    const amShort  = nums[4];
    const amNet    = amLong - amShort;
    const levLong  = nums[6];
    const levShort = nums[7];
    const levNet   = levLong - levShort;

    let levChangeNet = null;
    let amChangeNet  = null;
    for (let i = 0; i < lines.length; i++) {
      if (/Changes from/i.test(lines[i])) {
        let changeLine = '';
        if (i + 1 < lines.length && /[\d,]/.test(lines[i + 1])) changeLine = lines[i + 1];
        if (changeLine) {
          const cn = changeLine.trim().split(/\s+/)
            .map(s => parseInt(s.replace(/,/g, '')))
            .filter(n => !isNaN(n));
          if (cn.length >= 8) { amChangeNet = cn[3] - cn[4]; levChangeNet = cn[6] - cn[7]; }
        }
        break;
      }
    }

    positions[currency] = {
      am_long: amLong, am_short: amShort, am_net: amNet, am_change_net: amChangeNet,
      lev_long: levLong, lev_short: levShort, lev_net: levNet, lev_change_net: levChangeNet,
    };
  }

  let releaseDate = null;
  if (reportDate) {
    const d = new Date(reportDate);
    if (!isNaN(d)) {
      const fri = new Date(d.getTime() + 3 * 24 * 3600 * 1000);
      releaseDate = fri.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
  }

  const parsedCount = Object.keys(positions).length;

  if (parsedCount < 5) {
    console.warn(`COT parser: only ${parsedCount} currencies parsed — expected 8. Possible format change. Falling back to stale cache.`);
    try {
      const stale = await redisCmd('GET', 'cot_cache_v2');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true, parse_warning: `Only ${parsedCount}/8 currencies parsed from fresh fetch` });
    } catch(e2) {}
    return res.status(500).json({ error: `COT parser degraded: only ${parsedCount}/8 currencies parsed`, positions });
  }

  const payload = {
    positions,
    report_date: reportDate,
    release_date: releaseDate,
    fetched_at: new Date().toISOString(),
  };

  redisCmd('SET', 'cot_cache_v2', JSON.stringify(payload), 'EX', 21600).catch(() => {});

  // Fire-and-forget: accumulate weekly snapshots for future trend display
  storeCOTHistory(positions, reportDate).catch(() => {});

  return res.status(200).json(payload);
}

async function storeCOTHistory(positions, reportDate) {
  if (!reportDate) return;
  // Lock key per reportDate week — prevents duplicate storage of the same weekly report
  const dateKey = reportDate.replace(/\W/g, '');
  const lock = await redisCmd('SET', `cot_hist_lock:${dateKey}`, '1', 'EX', 604800, 'NX'); // 7-day TTL
  if (!lock) return;

  const ts    = Date.now();
  const entry = JSON.stringify({ positions, report_date: reportDate, stored_at: new Date().toISOString() });
  await redisCmd('ZADD', 'cot_history', 'NX', ts, entry);

  // Keep 90-day rolling window
  const cutoff = ts - 90 * 24 * 60 * 60 * 1000;
  await redisCmd('ZREMRANGEBYSCORE', 'cot_history', '-inf', cutoff);
}

// ── COT History handler ───────────────────────────────────────────────────────
// GET /api/feeds?type=cot_history&n=12
// Returns last N weekly COT snapshots from Redis sorted set `cot_history`

const COT_HISTORY_CACHE_KEY = 'cot_history_cache';
const COT_HISTORY_CACHE_TTL = 3600; // 1h — data is weekly, no need to refresh often

async function cotHistoryHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const n = Math.min(parseInt(req.query.n || '12', 10), 52);

  try {
    const cached = await redisCmd('GET', COT_HISTORY_CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (Date.now() - obj.fetched_at < COT_HISTORY_CACHE_TTL * 1000) {
        const sliced = obj.history.slice(-n);
        return res.status(200).json({ history: sliced, count: sliced.length, source: 'cache' });
      }
    }
  } catch(e) {
    console.warn('cot_history cache GET failed:', e.message);
  }

  try {
    const raw = await redisCmd('ZRANGE', 'cot_history', '0', '-1', 'WITHSCORES');
    if (!raw || raw.length === 0) {
      return res.status(200).json({ history: [], count: 0, message: 'Belum ada data history COT' });
    }

    // raw = [json1, score1, json2, score2, ...]
    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) {
      try {
        const entry = JSON.parse(raw[i]);
        const ts    = parseFloat(raw[i + 1]);
        pairs.push({ ...entry, ts });
      } catch(e2) { /* skip malformed */ }
    }

    // Sort descending by score (timestamp), slice n, then reverse to ascending for chart
    pairs.sort((a, b) => b.ts - a.ts);
    const sliced = pairs.slice(0, n).reverse();

    const payload = { history: sliced, fetched_at: Date.now() };
    redisCmd('SET', COT_HISTORY_CACHE_KEY, JSON.stringify(payload), 'EX', COT_HISTORY_CACHE_TTL).catch(() => {});

    return res.status(200).json({ history: sliced, count: sliced.length });
  } catch(e) {
    console.error('cot_history fetch failed:', e.message);
    return res.status(502).json({ error: 'cot_history fetch failed: ' + e.message });
  }
}

// ── CB Research handler ───────────────────────────────────────────────────────

// Direct sources — verified accessible from Vercel serverless IPs
// rss2json proxy — bypass WAF blocking on Vercel IPs (BIS blocks Vercel but allows rss2json)
const CB_RESEARCH_SOURCES = [
  // ── Central Bank Primary Sources ──────────────────────────────────────────
  { key: 'FED',  url: 'https://www.federalreserve.gov/feeds/speeches.xml' },
  { key: 'FOMC', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
  { key: 'FEDN', url: 'https://www.federalreserve.gov/feeds/feds_notes.xml' },
  { key: 'ECB',  url: 'https://www.ecb.europa.eu/rss/press.html' },
  { key: 'ECBB', url: 'https://www.ecb.europa.eu/rss/blog.html' },
  { key: 'BIS',  url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.bis.org%2Fdoclist%2Fcbspeeches.rss' },
  // RBA via rss2json (direct Vercel IP often gets 403 from RBA)
  { key: 'RBA',  url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.rba.gov.au%2Frss%2Frss-cb-speeches.xml' },
  // BoC direct feed — accessible from Vercel IPs
  { key: 'BOC',  url: 'https://www.bankofcanada.ca/feed/speeches/' },
  // BoJ via rss2json (BoJ blocks non-browser UAs on Vercel)
  { key: 'BOJ',  url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.boj.or.jp%2Fen%2Frss%2Fmediarss.xml' },
  // ── Macro Research / Institutional Analysis ───────────────────────────────
  // Marc to Market uses FeedBurner (Blogger backend) — direct fetch works fine
  { key: 'MTM',  url: 'https://feeds.feedburner.com/marctomarket/ujfs' },
  // ING Think has native RSS at /rss/ — direct accessible from Vercel IPs
  { key: 'ING',  url: 'https://think.ing.com/rss/' },
];
const RESEARCH_CACHE_KEY    = 'research_cache';
const RESEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function researchHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const forceRefresh = req.query.force === '1';

  if (!forceRefresh) {
    try {
      const cached = await redisCmd('GET', RESEARCH_CACHE_KEY);
      if (cached) {
        const obj = JSON.parse(cached);
        if (Date.now() - new Date(obj.fetched_at).getTime() < RESEARCH_CACHE_TTL_MS) {
          return res.json(obj);
        }
      }
    } catch(e) {}
  }

  const results = await Promise.allSettled(CB_RESEARCH_SOURCES.map(fetchCBFeed));

  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items = items.concat(r.value);
  }
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  items = items.slice(0, 50);

  if (items.length === 0) {
    try {
      const stale = await redisCmd('GET', RESEARCH_CACHE_KEY);
      if (stale) return res.json({ ...JSON.parse(stale), stale: true });
    } catch(e) {}
    return res.status(502).json({ error: 'All CB research feeds failed' });
  }

  const payload = { items, fetched_at: new Date().toISOString() };
  redisCmd('SET', RESEARCH_CACHE_KEY, JSON.stringify(payload), 'EX', 21600).catch(() => {});
  return res.json(payload);
}

const RESEARCH_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

async function fetchCBFeed(source) {
  try {
    const ua = RESEARCH_UAS[Math.floor(Math.random() * RESEARCH_UAS.length)];
    const r = await fetch(source.url, {
      headers: { 
        'User-Agent': ua, 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    
    const text = await r.text();
    
    // Handler khusus untuk bypass via rss2json (mengembalikan JSON, bukan XML)
    if (source.url.includes('rss2json.com')) {
      const json = JSON.parse(text);
      if (json.status !== 'ok') throw new Error('rss2json error');
      return (json.items || []).map(it => ({
        title: it.title,
        pubDate: it.pubDate,
        link: it.link || '',
        source: source.key
      })).slice(0, 20);
    }

    return parseCBRSSItems(text, source.key);
  } catch(e) {
    console.warn(`CB research fetch failed [${source.key}]:`, e.message);
    return [];
  }
}

// Atom feeds (e.g. Blogger/FeedBurner like MTM) emit multiple <link> tags —
// rel="edit"/"self" point at the raw feed entry, only rel="alternate" is the
// readable article page. Picking the first <link> blindly grabs the wrong one.
function pickAtomLink(b) {
  const tags = b.match(/<link\b[^>]*\/?>/gi) || [];
  let anyHref = null;
  for (const tag of tags) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (!anyHref) anyHref = href;
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1];
    if (rel === 'alternate') return href;
  }
  return anyHref;
}

function parseCBRSSItems(xml, sourceKey) {
  const items = [];

  // Support both RSS 2.0 (<item>) and Atom 1.0 (<entry>) — e.g. FeedBurner returns Atom
  const blockRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => {
      const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
      const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
      return (r1 || r2)?.[1]?.trim() || '';
    };
    const title = get('title');

    // pubDate (RSS 2.0) → dc:date (Dublin Core, e.g. ING Think) → published/updated (Atom)
    const pubDate = get('pubDate')
      || b.match(/<dc:date[^>]*>([^<]+)<\/dc:date>/i)?.[1]?.trim()
      || get('published')
      || get('updated')
      || '';

    // RSS 2.0: <link>url</link> | Atom: <link rel="alternate" href="url" .../> | fallback get('link')
    const link = b.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/)?.[1]
      || pickAtomLink(b)
      || get('link')
      || '';

    if (title && pubDate) items.push({ title, pubDate, link, source: sourceKey });
  }
  return items.slice(0, 20);
}

// ── FX Option Expiries handler (Forexlive) ────────────────────────────────────
// GET /api/feeds?type=options[&pair=EURUSD]
// Scrapes Forexlive daily FX option expiries page and parses per-pair data

const OPTIONS_CACHE_KEY    = 'fx_options_cache';
const OPTIONS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4h — data published once daily

// Known forex pair aliases for matching Forexlive text
const PAIR_ALIASES = {
  'EURUSD': ['eur/usd', 'eurusd', 'eur usd'],
  'GBPUSD': ['gbp/usd', 'gbpusd', 'gbp usd'],
  'USDJPY': ['usd/jpy', 'usdjpy', 'usd jpy'],
  'USDCAD': ['usd/cad', 'usdcad', 'usd cad'],
  'AUDUSD': ['aud/usd', 'audusd', 'aud usd'],
  'NZDUSD': ['nzd/usd', 'nzdusd', 'nzd usd'],
  'USDCHF': ['usd/chf', 'usdchf', 'usd chf'],
  'EURGBP': ['eur/gbp', 'eurgbp', 'eur gbp'],
  'EURJPY': ['eur/jpy', 'eurjpy', 'eur jpy'],
  'GBPJPY': ['gbp/jpy', 'gbpjpy', 'gbp jpy'],
  'XAUUSD': ['xau/usd', 'xauusd', 'gold', 'xau usd'],
};

async function optionsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const pairFilter   = (req.query.pair || '').toUpperCase().replace('/', '') || null;
  const forceRefresh = req.query.force === '1';

  // Try cache first (skip on force=1)
  if (!forceRefresh) {
    try {
      const cached = await redisCmd('GET', OPTIONS_CACHE_KEY);
      if (cached) {
        const obj = JSON.parse(cached);
        if (Date.now() - new Date(obj.fetched_at).getTime() < OPTIONS_CACHE_TTL_MS) {
          const out = pairFilter ? filterByPair(obj.expiries, pairFilter) : obj.expiries;
          return res.json({ expiries: out, fetched_at: obj.fetched_at, date: obj.date, source: 'cache' });
        }
      }
    } catch(e) {}
  }

  // Forexlive moved to investinglive.com — dedicated forexorders feed
  const FL_RSS_URL = 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Finvestinglive.com%2Ffeed%2Fforexorders%2F';

  let rawText = '';
  let postDate = '';
  let postLink = '';

  try {
    const r = await fetch(FL_RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('rss2json HTTP ' + r.status);
    const json = await r.json();
    if (json.status !== 'ok' || !json.items?.length) throw new Error('rss2json returned no items');

    // Dedicated forexorders feed — take the most recent option expiry post
    const expiryPost = json.items.find(it => /option.expir/i.test(it.title));
    if (!expiryPost) throw new Error('No option expiry post found in feed');

    rawText  = expiryPost.content || expiryPost.description || '';
    postDate = expiryPost.pubDate || '';
    postLink = expiryPost.link || '';
  } catch(e) {
    console.warn('InvestingLive options fetch failed:', e.message);
    // Return stale if available
    try {
      const stale = await redisCmd('GET', OPTIONS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        const out = pairFilter ? filterByPair(obj.expiries, pairFilter) : obj.expiries;
        return res.json({ expiries: out, fetched_at: obj.fetched_at, date: obj.date, stale: true });
      }
    } catch(e2) {}
    return res.status(502).json({ error: 'Forexlive option expiries unavailable: ' + e.message });
  }

  const expiries = parseOptionExpiries(rawText, postLink);
  const payload  = { expiries, fetched_at: new Date().toISOString(), date: postDate };
  redisCmd('SET', OPTIONS_CACHE_KEY, JSON.stringify(payload), 'EX', 14400).catch(() => {});

  const out = pairFilter ? filterByPair(expiries, pairFilter) : expiries;
  return res.json({ expiries: out, fetched_at: payload.fetched_at, date: postDate });
}

function filterByPair(expiries, pair) {
  const aliases = PAIR_ALIASES[pair] || [pair.toLowerCase().replace(/(.{3})(.{3})/, '$1/$2')];
  return expiries.filter(e => aliases.some(a => e.pair.toLowerCase() === a));
}

function parseOptionExpiries(html, sourceLink) {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ');

  // Try structured table parser first (old format: pair header + level/size rows)
  const structured = parseStructuredExpiries(text, sourceLink);
  if (structured.length > 0) return structured;

  // Fallback: prose parser — Investinglive switched to narrative format (levels in text, no sizes)
  return parseProseExpiries(text, sourceLink);
}

function parseStructuredExpiries(text, sourceLink) {
  const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  let currentPair = null;

  for (const line of lines) {
    const pairMatch = line.match(/^([A-Z]{3}\/[A-Z]{3}|[A-Z]{6})\s*[:\-–]?\s*$/i)
                   || line.match(/^([A-Z]{3}[\/\s][A-Z]{3})\s*$/i);
    if (pairMatch) {
      currentPair = pairMatch[1].toUpperCase().replace(/\s/g, '/');
      if (currentPair.length === 6) currentPair = currentPair.slice(0,3) + '/' + currentPair.slice(3);
      continue;
    }

    const inlineMatch = line.match(/^([A-Z]{3}[\/\s][A-Z]{3})\s*[:\-–]\s*(.+)/i);
    if (inlineMatch) {
      currentPair = inlineMatch[1].toUpperCase().replace(/\s/g, '/');
      if (currentPair.length === 6) currentPair = currentPair.slice(0,3) + '/' + currentPair.slice(3);
      parseExpiryEntries(inlineMatch[2], currentPair, results, sourceLink);
      continue;
    }

    if (currentPair) {
      parseExpiryEntries(line, currentPair, results, sourceLink);
    }
  }

  return results;
}

function parseExpiryEntries(text, pair, results, sourceLink) {
  const entryRe = /([\d]{1,4}\.[\d]{1,5}(?:\s*-\s*[\d]{1,5})?)\s*[\(\[]?([€$¥£]?[\d.]+\s*(?:b(?:ln)?|m(?:ln)?|billion|million)?)\s*[\)\]]?/gi;
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const level = m[1].replace(/\s/g, '');
    const size  = m[2].trim();
    if (level && size) results.push({ pair, level, size, link: sourceLink });
  }
}

// Prose parser: Investinglive now writes narrative format — extract pair + levels from sentences.
// Example: "EUR/USD at the 1.1540 and 1.1600 levels"
// Size not available in this format; size is returned as empty string.
function parseProseExpiries(text, sourceLink) {
  const results = [];
  const seen    = new Set();
  const lines   = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);

  const PAIR_ALIAS = [
    ['EUR/USD', /eur\/?usd/i],
    ['GBP/USD', /gbp\/?usd/i],
    ['USD/JPY', /usd\/?jpy/i],
    ['USD/CAD', /usd\/?cad/i],
    ['AUD/USD', /aud\/?usd/i],
    ['NZD/USD', /nzd\/?usd/i],
    ['USD/CHF', /usd\/?chf/i],
    ['EUR/GBP', /eur\/?gbp/i],
    ['EUR/JPY', /eur\/?jpy/i],
    ['GBP/JPY', /gbp\/?jpy/i],
    ['XAU/USD', /(?:xau\/?usd|gold)/i],
  ];

  for (const line of lines) {
    let pair = null;
    for (const [p, re] of PAIR_ALIAS) {
      if (re.test(line)) { pair = p; break; }
    }
    if (!pair) continue;

    const levelRe = /\b(\d{1,4}\.\d{2,5})\b/g;
    let m;
    while ((m = levelRe.exec(line)) !== null) {
      const level = m[1];
      const val   = parseFloat(level);
      if (isNaN(val) || val < 0.3 || val > 5000) continue;
      const key = pair + ':' + level;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ pair, level, size: '', link: sourceLink });
    }
  }

  return results;
}

// ── ActionForex per-pair technical outlook handler ─────────────────────────────
// GET /api/feeds?type=aftek&pair=EURUSD
// Returns last 5 technical analysis articles for the requested pair

const AFTEK_FEEDS = {
  EURUSD: 'https://www.actionforex.com/category/technical-outlook/eurusd-outlook/feed/',
  GBPUSD: 'https://www.actionforex.com/category/technical-outlook/gbpusd-outlook/feed/',
  USDJPY: 'https://www.actionforex.com/category/technical-outlook/usdjpy-outlook/feed/',
  USDCAD: 'https://www.actionforex.com/category/technical-outlook/usdcad-outlook/feed/',
  USDCHF: 'https://www.actionforex.com/category/technical-outlook/usdchf-outlook/feed/',
  AUDUSD: 'https://www.actionforex.com/category/technical-outlook/audusd-outlook/feed/',
  // NZDUSD and XAUUSD not available on ActionForex
};
const AFTEK_CACHE_TTL = 4 * 60 * 60; // 4h in seconds

async function aftekHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const pair = (req.query.pair || '').toUpperCase().replace('/', '');
  const feedUrl = AFTEK_FEEDS[pair];

  if (!feedUrl) {
    // Pair not covered by ActionForex — return empty gracefully
    return res.json({ items: [], pair, covered: false });
  }

  const cacheKey = `aftek_cache:${pair}`;

  try {
    const cached = await redisCmd('GET', cacheKey);
    if (cached) {
      const obj = JSON.parse(cached);
      if (Date.now() - new Date(obj.fetched_at).getTime() < AFTEK_CACHE_TTL * 1000) {
        return res.json(obj);
      }
    }
  } catch(e) {}

  try {
    const ua = RESEARCH_UAS[Math.floor(Math.random() * RESEARCH_UAS.length)];
    const r = await fetch(feedUrl, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const items = parseCBRSSItems(xml, 'AF').slice(0, 5);

    const payload = { items, pair, covered: true, fetched_at: new Date().toISOString() };
    redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', AFTEK_CACHE_TTL).catch(() => {});
    return res.json(payload);
  } catch(e) {
    console.warn(`aftek fetch failed [${pair}]:`, e.message);
    // Try stale
    try {
      const stale = await redisCmd('GET', cacheKey);
      if (stale) return res.json({ ...JSON.parse(stale), stale: true });
    } catch(e2) {}
    return res.json({ items: [], pair, covered: true, error: e.message });
  }
}

// ── Retail Sentiment handler (ForexBenchmark) ─────────────────────────────────
// GET /api/feeds?type=retail
// Scrapes forexbenchmark.com/quant/retail_positions/ — no login required
// Returns { positions: { EURUSD: { long_pct, short_pct, signal }, ... }, fetched_at }

const RETAIL_URL       = 'https://forexbenchmark.com/quant/retail_positions/';
const RETAIL_CACHE_KEY = 'retail_sentiment_cache';
const RETAIL_CACHE_TTL = 2 * 60 * 60; // 2h in seconds

// Pairs we care about — must match COT pairs for overlay comparison
const RETAIL_PAIRS = ['EURUSD','GBPUSD','USDJPY','USDCAD','AUDUSD','NZDUSD','USDCHF','XAUUSD'];

async function retailHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const forceRefresh = req.query.force === '1';

  if (!forceRefresh) {
    try {
      const cached = await redisCmd('GET', RETAIL_CACHE_KEY);
      if (cached) {
        const obj = JSON.parse(cached);
        if (Date.now() - new Date(obj.fetched_at).getTime() < RETAIL_CACHE_TTL * 1000) {
          return res.json(obj);
        }
      }
    } catch(e) {}
  }

  let html = '';
  try {
    const r = await fetch(RETAIL_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://forexbenchmark.com/',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    html = await r.text();
  } catch(e) {
    console.warn('ForexBenchmark fetch failed:', e.message);
    try {
      const stale = await redisCmd('GET', RETAIL_CACHE_KEY);
      if (stale) return res.json({ ...JSON.parse(stale), stale: true });
    } catch(e2) {}
    return res.status(502).json({ error: 'ForexBenchmark unavailable: ' + e.message });
  }

  const positions = parseRetailPositions(html);

  if (Object.keys(positions).length === 0) {
    try {
      const stale = await redisCmd('GET', RETAIL_CACHE_KEY);
      if (stale) return res.json({ ...JSON.parse(stale), stale: true, parse_warning: 'Fresh parse returned 0 pairs' });
    } catch(e2) {}
    return res.status(502).json({ error: 'Retail sentiment parse failed — page structure may have changed' });
  }

  const payload = { positions, fetched_at: new Date().toISOString() };
  redisCmd('SET', RETAIL_CACHE_KEY, JSON.stringify(payload), 'EX', RETAIL_CACHE_TTL).catch(() => {});
  return res.json(payload);
}

function parseRetailPositions(html) {
  const positions = {};

  // Strip scripts/styles first
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Strategy: find table rows containing a known pair name + a percentage number.
  // ForexBenchmark uses a table where each row has: pair | % long | volume long | volume short
  // We scan every <tr> block and look for a pair name + percentage.
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(clean)) !== null) {
    const row = m[1];
    // Extract all text content from cells
    const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

    // Try to find a pair name we recognise in this row
    let foundPair = null;
    for (const pair of RETAIL_PAIRS) {
      // Match exact pair or slash-separated form (EUR/USD or EURUSD)
      const slashed = pair.slice(0, 3) + '/' + pair.slice(3);
      if (text.includes(pair) || text.includes(slashed)) {
        foundPair = pair;
        break;
      }
    }
    if (!foundPair) continue;

    // Find the first percentage number in the row (e.g. "19.6" or "80.4")
    const pctMatch = text.match(/\b(\d{1,3}(?:\.\d)?)\s*%?\b/);
    if (!pctMatch) continue;

    const longPct = parseFloat(pctMatch[1]);
    if (isNaN(longPct) || longPct < 0 || longPct > 100) continue;

    const shortPct = parseFloat((100 - longPct).toFixed(1));

    // Contrarian signal: extreme retail long → institutional short bias; extreme retail short → long bias
    let signal = 'NEUTRAL';
    if (longPct >= 65)      signal = 'CONTRARIAN_SHORT'; // retail crowded long → lean short
    else if (longPct <= 35) signal = 'CONTRARIAN_LONG';  // retail crowded short → lean long

    positions[foundPair] = { long_pct: longPct, short_pct: shortPct, signal };
  }

  return positions;
}
