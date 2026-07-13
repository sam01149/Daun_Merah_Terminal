// api/feeds.js — consolidated feeds endpoint
// GET /api/feeds?type=rss            → FinancialJuice RSS XML (50s cache)
// GET /api/feeds?type=cot            → CFTC COT JSON (6h cache)
// GET /api/feeds?type=research       → CB speeches/publications + macro research JSON (6h cache)
// GET /api/feeds?type=options        → FX option expiries JSON, merged from Investinglive + FinancialJuice (4h cache)
// GET /api/feeds?type=aftek&pair=EUR/USD → ActionForex per-pair technical outlook (4h cache)
// GET /api/feeds?type=retail         → ForexBenchmark retail positioning JSON (2h cache)
// GET /api/feeds?type=retail_history → snapshot harian retail positioning (rolling 90 hari)
// GET /api/feeds?type=news_history&before=<ms>&limit=100 → halaman berita lama dari archive
//   36 jam untuk tombol "Muat Berita Lebih Lama" di tab NEWS (read-only, UI-only — window
//   baca dan retensi PERSIS sama dengan yang dipakai market-digest.js Call 2 CB bias).

const { autoUpdateFundamentals } = require('./_fundamental_parser');
const rateLimit = require('./_ratelimit');
const cbk = require('./_circuit_breaker');
const { requireAppKey } = require('./_app_key');

module.exports = async function handler(req, res) {
  const type = req.query.type;
  // type=rss DIKECUALIKAN dari gate APP_KEY: service worker (sw.js) polling notifikasi
  // via periodicsync di background — tidak punya akses localStorage/key. Endpoint ini
  // cache-first (50s), tanpa AI, jadi residual abuse-nya murah. Type lain tetap digate.
  if (type !== 'rss' && requireAppKey(req, res)) return;
  if (await rateLimit(req, res, { limit: 30, windowSecs: 60, endpoint: `feeds_${type || 'none'}` })) return;
  if (type === 'rss')         return rssHandler(req, res);
  if (type === 'cot')         return cotHandler(req, res);
  if (type === 'cot_history') return cotHistoryHandler(req, res);
  if (type === 'research')    return researchHandler(req, res);
  if (type === 'options')     return optionsHandler(req, res);
  if (type === 'aftek')       return aftekHandler(req, res);
  if (type === 'retail')      return retailHandler(req, res);
  if (type === 'retail_history') return retailHistoryHandler(req, res);
  if (type === 'news_history') return newsHistoryHandler(req, res);
  return res.status(400).json({ error: 'Missing ?type= — use rss, cot, cot_history, research, options, aftek, retail, retail_history, or news_history' });
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
        res.setHeader('X-News-Source', obj.source || 'financialjuice');
        return res.status(200).send(obj.xml);
      }
    }
  } catch(e) {
    console.warn('RSS Redis GET failed:', e.message);
  }

  // Cache expired — avoid a "thundering herd": if several browser windows/users
  // poll right as the 50s cache lapses, only the request holding this lock
  // actually hits FinancialJuice. Everyone else waits briefly for its result
  // instead of firing concurrent upstream requests, which can look like a
  // scrape burst to FinancialJuice's own anti-bot defenses and get blocked.
  const lockKey = 'rss_fetch_lock';
  const gotLock = await redisCmd('SET', lockKey, '1', 'NX', 'EX', 25);

  if (!gotLock) {
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 350));
      try {
        const fresh = await redisCmd('GET', RSS_CACHE_KEY);
        if (fresh) {
          const obj = JSON.parse(fresh);
          if (Date.now() - obj.fetchedAt < RSS_CACHE_TTL_MS) {
            res.setHeader('X-Cache-Source', 'REDIS_WAIT');
            res.setHeader('X-News-Source', obj.source || 'financialjuice');
            return res.status(200).send(obj.xml);
          }
        }
      } catch(e) {}
    }
    // Lock holder still hasn't published fresh data — serve whatever's cached
    // (even if stale) rather than also double-fetching upstream.
    try {
      const stale = await redisCmd('GET', RSS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        res.setHeader('X-Cache-Source', 'STALE_WAIT');
        res.setHeader('X-News-Source', obj.source || 'financialjuice');
        return res.status(200).send(obj.xml);
      }
    } catch(e) {}
    // Nothing cached at all (cold start race) — fall through and fetch
    // ourselves as last resort, lock or not.
  }

  const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
  let xml = null, fetchError = null;

  // Circuit breaker 'fj' (shared dengan health dashboard): kalau FinancialJuice
  // sedang OPEN, jangan bayar timeout 12s — langsung coba fallback.
  if (await cbk.canCall('fj')) {
    try {
      const r = await fetch(RSS_URL, {
        headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*', 'Referer': 'https://www.financialjuice.com/', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) { const t = await r.text(); if (t.includes('<rss')) xml = t; else fetchError = 'NOT_RSS'; }
      else fetchError = 'HTTP_' + r.status;
    } catch(e) { fetchError = e.message; }
    if (xml) cbk.onSuccess('fj').catch(() => {});
    else     cbk.onFailure('fj').catch(() => {});
  } else {
    fetchError = 'CIRCUIT_OPEN';
  }

  // Primary source down/blocked — serve stale cache instead of switching to a
  // different source (session 159, keputusan user): sempat pakai Investinglive
  // sebagai fallback isi (session 80), tapi headline dari sumber lain akan total
  // berbeda dari yang barusan dilihat user, lalu tiba-tiba balik lagi ke headline
  // FJ begitu FJ pulih — dua kali perubahan mendadak yang membingungkan. Mending
  // "macet" di data FJ terakhir yang familiar (stale, ditandai jelas via
  // X-Cache-Source: STALE) sampai FJ hidup lagi, daripada sekilas tampil dunia
  // berita yang berbeda lalu berubah lagi.
  if (!xml) {
    console.warn('FinancialJuice RSS failed:', fetchError, '— serving stale cache instead of switching source');
    if (gotLock) redisCmd('DEL', lockKey).catch(() => {}); // release early so next cycle isn't stuck waiting out the TTL
    try {
      const stale = await redisCmd('GET', RSS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        res.setHeader('X-Cache-Source', 'STALE');
        res.setHeader('X-News-Source', obj.source || 'financialjuice');
        return res.status(200).send(obj.xml);
      }
    } catch(e2) {}
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Upstream fetch failed', detail: fetchError });
  }

  if (gotLock) redisCmd('DEL', lockKey).catch(() => {}); // release as soon as fresh data is about to be cached

  const payload = JSON.stringify({ xml, fetchedAt: now, source: 'financialjuice' });
  try { await redisCmd('SET', RSS_CACHE_KEY, payload, 'EX', 60); } catch(e3) {
    console.warn('RSS Redis SET failed:', e3.message);
  }

  // Fire-and-forget: persist items to 36h rolling history for market-digest
  storeNewsHistory(xml, now).catch(() => {});

  res.setHeader('X-Cache-Source', 'UPSTREAM');
  res.setHeader('X-News-Source', 'financialjuice');
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

// ── News history handler ("Muat Berita Lebih Lama", plan/UX confirmed dengan user
//    session ini) — read-only pagination mundur atas 'news_history', sama sekali tidak
//    mengubah window baca atau perilaku Call 2 (CB bias) di market-digest.js, yang
//    membaca key Redis yang sama tapi dengan cutoff 36 jam-nya sendiri, terpisah total.
async function newsHistoryHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const before = req.query.before !== undefined ? Number(req.query.before) : Date.now();
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
  if (!isFinite(before)) return res.status(400).json({ error: 'invalid before' });

  // ZREVRANGEBYSCORE dengan bound eksklusif "(before" → ambil item yg lebih tua dari
  // cursor, urutan terbaru-dulu di dalam batch itu, dibatasi `limit` per halaman.
  const raw = await redisCmd('ZREVRANGEBYSCORE', 'news_history', `(${before}`, '-inf', 'LIMIT', '0', String(limit));
  const items = Array.isArray(raw)
    ? raw.map(s => { try { return JSON.parse(s); } catch(e) { return null; } }).filter(Boolean)
    : [];
  const oldestTs = items.length ? new Date(items[items.length - 1].pubDate).getTime() : null;

  return res.status(200).json({
    items,
    count: items.length,
    next_before: oldestTs,
    has_more: items.length === limit,
  });
}

function parseRSSItems(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title = get('title').replace(/^FinancialJuice:\s*/i,'').trim();
    const guid = get('guid'), pubDate = get('pubDate');
    const link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) {
      // description disimpan untuk SEMUA item (bukan cuma option-expiry/CB seperti versi
      // lama) — dipakai tab NEWS "Muat Berita Lebih Lama" biar berita lama juga tampil
      // dengan isi, bukan cuma judul. Retensi tetap 36 jam (lihat storeNewsHistory), jadi
      // tambahan storage-nya terbatas, bukan menumpuk tanpa batas.
      const item = { title, guid, pubDate, link, description: get('description') };
      items.push(item);
    }
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
    if (!await cbk.canCall('cftc')) throw new Error('CIRCUIT_OPEN');
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
    cbk.onSuccess('cftc').catch(() => {});
  } catch(e) {
    if (e.message !== 'CIRCUIT_OPEN') cbk.onFailure('cftc').catch(() => {});
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

    // Open Interest + baris "Percent of Open Interest ..." — dua-duanya SUDAH ada di
    // blok teks yang sama (audit vendor 2026-07-12, terverifikasi live): net mentah 50K
    // kontrak beda makna saat OI 200K vs 700K, jadi net sebagai % of OI adalah
    // normalisasi ekstremitas standar. Nol fetch tambahan. Kolom baris persen persis
    // sejajar dengan baris Positions (idx 3/4 = AM long/short, 6/7 = Lev long/short).
    const oi = _parseOpenInterest(block);
    const { amNetPctOi, levNetPctOi } = _parseCotPercentLine(lines);

    positions[currency] = {
      am_long: amLong, am_short: amShort, am_net: amNet, am_change_net: amChangeNet,
      lev_long: levLong, lev_short: levShort, lev_net: levNet, lev_change_net: levChangeNet,
      ...(oi != null ? { oi } : {}),
      ...(amNetPctOi  != null ? { am_net_pct_oi:  amNetPctOi  } : {}),
      ...(levNetPctOi != null ? { lev_net_pct_oi: levNetPctOi } : {}),
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

  // Percentile posisi 3 tahun (CFTC Socrata API) — konteks ekstremitas jangka panjang
  // yang tidak bisa dijawab cot_history internal (baru 90 hari). Cache terpisah,
  // refresh mingguan fire-and-forget; kalau belum ada, payload tetap jalan tanpanya.
  let percentiles = null;
  try {
    const rawPctile = await redisCmd('GET', 'cot_pctile_v1');
    if (rawPctile) {
      const p = JSON.parse(rawPctile);
      if (p && p.by_currency) percentiles = p;
    }
  } catch(e) {}
  const pctileStaleMs = percentiles ? Date.now() - new Date(percentiles.stored_at).getTime() : Infinity;
  if (pctileStaleMs > 6 * 24 * 3600 * 1000) updateCotPercentiles().catch(e => console.warn('cot pctile refresh failed:', e.message));

  const payload = {
    positions,
    report_date: reportDate,
    release_date: releaseDate,
    ...(percentiles ? { percentiles: percentiles.by_currency, percentiles_asof: percentiles.report_date } : {}),
    fetched_at: new Date().toISOString(),
  };

  redisCmd('SET', 'cot_cache_v2', JSON.stringify(payload), 'EX', 21600).catch(() => {});

  // Fire-and-forget: accumulate weekly snapshots for future trend display
  storeCOTHistory(positions, reportDate).catch(() => {});

  return res.status(200).json(payload);
}

// ── Helper parse blok COT (pure, dipakai cotHandler + unit test) ──────────────

function _parseOpenInterest(block) {
  const m = String(block || '').match(/Open Interest is\s+([\d,]+)/i);
  return m ? parseInt(m[1].replace(/,/g, '')) : null;
}

// Baris "Percent of Open Interest Represented by Each Category of Trader" punya
// kolom yang persis sejajar dengan baris Positions: idx 3/4 = AM long/short,
// idx 6/7 = Lev long/short. Kembalikan net (long − short) sebagai % of OI.
function _parseCotPercentLine(lines) {
  const empty = { amNetPctOi: null, levNetPctOi: null };
  if (!Array.isArray(lines)) return empty;
  for (let i = 0; i < lines.length; i++) {
    if (!/Percent of Open Interest/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const pcts = lines[j].trim().split(/\s+/)
        .filter(s => /^-?[\d.]+$/.test(s))
        .map(parseFloat);
      if (pcts.length >= 8) {
        return {
          amNetPctOi:  +(pcts[3] - pcts[4]).toFixed(1),
          levNetPctOi: +(pcts[6] - pcts[7]).toFixed(1),
        };
      }
    }
    return empty;
  }
  return empty;
}

// ── COT percentile 3 tahun (CFTC Socrata public API) ─────────────────────────
// Dataset yw9f-hn96 = "Traders in Financial Futures — Combined" (futures+options,
// sumber yang sama dengan financial_lof.htm). Satu request mingguan menarik ~156
// laporan mingguan x 8 market, lalu dihitung percentile rank posisi net TERAKHIR
// (AM & Lev) terhadap distribusi 3 tahunnya sendiri. Diverifikasi live 2026-07-12:
// row terbaru identik dengan rilis financial_lof (EUR AM net +279.5K, Lev -66.1K).
const COT_SOCRATA_MARKETS = {
  USD: ['USD INDEX', 'U.S. DOLLAR INDEX - ICE FUTURES U.S.'],
  EUR: ['EURO FX'],
  GBP: ['BRITISH POUND', 'BRITISH POUND STERLING'],
  JPY: ['JAPANESE YEN'],
  CAD: ['CANADIAN DOLLAR'],
  AUD: ['AUSTRALIAN DOLLAR'],
  NZD: ['NZ DOLLAR', 'NEW ZEALAND DOLLAR'],
  CHF: ['SWISS FRANC'],
};

// Percentile rank (0-100) nilai terakhir terhadap seluruh distribusi (inklusif).
function _pctileRank(values, latest) {
  if (!Array.isArray(values) || values.length < 20 || latest == null) return null;
  const below = values.filter(v => v <= latest).length;
  return Math.round(below / values.length * 100);
}

async function updateCotPercentiles() {
  // Lock NX 20 jam — gagal fetch tetap tidak retry-storm; sukses di-cache 8 hari.
  const lock = await redisCmd('SET', 'cot_pctile_lock', '1', 'EX', 72000, 'NX');
  if (!lock) return;

  const allNames = Object.values(COT_SOCRATA_MARKETS).flat();
  const inList = allNames.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
  const cutoff = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    '$select': 'contract_market_name,report_date_as_yyyy_mm_dd,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short',
    '$where': `contract_market_name in(${inList}) AND report_date_as_yyyy_mm_dd>'${cutoff}'`,
    '$limit': '3000',
  });
  const r = await fetch(`https://publicreporting.cftc.gov/resource/yw9f-hn96.json?${params}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`CFTC Socrata HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length < 100) throw new Error(`CFTC Socrata: cuma ${Array.isArray(rows) ? rows.length : 0} row`);

  const nameToCur = {};
  for (const [cur, names] of Object.entries(COT_SOCRATA_MARKETS))
    for (const n of names) nameToCur[n] = cur;

  const series = {}; // { USD: [{date, am_net, lev_net}, ...] }
  for (const row of rows) {
    const cur = nameToCur[row.contract_market_name];
    if (!cur) continue;
    const amNet  = parseInt(row.asset_mgr_positions_long) - parseInt(row.asset_mgr_positions_short);
    const levNet = parseInt(row.lev_money_positions_long) - parseInt(row.lev_money_positions_short);
    if (isNaN(amNet) || isNaN(levNet)) continue;
    (series[cur] = series[cur] || []).push({ date: row.report_date_as_yyyy_mm_dd, am_net: amNet, lev_net: levNet });
  }

  const by_currency = {};
  let latestDate = null;
  for (const [cur, arr] of Object.entries(series)) {
    arr.sort((a, b) => a.date < b.date ? -1 : 1);
    const latest = arr[arr.length - 1];
    const amPct  = _pctileRank(arr.map(x => x.am_net), latest.am_net);
    const levPct = _pctileRank(arr.map(x => x.lev_net), latest.lev_net);
    if (amPct == null && levPct == null) continue;
    by_currency[cur] = { am_pctile: amPct, lev_pctile: levPct, n_weeks: arr.length };
    if (!latestDate || latest.date > latestDate) latestDate = latest.date;
  }
  if (Object.keys(by_currency).length < 5) throw new Error(`CFTC Socrata: cuma ${Object.keys(by_currency).length}/8 market terhitung`);

  const payload = {
    by_currency,
    report_date: latestDate ? latestDate.slice(0, 10) : null,
    window_years: 3,
    stored_at: new Date().toISOString(),
  };
  await redisCmd('SET', 'cot_pctile_v1', JSON.stringify(payload), 'EX', 8 * 24 * 3600);
  console.log(`cot pctile updated: ${Object.keys(by_currency).length} markets, report ${payload.report_date}`);
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
  // BIS direct — RSS 1.0/RDF format, accessible from Vercel (rss2json proxy tidak perlu dan tidak reliable)
  { key: 'BIS',  url: 'https://www.bis.org/doclist/cbspeeches.rss' },
  // RBA via rss2json — RBA memblokir Vercel IP langsung (403); rss2json juga tidak reliable (500)
  // tetap dipertahankan karena kalau rss2json pulih, langsung jalan lagi otomatis
  { key: 'RBA',  url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.rba.gov.au%2Frss%2Frss-cb-speeches.xml' },
  { key: 'RBAM', url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.rba.gov.au%2Frss%2Frss-cb-minutes.xml' },
  { key: 'RBAS', url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.rba.gov.au%2Frss%2Frss-cb-statements.xml' },
  // BoC — /feed/speeches/ sekarang return HTML; /feed/ adalah general feed yang valid
  { key: 'BOC',  url: 'https://www.bankofcanada.ca/feed/' },
  // BoJ — RSS feeds dihapus total setelah redesign website 2024, semua URL 404/timeout
  // { key: 'BOJ', url: '...' }, // removed — no working RSS endpoint found
  // BOE (Bank of England) — accessible langsung dari Vercel, penting untuk GBP
  { key: 'BOE',  url: 'https://www.bankofengland.co.uk/rss/speeches' },
  { key: 'BOEP', url: 'https://www.bankofengland.co.uk/rss/publications' },
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
  // Some CB feeds (notably BoC's general /feed/, which aggregates the whole
  // site rather than just publications) mix genuine published research with
  // forward-looking calendar entries — statutory holidays, scheduled rate
  // announcement dates — whose <pubDate> is the future EVENT date, not a
  // publish timestamp. Sorted newest-first, those future dates bury today's
  // real articles under a holiday list. A genuinely published item can never
  // be dated in the future, so drop anything beyond a small clock-skew
  // allowance instead of maintaining a per-source holiday/title blocklist.
  const FUTURE_SKEW_MS = 60 * 60 * 1000; // 1h tolerance for feed timezone quirks
  const nowMs = Date.now();
  items = items.filter(it => {
    const t = new Date(it.pubDate).getTime();
    return !isNaN(t) && t <= nowMs + FUTURE_SKEW_MS;
  });
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

  // Support RSS 2.0 (<item>), Atom 1.0 (<entry>), and RDF/RSS 1.0 (<item rdf:about="...">)
  const blockRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/g;
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

// ── FX Option Expiries handler (Investinglive + FinancialJuice) ───────────────
// GET /api/feeds?type=options[&pair=EURUSD]
// Merges two independent daily FX option-expiry sources: Investinglive's
// forexorders RSS feed and FinancialJuice's "[Day] FX Options Expiries" headline.

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
          return res.json({ expiries: out, fetched_at: obj.fetched_at, date: obj.date, sources: obj.sources, source: 'cache' });
        }
      }
    } catch(e) {}
  }

  // Two independent sources, fetched in parallel — neither depends on the other,
  // and if one is down/blocked the other still gives usable data instead of a
  // hard failure (this is why we don't bail early on the first rejection).
  const [ilResult, fjResult] = await Promise.allSettled([
    fetchInvestingLiveOptions(),
    fetchFinancialJuiceOptions(),
  ]);

  let expiries = [];
  const sources = [];
  let latestDate = '';

  if (ilResult.status === 'fulfilled') {
    expiries = expiries.concat(ilResult.value.expiries);
    sources.push({ name: 'Investinglive', link: ilResult.value.link, date: ilResult.value.date });
    if (ilResult.value.date) latestDate = ilResult.value.date;
  } else {
    console.warn('InvestingLive options fetch failed:', ilResult.reason?.message);
  }

  if (fjResult.status === 'fulfilled') {
    expiries = expiries.concat(fjResult.value.expiries);
    sources.push({ name: 'FinancialJuice', link: fjResult.value.link, date: fjResult.value.date });
    if (fjResult.value.date && !latestDate) latestDate = fjResult.value.date;
  } else {
    console.warn('FinancialJuice options fetch failed:', fjResult.reason?.message);
  }

  if (sources.length === 0) {
    // Both sources down — fall back to stale cache rather than a hard error
    try {
      const stale = await redisCmd('GET', OPTIONS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        const out = pairFilter ? filterByPair(obj.expiries, pairFilter) : obj.expiries;
        return res.json({ expiries: out, fetched_at: obj.fetched_at, date: obj.date, sources: obj.sources, stale: true });
      }
    } catch(e2) {}
    return res.status(502).json({ error: 'Option expiries unavailable: both Investinglive and FinancialJuice failed' });
  }

  expiries = dedupeExpiries(expiries);

  const payload = { expiries, fetched_at: new Date().toISOString(), date: latestDate, sources };
  redisCmd('SET', OPTIONS_CACHE_KEY, JSON.stringify(payload), 'EX', 14400).catch(() => {});

  const out = pairFilter ? filterByPair(expiries, pairFilter) : expiries;
  return res.json({ expiries: out, fetched_at: payload.fetched_at, date: latestDate, sources });
}

// Forexlive moved to investinglive.com — dedicated forexorders feed.
// rss2json is a documented recurring single point of failure (proxy 500s
// independently of the source feed being fine) — on any failure, fall back
// to fetching the source RSS directly instead of surfacing a hard error.
async function fetchInvestingLiveOptions() {
  const FL_RSS_URL     = 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Finvestinglive.com%2Ffeed%2Fforexorders%2F';
  const DIRECT_RSS_URL = 'https://investinglive.com/feed/forexorders/';

  let items;
  try {
    const r = await fetch(FL_RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('rss2json HTTP ' + r.status);
    const json = await r.json();
    if (json.status !== 'ok' || !json.items?.length) throw new Error('rss2json returned no items');
    items = json.items.map(it => ({ title: it.title, content: it.content || it.description || '', pubDate: it.pubDate || '', link: it.link || '' }));
  } catch(proxyErr) {
    const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
    const r2 = await fetch(DIRECT_RSS_URL, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r2.ok) throw new Error('Investinglive direct HTTP ' + r2.status + ' (rss2json also failed: ' + proxyErr.message + ')');
    const xml = await r2.text();
    const blocks = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/g) || [];
    items = blocks.map(b => {
      const get = tag => {
        const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
        const r2b = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
        return (r1||r2b)?.[1]?.trim() || '';
      };
      return { title: get('title'), content: get('content:encoded') || get('description'), pubDate: get('pubDate'), link: get('link') };
    });
    if (!items.length) throw new Error('Investinglive direct feed returned no items (rss2json also failed: ' + proxyErr.message + ')');
  }

  const expiryPost = items.find(it => /options?\s*expir/i.test(it.title));
  if (!expiryPost) throw new Error('No option expiry post found in feed');

  const rawText  = expiryPost.content || '';
  const postDate = expiryPost.pubDate || '';
  const postLink = expiryPost.link || '';

  const expiries = parseOptionExpiries(rawText, postLink).map(e => ({ ...e, source: 'Investinglive' }));
  if (expiries.length === 0) throw new Error('No expiries parsed from Investinglive post');
  return { expiries, date: postDate, link: postLink };
}

// FinancialJuice posts a daily "[Day] FX Options Expiries" headline straight into
// its main news feed (same RSS_URL used by the news ticker) — structured as
// "<li><strong>PAIR:</strong> level (size), level (size)</li>" per pair.
async function fetchFinancialJuiceOptions() {
  // 1) Try the live ticker first — cheap, and catches the post within roughly
  //    the first hour after FinancialJuice publishes it.
  try {
    const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*', 'Referer': 'https://www.financialjuice.com/', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const xml = await r.text();
      if (xml.includes('<rss')) {
        const live = extractFJExpiryFromXml(xml);
        if (live) return live;
      }
    }
  } catch(e) { /* fall through to history */ }

  // 2) FinancialJuice's main feed is a fast, all-asset-classes ticker — at
  //    dozens of headlines/hour, a once-daily expiry post commonly rotates
  //    out of that narrow window within a few hours. Fall back to the 36h
  //    `news_history` Redis archive, which is already being populated on
  //    every visitor's RSS poll via storeNewsHistory().
  const cutoff = Date.now() - 36 * 60 * 60 * 1000;
  const raw = await redisCmd('ZRANGEBYSCORE', 'news_history', cutoff, '+inf');
  if (Array.isArray(raw)) {
    const candidates = raw
      .map(s => { try { return JSON.parse(s); } catch(e2) { return null; } })
      .filter(it => it && it.description && /options?\s*expir/i.test(it.title))
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    if (candidates.length > 0) {
      const it = candidates[0];
      const rawText = it.description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const expiries = parseOptionExpiries(rawText, it.link).map(e => ({ ...e, source: 'FinancialJuice' }));
      if (expiries.length > 0) return { expiries, date: it.pubDate, link: it.link };
    }
  }

  throw new Error('No option expiry post found in feed or history');
}

function extractFJExpiryFromXml(xml) {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  let expiryItem = null;
  for (const it of items) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(it);
    const title = (titleMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (/options?\s*expir/i.test(title)) { expiryItem = it; break; }
  }
  if (!expiryItem) return null;

  const descMatch = /<description[^>]*>([\s\S]*?)<\/description>/.exec(expiryItem);
  let rawText = (descMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
  rawText = rawText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  if (!rawText.trim()) return null;

  const linkMatch = /<link[^>]*>([\s\S]*?)<\/link>/.exec(expiryItem);
  const dateMatch = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(expiryItem);
  const postLink = (linkMatch?.[1] || '').trim();
  const postDate = (dateMatch?.[1] || '').trim();

  const expiries = parseOptionExpiries(rawText, postLink).map(e => ({ ...e, source: 'FinancialJuice' }));
  if (expiries.length === 0) return null;
  return { expiries, date: postDate, link: postLink };
}

// Two sources can report the same pair/level — merge those into one entry
// (so the table doesn't show visual duplicates) while keeping track of which
// source(s) confirmed it and preferring whichever side has a size figure.
function dedupeExpiries(expiries) {
  const byKey = new Map();
  for (const e of expiries) {
    const key = e.pair + '|' + e.level;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { pair: e.pair, level: e.level, size: e.size, link: e.link, sources: [e.source] });
      continue;
    }
    if (!existing.sources.includes(e.source)) existing.sources.push(e.source);
    if (!existing.size && e.size) existing.size = e.size;
  }
  return [...byKey.values()];
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
  // Size prefix is either a currency symbol ($/€/¥/£) or a 2-4 letter currency
  // code (EU, AUD, GBP, NZD, MXN...) — FinancialJuice uses the latter (e.g. "EU2.51b").
  const entryRe = /([\d]{1,4}\.[\d]{1,5}(?:\s*-\s*[\d]{1,5})?)\s*[\(\[]?((?:[€$¥£]|[A-Z]{2,4})?[\d.]+\s*(?:b(?:ln)?|m(?:ln)?|billion|million)?)\s*[\)\]]?/gi;
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
    if (!await cbk.canCall('actionforex')) throw new Error('CIRCUIT_OPEN');
    const ua = RESEARCH_UAS[Math.floor(Math.random() * RESEARCH_UAS.length)];
    const r = await fetch(feedUrl, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const items = parseCBRSSItems(xml, 'AF').slice(0, 5);
    cbk.onSuccess('actionforex').catch(() => {});

    const payload = { items, pair, covered: true, fetched_at: new Date().toISOString() };
    redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', AFTEK_CACHE_TTL).catch(() => {});
    return res.json(payload);
  } catch(e) {
    if (e.message !== 'CIRCUIT_OPEN') cbk.onFailure('actionforex').catch(() => {});
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
// 15 menit — dijaga tetap segar oleh GitHub Action retail-sentiment-warm.yml
// (cron */15) yang panggil ?force=1; TTL ini cuma jaring pengaman kalau
// Action-nya sendiri telat/gagal, bukan penentu update utama.
const RETAIL_CACHE_TTL = 15 * 60; // seconds

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
    if (!await cbk.canCall('forexbenchmark')) throw new Error('CIRCUIT_OPEN');
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
    cbk.onSuccess('forexbenchmark').catch(() => {});
  } catch(e) {
    if (e.message !== 'CIRCUIT_OPEN') cbk.onFailure('forexbenchmark').catch(() => {});
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

  // Fire-and-forget (plan G2): akumulasi snapshot harian utk histori — replikasi
  // pola storeCOTHistory. Gagal silent, jangan gagalkan response utama.
  storeRetailHistory(positions).catch(() => {});

  return res.json(payload);
}

// ── Retail Sentiment history (plan G2) ────────────────────────────────────────
// Mirror storeCOTHistory/cotHistoryHandler. Beda dari COT: retail tidak punya
// report date resmi mingguan → lock per-HARI UTC (datanya bisa berubah intraday,
// satu snapshot pertama per hari cukup untuk tren; jangan lock mingguan).

async function storeRetailHistory(positions, nowMs = Date.now()) {
  if (!positions || Object.keys(positions).length === 0) return;
  const dayKey = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const lock = await redisCmd('SET', `retail_hist_lock:${dayKey}`, '1', 'EX', 86400, 'NX');
  if (!lock) return;

  const entry = JSON.stringify({ positions, day: dayKey, stored_at: new Date(nowMs).toISOString() });
  await redisCmd('ZADD', 'retail_history', 'NX', nowMs, entry);

  // Rolling window 90 hari — sama seperti cot_history
  const cutoff = nowMs - 90 * 24 * 60 * 60 * 1000;
  await redisCmd('ZREMRANGEBYSCORE', 'retail_history', '-inf', cutoff);
}

// GET /api/feeds?type=retail_history&n=30
async function retailHistoryHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const n = Math.min(parseInt(req.query.n || '30', 10) || 30, 90);

  try {
    const raw = await redisCmd('ZRANGE', 'retail_history', '0', '-1', 'WITHSCORES');
    if (!raw || raw.length === 0) {
      return res.status(200).json({ history: [], count: 0, message: 'Belum ada data history retail sentiment' });
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

    // Descending by timestamp, ambil n terbaru, balik ke ascending utk chart
    pairs.sort((a, b) => b.ts - a.ts);
    const sliced = pairs.slice(0, n).reverse();

    return res.status(200).json({ history: sliced, count: sliced.length });
  } catch(e) {
    console.error('retail_history fetch failed:', e.message);
    return res.status(502).json({ error: 'retail_history fetch failed: ' + e.message });
  }
}

function parseRetailPositions(html) {
  const positions = {};

  // Strip scripts/styles first
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // ForexBenchmark's retail table columns (verified against live <thead>, 2026-07-10):
  // Symbol | Currency difference | Percentage long | Percentage/max | Volume/max | Price distance/max | ...
  // "Percentage long" is column index 2 (0-based) — NOT the first number in the row.
  // A prior version grabbed the first digit run in the row's flattened text, which
  // landed on "Currency difference" (col 1) instead — a different, unrelated metric
  // that happens to also fall in the 0-100 range often enough to pass validation
  // silently (e.g. AUDUSD showed 61.1 "long" when the real Percentage long was 5.2 —
  // the opposite lean). Parse per-<td> by index instead of scanning row text.
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(clean)) !== null) {
    const row = m[1];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let c;
    while ((c = cellRe.exec(row)) !== null) {
      cells.push(c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length < 3) continue;

    const symbolText = cells[0].toUpperCase();
    let foundPair = null;
    for (const pair of RETAIL_PAIRS) {
      // Match exact pair or slash-separated form (EUR/USD or EURUSD)
      const slashed = pair.slice(0, 3) + '/' + pair.slice(3);
      if (symbolText.includes(pair) || symbolText.includes(slashed)) {
        foundPair = pair;
        break;
      }
    }
    if (!foundPair) continue;

    const longPct = parseFloat(cells[2]);
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

// Ekspor helper murni untuk unit test (module.exports = handler function; properti
// tambahan tidak mengubah perilaku require() di tempat lain).
module.exports.parseRetailPositions = parseRetailPositions;
module.exports.storeRetailHistory = storeRetailHistory;
module.exports.retailHistoryHandler = retailHistoryHandler;
module.exports.newsHistoryHandler = newsHistoryHandler;
module.exports.storeNewsHistory = storeNewsHistory;
module.exports.parseRSSItems = parseRSSItems;
module.exports._pctileRank = _pctileRank;
module.exports._parseOpenInterest = _parseOpenInterest;
module.exports._parseCotPercentLine = _parseCotPercentLine;
