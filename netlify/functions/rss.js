// In-memory cache — no external dependencies needed
// Netlify reuses function instances within ~60s windows
const cache = { xml: null, fetchedAt: 0 };
const CACHE_TTL = 50 * 1000; // 50 seconds

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  'NewsBlur Feed Fetcher - 1000000 subscribers',
];

exports.handler = async function(event, context) {
  const now = Date.now();
  const age = now - cache.fetchedAt;

  // Serve from memory cache if still fresh
  if (cache.xml && age < CACHE_TTL) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT',
        'X-Cache-Age': Math.round(age / 1000) + 's',
      },
      body: cache.xml,
    };
  }

  // Fetch fresh
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  let xml = null;
  let fetchError = null;

  try {
    const res = await fetch(RSS_URL, {
      headers: {
        'User-Agent': ua,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.financialjuice.com/',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const text = await res.text();
      if (text.includes('<rss')) {
        xml = text;
      } else {
        fetchError = 'NOT_RSS';
      }
    } else {
      fetchError = 'HTTP_' + res.status;
    }
  } catch (e) {
    fetchError = e.message;
  }

  // Fetch failed — serve stale cache if available
  if (!xml) {
    if (cache.xml) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'STALE',
          'X-Error': fetchError || 'unknown',
        },
        body: cache.xml,
      };
    }
    // No cache at all — real error
    const status = fetchError?.startsWith('HTTP_') ? parseInt(fetchError.slice(5)) : 502;
    return {
      statusCode: status,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Upstream fetch failed', detail: fetchError }),
    };
  }

  // Update cache
  cache.xml = xml;
  cache.fetchedAt = now;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
    },
    body: xml,
  };
};
