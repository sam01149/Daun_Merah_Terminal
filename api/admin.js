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
const newscat  = require('../newscat');
const { autoUpdateFundamentals } = require('./_fundamental_parser');
const { getLiveCbRates } = require('./_cb_rates');
const { configureVapid, sendWebPush } = require('./_webpush');
const { isCronCall: _isCronCallReq, isCronDedupFresh } = require('./_cron_dedup');
const marketHours = require('./_market_hours');
const cb = require('./_circuit_breaker');
const rateLimit = require('./_ratelimit');
const { allowAiCall } = require('./_ai_guard');
const { requireAppKey } = require('./_app_key');
const { fetchYahooOhlcv1h, fetchFallbackCandles, shouldSendYahooAlert, mapYahooSymbolToDeriv, fetchDerivCandles } = require('./_ohlcv_fetch');

// Hermes 3 405B Instruct via OpenRouter (free tier) — kandidat diagnostik dari riset
// user, sama seperti HERMES_MODEL di market-digest.js (circuit breaker key sengaja
// SAMA — satu account/model, bukan fitur terpisah). Uptime dilaporkan OpenRouter cuma
// ~55.79%, jadi TIDAK masuk rantai fallback produksi ohlcv_analyze — satu-satunya jalur
// panggil adalah ?test_hermes=1, yang skip SambaNova sepenuhnya (isolasi total) dan
// hasilnya TIDAK ditulis ke cache ohlcv_analysis:{symbol} (lihat testHermesOnly di bawah).
const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://financial-feed-app.vercel.app', 'X-Title': 'Daun Merah' };
const HERMES_MODEL       = 'nousresearch/hermes-3-llama-3.1-405b:free';
const CB_OPENROUTER_HERMES = 'ai:openrouter:hermes';

// Ollama Cloud — API native (BUKAN OpenAI-compatible), lihat callOllama() di
// market-digest.js untuk bentuk request/response persis (sengaja duplikasi kecil,
// bukan shared import — konvensi project ini, lihat komentar OPENROUTER di atas).
// nemotron-3-nano dipakai KHUSUS untuk diagnostik konektivitas (?test_ollama=1) —
// model terkecil/tercepat di keluarga Nemotron 3 Ollama Cloud, tujuannya murni "apakah
// akun/API Ollama Cloud reachable & terautentikasi", BUKAN kandidat kualitas (beda dari
// nemotron-3-ultra yang dipakai test_nemotron=1 di market-digest.js, kandidat serius
// Call 1). Tag `:30b-cloud` WAJIB (dicek ke ollama.com/library — beda dari nemotron-3-
// ultra yang cloud id-nya tanpa suffix sama sekali; nano punya beberapa varian ukuran
// jadi butuh tag eksplisit yang menunjuk varian cloud-nya, bukan lokal).
const OLLAMA_URL         = 'https://ollama.com/api/chat';
const OLLAMA_NANO_MODEL  = 'nemotron-3-nano:30b-cloud';
const CB_OLLAMA_NANO     = 'ai:ollama:nano';

// Actions callable from the frontend without a secret → rate-limited per IP.
// AI-triggering actions get a tighter budget than cache reads.
const PUBLIC_ACTION_LIMITS = {
  fundamental_get:      30,
  fundamental_refresh:  10,
  fundamental_analysis:  5,
  ohlcv_read:           30,
  ohlcv_analyze:         5,
  ohlcv_critic:          3,
  pre_entry_check:       3,
  ohlcv_dashboard:      30,
  setup_stats:          20,
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
  if (action === 'ohlcv_critic')       return ohlcvCriticHandler(req, res);
  if (action === 'pre_entry_check')    return preEntryCheckHandler(req, res);
  if (action === 'ohlcv_dashboard')    return ohlcvDashboardHandler(req, res);
  if (action === 'setup_stats')        return setupStatsHandler(req, res);
  if (action === 'polymarket')         return polymarketHandler(req, res);
  return res.status(400).json({ error: 'Missing ?action= — use health, redis-keys, admin-prompts, push, fundamental_get, fundamental_seed, fundamental_refresh, fundamental_analysis, journal_import, circuit-reset, circuit-status, gdpnow, ohlcv_sync, ohlcv_read, ohlcv_analyze, ohlcv_critic, pre_entry_check, ohlcv_dashboard, or polymarket' });
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
  vps_heartbeat:  [], // tidak ada cache turunan — hanya sinyal umur beat
  data_freshness: [], // self-heal-nya trigger ohlcv_sync (lihat trySelfHealOhlcvSync), bukan clear cache
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

// M1 (audit 2026-07-18): Yahoo Finance = titik gagal tunggal semua candle FX.
// Counter "gagal beruntun" dihitung per-RUN ohlcv_sync (bukan per-pair) — hanya
// naik kalau SEMUA pair butuh fallback/gagal di run itu (sinyal Yahoo down
// sistemik, bukan hiccup 1 simbol). Reset ke 0 begitu ada 1 pair sukses via Yahoo.
async function trackYahooHealth(yahooFullyDownThisRun) {
  try {
    if (!yahooFullyDownThisRun) {
      await redisCmd('DEL', 'yahoo_fail_streak');
      return;
    }
    const streak = Number(await redisCmd('INCR', 'yahoo_fail_streak')) || 1;
    const lastAlertRaw = await redisCmd('GET', 'yahoo_last_alert_ts');
    const lastAlertTs = lastAlertRaw ? Number(lastAlertRaw) : 0;
    const now = Date.now();
    if (shouldSendYahooAlert(streak, lastAlertTs, now)) {
      await sendHealthTelegram(
        `🔴 *Daun Merah — Yahoo Finance OHLCV Down*\n\n` +
        `${streak}x sync beruntun: semua pair jatuh ke fallback Twelve Data atau gagal total.\n` +
        `Cek status Yahoo Finance / kemungkinan IP block Vercel.\n\n` +
        `_Dicek: ${new Date(now).toISOString().substring(0, 16)} UTC_`
      );
      await redisCmd('SET', 'yahoo_last_alert_ts', String(now));
    }
  } catch (e) { console.warn('trackYahooHealth failed:', e.message); }
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

// Plan Q-1: daemon vps/heartbeat.js (Render free tier) menulis epoch tiap 60s
// dengan TTL 300s (EX 300) — key otomatis hilang kalau proses berhenti kirim
// beat. Key hilang PADAHAL 'vps:heartbeat:configured' (marker permanen, tanpa
// TTL, ditulis sekali oleh heartbeat.js saat beat pertama) sudah ada berarti
// daemon sempat jalan lalu benar-benar mati — itu baru DOWN asli (alert
// Telegram). Kalau marker itu SENDIRI belum ada, artinya Render belum pernah
// di-deploy — status UNCONFIGURED (pola sama probeFred), BUKAN DOWN, supaya
// tidak spam alert sebelum user sempat deploy. Gate Q-1: tidak boleh ada gap
// >5 menit selama 7 hari berturut-turut, dihitung SETELAH daemon terkonfirmasi jalan.
async function probeVpsHeartbeat() {
  const raw = await redisCmd('GET', 'vps:heartbeat');
  if (raw) {
    const ageMs = Date.now() - Number(raw) * 1000;
    if (ageMs > 5 * 60 * 1000) throw new Error(`Heartbeat basi: ${Math.round(ageMs / 1000)}s sejak beat terakhir`);
    return { age_seconds: Math.round(ageMs / 1000) };
  }
  const everConfigured = await redisCmd('GET', 'vps:heartbeat:configured');
  if (!everConfigured) return { status: 'UNCONFIGURED', note: 'Render belum di-deploy — lihat vps/README-deploy.md' };
  throw new Error('vps:heartbeat hilang >5 menit — daemon sempat aktif, sekarang tidak terdeteksi');
}

// SELF-HEALING sisi Vercel (jalan walau daemon Railway mati total): probe umur
// candle sentinel EURUSD. Basi >3 jam saat market FX buka = SEMUA jalur pengisi
// (stream daemon, cron daemon, GH Actions) sedang gagal → healthHandler tidak
// cuma melapor DOWN tapi langsung memicu ohlcv_sync (lihat trySelfHealOhlcvSync).
// Kunci dedup Redis `selfheal:ohlcv_sync` SENGAJA sama dengan supervisor
// vps/daemon.js — dua lapisan ini saling dedup, tidak dobel trigger.
async function probeDataFreshness() {
  const raw = await redisCmd('GET', 'ohlcv:EURUSD=X:1h');
  let arr = null;
  try { arr = raw ? JSON.parse(raw) : null; } catch(_) { arr = null; }
  const newest = marketHours.newestCandleEpoch(arr);
  const ageMins = newest != null ? Math.round((Date.now() - newest * 1000) / 60000) : null;
  if (!marketHours.isFxMarketOpen(new Date())) {
    return { note: 'market FX tutup — umur candle tidak dinilai', candle_age_mins: ageMins, sentinel: 'EURUSD=X' };
  }
  if (marketHours.isCandleStale(arr, Date.now())) {
    throw new Error(newest == null
      ? 'ohlcv:EURUSD=X:1h kosong/tidak terbaca padahal market buka'
      : `candle terakhir ${ageMins} menit lalu (ambang 180) padahal market buka`);
  }
  return { candle_age_mins: ageMins, sentinel: 'EURUSD=X' };
}

// Fire-and-forget self-heal: NX 1 jam anti spam, lalu panggil ohlcv_sync di
// host sendiri. Timeout klien 5 detik DISENGAJA pendek — begitu request sampai,
// invocation ohlcv_sync jalan sampai selesai di function-nya sendiri (maxDuration
// 60s) walau klien ini sudah putus; health check tidak perlu menunggu hasilnya.
async function trySelfHealOhlcvSync(req) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return { attempted: false, reason: 'CRON_SECRET kosong' };
  try {
    const got = await redisCmd('SET', 'selfheal:ohlcv_sync', '1', 'NX', 'EX', 3600);
    if (got !== 'OK') return { attempted: false, reason: 'heal sudah dicoba <1 jam lalu, masih menunggu hasil' };
  } catch(e) { return { attempted: false, reason: `Redis: ${e.message}` }; }
  const host = req.headers.host || 'financial-feed-app.vercel.app';
  try {
    await fetch(`https://${host}/api/admin?action=ohlcv_sync`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal: AbortSignal.timeout(5000),
    });
    console.log('health: self-heal — ohlcv_sync dipicu karena candle sentinel basi saat market buka');
    return { attempted: true };
  } catch(e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.log('health: self-heal — ohlcv_sync dipicu (fire-and-forget, klien putus duluan by design)');
      return { attempted: true, note: 'fire-and-forget' };
    }
    return { attempted: false, reason: e.message };
  }
}

const PROBES = {
  fred:           { fn: probeFred,           label: 'FRED API' },
  stooq:          { fn: probeStooq,          label: 'Stooq CSV' },
  forexfactory:   { fn: probeForexFactory,   label: 'ForexFactory' },
  financialjuice: { fn: probeFinancialJuice, label: 'FinancialJuice RSS' },
  cftc:           { fn: probeCFTC,           label: 'CFTC COT' },
  redis:          { fn: probeRedis,          label: 'Upstash Redis' },
  vps_heartbeat:  { fn: probeVpsHeartbeat,   label: 'VPS Heartbeat (Plan Q-1)' },
  data_freshness: { fn: probeDataFreshness,  label: 'Data Freshness (candle FX)' },
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

  // SELF-HEALING: candle basi terdeteksi → langsung sembuhkan (trigger
  // ohlcv_sync), bukan hanya alert. Hasil percobaan dilampirkan ke report
  // supaya terlihat di respons health & log cron.
  if (report.data_freshness && report.data_freshness.status === 'DOWN') {
    report.data_freshness.self_heal = await trySelfHealOhlcvSync(req);
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
  { key: 'vps:heartbeat',        owner: 'vps/heartbeat.js',      ttl_expected: 300,    note: 'Plan Q-1: epoch beat daemon Render, dibaca api/admin.js?action=health source=vps_heartbeat' },
  { key: 'vps:heartbeat:configured', owner: 'vps/heartbeat.js',  ttl_expected: null,   note: 'Plan Q-1: marker permanen "daemon pernah jalan" — beda UNCONFIGURED (belum deploy) vs DOWN asli' },
  { key: 'selfheal:ohlcv_sync',      owner: 'api/admin.js + vps/daemon.js', ttl_expected: 3600,  note: 'NX lock self-heal: candle basi → trigger ohlcv_sync otomatis, maks 1x/jam lintas dua lapisan' },
  { key: 'selfheal:ohlcv_alert_ts',  owner: 'vps/daemon.js',     ttl_expected: 86400,  note: 'Dedup 6 jam alert Telegram "self-heal gagal, candle masih basi setelah trigger otomatis"' },
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

// Session 158: matching pindah ke engine word-boundary newscat.js — substring
// polos bikin salah kategori push ("software"⊂'war'→geopolitical, "turmoil"⊂
// 'oil'→energy). Daftar keyword tetap di _push_keywords.js (tuning kebisingan
// push sengaja beda dari filter feed), urutan first-match juga dipertahankan.
const PUSH_RX = Object.fromEntries(
  Object.entries(PUSH_KW).map(([k, list]) => [k, newscat.compileList(list)])
);
const PUSH_CAT_ORDER = [
  ['MARKET_MOVING', 'market-moving'],
  ['FOREX',         'forex'],
  ['ENERGY',        'energy'],
  ['MACRO',         'macro'],
  ['GEOPOLITICAL',  'geopolitical'],
  ['ECON_DATA',     'econ-data'],
];
function detectPushCat(t) {
  t = newscat.normalize(t);
  // Rilis kalender (Actual + Forecast/Previous) selalu econ-data — tanpa ini
  // "Korea Trade Balance Actual …" nyangkut duluan di GEOPOLITICAL via 'korea*'.
  if (newscat.isCalendarRelease(t)) return 'econ-data';
  for (const [key, cat] of PUSH_CAT_ORDER) {
    if (newscat.anyMatch(t, PUSH_RX[key])) return cat;
  }
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

// Gemini AI Studio — fallback terakhir fundamental_analysis + journal AI Coach
// (2026-07-19). Konstanta sama dengan market-digest.js (GEMINI_URL/GEMINI_MODEL/
// CB_GEMINI di sana): endpoint OpenAI-compat resmi, alias -latest supaya tidak basi
// saat Google ganti generasi (sekarang resolve ke gemini-3.5-flash). Lolos gate ToS
// produksi (daun_merah_riset.md S183: free tier boleh produksi, prompt = berita
// publik). Budget guard 'gemini' sudah ada di _ai_guard.js. NVIDIA API (GLM 5.2/
// Nemotron) SENGAJA tidak dipakai — ToS Trial melarang produksi, lihat KEPUTUSAN
// GATE AWAL di daun_merah_riset.md.
const GEMINI_URL_FUND   = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL_FUND = 'gemini-flash-latest';
const CB_GEMINI_ADMIN   = 'ai:gemini'; // circuit dipakai bersama market-digest.js & journal.js — provider sama

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

// Umur data dalam hari dari field `date` entri fundamental ("YYYY-MM-DD" dari parser
// headline; seed lama pakai '—' = tidak diketahui). Return null kalau tak bisa dihitung.
function _fundAgeDays(dateStr, nowMs = Date.now()) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(String(dateStr))) return null;
  const ms = nowMs - new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}

// Satu baris data untuk prompt AI fundamental. Dulu cuma "key: actual (period)" —
// previous & date yang SUDAH tersimpan di Redis dibuang, jadi AI menilai level statis
// tanpa arah perubahan dan tanpa tahu datanya segar atau basi (audit 2026-07-19).
function _formatFundDataLine(key, v, nowMs = Date.now()) {
  const parts = [`  ${key}: ${v.actual || '—'} (${v.period || '—'})`];
  const extras = [];
  const age = _fundAgeDays(v.date, nowMs);
  if (age !== null) extras.push(age === 0 ? 'rilis hari ini' : `rilis ${age} hari lalu`);
  if (v.previous && v.previous !== '—' && v.previous !== v.actual) extras.push(`sebelumnya ${v.previous}`);
  if (extras.length > 0) parts.push(` [${extras.join('; ')}]`);
  return parts.join('');
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

  const nowMs = Date.now();
  const dataBlock = FUND_CURRENCIES.map(cur => {
    const d = fundData[cur] || {};
    const lines = Object.entries(d)
      .map(([k, v]) => _formatFundDataLine(k, v, nowMs))
      .join('\n');
    return `${cur}:\n${lines || '  (no data)'}`;
  }).join('\n\n');

  const prompt = `Kamu adalah analis forex makro. Berikut data fundamental ekonomi terbaru per currency:

${dataBlock}

Berdasarkan data di atas, analisis dan rankingkan 8 currency dari TERKUAT hingga TERLEMAH dari sisi fundamental ekonomi.

ATURAN BOBOT WAKTU (penting — pasar men-trade data terbaru, bukan level lama):
- Beri bobot TERBESAR pada data dengan tag "rilis <=14 hari lalu", terutama yang berubah vs "sebelumnya" — arah perubahan (membaik/memburuk) lebih penting daripada level absolutnya.
- Data tanpa tag rilis atau lebih tua dari ~45 hari perlakukan sebagai latar belakang, BUKAN bukti utama ranking.
- Currency yang beberapa rilis terbarunya konsisten membaik layak naik ranking meski levelnya biasa saja; sebaliknya level bagus yang datanya basi dan mulai memburuk harus turun.

Pertimbangkan juga:
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

  // Fallback 3: Gemini flash (2026-07-19) — last resort baru setelah Groq. Free tier
  // AI Studio, lolos gate ToS produksi (lihat komentar konstanta GEMINI_URL_FUND).
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!analysis && GEMINI_KEY && await cb.canCall(CB_GEMINI_ADMIN)) {
    try {
      if (!await allowAiCall('gemini')) throw new Error('AI daily budget exceeded');
      const r = await fetch(GEMINI_URL_FUND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_KEY}` },
        body: JSON.stringify({ model: GEMINI_MODEL_FUND, messages: fundMessages, max_tokens: 1500, temperature: 0.3, reasoning_effort: 'low' }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      const txt = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!txt) throw new Error('Empty response');
      analysis = txt;
      await cb.onSuccess(CB_GEMINI_ADMIN);
      console.log('fundamental_analysis: Gemini fallback OK');
    } catch(e) {
      console.warn('fundamental_analysis Gemini fallback failed:', e.message);
      await cb.onFailure(CB_GEMINI_ADMIN);
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

const KNOWN_CIRCUITS = ['ai:openrouter', 'ai:openrouter:nemotron', 'ai:openrouter:nemotron-super', 'ai:openrouter:hermes', 'ai:cerebras', 'ai:cerebras:gptoss', 'ai:cerebras:glm', 'ai:sambanova:c1', 'ai:sambanova:main', 'ai:ollama:nemotron', 'ai:deepseek', 'ai:gemini', 'fred', 'stooq', 'ff', 'fj', 'cftc', 'redis', 'fxssi', 'actionforex'];

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

  // Plan P (2026-07-18): Deriv primary untuk pair FX — dicoba BERURUTAN (bukan
  // paralel per pair, edge case Plan P: "jangan loop 15 pair paralel tanpa jeda dari
  // satu function") sebelum masuk fan-out Yahoo di bawah. GC=F (XAU/USD) TIDAK
  // dipetakan, otomatis lewat ke Yahoo seperti biasa. Hasil disimpan per symbol,
  // dikonsumsi loop paralel Yahoo/TwelveData di bawah — pair yang sudah dapat Deriv
  // skip Yahoo sepenuhnya (satu array satu sumber, tidak pernah gabung).
  // Guard budget (Plan P): kalau Deriv down TOTAL, loop sekuensial 7 pair x 2
  // interval x timeout 8s bisa sampai 112s — jauh lewat batas 60s Vercel/55s GH
  // Actions. Berhenti mencoba Deriv untuk pair SISA begitu elapsed lewat ambang,
  // biar masih ada waktu cukup untuk fan-out Yahoo di bawah untuk semua pair.
  const derivPrefetchStart = Date.now();
  const DERIV_PREFETCH_BUDGET_MS = 20000;
  const derivResults = new Map(); // symbol -> { candles1h, candles1d }
  for (const { symbol } of pairsToSync) {
    if (!mapYahooSymbolToDeriv(symbol)) continue; // GC=F — bukan kandidat Deriv
    if (Date.now() - derivPrefetchStart > DERIV_PREFETCH_BUDGET_MS) {
      console.warn(`ohlcv_sync: Deriv prefetch budget habis — sisa pair langsung ke Yahoo`);
      break;
    }
    const entry = { candles1h: null, candles1d: null };
    try { entry.candles1h = await fetchDerivCandles(symbol, '1h', 250); }
    catch (e) { console.warn(`ohlcv_sync: Deriv 1h ${symbol} gagal (${e.message}), fallback Yahoo`); }
    try { entry.candles1d = await fetchDerivCandles(symbol, '1d', 140); }
    catch (e) { console.warn(`ohlcv_sync: Deriv 1d ${symbol} gagal (${e.message}), fallback Yahoo`); }
    derivResults.set(symbol, entry);
  }

  // Fetch all pairs in parallel — individual failures don't block others.
  // M1 (2026-07-18): Yahoo gagal/0 candle -> fallback Twelve Data (no-op kalau
  // TWELVEDATA_API_KEY belum diset — fetchFallbackCandles throw, error asli tetap
  // dilempar lewat catch di bawah, perilaku identik sebelum M1 ada).
  const results = await Promise.allSettled(
    pairsToSync.map(async ({ symbol, label }) => {
      const deriv = derivResults.get(symbol);

      let candles1h, source1h = 'yahoo';
      if (deriv?.candles1h) {
        candles1h = deriv.candles1h; source1h = 'deriv';
      } else {
        try {
          candles1h = await fetchYahooOhlcv1h(symbol);
          if (candles1h.length === 0) throw new Error(`${symbol}: empty candles`);
        } catch (yahooErr) {
          candles1h = await fetchFallbackCandles(symbol, '1h');
          source1h = 'twelvedata';
        }
      }

      const candles4h = resampleTo4h(candles1h);

      let candles1d, source1d = 'yahoo';
      if (deriv?.candles1d) {
        candles1d = deriv.candles1d; source1d = 'deriv';
      } else {
        try {
          candles1d = await fetchYahooOhlcvDaily(symbol);
          if (candles1d.length === 0) throw new Error(`${symbol}: empty daily candles`);
        } catch (yahooErr) {
          candles1d = await fetchFallbackCandles(symbol, '1d');
          source1d = 'twelvedata';
        }
      }

      // Store 3 TFs + source tag (diagnosa M1) in parallel
      await Promise.all([
        redisCmd('SET', `ohlcv:${symbol}:1h`, JSON.stringify(candles1h.slice(-120)), 'EX', '90000'), // 25h TTL
        redisCmd('SET', `ohlcv:${symbol}:4h`, JSON.stringify(candles4h.slice(-60)),  'EX', '90000'), // 25h TTL
        redisCmd('SET', `ohlcv:${symbol}:1d`, JSON.stringify(candles1d.slice(-135)), 'EX', '90000'), // 25h TTL
        redisCmd('SET', `ohlcv:${symbol}:source`, JSON.stringify({ '1h': source1h, '1d': source1d }), 'EX', '90000'),
      ]);

      const n1h = Math.min(120, candles1h.length), n4h = Math.min(60, candles4h.length), n1d = Math.min(135, candles1d.length);
      console.log(`ohlcv_sync: ${label} — 1H:${n1h}(${source1h}) 4H:${n4h} 1D:${n1d}(${source1d})`);
      return { symbol, label, count1h: n1h, count4h: n4h, count1d: n1d, source1h, source1d };
    })
  );

  const synced = results
    .filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results
    .filter(r => r.status === 'rejected')
    .map((r, i) => ({ symbol: pairsToSync[i]?.symbol, error: r.reason?.message }));

  // M1: run ini dianggap "Yahoo down sistemik" kalau TIDAK ADA satu pair pun yang
  // berhasil via Yahoo (semua fallback/gagal) — hindari alert dari hiccup 1 simbol.
  await trackYahooHealth(!synced.some(s => s.source1h === 'yahoo'));

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

  // Plan P (2026-07-18): Deriv primary untuk 14 pair FX — dicoba dulu SEBELUM Yahoo.
  // GC=F (XAU/USD) TIDAK dipetakan (lihat catatan scope di _ohlcv_fetch.js), jadi
  // otomatis lewat ke alur Yahoo→TwelveData di bawah, TIDAK berubah untuk emas.
  const derivEligible = !!mapYahooSymbolToDeriv(symbol);
  let candles1h = null, source1h = null, candles1d = null, source1d = null;
  if (derivEligible) {
    const [rd1h, rd1d] = await Promise.allSettled([
      fetchDerivCandles(symbol, '1h', 250),
      fetchDerivCandles(symbol, '1d', 140),
    ]);
    if (rd1h.status === 'fulfilled') { candles1h = rd1h.value; source1h = 'deriv'; }
    else console.warn(`refreshOhlcvFromYahoo: Deriv 1h ${symbol} gagal (${rd1h.reason?.message}), fallback Yahoo`);
    if (rd1d.status === 'fulfilled') { candles1d = rd1d.value; source1d = 'deriv'; }
    else console.warn(`refreshOhlcvFromYahoo: Deriv 1d ${symbol} gagal (${rd1d.reason?.message}), fallback Yahoo`);
  }

  // Aturan anti-campur-sumber (Plan P-3): hanya minta Yahoo untuk interval yang BELUM
  // didapat dari Deriv — satu array candle HARUS dari satu sumber, tidak pernah gabung.
  const need1h = !candles1h, need1d = !candles1d;
  const [r1h, r1d] = await Promise.allSettled([
    need1h ? fetchYahooOhlcv1h(symbol) : Promise.resolve(null),
    need1d ? fetchYahooOhlcvDaily(symbol) : Promise.resolve(null),
  ]);

  // M1: kalau Yahoo gagal/0 candle di jalur on-demand ini, coba Twelve Data sebelum
  // menyerah — no-op (tetap reject) kalau TWELVEDATA_API_KEY belum diset.
  if (need1h) {
    candles1h = (r1h.status === 'fulfilled' && r1h.value?.length) ? r1h.value : null;
    source1h = candles1h ? 'yahoo' : null;
    if (!candles1h) {
      try { candles1h = await fetchFallbackCandles(symbol, '1h'); source1h = 'twelvedata'; } catch (e) {}
    }
  }
  if (need1d) {
    candles1d = (r1d.status === 'fulfilled' && r1d.value?.length) ? r1d.value : null;
    source1d = candles1d ? 'yahoo' : null;
    if (!candles1d) {
      try { candles1d = await fetchFallbackCandles(symbol, '1d'); source1d = 'twelvedata'; } catch (e) {}
    }
  }

  const writes = [];
  if (candles1h) {
    const candles4h = resampleTo4h(candles1h);
    writes.push(redisCmd('SET', `ohlcv:${symbol}:1h`, JSON.stringify(candles1h.slice(-120)), 'EX', '90000'));
    writes.push(redisCmd('SET', `ohlcv:${symbol}:4h`, JSON.stringify(candles4h.slice(-60)),  'EX', '90000'));
  }
  if (candles1d) {
    writes.push(redisCmd('SET', `ohlcv:${symbol}:1d`, JSON.stringify(candles1d.slice(-135)), 'EX', '90000'));
  }
  if (candles1h || candles1d) {
    writes.push(redisCmd('SET', `ohlcv:${symbol}:source`, JSON.stringify({ '1h': source1h || 'yahoo', '1d': source1d || 'yahoo' }), 'EX', '90000'));
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

// ── Zona konfluensi deterministik (session 166) ───────────────────────────────
// Akar masalah "hasil Analisa AI lompat-lompat tiap re-generate": AI dibiarkan
// MEMILIH sendiri level entry dari belasan kandidat struktur yang tersebar di prompt
// (S/R, fib, pivot, prev day/week, swing H4, SMA, expiry) + temperature sampling —
// dua generate dengan data sama persis bisa menghasilkan zona berbeda. Fungsi ini
// memindahkan pemilihannya ke kode: kumpulkan semua level struktur, cluster yang
// berdekatan (≤ tolerance ~0.35x ATR Daily), skor = jumlah struktur yang bertumpuk
// (S/R diberi bobot ekstra dari sentuhan, expiry setengah bobot karena berlaku 1 hari),
// lalu ranking. AI tinggal MENARASIKAN zona teratas, bukan memilih bebas.
// Pure function — dites di test/ta_struct.test.js.
function _confluenceZones(data, expiryLvls) {
  const dec = data?.dec ?? 5;
  const now = data?.h1?.available ? data.h1.current : null;
  if (typeof now !== 'number' || isNaN(now)) return null;
  const f = n => n.toFixed(dec);
  const cands = [];
  const add = (price, name, w = 1) => {
    const p = typeof price === 'number' ? price : parseFloat(price);
    if (!isNaN(p) && p > 0) cands.push({ price: p, name, w });
  };
  for (const l of data.sr_levels?.above || []) add(l.price, `S/R ${f(l.price)} (${l.touches}x sentuh)`, 1 + Math.min(2, Math.max(0, l.touches - 1) * 0.25));
  for (const l of data.sr_levels?.below || []) add(l.price, `S/R ${f(l.price)} (${l.touches}x sentuh)`, 1 + Math.min(2, Math.max(0, l.touches - 1) * 0.25));
  if (data.fib?.available) {
    add(data.fib.f382, `fib 38.2% ${f(data.fib.f382)}`);
    add(data.fib.f500, `fib 50% ${f(data.fib.f500)}`);
    add(data.fib.f618, `fib 61.8% ${f(data.fib.f618)}`);
  }
  const piv = data.ref_levels?.available ? data.ref_levels.pivots : null;
  if (piv) {
    add(piv.p, `pivot P ${f(piv.p)}`);
    add(piv.r1, `pivot R1 ${f(piv.r1)}`); add(piv.s1, `pivot S1 ${f(piv.s1)}`);
    add(piv.r2, `pivot R2 ${f(piv.r2)}`); add(piv.s2, `pivot S2 ${f(piv.s2)}`);
  }
  const pd = data.ref_levels?.available ? data.ref_levels.prev_day : null;
  if (pd) { add(pd.high, `prev day high ${f(pd.high)}`); add(pd.low, `prev day low ${f(pd.low)}`); }
  const pw = data.ref_levels?.available ? data.ref_levels.prev_week : null;
  if (pw) { add(pw.high, `prev week high ${f(pw.high)}`); add(pw.low, `prev week low ${f(pw.low)}`); }
  for (const s of data.h4?.swing_highs || []) add(s.price, `swing high H4 ${f(s.price)}`);
  for (const s of data.h4?.swing_lows  || []) add(s.price, `swing low H4 ${f(s.price)}`);
  if (data.indicators?.available) {
    if (data.indicators.sma_50  != null) add(data.indicators.sma_50,  `SMA50 Daily ${f(data.indicators.sma_50)}`);
    if (data.indicators.sma_200 != null) add(data.indicators.sma_200, `SMA200 Daily ${f(data.indicators.sma_200)}`);
  }
  for (const l of expiryLvls || []) add(l.num, `option expiry ${l.level}${l.size ? ` (${l.size})` : ''}`, 0.5);
  if (cands.length === 0) return null;

  const atrD = (data.d1_ext?.available && data.d1_ext.atr_d != null) ? data.d1_ext.atr_d : null;
  const tol = atrD != null ? atrD * 0.35 : now * 0.0015;

  cands.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const c of cands) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.price - last.sum / last.n) <= tol) {
      last.sum += c.price; last.n++; last.score += c.w; last.members.push(c.name);
    } else {
      clusters.push({ sum: c.price, n: 1, score: c.w, members: [c.name] });
    }
  }
  const built = clusters.map(z => ({
    center:  +(z.sum / z.n).toFixed(dec),
    score:   +z.score.toFixed(2),
    members: z.members,
  }));
  // Ranking: skor tertinggi dulu; seri → yang paling dekat ke Now menang (lebih
  // actionable buat entry). Max 3 zona per sisi supaya prompt tetap ringkas.
  const rank = arr => [...arr].sort((a, b) => b.score - a.score || Math.abs(a.center - now) - Math.abs(b.center - now)).slice(0, 3);
  const out = {
    now:       +now.toFixed(dec),
    tolerance: +tol.toFixed(dec),
    above:     rank(built.filter(z => z.center >= now)),
    below:     rank(built.filter(z => z.center <  now)),
  };
  if (out.above.length === 0 && out.below.length === 0) return null;
  return out;
}

// ── Outcome logging setup Analisa AI (Tier 1 riset, session 166) ──────────────
// Setiap setup lengkap (entry/sl/tp) yang dihasilkan ohlcv_analyze dicatat ke Redis
// `setup_log:v1`, lalu dievaluasi lazy tiap kali `?action=setup_stats` dipanggil
// (tanpa cron baru, tanpa AI call): candle 1H sejak setup dibuat menentukan apakah
// harga MASUK zona entry dulu (pending→open), lalu kena TP atau SL duluan. Dari sini
// win-rate NYATA per pair bisa dihitung — bukan self-assessment "keyakinan" LLM.
//
// Status: pending (belum fill) → open (sudah masuk zona) → tp | sl | ambiguous
// (TP & SL tersentuh di candle 1H yang sama — tidak bisa tahu urutannya, JANGAN
// dihitung menang/kalah); pending terlalu lama → expired; gap data (candle tertua
// > 24 jam setelah setup dibuat, tidak tahu apa yang terjadi) → stale.
// Pure function — dites di test/ta_struct.test.js.
function _evaluateSetups(setups, candlesBySymbol, nowMs) {
  const DAY = 86400000;
  const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
  for (const st of setups || []) {
    if (!st || (st.status !== 'pending' && st.status !== 'open')) continue;
    const e = nums(st.entry_zone), sl = nums(st.sl)[0], tp = nums(st.tp)[0];
    if (!e.length || sl == null || tp == null || (st.bias !== 'bullish' && st.bias !== 'bearish')) {
      st.status = 'invalid';
      continue;
    }
    const eLo = Math.min(...e), eHi = Math.max(...e);
    const all = candlesBySymbol?.[st.symbol] || [];
    // Gap data: setup masih pending tapi candle tertua yang tersedia sudah > 24 jam
    // setelah setup dibuat — kejadian di gap tidak diketahui, jangan mengarang hasil.
    if (st.status === 'pending' && all.length && all[0].t * 1000 > st.ts + DAY) {
      st.status = 'stale';
      continue;
    }
    for (const c of all) {
      if (c.t * 1000 <= st.ts) continue;
      if (st.status === 'pending') {
        const filled = st.bias === 'bearish' ? c.h >= eLo : c.l <= eHi;
        if (filled) { st.status = 'open'; st.filled_t = c.t; }
      }
      if (st.status === 'open') {
        const hitSl = st.bias === 'bearish' ? c.h >= sl : c.l <= sl;
        const hitTp = st.bias === 'bearish' ? c.l <= tp : c.h >= tp;
        if (hitSl && hitTp) { st.status = 'ambiguous'; st.closed_t = c.t; break; }
        if (hitSl) { st.status = 'sl'; st.closed_t = c.t; break; }
        if (hitTp) { st.status = 'tp'; st.closed_t = c.t; break; }
      }
    }
    const horizonMs = Math.max(2, st.horizon_days || 5) * 1.5 * DAY;
    if (st.status === 'pending' && nowMs - st.ts > horizonMs) st.status = 'expired';
  }
  return setups;
}

// Agregat statistik dari log setup. Ambiguous TIDAK masuk pembagi win-rate.
function _aggSetupStats(arr) {
  const by = s => arr.filter(x => x.status === s).length;
  const tp = by('tp'), sl = by('sl');
  return {
    total: arr.length,
    pending: by('pending'), open: by('open'),
    tp, sl, ambiguous: by('ambiguous'), expired: by('expired'), stale: by('stale') + by('invalid'),
    win_rate: (tp + sl) > 0 ? Math.round(tp / (tp + sl) * 100) : null,
  };
}

async function setupStatsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const raw = await redisCmd('GET', 'setup_log:v1');
    if (!raw) return res.status(200).json({ symbols: {}, global: _aggSetupStats([]), recent: [] });
    let log = JSON.parse(raw);
    if (!Array.isArray(log)) log = [];
    // Evaluasi lazy hanya symbol yang punya setup aktif — hemat Redis call
    const active = [...new Set(log.filter(s => s && (s.status === 'pending' || s.status === 'open')).map(s => s.symbol))];
    const candlesBySymbol = {};
    await Promise.all(active.map(async sym => {
      try {
        const r = await redisCmd('GET', `ohlcv:${sym}:1h`);
        if (r) candlesBySymbol[sym] = JSON.parse(r);
      } catch (e) { /* candle hilang → setup symbol itu tetap pending */ }
    }));
    const before = JSON.stringify(log);
    log = _evaluateSetups(log, candlesBySymbol, Date.now());
    const after = JSON.stringify(log);
    if (after !== before) await redisCmd('SET', 'setup_log:v1', after);
    const bySymbol = {};
    for (const s of log) { (bySymbol[s.symbol] = bySymbol[s.symbol] || []).push(s); }
    const symbols = {};
    for (const k of Object.keys(bySymbol)) { symbols[k] = _aggSetupStats(bySymbol[k]); symbols[k].history = bySymbol[k]; }
    return res.status(200).json({ symbols, global: _aggSetupStats(log), recent: log.slice(0, 10) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Render blok [ZONA KONFLUENSI] untuk prompt AI. Zona diberi ID stabil (A1/B1 dst,
// urut skor) supaya instruksi entry_zone bisa merujuk "pilih dari daftar ini".
function _formatConfluenceBlock(zones, dec) {
  if (!zones || (!zones.above?.length && !zones.below?.length)) return '';
  const f = n => n.toFixed(dec ?? 5);
  const fmtZone = z => `${f(z.center)} [skor ${z.score}] = ${z.members.join(' + ')}`;
  const lines = [`[ZONA KONFLUENSI — dihitung DETERMINISTIK oleh kode dari struktur di atas (level berjarak ≤ ${f(zones.tolerance)} digabung); skor = jumlah & kekuatan struktur yang bertumpuk, diurutkan dari terkuat]`];
  if (zones.above.length) {
    lines.push('  Di ATAS Now (kandidat area jual / target buy):');
    zones.above.forEach((z, i) => lines.push(`  A${i + 1}. ${fmtZone(z)}`));
  }
  if (zones.below.length) {
    lines.push('  Di BAWAH Now (kandidat area beli / target sell):');
    zones.below.forEach((z, i) => lines.push(`  B${i + 1}. ${fmtZone(z)}`));
  }
  return lines.join('\n');
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
function _formatFundamentalBlock({ label, isXau, cbBias, cot, risk, retail, nowMs }) {
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
      // %OI + percentile 3thn (audit vendor 2026-07-12): normalisasi + ekstremitas —
      // "net +50K" tanpa konteks OI/persentil tidak bisa dinilai crowded atau tidak.
      const pctile = cot?.percentiles?.[leg];
      const extras = [
        typeof cp.lev_change_net === 'number' ? `${k(cp.lev_change_net)} w/w` : null,
        cp.lev_net_pct_oi != null ? `${cp.lev_net_pct_oi > 0 ? '+' : ''}${cp.lev_net_pct_oi}% dari OI` : null,
        pctile?.lev_pctile != null ? `persentil 3thn P${pctile.lev_pctile}${pctile.lev_pctile >= 90 ? ' — CROWDED LONG, rawan squeeze turun' : pctile.lev_pctile <= 10 ? ' — CROWDED SHORT, rawan squeeze naik' : ''}` : null,
      ].filter(Boolean).join(', ');
      parts.push(`COT leveraged net ${k(cp.lev_net)}${extras ? ` (${extras})` : ''}`);
    }
    if (parts.length > 0) lines.push(`${leg}: ${parts.join(' | ')}`);
  }
  // Retail sentiment (mikro/taktis — intraday, kontrarian): keyed per PAIR, bukan per leg.
  const pairKey = isXau ? 'XAUUSD' : legs.join('');
  const rt = retail?.positions?.[pairKey];
  if (rt && rt.long_pct != null) {
    const sig = rt.signal === 'CONTRARIAN_SHORT'
      ? 'crowd retail berat LONG → sinyal kontrarian condong SHORT'
      : rt.signal === 'CONTRARIAN_LONG'
        ? 'crowd retail berat SHORT → sinyal kontrarian condong LONG'
        : 'seimbang, tidak ada sinyal kontrarian';
    const a = ageH(retail.fetched_at);
    lines.push(`RETAIL SENTIMENT ${pairKey}: ${rt.long_pct}% long / ${rt.short_pct}% short — ${sig}${a != null ? ` (data ${a < 1 ? '<1' : a}j lalu)` : ''} [kontrarian lemah kalau melawan COT; cek baris COT di atas]`);
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

// Track record historis disuapkan ke prompt Analisa (Plan I item 2, session 180) —
// AI menimbang rapornya sendiri sebelum percaya diri, bukan self-assessment
// "keyakinan" tanpa dasar. HANYA tp/sl (hasil final) yang dihitung — ambiguous
// (TP&SL sama-sama tersentuh, urutan tak diketahui), expired/stale/invalid/pending/
// open TIDAK dihitung sebagai menang/kalah (lihat _evaluateSetups). Sampel < 5 =
// noise, jangan disuap ke AI (return ''). Pure function — dites di ta_struct.test.js.
function _formatTrackRecordBlock(log, symbol) {
  if (!Array.isArray(log) || !symbol) return '';
  const decided = log.filter(s => s && s.symbol === symbol && (s.status === 'tp' || s.status === 'sl'));
  const tp = decided.filter(s => s.status === 'tp').length;
  const sl = decided.filter(s => s.status === 'sl').length;
  const total = tp + sl;
  if (total < 5) return '';
  const winRate = Math.round(tp / total * 100);
  const advice = winRate < 50
    ? ' Win-rate di bawah 50% — WAJIB lebih konservatif: naikkan syarat konfirmasi di trigger atau turunkan keyakinan di kesimpulan, jangan abaikan fakta ini.'
    : '';
  return `[TRACK RECORD setup AI pair ini]\n${total} setup selesai (segala arah): ${tp} TP / ${sl} SL (win rate ${winRate}%).${advice}`;
}

// Konversi event kalender (date "YYYY-MM-DD" kalender WIB + time_wib "HH:MM WIB",
// lihat api/calendar.js) jadi epoch ms — dipakai AI Kritikus (Plan I item 3) untuk
// filter "event <24 jam". "Tentative" (jam belum pasti) → null, jangan dihitung
// jaraknya (bisa salah jauh). Pure function — dites di ta_struct.test.js.
function _calEventMsWib(dateStr, timeWib) {
  if (!dateStr || !timeWib || timeWib === 'Tentative') return null;
  const m = /^(\d{2}):(\d{2})/.exec(timeWib);
  if (!m) return null;
  const t = new Date(`${dateStr}T${m[1]}:${m[2]}:00+07:00`).getTime();
  return isNaN(t) ? null : t;
}

// S-2 (Plan S, 2026-07-19): blok event kalender high-impact 7 hari ke depan untuk
// prompt ohlcv_analyze — AI diminta isi invalidation_condition/time_horizon_days
// tapi selama ini buta jadwal rilis, bisa kasih horizon yang melewati NFP/FOMC
// tanpa tahu. Filter currency by legs (split label "EUR/USD" -> ['EUR','USD']) —
// pola SAMA dengan blok "[KALENDER <24 JAM untuk pair ini]" di ohlcvCriticHandler
// (~baris 3376). XAU otomatis ke-filter ke leg USD saja karena calendar events
// tidak pernah punya currency "XAU" — tidak perlu isXau khusus. Pure function,
// dites di ta_struct.test.js.
function _buildAnalyzeCalBlock(calThis, calNext, legs, nowMs) {
  if (!Array.isArray(legs) || legs.length === 0) return '';
  const events = [...(calThis?.events || []), ...(calNext?.events || [])];
  if (events.length === 0) return '';

  const cutoffMs = nowMs + 7 * 24 * 3600 * 1000;
  const seen = new Set();
  const upcoming = events
    .filter(e => e && legs.includes(e.currency) && e.impact === 'High')
    .map(e => ({ ...e, _ms: _calEventMsWib(e.date, e.time_wib) }))
    .filter(e => e._ms != null && e._ms > nowMs && e._ms <= cutoffMs)
    .filter(e => { const k = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a._ms - b._ms)
    .slice(0, 10);

  if (upcoming.length === 0) return '';

  const lines = upcoming.map(e => {
    const fp = (e.forecast || e.previous) ? ` [F: ${e.forecast || '—'} | P: ${e.previous || '—'}]` : '';
    return `- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}${fp}`;
  });
  return `[EVENT HIGH-IMPACT 7 HARI KE DEPAN]\n${lines.join('\n')}\nKalau event di atas jatuh dalam rentang time_horizon_days yang kamu tulis, WAJIB disebut di invalidation_condition atau trigger.`;
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

  // Q-6 (Plan Q, 2026-07-18): market-digest.yml (GH Actions) memicu ANALISA
  // XAU/USD lewat action ini setiap slot digest — vps/daemon.js SEKARANG ikut
  // memicu endpoint yang SAMA secara paralel (sengaja, untuk bandingkan
  // ketepatan jadwal). Endpoint ini TIDAK PERNAH punya guard "jangan generate
  // ulang kalau baru saja generate" (beda dari market-digest.js yang setidaknya
  // punya single-flight 55 detik) — tanpa guard di bawah, 2 sumber cron akan
  // memanggil AI 2x per slot untuk simbol yang sama, sia-sia (datanya identik).
  // Window 30 menit: jauh lebih pendek dari jarak antar slot (~7 jam) jadi
  // tidak pernah menahan generate slot berikutnya, cukup panjang menutupi
  // keterlambatan salah satu sumber cron (GH Actions pernah telat berjam-jam,
  // tapi kalaupun cuma beda beberapa menit dengan VPS, tetap ke-dedup).
  const isCronCall = _isCronCallReq(req);
  if (isCronCall) {
    const CRON_DEDUP_WINDOW_MS = 30 * 60 * 1000;
    try {
      const raw = await redisCmd('GET', `ohlcv_analysis:${symbol}`);
      if (raw) {
        const cached = JSON.parse(raw);
        if (isCronDedupFresh(cached.loaded_at, Date.now(), CRON_DEDUP_WINDOW_MS)) {
          console.log(`ohlcv_analyze: cron call kedua untuk ${symbol} (cache masih fresh) — skip generate ulang`);
          return res.status(200).json({ ...cached, cached: true, from_cron_dedup: true });
        }
      }
    } catch(e) { console.warn('ohlcv_analyze: cron dedup check gagal (fail-open, tetap generate):', e.message); }
  }

  // Input klien di-cap defensif: excerpt resmi max 900 char (lihat _extractRingkasanExcerpt) —
  // body adalah input publik, jangan biarkan string raksasa menggelembungkan prompt AI.
  let ringkasanContext = req.body?.ringkasanContext || null;
  if (typeof ringkasanContext !== 'string' || !ringkasanContext.trim()) ringkasanContext = null;
  else if (ringkasanContext.length > 1200) ringkasanContext = ringkasanContext.slice(0, 1197) + '...';
  let ringkasanAt      = req.body?.ringkasanGeneratedAt || null;
  const clientOhlcv    = req.body?.ohlcvData       || null;
  const cbDir          = req.body?.cbDir           || null;

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
    let expiryLvls  = [];
    try {
      const rawOpt = await redisCmd('GET', 'fx_options_cache');
      if (rawOpt) {
        const opt = JSON.parse(rawOpt);
        const ageOk = opt.fetched_at && (Date.now() - new Date(opt.fetched_at).getTime()) < 24 * 3600 * 1000;
        if (ageOk) {
          const lvls = _pickExpiryLevels(opt.expiries, data.label, nowPrice);
          expiryLvls = lvls;
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
      const [rawBias, rawCot, rawRisk, rawRetail] = await Promise.all([
        redisCmd('GET', 'cb_bias'),
        redisCmd('GET', 'cot_cache_v2'),
        redisCmd('GET', 'risk_regime'),
        redisCmd('GET', 'retail_sentiment_cache'),
      ]);
      fundBlock = _formatFundamentalBlock({
        label: data.label, isXau: data.is_xau,
        cbBias: rawBias ? JSON.parse(rawBias) : null,
        cot:    rawCot  ? JSON.parse(rawCot)  : null,
        risk:   rawRisk ? JSON.parse(rawRisk) : null,
        retail: rawRetail ? JSON.parse(rawRetail) : null,
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

    // Track record historis setup AI pair ini (Plan I item 2) — 1 GET Redis, 0 AI call.
    let trackBlock = '';
    try {
      const rawSetupLog = await redisCmd('GET', 'setup_log:v1');
      if (rawSetupLog) {
        const setupLog = JSON.parse(rawSetupLog);
        trackBlock = _formatTrackRecordBlock(Array.isArray(setupLog) ? setupLog : [], data.label);
      }
    } catch (e) { /* opsional — jangan gagalkan analisa kalau log setup kosong/korup */ }

    // S-2: event kalender high-impact 7 hari ke depan khusus currency pair ini —
    // baca cache calendar_v1/calendar_next_v1 (ditulis api/calendar.js, TTL 6h,
    // dijaga fresh oleh polling tab Kalender) — JANGAN fetch TradingView baru di sini.
    let calAnalyzeBlock = '';
    try {
      const [rawCalThis, rawCalNext] = await Promise.all([
        redisCmd('GET', 'calendar_v1'),
        redisCmd('GET', 'calendar_next_v1'),
      ]);
      const legs = String(data.label).toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
      calAnalyzeBlock = _buildAnalyzeCalBlock(
        rawCalThis ? JSON.parse(rawCalThis) : null,
        rawCalNext ? JSON.parse(rawCalNext) : null,
        legs, Date.now(),
      );
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache kalender kosong */ }

    const makroHeader = makroAgeH != null
      ? `KONTEKS MAKRO (dari Ringkasan ${makroAgeH} jam lalu${makroAgeH > 4 ? ' — SUDAH AGAK BASI: kalau ada rilis/berita besar setelah itu, beri bobot lebih rendah dan sebut ketidakpastiannya' : ''}):`
      : 'KONTEKS MAKRO:';
    // Zona konfluensi deterministik — dihitung SEKALI di kode dari struktur yang sama
    // dengan yang dilihat AI, supaya entry/SL/TP tidak "di-reroll" tiap re-generate.
    const confZones = _confluenceZones(data, expiryLvls);
    const confBlock = _formatConfluenceBlock(confZones, data.dec);

    const ctxParts = [];
    if (ringkasanContext) ctxParts.push(`${makroHeader}\n${ringkasanContext}`);
    if (fundBlock)        ctxParts.push(fundBlock);
    if (rrBlock)          ctxParts.push(rrBlock);
    if (trackBlock)       ctxParts.push(trackBlock);
    if (calAnalyzeBlock)  ctxParts.push(calAnalyzeBlock);
    ctxParts.push(`DATA TEKNIKAL:\n${textBlock}${expiryBlock}${confBlock ? '\n\n' + confBlock : ''}`);
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
      trackBlock             ? 'track record historis' : null,
      calAnalyzeBlock        ? 'event kalender' : null,
    ].filter(Boolean).join(' + ');

    const p4Macro = (ringkasanContext || fundBlock)
      ? ' — kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR berlawanan jelas dengan struktur teknikal (misal makro risk-off tapi teknikal breakout bullish), sebut konflik itu eksplisit dan turunkan keyakinan setup, jangan diam-diam diabaikan; kesimpulanmu di sini harus konsisten dengan field makro_alignment'
      : '';
    const p3Atr = extraCtx?.includes('ATR') ? ', volatilitas berdasarkan ATR' : '';
    const p4Label = extraCtx ? `(${extraCtx})` : 'timeframe';
    const p5Track = trackBlock
      ? ' Kalau [TRACK RECORD setup AI pair ini] tersedia di atas, WAJIB sebut win-rate historisnya secara singkat sebagai bagian pertimbangan level keyakinan.'
      : '';
    // Instruksi entry/sl/tp punya dua varian: kalau [ZONA KONFLUENSI] terhitung, AI
    // WAJIB memilih dari ranking deterministik itu (bukan mengarang kombinasi sendiri —
    // akar masalah hasil lompat-lompat antar re-generate); fallback ke instruksi lama
    // "pilih bebas dari struktur" hanya kalau zona gagal dihitung (data minim).
    const entryZoneInstr = confBlock
      ? '- entry_zone: WAJIB pilih dari daftar [ZONA KONFLUENSI] di atas — ambil zona dengan SKOR TERTINGGI yang searah bias dan konsisten dengan harga "Now": bias bearish → zona di ATAS Now (jual di rally ke resistance); bias bullish → zona di BAWAH Now (beli di pullback ke support); pengecualian hanya breakout/breakdown confirmation dengan trigger jelas. Tulis center zona itu atau range sempit di sekitarnya — JANGAN mengarang level di luar daftar. Kalau dua zona skornya sama, pilih yang lebih dekat ke Now. KALAU TIDAK ADA zona layak searah bias (struktur Mixed, harga di tengah range, semua zona skor rendah), ATAU jika makro_alignment adalah "konflik", set entry_zone, sl, tp, entry_basis ke null dan jelaskan di trigger kondisi apa yang ditunggu — JANGAN memaksakan setup saat makro dan teknikal bertabrakan.'
      : '- entry_zone: level atau range harga ideal untuk entry (angka konkret). WAJIB berpijak pada level STRUKTUR yang benar-benar ada di DATA TEKNIKAL: cluster [LEVEL S/R], level [FIBONACCI], [PIVOT HARIAN], Prev Day/Week H-L, swing H4, SMA, atau option expiry — jangan mengarang angka yang tidak ada di data. PRIORITASKAN KONFLUENSI: area di mana 2+ struktur berbeda jatuh berdekatan (misal fib 61.8% bertepatan dengan cluster S/R yang banyak disentuh dan pivot S1) — itu entry dengan dasar terkuat. WAJIB konsisten dengan harga "Now": kalau bias bearish, entry_zone >= Now (jual di rally ke resistance) ATAU di bawah Now kalau memang breakdown confirmation, TAPI jangan keduanya sekaligus. Kalau Now sudah melewati level breakdown/breakout relevan, jangan minta retracement ke arah berlawanan — definisikan entry di struktur terdekat dari Now. KALAU TIDAK ADA setup dengan dasar struktur jelas searah bias (misal struktur Mixed dan harga di tengah range, jauh dari semua level kuat), ATAU jika makro_alignment adalah "konflik", set entry_zone, sl, tp, entry_basis ke null dan jelaskan di trigger kondisi apa yang ditunggu — JANGAN memaksakan setup saat makro dan teknikal bertabrakan.';
    const entryBasisInstr = confBlock
      ? '- entry_basis: salin daftar struktur penyusun zona yang kamu pilih dari [ZONA KONFLUENSI] (bagian setelah tanda "=" di baris zona itu; boleh diringkas tapi minimal satu struktur bernama dengan angkanya). Kalau entry_zone null, field ini juga null.'
      : '- entry_basis: sebutkan struktur mana saja dari DATA TEKNIKAL yang jadi dasar entry_zone, dengan angkanya (contoh format: "fib 61.8% 1.1712 + cluster S/R 1.1709 (4x sentuh) + pivot S1 1.1705"). Minimal satu struktur bernama; makin banyak konfluensi makin baik. Kalau entry_zone null, field ini juga null.';
    const slInstr = confBlock
      ? '- sl: level stop loss konkret DI LUAR zona konfluensi yang melindungi entry — di balik zona [ZONA KONFLUENSI] atau struktur berikutnya setelah entry_zone, dengan buffer minimal ~0.5x ATR-14 H1 dari level itu (jangan tepat di level, rawan wick hunt). Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.'
      : '- sl: level stop loss konkret DI LUAR struktur yang melindungi entry — di balik swing H4, cluster S/R, atau Prev Day H/L yang ADA di data, dengan buffer minimal ~0.5x ATR-14 H1 dari level itu (jangan tepat di level, rawan wick hunt). Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.';
    const tpInstr = confBlock
      ? '- tp: zona konfluensi BERIKUTNYA searah bias dari daftar [ZONA KONFLUENSI] (atau struktur [LEVEL S/R] berikutnya kalau tidak ada zona lagi searah itu) — jangan mengarang. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. WAJIB risk/reward (jarak entry→tp dibanding entry→sl) minimal 1:1 — kalau struktur data tidak memungkinkan RR ≥1, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.'
      : '- tp: level take profit konkret = struktur berikutnya searah bias yang ADA di data (cluster S/R, swing, pivot, fib) — jangan mengarang. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. WAJIB risk/reward (jarak entry→tp dibanding entry→sl) minimal 1:1 — kalau struktur data tidak memungkinkan RR ≥1, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.';
    const userMsg = [
      `Analisa ${data.label}:`,
      '',
      makroBlock,
      '',
      'Isi field JSON berikut:',
      '- bias: trend dominan — bullish/bearish/neutral/mixed. Dasarkan pada GABUNGAN trend Daily + [STRUKTUR H4] (HH+HL vs LH+LL) + BOS kalau ada — bukan cuma perubahan %. Pakai "mixed" kalau timeframe saling kontradiksi (misal Daily naik tapi struktur H4 LH+LL) atau makro vs teknikal berlawanan jelas — jangan paksa ke "neutral" kalau sebenarnya konflik, bukan tanpa-trend.',
      entryZoneInstr,
      entryBasisInstr,
      slInstr,
      tpInstr,
      '- trigger: SATU kondisi price action spesifik yang HARUS terpenuhi sebelum entry — utamakan konfirmasi berbasis candle/pola di level konkret (misal "tunggu candle H4 close di bawah 1.1710" atau "tunggu rejection/pin bar H1 di area 3340") daripada indikator murni. Jangan sebut dua kondisi alternatif yang saling kontradiksi relatif ke Now. Manfaatkan [POLA CANDLE terdeteksi] kalau relevan.',
      '- invalidation_condition: kondisi spesifik yang membatalkan skenario ini sepenuhnya (beda dari sl — ini soal struktur/tesis, misal "kalau Daily close balik di bawah SMA50 atau swing low H4 terakhir jebol, bias bullish batal")',
      '- time_horizon_days: estimasi jumlah hari realistis skenario ini main out (angka, misal 3, 5, 10) berdasarkan jarak entry-tp dibanding rata-rata gerak harian (ATR/sigma) yang ada di data',
      '- makro_alignment: "searah" kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR mendukung arah bias teknikalmu, "konflik" kalau berlawanan, "netral" kalau sinyal makro tidak jelas/campuran. Kalau blok makro dan fundamental dua-duanya tidak tersedia di atas, isi null.',
      '- makro_alignment_reason: SATU kalimat pendek alasannya dengan menyebut data spesifik (misal "bias Fed Dovish + COT USD net short searah dengan bias bearish USD/JPY"). Null kalau makro_alignment null.',
      '',
      'Setelah objek JSON, di baris baru tulis PERSIS "===COMMENTARY===" lalu tulis commentary sebagai teks biasa (BUKAN di dalam JSON): analisa naratif mendalam 5 paragraf, pisah tiap paragraf dengan baris baru. PENTING — label "paragraf 1/2/3/4/5" di instruksi di bawah ini HANYA panduan urutan untukmu menulis, BUKAN teks yang harus muncul di output: paragraf 1-4 WAJIB ditulis sebagai prosa mengalir TANPA header/judul/angka urutan apapun di depannya (langsung mulai dengan kalimat isi). Paragraf 5 SATU-SATUNYA pengecualian yang harus mulai literal dengan kata "KESIMPULAN:" — jangan tambahkan header serupa di paragraf lain.',
      `Isi paragraf pertama (tanpa header) — bias & posisi makro harga: arah trend Daily dengan alasan konkret (perubahan %, close vs open, posisi dalam range 6 bulan dari [KONTEKS 6 BULAN] — dekat puncak/lembah/tengah).`,
      `Isi paragraf kedua (tanpa header) — struktur H4: pakai [STRUKTUR H4] (HH+HL / LH+LL / mixed) dan posisi harga terhadap cluster [LEVEL S/R] terdekat; fase akumulasi/distribusi/breakout; MACD H4 konfirmasi atau divergensi.`,
      `Isi paragraf ketiga (tanpa header) — momentum & pola: momentum H1 terkini, RSI H4 (arah naik/turun), pola candle yang terdeteksi dan artinya di posisi sekarang${p3Atr}, konfluensi atau perbedaan arah dengan H4.`,
      `Isi paragraf keempat (tanpa header) — integrasi ${p4Label}: simpulkan kekuatan setup (berapa struktur yang konfluens di entry_zone), risiko utama, dan kondisi pasar yang memvalidasi atau membatalkan skenario ini${p4Macro}.`,
      `Isi paragraf kelima — mulai literal dengan "KESIMPULAN:" lalu isi (WAJIB, paragraf penutup terpisah — jangan digabung ke paragraf keempat): 3-4 kalimat MAKSIMAL setelah kata "KESIMPULAN:", jangan mengulang detail/angka yang sudah dijelaskan panjang di paragraf sebelumnya. Harus BISA BERDIRI SENDIRI untuk trader yang cuma sempat baca satu paragraf ini: (1) bias akhir + level keyakinan (tinggi/sedang/rendah) dengan alasan singkat kenapa segitu, (2) SATU kondisi konkret yang ditunggu sebelum entry (ulangi trigger utama secara ringkas, minimal sebutkan levelnya), (3) SATU risiko/pembatal utama dalam satu kalimat. Nada tegas dan actionable, bukan mengulang narasi eksploratif paragraf sebelumnya.${p5Track}`,
      '4 paragraf pertama wajib sebut minimal 2 angka konkret masing-masing (harga, %, atau nilai indikator); paragraf kelima minimal 1 angka (level trigger). DILARANG kalimat generik tanpa angka (misal "harga bergerak sideways", "momentum masih lemah", "perlu konfirmasi lebih lanjut" tanpa data pendukung) — setiap klaim harus berpijak pada angka yang ada di DATA TEKNIKAL.',
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

    // Diagnostik Hermes 3 405B (lihat HERMES_MODEL di atas) — isolasi TOTAL dari
    // SambaNova: kalau flag ini aktif, dua tier SambaNova di bawah di-skip sama sekali
    // (bukan cuma primary seperti test_samba_c1), supaya hasil yang dikembalikan ke
    // client murni dari Hermes, bukan tersamar fallback lain kalau Hermes gagal.
    const testHermesOnly = req.query.test_hermes === '1' || req.body?.test_hermes === true;
    // Dikembalikan di response (bukan cuma console.warn) — tujuan diagnostik ini supaya
    // user bisa lihat langsung alasan gagal/lambat tanpa akses server log.
    let hermesError = null, hermesElapsedMs = null;

    if (testHermesOnly) {
      const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
      if (OPENROUTER_KEY && await cb.canCall(CB_OPENROUTER_HERMES)) {
        const t0h = Date.now();
        try {
          if (!await allowAiCall('openrouter')) throw new Error('AI daily budget exceeded');
          console.log('ohlcv_analyze: trying Hermes 3 405B (OpenRouter) — diagnostik test_hermes=1');
          const r = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}`, ...OPENROUTER_HEADERS },
            body: JSON.stringify({ model: HERMES_MODEL, messages, max_tokens: 1500, temperature: 0 }),
            signal: AbortSignal.timeout(30000),
          });
          if (r.ok) {
            const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'hermes-3-405b';
            if (rawText) await cb.onSuccess(CB_OPENROUTER_HERMES);
            else throw new Error('Empty response');
          } else { throw new Error(`HTTP ${r.status}`); }
          hermesElapsedMs = Date.now() - t0h;
          console.log('ohlcv_analyze: Hermes 3 405B OK,', hermesElapsedMs, 'ms');
        } catch(e) {
          hermesElapsedMs = Date.now() - t0h;
          hermesError = e.message;
          console.warn('ohlcv_analyze Hermes 3 405B failed:', e.message);
          await cb.onFailure(CB_OPENROUTER_HERMES);
        }
      } else if (OPENROUTER_KEY) {
        hermesError = 'circuit_open';
        console.log('ohlcv_analyze: test_hermes=1 — circuit OPEN');
      } else {
        hermesError = 'no_key';
        console.log('ohlcv_analyze: test_hermes=1 — OPENROUTER_API_KEY belum diset');
      }
    }

    // Diagnostik konektivitas Ollama Cloud (?test_ollama=1) — TIDAK berhubungan dengan
    // testHermesOnly (provider beda, tidak saling exclude — bisa dites terpisah). Isolasi
    // total dari SambaNova sama seperti Hermes. Tujuan murni "apakah akun/API-nya
    // reachable", bukan kandidat kualitas — pakai model terkecil/tercepat (OLLAMA_NANO_MODEL).
    const testOllamaOnly = req.query.test_ollama === '1' || req.body?.test_ollama === true;
    let ollamaError = null, ollamaElapsedMs = null;

    if (testOllamaOnly) {
      const OLLAMA_KEY = process.env.OLLAMA_API_KEY;
      if (OLLAMA_KEY && await cb.canCall(CB_OLLAMA_NANO)) {
        const t0o = Date.now();
        try {
          if (!await allowAiCall('ollama')) throw new Error('AI daily budget exceeded');
          console.log('ohlcv_analyze: trying Ollama Cloud nemotron-3-nano (think:false) — diagnostik test_ollama=1');
          const r = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OLLAMA_KEY}` },
            body: JSON.stringify({ model: OLLAMA_NANO_MODEL, messages, stream: false, think: false, options: { temperature: 0, num_predict: 1500 } }),
            signal: AbortSignal.timeout(20000),
          });
          if (r.ok) {
            const j = await r.json(); rawText = j?.message?.content?.trim() || null; model = 'nemotron-3-nano';
            if (rawText) await cb.onSuccess(CB_OLLAMA_NANO);
            else throw new Error('Empty response');
          } else { throw new Error(`HTTP ${r.status}`); }
          ollamaElapsedMs = Date.now() - t0o;
          console.log('ohlcv_analyze: Ollama nemotron-3-nano OK,', ollamaElapsedMs, 'ms');
        } catch(e) {
          ollamaElapsedMs = Date.now() - t0o;
          ollamaError = e.message;
          console.warn('ohlcv_analyze Ollama nemotron-3-nano failed:', e.message);
          await cb.onFailure(CB_OLLAMA_NANO);
        }
      } else if (OLLAMA_KEY) {
        ollamaError = 'circuit_open';
        console.log('ohlcv_analyze: test_ollama=1 — circuit OPEN');
      } else {
        ollamaError = 'no_key';
        console.log('ohlcv_analyze: test_ollama=1 — OLLAMA_API_KEY belum diset');
      }
    }

    // Diagnostik DeepSeek v4-flash API resmi (Plan O-6, 2026-07-18) — gate SEBELUM
    // promosi jadi primary Analisa per Pair (beda dari Ringkasan yang sudah dipromosikan
    // langsung di Plan O-3/market-digest.js: di sini kualitas belum divalidasi live untuk
    // tugas Entry/SL/TP numerik, jadi TETAP terisolasi total dari cache produksi sampai
    // dinilai — pola sama seperti Hermes/Ollama di atas). response_format json_object
    // TIDAK dipakai (beda dari Call 2/3 market-digest.js) karena skema jawaban di sini
    // dua-bagian (JSON + "===COMMENTARY===" + prosa), bukan JSON murni.
    const testDeepseekOnly = req.query.test_deepseek === '1' || req.body?.test_deepseek === true;
    let deepseekError = null, deepseekElapsedMs = null;

    if (testDeepseekOnly) {
      const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
      if (DEEPSEEK_KEY && await cb.canCall('ai:deepseek')) {
        const t0ds = Date.now();
        try {
          if (!await allowAiCall('deepseek')) throw new Error('AI daily budget exceeded');
          console.log('ohlcv_analyze: trying DeepSeek v4-flash (API resmi) — diagnostik test_deepseek=1');
          const r = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
            body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 1500, temperature: 0, thinking: { type: 'disabled' } }),
            signal: AbortSignal.timeout(20000),
          });
          if (r.ok) {
            const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
            if (rawText) await cb.onSuccess('ai:deepseek');
            else throw new Error('Empty response');
          } else {
            const errJ = await r.json().catch(() => ({}));
            throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
          }
          deepseekElapsedMs = Date.now() - t0ds;
          console.log('ohlcv_analyze: DeepSeek v4-flash OK,', deepseekElapsedMs, 'ms');
        } catch(e) {
          deepseekElapsedMs = Date.now() - t0ds;
          deepseekError = e.message;
          console.warn('ohlcv_analyze DeepSeek v4-flash failed:', e.message);
          await cb.onFailure('ai:deepseek');
        }
      } else if (DEEPSEEK_KEY) {
        deepseekError = 'circuit_open';
        console.log('ohlcv_analyze: test_deepseek=1 — circuit OPEN');
      } else {
        deepseekError = 'no_key';
        console.log('ohlcv_analyze: test_deepseek=1 — DEEPSEEK_API_KEY belum diset');
      }
    }

    // Dipakai untuk menggerbang dua tier SambaNova + cache produksi — SATU flag untuk
    // SEMUA diagnostik terisolasi (Hermes/Ollama/DeepSeek), supaya nambah kandidat baru
    // nanti tinggal OR ke sini, bukan cari-cari tiap titik guard satu-satu.
    const isDiagnosticOnly = testHermesOnly || testOllamaOnly || testDeepseekOnly;
    // Scope terpisah dari DEEPSEEK_KEY di blok testDeepseekOnly di atas (itu lokal ke
    // if-block-nya sendiri) — dibutuhkan lagi di sini untuk tier primary produksi.
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

    // Batas waktu keras cascade AI (Plan O-6, 2026-07-18): sekarang ADA 3 tier
    // (DeepSeek + 2x SambaNova) yang timeout aslinya kalau dijumlah (15+30+25=70s)
    // tembus maxDuration 60s Vercel — timeout SambaNova di bawah dibuat ADAPTIF
    // terhadap sisa budget, bukan fixed, supaya total cascade tetap aman.
    const aiCascadeStart = Date.now();
    const AI_HARD_BUDGET_MS = 48000;
    const aiBudgetLeftMs = () => AI_HARD_BUDGET_MS - (Date.now() - aiCascadeStart);

    // Primary (Plan O-6, 2026-07-18): DeepSeek v4-flash API resmi — promosi dari
    // diagnostik ?test_deepseek=1 setelah gate lolos (3/3 sampel live termasuk XAU/USD,
    // EUR/USD, GBP/JPY: JSON valid, entry/SL/TP konsisten arah, tidak ada kontaminasi
    // angka antar-pair). SambaNova akun-1/akun-2 TURUN jadi fallback berurutan.
    if (!isDiagnosticOnly && DEEPSEEK_KEY && await cb.canCall('ai:deepseek')) {
      try {
        if (!await allowAiCall('deepseek')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 1500, temperature: 0, thinking: { type: 'disabled' } }),
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
          if (rawText) await cb.onSuccess('ai:deepseek');
          else throw new Error('Empty response');
        } else {
          const errJ = await r.json().catch(() => ({}));
          throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
        }
      } catch(e) { console.warn('ohlcv_analyze DeepSeek (primary) failed:', e.message); await cb.onFailure('ai:deepseek'); }
    } else if (!isDiagnosticOnly && DEEPSEEK_KEY) { console.log('ohlcv_analyze: DeepSeek circuit OPEN — skipping to SambaNova akun 1'); }

    // Fallback 1: SambaNova DeepSeek-V3.2 (671B, akun 1). Eksperimen GLM-5.2/gpt-oss:120b
    // sebagai primary dulu dihentikan: gpt-oss:120b (120B) kemungkinan di bawah
    // DeepSeek-V3.2 secara kualitas — tidak masuk akal jadi primary yang mengalahkan
    // model yang sudah terbukti lebih kuat & proven di app ini.
    const c1Timeout = Math.max(0, Math.min(30000, aiBudgetLeftMs() - 3000));
    if (!isDiagnosticOnly && !rawText && !testC1Only && c1Timeout >= 10000 && SAMBANOVA_KEY && await cb.canCall('ai:sambanova:main')) {
      try {
        if (!await allowAiCall('sambanova_main')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY}` },
          body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 1500, temperature: 0 }),
          signal: AbortSignal.timeout(c1Timeout),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
          if (rawText) await cb.onSuccess('ai:sambanova:main');
          else throw new Error('Empty response');
        } else { throw new Error(`HTTP ${r.status}`); }
      } catch(e) { console.warn('ohlcv_analyze SambaNova failed:', e.message); await cb.onFailure('ai:sambanova:main'); }
    } else if (isDiagnosticOnly) { /* sudah di-log di blok Hermes/Ollama/DeepSeek di atas */ }
    else if (!rawText && testC1Only) { console.log('ohlcv_analyze: test_samba_c1=1 — bypassing primary'); }
    else if (!rawText && SAMBANOVA_KEY) { console.log('ohlcv_analyze: SambaNova circuit OPEN/budget mepet — skipping to akun 2'); }

    // Fallback 2: SambaNova DeepSeek-V3.2 (akun 2, SAMBANOVA_API_KEY_CALL1) — akun terpisah
    // dari fallback 1 supaya rate-limit/outage di satu akun tidak menjatuhkan dua-duanya
    // sekaligus. Ollama Cloud (gpt-oss:120b) dan Groq (llama-3.3) yang tadinya di sini
    // sudah dicoret: live test (2026-07-10, ?test_ollama=1 x2) membuktikan Ollama timeout
    // 15s KONSISTEN ("operation was aborted due to timeout") sampai circuit ai:ollama OPEN
    // setelah 3x gagal beruntun, dan Groq/llama-3.3 kualitasnya paling rendah di rantai
    // ini — DeepSeek-V3.2 akun 2 jauh lebih kuat sebagai fallback tunggal. Timeout adaptif
    // (Plan O-6) menggantikan fixed 25s supaya cascade 3-tier tetap di bawah 60s Vercel.
    const c2Timeout = Math.max(0, Math.min(25000, aiBudgetLeftMs() - 3000));
    if (!isDiagnosticOnly && !rawText && c2Timeout >= 10000 && SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1_ADMIN)) {
      try {
        if (!await allowAiCall('sambanova_c1')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY_CALL1}` },
          body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 1500, temperature: 0 }),
          signal: AbortSignal.timeout(c2Timeout),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
          if (rawText) await cb.onSuccess(CB_SAMBA_C1_ADMIN);
          else throw new Error('Empty response');
        } else { throw new Error(`HTTP ${r.status}`); }
      } catch(e) { console.warn('ohlcv_analyze SambaNova akun2 failed:', e.message); await cb.onFailure(CB_SAMBA_C1_ADMIN); }
    } else if (!isDiagnosticOnly && !rawText && SAMBANOVA_KEY_CALL1) { console.log('ohlcv_analyze: SambaNova akun2 circuit OPEN/budget mepet'); }

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

        // [SISTEM HAKIM] Soft Block (Hak Veto User) - Mencegat halusinasi makro_alignment
        if (cbDir && structured.bias) {
          const techBias = structured.bias.toLowerCase();
          const isTechLong = techBias.includes('bullish') || techBias === 'long';
          const isTechShort = techBias.includes('bearish') || techBias === 'short';
          
          if ((cbDir === 'long' && isTechShort) || (cbDir === 'short' && isTechLong)) {
            structured.makro_alignment = 'konflik';
            structured.makro_alignment_reason = '[SISTEM HAKIM] Terdeteksi konflik nyata antara arah Makro/Fundamental dan Teknikal. Setup ini melanggar aturan konfluensi makro.';
          }
        }
      } catch(e) {
        // Keep rawText as commentary, structured stays null
      }
    }

    const resultPayload = {
      commentary, structured, model,
      hasMakro: !!ringkasanContext,
      hasFund:  !!fundBlock,
      // Zona konfluensi deterministik yang jadi dasar entry/sl/tp — diikutkan di payload
      // supaya UI bisa menampilkan/memverifikasi bahwa level AI memang dari ranking ini.
      confluence: confZones || null,
      makro_generated_at: (ringkasanContext && ringkasanAt) ? ringkasanAt : null,
      loaded_at: new Date().toISOString(),
    };

    if (!commentary && !structured) {
      resultPayload.error = 'SambaNova (Utama & Cadangan) sedang offline, timeout, atau limit harian habis';
    }

    // isDiagnosticOnly dikecualikan dari cache produksi — request diagnostik tidak boleh
    // menimpa hasil analisa AI real yang sedang ditampilkan ke user di tab Analisa.
    if ((commentary || structured) && !isDiagnosticOnly) {
      redisCmd('SET', `ohlcv_analysis:${symbol}`, JSON.stringify(resultPayload), 'EX', 21600).catch(() => {});
    }
    // Outcome logging (Tier 1 riset, session 166): catat setiap setup lengkap supaya
    // win-rate NYATA bisa dihitung via ?action=setup_stats. Best-effort — kegagalan
    // logging tidak boleh menggagalkan response analisa. Dedup: setup aktif dengan
    // level identik di symbol yang sama tidak dicatat dua kali (re-generate tanpa
    // perubahan level = satu keputusan yang sama, bukan dua track record).
    if (structured?.entry_zone && structured.sl && structured.tp && structured.makro_alignment !== 'konflik' && !isDiagnosticOnly) {
      try {
        const rawLog = await redisCmd('GET', 'setup_log:v1');
        let log = rawLog ? JSON.parse(rawLog) : [];
        if (!Array.isArray(log)) log = [];
        const dup = log.find(x => x && x.symbol === symbol
          && (x.status === 'pending' || x.status === 'open')
          && x.entry_zone === structured.entry_zone && x.sl === structured.sl && x.tp === structured.tp);
        if (!dup) {
          log.unshift({
            id: `${symbol}:${Date.now()}`,
            symbol, label: data.label, bias: structured.bias,
            entry_zone: structured.entry_zone, sl: structured.sl, tp: structured.tp,
            rr: structured.risk_reward ?? null,
            horizon_days: structured.time_horizon_days ?? null,
            model, ts: Date.now(), status: 'pending',
          });
          await redisCmd('SET', 'setup_log:v1', JSON.stringify(log.slice(0, 200)));
        }
      } catch (e) { console.warn('setup_log write failed:', e.message); }
    }
    return res.status(200).json({
      ...resultPayload,
      test_hermes: testHermesOnly || undefined,
      hermes_error: testHermesOnly ? hermesError : undefined,
      hermes_elapsed_ms: testHermesOnly ? hermesElapsedMs : undefined,
      test_ollama: testOllamaOnly || undefined,
      ollama_error: testOllamaOnly ? ollamaError : undefined,
      ollama_elapsed_ms: testOllamaOnly ? ollamaElapsedMs : undefined,
      test_deepseek: testDeepseekOnly || undefined,
      deepseek_error: testDeepseekOnly ? deepseekError : undefined,
      deepseek_elapsed_ms: testDeepseekOnly ? deepseekElapsedMs : undefined,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── AI Kritikus — tombol "UJI KELEMAHAN" (Plan I item 3, session 180) ─────────
// Decision Critic hemat: BUKAN otomatis tiap analisa (beda dari Plan H penuh),
// tombol terpisah yang user tekan saat serius mau entry. Numpang admin.js
// (?action=ohlcv_critic), BUKAN function baru (Vercel Hobby 12/12 penuh).
// Fact sheet 100% deterministik dari Redis yang sudah ada (cb_bias, cot_cache_v2,
// risk_regime, retail_sentiment_cache, rr_cache_v2, calendar_v1, setup_log:v1) —
// TIDAK ada fetch eksternal baru, cuma 1 AI call (SambaNova → Groq fallback).
async function ohlcvCriticHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = req.query.symbol || req.body?.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const label = req.query.label || req.body?.label
    || Object.entries(OHLCV_PAIR_SYMBOL_MAP).find(([, s]) => s === symbol)?.[0]
    || symbol;

  // WAJIB sudah ada analisa dengan setup lengkap — JANGAN analisa ulang di sini,
  // kritikus cuma mengaudit keputusan yang SUDAH ada, bukan bikin keputusan baru.
  let analysis = null;
  try {
    const raw = await redisCmd('GET', `ohlcv_analysis:${symbol}`);
    if (raw) analysis = JSON.parse(raw);
  } catch (e) { /* treat as missing — fall through ke pesan error di bawah */ }

  const st = analysis?.structured;
  if (!st || !st.entry_zone || !st.sl || !st.tp) {
    return res.status(200).json({ error: 'Belum ada setup untuk dikritik — jalankan Analisa AI dulu.' });
  }

  const isXau = symbol === 'GC=F';

  // Fact sheet ringkas — tiap blok independen try/catch (kegagalan satu cache
  // tidak boleh mengosongkan blok lain), sama pola dengan ohlcvAnalyzeHandler.
  let fundBlock = '', rrBlock = '', trackBlock = '', calBlock = '';
  const [rawBias, rawCot, rawRisk, rawRetail, rawRR, rawCal, rawLog] = await Promise.all([
    redisCmd('GET', 'cb_bias').catch(() => null),
    redisCmd('GET', 'cot_cache_v2').catch(() => null),
    redisCmd('GET', 'risk_regime').catch(() => null),
    redisCmd('GET', 'retail_sentiment_cache').catch(() => null),
    redisCmd('GET', 'rr_cache_v2').catch(() => null),
    redisCmd('GET', 'calendar_v1').catch(() => null),
    redisCmd('GET', 'setup_log:v1').catch(() => null),
  ]);
  try {
    fundBlock = _formatFundamentalBlock({
      label, isXau,
      cbBias: rawBias ? JSON.parse(rawBias) : null,
      cot:    rawCot  ? JSON.parse(rawCot)  : null,
      risk:   rawRisk ? JSON.parse(rawRisk) : null,
      retail: rawRetail ? JSON.parse(rawRetail) : null,
      nowMs:  Date.now(),
    });
  } catch (e) { /* opsional */ }
  try {
    if (rawRR) rrBlock = _formatOptionsSentimentBlock(JSON.parse(rawRR)?.pairs?.[label]);
  } catch (e) { /* opsional */ }
  try {
    if (rawLog) {
      const log = JSON.parse(rawLog);
      trackBlock = _formatTrackRecordBlock(Array.isArray(log) ? log : [], symbol);
    }
  } catch (e) { /* opsional */ }
  try {
    if (rawCal) {
      const cal = JSON.parse(rawCal);
      const legs = String(label).toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
      const now = Date.now();
      const upcoming = (cal.events || [])
        .filter(e => legs.includes(e.currency))
        .map(e => ({ ...e, _ms: _calEventMsWib(e.date, e.time_wib) }))
        .filter(e => e._ms != null && e._ms > now && e._ms - now <= 24 * 3600 * 1000)
        .sort((a, b) => a._ms - b._ms);
      if (upcoming.length > 0) {
        calBlock = '[KALENDER <24 JAM untuk pair ini]\n' + upcoming
          .map(e => `- ${e.event} (${e.currency}, impact ${e.impact}) dalam ${((e._ms - now) / 3600000).toFixed(1)} jam`)
          .join('\n');
      }
    }
  } catch (e) { /* opsional */ }

  const ageMin = analysis.loaded_at ? Math.round((Date.now() - new Date(analysis.loaded_at).getTime()) / 60000) : null;
  const setupBlock = [
    `[SETUP YANG DIUSULKAN]`,
    `Pair: ${label} | Bias: ${st.bias || '—'} | Entry: ${st.entry_zone} | SL: ${st.sl} | TP: ${st.tp}${st.risk_reward ? ` | RR: ${st.risk_reward}` : ''}`,
    `Trigger: ${st.trigger || '—'}`,
    st.invalidation_condition ? `Invalidation: ${st.invalidation_condition}` : null,
    st.makro_alignment ? `Makro alignment: ${st.makro_alignment}${st.makro_alignment_reason ? ` (${st.makro_alignment_reason})` : ''}` : null,
    ageMin != null ? `Analisa ini dibuat ${ageMin} menit lalu — kalau sudah lama, harga bisa sudah bergerak jauh dari saat analisa dibuat.` : null,
  ].filter(Boolean).join('\n');

  const factParts = [setupBlock, fundBlock, rrBlock, trackBlock, calBlock].filter(Boolean);
  const userMsg = factParts.join('\n\n') + '\n\nBalas HANYA satu objek JSON valid (tanpa markdown fence, tanpa teks lain) persis format ini: {"objections":[{"severity":"tinggi","reason":"..."}],"verdict":"lanjut"}. Maksimal 3 objections. Kalau tidak ada keberatan berarti, objections HARUS array kosong [] dan verdict "lanjut".';

  const messages = [
    { role: 'system', content: 'Kamu auditor risiko trading yang skeptis. Setup yang diusulkan Senior Trader + fakta pasar terlampir adalah FAKTA, bukan tebakan. Tugasmu SATU-SATUNYA: cari alasan kenapa trade ini TIDAK layak diambil SEKARANG — fokus konflik makro, ancaman rilis kalender terdekat, crowded positioning (retail/COT), dan win-rate historis kalau tersedia. Maksimal 3 keberatan, masing-masing WAJIB mengutip angka/fakta KONKRET dari data terlampir — keberatan generik tanpa angka DILARANG. Kalau memang tidak ada keberatan berarti (data mendukung, tidak ada event dekat, positioning tidak ekstrem), verdict WAJIB "lanjut" dengan objections kosong — JANGAN mengarang risiko yang tidak ada di data. verdict: "lanjut" (tidak ada keberatan berarti) / "tunda" (ada keberatan tapi bisa dilewati dengan menunggu) / "batalkan" (keberatan fundamental terhadap tesis itu sendiri). Bahasa Indonesia.' },
    { role: 'user', content: userMsg },
  ];

  const SAMBANOVA_KEY = process.env.SAMBANOVA_API_KEY;
  const GROQ_KEY       = process.env.GROQ_API_KEY;
  let rawText = null, model = null;

  // Primary: SambaNova akun 1 — SAMA account/circuit dengan ohlcv_analyze primary
  // (memang endpoint fisik yang sama, circuit breaker WAJIB dibagi supaya outage
  // di satu tempat langsung terdeteksi di keduanya, bukan dites dobel).
  if (SAMBANOVA_KEY && await cb.canCall('ai:sambanova:main')) {
    try {
      if (!await allowAiCall('sambanova_main')) throw new Error('AI daily budget exceeded');
      const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY}` },
        body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 600, temperature: 0 }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) {
        const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
        if (rawText) await cb.onSuccess('ai:sambanova:main');
        else throw new Error('Empty response');
      } else { throw new Error(`HTTP ${r.status}`); }
    } catch(e) { console.warn('ohlcv_critic SambaNova failed:', e.message); await cb.onFailure('ai:sambanova:main'); }
  } else if (SAMBANOVA_KEY) { console.log('ohlcv_critic: SambaNova circuit OPEN — skipping to Groq'); }

  // Fallback: Groq (last resort, tanpa circuit breaker — pola sama dengan
  // fundamentalAnalysisHandler fallback 2, lihat daun_merah_plan.md Session 145).
  if (!rawText && GROQ_KEY) {
    try {
      if (!await allowAiCall('groq')) throw new Error('AI daily budget exceeded');
      const r = await fetch(GROQ_URL_FUND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL_FUND, messages, max_tokens: 600, temperature: 0 }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) {
        const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = GROQ_MODEL_FUND;
        if (!rawText) throw new Error('Empty response');
      } else { throw new Error(`HTTP ${r.status}`); }
    } catch(e) { console.warn('ohlcv_critic Groq fallback failed:', e.message); }
  }

  if (!rawText) {
    return res.status(200).json({ error: 'AI Kritikus tidak tersedia (SambaNova & Groq offline/limit habis) — coba lagi nanti.' });
  }

  let objections = null, verdict = null;
  try {
    const jsonStart = rawText.indexOf('{');
    const jsonEnd   = rawText.lastIndexOf('}');
    const cleaned   = jsonStart !== -1 && jsonEnd !== -1 ? rawText.slice(jsonStart, jsonEnd + 1) : rawText;
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.objections)) {
      objections = parsed.objections
        .filter(o => o && typeof o.reason === 'string' && o.reason.trim())
        .slice(0, 3)
        .map(o => ({ severity: o.severity === 'tinggi' ? 'tinggi' : 'sedang', reason: o.reason.trim() }));
    }
    verdict = ['lanjut', 'tunda', 'batalkan'].includes(parsed.verdict) ? parsed.verdict : (objections?.length ? 'tunda' : 'lanjut');
  } catch (e) {
    console.warn('ohlcv_critic: JSON parse gagal, fallback raw text:', e.message);
  }

  return res.status(200).json({
    objections, verdict, model,
    raw: objections === null ? rawText : undefined, // fallback tampilan mentah kalau parse gagal
    symbol, label,
    generated_at: new Date().toISOString(),
  });
}

// ── Pre-Entry Check — tombol "Pre-Entry Check" (Plan R, session 186 lanjutan) ────
// Auto-tick semua item deterministik sudah selesai CLIENT-SIDE (ckAutoTick/
// ckAutoTickFromAnalisa di index.html, lihat R-0/R-1) — endpoint ini HANYA menilai
// sisa item discretionary + mencari kontradiksi antar item yang sudah FAKTA (auto-tick).
// Pola SAMA dengan ohlcv_critic (AI Kritikus) di atas: SATU AI call, fact sheet
// deterministik dikirim client (bukan fetch ulang dari Redis — checklist state cuma
// hidup di localStorage per-device, lihat catatan "tidak ikut ter-sync" di PETUNJUK).
// DeepSeek v4-flash primary (Plan O sudah promosi jadi primary produksi) → SambaNova
// fallback. GARIS KERAS (Plan R): verdict = konteks keputusan, BUKAN auto-entry — user
// tetap yang menekan tombol entry sendiri, tidak ada eksekusi otomatis apa pun di sini.
async function preEntryCheckHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pair = req.body?.pair;
  const playbook = req.body?.playbook;
  let items = req.body?.items;
  if (!pair || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'pair dan items diperlukan' });
  }

  // Input klien di-cap defensif (sama pola dengan ohlcvAnalyzeHandler.ringkasanContext):
  // body adalah input publik, jangan biarkan array/string raksasa menggelembungkan prompt.
  items = items.slice(0, 80).map(it => ({
    label: String(it?.label || '').slice(0, 200),
    status: it?.status === 'tick' ? 'tick' : it?.status === 'block' ? 'block' : it?.checked ? 'checked' : 'unchecked',
    evidence: it?.evidence ? String(it.evidence).slice(0, 300) : null,
  }));

  const STATUS_TAG = { tick: '[FAKTA-TERPENUHI]', block: '[FAKTA-TIDAK TERPENUHI]', checked: '[MANUAL-DICENTANG]', unchecked: '[MANUAL-KOSONG]' };
  const factLines = items.map(it => `${STATUS_TAG[it.status]} ${it.label}${it.evidence ? ` — ${it.evidence}` : ''}`);
  const userMsg = `Playbook: ${String(playbook || '-').slice(0, 60)} | Pair: ${String(pair).slice(0, 20)}\n\n` +
    factLines.join('\n') +
    '\n\nBalas HANYA satu objek JSON valid (tanpa markdown fence, tanpa teks lain) persis format ini: {"verdict":"LAYAK","failed_items":[{"item":"...","alasan":"..."}],"catatan":"..."}. verdict HARUS persis "LAYAK" atau "TIDAK_LAYAK". failed_items maksimal 5, HANYA untuk item [MANUAL-KOSONG] yang menurutmu genuinely belum terpenuhi ATAU kontradiksi nyata yang kamu temukan antar item [FAKTA-*] — JANGAN mengarang alasan untuk item yang sudah [FAKTA-TERPENUHI]. catatan maksimal 2 kalimat.';

  const messages = [
    { role: 'system', content: 'Kamu auditor pre-entry checklist trading yang skeptis dan teliti. Item bertag [FAKTA-*] SUDAH diverifikasi deterministik dari data pasar real-time — JANGAN meragukan atau membantahnya, tugasmu HANYA: (1) menilai item [MANUAL-KOSONG] apakah genuinely masih kosong atau sebenarnya bisa disimpulkan dari fakta lain di atas, (2) mencari KONTRADIKSI LOGIS antar item [FAKTA-*] (misal satu bilang market trending, satu lagi bilang ranging — dua-duanya tidak boleh benar sekaligus). verdict "LAYAK" HANYA kalau tidak ada gate/section wajib yang gagal dan tidak ada kontradiksi berarti; "TIDAK_LAYAK" kalau ada. JANGAN sycophant — setup dengan banyak item [MANUAL-KOSONG] penting atau kontradiksi jelas HARUS dinilai TIDAK_LAYAK meski user berharap sebaliknya. Bahasa Indonesia.' },
    { role: 'user', content: userMsg },
  ];

  const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY;
  const SAMBANOVA_KEY = process.env.SAMBANOVA_API_KEY;
  let rawText = null, model = null;

  // Primary: DeepSeek v4-flash — 1 call/klik masuk pool 'deepseek' di _ai_guard.js
  // (limit harian 50, dibagi bersama Ringkasan/Analisa — lihat CB_DEEPSEEK market-digest.js).
  if (DEEPSEEK_KEY && await cb.canCall('ai:deepseek')) {
    try {
      if (!await allowAiCall('deepseek')) throw new Error('AI daily budget exceeded');
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 700, temperature: 0, response_format: { type: 'json_object' }, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) {
        const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
        if (rawText) await cb.onSuccess('ai:deepseek');
        else throw new Error('Empty response');
      } else {
        const errJ = await r.json().catch(() => ({}));
        throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
      }
    } catch(e) { console.warn('pre_entry_check DeepSeek failed:', e.message); await cb.onFailure('ai:deepseek'); }
  } else if (DEEPSEEK_KEY) { console.log('pre_entry_check: DeepSeek circuit OPEN — skipping to SambaNova'); }

  // Fallback: SambaNova akun 1 — circuit SAMA dengan ohlcv_analyze/ohlcv_critic (akun
  // fisik yang sama, lihat catatan ohlcv_critic di atas).
  if (!rawText && SAMBANOVA_KEY && await cb.canCall('ai:sambanova:main')) {
    try {
      if (!await allowAiCall('sambanova_main')) throw new Error('AI daily budget exceeded');
      const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY}` },
        body: JSON.stringify({ model: 'DeepSeek-V3.2', messages, max_tokens: 700, temperature: 0 }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) {
        const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v3.2';
        if (rawText) await cb.onSuccess('ai:sambanova:main');
        else throw new Error('Empty response');
      } else { throw new Error(`HTTP ${r.status}`); }
    } catch(e) { console.warn('pre_entry_check SambaNova fallback failed:', e.message); await cb.onFailure('ai:sambanova:main'); }
  } else if (!rawText && SAMBANOVA_KEY) { console.log('pre_entry_check: SambaNova circuit OPEN'); }

  if (!rawText) {
    // R-3 fallback (Plan R): AI tidak tersedia → client tampilkan hasil deterministik
    // saja (skor + item tercentang), fitur tetap berguna tanpa AI — bukan fitur mati.
    return res.status(200).json({ error: 'ai_unavailable', verdict: null, failed_items: null, catatan: null });
  }

  let verdict = null, failedItems = null, catatan = null;
  try {
    const jsonStart = rawText.indexOf('{');
    const jsonEnd   = rawText.lastIndexOf('}');
    const cleaned   = jsonStart !== -1 && jsonEnd !== -1 ? rawText.slice(jsonStart, jsonEnd + 1) : rawText;
    const parsed = JSON.parse(cleaned);
    verdict = ['LAYAK', 'TIDAK_LAYAK'].includes(parsed.verdict) ? parsed.verdict : null;
    if (Array.isArray(parsed.failed_items)) {
      failedItems = parsed.failed_items
        .filter(f => f && typeof f.alasan === 'string' && f.alasan.trim())
        .slice(0, 5)
        .map(f => ({ item: String(f.item || '').slice(0, 200), alasan: String(f.alasan).trim().slice(0, 300) }));
    }
    catatan = typeof parsed.catatan === 'string' ? parsed.catatan.trim().slice(0, 400) : null;
    if (!verdict) verdict = (failedItems && failedItems.length > 0) ? 'TIDAK_LAYAK' : 'LAYAK';
  } catch(e) {
    console.warn('pre_entry_check: JSON parse gagal:', e.message);
    return res.status(200).json({ error: 'parse_failed', verdict: null, failed_items: null, catatan: null, raw: rawText, model });
  }

  return res.status(200).json({
    verdict, failed_items: failedItems, catatan, model,
    pair, generated_at: new Date().toISOString(),
  });
}

async function ohlcvDashboardHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const pairs = await Promise.all(
      OHLCV_FIXED_PAIRS.map(async ({ symbol, label }) => {
        try {
          const [raw, rawSource] = await Promise.all([
            redisCmd('GET', `ohlcv:${symbol}:1h`),
            redisCmd('GET', `ohlcv:${symbol}:source`),
          ]);
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
          // M1: source diagnostik — 'yahoo' (default) atau 'twelvedata' (fallback aktif).
          let source1h = 'yahoo';
          try { source1h = (rawSource && JSON.parse(rawSource)['1h']) || 'yahoo'; } catch(e) {}
          return { symbol, label, available: true, trend, current: curr, change_pct: chg, dec, source: source1h };
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
        // Audit vendor 2026-07-12: oneDayPriceChange & liquidity SUDAH ada di response
        // yang sama (0 call tambahan, diverifikasi live). Momentum = pergeseran
        // probabilitas 24 jam dalam poin persen — "prob turun 62→48 semalam" adalah
        // sinyal yang tidak terlihat dari level saja. change_1d mengikuti outcome YA
        // (positif = pasar makin yakin YA).
        const rawChg = parseFloat(m.oneDayPriceChange);
        const change1d = (!isNaN(rawChg) && prob !== null) ? Math.round(rawChg * 100) : null;
        const liqRaw = parseFloat(m.liquidityNum ?? m.liquidity);
        return {
          question:  m.question,
          slug:      m.slug,
          category:  category || 'Macro',
          outcomes,
          prices:    prices.map(p => Math.round(parseFloat(p) * 100)),
          yes_prob:  prob,
          change_1d: change1d,
          liquidity: !isNaN(liqRaw) ? Math.round(liqRaw) : null,
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
module.exports.detectPushCat = detectPushCat;
module.exports._fundAgeDays = _fundAgeDays;
module.exports._formatFundDataLine = _formatFundDataLine;
module.exports._pickExpiryLevels = _pickExpiryLevels;
module.exports._confluenceZones = _confluenceZones;
module.exports._formatConfluenceBlock = _formatConfluenceBlock;
module.exports._evaluateSetups = _evaluateSetups;
module.exports._aggSetupStats = _aggSetupStats;
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
module.exports._formatTrackRecordBlock = _formatTrackRecordBlock;
module.exports._calEventMsWib = _calEventMsWib;
module.exports._buildAnalyzeCalBlock = _buildAnalyzeCalBlock;
