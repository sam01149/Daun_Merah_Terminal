// api/unified-digest.js
const rateLimit    = require('./_ratelimit');
const cb           = require('./_circuit_breaker');
const { autoUpdateFundamentals } = require('./_fundamental_parser');
const { withSingleFlight } = require('./_fetch_lock');
const { getLiveCbRates } = require('./_cb_rates');
const { configureVapid, sendWebPush } = require('./_webpush');

// AI provider failure threshold before circuit opens (fewer than external sources
// because AI errors are faster to detect and providers recover quickly)
const AI_CB_THRESHOLD = 2;

// Frasa terlarang dari DIGEST_SYSTEM_DEFAULT — satu sumber kebenaran untuk prompt DAN cek kode (C8)
const FORBIDDEN_PHRASES = [
  'dapat mempengaruhi','dapat memberikan','dapat berdampak','perlu dicermati','patut diwaspadai',
  'tergantung data','masih akan volatile','menjadi fokus','berpotensi menggerakkan',
  'berpotensi mempengaruhi','dapat menekan','memberikan tekanan','memberikan dorongan',
  'perlu diperhatikan','akan terus dipantau','seiring dengan','sejalan dengan','di tengah',
  'memberikan gambaran','masih dalam ketidakpastian','mencermati','perkembangan ini',
  'berdampak pada pasar',
];

const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';

// AI providers
const SAMBANOVA_URL       = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL     = 'DeepSeek-V3.2';              // Call 2 & 3: structured JSON (akun 1) — upgrade dari V3.1, kualitas lebih baik
const SAMBANOVA_URL_CALL1 = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL_CALL1 = 'DeepSeek-V3.2';            // Call 1: prose (akun 2) — preview, tapi kualitas superior untuk Indonesian
// Circuit breaker source names — pisahkan per-akun agar kegagalan akun 1 tak menjatuhkan akun 2
const CB_SAMBA_C1   = 'ai:sambanova:c1';   // Call 1 prosa, akun 2 (SAMBANOVA_KEY_CALL1)
const CB_SAMBA_MAIN = 'ai:sambanova:main'; // Call 2/3/4 JSON, akun 1 (SAMBANOVA_KEY)
const GROQ_URL        = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama-3.3-70b-versatile';        // Call 2, 3, 4: JSON + thesis
const GROQ_MODEL_PROSE = 'llama-3.3-70b-versatile';        // Call 1 fallback 3: prose. Diganti dari qwen/qwen3-32b (2026-06)
                                                            // — terkonfirmasi via console.groq.com/docs/models statusnya
                                                            // "Preview/Evaluation" (bukan production), kemungkinan besar
                                                            // sumber HTTP 413 saat jadi fallback terakhir. llama-3.3-70b-versatile
                                                            // production-tier, context sama 131K, sudah proven reliable di
                                                            // codebase ini buat Call 2/4, dan didokumentasikan resmi cocok
                                                            // untuk "long-form content".
const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL   = 'openai/gpt-oss-120b:free'; // Call 1 fallback 2: proven stabil, output Bahasa Indonesia
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://financial-feed-app.vercel.app', 'X-Title': 'Daun Merah' };

const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

// Map pair label → Yahoo symbol for OHLCV context lookup
const OHLCV_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
  'NZD/USD': 'NZDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X', 'AUD/JPY': 'AUDJPY=X', 'EUR/AUD': 'EURAUD=X',
  'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X', 'XAU/USD': 'GC=F',
};

// Map non-USD major currency → its standard OHLCV pair label (for "today's dominant headline currency" lookup)
const CUR_TO_OHLCV_PAIR = {
  EUR: 'EUR/USD', GBP: 'GBP/USD', JPY: 'USD/JPY',
  CAD: 'USD/CAD', AUD: 'AUD/USD', NZD: 'NZD/USD', CHF: 'USD/CHF',
};

// Central-bank keyword map — used both to pick today's dominant FX pair for OHLCV context
// and to scope Call 2 (CB bias) headline analysis.
const CB_KW = {
  USD: ['fed','fomc','powell','goolsbee','waller','kashkari','warsh','federal reserve','us inflation','us gdp','us jobs','nfp','us cpi'],
  EUR: ['ecb','lagarde','lane','schnabel','euro zone','eurozone','euro area','eu inflation','eu gdp'],
  GBP: ['boe','bank of england','bailey','pill','gbp','sterling','uk inflation','uk gdp','uk jobs','claimant'],
  JPY: ['boj','bank of japan','ueda','japan inflation','japan gdp','yen','japanese'],
  CAD: ['boc','bank of canada','macklem','canada inflation','canada gdp','canadian'],
  AUD: ['rba','reserve bank of australia','bullock','australia inflation','australia gdp','aussie'],
  NZD: ['rbnz','reserve bank of new zealand','orr','new zealand inflation','new zealand gdp','kiwi'],
  CHF: ['snb','swiss national bank','schlegel','switzerland','swiss franc','franc'],
};
// Word-boundary match: single words use \b..\b so 'orr' won't match 'worrying',
// 'boc' won't match 'pboc', 'lane' won't match 'plane', etc.
// Phrases (containing space) keep simple includes since boundaries don't apply.
const kwTest = (title, kw) => kw.includes(' ')
  ? title.includes(kw)
  : new RegExp('\\b' + kw + '\\b').test(title);
const GOLD_KEYWORDS = [
  // Direct gold references
  'gold','xau','bullion','spot gold','precious metal','gold price','gold demand','gold rally','gold drop',
  // Real yield / USD channel (gold's #1 driver)
  'real yield','tips yield','breakeven','inflation expect','10y yield','10-year yield','treasury yield','us yield','yield curve',
  'dxy','dollar index',
  // Fed / FOMC — USD fundamentals that directly drive XAU via rate/real yield channel
  'powell','warsh','fomc','federal reserve','fed rate','fed minutes','fed pivot','rate cut','rate hike',
  'us cpi','us inflation','nonfarm','nfp','us gdp','us jobs','us unemployment',
  // ETF / flow
  'gld','gold etf','etf flow','bullion etf','central bank buy','central bank gold','gold reserve',
  // Safe haven — gold-specific phrasing only
  'safe haven','haven demand','flight to safety','flight to gold',
  // Geopolitical — only phrasing explicitly tied to haven/gold impact
  'middle east tension','iran nuclear','russia ukraine','ukraine war','gold safe',
  // Iran / Hormuz — direct geopolitical risk → safe haven gold channel
  // 'iran' standalone: nearly all Iran headlines in financial news imply geopolitical risk
  'iran','hormuz','strait of hormuz','ofac sanction','iran nuclear deal',
  'iran oil','iran blockade','us-iran',
  // Risk sentiment — equities as risk-off/on proxy for haven demand
  'risk aversion','risk-off','risk off','risk-on','risk on',
  'vix spike','vix surge','equity sell-off','stock market crash','market rout','flight to bonds',
  // Geopolitical — broader triggers with clear haven implication
  'trade war','us china tariff','sanction escalat','nuclear threat','conflict escalat',
  // US-China trade / Trump geopolitical — risk-on/off driver affecting gold via sentiment channel
  // 'beijing' captures Trump China visit; 'trump xi' captures summit headlines
  'trump xi','beijing','china visit','us china trade','china trade deal','rare earth',
  // Dollar moves (non-DXY phrasing)
  'dollar rally','dollar drop','dollar strengthen','dollar weaken','usd rally','usd drop',
  // Precious metals family — comex is gold's primary venue
  'comex','silver price','silver rally','silver drop',
];

// ── XAU/USD spot price fetch (Yahoo GC=F → Binance PAXG fallback) ─────────────
async function fetchXauSpot() {
  try {
    const cached = await redisCmd('GET', 'xau_spot');
    if (cached) {
      const d = JSON.parse(cached);
      if (Date.now() - new Date(d.fetched_at).getTime() < 5 * 60 * 1000) return d;
    }
  } catch(e) {}

  const sf = await withSingleFlight(redisCmd, {
    lockKey: 'lock:xau_spot',
    cacheKey: 'xau_spot',
    isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < 5 * 60 * 1000; } catch(e) { return false; } },
  });
  if (!sf.gotLock && sf.fresh) return JSON.parse(sf.fresh);

  // Primary: Yahoo Finance GC=F (COMEX gold front-month futures)
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=5m', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const json = await r.json();
      const meta  = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev  = meta?.previousClose || meta?.chartPreviousClose;
      if (price && price > 0) {
        const changePct = prev ? +((price - prev) / prev * 100).toFixed(2) : null;
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: changePct, source: 'Yahoo GC=F', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        if (sf.gotLock) sf.release();
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Yahoo failed:', e.message); }

  // Fallback: Binance PAXGUSDT (24/7, no auth, tracks spot 1:1)
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT', {
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const d = await r.json();
      const price     = parseFloat(d.lastPrice);
      const changePct = parseFloat(d.priceChangePercent);
      const prev      = parseFloat(d.openPrice);
      if (price > 0) {
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: +changePct.toFixed(2), source: 'Binance PAXG', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        if (sf.gotLock) sf.release();
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Binance failed:', e.message); }

  if (sf.gotLock) sf.release();
  return null;
}

// Read daily TA (RSI/SMA) from Redis cache (written by /api/correlations?action=ta).
// Generic — works for XAU (GC=F) and any FX pair Yahoo symbol.
async function fetchTaCache(symbol) {
  try {
    const cached = await redisCmd('GET', `ta:${symbol}:1d`);
    if (!cached) return null;
    const d = JSON.parse(cached);
    // Allow up to 2h stale — daily TA doesn't change fast
    if (Date.now() - new Date(d.computed_at).getTime() > 2 * 3600 * 1000) return null;
    return d;
  } catch(e) {
    console.warn(`fetchTaCache ${symbol} failed:`, e.message);
    return null;
  }
}
async function fetchXauTA() { return fetchTaCache('GC=F'); }

// Strip <think>...</think> blocks from Qwen3 thinking models — content after </think> is the actual response
function stripThinking(text) {
  const lastClose = text.lastIndexOf('</think>');
  if (lastClose !== -1) return text.slice(lastClose + 8).trim();
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Shared low-level fetch for any OpenAI-compatible provider
async function aiCall(url, apiKey, model, messages, maxTokens, temperature, timeoutMs, extraHeaders = {}, extraBody = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, ...extraBody }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err?.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    console.warn(`aiCall truncated (finish_reason=length, model=${model}, max_tokens=${maxTokens})`);
  }
  const content = choice?.message?.content || '';
  return stripThinking(content).trim();
}


// Read 1H OHLCV from Redis (written by ohlcv_sync cron) and format for AI context.
// Returns compact pre-processed block: 3D summary + raw 24H candles for entry context.
async function fetchOhlcvContext(symbol, label) {
  try {
    const isXau = symbol === 'GC=F';
    const isJpy = symbol.includes('JPY');
    const dec   = isXau ? 2 : isJpy ? 3 : 5;
    const fmt   = n => n.toFixed(dec);

    const fmtWib = ts => {
      const d = new Date((ts + 7 * 3600) * 1000);
      return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}WIB`;
    };

    // Read all 3 timeframes in parallel
    const [raw1h, raw4h, raw1d] = await Promise.all([
      redisCmd('GET', `ohlcv:${symbol}:1h`),
      redisCmd('GET', `ohlcv:${symbol}:4h`),
      redisCmd('GET', `ohlcv:${symbol}:1d`),
    ]);

    const c1h = raw1h ? JSON.parse(raw1h) : null;
    const c4h = raw4h ? JSON.parse(raw4h) : null;
    const c1d = raw1d ? JSON.parse(raw1d) : null;

    if (!c1h || c1h.length < 6) return null;

    const lines = [`=== ${label} MULTI-TIMEFRAME ===`];

    // ── Daily block — macro structure ─────────────────────────
    if (c1d && c1d.length >= 5) {
      const high1d = Math.max(...c1d.map(c => c.h));
      const low1d  = Math.min(...c1d.map(c => c.l));
      const curr1d = c1d[c1d.length - 1].c;
      const open1d = c1d[0].o;
      const chg1d  = +((curr1d - open1d) / open1d * 100).toFixed(2);

      const half   = Math.floor(c1d.length / 2);
      const avgOld = c1d.slice(0, half).reduce((s,c) => s+c.c, 0) / half;
      const avgNew = c1d.slice(half).reduce((s,c) => s+c.c, 0) / (c1d.length - half);
      const tPct   = (avgNew - avgOld) / avgOld * 100;
      const trend1d = tPct > 0.3 ? 'Uptrend' : tPct < -0.3 ? 'Downtrend' : 'Sideways';

      const topR = [...c1d].sort((a,b) => b.h - a.h).slice(0, 2).map(c => fmt(c.h));
      const botS = [...c1d].sort((a,b) => a.l - b.l).slice(0, 2).map(c => fmt(c.l));

      lines.push(`[MAKRO — Daily 30D] Range: ${fmt(low1d)}–${fmt(high1d)} | Now: ${fmt(curr1d)} | 30D: ${chg1d >= 0 ? '+' : ''}${chg1d}% | Trend: ${trend1d}`);
      lines.push(`  Resistance: ${topR.join(', ')} | Support: ${botS.join(', ')}`);

      if (isXau) {
        const vArr = c1d.map(c => c.v).filter(v => v > 0);
        if (vArr.length > 3) {
          const vAvg  = Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length);
          const vLast = c1d[c1d.length - 1].v;
          const vStat = vLast > vAvg * 1.5 ? 'HIGH' : vLast < vAvg * 0.7 ? 'low' : 'Normal';
          lines.push(`  Volume avg: ${(vAvg/1000).toFixed(0)}K | Today: ${(vLast/1000).toFixed(0)}K [${vStat}]`);
        }
      }
    }

    // ── 4H block — swing structure ────────────────────────────
    if (c4h && c4h.length >= 6) {
      const high4h = Math.max(...c4h.map(c => c.h));
      const low4h  = Math.min(...c4h.map(c => c.l));
      const curr4h = c4h[c4h.length - 1].c;
      const open4h = c4h[0].o;
      const chg4h  = +((curr4h - open4h) / open4h * 100).toFixed(2);

      const recent10 = c4h.slice(-10);
      const avgOld4  = c4h.slice(0, c4h.length - 10).reduce((s,c) => s+c.c, 0) / Math.max(1, c4h.length - 10);
      const avgNew4  = recent10.reduce((s,c) => s+c.c, 0) / recent10.length;
      const tPct4    = (avgNew4 - avgOld4) / avgOld4 * 100;
      const trend4h  = tPct4 > 0.15 ? 'Uptrend' : tPct4 < -0.15 ? 'Downtrend' : 'Sideways';

      const sHigh = [...c4h].sort((a,b) => b.h - a.h)[0];
      const sLow  = [...c4h].sort((a,b) => a.l - b.l)[0];

      lines.push(`[SWING — 4H 10D] Range: ${fmt(low4h)}–${fmt(high4h)} | Trend: ${trend4h} | 10D: ${chg4h >= 0 ? '+' : ''}${chg4h}%`);
      lines.push(`  Swing High: ${fmt(sHigh.h)} (${fmtWib(sHigh.t)}) | Swing Low: ${fmt(sLow.l)} (${fmtWib(sLow.t)})`);
    }

    // ── 1H block — entry context ──────────────────────────────
    const c72 = c1h.slice(-72);
    const c24 = c1h.slice(-24);

    const high1h = Math.max(...c72.map(c => c.h));
    const low1h  = Math.min(...c72.map(c => c.l));
    const curr1h = c72[c72.length - 1].c;
    const open1h = c72[0].o;
    const chg1h  = +((curr1h - open1h) / open1h * 100).toFixed(2);

    const older1h = c72.slice(0, Math.max(1, c72.length - 24));
    const avgO1h  = older1h.reduce((s,c) => s+c.c, 0) / older1h.length;
    const avgN1h  = c24.reduce((s,c) => s+c.c, 0) / c24.length;
    const tPct1h  = (avgN1h - avgO1h) / avgO1h * 100;
    const trend1h = tPct1h > 0.08 ? 'Uptrend' : tPct1h < -0.08 ? 'Downtrend' : 'Sideways';

    lines.push(`[ENTRY — 1H 3D] Range: ${fmt(low1h)}–${fmt(high1h)} | Now: ${fmt(curr1h)} | 3D: ${chg1h >= 0 ? '+' : ''}${chg1h}% | Trend: ${trend1h}`);

    // Pre-compute vol avg (XAU only) for per-candle labelling
    let vAvg1h = 0;
    if (isXau) {
      const vArr = c72.map(c => c.v).filter(v => v > 0);
      vAvg1h = vArr.length > 0 ? Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length) : 0;
    }

    lines.push(`[24H candles — entry context:]`);
    c24.forEach(c => {
      const base = `${fmtWib(c.t)} H:${fmt(c.h)} L:${fmt(c.l)} C:${fmt(c.c)}`;
      if (isXau && c.v > 0 && vAvg1h > 0) {
        const vStat = c.v > vAvg1h * 1.5 ? ' [HIGH]' : c.v < vAvg1h * 0.7 ? ' [low]' : '';
        lines.push(`${base} V:${(c.v/1000).toFixed(1)}K${vStat}`);
      } else {
        lines.push(base);
      }
    });

    return lines.join('\n');
  } catch(e) {
    console.warn(`fetchOhlcvContext ${symbol}:`, e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  console.log('market-digest v3 START', new Date().toISOString());
  const handlerStart = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cached mode — serve last saved digest from Redis, no AI calls
  if (req.query?.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', 'latest_article');
      const cachedDeviceId = req.query?.device_id;
      let cachedAlerts = null;
      if (cachedDeviceId) {
        try {
          const alertsRaw = await redisCmd('GET', `thesis_alerts:${cachedDeviceId}`);
          if (alertsRaw) cachedAlerts = JSON.parse(alertsRaw);
        } catch(e) { /* skip — non-critical */ }
      }
      if (raw) return res.status(200).json({ ...JSON.parse(raw), from_cache: true, thesis_alerts: cachedAlerts });
    } catch(e) { console.warn('cached mode Redis read failed:', e.message); }
    return res.status(200).json({ from_cache: true, article: null });
  }

  // Auth for scheduled session-open runs (Vercel cron sends x-vercel-cron; GitHub
  // Actions/cron-job.org fallback sends x-cron-secret) — these bypass the per-IP
  // rate limit below since they're 3 authenticated calls/day, not user traffic.
  // No device_id on these calls, which is intentional: Call 4 (thesis monitor,
  // gated on `&& deviceId` further down) is per-user journal data and is skipped,
  // while the shared briefing/bias/thesis still generate and populate the cache
  // every user's dashboard reads via mode=cached.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret    = req.headers['x-cron-secret'];
  const isCronCall    = isVercelCron || (cronSecret && cronSecret === process.env.CRON_SECRET);

  // Multi-provider AI calls — rate limit to 4 req/min per IP
  if (!isCronCall && await rateLimit(req, res, { limit: 4, windowSecs: 60, endpoint: 'market-digest' })) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('x-vercel-cache', 'BYPASS');

  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const SAMBANOVA_KEY  = process.env.SAMBANOVA_API_KEY;
  const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
  const GROQ_KEY       = process.env.GROQ_API_KEY;

  const host  = req.headers.host || 'financial-feed-app.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';

  // 1. RSS — current feed + 36h Redis history in parallel
  let rssItems = [];
  try {
    const cutoff36h = Date.now() - 36 * 60 * 60 * 1000;
    const histTimeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    const [rssRes, histRaw] = await Promise.allSettled([
      fetch(`${proto}://${host}/api/feeds?type=rss`, { signal: AbortSignal.timeout(12000) }),
      Promise.race([redisCmd('ZRANGEBYSCORE', 'news_history', cutoff36h, '+inf'), histTimeout]),
    ]);

    let currentItems = [];
    if (rssRes.status === 'fulfilled' && rssRes.value.ok) {
      const xml = await rssRes.value.text();
      if (xml.includes('<rss')) currentItems = parseRSS(xml);
    }

    let historyItems = [];
    if (histRaw.status === 'fulfilled' && Array.isArray(histRaw.value)) {
      historyItems = histRaw.value.map(s => { try { return JSON.parse(s); } catch(_) { return null; } }).filter(Boolean);
    }

    // Merge: current RSS takes priority, dedup by guid
    const seen = new Set(currentItems.map(i => i.guid));
    const merged = [...currentItems, ...historyItems.filter(i => i.guid && !seen.has(i.guid))];
    rssItems = merged
      .filter(i => new Date(i.pubDate).getTime() > cutoff36h)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    console.log(`RSS items: ${currentItems.length} current + ${historyItems.length} history → ${rssItems.length} merged`);
  } catch(e) {
    console.warn('RSS/history fetch failed:', e.message);
  }

  const recentItems = rssItems.slice(0, 150);

  // 2. Calendar
  let calEvents = [];
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
    ]);
    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 3; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    const seen = new Set();
    calEvents = allEvents
      .filter(e => dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => { const k=`${e.date}|${e.time_wib}|${e.currency}|${e.event}`; if(seen.has(k))return false; seen.add(k); return true; })
      .sort((a,b) => (a.date+a.time_wib).localeCompare(b.date+b.time_wib));
  } catch(e) { console.warn('Cal:', e.message); }

  // 3. Context
  const wibNow  = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;
  const DAYS_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const dayStr  = DAYS_ID[wibNow.getUTCDay()];
  const isMonEarly = wibNow.getUTCDay() === 1 && wibNow.getUTCHours() < 15;
  const weekendNote = isMonEarly ? '\nCATATAN KONTEKS: Ini Senin pagi — bagian "12-36 jam lalu" mencakup weekend, volume berita tipis, tidak market-moving.' : '';
  // QUAL-12: pre-rank headlines by the same per-currency mention signal already used below to
  // pick the dominant OHLCV pair (~line 556) — float headlines tied to today's dominant currency
  // theme to the top so the model focuses there, instead of feeding 80 headlines in raw chronological
  // order with no relevance signal. Sort is stable, so recency order is preserved within equal scores.
  const _headlinesLowerForRank = recentItems.map(i => i.title.toLowerCase());
  const curMentionCounts = {};
  for (const cur of Object.keys(CB_KW)) {
    const count = _headlinesLowerForRank.filter(h => CB_KW[cur].some(kw => kwTest(h, kw))).length;
    if (count > 0) curMentionCounts[cur] = count;
  }
  const _headlineRelevance = title => {
    const lower = title.toLowerCase();
    return Object.entries(curMentionCounts).reduce((sum, [cur, count]) => (
      CB_KW[cur].some(kw => kwTest(lower, kw)) ? sum + count : sum
    ), 0);
  };
  const headlinesForBriefing = [...recentItems].sort((a, b) => _headlineRelevance(b.title) - _headlineRelevance(a.title)).slice(0, 80);
  const headlinesBlock = headlinesForBriefing.length > 0 ? headlinesForBriefing.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n') : '(Tidak ada headline)';
  // Beri tag status SUDAH RILIS / AKAN RILIS yang dihitung di kode (bukan diserahkan
  // ke LLM untuk hitung sendiri dari "date | time" mentah) — LLM nggak reliable buat
  // aritmatika tanggal/jam relatif, dan ini ketahuan bikin kesalahan nyata: event hari
  // ini jam 08:30 WIB yang sudah lewat (generate jam 19:30+) malah disebut "besok pagi"
  // di output, padahal datanya sudah rilis beberapa jam sebelumnya.
  function _calEventStatusTag(e) {
    if (!e.time_wib || e.time_wib === 'Tentative') return '';
    const [hStr, mStr] = e.time_wib.replace(' WIB', '').split(':');
    const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
    if (isNaN(h) || isNaN(m)) return '';
    const [y, mo, d] = e.date.split('-').map(Number);
    const evMs = Date.UTC(y, mo - 1, d, h - 7, m); // WIB = UTC+7
    const diffH = (evMs - Date.now()) / 3600000;
    if (diffH < 0) {
      const ago = Math.abs(diffH) < 1 ? `${Math.round(Math.abs(diffH) * 60)} menit` : `${Math.round(Math.abs(diffH))} jam`;
      return ` [SUDAH RILIS ${ago} lalu — JANGAN sebut "besok"/"akan datang", actual mungkin belum masuk]`;
    }
    const until = diffH < 1 ? `${Math.round(diffH * 60)} menit` : `${Math.round(diffH)} jam`;
    return ` [AKAN RILIS dalam ${until}]`;
  }
  const calBlock = calEvents.length > 0 ? calEvents.map(e=>`- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}${_calEventStatusTag(e)}`).join('\n') : '(Tidak ada event high-impact)';

  // Gold-specific headline filter — split recent vs historical so AI weights correctly
  const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
  const isGold = i => GOLD_KEYWORDS.some(kw => i.title.toLowerCase().includes(kw));
  const goldRecent = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() > cutoff12h).slice(0, 20);
  const goldOlder  = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() <= cutoff12h).slice(0, 15);
  const goldItems  = [...goldRecent, ...goldOlder];
  const goldBlock  = [
    goldRecent.length > 0
      ? `[12 JAM TERAKHIR — ${goldRecent.length} berita]\n${goldRecent.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '[12 JAM TERAKHIR] (tidak ada)',
    goldOlder.length > 0
      ? `\n[KONTEKS HISTORIS 12-36 JAM LALU — ${goldOlder.length} berita]\n${goldOlder.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '\n[KONTEKS HISTORIS 12-36 JAM LALU] (tidak ada)',
  ].join('');

  // Self-healing cache read: if the Redis key is cold (no cron populates these — they're
  // normally warmed by frontend tab visits), fetch the source endpoint directly so the
  // digest still gets fresh data, and the endpoint's own SET refreshes the cache for next time.
  async function fetchOrWarm(key, path, timeoutMs = 15000) {
    try {
      const cached = await redisCmd('GET', key);
      if (cached) return cached;
    } catch(e) {}
    try {
      const r = await fetch(`${proto}://${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return JSON.stringify(await r.json());
    } catch(e) { console.warn(`fetchOrWarm ${key} failed:`, e.message); }
    return null;
  }

  // 3b. Load digest history + xau history + real yields + XAU spot + XAU TA + liquidity + yield curve
  //     + risk regime (VIX/MOVE/HY) + rate path (Fed Funds futures) + cross-asset correlations + FX skew, in parallel
  let digestHistory = [], xauHistory = [], realYieldsData = null, xauSpot = null, xauTa = null, liqData = null, ycData = null, rawPrevThesis = null;
  let riskRegimeData = null, ratePathData = null, correlationsData = null, riskReversalData = null;
  try {
    const [rawHist, rawXauHist, rawRY, spotResult, taResult, rawLiq, rawYc, _rawPrevThesis, rawRisk, rawRate, rawCorr, rawRR] = await Promise.all([
      redisCmd('LRANGE', 'digest_history', 0, 6),
      redisCmd('LRANGE', 'xau_history', 0, 3),
      redisCmd('GET', 'real_yields'),
      fetchXauSpot(),
      fetchXauTA(),
      redisCmd('GET', 'liquidity_usd'),
      redisCmd('GET', 'yield_curve'),
      redisCmd('GET', 'latest_thesis'),
      fetchOrWarm('risk_regime', '/api/risk-regime'),
      fetchOrWarm('rate_path', '/api/rate-path'),
      fetchOrWarm('correlations_v3', '/api/correlations'),
      fetchOrWarm('rr_cache_v2', '/api/correlations?action=risk-reversal'),
    ]);
    rawPrevThesis = _rawPrevThesis;
    if (Array.isArray(rawHist)) digestHistory = rawHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (Array.isArray(rawXauHist)) xauHistory = rawXauHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (rawRY) realYieldsData = JSON.parse(rawRY);
    xauSpot = spotResult;
    xauTa   = taResult;
    if (rawLiq)  { try { liqData          = JSON.parse(rawLiq);  } catch(_) {} }
    if (rawYc)   { try { ycData           = JSON.parse(rawYc);   } catch(_) {} }
    if (rawRisk) { try { riskRegimeData   = JSON.parse(rawRisk); } catch(_) {} }
    if (rawRate) { try { ratePathData     = JSON.parse(rawRate); } catch(_) {} }
    if (rawCorr) { try { correlationsData = JSON.parse(rawCorr); } catch(_) {} }
    if (rawRR)   { try { riskReversalData = JSON.parse(rawRR);   } catch(_) {} }
    console.log('XAU spot:', xauSpot ? `$${xauSpot.price} (${xauSpot.source})` : 'unavailable');
    console.log('XAU TA:', xauTa ? `RSI=${xauTa.rsi_14} SMA50=${xauTa.price_vs_sma50}` : 'unavailable (cache cold)');
    console.log('Risk regime:', riskRegimeData ? riskRegimeData.regime : 'unavailable (cache cold)');
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';
  const xauHistoryBlock = xauHistory.length > 0
    ? xauHistory.map(h => `[${h.wib}] ${h.xau_summary}`).join('\n')
    : '(Belum ada riwayat XAU — ini sesi pertama)';

  // Load OHLCV context: XAU always + FX pair picked from TODAY'S dominant headline currency
  // (falls back to previous thesis recommendation, then EUR/USD, if no major-currency headline today).
  let fxOhlcvSymbol = 'EURUSD=X', fxOhlcvLabel = 'EUR/USD';
  try {
    const headlinesLowerForPair = recentItems.map(i => i.title.toLowerCase());
    const curCounts = {};
    for (const cur of Object.keys(CUR_TO_OHLCV_PAIR)) {
      const count = headlinesLowerForPair.filter(h => CB_KW[cur].some(kw => kwTest(h, kw))).length;
      if (count > 0) curCounts[cur] = count;
    }
    const topCur = Object.entries(curCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topCur) {
      fxOhlcvSymbol = OHLCV_SYMBOL_MAP[CUR_TO_OHLCV_PAIR[topCur]];
      fxOhlcvLabel  = CUR_TO_OHLCV_PAIR[topCur];
      console.log(`OHLCV pair: dominant headline currency = ${topCur} (${curCounts[topCur]} mentions) → ${fxOhlcvLabel}`);
    } else if (rawPrevThesis) {
      const prevT = JSON.parse(rawPrevThesis);
      const rec = prevT?.pair_recommendation;
      if (rec && OHLCV_SYMBOL_MAP[rec] && OHLCV_SYMBOL_MAP[rec] !== 'GC=F') {
        fxOhlcvSymbol = OHLCV_SYMBOL_MAP[rec];
        fxOhlcvLabel  = rec;
        console.log(`OHLCV pair: no dominant headline currency today, falling back to prev thesis pair → ${fxOhlcvLabel}`);
      }
    }
  } catch(e) {
    console.warn('OHLCV pair selection failed, using default EUR/USD:', e.message);
  }
  let xauOhlcvBlock = null, fxOhlcvBlock = null, fxTa = null;
  try {
    [xauOhlcvBlock, fxOhlcvBlock, fxTa] = await Promise.all([
      fetchOhlcvContext('GC=F', 'XAU/USD'),
      fetchOhlcvContext(fxOhlcvSymbol, fxOhlcvLabel),
      fetchTaCache(fxOhlcvSymbol),
    ]);
    console.log('OHLCV context:', xauOhlcvBlock ? 'XAU ok' : 'XAU miss', fxOhlcvBlock ? `${fxOhlcvLabel} ok` : `${fxOhlcvLabel} miss`);
  } catch(e) {
    console.warn('OHLCV context load failed:', e.message);
  }

  // Build real yield block for Call 1 context
  let realYieldBlock = '(Data real yield tidak tersedia — inferensi dari headline saja)';
  if (realYieldsData?.currencies?.USD) {
    const ry = realYieldsData.currencies.USD;
    const trendNote = ry.real > 2.0 ? 'ELEVATED — tekanan struktural bearish pada XAU' : ry.real > 1.0 ? 'moderat' : 'rendah/negatif — relatif supportif XAU';
    realYieldBlock = `USD 10Y Nominal: ${ry.nominal}% | TIPS Breakeven: ${ry.inflation_exp}% | Real Yield: ${ry.real}% (${trendNote}) | per ${ry.as_of}`;
  }
  if (liqData?.tga_balance_bn != null) {
    const ch = liqData.tga_change_bn ?? 0;
    const tgaDir = ch > 5 ? `NAIK +$${ch}B (drain likuiditas)` : ch < -5 ? `TURUN $${ch}B (injeksi likuiditas)` : 'stabil';
    realYieldBlock += `\nLIKUIDITAS USD: TGA $${liqData.tga_balance_bn}B [${tgaDir}] | Fed Balance Sheet $${liqData.fed_assets_bn ?? '?'}B`;
  }
  if (ycData?.USD?.spread_2y10y != null) {
    const spread = ycData.USD.spread_2y10y;
    const curveShape = spread < 0 ? 'INVERTED (recessionary signal)' : spread < 0.3 ? 'flat' : 'normal/steep';
    realYieldBlock += `\nYIELD CURVE USD: 2Y ${ycData.USD['2y'] ?? '?'}% | 10Y ${ycData.USD['10y'] ?? '?'}% | Spread 2Y10Y ${spread}% [${curveShape}]`;
  }

  // Build XAU spot block
  let xauSpotBlock = '(Data harga XAU tidak tersedia sesi ini — gunakan tekanan fundamental saja)';
  if (xauSpot) {
    const sign  = xauSpot.change_pct > 0 ? '+' : '';
    const pctStr = xauSpot.change_pct !== null ? ` (${sign}${xauSpot.change_pct}% dari sesi sebelumnya)` : '';
    xauSpotBlock = `${xauSpot.source}: $${xauSpot.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${pctStr} | per ${xauSpot.as_of}`;
  }

  // Build XAU daily TA block
  let xauTaBlock = '(Cache TA belum tersedia — kunjungi tab TEK untuk mengisi cache, atau abaikan bagian ini)';
  if (xauTa) {
    const parts = [];
    if (xauTa.rsi_14 != null) {
      const rsiLabel = xauTa.rsi_14 > 70 ? 'Overbought' : xauTa.rsi_14 < 30 ? 'Oversold' : 'Netral';
      parts.push(`RSI 14: ${xauTa.rsi_14.toFixed(1)} (${rsiLabel})`);
    }
    if (xauTa.sma_50 != null && xauTa.price_vs_sma50)
      parts.push(`SMA 50: ${xauTa.sma_50.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma50 === 'above' ? 'di atas' : 'di bawah'}`);
    if (xauTa.sma_200 != null && xauTa.price_vs_sma200)
      parts.push(`SMA 200: ${xauTa.sma_200.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma200 === 'above' ? 'di atas' : 'di bawah'}`);
    xauTaBlock = parts.length > 0 ? parts.join(' | ') : '(Data TA terbatas)';
  }

  // Build FX pair daily TA block (RSI/SMA) — same cache mechanism as XAU, keyed by recommended pair's symbol
  let fxTaBlock = '(Cache TA belum tersedia untuk pair ini — kunjungi tab TEK untuk mengisi cache)';
  if (fxTa) {
    const parts = [];
    if (fxTa.rsi_14 != null) {
      const rsiLabel = fxTa.rsi_14 > 70 ? 'Overbought' : fxTa.rsi_14 < 30 ? 'Oversold' : 'Netral';
      parts.push(`RSI 14: ${fxTa.rsi_14.toFixed(1)} (${rsiLabel})`);
    }
    if (fxTa.sma_50 != null && fxTa.price_vs_sma50)
      parts.push(`SMA 50 — harga ${fxTa.price_vs_sma50 === 'above' ? 'di atas' : 'di bawah'}`);
    if (fxTa.sma_200 != null && fxTa.price_vs_sma200)
      parts.push(`SMA 200 — harga ${fxTa.price_vs_sma200 === 'above' ? 'di atas' : 'di bawah'}`);
    fxTaBlock = parts.length > 0 ? parts.join(' | ') : '(Data TA terbatas)';
  }

  // Build risk regime block (VIX/MOVE/HY) — ground-truth for risk-on/off claims instead of inferring from headlines
  let riskRegimeBlock = '(Data risk regime tidak tersedia — inferensi risk-on/off dari headline saja)';
  if (riskRegimeData) {
    const r = riskRegimeData;
    const parts = [`Regime: ${(r.regime || 'unknown').toUpperCase()}`];
    if (r.vix != null) parts.push(`VIX ${r.vix}${r.vix_change_2d != null ? ` (${r.vix_change_2d >= 0 ? '+' : ''}${r.vix_change_2d} 2d)` : ''}`);
    if (r.move != null) parts.push(`MOVE ${r.move}${r.move_change_2d != null ? ` (${r.move_change_2d >= 0 ? '+' : ''}${r.move_change_2d} 2d)` : ''}`);
    if (r.hy_spread != null) parts.push(`HY OAS ${r.hy_spread}%${r.hy_change_2d != null ? ` (${r.hy_change_2d >= 0 ? '+' : ''}${r.hy_change_2d} 2d)` : ''}`);
    if (r.vix_term_structure?.structure) parts.push(`VIX term structure: ${r.vix_term_structure.structure}`);
    riskRegimeBlock = parts.join(' | ');
  }

  // Build rate path block (market-implied Fed Funds path) — ground-truth for "rate differential" mechanism claims
  let ratePathBlock = '(Data rate path tidak tersedia — inferensi rate differential dari headline saja)';
  if (ratePathData?.USD?.cumulative_3m_bps != null) {
    const rp = ratePathData.USD;
    const dir3m = rp.cumulative_3m_bps < 0 ? `${Math.abs(rp.cumulative_3m_bps)}bps CUT priced (3m)` : rp.cumulative_3m_bps > 0 ? `${rp.cumulative_3m_bps}bps HIKE priced (3m)` : 'tidak ada perubahan diharga (3m)';
    const parts = [`USD: ${dir3m}`];
    if (rp.cumulative_6m_bps != null) {
      const dir6m = rp.cumulative_6m_bps < 0 ? `${Math.abs(rp.cumulative_6m_bps)}bps CUT (6m)` : rp.cumulative_6m_bps > 0 ? `${rp.cumulative_6m_bps}bps HIKE (6m)` : 'flat (6m)';
      parts.push(dir6m);
    }
    ratePathBlock = parts.join(' | ');
  }

  // Build cross-asset correlation block — anomalies (regime breaks) + gold's key correlations + FX grounding
  let correlationBlock = '(Data korelasi cross-asset tidak tersedia)';
  if (correlationsData) {
    const lines = [];
    // Anomali: prioritaskan pasangan yang relevan ke Gold/DXY (relevance-aware), baru sisanya by |delta|
    if (Array.isArray(correlationsData.anomalies) && correlationsData.anomalies.length > 0) {
      const isRelevant = (a) => /Gold|DXY/.test(a.label);
      const ranked = [...correlationsData.anomalies].sort((a, b) => {
        const ra = isRelevant(a) ? 1 : 0, rb = isRelevant(b) ? 1 : 0;
        if (ra !== rb) return rb - ra;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
      const dirHint = (a) => {
        const sameSign = (a.r20 >= 0) === (a.r60 >= 0);
        return sameSign ? 'melemah/menguat (arah sama)' : 'berbalik arah (sign-flip)';
      };
      lines.push('Anomali korelasi 20D vs 60D (deviasi >0.4 dari norma — sinyal regime berubah, prioritas Gold/DXY): ' +
        ranked.slice(0, 5).map(a => `${a.label} (20D:${a.r20} vs 60D:${a.r60}, Δ${a.delta}, ${dirHint(a)})`).join('; '));
    }
    if (correlationsData.gold_correlations && Object.keys(correlationsData.gold_correlations).length > 0) {
      lines.push('Korelasi Gold (20D vs norma 60D): ' +
        Object.entries(correlationsData.gold_correlations).map(([k, v]) =>
          `${k}:${v.r20 ?? '?'} (norma60D:${v.r60 ?? '?'}, Δ${v.delta ?? '?'})`).join(', '));
    }
    // Grounding korelasi FX — pasangan yang sering dipakai narasi benang merah FX
    if (correlationsData.matrix_20d && correlationsData.matrix_60d) {
      const getPair = (a, b) => {
        const k1 = `${a}|${b}`, k2 = `${b}|${a}`;
        const r20 = correlationsData.matrix_20d[k1] ?? correlationsData.matrix_20d[k2];
        const r60 = correlationsData.matrix_60d[k1] ?? correlationsData.matrix_60d[k2];
        return (r20 == null || r60 == null) ? null : { r20, r60 };
      };
      const FX_PAIRS = [['DXY','EUR'], ['DXY','GBP'], ['DXY','AUD'], ['DXY','JPY'], ['AUD','SPX'], ['JPY','US10Y']];
      const fxLines = FX_PAIRS.map(([a, b]) => {
        const d = getPair(a, b);
        return d ? `${a}-${b}:${d.r20} (60D:${d.r60})` : null;
      }).filter(Boolean);
      if (fxLines.length > 0) {
        lines.push('Korelasi FX (20D vs norma 60D): ' + fxLines.join(', '));
      }
    }
    correlationBlock = lines.length > 0 ? lines.join('\n') : '(Tidak ada anomali signifikan — korelasi sesuai norma historis)';
  }

  // Build FX/XAU options positioning block (25-delta risk reversal skew) — institutional positioning signal
  let riskReversalBlock = '(Data risk reversal/skew opsi tidak tersedia)';
  if (riskReversalData?.available && riskReversalData.pairs) {
    const entries = Object.entries(riskReversalData.pairs);
    if (entries.length > 0) {
      riskReversalBlock = entries.map(([pair, d]) => {
        const skew = d.rr_value;
        const lean = skew > 0.05 ? 'call-skewed (bullish bias)' : skew < -0.05 ? 'put-skewed (bearish bias)' : 'netral';
        return `${pair}: ${skew} (${lean})`;
      }).join(' | ');
    }
  }

  // 3c. Load externalized prompts from Redis — fall back to hardcoded if missing
  let promptDigestInstr = null;
  try {
    promptDigestInstr = await redisCmd('GET', 'prompt_digest');
  } catch(e) {
    console.warn('prompt_digest Redis load failed:', e.message);
  }

  // Pre-fire Call 2 (CB bias) and Call 4 (thesis monitor) concurrently with Call 1.
  // Both only need recentItems (already available) — no dependency on Call 1's article.
  const deviceId = req.query?.device_id;

  const _biasPromise = recentItems.length > 0 ? (async () => {
    const _biasUpdated = [];
    // CB_KW / kwTest are defined at module level — shared with the OHLCV dominant-pair lookup above.
    const relevantCurrencies = [];
    const headlinesLower = recentItems.map(i => i.title.toLowerCase());
    for (const [cur, kws] of Object.entries(CB_KW)) {
      if (kws.some(kw => headlinesLower.some(h => kwTest(h, kw)))) relevantCurrencies.push(cur);
    }
    console.log('relevantCurrencies (async):', JSON.stringify(relevantCurrencies));
    if (relevantCurrencies.length > 0) {
      const relevantHeadlines = recentItems.filter(i => {
        const lower = i.title.toLowerCase();
        return relevantCurrencies.some(cur => CB_KW[cur].some(kw => kwTest(lower, kw)));
      });
      const biasHeadlines = relevantHeadlines.slice(0, 50).map((i,idx) => (idx+1) + '. ' + i.title).join('\n');
      const biasCurrencies = relevantCurrencies.join(', ');
      // A1.1: read prior stance (read-only — the write path below still re-reads under lock
      // right before saving) + live policy rates, so the model judges a SHIFT, not an absolute stance.
      let prevBiasMap = {};
      try { const prevBiasRaw = await redisCmd('GET', 'cb_bias'); if (prevBiasRaw) prevBiasMap = JSON.parse(prevBiasRaw); } catch(e) {}
      let cbRatesMap = {};
      try {
        const cbRatesArr = await getLiveCbRates();
        cbRatesMap = Object.fromEntries(cbRatesArr.map(r => [r.currency, r.rate]));
      } catch(e) { console.warn('Call 2: getLiveCbRates failed:', e.message); }
      const priorStanceLines = relevantCurrencies.map(cur => {
        const prev = prevBiasMap[cur];
        const stanceStr = prev ? `stance sebelumnya = "${prev.bias}" (confidence ${prev.confidence}, ${prev.updated_at ? prev.updated_at.slice(0, 10) : '-'})` : 'stance sebelumnya = belum ada';
        const rate = cbRatesMap[cur];
        const rateStr = rate != null ? `policy rate sekarang = ${rate}%` : 'rate = n/a';
        return `${cur}: ${stanceStr}; ${rateStr}`;
      }).join('\n');
      const priorStanceSection = priorStanceLines ? [
        '', '=== PRIOR STANCE & POLICY RATE (gunakan sebagai titik acuan — nilai PERGESERAN, bukan stance absolut dari nol) ===',
        priorStanceLines,
      ].join('\n') : '';
      const fundDataForPrompt = {};
      try {
        await Promise.all(relevantCurrencies.map(async cur => {
          const fields = await redisCmd('HGETALL', `fundamental:${cur}`);
          if (Array.isArray(fields) && fields.length > 0) {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) { try { obj[fields[i]] = JSON.parse(fields[i + 1]); } catch(_) {} }
            fundDataForPrompt[cur] = obj;
          }
        }));
      } catch(e) { console.warn('Fundamental fetch for Call 2 failed:', e.message); }
      const fundLines = Object.entries(fundDataForPrompt).map(([cur, data]) => {
        const items = Object.entries(data).filter(([, v]) => v?.actual).map(([k, v]) => `${k}: ${v.actual}${v.previous ? ` (prev ${v.previous})` : ''} [${v.date || '—'}]`);
        return items.length ? `${cur}: ${items.slice(0, 8).join(', ')}` : null;
      }).filter(Boolean);
      const fundSection = fundLines.length > 0 ? [
        '', '=== LATEST MACRO FUNDAMENTALS (from headline releases — use as objective anchor) ===',
        fundLines.join('\n'),
        '(If fundamentals contradict headline sentiment: fundamentals may change the DIRECTION of the bias, not just lower confidence — actual data is more objective than headline tone.)',
      ].join('\n') : '';
      const biasPrompt = [
        'You are a central bank policy analyst. Based on the following recent financial news headlines AND the latest macro fundamental data, assess the current monetary policy stance for each central bank mentioned.',
        priorStanceSection,
        '- Hawkish/dovish is RELATIVE to the prior stance and market expectations. If a headline only CONFIRMS the prior stance, keep the prior bias and do NOT raise confidence. Only shift the bias when there is a clear NEW signal (rate change, guidance change, data surprise).',
        '', 'Headlines (sorted NEWEST first — #1 is most recent; weight recent signals higher, do not average in stale commentary already overtaken by newer data):', biasHeadlines, fundSection, '',
        'For each of these currencies that have relevant headlines: ' + biasCurrencies, '',
        '- Ignore headlines that ONLY report currency price action (e.g. "Yen falls to 161"). Judge stance ONLY from: CB official communication, rate decisions/signals, inflation/employment releases, or meeting minutes.',
        'Return ONLY a valid JSON object. No explanation, no markdown, no code block. Just the raw JSON.',
        'Use ONLY these exact bias values: "Hawkish", "Cautious Hawkish", "Neutral", "Data Dependent", "On Hold", "Cautious Dovish", "Dovish", "Split"',
        '  "Data Dependent" = CB explicitly defers direction, waiting on data (NOT hawkish/dovish — conditional neutral).',
        '  "On Hold" = rate held with no clear signal on the next move.',
        '  "Split" = MPC/governing council is divided (significant dissent vote).',
        'For confidence, use ONLY: "High", "Medium", "Low"',
        '  High = multiple clear, direct signals from officials or data releases',
        '  Medium = some signals but mixed or indirect',
        '  Low = minimal or ambiguous evidence — prefer omitting the currency over Low confidence', '',
        'Example format:', '{"USD":{"bias":"Cautious Hawkish","confidence":"High"},"EUR":{"bias":"Dovish","confidence":"Medium"}}', '',
        'Only include currencies where you have enough evidence. If insufficient evidence for a currency, OMIT it entirely — do not guess.',
      ].join('\n');
      const call2Messages = [{ role: 'user', content: biasPrompt }];
      let biasRaw = null;
      if (SAMBANOVA_KEY && await cb.canCall(CB_SAMBA_MAIN)) {
        try {
          console.log('Call 2: trying SambaNova');
          biasRaw = await aiCall(SAMBANOVA_URL, SAMBANOVA_KEY, SAMBANOVA_MODEL, call2Messages, 700, 0.1, 8000);
          console.log('Call 2: SambaNova OK');
          await cb.onSuccess(CB_SAMBA_MAIN);
        } catch(e) { console.warn('Call 2 SambaNova failed:', e.status || e.message); await cb.onFailure(CB_SAMBA_MAIN, AI_CB_THRESHOLD); }
      } else if (SAMBANOVA_KEY) { console.log('Call 2: SambaNova circuit OPEN — skipping to Groq'); }
      if (!biasRaw && GROQ_KEY) {
        try {
          console.log('Call 2: falling back to Groq');
          biasRaw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, call2Messages, 700, 0.1, 12000);
          console.log('Call 2: Groq fallback OK');
        } catch(e) { console.warn('Call 2 Groq fallback failed:', e.status || e.message); }
      }
      if (biasRaw) {
        try {
          const clean = biasRaw.replace(/```json|```/g, '').trim();
          console.log('Call 2 bias raw:', biasRaw.substring(0, 300));
          const parsed = JSON.parse(clean);
          console.log('Call 2 bias parsed:', JSON.stringify(parsed));
          const VALID_BIASES = ['Hawkish','Cautious Hawkish','Neutral','Data Dependent','On Hold','Cautious Dovish','Dovish','Split'];
          // A1.5: hawk-dove magnitude is measured ONLY on this axis. "Data Dependent"/"On Hold"/"Split"
          // are orthogonal labels (not a degree of dovishness) — they map to 'Neutral' for magnitude
          // purposes so a Hawkish→On Hold transition isn't mistaken for a 4-level swing.
          const HAWK_DOVE_AXIS = ['Hawkish','Cautious Hawkish','Neutral','Cautious Dovish','Dovish'];
          const ORTHOGONAL_LABELS = new Set(['Data Dependent','On Hold','Split']);
          const VALID_CONFIDENCES = ['High','Medium','Low'];
          const VALID_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          // A1.6: AI may reply with different casing/whitespace — normalize before validating
          // instead of dropping an otherwise-valid signal on an exact-case mismatch.
          const BIAS_CANON = new Map(VALID_BIASES.map(b => [b.toLowerCase(), b]));
          const CONFIDENCE_CANON = new Map(VALID_CONFIDENCES.map(c => [c.toLowerCase(), c]));
          const now2 = new Date().toISOString();
          const lockAcquired = await redisCmd('SET', 'cb_bias_lock', '1', 'NX', 'EX', '10');
          if (lockAcquired) {
            let existing = {};
            try { const rawBias = await redisCmd('GET', 'cb_bias'); if (rawBias) existing = JSON.parse(rawBias); } catch(e) {}
            for (const [cur, entry] of Object.entries(parsed)) {
              const curOk = VALID_CURRENCIES.has(cur);
              const entryBias = (typeof entry === 'object' && entry !== null) ? entry.bias : entry;
              const confidenceRaw = (typeof entry === 'object' && entry !== null) ? entry.confidence : null;
              const bias = BIAS_CANON.get(String(entryBias).trim().toLowerCase());
              const confidence = CONFIDENCE_CANON.get(String(confidenceRaw).trim().toLowerCase());
              if (!curOk || !bias) continue;
              if (!confidence || confidence === 'Low') { console.log(`Call 2: skip ${cur} — confidence Low`); continue; }
              const prevEntry = existing[cur];
              const prevBias  = prevEntry?.bias;
              const kws = CB_KW[cur] || [];
              const sourceHeadlines = recentItems.filter(i => kws.some(kw => kwTest(i.title.toLowerCase(), kw))).slice(0, 5).map(i => i.title);
              // Magnitude check only applies when BOTH biases sit on the hawk-dove axis — a transition
              // to/from an orthogonal label (Data Dependent/On Hold/Split) never trips false divergence.
              const prevOnAxis = prevBias && !ORTHOGONAL_LABELS.has(prevBias) && HAWK_DOVE_AXIS.includes(prevBias);
              const newOnAxis  = !ORTHOGONAL_LABELS.has(bias) && HAWK_DOVE_AXIS.includes(bias);
              if (prevBias && confidence !== 'High' && prevOnAxis && newOnAxis) {
                const prevIdx = HAWK_DOVE_AXIS.indexOf(prevBias); const newIdx = HAWK_DOVE_AXIS.indexOf(bias);
                if (prevIdx !== -1 && newIdx !== -1 && Math.abs(newIdx - prevIdx) > 2) {
                  // Large swing but not High-confidence: keep the established bias rather than
                  // flip on ambiguous evidence, but surface a divergence warning instead of
                  // silently discarding the signal — downgrade displayed confidence to Low.
                  console.log(`Call 2: divergence ${cur} — ${prevBias}→${bias} (confidence ${confidence}), keeping prev bias + flagging`);
                  existing[cur] = {
                    ...prevEntry,
                    confidence: 'Low',
                    divergence_warning: { suggested_bias: bias, suggested_confidence: confidence, detected_at: now2, source_headlines: sourceHeadlines },
                  };
                  _biasUpdated.push(cur);
                  continue;
                }
              }
              existing[cur] = { bias, confidence, updated_at: now2, source_headlines: sourceHeadlines };
              _biasUpdated.push(cur);
            }
            if (_biasUpdated.length > 0) {
              const saveResult = await redisCmd('SET', 'cb_bias', JSON.stringify(existing));
              console.log('CB bias Redis SET result:', saveResult);
            }
            await redisCmd('DEL', 'cb_bias_lock').catch(()=>{});
          }
        } catch(e) { console.warn('Call 2 bias parse/save failed:', e.message); }
      }
    }
    return _biasUpdated;
  })() : Promise.resolve([]);

  const _call4Promise = ((SAMBANOVA_KEY || GROQ_KEY) && deviceId) ? (async () => {
    try {
      const ids4 = await redisCmd('ZRANGE', `journal_index:${deviceId}`, 0, -1, 'REV') || [];
      const openEntries = [];
      for (const id of ids4.slice(0, 10)) {
        try {
          const raw = await redisCmd('GET', `journal:${deviceId}:${id}`);
          if (!raw) continue;
          const entry = JSON.parse(raw);
          if (entry.status === 'open' && entry.thesis_text?.trim()) openEntries.push(entry);
          if (openEntries.length >= 5) break;
        } catch(e) {}
      }
      if (openEntries.length === 0) { console.log('Call 4: no open entries, skipping'); return null; }
      console.log('Call 4: checking', openEntries.length, 'open entries against headlines');
      const thesesBlock = openEntries.map((e, i) => `${i+1}. [ID:${e.id}] ${e.pair} ${(e.direction||'').toUpperCase()}: ${e.thesis_text}`).join('\n');
      const headlines30 = recentItems.slice(0, 30).map((h, i) => `${i+1}. ${h.title}`).join('\n');
      const monitorPrompt = [
        'You are a forex trade thesis monitor.', '',
        'Open trade theses:', thesesBlock, '', 'Recent headlines (newest first):', headlines30, '',
        'Check if ANY headline directly contradicts or significantly undermines the stated reason for ANY open thesis.',
        'Only flag genuine contradictions — news that directly opposes the trade direction rationale, not tangentially related news.',
        'Ignore price-level headlines; focus on fundamental basis changes (macro data, CB policy shifts, geopolitical reversals).', '',
        'Return ONLY valid JSON, no markdown, no explanation:',
        '{"alerts":[{"entry_id":"...","pair":"...","direction":"...","headline":"exact headline text","reason":"one sentence why this contradicts the thesis"}]}',
        'If no genuine contradictions found: {"alerts":[]}',
      ].join('\n');
      const call4Messages = [{ role: 'user', content: monitorPrompt }];
      let raw4 = null;
      // Primary: SambaNova DeepSeek-V3.2 (akun 1) — same model used for Call 2 & 3
      if (SAMBANOVA_KEY && await cb.canCall(CB_SAMBA_MAIN)) {
        try {
          console.log('Call 4: trying SambaNova');
          raw4 = await aiCall(SAMBANOVA_URL, SAMBANOVA_KEY, SAMBANOVA_MODEL, call4Messages, 700, 0.1, 8000);
          console.log('Call 4: SambaNova OK');
          await cb.onSuccess(CB_SAMBA_MAIN);
        } catch(e) {
          console.warn('Call 4 SambaNova failed:', e.status || e.message);
          await cb.onFailure(CB_SAMBA_MAIN, AI_CB_THRESHOLD);
        }
      }
      // Fallback: Groq llama-3.3-70b
      if (!raw4 && GROQ_KEY) {
        try {
          console.log('Call 4: falling back to Groq');
          raw4 = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, call4Messages, 700, 0.1, 8000);
          console.log('Call 4: Groq fallback OK');
        } catch(e) { console.warn('Call 4 Groq fallback failed:', e.status || e.message); }
      }
      if (!raw4) return null;
      const parsed4 = JSON.parse(raw4.replace(/```json|```/g, '').trim());
      if (!Array.isArray(parsed4.alerts)) return null;
      console.log('Call 4: found', parsed4.alerts.length, 'alert(s)');
      if (parsed4.alerts.length > 0) {
        redisCmd('SET', `thesis_alerts:${deviceId}`, JSON.stringify(parsed4.alerts), 'EX', 1800).catch(() => {});
      } else {
        redisCmd('DEL', `thesis_alerts:${deviceId}`).catch(() => {});
      }
      return parsed4.alerts;
    } catch(e) { console.warn('Call 4 Thesis Monitor failed:', e.message); return null; }
  })() : Promise.resolve(null);

  // ── 4. Call 1: Market Briefing — Cerebras → Groq fallback ────────────────────
  let article = null, method = 'fallback';
  const providerLog = [];
  if (recentItems.length > 0) {
    const DIGEST_SYSTEM_DEFAULT = `Kamu analis macro FX senior. Tulis briefing pre-session Bahasa Indonesia untuk trader Indonesia yang sudah fasih: DXY, real yield, carry, risk-on/off, basis point — jangan jelaskan istilah ini.

FORMAT OUTPUT:
- Prosa mengalir. Tanpa bullet, heading, bold, emoji.
- Dua bagian: (1) bagian FX, (2) bagian XAUUSD diawali tepat "XAUUSD:" (baris baru, tanpa spasi sebelum tanda titik dua).
- Mulai LANGSUNG dengan fakta paling spesifik yang market-moving dari headline. DILARANG KERAS membuka dengan: "Pagi ini", "Hari ini", "Sesi ini", "Flow berita", "Pasar hari ini", "Dalam konteks ini", "Minggu ini", atau kalimat konteks/ringkasan apapun. Kalimat pertama harus menyebut nama pejabat, angka spesifik, atau pair FX konkret (USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF — BUKAN XAU/emas/gold).
- Target panjang: bagian FX 4-7 kalimat, bagian XAUUSD 4-6 kalimat (kecuali sinyal tipis, lihat ATURAN XAUUSD). Ini batas lunak untuk menjaga fokus — jangan memotong fakta penting demi memenuhi angka ini, tapi jangan juga menumpuk tema lepas hanya untuk memenuhi panjang.

FRASA TERLARANG — periksa output sebelum kirim, tidak ada pengecualian:
dapat mempengaruhi · dapat memberikan · dapat berdampak · perlu dicermati · patut diwaspadai · tergantung data · masih akan volatile · menjadi fokus · trader harus berhati-hati · sentimen mixed · berpotensi menggerakkan · berpotensi mempengaruhi · dapat menekan · memberikan tekanan · memberikan dorongan · perlu diperhatikan · akan terus dipantau · seiring dengan · sejalan dengan · di tengah · memberikan gambaran · masih dalam ketidakpastian · mencermati · cukup padat · perkembangan ini · hal ini · dalam beberapa jam ke depan (tanpa spesifik) · berdampak pada pasar

TES WAJIB TIAP KALIMAT: Bisakah kalimat ini ditulis tanpa membaca headlines hari ini? Kalau ya → hapus.

ATURAN FX:
PENTING: Bagian FX adalah KHUSUS untuk analisa FX pair dan USD. DILARANG KERAS membahas XAU, emas, gold, bullion, atau harga emas di bagian ini — semua gold content masuk ke bagian XAUUSD. Kalau hari ini yang paling market-moving adalah gold, tetap buka dengan dampaknya ke FX pairs (misal: "Kenaikan tajam XAU memicu risk-off, mengangkat JPY dan CHF vs USD") — bukan membahas gold itu sendiri.
ANTI-HALLUCINATION: Jangan gabungkan dua headline berbeda menjadi satu klaim baru yang tidak ada di headline aslinya. Jika headline A menyebut X dan headline B menyebut Y, jangan tulis "X berkoordinasi dengan Y" kecuali kalimat itu memang ada di salah satu headline.

PENDEKATAN BENANG MERAH FX — ikuti urutan ini, JANGAN tulis tema-tema sebagai paragraf lepas yang ditumpuk:
1. JANGKAR TEMA: Tentukan SATU tema paling market-moving hari ini (CB tertentu, data rilis, atau divergence currency tertentu). Ini titik awal narasi.
2. RAJUT TEMA: Tema lain HARUS dikaitkan ke tema utama lewat driver bersama yang eksplisit — paling sering USD (DXY arah, real yield, rate path Fed) atau risk sentiment global. Pakai konektor sebab-akibat ("ini berbarengan dengan...", "di sisi lain, ... juga bergerak karena driver yang sama/berlawanan") — JANGAN mulai kalimat baru dengan currency lain tanpa menjelaskan kaitannya ke tema sebelumnya.
3. Kalau tema-tema benar-benar tidak berkaitan (misal CB Asia vs data AS, tidak ada irisan driver) — boleh dipisah, tapi maksimal 2 tema independen per output. Tema ketiga ke bawah yang tidak terkait → skip, sebut hanya jika punya magnitude kuat. Tema dengan kaitan kausal lemah/tidak langsung (mis. ekuitas regional sebagai proksi sentimen currency) — SKIP, kecuali magnitude-nya jelas kuat dan disebut dengan mekanisme konkret. Jangan masukkan tema hanya untuk menambah panjang.
4. Continuity DIJALIN ke tema yang relevan, bukan ditulis sebagai kalimat penutup terpisah yang tidak terhubung dengan paragraf sebelumnya (misal: "...berlanjut dari pola sesi sebelumnya" disisipkan langsung setelah klaim terkait, bukan kalimat baru berdiri sendiri).
5. Penutup FX menyimpulkan dari benang merah yang sudah dibangun, bukan currency baru yang belum disebut di paragraf sebelumnya.
6. LABEL TOPIK (navigasi visual untuk pembaca — BUKAN pengganti konektor di poin 2, keduanya WAJIB ada bersamaan): setiap kali fokus bergeser ke currency/tema baru, sisipkan tag PERSIS sebelum kalimat itu dengan format {{TAG: NAMA}}.
   - WAJIB tag SETIAP currency yang dibahas dengan klaim/mekanisme sendiri (punya alasan/data sendiri kenapa bergerak) — bukan cuma yang numpang disebut di kalimat currency lain. EUR, AUD/CAD, USD/JPY di contoh ini cuma CONTOH FORMAT, BUKAN daftar lengkap — currency lain (JPY, CHF, GBP, NZD, dst) yang dibahas dengan alasannya sendiri WAJIB dapat tag sendiri juga, pakai nama currency itu sendiri sebagai NAMA tag. JANGAN gabungkan currency yang tidak berhubungan langsung ke tag currency lain hanya karena disebut di paragraf yang sama — kalau JPY/CHF dibahas sebagai mekanisme safe-haven yang berdiri sendiri, beri tag {{TAG: JPY/CHF}} sendiri, jangan dibiarkan menyatu tanpa tag di bawah tag currency sebelumnya.
   - Kalimat jangkar (tema utama/pembuka) TETAP tanpa tag — itu titik awal narasi, bukan pergeseran tema.
   - Kalimat penutup (kesimpulan kekuatan mata uang, TEPAT SATU currency kuat + TEPAT SATU currency lemah) WAJIB diberi tag {{TAG: Konfirmasi}} — JANGAN biarkan menyatu tanpa jeda ke paragraf tema currency sebelumnya, ini harus jadi blok tersendiri.
   - Tag ini beda dari format kalender "[EVENT] (CURRENCY) [TIME]" di bawah — jangan tertukar formatnya, dan jangan sampai menghapus kalimat konektor sebab-akibat yang sudah diwajibkan hanya karena sudah ada tag.

DETAIL PER TEMA (terapkan ke tema yang lolos seleksi di atas):
Klaim: Sebut nama pejabat, angka, atau pair spesifik dari headline. Tidak ada? Skip tema itu sepenuhnya.
Mekanisme: Jalur transmisi konkret (rate differential, real yield gap, risk channel, flow). Bukan "berdampak ke pair X" — sebutkan via mekanisme apa.
Magnitude: Kuat atau marginal. Marginal harus disebut marginal.
Teknikal: Jika blok PRICE ACTION pair tersedia, sisipkan konteks trend (uptrend/downtrend/sideways), level support/resistance terdekat, atau swing high/low dalam satu kalimat natural — terutama untuk pair yang paling relevan dengan tema fundamental yang dibahas. Jika blok TEKNIKAL pair tersedia juga (RSI/SMA), sisipkan singkat sebagai penguat (misal: "RSI 28 oversold, konsisten dengan tekanan jual yang sudah berlebihan"). Bukan paragraf analisa teknikal terpisah, cukup penguat konteks.
Rate Differential: Kalau tema menyangkut ekspektasi kebijakan Fed/CB lain, gunakan data RATE PATH (bps cut/hike yang sudah di-price market) sebagai angka konkret — bukan "diperkirakan akan menurunkan suku bunga", tapi "market sudah price-in X bps cut dalam 3 bulan". Kalau data tidak tersedia, boleh infer dari headline tapi jangan klaim angka pasti.
Risk Sentiment: Kalau tema melibatkan risk-on/risk-off (safe haven flow, JPY/CHF strength, dst), rujuk data RISK REGIME (VIX/MOVE/HY) sebagai bukti konkret, bukan asumsi dari judul berita saja. VIX/MOVE naik tajam = konfirmasi risk-off nyata, bukan cuma persepsi. VIX/MOVE rendah dan stabil = risk-off di headline kemungkinan overstated, sebut ini sebagai konflik kalau relevan.
Positioning: Jika blok SKEW OPSI FX tersedia untuk pair yang dibahas, sisipkan singkat sebagai konfirmasi atau kontradiksi terhadap arah fundamental (misal: "skew EUR/USD masih put-skewed, menunjukkan positioning belum mengikuti pelemahan dolar ini" — sinyal potensi reversal/catch-up). Positioning/skew adalah KONFIRMASI atau KONTRADIKSI, BUKAN jangkar arah. Jangan buka analisa pair dengan positioning. Kalau fundamental (data rilis) atau level teknikal (resistance/support kuat) berlawanan dengan positioning, sebut ketegangan itu eksplisit dan timbang mana lebih berat — jangan diam-diam ikut positioning.
Konflik: Dua signal berlawanan dalam satu tema? Sebut keduanya, putuskan mana lebih berat, jelaskan kenapa.
Kalender: Hanya event dengan asymmetri beat/miss jelas. Untuk setiap event yang dianalisis, gunakan format prosa ini persis: "[EVENT] ([CURRENCY]) [TIME WIB] — jika beat: [pair] [naik/turun] karena [mekanisme konkret]; jika miss: [pair] [naik/turun] karena [mekanisme konkret]." Event tanpa edge antisipatif → skip sepenuhnya, jangan disebutkan. WAJIB: tiap event kalender sudah punya tag "[SUDAH RILIS X lalu]" atau "[AKAN RILIS dalam X]" di blok KALENDER EKONOMI — PAKAI TAG ITU APA ADANYA untuk menentukan tense ("tadi pagi", "nanti", "besok"), JANGAN hitung sendiri dari tanggal/jam mentah (rawan salah). Event yang ber-tag "SUDAH RILIS" tidak boleh disebut "akan datang"/"besok" — kalau actual-nya belum diketahui dari headline, sebut sebagai "hasil belum tercermin di headline" bukan menebak arah.
Pejabat CB: Hanya analisa jika menyentuh rate path, balance sheet, atau inflation framework. Non-policy → sebut sekali "tidak ada sinyal kebijakan dari [nama]" lalu lanjut.
Penutup FX: Satu kalimat menyimpulkan kekuatan mata uang hari ini (HANYA pilih dari 8 majors: USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF). Kalau ada SATU currency yang jelas paling kuat dan SATU yang paling lemah tanpa kontradiksi — sebut TEPAT SATU di tiap sisi, dengan alasan spesifik dari headline. Kalau buktinya genuinely campuran (misal USD kuat vs satu currency tapi lemah vs currency lain) — JANGAN dipaksa pilih satu pemenang palsu, sebut eksplisit sebagai "sinyal campuran" dan jelaskan singkat kenapa (kuat vs siapa, lemah vs siapa). Currency paling lemah/rentan tetap WAJIB disebut kalau buktinya jelas, dengan alasan spesifik dari headline — jangan jatuh ke "pasar volatile" generik tanpa alasan, baik di skenario satu pemenang maupun campuran.

ATURAN XAUUSD (paragraf baru, mulai tepat "XAUUSD:"):
Trader gold baca ini standalone — harus self-contained.
Gunakan HANYA headline dari blok HEADLINE RELEVAN XAUUSD di bawah.
< 3 headline substantif → buka "Sinyal gold tipis" dan persingkat ke 2-3 kalimat saja.
ANTI-HALLUCINATION: Jangan gabungkan dua headline berbeda menjadi satu klaim baru yang tidak ada di headline aslinya. Jika headline A menyebut X dan headline B menyebut Y, jangan tulis "X berkoordinasi dengan Y" kecuali kalimat itu memang ada di salah satu headline.

PENDEKATAN BENANG MERAH — ikuti urutan ini:
1. JANGKAR HARGA: Jika blok HARGA XAU/USD LIVE tersedia, buka dengan harga dan pergerakan hari ini (naik/turun berapa persen). Ini titik awal narasi — semua fakta berikutnya menjelaskan MENGAPA harga ada di sini.
2. RAJUT FAKTA: Hubungkan harga → headline → real yield → geopolitik secara natural, seperti analis yang bercerita. Tidak perlu rantai kausal formal. Cukup: "kenaikan ini didukung oleh X, meski dibatasi oleh Y." Fakta yang saling memperkuat → gabungkan. Fakta yang berlawanan → sebut keduanya, putuskan mana lebih berat dalam satu kalimat. Jika blok TEKNIKAL XAU tersedia, sisipkan RSI dan posisi vs SMA dalam satu kalimat natural sebagai konteks teknikal pendukung (misal: "secara teknikal harga masih di atas SMA 50 dengan RSI 45 di zona netral") — bukan paragraf terpisah.
3. REAL YIELD sebagai pembatas: Jika real yield > 2%, emas mahal secara struktural — wajib disebut sebagai rem, bukan diabaikan. Tapi jika harga tetap naik meski yield tinggi, artinya tekanan bullish cukup kuat untuk offset — nyatakan ini secara eksplisit. Kalau harga emas naik/bertahan tinggi PADAHAL real yield juga tinggi (hubungan invers normal melemah), sebut eksplisit sebagai sinyal regime: driver emas sedang BUKAN real yield (kemungkinan CB buying / debasement / safe-haven struktural). Jangan cuma sebut "dibatasi yield" lalu lanjut.
4. TIDAK ADA RANTAI KAUSAL WAJIB: Untuk geopolitik minyak (Iran, Hormuz, OPEC) — tidak perlu trace oil→inflasi→Fed→yield secara kaku. Cukup: apakah ada bukti di headline bahwa ini mempengaruhi XAU? Jika ya, sebut. Jika tidak, skip.
5. RISK REGIME sebagai konfirmasi safe-haven: Jika blok RISK REGIME tersedia, gunakan VIX/MOVE sebagai bukti konkret bahwa demand safe-haven nyata (bukan cuma narasi geopolitik tanpa data). Regime "risk_off" + harga naik = haven demand terkonfirmasi data. Regime "risk_on" tapi harga tetap naik = driver bukan safe-haven, harus dijelaskan via mekanisme lain (real yield turun, CB buying, dst).
6. KORELASI sebagai cek silang: Jika blok KORELASI tersedia dan ada anomali (misal Gold-DXY yang biasanya negatif kuat tapi sekarang melemah), sebut ini sebagai sinyal regime berubah — satu kalimat saja, jangan jelaskan matematika korelasinya.
7. POSITIONING: Jika blok SKEW OPSI XAU tersedia, sisipkan sebagai konfirmasi/kontradiksi arah (call-skewed = positioning sudah bullish, jadi rally lanjutan butuh trigger baru; put-skewed saat harga naik = skeptisisme market, potensi short squeeze). Kalau menyebut positioning crowded sebagai risiko reversal, WAJIB sertakan mekanismenya dalam kalimat yang sama (mis. "long sudah ramai, jadi kalau support X jebol, likuidasi posisi itu sendiri jadi bahan bakar penurunan") — jangan tinggalkan sebagai lompatan logika.
8. Driver sama dengan sesi sebelumnya → nyatakan eksplisit, itu informasi valid.
9. LABEL TOPIK (navigasi visual, BUKAN pengganti rangkaian fakta di poin 2 — keduanya WAJIB ada bersamaan): setiap kali masuk ke sub-angle baru di luar JANGKAR HARGA awal, sisipkan tag PERSIS sebelum kalimat itu dengan format {{TAG: NAMA}}. Korelasi, Geopolitik, Positioning di sini cuma CONTOH FORMAT, BUKAN daftar lengkap — sub-angle lain (Risk Regime, Rate Differential, ETF Flow, CB Buying, dst, apa pun yang punya klaim/mekanisme sendiri) WAJIB dapat tag sendiri juga dengan nama yang sesuai, jangan dibiarkan menyatu tanpa tag di bawah sub-angle sebelumnya hanya karena tidak ada di contoh. Jangan beri tag pada kalimat jangkar harga (pembuka). Tag ini beda dari format trigger kalender "[EVENT] [TIME WIB]" di bawah — jangan tertukar formatnya.

TRIGGER TERDEKAT 24 JAM: Pilih event dari kalender dengan PRIORITAS TERTINGGI: (1) FOMC/Fed — Minutes, pidato Powell, rate decision; (2) US data — CPI, NFP, GDP; (3) event major currency lain. Format wajib: "[EVENT] [TIME WIB] — jika [outcome]: tekanan [bullish/bearish] XAU karena [mekanisme]; jika [outcome berlawanan]: tekanan [bullish/bearish] XAU karena [mekanisme]." Harus ada DUA skenario. Jika tidak ada event kalender relevan untuk XAU dalam 24 jam, tulis "Tidak ada trigger kalender untuk XAU dalam 24 jam ke depan."

CEK AKHIR SEBELUM KIRIM: (1) Ganti semua "dapat mempengaruhi/berpotensi/mungkin/dalam beberapa jam ke depan" dengan pernyataan tegas berbasis data. (2) Penutup FX: tepat satu currency kuat + tepat satu lemah — ATAU nyatakan eksplisit "sinyal campuran" dengan menjelaskan kuat-vs-siapa dan lemah-vs-siapa. Baris "dan X juga" tanpa penjelasan campuran = salah.`;

    function isValidDigestPrompt(p) {
      if (typeof p !== 'string') return false;
      const t = p.trim();
      if (t.length < 1000) return false;
      if (!t.includes('XAUUSD')) return false;
      if (!t.includes('ATURAN FX')) return false;
      return true;
    }
    if (promptDigestInstr && !isValidDigestPrompt(promptDigestInstr)) {
      console.warn('prompt_digest override invalid (too short / missing markers) — using DIGEST_SYSTEM_DEFAULT');
    }
    const digestSystemMsg = isValidDigestPrompt(promptDigestInstr) ? promptDigestInstr : DIGEST_SYSTEM_DEFAULT;
    const digestUserMsg = `PENTING: TULIS SELURUH OUTPUT DALAM BAHASA INDONESIA. JANGAN GUNAKAN BAHASA INGGRIS SAMA SEKALI.
WAKTU: ${dayStr}, ${dateStr}, ${timeStr}${weekendNote}

=== HARGA XAU/USD LIVE (jangkar harga — gunakan sebagai titik awal narasi) ===
${xauSpotBlock}

=== TEKNIKAL XAU/USD DAILY (dari Yahoo GC=F — sebutkan singkat dalam 1 kalimat sebagai konteks, bukan analisa teknikal terpisah) ===
${xauTaBlock}

=== PRICE ACTION XAU/USD (Daily/4H/1H — identifikasi trend makro, swing, dan level entry/invalidation) ===
${xauOhlcvBlock || '(Cache OHLCV belum tersedia — ohlcv_sync cron belum berjalan. Abaikan bagian ini.)'}

=== PRICE ACTION ${fxOhlcvLabel} (Daily/4H/1H — context teknikal multi-timeframe untuk pair FX rekomendasi) ===
${fxOhlcvBlock || '(Cache OHLCV belum tersedia untuk pair ini.)'}

=== TEKNIKAL ${fxOhlcvLabel} DAILY (RSI/SMA — sebutkan singkat sebagai penguat konteks) ===
${fxTaBlock}

=== DATA REAL YIELD USD (LIVE — gunakan ini, jangan inferensi dari headline) ===
${realYieldBlock}

=== RISK REGIME GLOBAL (VIX/MOVE/HY — ground-truth untuk klaim risk-on/risk-off, jangan asumsi dari judul berita saja) ===
${riskRegimeBlock}

=== RATE PATH USD (market-implied dari Fed Funds futures — angka konkret untuk mekanisme rate differential) ===
${ratePathBlock}

CATATAN STALENESS: Blok REAL YIELD/RISK REGIME/RATE PATH di atas di-cache (TTL menit-jam), bisa sedikit basi. Kalau ada headline yang JELAS lebih baru dan bertentangan dengan angka di blok itu (misal yield spike besar baru saja, VIX melonjak tajam yang belum tercermin di RISK REGIME) — sebut konflik itu eksplisit dan beri bobot lebih ke sinyal yang lebih segar, jangan diam-diam pilih salah satu tanpa penjelasan.

=== KORELASI CROSS-ASSET (anomali = sinyal regime berubah, gunakan sebagai cek silang) ===
${correlationBlock}

=== SKEW OPSI FX/XAU 25-delta (positioning institusional — confirm/contradict arah fundamental) ===
${riskReversalBlock}

=== HEADLINE BERITA TERKINI (${headlinesForBriefing.length} dari ${recentItems.length} berita, 36 jam terakhir) ===
${headlinesBlock}

=== HEADLINE RELEVAN XAUUSD (${goldItems.length} dari ${recentItems.length} berita, 36 jam, difilter) ===
${goldBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

=== RINGKASAN SESI SEBELUMNYA (FX) ===
${historyBlock}

=== RIWAYAT XAUUSD SESI SEBELUMNYA (4 sesi terakhir) ===
${xauHistoryBlock}`;

    const call1Messages = [
      { role: 'system', content: digestSystemMsg },
      { role: 'user', content: digestUserMsg },
    ];

    // Primary: SambaNova DeepSeek-V3.2 (akun 2, Call 1 prose only) — circuit breaker
    if (SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1)) {
      const t1s = Date.now();
      try {
        console.log('Call 1: trying SambaNova DeepSeek-V3.2 (akun 2 prose)');
        const raw = await aiCall(SAMBANOVA_URL_CALL1, SAMBANOVA_KEY_CALL1, SAMBANOVA_MODEL_CALL1, call1Messages, 1300, 0.25, 22000);
        const elapsed = Date.now() - t1s;
        if (raw.trim()) {
          article = raw.trim(); method = 'deepseek-v3.2';
          providerLog.push(`sambanova:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`sambanova:empty(${elapsed}ms)`);
        }
        console.log('Call 1: SambaNova V3.2 OK, length', article?.length);
        await cb.onSuccess(CB_SAMBA_C1);
      } catch(e) {
        const elapsed = Date.now() - t1s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`sambanova:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 SambaNova V3.2 failed:', e.status || e.message);
        await cb.onFailure(CB_SAMBA_C1, AI_CB_THRESHOLD);
      }
    } else if (SAMBANOVA_KEY_CALL1) {
      providerLog.push('sambanova:circuit_open');
      console.log('Call 1: SambaNova circuit OPEN — skipping to OpenRouter');
    } else {
      providerLog.push('sambanova:no_key');
    }

    // Fallback 2: OpenRouter gpt-oss-120b (if SambaNova failed/empty)
    if (!article && OPENROUTER_KEY) {
      const t2s = Date.now();
      try {
        console.log('Call 1: fallback 2 to OpenRouter gpt-oss-120b:free');
        const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, OPENROUTER_MODEL, call1Messages, 1300, 0.25, 15000, OPENROUTER_HEADERS);
        const elapsed = Date.now() - t2s;
        if (raw.trim()) {
          article = raw.trim(); method = 'gpt-oss-120b';
          providerLog.push(`openrouter:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`openrouter:empty(${elapsed}ms)`);
        }
        console.log('Call 1: OpenRouter OK, length', article?.length);
      } catch(e) {
        const elapsed = Date.now() - t2s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`openrouter:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 OpenRouter fallback failed:', e.status || e.message);
      }
    } else if (!article) {
      providerLog.push('openrouter:no_key');
    }

    // Fallback 3: Groq qwen3-32b (if OpenRouter failed/empty)
    if (!article && GROQ_KEY) {
      const t3s = Date.now();
      try {
        console.log('Call 1: fallback 3 to Groq qwen3-32b');
        const raw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL_PROSE, call1Messages, 1300, 0.25, 15000);
        const elapsed = Date.now() - t3s;
        if (raw.trim()) {
          article = raw.trim(); method = 'qwen3-32b';
          providerLog.push(`groq_qwen3:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`groq_qwen3:empty(${elapsed}ms)`);
        }
        console.log('Call 1: Groq qwen3 OK, length', article?.length);
      } catch(e) {
        const elapsed = Date.now() - t3s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`groq_qwen3:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 Groq qwen3 fallback failed:', e.status || e.message);
      }
    } else if (!article) {
      providerLog.push('groq_qwen3:no_key');
    }

    if (!article) method = 'fallback';
  } else {
    method = 'fallback';
  }

  // ── 5. Manual fallback (no AI) ────────────────────────────────────────────────
  if (!article) {
    method = 'fallback';
    if (recentItems.length === 0) {
      article = 'Tidak ada berita baru dalam 36 jam terakhir.';
    } else {
      const catGroups = {};
      recentItems.forEach(i => { const c=detectCat(i.title); if(!catGroups[c])catGroups[c]=[]; catGroups[c].push(i.title); });
      const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
      const CAT_ID = { 'market-moving':'Penggerak utama pasar','macro':'Dari sisi kebijakan moneter','energy':'Di sektor energi','geopolitical':'Dari sisi geopolitik','forex':'Pada pasar valuta asing','econ-data':'Data ekonomi menunjukkan','equities':'Pasar saham mencatat','commodities':'Di pasar komoditas','bonds':'Pasar obligasi' };
      const parts = [];
      for (const cat of priority) { if (catGroups[cat]?.length > 0 && parts.length < 3) parts.push(`${CAT_ID[cat]||cat}: ${catGroups[cat][0].toLowerCase()}.`); }
      const calPart = calEvents.length > 0 ? `Event high-impact terdekat adalah ${calEvents[0].event} (${calEvents[0].currency}) pada ${calEvents[0].time_wib}, ${calEvents[0].date}.` : 'Tidak ada event high-impact terjadwal.';
      article = parts.join(' ') + '\n\n' + calPart;
    }
  }

  // ── 5a. Safety net: kalimat penutup FX selalu ditag {{TAG: Konfirmasi}} ──────
  // AI nggak selalu comply instruksi "WAJIB tag kalimat penutup" (terbukti di test
  // live — kadang nempel tanpa tag di paragraf currency sebelumnya). Daripada cuma
  // gantungin ke prompt compliance, pastikan juga di kode: kalimat penutup FX itu
  // by design SELALU ada (instruksi "Penutup FX" di atas wajib menghasilkan satu
  // kalimat kuat/lemah currency) dan SELALU jadi kalimat terakhir sebelum marker
  // "XAUUSD:" — jadi aman ditandai di sini kalau AI lupa nge-tag sendiri.
  function _ensureConfirmasiTag(text) {
    if (!text) return text;
    const xauIdx = text.indexOf('XAUUSD:');
    const fxPart = xauIdx === -1 ? text : text.slice(0, xauIdx);
    if (fxPart.includes('{{TAG:')) {
      if (fxPart.includes('{{TAG: Konfirmasi}}')) return text; // AI sudah comply
      // AI sudah pakai tag untuk topik lain tapi lupa di penutup — tetap cari batas
      // kalimat terakhir di bawah, jangan skip cuma karena ada tag lain.
    }
    // Batas kalimat: titik diikuti spasi+huruf besar — pola ini sengaja menghindari
    // angka desimal ("2.32%") karena tidak diikuti spasi+huruf besar.
    const sentenceBoundary = /\.\s+(?=[A-Z])/g;
    let lastIdx = -1, m;
    while ((m = sentenceBoundary.exec(fxPart)) !== null) lastIdx = m.index + m[0].length;
    if (lastIdx === -1) return text; // cuma 1 kalimat atau pola nggak ketemu, jangan dipaksa
    return text.slice(0, lastIdx) + '{{TAG: Konfirmasi}} ' + text.slice(lastIdx);
  }
  // QUAL-11: Opening sentence validation — the prompt forbids these openers but code
  // didn't enforce it; now we log a warning so quality issues surface in server logs.
  const FORBIDDEN_OPENERS = [
    'pagi ini', 'hari ini', 'sesi ini', 'flow berita', 'pasar hari ini',
    'dalam konteks ini', 'minggu ini', 'dalam sesi', 'berita utama',
  ];
  let phraseHits = [];
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    article = _ensureConfirmasiTag(article);
    // C8: Deteksi frasa terlarang yang lolos dari instruksi prompt (observability — tidak auto-edit)
    const lowerArt = article.toLowerCase();
    phraseHits = FORBIDDEN_PHRASES.filter(p => lowerArt.includes(p));
    if (phraseHits.length > 0) {
      console.warn('Call 1 forbidden phrases leaked:', phraseHits.join(', '));
      providerLog.push(`forbidden:${phraseHits.length}`);
    }
    // QUAL-11: Check if article opens with a forbidden opener
    const firstSentence = article.slice(0, 80).toLowerCase();
    const badOpener = FORBIDDEN_OPENERS.find(o => firstSentence.startsWith(o));
    if (badOpener) {
      console.warn(`Call 1 forbidden opener: "${badOpener}" — prompt compliance failure`);
      providerLog.push(`bad_opener:${badOpener}`);
    }
  }

  // ── 5b. Save digest + xau history (parallel) ──
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    try {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wibStr = `${String(wibNow.getUTCDate()).padStart(2,'0')} ${MONTHS[wibNow.getUTCMonth()]} ${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

      // FX digest history — first 700 chars (FX section)
      const xauIdx = article.indexOf('XAUUSD:');
      const fxSummary = (xauIdx > 0 ? article.slice(0, xauIdx) : article).replace(/\n/g, ' ').slice(0, 700);
      const fxEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, summary: fxSummary });

      // XAU-specific history — extract XAUUSD paragraph only
      const xauParagraph = xauIdx !== -1 ? article.slice(xauIdx, xauIdx + 600).replace(/\n/g, ' ') : null;
      const saves = [
        redisCmd('LPUSH', 'digest_history', fxEntry).then(() => redisCmd('LTRIM', 'digest_history', 0, 6)),
      ];
      // Only save XAU history when gold headlines are substantive — prevents hallucinated
      // thin-day analysis from polluting future sessions via xauHistoryBlock continuity prompt
      if (xauParagraph && goldItems.length >= 3) {
        const xauEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, xau_summary: xauParagraph });
        saves.push(redisCmd('LPUSH', 'xau_history', xauEntry).then(() => redisCmd('LTRIM', 'xau_history', 0, 3)));
      } else if (xauParagraph) {
        console.log(`XAU history skipped — goldItems ${goldItems.length} < 3, output unreliable`);
      }
      await Promise.all(saves);
      console.log('Digest + XAU history saved');
    } catch(e) { console.warn('Digest history save failed:', e.message); }
  }

  // ── 6. Await Call 2 (ran concurrently with Call 1) ───────────────────────────
  const biasUpdated = await _biasPromise;

  // ── 7. Call 3: Structured Trade Thesis — SambaNova → Groq fallback ───────────
  let thesis = null;
  const elapsedBeforeCall3 = Date.now() - handlerStart;
  const CALL3_BUDGET_MS = 50000; // sisakan ~10s headroom dari maxDuration 60s
  if (elapsedBeforeCall3 > CALL3_BUDGET_MS) {
    console.warn(`Call 3 skipped — time budget exhausted (${elapsedBeforeCall3}ms elapsed)`);
    // thesis tetap null → UI sajikan latest_thesis lama dari Redis (tak fatal)
  } else if (recentItems.length > 0 && article) {
    const cbSummary = biasUpdated.length > 0
      ? `CB biases just updated for: ${biasUpdated.join(', ')}`
      : 'CB biases unchanged this cycle';
    const xauSectionMatch = article.indexOf('XAUUSD:');
    const xauSection = xauSectionMatch !== -1 ? article.slice(xauSectionMatch, xauSectionMatch + 700) : '';
    const briefingForThesis = article.slice(0, 900) + (xauSection && xauSectionMatch > 900 ? '\n\n' + xauSection : '');
    const goldHeadlinesForThesis = goldItems.slice(0, 15).map((i, idx) => `${idx + 1}. ${i.title}`).join('\n') || '(none)';
    const rawHeadlinesForThesis = headlinesForBriefing.slice(0, 15).map((h, i) => `${i + 1}. ${h.title}`).join('\n');

    const thesisPrompt = [
      'You are a macro FX and gold strategist. Based on the market context below, output a structured JSON with both an FX trade thesis and an XAU/USD fundamental thesis.',
      '',
      `Market briefing (current session): ${briefingForThesis}`,
      '',
      `Top headlines (raw, newest first — use as the factual anchor):\n${rawHeadlinesForThesis}`,
      '',
      'If the prose briefing above appears to contradict these raw headlines, prioritise the raw headlines — the briefing is a derived summary and may compress or distort.',
      '',
      cbSummary,
      '',
      `Upcoming high-impact calendar events (next 3 days, WIB): ${calBlock}`,
      '',
      `Gold-relevant headlines: ${goldHeadlinesForThesis}`,
      '',
      xauOhlcvBlock ? `XAU/USD multi-TF price context (use for precise entry, target, invalidation):\n${xauOhlcvBlock.split('\n').slice(1, 8).join('\n')}` : '',
      fxOhlcvBlock  ? `${fxOhlcvLabel} multi-TF price context:\n${fxOhlcvBlock.split('\n').slice(1, 8).join('\n')}`  : '',
      '',
      `Risk regime (VIX/MOVE/HY, ground-truth — use this to set dominant_regime, do not infer purely from headlines): ${riskRegimeBlock}`,
      `Rate path (market-implied Fed Funds, bps priced): ${ratePathBlock}`,
      `Cross-asset correlation anomalies (regime-break signal): ${correlationBlock}`,
      `FX/XAU options skew (25-delta risk reversal, institutional positioning): ${riskReversalBlock}`,
      xauTa ? `XAU daily TA: ${xauTaBlock}` : '',
      fxTa  ? `${fxOhlcvLabel} daily TA: ${fxTaBlock}` : '',
      '',
      'Return ONLY valid JSON with this exact schema (no markdown, no explanation):',
      '{',
      '  "dominant_regime": "risk_on" | "risk_off" | "neutral",',
      '  "strongest_currency": "USD",',
      '  "weakest_currency": "JPY",',
      '  "pair_recommendation": "USD/JPY",',
      '  "direction": "long" | "short" | "no_trade",',
      '  "confidence_1_to_5": 3,',
      '  "invalidation_condition": "string, in Bahasa Indonesia",',
      '  "time_horizon_days": 5,',
      '  "catalyst_dependency": "string, in Bahasa Indonesia",',
      '  "xau_bias": "bullish" | "bearish" | "neutral" | "conflicting",',
      '  "xau_dominant_driver": "real_yield" | "safe_haven" | "risk_sentiment" | "usd_strength" | "insufficient_data",',
      '  "xau_driver_evidence": "string in Bahasa Indonesia — specific data point or event from headlines",',
      '  "xau_key_trigger": "string in Bahasa Indonesia — event name + WIB time + specific spike scenario, or \'Tidak ada trigger jelas dalam 24 jam\' if none",',
      '  "xau_confidence": 3',
      '}',
      '',
      'All free-text string fields (invalidation_condition, catalyst_dependency, xau_driver_evidence, xau_key_trigger) must be written in Bahasa Indonesia — the trader reading this is Indonesian. Keep standard finance terms (DXY, real yield, basis point, dll) as-is, do not translate those.',
      '',
      'FX rules:',
      'Use only 8 major currencies: USD EUR GBP JPY CAD AUD NZD CHF.',
      'Set direction to "no_trade" and confidence to 1-2 if conviction is low.',
      'Only recommend a pair if CB bias divergence between the two currencies is at least 2 levels apart (e.g. Hawkish vs Dovish).',
      'Use the calendar events to inform invalidation_condition — if a high-impact event for one of the pair currencies is scheduled within time_horizon_days, name it as the primary invalidation trigger.',
      'dominant_regime must directly copy the "Regime" classification from the risk regime data above when available, using this exact mapping: risk_off or elevated → "risk_off"; risk_on → "risk_on"; neutral → "neutral". Do not reinterpret or override this with headline sentiment — if the data says neutral, output "neutral" even if headlines feel risk-on or risk-off. Only fall back to inferring from headlines if risk regime data is unavailable.',
      'If rate path data shows bps already priced in for USD, weigh this into confidence — a pair recommendation that fights an already-priced rate path needs stronger non-rate justification.',
      'If options skew for the recommended pair contradicts the recommended direction (e.g. recommending long but skew is put-skewed), lower confidence by at least 1 point and mention the conflict in catalyst_dependency.',
      '',
      'XAU rules:',
      'xau_bias must be based on fundamental pressure from headlines, NOT price prediction.',
      'xau_driver_evidence must cite a specific number, official name, or event from the gold headlines — not a generic statement.',
      'If gold headlines are sparse (fewer than 3 substantive), set xau_dominant_driver to "insufficient_data" and xau_confidence to 1.',
      'xau_key_trigger must include WIB time if available from calendar, otherwise note "time TBD".',
      'xau_confidence: 1-5 where 5 = multiple converging headlines with clear direction.',
      'If xau_dominant_driver is "safe_haven", it must be corroborated by the risk regime data (VIX/MOVE elevated or risk_off) — if risk regime is benign/risk_on, do not select "safe_haven" as dominant_driver unless headlines show a very fresh, unpriced shock.',
      'If gold correlation anomalies show a breakdown vs DXY or real yield (the usual negative correlation weakening), factor this into xau_confidence — a correlation breakdown signals the dominant driver may be shifting.',
    ].join('\n');

    const call3Messages = [{ role: 'user', content: thesisPrompt }];
    const VALID_DIR = ['long', 'short', 'no_trade'];
    const VALID_REG = ['risk_on', 'risk_off', 'neutral'];
    const VALID_CURR = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
    const VALID_XAU_BIAS = ['bullish', 'bearish', 'neutral', 'conflicting'];
    const VALID_XAU_DRIVER = ['real_yield', 'safe_haven', 'risk_sentiment', 'usd_strength', 'insufficient_data'];

    function validateThesis(parsed) {
      return (
        VALID_REG.includes(parsed.dominant_regime) &&
        VALID_CURR.has(parsed.strongest_currency) &&
        VALID_CURR.has(parsed.weakest_currency) &&
        VALID_DIR.includes(parsed.direction) &&
        typeof parsed.confidence_1_to_5 === 'number' &&
        parsed.confidence_1_to_5 >= 1 && parsed.confidence_1_to_5 <= 5 &&
        VALID_XAU_BIAS.includes(parsed.xau_bias) &&
        VALID_XAU_DRIVER.includes(parsed.xau_dominant_driver)
      );
    }

    // Try SambaNova, then Groq fallback
    const call3Providers = [];
    if (SAMBANOVA_KEY) call3Providers.push({ url: SAMBANOVA_URL, key: SAMBANOVA_KEY, model: SAMBANOVA_MODEL, label: 'SambaNova', timeout: 8000 });
    if (GROQ_KEY)      call3Providers.push({ url: GROQ_URL,      key: GROQ_KEY,      model: GROQ_MODEL,      label: 'Groq fallback', timeout: 12000 });

    for (const provider of call3Providers) {
      if (thesis) break;
      // Check circuit breaker for SambaNova; Groq fallback is always allowed
      const circuitSource = provider.label.startsWith('SambaNova') ? CB_SAMBA_MAIN : null;
      if (circuitSource && !await cb.canCall(circuitSource)) {
        console.log('Call 3:', provider.label, 'circuit OPEN — skipping');
        continue;
      }
      try {
        console.log('Call 3: trying', provider.label);
        const raw = await aiCall(provider.url, provider.key, provider.model, call3Messages, 800, 0.1, provider.timeout);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (validateThesis(parsed)) {
          thesis = parsed;
          console.log('Call 3: OK via', provider.label);
          if (circuitSource) await cb.onSuccess(circuitSource);
        } else {
          console.warn('Call 3: schema invalid via', provider.label, JSON.stringify(parsed).slice(0, 200));
          // Schema invalid ≠ provider failure — don't penalize circuit
        }
      } catch(e) {
        console.warn('Call 3', provider.label, 'failed:', e.status || e.message);
        if (circuitSource) await cb.onFailure(circuitSource, AI_CB_THRESHOLD);
      }
    }

    if (thesis) {
      try {
        await redisCmd('SET', 'latest_thesis', JSON.stringify(thesis), 'EX', 21600);
        console.log('Thesis saved to Redis');
      } catch(e) {
        console.warn('Thesis Redis save failed:', e.message);
      }
    } else {
      console.warn('Call 3: all attempts failed — thesis null');
    }
  }

  // ── 8. Await Call 4 (ran concurrently with Call 1) ───────────────────────────
  const _rawAlerts = await _call4Promise;
  const thesisAlerts = (method !== 'fallback' && method !== 'fallback_quota') ? _rawAlerts : null;

  // ── Auto-update fundamental data + CB decisions from headlines ───────────────
  try {
    await autoUpdateFundamentals(recentItems.slice(0, 100), redisCmd);
  } catch(e) {
    console.warn('autoUpdateFundamentals failed:', e.message);
  }

  const payload = {
    article, method, thesis,
    thesis_alerts:  thesisAlerts,
    news_count:     recentItems.length,
    gold_count:     goldItems.length,
    cal_count:      calEvents.length,
    bias_updated:   biasUpdated,
    provider_log:   providerLog,
    quality_flags:  phraseHits.length > 0 ? { forbidden_phrases: phraseHits } : undefined,
    generated_at:   new Date().toISOString(),
  };

  // Persist full payload to Redis so cached mode works (exclude thesis_alerts — device-specific)
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    const toCache = { ...payload, thesis_alerts: null };
    redisCmd('SET', 'latest_article', JSON.stringify(toCache), 'EX', 21600).catch(() => {});
    // A2.2: notify subscribers once per successful digest — fire-and-forget, never block the response.
    notifyDigestReady(article).catch(e => console.warn('Digest-ready push failed:', e.message));
  }

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

// A2.2 — sesi label matches the 3 vercel.json cron times (UTC 00:00 / 07:00 / 12:30).
function sesiLabel() {
  const h = new Date().getUTCHours();
  if (h < 4)  return 'sesi Asia';
  if (h < 10) return 'sesi Eropa';
  return 'sesi NY';
}

// A2.2 — sends exactly one "Ringkasan siap" push per successful digest. Fire-and-forget:
// failures here must never affect the digest response itself.
async function notifyDigestReady(articleText) {
  if (!configureVapid()) return;
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { subs.push(JSON.parse(raw[i + 1])); } catch(e) {}
      }
    }
  } catch(e) {}
  if (subs.length === 0) return;

  const firstSentence = (articleText.split(/\n/).find(l => l.trim()) || articleText).trim();
  const body = firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence;
  const payload = { title: `📰 Ringkasan ${sesiLabel()} siap`, body, url: '/#ringkasan', icon: '/icon.svg' };

  const staleKeys = await sendWebPush(subs, payload);
  if (staleKeys.length > 0) await redisCmd('HDEL', 'push_subs', ...staleKeys).catch(() => {});
}

function toDateStr(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

function parseRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate'), link=b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid&&title) items.push({title,guid,pubDate,link});
  }
  return items;
}

function parseFFXML(xml) {
  const events = [], re = /<event>([\s\S]*?)<\/event>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r=new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block); if(!r)return''; return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); };
    const title=get('title'), country=get('country').toUpperCase(), date=get('date'), time=get('time'), impact=get('impact');
    if (!title||!country) continue;
    const dp=date.match(/(\d{2})-(\d{2})-(\d{4})/); if(!dp) continue;
    events.push({ date:`${dp[3]}-${dp[1]}-${dp[2]}`, time_wib:convertToWIB(time), currency:country, event:title, impact });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr||timeStr==='All Day'||timeStr==='Tentative') return 'Tentative';
  const m=timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i); if(!m) return timeStr;
  let hour=parseInt(m[1]); const min=parseInt(m[2]), ampm=m[3].toLowerCase();
  if(ampm==='pm'&&hour!==12)hour+=12; if(ampm==='am'&&hour===12)hour=0;
  return `${String((hour+7)%24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}


function detectCat(title) {
  const t=title.toLowerCase();
  const CATS = {
    'market-moving':['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/eur','/gbp','/jpy','/cad','/chf','/aud','/nzd','fx options','dollar index','dxy','cable','loonie','aussie','kiwi','fiber'],
    'equities':['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx'],
    'commodities':['gold','silver','copper','wheat','corn','xau','xag','commodity','zinc','nickel'],
    'energy':['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','hormuz','iea','tanker','lng'],
    'bonds':['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':['pmi','purchasing manager','composite index','manufacturing index'],
    'macro':['fed ','fomc','powell','warsh','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','payroll'],
    'geopolitical':['iran','iranian','nuclear','ceasefire','israel','russia','ukraine','china','chinese','taiwan','sanction','tariff','trump','nato','military'],
  };
  for (const [cat,kws] of Object.entries(CATS)) { if(kws.some(k=>t.includes(k)))return cat; }
  return 'macro';
}
