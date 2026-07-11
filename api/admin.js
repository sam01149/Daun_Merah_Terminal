// api/admin.js — consolidated admin endpoint
// GET/POST    /api/admin?action=health[&source=...]        → health check all sources
// GET/POST    /api/admin?action=redis-keys[&key=...]       → Redis key registry
// GET/POST/DELETE /api/admin?action=admin-prompts&key=...  → manage Groq prompt templates
// GET         /api/admin?action=push                       → cron: send push notifications
//
// Auth: health/redis-keys/admin-prompts use x-admin-secret header
//       push uses x-cron-secret header
// Update cron-job.org URLs:
//   /api/health → /api/admin?action=health
//   /api/push   → /api/admin?action=push

const PUSH_KW  = require('./_push_keywords');
const { autoUpdateFundamentals } = require('./_fundamental_parser');
const { getLiveCbRates } = require('./_cb_rates');
const { configureVapid, sendWebPush } = require('./_webpush');
const cb = require('./_circuit_breaker');
const rateLimit = require('./_ratelimit');
const { allowAiCall } = require('./_ai_guard');
const { requireAppKey } = require('./_app_key');
const { fetchYahooOhlcv1h } = require('./_ohlcv_fetch');

// Actions callable from the frontend without a secret → rate-limited per IP.
// AI-triggering actions get a tighter budget than cache reads.
const PUBLIC_ACTION_LIMITS = {
  fundamental_get:      30,
  fundamental_refresh:  10,
  fundamental_analysis:  5,
  ohlcv_read:           30,
  ohlcv_analyze:         5,
  ohlcv_dashboard:      30,
  polymarket:           30,
  gdpnow:               10,
};

module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  const action = req.query.action;

  // Cron traffic (Vercel cron header atau secret valid) tidak pernah kena 429
  const isCron = req.headers['x-vercel-cron'] === '1' ||
    (process.env.CRON_SECRET && (
      req.headers['x-cron-secret']  === process.env.CRON_SECRET ||
      req.headers['x-admin-secret'] === process.env.CRON_SECRET));
  if (!isCron && PUBLIC_ACTION_LIMITS[action]) {
    if (await rateLimit(req, res, { limit: PUBLIC_ACTION_LIMITS[action], windowSecs: 60, endpoint: `admin_${action}` })) return;
  }
  if (action === 'health')        return healthHandler(req, res);
  if (action === 'redis-keys')    return redisKeysHandler(req, res);
  if (action === 'admin-prompts') return adminPromptsHandler(req, res);
  if (action === 'push')                return pushHandler(req, res);
  if (action === 'fundamental_get')     return fundamentalGetHandler(req, res);
  if (action === 'fundamental_seed')    return fundamentalSeedHandler(req, res);
  if (action === 'fundamental_refresh') return fundamentalRefreshHandler(req, res);
  if (action === 'fundamental_analysis') return fundamentalAnalysisHandler(req, res);
  if (action === 'journal_import')      return journalImportHandler(req, res);
  if (action === 'circuit-reset')       return circuitResetHandler(req, res);
  if (action === 'circuit-status')      return circuitStatusHandler(req, res);
  if (action === 'gdpnow')             return gdpnowHandler(req, res);
  if (action === 'ohlcv_sync')         return ohlcvSyncHandler(req, res);
  if (action === 'ohlcv_read')         return ohlcvReadHandler(req, res);
  if (action === 'ohlcv_analyze')      return ohlcvAnalyzeHandler(req, res);
  if (action === 'ohlcv_dashboard')    return ohlcvDashboardHandler(req, res);
  if (action === 'polymarket')         return polymarketHandler(req, res);
  return res.status(400).json({ error: 'Missing ?action= — use health, redis-keys, admin-prompts, push, fundamental_get, fundamental_seed, fundamental_refresh, fundamental_analysis, journal_import, circuit-reset, circuit-status, gdpnow, ohlcv_sync, ohlcv_read, ohlcv_analyze, ohlcv_dashboard, or polymarket' });
};

// ── Shared Redis helper ────────────────────────────────────────────────────────

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

// ── Health handler (was api/health.js) ────────────────────────────────────────

const HEALTH_CORS            = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const HEALTH_ALERT_THRESHOLD = 2 * 60 * 60 * 1000;
const HEALTH_REDIS_KEY       = 'health_last_ok';
const HEALTH_RECOVER_THRESHOLD_MS = 5 * 60 * 1000; // 5 min down before recovery event

// Maps each health source to the Redis cache keys it populates.
// When a source goes DOWN, its cache is cleared so the next live request
// fetches fresh data immediately after recovery rather than serving stale.
const SOURCE_CACHE_KEYS = {
  fred:           ['real_yields', 'risk_regime'],
  stooq:          ['risk_regime'],
  financialjuice: ['rss_cache'],
  cftc:           ['cot_cache_v2'],
  forexfactory:   [],
  redis:          [], // can't clear Redis keys if Redis itself is down
};

async function sendHealthTelegram(text) {
  const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch(e) { console.warn('health: Telegram alert failed:', e.message); }
}

async function probeFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return { status: 'UNCONFIGURED', note: 'FRED_API_KEY not set' };
  const r = await fetch(
    `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${apiKey}&limit=1&sort_order=desc&file_type=json`,
    { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  const obs = (json.observations || []).filter(o => o.value !== '.');
  if (obs.length === 0) throw new Error('No observations returned');
  return { latest_date: obs[0].date, series: 'VIXCLS' };
}

async function probeStooq() {
  const r = await fetch('https://stooq.com/q/d/l/?s=%5evix&i=d&l=3', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('Date'));
  if (lines.length === 0) throw new Error('Empty CSV response');
  return { rows: lines.length, symbol: '^vix' };
}

async function probeForexFactory() {
  const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.xml', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaunMerah/1.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('<eventInfo>') && !txt.includes('<event>')) throw new Error('Unexpected XML structure');
  return { size_bytes: txt.length };
}

async function probeFinancialJuice() {
  const r = await fetch('https://www.financialjuice.com/feed.ashx?xy=rss', {
    headers: {
      'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
      'Referer': 'https://www.financialjuice.com/',
      'Accept': 'application/rss+xml,*/*',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('<rss')) throw new Error('Response is not valid RSS');
  return { size_bytes: txt.length };
}

async function probeCFTC() {
  const r = await fetch('https://www.cftc.gov/dea/options/financial_lof.htm', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaunMerah/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('EURO FX') && !txt.includes('JAPANESE YEN')) throw new Error('Currency data not found in page');
  return { size_bytes: txt.length };
}

async function probeRedis() {
  const result = await redisCmd('PING');
  if (result !== 'PONG') throw new Error(`Unexpected PING response: ${result}`);
  return {};
}

const PROBES = {
  fred:           { fn: probeFred,           label: 'FRED API' },
  stooq:          { fn: probeStooq,          label: 'Stooq CSV' },
  forexfactory:   { fn: probeForexFactory,   label: 'ForexFactory' },
  financialjuice: { fn: probeFinancialJuice, label: 'FinancialJuice RSS' },
  cftc:           { fn: probeCFTC,           label: 'CFTC COT' },
  redis:          { fn: probeRedis,          label: 'Upstash Redis' },
};

async function healthHandler(req, res) {
  Object.entries(HEALTH_CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  const singleSource = req.query.source;
  const targetProbes = singleSource
    ? (PROBES[singleSource] ? { [singleSource]: PROBES[singleSource] } : null)
    : PROBES;

  if (!targetProbes) {
    return res.status(400).json({ error: `Unknown source. Valid: ${Object.keys(PROBES).join(', ')}` });
  }

  const startTime = Date.now();

  let lastOkMap = {};
  try {
    const raw = await redisCmd('HGETALL', HEALTH_REDIS_KEY);
    if (raw && Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) lastOkMap[raw[i]] = raw[i + 1];
    }
  } catch(e) { console.warn('health: Redis HGETALL failed:', e.message); }

  const settled = await Promise.allSettled(
    Object.entries(targetProbes).map(async ([key, probe]) => {
      const t0 = Date.now();
      try {
        const detail = await probe.fn();
        return { key, label: probe.label, status: 'OK', latency_ms: Date.now() - t0, detail };
      } catch(e) {
        return { key, label: probe.label, status: 'DOWN', latency_ms: Date.now() - t0, error: e.message };
      }
    })
  );

  const now = new Date().toISOString();
  const report = {};
  const toAlert = [];
  const toRecover = [];

  for (const r of settled) {
    const { key, label, status, latency_ms, detail, error } = r.value;
    const lastOk = lastOkMap[key] || null;
    const gapMs  = lastOk ? Date.now() - new Date(lastOk).getTime() : null;

    // For DOWN sources: gapMs = how long it's been since last OK (= downtime duration)
    // For OK sources that just recovered: gapMs = how long the gap was while it was down
    const downMs   = status === 'DOWN' && gapMs != null ? gapMs : null;
    const downMins = downMs ? Math.round(downMs / 60000) : null;

    report[key] = {
      label, status, latency_ms,
      last_ok: status === 'OK' ? now : lastOk,
      ...(detail || {}),
      ...(error ? { error } : {}),
      ...(downMins != null ? { down_since_mins: downMins } : {}),
    };

    if (status === 'OK') {
      redisCmd('HSET', HEALTH_REDIS_KEY, key, now).catch(() => {});

      // Recovery detection: OK now but was down for > threshold
      if (lastOk && gapMs > HEALTH_RECOVER_THRESHOLD_MS) {
        toRecover.push({ key, label, downMins: Math.round(gapMs / 60000) });

        // Clear cache SAAT RECOVERY (bukan saat DOWN) — supaya request berikutnya
        // langsung fetch data segar pasca-outage. Dulu clear dilakukan saat DOWN,
        // yang justru menghapus salinan stale yang dipakai handler sebagai fallback
        // "serve stale" selama outage — user dapat 502 padahal ada data lama.
        const cacheKeys = SOURCE_CACHE_KEYS[key] || [];
        for (const ck of cacheKeys) {
          redisCmd('DEL', ck).catch(() => {});
          console.log(`health: cleared cache key "${ck}" — ${label} recovered, next request refetches fresh`);
        }
      }
    } else {
      if (!lastOk || downMs > HEALTH_ALERT_THRESHOLD) {
        toAlert.push({ label, error, lastOk });
      }
    }
  }

  if (toAlert.length > 0) {
    const lines = toAlert.map(d =>
      `• *${d.label}*: ${d.error}${d.lastOk ? ` (OK terakhir: ${d.lastOk.substring(0, 16)} UTC)` : ' (belum pernah OK)'}`
    ).join('\n');
    sendHealthTelegram(`🔴 *Daun Merah — Source Alert*\n\n${lines}\n\n_Dicek: ${now.substring(0, 16)} UTC_`);
  }

  if (toRecover.length > 0) {
    const lines = toRecover.map(d => `• *${d.label}*: kembali OK setelah ${d.downMins} menit`).join('\n');
    sendHealthTelegram(`✅ *Daun Merah — Recovery*\n\n${lines}\n\n_Dicek: ${now.substring(0, 16)} UTC_`);
  }

  const statuses = Object.values(report).map(r => r.status);
  const overall  = statuses.every(s => s === 'OK' || s === 'UNCONFIGURED') ? 'OK'
    : statuses.some(s => s === 'OK') ? 'DEGRADED' : 'DOWN';

  // Pemakaian budget AI hari ini (observability untuk guard _ai_guard.js)
  let aiBudget = null;
  try {
    const { getUsage } = require('./_ai_guard');
    const usages = await Promise.all(['groq', 'sambanova_main', 'sambanova_c1', 'ollama', 'openrouter', 'cerebras'].map(getUsage));
    aiBudget = Object.fromEntries(usages.map(u => [u.provider, { used: u.used, limit: u.limit }]));
  } catch(e) { /* diagnostik opsional — jangan gagalkan health check */ }

  return res.status(200).json({
    overall,
    checked_at: now,
    duration_ms: Date.now() - startTime,
    sources: report,
    ...(aiBudget ? { ai_budget: aiBudget } : {}),
  });
}

// ── Redis keys handler (was api/redis-keys.js) ────────────────────────────────

const KEY_REGISTRY = [
  { key: 'cb_bias',            owner: 'api/market-digest.js',  ttl_expected: null,   note: 'CB bias per currency, updated on each digest run' },
  { key: 'digest_history',     owner: 'api/market-digest.js',  ttl_expected: null,   note: 'Max 7 AI digest entries (array)' },
  { key: 'cot_cache_v2',       owner: 'api/feeds.js',          ttl_expected: 21600,  note: 'CFTC COT payload — TTL 6h' },
  { key: 'risk_regime',        owner: 'api/risk-regime.js',    ttl_expected: 1800,   note: 'VIX/MOVE/HY risk regime classifier' },
  { key: 'rss_cache',          owner: 'api/feeds.js',          ttl_expected: 60,     note: 'FinancialJuice RSS XML' },
  { key: 'real_yields',        owner: 'api/real-yields.js',    ttl_expected: 21600,  note: 'Real yield per currency (DGS10-T10YIE for USD)' },
  { key: 'rate_path',          owner: 'api/rate-path.js',      ttl_expected: 14400,  note: 'USD rate path heuristic (SOFR/EFFR)' },
  { key: 'latest_thesis',      owner: 'api/market-digest.js',  ttl_expected: 21600,  note: 'Structured trade thesis JSON from Groq Call 3' },
  { key: 'correlations',       owner: 'api/correlations.js',   ttl_expected: 86400,  note: '20d+60d cross-asset correlation matrix' },
  { key: 'prompt_digest',      owner: 'api/admin.js',          ttl_expected: null,   note: 'Groq prompt for market briefing (fallback: hardcoded)' },
  { key: 'health_last_ok',     owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET: source → last OK timestamp for alerting' },
  { key: 'push_subs',          owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET push subscriptions endpoint → JSON' },
  { key: 'seen_guids_set',     owner: 'api/admin.js',          ttl_expected: 86400,  note: 'Redis SET of seen RSS GUIDs for push dedup (SADD/SMEMBERS, atomic)' },
  { key: 'push_lock',          owner: 'api/admin.js',          ttl_expected: 55,     note: 'Distributed lock to prevent concurrent push cron runs' },
  { key: 'sizing_history:*',   owner: 'api/sizing-history.js', ttl_expected: null,   note: 'Sorted set: sizing calculations per device (max 10 entries)' },
  { key: 'journal:*',          owner: 'api/journal.js',        ttl_expected: null,   note: 'Full journal entry JSON per device' },
  { key: 'journal_index:*',      owner: 'api/journal.js',        ttl_expected: null,   note: 'Sorted set: journal entry IDs by created_at timestamp' },
  { key: 'fundamental:*',        owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET fundamental data per currency (no TTL — overwritten when new data)' },
  { key: 'fundamental_analysis', owner: 'api/admin.js',          ttl_expected: 21600,  note: 'Groq AI analysis of fundamental data, cached 6h' },
  { key: 'cb_decisions',         owner: 'api/market-digest.js',  ttl_expected: null,   note: 'HSET CB rate decisions detected from headlines, overrides CB_FALLBACK metadata' },
];

const DEPRECATED_KEYS = [
  { key: 'cot_cache',          replaced_by: 'cot_cache_v2',    note: 'Old COT format, superseded in Task 10b' },
  { key: 'fundamentals_cache', replaced_by: null,              note: 'Fundamentals tab removed from UI' },
  { key: 'seen_guids',         replaced_by: 'seen_guids_set',  note: 'JSON array replaced by Redis native SET for atomic dedup' },
];

async function getKeyInfo(key) {
  if (key.includes('*')) return { exists: 'wildcard_pattern', ttl_actual: null };
  const [exists, ttl] = await Promise.all([redisCmd('EXISTS', key), redisCmd('TTL', key)]);
  const ttl_actual = ttl === -1 ? 'no_ttl' : ttl === -2 ? 'not_set' : ttl;
  return { exists: exists === 1, ttl_actual };
}

async function redisKeysHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  if (req.method === 'POST' && req.query.cleanup === 'true') {
    const deletable = DEPRECATED_KEYS.filter(d => !d.key.includes('*'));
    const deleted = [];
    for (const dep of deletable) {
      try {
        const result = await redisCmd('DEL', dep.key);
        if (result === 1) deleted.push(dep.key);
      } catch(e) { console.warn('redis-keys: cleanup DEL failed for', dep.key, e.message); }
    }
    return res.status(200).json({
      ok: true,
      deleted,
      skipped: deletable.filter(d => !deleted.includes(d.key)).map(d => d.key),
      deprecated_list: DEPRECATED_KEYS,
    });
  }

  const singleKey = req.query.key;
  if (singleKey) {
    const entry = KEY_REGISTRY.find(k => k.key === singleKey);
    if (!entry) {
      return res.status(404).json({ error: 'Key not in registry', hint: 'GET /api/admin?action=redis-keys for full list' });
    }
    try {
      const liveInfo = await getKeyInfo(singleKey);
      return res.status(200).json({ ...entry, ...liveInfo, checked_at: new Date().toISOString() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const [activeWithInfo, deprecatedWithInfo] = await Promise.all([
    Promise.all(KEY_REGISTRY.map(async entry => {
      try { return { ...entry, ...(await getKeyInfo(entry.key)) }; }
      catch(e) { return { ...entry, exists: 'error', error: e.message }; }
    })),
    Promise.all(DEPRECATED_KEYS.map(async entry => {
      try {
        const exists = entry.key.includes('*') ? 'wildcard_pattern'
          : (await redisCmd('EXISTS', entry.key)) === 1;
        return { ...entry, exists };
      } catch(e) { return { ...entry, exists: 'error' }; }
    })),
  ]);

  const deprecatedPresent = deprecatedWithInfo.filter(d => d.exists === true).map(d => d.key);

  return res.status(200).json({
    active_keys: activeWithInfo,
    deprecated_keys: deprecatedWithInfo,
    deprecated_present_count: deprecatedPresent.length,
    cleanup_hint: deprecatedPresent.length > 0
      ? `POST /api/admin?action=redis-keys&cleanup=true with x-admin-secret to delete: ${deprecatedPresent.join(', ')}`
      : 'No deprecated keys found in Redis',
    checked_at: new Date().toISOString(),
  });
}

// ── Admin prompts handler (was api/admin-prompts.js) ──────────────────────────

const ALLOWED_PROMPT_KEYS = new Set(['prompt_digest']);

async function adminPromptsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  const key = req.query.key;
  if (!key || !ALLOWED_PROMPT_KEYS.has(key)) {
    return res.status(400).json({ error: 'key must be one of: ' + [...ALLOWED_PROMPT_KEYS].join(', ') });
  }

  if (req.method === 'GET') {
    try {
      const val = await redisCmd('GET', key);
      return res.status(200).json({ key, value: val || null, source: val ? 'redis' : 'hardcoded_fallback' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    if (!body.trim()) return res.status(400).json({ error: 'Body cannot be empty' });
    try {
      await redisCmd('SET', key, body.trim());
      return res.status(200).json({ ok: true, key, length: body.trim().length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await redisCmd('DEL', key);
      return res.status(200).json({ ok: true, key, message: 'Deleted — hardcoded default will be used' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Push handler (was api/push.js) ────────────────────────────────────────────

async function pushHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const CRON_SECRET   = process.env.CRON_SECRET;
  const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
  const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

  if (!CRON_SECRET || req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!configureVapid() || !REDIS_URL) {
    return res.status(200).json({ status: 'Not configured' });
  }

  // Distributed lock: prevent concurrent cron runs from double-sending
  const lockAcquired = await redisCmd('SET', 'push_lock', String(Date.now()), 'NX', 'EX', '55');
  if (!lockAcquired) {
    return res.status(200).json({ status: 'Locked — concurrent run skipped' });
  }

  let seenGuids = new Set();
  try {
    const members = await redisCmd('SMEMBERS', 'seen_guids_set');
    if (Array.isArray(members) && members.length > 0) seenGuids = new Set(members);
  } catch(e) {}

  let xml = null;
  const RSS_UAS = [
    'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'NewsBlur Feed Fetcher - 1000000 subscribers',
  ];
  const PUSH_RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
  for (const ua of RSS_UAS) {
    try {
      const r = await fetch(PUSH_RSS_URL, {
        headers: { 'User-Agent': ua, 'Referer': 'https://www.financialjuice.com/', 'Accept': 'application/rss+xml, application/xml, */*', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<rss')) { xml = text; break; }
      }
    } catch(e) { console.warn('RSS attempt failed:', ua.substring(0, 20), e.message); }
  }
  if (!xml) {
    await redisCmd('DEL', 'push_lock').catch(() => {});
    return res.status(200).json({ status: 'RSS unavailable' });
  }

  const items = parsePushRSS(xml);
  const isFirst = seenGuids.size === 0;
  const newItems = isFirst ? [] : items.filter(i => !seenGuids.has(i.guid));

  // SADD is atomic — safe even if two runs overlap at this point
  if (items.length > 0) {
    try {
      await redisCmd('SADD', 'seen_guids_set', ...items.map(i => i.guid));
      await redisCmd('EXPIRE', 'seen_guids_set', '86400');
    } catch(e) { console.warn('push: seen_guids_set write failed:', e.message); }
  }

  await redisCmd('DEL', 'push_lock').catch(() => {});

  if (newItems.length === 0) return res.status(200).json({ status: isFirst ? 'Initialized' : 'No new items' });

  await sendPushTelegram(newItems, TG_TOKEN, TG_CHAT_ID);

  // A2.3 Fase 1: kurangi kebisingan device push — hanya kategori bernilai tinggi.
  // 'market-moving' selalu lolos (override semua filter). Diperketat sesuai feedback user
  // (2026-06-29): macro & geopolitical mendominasi feed FinancialJuice dan jadi noise, jadi
  // di-drop dari push device — tetap masuk feed in-app & Telegram, cuma tak nge-push device.
  // A2.4 quiet hours: di luar market-moving, tahan push selama jam tidur WIB (23:00–06:00).
  const PUSH_CATS = new Set(['market-moving', 'econ-data']);
  const wibHour = new Date(Date.now() + 7 * 3600000).getUTCHours();
  const isQuietHours = wibHour >= 23 || wibHour < 6;
  const pushItems = newItems.filter(i => {
    const cat = detectPushCat(i.title);
    if (cat === 'market-moving') return true;
    if (isQuietHours) return false;
    return PUSH_CATS.has(cat);
  });

  // Baca semua subscription — raw HGETALL = [key, value, key, value, ...]
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (raw && Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { subs.push(JSON.parse(raw[i + 1])); } catch(e) {}
      }
    }
  } catch(e) {}

  let totalStaleKeys = [];
  if (subs.length > 0 && pushItems.length > 0) {
    const EMOJI = { 'market-moving': '🔴', 'forex': '💱', 'energy': '⚡', 'macro': '🏦', 'geopolitical': '🌐', 'econ-data': '📋', 'news': '📰' };
    // A2.3 Fase 2: per-item send with per-subscriber category filtering.
    // market-moving always reaches everyone; other categories respect each subscriber's preferences.
    for (const item of pushItems) {
      const cat = detectPushCat(item.title);
      const targetSubs = subs.filter(sub => {
        if (cat === 'market-moving') return true;
        const userCats = sub.categories;
        if (!userCats || !Array.isArray(userCats)) return PUSH_CATS.has(cat); // legacy fallback
        return userCats.includes(cat);
      });
      if (targetSubs.length === 0) continue;
      const payload = {
        title: `${EMOJI[cat] || '📰'} Daun Merah`,
        body:  item.title,
        url:   item.link || '/',
        icon:  '/icon.svg',
      };
      const stale = await sendWebPush(targetSubs, payload);
      totalStaleKeys.push(...stale);
    }
    if (totalStaleKeys.length > 0) {
      const unique = [...new Set(totalStaleKeys)];
      await redisCmd('HDEL', 'push_subs', ...unique);
    }
  }

  return res.status(200).json({ status: 'OK', new_items: newItems.length, pushed_items: pushItems.length, subscribers: subs.length });
}

async function sendPushTelegram(newItems, TG_TOKEN, TG_CHAT_ID) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const EMOJI = { 'market-moving': '🔴', 'forex': '💱', 'energy': '⚡', 'macro': '🏦', 'geopolitical': '🌐', 'econ-data': '📋', 'news': '📰' };
  const lines = newItems.slice(0, 10).map(i => `${EMOJI[detectPushCat(i.title)] || '📰'} ${i.link ? `[${i.title}](${i.link})` : i.title}`);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `*Daun Merah — ${newItems.length} berita baru*\n\n${lines.join('\n')}`, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch(e) { console.warn('Telegram:', e.message); }
}

function parsePushRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1 || r2)?.[1]?.trim() || ''; };
    const title = get('title').replace(/^FinancialJuice:\s*/i, '').trim(), guid = get('guid'), link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, link });
  }
  return items;
}

function detectPushCat(t) {
  t = t.toLowerCase();
  if (PUSH_KW.MARKET_MOVING.some(k => t.includes(k))) return 'market-moving';
  if (PUSH_KW.FOREX.some(k => t.includes(k)))         return 'forex';
  if (PUSH_KW.ENERGY.some(k => t.includes(k)))        return 'energy';
  if (PUSH_KW.MACRO.some(k => t.includes(k)))         return 'macro';
  if (PUSH_KW.GEOPOLITICAL.some(k => t.includes(k)))  return 'geopolitical';
  if (PUSH_KW.ECON_DATA.some(k => t.includes(k)))     return 'econ-data';
  return 'news';
}

// ── Fundamental Data handlers ──────────────────────────────────────────────────

const FUND_CURRENCIES = ['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF'];

const FJ_RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';

function parseRSSHeadlines(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate');
    if (guid && title) items.push({ title, guid, pubDate });
  }
  return items;
}

async function fundamentalRefreshHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    // Fetch live FJ RSS + news_history in parallel for maximum coverage
    const [rssResult, histRaw] = await Promise.allSettled([
      fetch(FJ_RSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
      redisCmd('ZREVRANGE', 'news_history', 0, 149),
    ]);

    const seen = new Set();
    const headlines = [];

    // Live RSS first (most current)
    if (rssResult.status === 'fulfilled' && rssResult.value.ok) {
      const xml = await rssResult.value.text();
      for (const item of parseRSSHeadlines(xml)) {
        if (!seen.has(item.guid)) { seen.add(item.guid); headlines.push(item); }
      }
    }

    // news_history as supplement (last 36h)
    if (histRaw.status === 'fulfilled' && Array.isArray(histRaw.value)) {
      for (const entry of histRaw.value) {
        try {
          const item = JSON.parse(entry);
          if (item.guid && !seen.has(item.guid)) { seen.add(item.guid); headlines.push(item); }
        } catch(_) {}
      }
    }

    if (headlines.length === 0) return res.status(200).json({ updated: {}, headlines: 0 });

    const updated = await autoUpdateFundamentals(headlines, redisCmd);

    // Self-heal: reset quantity indicators that were incorrectly written as % values (legacy bad data)
    // and move mistaken Core PCE YoY values back to the correct key.
    try {
      const QUANTITY_SEED_KEYS = ['NFP', 'Jobless Claims', 'Employment Change', 'Claimant Count', 'Building Approvals', 'Housing Starts', 'Durable Goods Orders'];
      const hashes = await redisCmd('HMGET', 'fundamental:USD', ...QUANTITY_SEED_KEYS, 'Core PCE');
      const fixArgs = ['HSET', 'fundamental:USD'];
      const SEED_USD = FUND_SEED.USD || {};
      let needFix = false;
      for (let i = 0; i < QUANTITY_SEED_KEYS.length; i++) {
        const raw = hashes?.[i];
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw);
          if (entry.actual && String(entry.actual).endsWith('%')) {
            const seed = SEED_USD[QUANTITY_SEED_KEYS[i]];
            if (seed) { fixArgs.push(QUANTITY_SEED_KEYS[i], JSON.stringify(seed)); needFix = true; }
          }
        } catch(_) {}
      }
      // Core PCE: if value >2% it's YoY — move to 'Core PCE YoY', reset 'Core PCE' to MoM seed
      const pcRaw = hashes?.[QUANTITY_SEED_KEYS.length];
      if (pcRaw) {
        try {
          const pcEntry = JSON.parse(pcRaw);
          const pcVal = parseFloat(pcEntry.actual);
          if (!isNaN(pcVal) && pcVal > 2.0) {
            fixArgs.push('Core PCE YoY', pcRaw);       // save as YoY
            const pcSeed = SEED_USD['Core PCE'];
            if (pcSeed) fixArgs.push('Core PCE', JSON.stringify(pcSeed)); // restore MoM seed
            needFix = true;
          }
        } catch(_) {}
      }
      if (needFix && fixArgs.length > 2) await redisCmd(...fixArgs);
    } catch(e) { console.warn('sanitize quantity indicators failed:', e.message); }

    // Also refresh GDP Nowcast if data is stale (>6h) — piggyback on refresh call
    let gdpUpdated = false;
    try {
      const gdpRaw = await redisCmd('HGET', 'fundamental:USD', 'GDP Nowcast');
      const gdpEntry  = gdpRaw ? JSON.parse(gdpRaw) : null;
      // Use the stored date field to judge staleness; fall back to "always refresh" if absent
      const gdpDate   = gdpEntry?.date ? new Date(gdpEntry.date).getTime() : 0;
      const ageMs     = Date.now() - gdpDate;
      if (ageMs > 6 * 3600 * 1000) {
        const vals  = await fetchGdpNowData();
        const value = parseFloat(vals[0].value);
        const prev  = vals.length > 1 ? parseFloat(vals[1].value) : null;
        await redisCmd('HSET', 'fundamental:USD', 'GDP Nowcast', JSON.stringify({
          actual:   `${value.toFixed(1)}%`,
          previous: prev != null ? `${prev.toFixed(1)}%` : null,
          period:   vals[0].date,
          date:     vals[0].date,
          source:   'Atlanta Fed GDPNow',
        }));
        gdpUpdated = true;
      }
    } catch(e) { console.warn('gdpnow in fundamental_refresh failed:', e.message); }

    return res.status(200).json({ updated, headlines: headlines.length, gdp_nowcast_refreshed: gdpUpdated });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
const GROQ_URL_FUND   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL_FUND = 'llama-3.3-70b-versatile';

// Cerebras Cloud (session 145) — gpt-oss-120b primary untuk fundamental_analysis DAN
// journal.js AI Coach (lihat journal.js). OpenAI-compatible, model asli OpenAI di-host
// Cerebras (bukan via OpenRouter) — pool token/hari terpisah total dari OpenRouter
// (dipakai Nemotron 3 Ultra di market-digest.js), jadi 2 fitur ini tidak berebut kuota
// dengan digest. Perlu env CEREBRAS_API_KEY (akun gratis di cerebras.ai/openai).
const CEREBRAS_URL   = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'gpt-oss-120b';
const CB_CEREBRAS_GPTOSS = 'ai:cerebras:gptoss';
const CB_SAMBA_C1_ADMIN  = 'ai:sambanova:c1'; // sama seperti CB_SAMBA_C1 di market-digest.js — akun 2 dipakai bersama

const FUND_SEED = {
  USD: {
    'Fed Rate':          { actual:'3.75%',      period:'Apr 2026',    date:'—', source:'seed' },
    'CPI YoY':           { actual:'3.3%',       period:'Apr 2026',    date:'—', source:'seed' },
    'Core CPI MoM':      { actual:'0.2%',       period:'Apr 2026',    date:'—', source:'seed' },
    'NFP':               { actual:'178K',       period:'Apr 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'4.3%',       period:'Apr 2026',    date:'—', source:'seed' },
    'GDP QoQ':           { actual:'2.0%',       period:'Q1 2026',     date:'—', source:'seed' },
    'Core PCE':          { actual:'0.3%',       period:'Mar 2026',    date:'—', source:'seed' },
    'Jobless Claims':    { actual:'200K',       period:'May W1 2026', date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'1.7%',       period:'Apr 2026',    date:'—', source:'seed' },
    'ISM Manufacturing': { actual:'54.5',       period:'Apr 2026',    date:'—', source:'seed' },
    'ISM Services':      { actual:'51.0',       period:'Apr 2026',    date:'—', source:'seed' },
    'PPI MoM':           { actual:'0.2%',       period:'Apr 2026',    date:'—', source:'seed' },
  },
  EUR: {
    'CPI Flash YoY':     { actual:'3.0%',       period:'Apr 2026',    date:'—', source:'seed' },
    'German CPI YoY':    { actual:'2.9%',       period:'Apr 2026',    date:'—', source:'seed' },
    'GDP QoQ Flash':     { actual:'0.1%',       period:'Q1 2026',     date:'—', source:'seed' },
    'ECB Rate':          { actual:'2.15%',      period:'Apr 2026',    date:'—', source:'seed' },
    'Manufacturing PMI': { actual:'52.2',       period:'Apr 2026',    date:'—', source:'seed' },
    'Services PMI':      { actual:'47.6',       period:'Apr 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'6.2%',       period:'Mar 2026',    date:'—', source:'seed' },
    'ZEW Sentiment':     { actual:'-17.2',      period:'Apr 2026',    date:'—', source:'seed' },
    'IFO Business':      { actual:'84.4',       period:'Apr 2026',    date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'-0.1%',      period:'Mar 2026',    date:'—', source:'seed' },
  },
  GBP: {
    'CPI YoY':           { actual:'3.3%',       period:'Mar 2026',    date:'—', source:'seed' },
    'GDP MoM':           { actual:'0.1%',       period:'Mar 2026',    date:'—', source:'seed' },
    'BOE Rate':          { actual:'3.75%',      period:'May 2026',    date:'—', source:'seed' },
    'Manufacturing PMI': { actual:'53.7',       period:'Apr 2026',    date:'—', source:'seed' },
    'Services PMI':      { actual:'52.7',       period:'Apr 2026',    date:'—', source:'seed' },
    'Employment Change': { actual:'25K',        period:'Mar 2026',    date:'—', source:'seed' },
    'Claimant Count':    { actual:'26.8K',      period:'Apr 2026',    date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'0.7%',       period:'Mar 2026',    date:'—', source:'seed' },
  },
  JPY: {
    'CPI YoY':              { actual:'1.5%',    period:'Mar 2026',    date:'—', source:'seed' },
    'GDP QoQ':              { actual:'0.5%',    period:'Q1 2026',     date:'—', source:'seed' },
    'BOJ Rate':             { actual:'0.75%',   period:'Apr 2026',    date:'—', source:'seed' },
    'Tankan Mfg Index':     { actual:'17',      period:'Q1 2026',     date:'—', source:'seed' },
    'Unemployment Rate':    { actual:'2.7%',    period:'Mar 2026',    date:'—', source:'seed' },
    'Retail Sales YoY':     { actual:'1.7%',    period:'Mar 2026',    date:'—', source:'seed' },
    'Industrial Production':{ actual:'-0.5%',   period:'Mar 2026',    date:'—', source:'seed' },
    'Trade Balance':        { actual:'667B JPY',period:'Mar 2026',    date:'—', source:'seed' },
  },
  CAD: {
    'CPI YoY':           { actual:'2.4%',       period:'Mar 2026',    date:'—', source:'seed' },
    'BOC Rate':          { actual:'2.25%',      period:'Apr 2026',    date:'—', source:'seed' },
    'Employment Change': { actual:'14.1K',      period:'Apr 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'6.7%',       period:'Apr 2026',    date:'—', source:'seed' },
    'GDP MoM':           { actual:'0.2%',       period:'Feb 2026',    date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'0.6%',       period:'Feb 2026',    date:'—', source:'seed' },
    'Trade Balance':     { actual:'1780M CAD',  period:'Mar 2026',    date:'—', source:'seed' },
    'Ivey PMI':          { actual:'57.7',       period:'Apr 2026',    date:'—', source:'seed' },
  },
  AUD: {
    'Employment Change': { actual:'17.9K',      period:'Mar 2026',    date:'—', source:'seed' },
    'CPI QoQ':           { actual:'0.6%',       period:'Q1 2026',     date:'—', source:'seed' },
    'GDP QoQ':           { actual:'0.3%',       period:'Q1 2026',     date:'—', source:'seed' },
    'RBA Rate':          { actual:'4.35%',      period:'May 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'4.5%',       period:'Apr 2026',    date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'0.2%',       period:'Mar 2026',    date:'—', source:'seed' },
    'Trade Balance':     { actual:'-1841M AUD', period:'Mar 2026',    date:'—', source:'seed' },
    'NAB Business Conf': { actual:'-29',        period:'Apr 2026',    date:'—', source:'seed' },
  },
  NZD: {
    'CPI QoQ':           { actual:'0.6%',       period:'Q4 2025',     date:'—', source:'seed' },
    'GDP QoQ':           { actual:'0.2%',       period:'Q4 2025',     date:'—', source:'seed' },
    'RBNZ Rate':         { actual:'2.25%',      period:'Apr 2026',    date:'—', source:'seed' },
    'Employment Change': { actual:'0.2%',       period:'Q4 2025',     date:'—', source:'seed' },
    'Unemployment Rate': { actual:'5.3%',       period:'Q4 2025',     date:'—', source:'seed' },
    'Trade Balance':     { actual:'698M NZD',   period:'Mar 2026',    date:'—', source:'seed' },
  },
  CHF: {
    'GDP QoQ':           { actual:'0.2%',       period:'Q4 2025',     date:'—', source:'seed' },
    'SNB Rate':          { actual:'0.0%',       period:'Mar 2026',    date:'—', source:'seed' },
    'CPI YoY':           { actual:'0.6%',       period:'Apr 2026',    date:'—', source:'seed' },
    'KOF Barometer':     { actual:'97.9',       period:'Apr 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'2.8%',       period:'Q1 2026',     date:'—', source:'seed' },
  },
};

async function fundamentalGetHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const [pairs, liveCbRates] = await Promise.all([
      Promise.all(FUND_CURRENCIES.map(async cur => {
        const raw = await redisCmd('HGETALL', `fundamental:${cur}`);
        const data = {};
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i += 2) {
            try { data[raw[i]] = JSON.parse(raw[i + 1]); } catch(_) { data[raw[i]] = { actual: raw[i + 1] }; }
          }
        }
        return [cur, data];
      })),
      getLiveCbRates().catch(e => { console.warn('getLiveCbRates failed:', e.message); return []; }),
    ]);

    // Overlay live-scraped CB rate onto "{Bank} Rate" row — this is the field that
    // previously stayed frozen on its seed value (e.g. ECB Rate missed a hike).
    // _cb_rates.js already merges 6h-cached scrape + cb_decisions, so this is
    // always at most ~6h stale instead of "since whenever it was last seeded".
    const dataByCur = Object.fromEntries(pairs);
    for (const cb of liveCbRates) {
      const bucket = dataByCur[cb.currency];
      if (!bucket) continue;
      bucket[`${cb.short} Rate`] = {
        actual: `${cb.rate}%`,
        period: cb.last_meeting,
        date: cb.last_meeting,
        source: cb.rate_source,
      };
    }

    return res.status(200).json({ ok: true, data: dataByCur, fetched_at: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function fundamentalSeedHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const written = [];
    for (const [cur, indicators] of Object.entries(FUND_SEED)) {
      const args = ['HSET', `fundamental:${cur}`];
      for (const [key, val] of Object.entries(indicators)) args.push(key, JSON.stringify(val));
      await redisCmd(...args);
      written.push(cur);
    }
    return res.status(200).json({ ok: true, seeded: written });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function fundamentalAnalysisHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const GROQ_KEY      = process.env.GROQ_API_KEY;
  const CEREBRAS_KEY  = process.env.CEREBRAS_API_KEY;
  const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
  if (!CEREBRAS_KEY && !SAMBANOVA_KEY_CALL1 && !GROQ_KEY) {
    return res.status(500).json({ error: 'No AI provider configured (CEREBRAS_API_KEY / SAMBANOVA_API_KEY_CALL1 / GROQ_API_KEY)' });
  }

  // Return cached if fresh (6h)
  if (req.query.force !== 'true') {
    try {
      const cached = await redisCmd('GET', 'fundamental_analysis');
      if (cached) {
        const obj = JSON.parse(cached);
        if (Date.now() - new Date(obj.generated_at).getTime() < 6 * 3600 * 1000) {
          return res.status(200).json({ ...obj, from_cache: true });
        }
      }
    } catch(e) {}
  }

  // Load all fundamental data
  const fundData = {};
  for (const cur of FUND_CURRENCIES) {
    const raw = await redisCmd('HGETALL', `fundamental:${cur}`);
    const d = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { d[raw[i]] = JSON.parse(raw[i + 1]); } catch(_) {}
      }
    }
    fundData[cur] = d;
  }

  const dataBlock = FUND_CURRENCIES.map(cur => {
    const d = fundData[cur] || {};
    const lines = Object.entries(d)
      .map(([k, v]) => `  ${k}: ${v.actual || '—'} (${v.period || '—'})`)
      .join('\n');
    return `${cur}:\n${lines || '  (no data)'}`;
  }).join('\n\n');

  const prompt = `Kamu adalah analis forex makro. Berikut data fundamental ekonomi terbaru per currency:

${dataBlock}

Berdasarkan data di atas, analisis dan rankingkan 8 currency dari TERKUAT hingga TERLEMAH dari sisi fundamental ekonomi.

Pertimbangkan:
- Pertumbuhan GDP vs ekspektasi global
- Tingkat inflasi vs target bank sentral (umumnya 2%)
- Kondisi pasar tenaga kerja (unemployment rate, employment change)
- Arah kebijakan moneter (tingkat suku bunga — makin tinggi = makin hawkish)
- PMI: >50 = ekspansi, <50 = kontraksi
- Untuk JPY: CPI rendah = deflasi = lemah secara fundamental; untuk CHF: CPI rendah biasa karena franc kuat secara struktural
- Untuk AUD: bergantung pada commodity prices (terutama minerals); untuk NZD: ekspor dairy sensitive terhadap demand Asia
- Untuk CAD: correlate kuat dengan harga minyak (Oil mencerminkan ekonomi Canada), tidak fluktuasi independent

Format jawaban WAJIB (Bahasa Indonesia, singkat dan actionable):

RANKING FUNDAMENTAL:
1. [currency] — [alasan satu kalimat]
2. [currency] — [alasan satu kalimat]
... (8 currency)

TERKUAT: [currency]
[2 kalimat ringkasan kenapa paling kuat]

TERLEMAH: [currency]
[2 kalimat ringkasan kenapa paling lemah]

DIVERGENSI TERBESAR:
1. [currency A] vs [currency B] — [1 kalimat kenapa divergensi ini paling besar]
2. [currency C] vs [currency D] — [1 kalimat]
3. [currency E] vs [currency F] — [1 kalimat]
(Ini untuk identify pair dengan setup fundamental paling kuat — bukan rekomendasi entry)`;

  const fundMessages = [{ role: 'user', content: prompt }];
  let analysis = null;

  // Primary: Cerebras gpt-oss-120b (session 145 — pool token/hari sendiri, terpisah
  // dari OpenRouter yang dipakai Nemotron di market-digest.js)
  if (CEREBRAS_KEY && await cb.canCall(CB_CEREBRAS_GPTOSS)) {
    try {
      if (!await allowAiCall('cerebras')) throw new Error('AI daily budget exceeded');
      const r = await fetch(CEREBRAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CEREBRAS_KEY}` },
        body: JSON.stringify({ model: CEREBRAS_MODEL, messages: fundMessages, max_tokens: 1500, temperature: 0.3, reasoning_effort: 'low' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      const txt = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!txt) throw new Error('Empty response');
      if (data?.choices?.[0]?.finish_reason === 'length') console.warn('fundamental_analysis: Cerebras output truncated (finish_reason=length) — pertimbangkan naikkan max_tokens');
      analysis = txt;
      console.log('fundamental_analysis: Cerebras gpt-oss-120b OK');
      await cb.onSuccess(CB_CEREBRAS_GPTOSS);
    } catch(e) {
      console.warn('fundamental_analysis Cerebras failed:', e.message);
      await cb.onFailure(CB_CEREBRAS_GPTOSS);
    }
  } else if (CEREBRAS_KEY) {
    console.log('fundamental_analysis: Cerebras circuit OPEN — skipping to SambaNova');
  }

  // Fallback 1: SambaNova akun 2 (session 145 — geser dari akun 1; akun 2 sekarang
  // dipakai bersama sebagai fallback journal_analysis + fundamental_analysis + Call 1
  // market-digest, lihat _ai_guard.js untuk rasionalnya)
  if (!analysis && SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1_ADMIN)) {
    try {
      if (!await allowAiCall('sambanova_c1')) throw new Error('AI daily budget exceeded');
      const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY_CALL1}` },
        body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: fundMessages, max_tokens: 1500, temperature: 0.3 }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      const txt = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!txt) throw new Error('Empty response');
      if (data?.choices?.[0]?.finish_reason === 'length') console.warn('fundamental_analysis: SambaNova output truncated (finish_reason=length) — pertimbangkan naikkan max_tokens');
      analysis = txt;
      console.log('fundamental_analysis: SambaNova akun2 fallback OK');
      await cb.onSuccess(CB_SAMBA_C1_ADMIN);
    } catch(e) {
      console.warn('fundamental_analysis SambaNova akun2 fallback failed:', e.message);
      await cb.onFailure(CB_SAMBA_C1_ADMIN);
    }
  } else if (!analysis && SAMBANOVA_KEY_CALL1) {
    console.log('fundamental_analysis: SambaNova akun2 circuit OPEN — skipping to Groq');
  }

  // Fallback 2: Groq (last resort, tetap ada — lihat daun_merah_plan.md Session 145)
  if (!analysis && GROQ_KEY) {
    try {
      if (!await allowAiCall('groq')) throw new Error('AI daily budget exceeded');
      const r = await fetch(GROQ_URL_FUND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL_FUND, messages: fundMessages, max_tokens: 1500, temperature: 0.3 }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      const txt = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!txt) throw new Error('Empty response');
      if (data?.choices?.[0]?.finish_reason === 'length') console.warn('fundamental_analysis: Groq output truncated (finish_reason=length) — pertimbangkan naikkan max_tokens');
      analysis = txt;
      console.log('fundamental_analysis: Groq fallback OK');
    } catch(e) {
      console.warn('fundamental_analysis Groq fallback failed:', e.message);
    }
  }

  if (!analysis) return res.status(500).json({ error: 'All providers failed for fundamental_analysis' });

  try {
    const result = { analysis, generated_at: new Date().toISOString(), from_cache: false };
    await redisCmd('SET', 'fundamental_analysis', JSON.stringify(result), 'EX', '21600');
    return res.status(200).json(result);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Journal Import ─────────────────────────────────────────────────────────────
// POST /api/admin?action=journal_import
// Body: { device_id, entries: [...] }
// Accepts original created_at / closed_at timestamps (preserves trade history order)

async function journalImportHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || !secret || secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Forbidden' });

  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  let parsed;
  try { parsed = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { device_id, entries } = parsed;
  if (!device_id || !Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: 'device_id and entries[] required' });

  const indexKey = `journal_index:${device_id}`;
  let imported = 0;

  for (const data of entries) {
    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const createdAt = data.created_at || new Date().toISOString();
    const score     = new Date(createdAt).getTime();

    const entry = {
      id, device_id,
      created_at:        createdAt,
      pair:              data.pair              || '',
      direction:         data.direction         || '',
      regime_at_entry:   null,
      thesis_text:       data.thesis_text       || '',
      driver_references: [],
      cb_bias_snapshot:  null,
      cot_snapshot:      null,
      entry_price:       data.entry_price  != null ? parseFloat(data.entry_price)  : null,
      stop_price:        data.stop_price   != null ? parseFloat(data.stop_price)   : null,
      target_price:      data.target_price != null ? parseFloat(data.target_price) : null,
      size_lots:         data.size_lots    != null ? parseFloat(data.size_lots)    : null,
      rr_planned:        data.rr_planned   != null ? parseFloat(data.rr_planned)   : null,
      time_horizon:      data.time_horizon  || '',
      status:            data.status        || 'closed',
      exit_price:        data.exit_price   != null ? parseFloat(data.exit_price)   : null,
      exit_reason:       data.exit_reason   || null,
      r_actual:          data.r_actual     != null ? parseFloat(data.r_actual)     : null,
      attribution_notes: data.attribution_notes || null,
      closed_at:         data.closed_at     || null,
    };

    await redisCmd('SET', `journal:${device_id}:${id}`, JSON.stringify(entry));
    await redisCmd('ZADD', indexKey, score, id);
    imported++;
  }

  return res.status(200).json({ ok: true, imported });
}

// ── Circuit breaker status + reset ───────────────────────────────────────────

const KNOWN_CIRCUITS = ['ai:openrouter', 'ai:openrouter:nemotron', 'ai:openrouter:nemotron-super', 'ai:cerebras', 'ai:cerebras:gptoss', 'ai:sambanova:c1', 'ai:sambanova:main', 'ai:ollama:nemotron', 'fred', 'stooq', 'ff', 'fj', 'cftc', 'redis', 'forexbenchmark', 'actionforex'];

async function circuitStatusHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const results = {};
  for (const src of KNOWN_CIRCUITS) {
    try {
      const raw = await redisCmd('GET', `circuit:${src}`);
      results[src] = raw ? JSON.parse(raw) : { state: 'closed', failures: 0 };
    } catch(e) {
      results[src] = { error: e.message };
    }
  }
  return res.status(200).json({ circuits: results });
}

// ── GDPNow helper + handler (Atlanta Fed nowcast) ────────────────────────────
// Uses keyless FRED CSV endpoint (same pattern as cb-status.js scrapeUSD).
// Falls back to FRED API with key if CSV fails.

async function fetchGdpNowData() {
  // Primary: keyless FRED CSV (no API key required)
  try {
    const csvUrl = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDPNOW&sort_order=desc&limit=5';
    const r = await fetch(csvUrl, { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split('\n').filter(l => l && !l.startsWith('DATE'));
      const vals = lines
        .map(l => { const p = l.split(','); return { date: p[0]?.trim(), value: p[1]?.trim() }; })
        .filter(v => v.value && v.value !== '.');
      if (vals.length > 0) return vals; // [{ date, value }, ...]
    }
  } catch(e) { console.warn('gdpnow CSV failed:', e.message); }

  // Fallback: FRED API with key
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED CSV unavailable and FRED_API_KEY not set');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=GDPNOW&api_key=${apiKey}&limit=5&sort_order=desc&file_type=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`FRED API HTTP ${r.status}`);
  const json = await r.json();
  const obs = (json.observations || []).filter(o => o.value !== '.');
  if (obs.length === 0) throw new Error('No GDPNOW observations');
  return obs.map(o => ({ date: o.date, value: o.value }));
}

async function gdpnowHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const vals = await fetchGdpNowData();
    const latest = vals[0];
    const value  = parseFloat(latest.value);
    const prev   = vals.length > 1 ? parseFloat(vals[1].value) : null;

    await redisCmd('HSET', 'fundamental:USD', 'GDP Nowcast', JSON.stringify({
      actual:   `${value.toFixed(1)}%`,
      previous: prev != null ? `${prev.toFixed(1)}%` : null,
      period:   latest.date,
      date:     latest.date,
      source:   'Atlanta Fed GDPNow',
    }));

    return res.status(200).json({ ok: true, value, date: latest.date, source: 'FRED GDPNOW' });
  } catch(e) {
    console.warn('gdpnow failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── OHLCV Sync — called by Vercel cron every hour ────────────────────────────
// Fetches 1H candles for fixed pairs + dynamic pair from latest_thesis.
// Stores as JSON array in Redis (key: ohlcv:{symbol}:1h, TTL 8h, max 120 candles).
// Self-healing: if Yahoo fails for one pair, others still sync. TTL ensures stale data
// expires automatically if the cron stops running.

const OHLCV_FIXED_PAIRS = [
  { symbol: 'GC=F',     label: 'XAU/USD' },
  { symbol: 'EURUSD=X', label: 'EUR/USD' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { symbol: 'USDJPY=X', label: 'USD/JPY' },
  { symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { symbol: 'USDCAD=X', label: 'USD/CAD' },
  { symbol: 'USDCHF=X', label: 'USD/CHF' },
  { symbol: 'NZDUSD=X', label: 'NZD/USD' },
];

const OHLCV_PAIR_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
  'NZD/USD': 'NZDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X', 'AUD/JPY': 'AUDJPY=X', 'EUR/AUD': 'EURAUD=X',
  'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X', 'XAU/USD': 'GC=F',
};

// fetchYahooOhlcv1h + fetchBinancePaxg1h dipindah ke ./_ohlcv_fetch.js (plan G6) —
// dipakai bersama cb-status.js ?section=shock. Perilaku tidak berubah.

async function fetchYahooOhlcvDaily(symbol) {
  // range=6mo — daily disimpan 135 bar supaya AI Analisa/Ringkasan punya anchor
  // 6 bulan (posisi dalam range, jarak dari puncak) + bahan cluster S/R;
  // konsumen yang butuh window 30D (stat UI, blok "Daily 30D") slice(-30) sendiri.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`Yahoo ${symbol} daily HTTP ${r.status}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No daily chart result for ${symbol}`);
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    const vol = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
    candles.push({ t: timestamps[i], o: +o.toFixed(6), h: +h.toFixed(6), l: +l.toFixed(6), c: +c.toFixed(6), v: Math.round(vol || 0) });
  }
  return candles;
}

function resampleTo4h(candles1h) {
  const bucket = 4 * 3600;
  const map = new Map();
  for (const c of candles1h) {
    const key = Math.floor(c.t / bucket) * bucket;
    if (!map.has(key)) {
      map.set(key, { t: key, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    } else {
      const b = map.get(key);
      b.h = Math.max(b.h, c.h);
      b.l = Math.min(b.l, c.l);
      b.c = c.c;
      b.v += (c.v || 0);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function ohlcvSyncHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth: GitHub Actions sends x-cron-secret; Vercel internal cron sends x-vercel-cron
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret   = req.headers['x-cron-secret'];
  if (!isVercelCron && (!cronSecret || cronSecret !== process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Determine pairs: fixed set + dynamic pair from latest thesis recommendation
  const pairsToSync = [...OHLCV_FIXED_PAIRS];
  try {
    const rawThesis = await redisCmd('GET', 'latest_thesis');
    if (rawThesis) {
      const thesis = JSON.parse(rawThesis);
      const rec = thesis?.pair_recommendation;
      if (rec && OHLCV_PAIR_SYMBOL_MAP[rec]) {
        const dynSymbol = OHLCV_PAIR_SYMBOL_MAP[rec];
        if (!pairsToSync.some(p => p.symbol === dynSymbol)) {
          pairsToSync.push({ symbol: dynSymbol, label: rec });
        }
      }
    }
  } catch(e) {
    console.warn('ohlcv_sync: latest_thesis read failed:', e.message);
  }

  // Fetch all pairs in parallel — individual failures don't block others
  const results = await Promise.allSettled(
    pairsToSync.map(async ({ symbol, label }) => {
      // 1H with range=10d (needed for 4H resampling over full 10 days)
      const candles1h = await fetchYahooOhlcv1h(symbol);
      if (candles1h.length === 0) throw new Error(`${symbol}: empty candles`);

      const candles4h = resampleTo4h(candles1h);
      const candles1d = await fetchYahooOhlcvDaily(symbol);

      // Store 3 TFs in parallel: 1H last 120 (5D), 4H last 60 (10D), 1D last 135 (6mo)
      await Promise.all([
        redisCmd('SET', `ohlcv:${symbol}:1h`, JSON.stringify(candles1h.slice(-120)), 'EX', '90000'), // 25h TTL
        redisCmd('SET', `ohlcv:${symbol}:4h`, JSON.stringify(candles4h.slice(-60)),  'EX', '90000'), // 25h TTL
        redisCmd('SET', `ohlcv:${symbol}:1d`, JSON.stringify(candles1d.slice(-135)), 'EX', '90000'), // 25h TTL
      ]);

      const n1h = Math.min(120, candles1h.length), n4h = Math.min(60, candles4h.length), n1d = Math.min(135, candles1d.length);
      console.log(`ohlcv_sync: ${label} — 1H:${n1h} 4H:${n4h} 1D:${n1d}`);
      return { symbol, label, count1h: n1h, count4h: n4h, count1d: n1d };
    })
  );

  const synced = results
    .filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results
    .filter(r => r.status === 'rejected')
    .map((r, i) => ({ symbol: pairsToSync[i]?.symbol, error: r.reason?.message }));

  console.log(`ohlcv_sync complete: ${synced.length}/${pairsToSync.length} synced (1H+4H+1D per pair)`);

  // Warm `ta:<symbol>:1d` (RSI/SMA) for synced pairs so Analisa indicators are
  // always available, not just after the TEK tab happens to be opened.
  const host  = req.headers.host || 'financial-feed-app.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  await Promise.allSettled(
    pairsToSync.map(({ symbol }) =>
      fetch(`${proto}://${host}/api/correlations?action=ta&symbol=${encodeURIComponent(symbol)}&interval=1d`, {
        headers: { 'x-cron-secret': process.env.CRON_SECRET || '' },
        signal: AbortSignal.timeout(15000),
      }).catch(e => console.warn(`ohlcv_sync: ta warm failed for ${symbol}:`, e.message))
    )
  );

  return res.status(200).json({ ok: true, synced, failed, synced_at: new Date().toISOString() });
}

// ── OHLCV helpers ─────────────────────────────────────────────────────────────

function _macdFull(closes) {
  if (!closes || closes.length < 35) return null;
  const k12 = 2/13, k26 = 2/27, k9 = 2/10;
  const ema12 = new Array(closes.length);
  ema12[11] = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  for (let i = 12; i < closes.length; i++) ema12[i] = closes[i] * k12 + ema12[i-1] * (1-k12);
  const ema26 = new Array(closes.length);
  ema26[25] = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 26; i < closes.length; i++) ema26[i] = closes[i] * k26 + ema26[i-1] * (1-k26);
  const macdLine = [];
  for (let i = 25; i < closes.length; i++) macdLine.push(ema12[i] - ema26[i]);
  if (macdLine.length < 9) return null;
  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) sig = macdLine[i] * k9 + sig * (1-k9);
  const last = macdLine[macdLine.length - 1];
  return { macd: last, signal: sig, histogram: last - sig };
}

function _atr14h1(candles) {
  if (!candles || candles.length < 15) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
}

// ── OHLCV Read — structured metrics for Analisa tab ──────────────────────────

// 5-bar pivot detection: candle i is a swing high if its high is strictly higher
// than the `lookback` candles on each side. Returns the `keep` most recent swings of each type.
function _findSwings(candles, lookback = 2, keep = 2) {
  if (!candles || candles.length < (lookback * 2 + 1)) return { swing_highs: [], swing_lows: [], last_swing_high: null, last_swing_low: null };
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].h < candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l > candles[i - j].l || candles[i].l >= candles[i + j].l) isLow  = false;
    }
    if (isHigh) highs.push({ price: candles[i].h, t: candles[i].t });
    if (isLow)  lows.push({ price: candles[i].l,  t: candles[i].t });
  }
  // Keep the N most recent of each (already sorted oldest→newest, so slice(-keep))
  const swingHighs = highs.slice(-keep);
  const swingLows  = lows.slice(-keep);
  return {
    swing_highs:     swingHighs,
    swing_lows:      swingLows,
    last_swing_high: swingHighs.length > 0 ? swingHighs[swingHighs.length - 1] : null,
    last_swing_low:  swingLows.length  > 0 ? swingLows[swingLows.length   - 1] : null,
  };
}

// ── Struktur teknikal untuk AI Analisa (semua pure function — dites di test/ta_struct.test.js) ──

// Klasifikasi market structure dari 2 swing high + 2 swing low terakhir H4:
// HH+HL = bullish, LH+LL = bearish, selain itu mixed/range. BOS = close terakhir
// menembus swing terakhir (sinyal struktur berubah, bukan sekadar range).
function _classifyStructure(swingHighs, swingLows, lastClose, dec) {
  if (!Array.isArray(swingHighs) || !Array.isArray(swingLows) || swingHighs.length < 2 || swingLows.length < 2 || typeof lastClose !== 'number') return null;
  const f = n => n.toFixed(dec);
  const [hOld, hNew] = swingHighs.slice(-2);
  const [lOld, lNew] = swingLows.slice(-2);
  let label;
  if (hNew.price > hOld.price && lNew.price > lOld.price)      label = 'Bullish (HH + HL)';
  else if (hNew.price < hOld.price && lNew.price < lOld.price) label = 'Bearish (LH + LL)';
  else                                                         label = 'Mixed/Range (swing tidak searah)';
  let bos = null;
  if (lastClose > hNew.price)      bos = `close terakhir ${f(lastClose)} menembus DI ATAS swing high terakhir ${f(hNew.price)} (break of structure bullish)`;
  else if (lastClose < lNew.price) bos = `close terakhir ${f(lastClose)} menembus DI BAWAH swing low terakhir ${f(lNew.price)} (break of structure bearish)`;
  return {
    label,
    detail: `swing high ${f(hOld.price)} → ${f(hNew.price)}, swing low ${f(lOld.price)} → ${f(lNew.price)}`,
    bos,
  };
}

// Cluster level S/R dari pivot Daily (window penuh, ~6 bulan) + swing 4H.
// Level berdekatan (≤ tolerance) digabung; kekuatan diukur dari jumlah candle Daily
// yang high/low-nya menyentuh area itu. Return max 3 resistance + 3 support terkuat.
function _clusterSrLevels(dailyCandles, swings4h, nowPrice, tolerance, dec) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 10 || typeof nowPrice !== 'number' || !(tolerance > 0)) return null;
  const dSw = _findSwings(dailyCandles, 2, 100);
  const candidates = [
    ...dSw.swing_highs.map(s => s.price),
    ...dSw.swing_lows.map(s => s.price),
    ...(swings4h?.swing_highs || []).map(s => s.price),
    ...(swings4h?.swing_lows  || []).map(s => s.price),
  ].filter(p => typeof p === 'number' && !isNaN(p)).sort((a, b) => a - b);
  if (candidates.length === 0) return null;
  const clusters = [];
  for (const p of candidates) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p - last.sum / last.n) <= tolerance) { last.sum += p; last.n++; }
    else clusters.push({ sum: p, n: 1 });
  }
  const levels = clusters.map(cl => {
    const center = cl.sum / cl.n;
    let touches = 0;
    for (const c of dailyCandles) {
      if (Math.abs(c.h - center) <= tolerance || Math.abs(c.l - center) <= tolerance) touches++;
    }
    return { price: +center.toFixed(dec), touches };
  });
  const strongest = arr => {
    const pick = [...arr]
      .sort((a, b) => b.touches - a.touches || Math.abs(a.price - nowPrice) - Math.abs(b.price - nowPrice))
      .slice(0, 3);
    // Cluster TERDEKAT ke harga wajib ikut — top-3 by sentuhan bisa semuanya zona lama
    // ratusan pip jauhnya (bagus untuk TP, tapi entry/SL butuh struktur immediate).
    const nearest = [...arr].sort((a, b) => Math.abs(a.price - nowPrice) - Math.abs(b.price - nowPrice))[0];
    if (nearest && !pick.includes(nearest)) pick[pick.length - 1] = nearest;
    return pick;
  };
  const above = strongest(levels.filter(l => l.price >= nowPrice)).sort((a, b) => a.price - b.price);
  const below = strongest(levels.filter(l => l.price <  nowPrice)).sort((a, b) => b.price - a.price);
  if (above.length === 0 && below.length === 0) return null;
  return { above, below };
}

// Fibonacci retracement dari leg dominan 4H (10 hari): ekstrem tertinggi & terendah
// window, arah leg dari urutan waktunya (low duluan = leg naik).
function _fibLevels(c4h, dec) {
  if (!Array.isArray(c4h) || c4h.length < 10) return null;
  let hiIdx = 0, loIdx = 0;
  c4h.forEach((c, i) => {
    if (c.h > c4h[hiIdx].h) hiIdx = i;
    if (c.l < c4h[loIdx].l) loIdx = i;
  });
  const hi = c4h[hiIdx].h, lo = c4h[loIdx].l;
  if (!(hi > lo)) return null;
  const up = loIdx < hiIdx;
  const range = hi - lo;
  const lvl = r => +(up ? hi - range * r : lo + range * r).toFixed(dec);
  return {
    direction:  up ? 'naik' : 'turun',
    swing_low:  +lo.toFixed(dec),
    swing_high: +hi.toFixed(dec),
    f382: lvl(0.382), f500: lvl(0.5), f618: lvl(0.618),
  };
}

// Pivot point klasik dari candle daily terakhir yang sudah selesai.
function _dailyPivots(prevDay, dec) {
  if (!prevDay || [prevDay.h, prevDay.l, prevDay.c].some(v => typeof v !== 'number' || isNaN(v))) return null;
  const { h, l, c } = prevDay;
  const p = (h + l + c) / 3;
  return {
    p:  +p.toFixed(dec),
    r1: +(2 * p - l).toFixed(dec), s1: +(2 * p - h).toFixed(dec),
    r2: +(p + (h - l)).toFixed(dec), s2: +(p - (h - l)).toFixed(dec),
  };
}

// High/low minggu lalu (minggu kalender Senin-start UTC) dari candle daily.
function _prevWeekHighLow(dailyCandles, dec) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 6) return null;
  const weekIdx = t => Math.floor((Math.floor(t / 86400) + 3) / 7); // epoch Kamis → +3 = minggu mulai Senin
  const curWeek = weekIdx(dailyCandles[dailyCandles.length - 1].t);
  const prev = dailyCandles.filter(c => weekIdx(c.t) === curWeek - 1);
  if (prev.length === 0) return null;
  return {
    high: +Math.max(...prev.map(c => c.h)).toFixed(dec),
    low:  +Math.min(...prev.map(c => c.l)).toFixed(dec),
  };
}

// Deteksi pola candlestick klasik pada `count` candle terakhir: engulfing,
// pin bar (hammer/shooting star), inside bar, doji. Deterministik dari OHLC —
// AI tinggal memakai label, tidak menebak pola sendiri.
function _detectCandlePatterns(candles, count, dec) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  const out = [];
  const n = candles.length;
  for (let k = Math.max(1, n - count); k < n; k++) {
    const c = candles[k], p = candles[k - 1];
    const body = Math.abs(c.c - c.o), range = c.h - c.l;
    if (!(range > 0)) continue;
    const upper = c.h - Math.max(c.c, c.o), lower = Math.min(c.c, c.o) - c.l;
    const pBody = Math.abs(p.c - p.o);
    const labels = [];
    if (pBody > 0 && body > pBody && c.c > c.o && p.c < p.o && c.c >= Math.max(p.o, p.c) && c.o <= Math.min(p.o, p.c)) labels.push('Bullish Engulfing');
    if (pBody > 0 && body > pBody && c.c < c.o && p.c > p.o && c.o >= Math.max(p.o, p.c) && c.c <= Math.min(p.o, p.c)) labels.push('Bearish Engulfing');
    if (body > 0 && lower >= body * 2 && upper <= body * 0.8) labels.push('Pin Bar bawah (rejection ke atas)');
    if (body > 0 && upper >= body * 2 && lower <= body * 0.8) labels.push('Pin Bar atas (rejection ke bawah)');
    if (c.h < p.h && c.l > p.l) labels.push('Inside Bar');
    if (body <= range * 0.1) labels.push('Doji');
    const isLast = k === n - 1;
    for (const label of labels) out.push({ t: c.t, label, close: +c.c.toFixed(dec), running: isLast });
  }
  return out;
}

// RSI-14 Wilder dari deret close. Return null kalau data kurang.
function _rsi14(closes) {
  if (!Array.isArray(closes) || closes.length < 15) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= 14; loss /= 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * 13 + Math.max(d, 0)) / 14;
    loss = (loss * 13 + Math.max(-d, 0)) / 14;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// On-demand fresh OHLCV pull for the Analisa tab. ohlcv_sync (cron) only runs ~1x/day on
// the Vercel Hobby plan, so the Redis snapshot it writes can be hours stale. This runs when
// a user opens/refreshes a pair so candles are near real-time. Throttled per-symbol via Redis
// (ohlcv_fresh:<symbol>) so rapid refreshes / multiple clients don't hammer Yahoo. Writes the
// same ohlcv:<symbol>:* keys the sync cron uses, keeping the snapshot warm for
// ohlcv_analyze / ohlcv_dashboard too. Per-timeframe allSettled so a transient daily failure
// doesn't throw away a good 1H fetch. Returns true if anything was refreshed.
const OHLCV_FRESH_THROTTLE = 90; // seconds — within this window, reads reuse the just-written snapshot

async function refreshOhlcvFromYahoo(symbol) {
  // Skip if this symbol was refreshed within the throttle window (another read/client did it).
  try {
    if (await redisCmd('GET', `ohlcv_fresh:${symbol}`)) return false;
  } catch (e) { /* throttle check best-effort — fall through to fetch */ }

  const [r1h, r1d] = await Promise.allSettled([
    fetchYahooOhlcv1h(symbol),
    fetchYahooOhlcvDaily(symbol),
  ]);

  const writes = [];
  if (r1h.status === 'fulfilled' && r1h.value?.length) {
    const candles1h = r1h.value;
    const candles4h = resampleTo4h(candles1h);
    writes.push(redisCmd('SET', `ohlcv:${symbol}:1h`, JSON.stringify(candles1h.slice(-120)), 'EX', '90000'));
    writes.push(redisCmd('SET', `ohlcv:${symbol}:4h`, JSON.stringify(candles4h.slice(-60)),  'EX', '90000'));
  }
  if (r1d.status === 'fulfilled' && r1d.value?.length) {
    writes.push(redisCmd('SET', `ohlcv:${symbol}:1d`, JSON.stringify(r1d.value.slice(-135)), 'EX', '90000'));
  }
  if (writes.length === 0) {
    // Arm a short throttle so a Yahoo outage doesn't make every read pay the full fetch timeout —
    // reads within 30s skip the retry and serve the last snapshot immediately.
    try { await redisCmd('SET', `ohlcv_fresh:${symbol}`, '0', 'EX', '30'); } catch (e) {}
    throw new Error(`${symbol}: Yahoo fetch failed (1h: ${r1h.reason?.message || 'ok'}, 1d: ${r1d.reason?.message || 'ok'})`);
  }
  // Only arm the throttle once we've actually written fresh candles.
  writes.push(redisCmd('SET', `ohlcv_fresh:${symbol}`, '1', 'EX', String(OHLCV_FRESH_THROTTLE)));
  await Promise.all(writes);
  return true;
}

async function loadOhlcvData(symbol, label) {
  // Pull fresh candles from Yahoo on read (throttled) so the Analisa tab is near real-time
  // instead of bound to the ~daily sync cron. If Yahoo is down we fall through to the last
  // snapshot — the candle-age badge in the UI will flag the staleness.
  try {
    await refreshOhlcvFromYahoo(symbol);
  } catch (e) {
    console.warn(`ohlcv_read: fresh fetch failed for ${symbol}, using snapshot:`, e.message);
  }

  const [raw1h, raw4h, raw1d, rawTa] = await Promise.all([
    redisCmd('GET', `ohlcv:${symbol}:1h`),
    redisCmd('GET', `ohlcv:${symbol}:4h`),
    redisCmd('GET', `ohlcv:${symbol}:1d`),
    redisCmd('GET', `ta:${symbol}:1d`),
  ]);

  return computeOhlcvMetrics({
    symbol, label,
    c1h:     raw1h ? JSON.parse(raw1h) : null,
    c4h:     raw4h ? JSON.parse(raw4h) : null,
    c1dFull: raw1d ? JSON.parse(raw1d) : null,
    ta:      rawTa ? JSON.parse(rawTa) : null,
  });
}

// Perakitan metrik murni dari candle mentah — dipisah dari I/O Redis/Yahoo supaya bisa
// diuji end-to-end tanpa infra (test/ta_struct.test.js + scripts smoke test).
function computeOhlcvMetrics({ symbol, label, c1h, c4h, c1dFull, ta }) {
  const isXau = symbol === 'GC=F';
  const isJpy = symbol.includes('JPY');
  const dec   = isXau ? 2 : isJpy ? 3 : 5;
  const c1d   = c1dFull ? c1dFull.slice(-30) : null;    // stat "Daily 30D" (UI + blok lama) tetap 30 bar
  const out   = { symbol, label, dec, is_xau: isXau, loaded_at: new Date().toISOString() };

  // Indicators (RSI/SMA from correlations TA cache — may be null if TEK tab never loaded)
  if (ta && ta.rsi_14 != null) {
    const rsi = ta.rsi_14;
    const rsiLabel = rsi >= 70 ? 'Overbought' : rsi <= 30 ? 'Oversold' : rsi >= 55 ? 'Bullish' : rsi <= 45 ? 'Bearish' : 'Neutral';
    out.indicators = {
      available:      true,
      rsi_14:         rsi,
      rsi_label:      rsiLabel,
      sma_50:         ta.sma_50   != null ? +ta.sma_50.toFixed(dec)  : null,
      sma_200:        ta.sma_200  != null ? +ta.sma_200.toFixed(dec) : null,
      vs_sma50:       ta.price_vs_sma50  || null,
      vs_sma200:      ta.price_vs_sma200 || null,
      computed_at:    ta.computed_at || null,
    };
  } else {
    out.indicators = { available: false };
  }
  const tp   = (a, b) => (b - a) / a * 100;

  // Daily
  if (c1d && c1d.length >= 5) {
    const hi = Math.max(...c1d.map(c => c.h)), lo = Math.min(...c1d.map(c => c.l));
    const curr = c1d[c1d.length - 1].c, chg = +tp(c1d[0].o, curr).toFixed(2);
    const half = Math.floor(c1d.length / 2);
    const avgO = c1d.slice(0, half).reduce((s,c) => s+c.c, 0) / half;
    const avgN = c1d.slice(half).reduce((s,c) => s+c.c, 0) / (c1d.length - half);
    const t = tp(avgO, avgN);
    const trend = t > 0.3 ? 'Uptrend' : t < -0.3 ? 'Downtrend' : 'Sideways';
    const topR  = [...c1d].sort((a,b) => b.h - a.h).slice(0,2).map(c => +c.h.toFixed(dec));
    const botS  = [...c1d].sort((a,b) => a.l - b.l).slice(0,2).map(c => +c.l.toFixed(dec));
    let vol = null;
    if (isXau) {
      const vArr = c1d.map(c => c.v).filter(v => v > 0);
      if (vArr.length > 3) {
        const vAvg = Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length);
        const vLast = c1d[c1d.length - 1].v;
        vol = { avg: vAvg, last: vLast, status: vLast > vAvg * 1.5 ? 'HIGH' : vLast < vAvg * 0.7 ? 'low' : 'Normal' };
      }
    }
    out.d1 = { available: true, high: +hi.toFixed(dec), low: +lo.toFixed(dec), current: +curr.toFixed(dec), change_pct: chg, trend, resistance: topR, support: botS, vol };
  } else { out.d1 = { available: false }; }

  // 4H
  if (c4h && c4h.length >= 6) {
    const hi = Math.max(...c4h.map(c => c.h)), lo = Math.min(...c4h.map(c => c.l));
    const curr = c4h[c4h.length - 1].c, chg = +tp(c4h[0].o, curr).toFixed(2);
    const n = Math.max(1, c4h.length - 10);
    const avgO = c4h.slice(0, n).reduce((s,c) => s+c.c, 0) / n;
    const avgN = c4h.slice(-10).reduce((s,c) => s+c.c, 0) / 10;
    const t = tp(avgO, avgN);
    const trend = t > 0.15 ? 'Uptrend' : t < -0.15 ? 'Downtrend' : 'Sideways';
    const swings = _findSwings(c4h, 2, 4);
    out.h4 = {
      available: true, high: +hi.toFixed(dec), low: +lo.toFixed(dec), current: +curr.toFixed(dec), change_pct: chg, trend,
      // Legacy single-swing fields (backwards compat with UI table)
      swing_high: swings.last_swing_high ? { price: +swings.last_swing_high.price.toFixed(dec), t: swings.last_swing_high.t } : null,
      swing_low:  swings.last_swing_low  ? { price: +swings.last_swing_low.price.toFixed(dec),  t: swings.last_swing_low.t  } : null,
      // Extended: up-to-4 swing highs & lows for AI entry/SL/TP precision + struktur HH/HL
      swing_highs: swings.swing_highs.map(s => ({ price: +s.price.toFixed(dec), t: s.t })),
      swing_lows:  swings.swing_lows.map(s  => ({ price: +s.price.toFixed(dec), t: s.t  })),
      // Raw 12 candle terakhir untuk pembacaan pola oleh AI (grounded, bukan menebak)
      candles12: c4h.slice(-12),
    };
  } else { out.h4 = { available: false }; }

  // 1H
  if (c1h && c1h.length >= 6) {
    const c120 = c1h.slice(-120), c24 = c1h.slice(-24);
    const hi = Math.max(...c120.map(c => c.h)), lo = Math.min(...c120.map(c => c.l));
    const curr = c120[c120.length - 1].c, chg = +tp(c120[0].o, curr).toFixed(2);
    const older = c120.slice(0, Math.max(1, c120.length - 24));
    const avgO = older.reduce((s,c) => s+c.c, 0) / older.length;
    const avgN = c24.reduce((s,c) => s+c.c, 0) / c24.length;
    const t = tp(avgO, avgN);
    const trend = t > 0.08 ? 'Uptrend' : t < -0.08 ? 'Downtrend' : 'Sideways';
    let volAvg = 0;
    if (isXau) {
      const vArr = c120.map(c => c.v).filter(v => v > 0);
      volAvg = vArr.length ? Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length) : 0;
    }
    out.h1 = { available: true, high: +hi.toFixed(dec), low: +lo.toFixed(dec), current: +curr.toFixed(dec), change_pct: chg, trend, candles24: c24, vol_avg: volAvg };
  } else { out.h1 = { available: false }; }

  // 4.0b: surface actual candle age, not just server read time — loaded_at is when THIS
  // request ran, not when ohlcv_sync last wrote data. If the cron stalls, candles can be
  // ~25h stale while loaded_at still reads "now", giving a false impression of freshness.
  out.last_candle_t = (c1h && c1h.length) ? c1h[c1h.length - 1].t : null;

  // MACD from H4 candles (EMA 12/26/9) — needs 35+ bars
  if (c4h && c4h.length >= 35) {
    const m = _macdFull(c4h.map(c => c.c));
    if (m) {
      const histUp = m.histogram > 0, macdUp = m.macd > 0;
      const status = histUp && macdUp ? 'Bullish' : !histUp && !macdUp ? 'Bearish' : histUp ? 'Recovering' : 'Weakening';
      out.macd = {
        available: true,
        macd:      +m.macd.toFixed(dec + 2),
        signal:    +m.signal.toFixed(dec + 2),
        histogram: +m.histogram.toFixed(dec + 2),
        status,
      };
    }
  }
  if (!out.macd) out.macd = { available: false };

  // ATR-14 from H1 candles (14-hour rolling volatility)
  if (c1h && c1h.length >= 15) {
    const atrVal = _atr14h1(c1h);
    if (atrVal != null) {
      const pipSize = isJpy ? 0.01 : isXau ? null : 0.0001;
      out.atr = {
        available: true,
        atr_h1:   +atrVal.toFixed(dec),
        atr_pips: pipSize ? Math.round(atrVal / pipSize) : null,
      };
    }
  }
  if (!out.atr) out.atr = { available: false };

  // ── Struktur tambahan untuk AI Analisa (semua guarded — data lama/klien tanpa
  // field ini tetap jalan; buildOhlcvText juga guard per-blok) ─────────────────

  // Konteks 6 bulan: posisi harga dalam range panjang — anchor yang selama ini
  // hilang (AI cuma tahu 30 hari, tidak bisa bilang "di puncak 6 bulan").
  const nowP = out.h1?.available ? out.h1.current : (out.d1?.available ? out.d1.current : null);
  const atrD = c1dFull && c1dFull.length >= 15 ? _atr14h1(c1dFull) : null;
  if (c1dFull && c1dFull.length >= 40 && typeof nowP === 'number') {
    const hi6 = Math.max(...c1dFull.map(c => c.h));
    const lo6 = Math.min(...c1dFull.map(c => c.l));
    const chg6 = +((nowP - c1dFull[0].o) / c1dFull[0].o * 100).toFixed(2);
    out.d1_ext = {
      available: true,
      high_6m: +hi6.toFixed(dec), low_6m: +lo6.toFixed(dec),
      pos_pct: hi6 > lo6 ? Math.round((nowP - lo6) / (hi6 - lo6) * 100) : null,
      chg_6m_pct: chg6,
      dist_high_pct: +((nowP - hi6) / hi6 * 100).toFixed(2),
      atr_d: atrD != null ? +atrD.toFixed(dec) : null,
      bars: c1dFull.length,
    };
  } else { out.d1_ext = { available: false }; }

  // Market structure H4 (HH/HL vs LH/LL + BOS)
  const h4LastClose = (c4h && c4h.length) ? c4h[c4h.length - 1].c : null;
  const struct = out.h4?.available ? _classifyStructure(out.h4.swing_highs, out.h4.swing_lows, h4LastClose, dec) : null;
  out.structure = struct ? { available: true, ...struct } : { available: false };

  // Cluster S/R (pivot Daily 6 bulan + swing H4, kekuatan = jumlah sentuhan Daily)
  const tol = atrD != null ? atrD * 0.35 : (typeof nowP === 'number' ? nowP * 0.0015 : null);
  const sr = (c1dFull && typeof nowP === 'number' && tol) ? _clusterSrLevels(c1dFull, out.h4?.available ? out.h4 : null, nowP, tol, dec) : null;
  out.sr_levels = sr ? { available: true, ...sr } : { available: false };

  // Fibonacci retracement leg dominan 4H
  const fib = _fibLevels(c4h, dec);
  out.fib = fib ? { available: true, ...fib } : { available: false };

  // Pivot harian klasik + prev day/week H-L. Bar daily terakhir umumnya masih
  // berjalan (hari ini) — bar "kemarin" yang sudah close ada di index len-2.
  if (c1dFull && c1dFull.length >= 3) {
    const prevDay = c1dFull[c1dFull.length - 2];
    const piv = _dailyPivots(prevDay, dec);
    out.ref_levels = {
      available: true,
      pivots: piv,
      prev_day:  { high: +prevDay.h.toFixed(dec), low: +prevDay.l.toFixed(dec), close: +prevDay.c.toFixed(dec) },
      prev_week: _prevWeekHighLow(c1dFull, dec),
    };
  } else { out.ref_levels = { available: false }; }

  // Pola candlestick terdeteksi (H4 3 terakhir, Daily 2 terakhir)
  const patH4 = c4h ? _detectCandlePatterns(c4h, 3, dec) : [];
  const patD1 = c1dFull ? _detectCandlePatterns(c1dFull, 2, dec) : [];
  out.patterns = (patH4.length || patD1.length) ? { available: true, h4: patH4, d1: patD1 } : { available: false };

  // RSI-14 H4 (timing entry — pelengkap RSI Daily dari cache TA)
  if (c4h && c4h.length >= 18) {
    const closes = c4h.map(c => c.c);
    const rsiNow  = _rsi14(closes);
    const rsiPrev = _rsi14(closes.slice(0, -3));
    if (rsiNow != null) {
      out.rsi_h4 = {
        available: true,
        value: +rsiNow.toFixed(1),
        direction: rsiPrev != null ? (rsiNow > rsiPrev + 1 ? 'naik' : rsiNow < rsiPrev - 1 ? 'turun' : 'datar') : null,
      };
    }
  }
  if (!out.rsi_h4) out.rsi_h4 = { available: false };

  return out;
}

function buildOhlcvText(data) {
  const { label, dec, is_xau, d1, h4, h1 } = data;
  const f = n => n.toFixed(dec);
  const fmtWib = ts => {
    const d = new Date((ts + 7 * 3600) * 1000);
    return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}WIB`;
  };
  const lines = [`${label} MULTI-TIMEFRAME`];
  if (d1.available) {
    lines.push(`[Daily 30D] Range: ${f(d1.low)}–${f(d1.high)} | Trend: ${d1.trend} | 30D: ${d1.change_pct >= 0 ? '+' : ''}${d1.change_pct}%`);
    lines.push(`  Resistance: ${d1.resistance.map(f).join(', ')} | Support: ${d1.support.map(f).join(', ')}`);
    if (is_xau && d1.vol) lines.push(`  Volume avg: ${(d1.vol.avg/1000).toFixed(0)}K | Today: ${(d1.vol.last/1000).toFixed(0)}K [${d1.vol.status}]`);
  }
  if (h4.available) {
    lines.push(`[4H 10D] Range: ${f(h4.low)}–${f(h4.high)} | Trend: ${h4.trend} | 10D: ${h4.change_pct >= 0 ? '+' : ''}${h4.change_pct}%`);
    // Show up to 2 swing highs and 2 swing lows for better AI entry/SL/TP precision (B2 4.0c)
    const shArr = (h4.swing_highs && h4.swing_highs.length > 0) ? h4.swing_highs : (h4.swing_high ? [h4.swing_high] : []);
    const slArr = (h4.swing_lows  && h4.swing_lows.length  > 0) ? h4.swing_lows  : (h4.swing_low  ? [h4.swing_low]  : []);
    const shTxt = shArr.length > 0 ? shArr.map(s => `${f(s.price)} (${fmtWib(s.t)})`).join(' → ') : 'N/A';
    const slTxt = slArr.length > 0 ? slArr.map(s => `${f(s.price)} (${fmtWib(s.t)})`).join(' → ') : 'N/A';
    lines.push(`  Swing Highs H4 (lama→baru): ${shTxt}`);
    lines.push(`  Swing Lows  H4 (lama→baru): ${slTxt}`);
  }
  if (h1.available) {
    lines.push(`[1H 5D] Range: ${f(h1.low)}–${f(h1.high)} | Now: ${f(h1.current)} | 5D: ${h1.change_pct >= 0 ? '+' : ''}${h1.change_pct}% | Trend: ${h1.trend}`);
  }
  if (data.indicators?.available) {
    const ind = data.indicators;
    const smaLine = [
      ind.sma_50  != null ? `SMA 50: ${f(ind.sma_50)} (price ${ind.vs_sma50})` : null,
      ind.sma_200 != null ? `SMA 200: ${f(ind.sma_200)} (price ${ind.vs_sma200})` : null,
    ].filter(Boolean).join(' | ');
    lines.push(`[INDIKATOR Daily] RSI 14: ${ind.rsi_14} (${ind.rsi_label}) | ${smaLine}`);
  }
  if (data.macd?.available) {
    const m = data.macd;
    const sign = m.histogram >= 0 ? '+' : '';
    lines.push(`[MACD H4 12,26,9] Line: ${m.macd} | Signal: ${m.signal} | Hist: ${sign}${m.histogram} [${m.status}]`);
  }
  if (data.atr?.available) {
    const a = data.atr;
    const pipsStr = a.atr_pips ? ` (${a.atr_pips} pip)` : '';
    lines.push(`[ATR-14 H1] Volatilitas: ${a.atr_h1}${pipsStr} — gunakan untuk SL minimum dan sizing`);
  }

  // ── Blok struktur (semua guarded — cache klien lama tanpa field ini tetap jalan) ──
  if (data.d1_ext?.available) {
    const e = data.d1_ext;
    const parts = [
      `Range: ${f(e.low_6m)}–${f(e.high_6m)}`,
      e.pos_pct != null ? `Posisi now: ${e.pos_pct}% dari range (0%=low, 100%=high)` : null,
      `6M: ${e.chg_6m_pct >= 0 ? '+' : ''}${e.chg_6m_pct}%`,
      `Jarak dari puncak 6M: ${e.dist_high_pct}%`,
      e.atr_d != null ? `ATR-14 Daily: ${f(e.atr_d)}` : null,
    ].filter(Boolean);
    lines.push(`[KONTEKS 6 BULAN — Daily ${e.bars} bar] ${parts.join(' | ')}`);
  }
  if (data.structure?.available) {
    lines.push(`[STRUKTUR H4] ${data.structure.label} — ${data.structure.detail}${data.structure.bos ? ` | BOS: ${data.structure.bos}` : ''}`);
  }
  if (data.sr_levels?.available) {
    const fmtLvl = l => `${f(l.price)} (${l.touches}x sentuh)`;
    lines.push(`[LEVEL S/R — cluster pivot Daily 6 bulan + swing H4, makin banyak sentuhan makin kuat]`);
    if (data.sr_levels.above?.length) lines.push(`  Resistance (di atas Now): ${data.sr_levels.above.map(fmtLvl).join(', ')}`);
    if (data.sr_levels.below?.length) lines.push(`  Support (di bawah Now): ${data.sr_levels.below.map(fmtLvl).join(', ')}`);
  }
  if (data.fib?.available) {
    const fb = data.fib;
    lines.push(`[FIBONACCI leg 4H ${fb.direction} ${f(fb.swing_low)}→${f(fb.swing_high)}] 38.2%: ${f(fb.f382)} | 50%: ${f(fb.f500)} | 61.8%: ${f(fb.f618)}`);
  }
  if (data.ref_levels?.available) {
    const r = data.ref_levels;
    if (r.pivots) lines.push(`[PIVOT HARIAN klasik dari daily kemarin] P: ${f(r.pivots.p)} | R1: ${f(r.pivots.r1)} | S1: ${f(r.pivots.s1)} | R2: ${f(r.pivots.r2)} | S2: ${f(r.pivots.s2)}`);
    const refParts = [
      r.prev_day  ? `Prev Day H/L/C: ${f(r.prev_day.high)}/${f(r.prev_day.low)}/${f(r.prev_day.close)}` : null,
      r.prev_week ? `Prev Week H/L: ${f(r.prev_week.high)}/${f(r.prev_week.low)}` : null,
    ].filter(Boolean);
    if (refParts.length) lines.push(`[LEVEL REFERENSI] ${refParts.join(' | ')}`);
  }
  if (data.patterns?.available) {
    const fmtPat = p => `${fmtWib(p.t)} ${p.label} (close ${f(p.close)})${p.running ? ' [candle berjalan, belum close]' : ''}`;
    lines.push(`[POLA CANDLE terdeteksi dari OHLC]`);
    if (data.patterns.h4?.length) lines.push(`  H4: ${data.patterns.h4.map(fmtPat).join('; ')}`);
    if (data.patterns.d1?.length) lines.push(`  Daily: ${data.patterns.d1.map(fmtPat).join('; ')}`);
    if (!data.patterns.h4?.length && !data.patterns.d1?.length) lines.push(`  (tidak ada pola signifikan di candle terakhir)`);
  }
  if (data.rsi_h4?.available) {
    lines.push(`[RSI-14 H4] ${data.rsi_h4.value}${data.rsi_h4.direction ? ` (${data.rsi_h4.direction} vs 3 candle lalu)` : ''}`);
  }
  const fmtCandle = c => `${fmtWib(c.t)} O:${f(c.o)} H:${f(c.h)} L:${f(c.l)} C:${f(c.c)}`;
  if (Array.isArray(h4?.candles12) && h4.candles12.length > 0) {
    lines.push(`[${h4.candles12.length} candle H4 terakhir (lama→baru) — baca pola & momentum langsung dari sini:]`);
    h4.candles12.forEach(c => lines.push(fmtCandle(c)));
  }
  if (Array.isArray(h1?.candles24) && h1.candles24.length > 0) {
    const c12 = h1.candles24.slice(-12);
    lines.push(`[${c12.length} candle 1H terakhir (lama→baru) — konteks entry intraday:]`);
    c12.forEach(c => lines.push(fmtCandle(c)));
  }
  return lines.join('\n');
}

async function ohlcvReadHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const { symbol, label } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    return res.status(200).json(await loadOhlcvData(symbol, label || symbol));
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

// Ambil max 6 level expiry milik pair ini, diurutkan dari yang paling dekat ke harga
// sekarang (magnet paling relevan duluan). Pure function — dites di test/guards.test.js.
function _pickExpiryLevels(expiries, pairLabel, nowPrice) {
  if (!Array.isArray(expiries) || !pairLabel) return [];
  const want = String(pairLabel).toUpperCase().replace('/', '');
  const rows = [];
  for (const e of expiries) {
    if ((e.pair || '').toUpperCase().replace('/', '') !== want) continue;
    const num = parseFloat(e.level);
    if (isNaN(num)) continue;
    rows.push({ level: e.level, num, size: (e.size || '').trim() });
  }
  if (typeof nowPrice === 'number') rows.sort((a, b) => Math.abs(a.num - nowPrice) - Math.abs(b.num - nowPrice));
  return rows.slice(0, 6);
}

// Ekstrak konteks makro dari artikel Ringkasan untuk pair tertentu (pure — dites unit).
// XAU: blok "XAUUSD:" (memang self-contained). Pair FX: bagian FX dipecah per marker
// {{TAG: NAMA}} yang disisipkan AI digest — ambil jangkar (teks sebelum tag pertama,
// tema utama hari itu) + segmen yang tag-nya menyebut salah satu leg pair + blok
// Konfirmasi (penutup currency kuat/lemah). Dulu excerpt FX = "3 paragraf pertama"
// apapun pair-nya — analisa NZD/USD bisa dapat konteks yang isinya melulu EUR/JPY.
// Artikel tanpa tag (model lama non-compliant) → fallback perilaku lama.
function _extractRingkasanExcerpt(article, label, isXau) {
  if (!article || typeof article !== 'string') return null;
  const cap = (s, n) => { s = s.trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
  if (isXau) {
    const clean = article.replace(/\{\{TAG:[^}]*\}\}/g, '').trim();
    const xauIdx = clean.search(/\bXAUUSD:/);
    const excerpt = xauIdx !== -1 ? clean.slice(xauIdx) : clean.split(/\n\n+/).slice(0, 3).join('\n\n');
    return excerpt ? cap(excerpt, 700) : null;
  }
  const xauIdx = article.search(/\bXAUUSD:/);
  const fxPart = (xauIdx !== -1 ? article.slice(0, xauIdx) : article).trim();
  if (!fxPart) return null;
  const parts = fxPart.split(/\{\{TAG:\s*([^}]+)\}\}\s*/);
  if (parts.length === 1) {
    return cap(fxPart.split(/\n\n+/).slice(0, 3).join('\n\n'), 700);
  }
  const legs = String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  const picked = [];
  if (parts[0].trim()) picked.push(parts[0].trim()); // jangkar tema utama — selalu ikut
  for (let i = 1; i < parts.length; i += 2) {
    const tag  = (parts[i] || '').toUpperCase();
    const text = (parts[i + 1] || '').trim();
    if (!text) continue;
    if (tag.includes('KONFIRMASI') || legs.some(leg => tag.includes(leg))) picked.push(text);
  }
  if (picked.length === 0) {
    return cap(fxPart.replace(/\{\{TAG:[^}]*\}\}/g, ' ').trim().split(/\n\n+/).slice(0, 3).join('\n\n'), 700);
  }
  // Cap 900 (bukan 700): excerpt tertarget sudah minim noise, sedikit lebih longgar
  // supaya blok Konfirmasi di ekor tidak terpotong.
  return cap(picked.join('\n\n'), 900);
}

// Format blok fundamental terstruktur per pair untuk prompt Analisa (pure — dites unit).
// Sumber: cb_bias (dirawat Call 2 digest), cot_cache_v2 (CFTC; USD = Dollar Index),
// risk_regime — data langsung dari cache server, BUKAN turunan prosa artikel, jadi
// Analisa tetap dapat fundamental kedua leg meski artikel hari itu tidak membahasnya.
function _formatFundamentalBlock({ label, isXau, cbBias, cot, risk, nowMs }) {
  const legs = String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  if (legs.length === 0) return '';
  const ageH = iso => {
    if (!iso) return null;
    const ms = nowMs - new Date(iso).getTime();
    return (isNaN(ms) || ms < 0) ? null : Math.round(ms / 3600000);
  };
  const lines = [];
  for (const leg of legs) {
    const parts = [];
    const cb = cbBias?.[leg];
    if (cb?.bias) {
      const a = ageH(cb.updated_at);
      parts.push(`bias CB ${cb.bias}${cb.confidence ? ` (confidence ${cb.confidence}${a != null ? `, update ${a}j lalu` : ''})` : ''}`);
    }
    const cp = cot?.positions?.[leg];
    if (cp && typeof cp.lev_net === 'number') {
      const k = n => `${n >= 0 ? '+' : ''}${(n / 1000).toFixed(1)}K`;
      parts.push(`COT leveraged net ${k(cp.lev_net)}${typeof cp.lev_change_net === 'number' ? ` (${k(cp.lev_change_net)} w/w)` : ''}`);
    }
    if (parts.length > 0) lines.push(`${leg}: ${parts.join(' | ')}`);
  }
  if (risk?.regime) {
    const parts = [`Regime: ${String(risk.regime).toUpperCase()}`];
    if (risk.vix != null)  parts.push(`VIX ${risk.vix}${risk.vix_change_2d != null ? ` (${risk.vix_change_2d >= 0 ? '+' : ''}${risk.vix_change_2d} 2d)` : ''}`);
    if (risk.move != null) parts.push(`MOVE ${risk.move}`);
    lines.push(`RISK REGIME: ${parts.join(' | ')}`);
  }
  if (lines.length === 0) return '';
  const note = isXau
    ? 'catatan: XAU tidak punya bank sentral — pakai bias Fed (USD) + risk regime sebagai proxy arah dolar/haven'
    : 'gunakan untuk menilai apakah setup teknikal searah atau melawan fundamental kedua leg';
  return `FUNDAMENTAL TERSTRUKTUR (cache server, bukan dari artikel — ${note}):\n${lines.join('\n')}`;
}

// Session 157 lanjutan 7: konteks sentimen pasar options (CME CVOL) per pair, bahasa
// sederhana bukan istilah teknis mentah (skew/convexity) — supaya AI meneruskan
// dengan nada yang sama ke commentary, bukan sekadar dump angka jargon. 3 sinyal
// terpisah (lihat correlations.js untuk sumber field, dan diskusi kenapa 3 axis ini
// tidak saling redundant — level vs arah vs kelengkungan smile):
// 1. Arah + momentum sentimen (skew + skewPercentChange)
// 2. Level volatilitas yang diharapkan pasar (cvolPrice + %chg)
// 3. Antisipasi kejutan mendadak 2 arah sekaligus, independen dari arah (convexInd + %chg)
function _formatOptionsSentimentBlock(rr) {
  if (!rr) return '';
  const val = rr.rr_value;
  const abs = Math.abs(val);
  const arah = abs < 0.2
    ? 'netral (tidak condong ke arah manapun)'
    : val < 0
      ? 'condong pesimis (put lebih diminati — pasar options bayar mahal untuk proteksi turun)'
      : 'condong optimis (call lebih diminati — pasar options bayar mahal untuk upside)';
  const lines = [`Sentimen pasar options: ${arah} (skor ${val > 0 ? '+' : ''}${val.toFixed(2)})`];

  if (rr.skew_change_pct != null && abs >= 0.1) {
    const arahSama = Math.sign(val) === Math.sign(rr.skew_change_pct);
    lines.push(arahSama
      ? `Sentimen ini SEDANG MENGUAT dibanding kemarin (${rr.skew_change_pct > 0 ? '+' : ''}${rr.skew_change_pct.toFixed(1)}%) — makin yakin ke arah itu.`
      : `Sentimen ini SEDANG MEREDA dibanding kemarin (${rr.skew_change_pct > 0 ? '+' : ''}${rr.skew_change_pct.toFixed(1)}%) — mulai ragu / berbalik arah, jangan anggap sentimen di atas masih penuh.`);
  }

  if (rr.vol_change_pct != null) {
    lines.push(rr.vol_change_pct > 0
      ? `Pasar memperkirakan pergerakan harga LEBIH BESAR dari biasanya (ekspektasi volatilitas naik ${rr.vol_change_pct.toFixed(1)}% dari kemarin).`
      : `Pasar memperkirakan pergerakan harga LEBIH TENANG dari biasanya (ekspektasi volatilitas turun ${Math.abs(rr.vol_change_pct).toFixed(1)}% dari kemarin).`);
  }

  if (rr.convexity_change_pct != null) {
    lines.push(rr.convexity_change_pct > 0
      ? `Ada tanda pasar mulai WASPADA kemungkinan kejutan mendadak ke arah manapun (naik ${rr.convexity_change_pct.toFixed(1)}% dari kemarin) — kalau ada rilis data/event besar dalam waktu dekat, sebut ini sebagai alasannya.`
      : `Tidak ada tanda pasar sedang mengantisipasi kejutan mendadak saat ini (indikator ini turun ${Math.abs(rr.convexity_change_pct).toFixed(1)}% dari kemarin).`);
  }

  return `SENTIMEN PASAR OPTIONS (dari CME, sumber terpisah dari data teknikal chart — pakai sebagai cross-check tambahan, BUKAN sinyal utama; kalau bertentangan dengan bias teknikal, sebut sebagai catatan risiko di paragraf integrasi, jangan mengubah bias):\n${lines.join('\n')}`;
}

async function ohlcvAnalyzeHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = req.query.symbol || req.body?.symbol;
  const label  = req.query.label  || req.body?.label;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Read-only path: return whatever the last successful analysis for this symbol
  // was (session cron or an earlier manual click) without spending an AI call —
  // used by the frontend to auto-show XAU/USD analysis when the tab opens.
  if (req.query.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', `ohlcv_analysis:${symbol}`);
      if (!raw) return res.status(200).json({ commentary: null, structured: null, cached: false });
      return res.status(200).json({ ...JSON.parse(raw), cached: true });
    } catch(e) {
      return res.status(200).json({ commentary: null, structured: null, cached: false });
    }
  }

  // Input klien di-cap defensif: excerpt resmi max 900 char (lihat _extractRingkasanExcerpt) —
  // body adalah input publik, jangan biarkan string raksasa menggelembungkan prompt AI.
  let ringkasanContext = req.body?.ringkasanContext || null;
  if (typeof ringkasanContext !== 'string' || !ringkasanContext.trim()) ringkasanContext = null;
  else if (ringkasanContext.length > 1200) ringkasanContext = ringkasanContext.slice(0, 1197) + '...';
  let ringkasanAt      = req.body?.ringkasanGeneratedAt || null;
  const clientOhlcv    = req.body?.ohlcvData       || null;

  // Fallback server-side untuk SEMUA pair (dulu GC=F saja): cron tidak punya browser,
  // dan user yang belum pernah buka tab Ringkasan tetap dapat konteks makro selama
  // latest_article masih hidup di Redis. Ekstraksi per-pair via _extractRingkasanExcerpt
  // (logic yang sama dengan client di index.html).
  if (!ringkasanContext) {
    try {
      const rawArticle = await redisCmd('GET', 'latest_article');
      if (rawArticle) {
        const artObj = JSON.parse(rawArticle);
        ringkasanContext = _extractRingkasanExcerpt(artObj.article || '', label || symbol, symbol === 'GC=F');
        if (ringkasanContext) ringkasanAt = artObj.generated_at || null;
      }
    } catch(e) { /* opsional — analisa tetap jalan tanpa konteks makro */ }
  }

  // Umur ringkasan: digest jalan ~3x/hari, excerpt bisa berjam-jam basi — tanpa
  // penanda umur AI menimbang narasi pre-rilis seolah kondisi sekarang.
  let makroAgeH = null;
  if (ringkasanContext && ringkasanAt) {
    const ms = Date.now() - new Date(ringkasanAt).getTime();
    if (!isNaN(ms) && ms >= 0) makroAgeH = Math.round(ms / 3600000 * 10) / 10;
  }

  try {
    let data = await loadOhlcvData(symbol, label || symbol);
    // Fallback: if Redis expired, use the client's cached data (same data shown in table)
    if (!data.h1.available && clientOhlcv?.h1?.available) {
      data = clientOhlcv;
    }
    if (!data.h1.available) return res.status(200).json({ commentary: null, error: 'OHLCV belum tersedia — tunggu GitHub Actions sync pertama.' });

    const textBlock = buildOhlcvText(data);
    const nowPrice = data.h1?.current;

    // Option expiries NY cut hari ini (fx_options_cache, ditulis /api/feeds?type=options,
    // TTL 4h) — level "magnet" intraday untuk pair ini, sebagai S/R tambahan konteks AI.
    // Data ini sudah lama diparse untuk tab TEK tapi belum pernah dikirim ke AI Analisa.
    let expiryBlock = '';
    try {
      const rawOpt = await redisCmd('GET', 'fx_options_cache');
      if (rawOpt) {
        const opt = JSON.parse(rawOpt);
        const ageOk = opt.fetched_at && (Date.now() - new Date(opt.fetched_at).getTime()) < 24 * 3600 * 1000;
        if (ageOk) {
          const lvls = _pickExpiryLevels(opt.expiries, data.label, nowPrice);
          if (lvls.length > 0) {
            expiryBlock = '\n\nOPTION EXPIRIES NY CUT HARI INI (level "magnet" intraday — harga cenderung tertarik ke cluster ini menjelang 15:00 NY / ~02:00 WIB; perlakukan sebagai S/R tambahan berlaku HARI INI saja, bukan sinyal arah):\n'
              + lvls.map(l => `- ${l.level}${l.size ? ` (${l.size})` : ''}`).join('\n');
          }
        }
      }
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache options kosong */ }

    // Blok fundamental terstruktur per pair — langsung dari cache Redis (cb_bias, COT,
    // risk regime), bukan turunan artikel. Best-effort: gagal baca = blok kosong.
    let fundBlock = '';
    try {
      const [rawBias, rawCot, rawRisk] = await Promise.all([
        redisCmd('GET', 'cb_bias'),
        redisCmd('GET', 'cot_cache_v2'),
        redisCmd('GET', 'risk_regime'),
      ]);
      fundBlock = _formatFundamentalBlock({
        label: data.label, isXau: data.is_xau,
        cbBias: rawBias ? JSON.parse(rawBias) : null,
        cot:    rawCot  ? JSON.parse(rawCot)  : null,
        risk:   rawRisk ? JSON.parse(rawRisk) : null,
        nowMs:  Date.now(),
      });
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache fundamental kosong */ }

    // Sentimen pasar options (CME CVOL) per pair — session 157 lanjutan 7. Cache
    // ditulis correlations.js (rr_cache_v2, TTL 1h), dibaca read-only di sini (tidak
    // memicu fetch CME baru — kalau cache kosong/expired, blok ini kosong, tidak
    // menunggu/gagalkan analisa). NZD/USD & USD/CHF tidak punya data (options CME
    // terlalu illiquid) — blok otomatis kosong untuk keduanya, bukan bug.
    let rrBlock = '';
    try {
      const rawRR = await redisCmd('GET', 'rr_cache_v2');
      if (rawRR) {
        const rrCache = JSON.parse(rawRR);
        rrBlock = _formatOptionsSentimentBlock(rrCache?.pairs?.[data.label]);
      }
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache RR kosong */ }

    const makroHeader = makroAgeH != null
      ? `KONTEKS MAKRO (dari Ringkasan ${makroAgeH} jam lalu${makroAgeH > 4 ? ' — SUDAH AGAK BASI: kalau ada rilis/berita besar setelah itu, beri bobot lebih rendah dan sebut ketidakpastiannya' : ''}):`
      : 'KONTEKS MAKRO:';
    const ctxParts = [];
    if (ringkasanContext) ctxParts.push(`${makroHeader}\n${ringkasanContext}`);
    if (fundBlock)        ctxParts.push(fundBlock);
    if (rrBlock)          ctxParts.push(rrBlock);
    ctxParts.push(`DATA TEKNIKAL:\n${textBlock}${expiryBlock}`);
    const makroBlock = ctxParts.join('\n\n');

    const extraCtx = [
      data.is_xau            ? 'volume XAU' : null,
      data.indicators?.available ? 'RSI/SMA Daily' : null,
      data.macd?.available   ? 'MACD H4' : null,
      data.atr?.available    ? 'ATR H1' : null,
      data.structure?.available  ? 'struktur H4' : null,
      data.sr_levels?.available  ? 'cluster S/R' : null,
      data.fib?.available        ? 'fibonacci' : null,
      data.patterns?.available   ? 'pola candle' : null,
      expiryBlock            ? 'option expiry' : null,
      ringkasanContext       ? 'konteks makro' : null,
      fundBlock              ? 'fundamental terstruktur' : null,
      rrBlock                ? 'sentimen options' : null,
    ].filter(Boolean).join(' + ');

    const p4Macro = (ringkasanContext || fundBlock)
      ? ' — kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR berlawanan jelas dengan struktur teknikal (misal makro risk-off tapi teknikal breakout bullish), sebut konflik itu eksplisit dan turunkan keyakinan setup, jangan diam-diam diabaikan; kesimpulanmu di sini harus konsisten dengan field makro_alignment'
      : '';
    const p3Atr = extraCtx?.includes('ATR') ? ', volatilitas berdasarkan ATR' : '';
    const p4Label = extraCtx ? `(${extraCtx})` : 'timeframe';
    const userMsg = [
      `Analisa ${data.label}:`,
      '',
      makroBlock,
      '',
      'Isi field JSON berikut:',
      '- bias: trend dominan — bullish/bearish/neutral/mixed. Dasarkan pada GABUNGAN trend Daily + [STRUKTUR H4] (HH+HL vs LH+LL) + BOS kalau ada — bukan cuma perubahan %. Pakai "mixed" kalau timeframe saling kontradiksi (misal Daily naik tapi struktur H4 LH+LL) atau makro vs teknikal berlawanan jelas — jangan paksa ke "neutral" kalau sebenarnya konflik, bukan tanpa-trend.',
      '- entry_zone: level atau range harga ideal untuk entry (angka konkret). WAJIB berpijak pada level STRUKTUR yang benar-benar ada di DATA TEKNIKAL: cluster [LEVEL S/R], level [FIBONACCI], [PIVOT HARIAN], Prev Day/Week H-L, swing H4, SMA, atau option expiry — jangan mengarang angka yang tidak ada di data. PRIORITASKAN KONFLUENSI: area di mana 2+ struktur berbeda jatuh berdekatan (misal fib 61.8% bertepatan dengan cluster S/R yang banyak disentuh dan pivot S1) — itu entry dengan dasar terkuat. WAJIB konsisten dengan harga "Now": kalau bias bearish, entry_zone >= Now (jual di rally ke resistance) ATAU di bawah Now kalau memang breakdown confirmation, TAPI jangan keduanya sekaligus. Kalau Now sudah melewati level breakdown/breakout relevan, jangan minta retracement ke arah berlawanan — definisikan entry di struktur terdekat dari Now. KALAU TIDAK ADA setup dengan dasar struktur jelas searah bias (misal struktur Mixed dan harga di tengah range, jauh dari semua level kuat), set entry_zone, sl, tp, entry_basis ke null dan jelaskan di trigger kondisi apa yang ditunggu — JANGAN memaksakan setup.',
      '- entry_basis: sebutkan struktur mana saja dari DATA TEKNIKAL yang jadi dasar entry_zone, dengan angkanya (contoh format: "fib 61.8% 1.1712 + cluster S/R 1.1709 (4x sentuh) + pivot S1 1.1705"). Minimal satu struktur bernama; makin banyak konfluensi makin baik. Kalau entry_zone null, field ini juga null.',
      '- sl: level stop loss konkret DI LUAR struktur yang melindungi entry — di balik swing H4, cluster S/R, atau Prev Day H/L yang ADA di data, dengan buffer minimal ~0.5x ATR-14 H1 dari level itu (jangan tepat di level, rawan wick hunt). Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.',
      '- tp: level take profit konkret = struktur berikutnya searah bias yang ADA di data (cluster S/R, swing, pivot, fib) — jangan mengarang. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. WAJIB risk/reward (jarak entry→tp dibanding entry→sl) minimal 1:1 — kalau struktur data tidak memungkinkan RR ≥1, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.',
      '- trigger: SATU kondisi price action spesifik yang HARUS terpenuhi sebelum entry — utamakan konfirmasi berbasis candle/pola di level konkret (misal "tunggu candle H4 close di bawah 1.1710" atau "tunggu rejection/pin bar H1 di area 3340") daripada indikator murni. Jangan sebut dua kondisi alternatif yang saling kontradiksi relatif ke Now. Manfaatkan [POLA CANDLE terdeteksi] kalau relevan.',
      '- invalidation_condition: kondisi spesifik yang membatalkan skenario ini sepenuhnya (beda dari sl — ini soal struktur/tesis, misal "kalau Daily close balik di bawah SMA50 atau swing low H4 terakhir jebol, bias bullish batal")',
      '- time_horizon_days: estimasi jumlah hari realistis skenario ini main out (angka, misal 3, 5, 10) berdasarkan jarak entry-tp dibanding rata-rata gerak harian (ATR/sigma) yang ada di data',
      '- makro_alignment: "searah" kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR mendukung arah bias teknikalmu, "konflik" kalau berlawanan, "netral" kalau sinyal makro tidak jelas/campuran. Kalau blok makro dan fundamental dua-duanya tidak tersedia di atas, isi null.',
      '- makro_alignment_reason: SATU kalimat pendek alasannya dengan menyebut data spesifik (misal "bias Fed Dovish + COT USD net short searah dengan bias bearish USD/JPY"). Null kalau makro_alignment null.',
      '',
      'Setelah objek JSON, di baris baru tulis PERSIS "===COMMENTARY===" lalu tulis commentary sebagai teks biasa (BUKAN di dalam JSON): analisa naratif mendalam 4-5 paragraf, pisah tiap paragraf dengan baris baru.',
      `Paragraf 1 — bias & posisi makro harga: arah trend Daily dengan alasan konkret (perubahan %, close vs open, posisi dalam range 6 bulan dari [KONTEKS 6 BULAN] — dekat puncak/lembah/tengah).`,
      `Paragraf 2 — struktur H4: pakai [STRUKTUR H4] (HH+HL / LH+LL / mixed) dan posisi harga terhadap cluster [LEVEL S/R] terdekat; fase akumulasi/distribusi/breakout; MACD H4 konfirmasi atau divergensi.`,
      `Paragraf 3 — momentum & pola: momentum H1 terkini, RSI H4 (arah naik/turun), pola candle yang terdeteksi dan artinya di posisi sekarang${p3Atr}, konfluensi atau perbedaan arah dengan H4.`,
      `Paragraf 4 — integrasi ${p4Label}: simpulkan kekuatan setup (berapa struktur yang konfluens di entry_zone), risiko utama, dan kondisi pasar yang memvalidasi atau membatalkan skenario ini${p4Macro}.`,
      'Setiap paragraf wajib sebut minimal 2 angka konkret (harga, %, atau nilai indikator). DILARANG kalimat generik tanpa angka (misal "harga bergerak sideways", "momentum masih lemah", "perlu konfirmasi lebih lanjut" tanpa data pendukung) — setiap klaim harus berpijak pada angka yang ada di DATA TEKNIKAL.',
    ].join('\n');

    // QUAL-14: commentary dikeluarkan dari JSON (lihat delimiter "===COMMENTARY===" di userMsg)
    // — prosa panjang 4-5 paragraf sebagai string JSON rawan gagal JSON.parse (kutip/newline
    // tak ter-escape), yang dulu bikin structured null dan bias/entry/sl/tp hilang total.
    const messages = [
      { role: 'system', content: 'Kamu analis senior teknikal dan makro. WAJIB jawab dalam DUA bagian persis seperti diminta: (1) SATU objek JSON valid tanpa markdown fence berisi HANYA field {"bias":"...","entry_zone":"...","entry_basis":"...","sl":"...","tp":"...","trigger":"...","invalidation_condition":"...","time_horizon_days":0,"makro_alignment":"...","makro_alignment_reason":"..."} — JANGAN sertakan field commentary di JSON ini; (2) setelah JSON, baris berisi PERSIS "===COMMENTARY===", lalu teks commentary biasa (bukan JSON, bebas tanda kutip/baris baru). Bahasa Indonesia.' },
      { role: 'user',   content: userMsg },
    ];

    const SAMBANOVA_KEY       = process.env.SAMBANOVA_API_KEY;
    const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
    let rawText = null, model = null;

    // Diagnostik sementara: ?test_samba_c1=1 skip primary buat request ini SAJA, supaya
    // fallback akun 2 bisa dites langsung tanpa nunggu primary gagal. Tidak mengubah
    // urutan fallback produksi — hanya bypass satu kali per request eksplisit.
    const testC1Only = req.query.test_samba_c1 === '1' || req.body?.test_samba_c1 === true;

    // Primary: SambaNova DeepSeek-V3.2 (671B, akun 1) — dikembalikan jadi primary (30s, timeout
    // asli). Eksperimen GLM-5.2/gpt-oss:120b sebagai primary dihentikan: alasan awal coba
    // model lain adalah cari yang LEBIH kuat dari DeepSeek-V3.2, tapi gpt-oss:120b (120B)
    // kemungkinan malah di bawahnya secara kualitas — jadi tidak masuk akal jadi primary
    // yang mengalahkan model yang sudah terbukti lebih kuat & sudah proven di app ini.
    if (!testC1Only && SAMBANOVA_KEY && await cb.canCall('ai:sambanova:main')) {
      try {
        if (!await allowAiCall('sambanova_main')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY}` },
          body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 1500, temperature: 0.3 }),
          signal: AbortSignal.timeout(30000),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
          if (rawText) await cb.onSuccess('ai:sambanova:main');
          else throw new Error('Empty response');
        } else { throw new Error(`HTTP ${r.status}`); }
      } catch(e) { console.warn('ohlcv_analyze SambaNova failed:', e.message); await cb.onFailure('ai:sambanova:main'); }
    } else if (testC1Only) { console.log('ohlcv_analyze: test_samba_c1=1 — bypassing primary'); }
    else if (SAMBANOVA_KEY) { console.log('ohlcv_analyze: SambaNova circuit OPEN — skipping to akun 2'); }

    // Fallback 1: SambaNova DeepSeek-V3.2 (akun 2, SAMBANOVA_API_KEY_CALL1) — akun terpisah
    // dari primary supaya rate-limit/outage di satu akun tidak menjatuhkan dua-duanya
    // sekaligus. Ollama Cloud (gpt-oss:120b) dan Groq (llama-3.3) yang tadinya di sini
    // sudah dicoret: live test (2026-07-10, ?test_ollama=1 x2) membuktikan Ollama timeout
    // 15s KONSISTEN ("operation was aborted due to timeout") sampai circuit ai:ollama OPEN
    // setelah 3x gagal beruntun, dan Groq/llama-3.3 kualitasnya paling rendah di rantai
    // ini — DeepSeek-V3.2 akun 2 jauh lebih kuat sebagai fallback tunggal. Timeout 25s
    // supaya total 30s (primary) + 25s tetap di bawah 60s hard limit Vercel.
    if (!rawText && SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1_ADMIN)) {
      try {
        if (!await allowAiCall('sambanova_c1')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY_CALL1}` },
          body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 1500, temperature: 0.3 }),
          signal: AbortSignal.timeout(25000),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
          if (rawText) await cb.onSuccess(CB_SAMBA_C1_ADMIN);
          else throw new Error('Empty response');
        } else { throw new Error(`HTTP ${r.status}`); }
      } catch(e) { console.warn('ohlcv_analyze SambaNova akun2 failed:', e.message); await cb.onFailure(CB_SAMBA_C1_ADMIN); }
    } else if (SAMBANOVA_KEY_CALL1) { console.log('ohlcv_analyze: SambaNova akun2 circuit OPEN'); }

    let structured = null, commentary = rawText;
    if (rawText) {
      try {
        // Split on the delimiter BEFORE touching JSON — commentary lives as plain text after it,
        // so it never needs to survive JSON string-escaping (root cause of QUAL-14 parse failures).
        const DELIM = '===COMMENTARY===';
        const delimIdx = rawText.indexOf(DELIM);
        const jsonPart = delimIdx !== -1 ? rawText.slice(0, delimIdx) : rawText;
        const commentaryPart = delimIdx !== -1 ? rawText.slice(delimIdx + DELIM.length).trim() : null;
        // Ekstrak objek JSON dengan cari { pertama dan } terakhir — robust terhadap
        // leading newline/whitespace sebelum code fence yang bikin regex ^``` gagal match.
        const jsonStart = jsonPart.indexOf('{');
        const jsonEnd   = jsonPart.lastIndexOf('}');
        const cleaned   = jsonStart !== -1 && jsonEnd !== -1
          ? jsonPart.slice(jsonStart, jsonEnd + 1)
          : jsonPart.replace(/```(?:json)?/gi, '').trim();
        const parsed  = JSON.parse(cleaned);
        // Normalize bias (incl. "mixed/conflicting" per QUAL-7 — don't force into neutral)
        const biasRaw = (parsed.bias || '').toLowerCase().replace(/[^a-z]/g, '');
        const mixedAliases = ['mixed', 'conflicting', 'campuran', 'konflik'];
        parsed.bias = ['bullish', 'bearish', 'neutral'].includes(biasRaw) ? biasRaw
          : mixedAliases.includes(biasRaw) ? 'mixed' : 'neutral';
        structured    = parsed;
        commentary    = commentaryPart || parsed.commentary || rawText;
        if (structured.time_horizon_days != null) {
          const h = Number(structured.time_horizon_days);
          structured.time_horizon_days = isNaN(h) ? null : h;
        }

        // Sanity-check entry_zone/sl/tp direction vs current price AND risk/reward —
        // drop the levels (keep bias/trigger/commentary) if the model produced a setup
        // that contradicts the live price it was given, or has RR < 1.
        if (structured.entry_zone && structured.sl && structured.tp && typeof nowPrice === 'number') {
          const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
          const entryNums = nums(structured.entry_zone);
          const slNum = nums(structured.sl)[0];
          const tpNum = nums(structured.tp)[0];
          if (entryNums.length && slNum != null && tpNum != null) {
            const entryLow = Math.min(...entryNums), entryHigh = Math.max(...entryNums);
            let valid = true;
            if (structured.bias === 'bearish') {
              valid = slNum > entryHigh && entryLow > tpNum && nowPrice < slNum && nowPrice > tpNum;
            } else if (structured.bias === 'bullish') {
              valid = slNum < entryLow && entryHigh < tpNum && nowPrice > slNum && nowPrice < tpNum;
            }
            // RR check (only meaningful once direction itself is valid)
            if (valid) {
              const entryMid = (entryLow + entryHigh) / 2;
              const risk = Math.abs(entryMid - slNum), reward = Math.abs(tpNum - entryMid);
              if (risk > 0) {
                structured.risk_reward = Math.round((reward / risk) * 100) / 100;
                if (reward / risk < 1) valid = false;
              }
            }
            if (!valid) {
              console.warn('ohlcv_analyze: entry/sl/tp inconsistent or RR<1 — dropping levels', { bias: structured.bias, entry_zone: structured.entry_zone, sl: structured.sl, tp: structured.tp, nowPrice, rr: structured.risk_reward });
              structured.entry_zone = structured.sl = structured.tp = null;
              structured.risk_reward = null;
            }
          }
        }
        // entry_basis hanya bermakna bersama entry_zone — ikut di-null kalau level
        // di-drop sanity check / model memang tidak memberi setup; buang juga non-string.
        if (typeof structured.entry_basis !== 'string' || !structured.entry_basis.trim() || !structured.entry_zone) {
          structured.entry_basis = null;
        }
        // Normalisasi makro_alignment: badge UI hanya kenal 3 nilai; paksa null kalau
        // memang tidak ada sumber makro/fundamental di prompt (model tidak boleh mengaku
        // menilai alignment dari data yang tidak dikirim).
        const ALIGN_CANON = new Map([
          ['searah', 'searah'], ['aligned', 'searah'],
          ['konflik', 'konflik'], ['conflict', 'konflik'], ['conflicting', 'konflik'],
          ['netral', 'netral'], ['neutral', 'netral'],
        ]);
        const alignRaw = String(structured.makro_alignment || '').toLowerCase().replace(/[^a-z]/g, '');
        structured.makro_alignment = (ringkasanContext || fundBlock) ? (ALIGN_CANON.get(alignRaw) || null) : null;
        structured.makro_alignment_reason = (structured.makro_alignment && typeof structured.makro_alignment_reason === 'string' && structured.makro_alignment_reason.trim())
          ? structured.makro_alignment_reason.trim()
          : null;
      } catch(e) {
        // Keep rawText as commentary, structured stays null
      }
    }

    const resultPayload = {
      commentary, structured, model,
      hasMakro: !!ringkasanContext,
      hasFund:  !!fundBlock,
      makro_generated_at: (ringkasanContext && ringkasanAt) ? ringkasanAt : null,
      loaded_at: new Date().toISOString(),
    };
    if (commentary || structured) {
      redisCmd('SET', `ohlcv_analysis:${symbol}`, JSON.stringify(resultPayload), 'EX', 21600).catch(() => {});
    }
    return res.status(200).json(resultPayload);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function ohlcvDashboardHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const pairs = await Promise.all(
      OHLCV_FIXED_PAIRS.map(async ({ symbol, label }) => {
        try {
          const raw = await redisCmd('GET', `ohlcv:${symbol}:1h`);
          if (!raw) return { symbol, label, available: false };
          const c = JSON.parse(raw);
          if (!Array.isArray(c) || c.length < 6) return { symbol, label, available: false };
          const isXau = symbol === 'GC=F';
          const isJpy = symbol.includes('JPY');
          const dec   = isXau ? 2 : isJpy ? 3 : 5;
          const c120  = c.slice(-120);
          const c24   = c.slice(-24);
          const curr  = +c120[c120.length - 1].c.toFixed(dec);
          const chg   = +((c120[c120.length - 1].c - c120[0].o) / c120[0].o * 100).toFixed(2);
          const older = c120.slice(0, Math.max(1, c120.length - 24));
          const avgO  = older.reduce((s, x) => s + x.c, 0) / older.length;
          const avgN  = c24.reduce((s, x) => s + x.c, 0) / c24.length;
          const t     = (avgN - avgO) / avgO * 100;
          const trend = t > 0.08 ? 'Uptrend' : t < -0.08 ? 'Downtrend' : 'Sideways';
          return { symbol, label, available: true, trend, current: curr, change_pct: chg, dec };
        } catch(e) {
          return { symbol, label, available: false };
        }
      })
    );
    return res.status(200).json({ pairs, fetched_at: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function circuitResetHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const source = req.query.source;
  const targets = source ? [source] : KNOWN_CIRCUITS;
  const reset = [], skipped = [];

  for (const src of targets) {
    try {
      await redisCmd('DEL', `circuit:${src}`);
      reset.push(src);
    } catch(e) {
      skipped.push({ src, error: e.message });
    }
  }
  return res.status(200).json({ ok: true, reset, skipped });
}

// ── Polymarket — prediction market probabilities untuk macro events ───────────
// Gamma API: public, no auth, no API key. Rate limit: 300 req/10s.
// outcomePrices[i] = implied probability (0–1) for outcomes[i]

// Category-weighted scoring — pure forex signal, no sports/crypto/entertainment
const POLY_SIGNAL_CATS = [
  { name: 'CB Policy',    w: 3, terms: ['fed cut','fed raise','rate cut','rate hike','rate decision','fomc','federal reserve','ecb rate','boe rate','boj rate','rba rate','rbnz rate','boc rate','snb rate','interest rate','monetary policy','powell','warsh','lagarde','bailey','ueda','waller','jefferson','basis point','central bank'] },
  { name: 'Macro Data',   w: 2, terms: ['cpi','inflation','nfp','jobs report','unemployment','gdp','recession','stagflation','soft landing','hard landing','pce','payroll','core cpi','consumer price','producer price','retail sales'] },
  { name: 'USD/Yields',   w: 2, terms: ['dollar index','dxy','treasury','yield curve','10-year','2-year','debt ceiling','us default','dollar fall','dollar rise','dollar strength'] },
  { name: 'Trade/Tariff', w: 2, terms: ['tariff','trade war','trade deal','trade agreement','import tax','export ban','trade deficit','trade surplus'] },
  { name: 'Geopolitical', w: 1, terms: ['ukraine','ceasefire','taiwan','iran','sanctions','nato','military conflict','missile','war end'] },
  { name: 'Commodity',    w: 1, terms: ['oil price','crude oil','opec','gold price','wti','brent','barrel','gold above','oil above'] },
  { name: 'Political',    w: 1, terms: ['trump','government shutdown','congress','senate','fiscal','debt limit'] },
];

function _polyScore(question) {
  const q = question.toLowerCase();
  let score = 0, topCat = null, topW = 0;
  for (const cat of POLY_SIGNAL_CATS) {
    for (const t of cat.terms) {
      if (q.includes(t)) {
        score += cat.w;
        if (cat.w > topW) { topW = cat.w; topCat = cat.name; }
        break; // each category counts once
      }
    }
  }
  return { score, category: topCat };
}

async function polymarketHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CACHE_KEY = 'polymarket_signal_v3'; // v3: score≥1, 50 results with categories
  const CACHE_TTL = 1800; // 30 min — prediction markets shift fast

  // Serve from cache if fresh
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      return res.status(200).json({ ...parsed, cached: true });
    }
  } catch(e) {}

  try {
    // Fetch top 200 active markets by volume — wide net, then score filter for signal
    const r = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&order=volume24hr&ascending=false&limit=200',
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) }
    );
    if (!r.ok) throw new Error(`Gamma API ${r.status}`);
    const markets = await r.json();

    // Score & filter: keep all categorized markets (score ≥1 = matched at least one category)
    const scored = markets
      .filter(m => m.outcomePrices && m.outcomes)
      .map(m => ({ m, ...(_polyScore(m.question || '')) }))
      .filter(x => x.score >= 1)
      .sort((a, b) => b.score - a.score || (b.m.volume24hr || 0) - (a.m.volume24hr || 0));

    const macro = scored.slice(0, 50).map(({ m, category }) => {
        const prices   = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '[]');
        const outcomes = Array.isArray(m.outcomes)      ? m.outcomes      : JSON.parse(m.outcomes      || '[]');
        const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
        const prob   = yesIdx >= 0 ? Math.round(parseFloat(prices[yesIdx] || 0) * 100) : null;
        return {
          question:  m.question,
          slug:      m.slug,
          category:  category || 'Macro',
          outcomes,
          prices:    prices.map(p => Math.round(parseFloat(p) * 100)),
          yes_prob:  prob,
          volume24h: Math.round(m.volume24hr || 0),
          end_date:  m.endDate,
        };
      });

    const payload = { markets: macro, fetched_at: new Date().toISOString(), cached: false };
    await redisCmd('SETEX', CACHE_KEY, CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    return res.status(200).json(payload);
  } catch(e) {
    // Fallback: stale cache
    try {
      const stale = await redisCmd('GET', CACHE_KEY);
      if (stale) return res.status(200).json({ ...JSON.parse(stale), cached: true, stale: true });
    } catch(_) {}
    return res.status(200).json({ markets: [], error: e.message, fetched_at: new Date().toISOString() });
  }
}

// Ekspor helper murni untuk unit test (module.exports = handler function; properti
// tambahan tidak mengganggu Vercel yang hanya memanggil function-nya).
module.exports._pickExpiryLevels = _pickExpiryLevels;
module.exports._findSwings = _findSwings;
module.exports._classifyStructure = _classifyStructure;
module.exports._clusterSrLevels = _clusterSrLevels;
module.exports._fibLevels = _fibLevels;
module.exports._dailyPivots = _dailyPivots;
module.exports._prevWeekHighLow = _prevWeekHighLow;
module.exports._detectCandlePatterns = _detectCandlePatterns;
module.exports._rsi14 = _rsi14;
module.exports.buildOhlcvText = buildOhlcvText;
module.exports.computeOhlcvMetrics = computeOhlcvMetrics;
module.exports.resampleTo4h = resampleTo4h;
module.exports._extractRingkasanExcerpt = _extractRingkasanExcerpt;
module.exports._formatFundamentalBlock = _formatFundamentalBlock;
