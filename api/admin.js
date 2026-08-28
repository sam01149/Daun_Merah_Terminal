// api/admin.js — consolidated admin endpoint
// GET/POST    /api/admin?action=health[&source=...]        → health check all sources
// GET/POST    /api/admin?action=redis-keys[&key=...]       → Redis key registry
// GET/POST/DELETE /api/admin?action=admin-prompts&key=...  → manage AI prompt templates
// GET         /api/admin?action=push                       → cron: send push notifications
//
// Auth: health/redis-keys/admin-prompts use x-admin-secret header
//       push uses x-cron-secret header
// Update cron-job.org URLs:
//   /api/health → /api/admin?action=health
//   /api/push   → /api/admin?action=push

const PUSH_KW  = require('./_push_keywords');
const newscat  = require('../newscat');
const { autoUpdateFundamentals, autoUpdateFundamentalsFromCalendar, _fetchCalendarEventsForFund, reconcileFundamentalKeys } = require('./_fundamental_parser');
const { getLiveCbRates } = require('./_cb_rates');
const { configureVapid, sendWebPush, subKey } = require('./_webpush');
const { isCronCall: _isCronCallReq, isCronDedupFresh } = require('./_cron_dedup');
const marketHours = require('./_market_hours');
const cb = require('./_circuit_breaker');
const rateLimit = require('./_ratelimit');
const { allowAiCall } = require('./_ai_guard');
const { requireAppKey, safeEqual } = require('./_app_key');
const { fetchYahooOhlcv1h, fetchFallbackCandles, shouldSendYahooAlert, mapYahooSymbolToDeriv, fetchDerivCandles, mergeVolumeByTimestamp } = require('./_ohlcv_fetch');
const { buildPairContext, computeCurrencyStrength } = require('./_pair_context');
const { validateTightenSl, computePreventiveTightenSl, _evaluateManaged, _aggManagementStats, isCorroborated } = require('./_position_review');
// isDrawdownHalted (Gate B) diaktifkan ulang 2026-08-22 (POLICY_EPOCHS v30) — lihat
// komentar di titik pemanggilannya untuk riwayat lengkap nonaktif (v29) -> aktif lagi.
const { isCorrelatedExposureBlocked, isTimingConflictBlocked, isInvalidationTriggered, INVALIDATION_TRIGGER_TYPES, INVALIDATION_TRIGGER_DIRECTIONS, INVALIDATION_TRIGGER_TIMEFRAMES, CORRELATED_PAIRS, POLICY_VERSION, POLICY_EPOCHS, policyVersionForTs, isDrawdownHalted, isDrawdownEmergencyValveOpen, AATAS_EPOCH, isGoldRegimeBlocked } = require('./_auto_entry_guard');
const { computeLevelCandidates } = require('./_levels');

// Gate D live-sign lookup (audit 2026-08-16): terjemahkan simbol Yahoo di
// CORRELATED_PAIRS ke label instrumen api/correlations.js, supaya sign statis di
// tabel itu bisa ditimpa kalau sistem SENDIRI sudah mendeteksi pergeseran rezim
// nyata. SENGAJA pakai `anomalies` (syarat |r20-r60|>0,4, ambang yang sudah dipakai
// & tervalidasi di tempat lain di correlations.js), BUKAN r20 mentah — r20 harian itu
// berisik (bisa lintas-nol tanpa perubahan rezim sungguhan untuk pasangan yang
// korelasinya memang tidak kuat); menimpa asumsi hasil riset manual dengan noise
// harian berisiko MENURUNKAN kualitas gate, bukan menaikkan (diskusi user
// 2026-08-16). Kalau tidak ada anomali terdeteksi untuk pasangan ini, diam-diam
// TIDAK override -> tetap pakai sign statis yang sudah diriset. Pasangan yang salah
// satu legnya bukan instrumen langsung di correlations.js (mis. CHFJPY=X, cross rate
// yang tidak difetch sendiri) juga sengaja TIDAK dipetakan -> fallback sign statis.
const CORR_SYMBOL_TO_LABEL = {
  'DX-Y.NYB': 'DXY', 'EURUSD=X': 'EUR', 'GBPUSD=X': 'GBP', 'USDJPY=X': 'JPY',
  'AUDUSD=X': 'AUD', 'USDCAD=X': 'CAD', 'NZDUSD=X': 'NZD', 'USDCHF=X': 'CHF',
  'GC=F': 'Gold',
};
function _buildLiveCorrSign(corrData) {
  if (!corrData || !Array.isArray(corrData.anomalies)) return null;
  const out = {};
  for (const { a, b } of CORRELATED_PAIRS) {
    const la = CORR_SYMBOL_TO_LABEL[a], lb = CORR_SYMBOL_TO_LABEL[b];
    if (!la || !lb) continue;
    const anomaly = corrData.anomalies.find(x => x.pair === `${la}|${lb}` || x.pair === `${lb}|${la}`);
    if (!anomaly || anomaly.r20 == null) continue;
    out[`${a}|${b}`] = anomaly.r20 >= 0 ? 'positive' : 'negative';
  }
  return out;
}

// Actions callable from the frontend without a secret → rate-limited per IP.
// AI-triggering actions get a tighter budget than cache reads.
const PUBLIC_ACTION_LIMITS = {
  fundamental_get:      30,
  fundamental_refresh:  10,
  fundamental_analysis:  5,
  ohlcv_read:           30,
  ohlcv_chart:          30,
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
      safeEqual(req.headers['x-cron-secret']  || '', process.env.CRON_SECRET) ||
      safeEqual(req.headers['x-admin-secret'] || '', process.env.CRON_SECRET)));
  if (!isCron && PUBLIC_ACTION_LIMITS[action]) {
    if (await rateLimit(req, res, { limit: PUBLIC_ACTION_LIMITS[action], windowSecs: 60, endpoint: `admin_${action}` })) return;
  }
  if (action === 'health')        return healthHandler(req, res);
  if (action === 'redis-keys')    return redisKeysHandler(req, res);
  if (action === 'admin-prompts') return adminPromptsHandler(req, res);
  if (action === 'push')                return pushHandler(req, res);
  if (action === 'inflation_staleness_check') return inflationStalenessCheckHandler(req, res);
  if (action === 'fundamental_get')     return fundamentalGetHandler(req, res);
  if (action === 'fundamental_seed')    return fundamentalSeedHandler(req, res);
  if (action === 'fundamental_refresh') return fundamentalRefreshHandler(req, res);
  if (action === 'fundamental_analysis') return fundamentalAnalysisHandler(req, res);
  if (action === 'journal_import')      return journalImportHandler(req, res);
  if (action === 'circuit-reset')       return circuitResetHandler(req, res);
  if (action === 'circuit-status')      return circuitStatusHandler(req, res);
  if (action === 'deepseek_balance')    return deepseekBalanceHandler(req, res);
  if (action === 'gdpnow')             return gdpnowHandler(req, res);
  if (action === 'ohlcv_sync')         return ohlcvSyncHandler(req, res);
  if (action === 'ohlcv_read')         return ohlcvReadHandler(req, res);
  if (action === 'ohlcv_chart')        return ohlcvChartHandler(req, res);
  if (action === 'ohlcv_analyze')      return ohlcvAnalyzeHandler(req, res);
  if (action === 'ohlcv_critic')       return ohlcvCriticHandler(req, res);
  if (action === 'pre_entry_check')    return preEntryCheckHandler(req, res);
  if (action === 'ohlcv_dashboard')    return ohlcvDashboardHandler(req, res);
  if (action === 'setup_stats')        return setupStatsHandler(req, res);
  if (action === 'setup_override')     return setupOverrideHandler(req, res);
  if (action === 'position_review')    return positionReviewHandler(req, res);
  if (action === 'friday_tighten')     return fridayTightenHandler(req, res);
  if (action === 'polymarket')         return polymarketHandler(req, res);
  if (action === 'push_subscribe_dev') return pushSubscribeDevHandler(req, res);
  if (action === 'setup_log_archive')  return setupLogArchiveHandler(req, res);
  return res.status(400).json({ error: 'Missing ?action= — use health, redis-keys, admin-prompts, push, inflation_staleness_check, fundamental_get, fundamental_seed, fundamental_refresh, fundamental_analysis, journal_import, circuit-reset, circuit-status, deepseek_balance, gdpnow, ohlcv_sync, ohlcv_read, ohlcv_chart, ohlcv_analyze, ohlcv_critic, pre_entry_check, ohlcv_dashboard, setup_stats, setup_override, position_review, friday_tighten, polymarket, push_subscribe_dev, or setup_log_archive' });
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

// ── Arsip setup_log_auto:v1 sebelum tergeser cap 200 (audit 2026-08-27) ────────
// Populasi AATAS v2 (policy_v>=31) baru n=5 (0 closed) saat audit ditulis — laju
// pengisian ~1.5 entri/hari BARU menyentuh cap 200 sekitar 9 minggu lagi, TAPI
// begitu tersentuh, entri tertua (bisa termasuk sampel n>=30 yang jadi dasar
// statistik AATAS) tergeser keluar PERMANEN (setup_log_auto:v1 ditulis via SET
// overwrite penuh, bukan append — lihat api/admin.js .slice(0,200) di jalur
// tulis auto-entry). Handler ini MURNI ADDITIVE dan read-mostly terhadap
// setup_log_auto:v1: baca apa adanya, gabung (dedup by id) ke key TERPISAH
// `setup_log_auto_archive:v1` (cap jauh lebih besar, 5000 — bukan 200). TIDAK
// PERNAH menulis balik ke setup_log_auto:v1 dan TIDAK menyentuh gate/keputusan
// auto-entry apa pun — nol risiko terhadap alur trading yang sedang berjalan.
// Dipicu terjadwal dari .github/workflows/setup-log-archive.yml (GH Actions),
// pola sama persis dengan setup-tp-sl-watch.yml (fallback GH Actions paralel
// daemon Railway, auth x-admin-secret/x-cron-secret === CRON_SECRET).
async function setupLogArchiveHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (!isVercelCron && (!CRON_SECRET || !safeEqual(secret || '', CRON_SECRET))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const rawCurrent = await redisCmd('GET', 'setup_log_auto:v1');
    const current = rawCurrent ? JSON.parse(rawCurrent) : [];
    const rawArchive = await redisCmd('GET', 'setup_log_auto_archive:v1');
    const archiveParsed = rawArchive ? JSON.parse(rawArchive) : [];
    const archive = Array.isArray(archiveParsed) ? archiveParsed : [];
    const seen = new Set(archive.map(x => x && x.id).filter(Boolean));
    const added = current.filter(x => x && x.id && !seen.has(x.id));
    if (added.length) {
      const merged = archive.concat(added).slice(-5000);
      await redisCmd('SET', 'setup_log_auto_archive:v1', JSON.stringify(merged));
    }
    return res.status(200).json({ ok: true, current_total: current.length, archive_total: archive.length + added.length, added: added.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// BUG DITEMUKAN & DIFIX (2026-07-25, audit lanjutan pasca-insiden GC=F): lock
// `lock:setuplog_write:*` sebelumnya SELALU dicoba SEKALI lalu skip-diam-diam kalau
// gagal (fail-open) — cukup aman untuk tick evaluasi pasif (self-healing tick
// berikutnya), TAPI fatal untuk jalur penulisan SINYAL AUTO-ENTRY: kalau lock kebetulan
// dipegang proses lain (makin mungkin sekarang setelah lebih banyak handler ikut pakai
// lock yang sama), satu panggilan AI yang sudah selesai & sukses bisa hilang TANPA JEJAK
// selain console.warn — sinyal trading nyata lenyap begitu saja. Helper ini retry
// singkat (default 4x, jeda 300ms, total <=1.2 detik — kecil dibanding latensi AI call
// yang sudah puluhan detik) sebelum benar-benar menyerah, dipakai KHUSUS di jalur tulis
// yang konsekuensinya nyata kalau hilang (bukan di tick evaluasi pasif yang memang
// sengaja fail-open cepat).
async function _acquireLockWithRetry(lockKey, { retries = 4, delayMs = 300, ttlSec = 10 } = {}) {
  for (let i = 0; i <= retries; i++) {
    const got = await redisCmd('SET', lockKey, '1', 'NX', 'EX', String(ttlSec)).catch(() => null);
    if (got === 'OK') return true;
    if (i < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
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

// 2026-08-13 (diskusi user, daun_merah.md Session 313): sejak fallback lintas-vendor
// dihentikan untuk pair yang primary-nya Deriv (lihat komentar di ohlcvSyncHandler —
// campur candle Deriv+Yahoo/Twelve Data di array yang sama dipakai evaluasi SL/TP
// auto-entry lebih berisiko daripada cache sedikit basi), kalau Deriv down cache
// TIDAK ter-refresh sama sekali (bukan diam-diam ganti vendor) — user perlu tahu ini
// terjadi, bukan cuma log server yang tidak pernah dilihat. Pola SAMA persis dengan
// trackYahooHealth (reuse shouldSendYahooAlert, generic pure function walau namanya
// Yahoo — threshold 3x sync beruntun, cooldown 6 jam) supaya satu mekanisme alert
// konsisten, bukan reinvent.
async function trackDerivHealth(derivFullyDownThisRun) {
  try {
    if (!derivFullyDownThisRun) {
      await redisCmd('DEL', 'deriv_fail_streak');
      return;
    }
    const streak = Number(await redisCmd('INCR', 'deriv_fail_streak')) || 1;
    const lastAlertRaw = await redisCmd('GET', 'deriv_last_alert_ts');
    const lastAlertTs = lastAlertRaw ? Number(lastAlertRaw) : 0;
    const now = Date.now();
    if (shouldSendYahooAlert(streak, lastAlertTs, now)) {
      await sendHealthTelegram(
        `🔴 *Daun Merah — Deriv OHLCV Down*\n\n` +
        `${streak}x sync beruntun: semua pair primary Deriv gagal fetch. Cache TIDAK di-fallback ke Yahoo/Twelve Data (kebijakan sejak Session 313 — hindari campur skala harga vendor di evaluasi SL/TP) — data candle akan makin basi sampai Deriv pulih.\n` +
        `Cek status Deriv API (\`ws.derivws.com\`) / app_id.\n\n` +
        `_Dicek: ${new Date(now).toISOString().substring(0, 16)} UTC_`
      );
      await redisCmd('SET', 'deriv_last_alert_ts', String(now));
    }
  } catch (e) { console.warn('trackDerivHealth failed:', e.message); }
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

// PLAN U-3 lanjutan (2026-07-20): probe di atas ('forexfactory') cek sumber XML lama yang
// SUDAH TIDAK dipakai lagi sejak calendar.js pindah ke TradingView (session 2026-07-13,
// fallback FF dihapus) — jadi tidak pernah membuktikan calendar_v1 sendiri sehat. Cache ini
// yang benar-benar dipakai fundamental_shock (U-1) & filter berita keras auto-entry (U-3);
// kalau pipeline TradingView->Redis rusak diam-diam (bukan sumbernya, tapi proses tulisnya),
// probe lama tetap bilang OK padahal calendar_v1 basi. Probe ini baca calendar_v1 LANGSUNG.
async function probeCalendarCache() {
  const raw = await redisCmd('GET', 'calendar_v1');
  if (!raw) throw new Error('calendar_v1 kosong/belum pernah ter-fetch');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error('calendar_v1 tidak valid JSON'); }
  const fetchedAtMs = obj.fetched_at ? new Date(obj.fetched_at).getTime() : NaN;
  if (isNaN(fetchedAtMs)) throw new Error('calendar_v1 tanpa fetched_at yang valid');
  const ageMins = Math.round((Date.now() - fetchedAtMs) / 60000);
  const STALE_THRESHOLD_MINS = 180; // 3 jam — longgar dari cadence normal (polling user tiap 90s + digest cron), cukup ketat untuk menangkap pipeline yang benar-benar mati
  if (ageMins > STALE_THRESHOLD_MINS) {
    throw new Error(`calendar_v1 basi: ${ageMins} menit sejak fetch terakhir (ambang ${STALE_THRESHOLD_MINS})`);
  }
  return { age_mins: ageMins, event_count: Array.isArray(obj.events) ? obj.events.length : null, source: obj.source || null };
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
  calendar_cache: { fn: probeCalendarCache,  label: 'Calendar Cache (calendar_v1, fundamental_shock)' },
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
  if (!CRON_SECRET || !safeEqual(req.headers['x-admin-secret'] || '', CRON_SECRET)) {
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

  // Pemakaian budget AI hari ini (observability untuk guard _ai_guard.js) — SEMUA
  // provider yang punya limit terdaftar (2026-08-15, sebelumnya cuma gemini/deepseek
  // hardcoded, luput mistral/mistral_newstranslate/nvidia/deepseek_experimental).
  let aiBudget = null;
  try {
    const { getUsage, DEFAULT_LIMITS } = require('./_ai_guard');
    const usages = await Promise.all(Object.keys(DEFAULT_LIMITS).map(getUsage));
    aiBudget = Object.fromEntries(usages.map(u => [u.provider, { used: u.used, limit: u.limit }]));
  } catch(e) { /* diagnostik opsional — jangan gagalkan health check */ }

  // Storage Redis (2026-08-15, dashboard Upstash 326K/500K command/bulan): REST
  // API data-plane (UPSTASH_REDIS_REST_URL/TOKEN, yang dipakai app ini) TIDAK
  // expose command-count bulanan atau ukuran byte — itu cuma ada di Management
  // API (kredensial akun terpisah, belum dikonfigurasi). DBSIZE (jumlah key) jadi
  // proxy TERDEKAT yang bisa diambil tanpa kredensial tambahan — cukup untuk
  // mengendus pertumbuhan tak wajar (key sampah/orphan menumpuk), BUKAN pengganti
  // cek dashboard Upstash langsung untuk command-count/storage-byte sesungguhnya.
  let redisKeyCount = null;
  try { redisKeyCount = await redisCmd('DBSIZE'); } catch(e) { /* opsional */ }

  // Akun 2 (2026-08-27): rate limit counter dipindah ke sini supaya tidak rebutan
  // kuota command dengan akun utama di atas — lihat api/_ratelimit.js.
  let redisKeyCount2 = null;
  try {
    const url2   = process.env.UPSTASH2_REDIS_REST_URL;
    const token2 = process.env.UPSTASH2_REDIS_REST_TOKEN;
    if (url2 && token2) {
      const r2 = await fetch(url2, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['DBSIZE']),
        signal: AbortSignal.timeout(5000),
      });
      redisKeyCount2 = (await r2.json()).result;
    }
  } catch(e) { /* opsional */ }

  return res.status(200).json({
    overall,
    checked_at: now,
    duration_ms: Date.now() - startTime,
    sources: report,
    ...(aiBudget ? { ai_budget: aiBudget } : {}),
    ...(redisKeyCount != null ? {
      redis_key_count: redisKeyCount,
      redis_note: 'DBSIZE — proxy jumlah key, BUKAN command-count/storage-byte bulanan (cek dashboard Upstash langsung untuk itu)',
    } : {}),
    ...(redisKeyCount2 != null ? { redis2_key_count: redisKeyCount2, redis2_note: 'DBSIZE akun 2 (rate limit)' } : {}),
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
  { key: 'latest_thesis',      owner: 'api/market-digest.js',  ttl_expected: 86400,  note: 'Structured trade thesis JSON from Call 3 (DeepSeek). TTL 6j->24j (audit 2026-08-28): jarak terjauh jadwal session-open 11,5j, lebih panjang dari TTL lama' },
  { key: 'correlations',       owner: 'api/correlations.js',   ttl_expected: 86400,  note: '20d+60d cross-asset correlation matrix' },
  { key: 'prompt_digest',      owner: 'api/admin.js',          ttl_expected: null,   note: 'AI prompt for market briefing (fallback: hardcoded)' },
  { key: 'health_last_ok',     owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET: source → last OK timestamp for alerting' },
  { key: 'push_subs',          owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET push subscriptions endpoint → JSON' },
  { key: 'push_subs_dev',      owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET push subscriptions dev-only (alert TP/SL setup_log_auto:v1) endpoint → JSON, terpisah dari push_subs publik' },
  { key: 'seen_guids_set',     owner: 'api/admin.js',          ttl_expected: 86400,  note: 'Redis SET of seen RSS GUIDs for push dedup (SADD/SMEMBERS, atomic)' },
  { key: 'push_lock',          owner: 'api/admin.js',          ttl_expected: 55,     note: 'Distributed lock to prevent concurrent push cron runs' },
  { key: 'sizing_history:*',   owner: 'api/sizing-history.js', ttl_expected: null,   note: 'Sorted set: sizing calculations per device (max 10 entries)' },
  { key: 'journal:*',          owner: 'api/journal.js',        ttl_expected: null,   note: 'Full journal entry JSON per device' },
  { key: 'journal_index:*',      owner: 'api/journal.js',        ttl_expected: null,   note: 'Sorted set: journal entry IDs by created_at timestamp' },
  { key: 'fundamental:*',        owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET fundamental data per currency (no TTL — overwritten when new data)' },
  { key: 'fundamental_analysis', owner: 'api/admin.js',          ttl_expected: 21600,  note: 'AI analysis of fundamental data (Gemini only), cached 6h' },
  { key: 'cb_decisions',         owner: 'api/market-digest.js',  ttl_expected: null,   note: 'HSET CB rate decisions detected from headlines, overrides CB_FALLBACK metadata' },
  { key: 'vps:heartbeat',        owner: 'vps/heartbeat.js',      ttl_expected: 300,    note: 'Plan Q-1: epoch beat daemon Render, dibaca api/admin.js?action=health source=vps_heartbeat' },
  { key: 'vps:heartbeat:configured', owner: 'vps/heartbeat.js',  ttl_expected: null,   note: 'Plan Q-1: marker permanen "daemon pernah jalan" — beda UNCONFIGURED (belum deploy) vs DOWN asli' },
  { key: 'selfheal:ohlcv_sync',      owner: 'api/admin.js + vps/daemon.js', ttl_expected: 3600,  note: 'NX lock self-heal: candle basi → trigger ohlcv_sync otomatis, maks 1x/jam lintas dua lapisan' },
  { key: 'selfheal:ohlcv_alert_ts',  owner: 'vps/daemon.js',     ttl_expected: 86400,  note: 'Dedup 6 jam alert Telegram "self-heal gagal, candle masih basi setelah trigger otomatis"' },
  { key: 'ohlcv_sync:last_run_at',   owner: 'api/admin.js',      ttl_expected: 5400,   note: 'Plan V-2: marker ISO timestamp cron dedup — GH Actions & Railway daemon Q-6 memicu ohlcv_sync 2x/jam, pemicu kedua dalam window 45 menit di-skip' },
  // Audit celah "kesalahan trader" auto-entry (Session 250, 2026-07-28) — counter
  // INCR polos, TTL none (akumulasi permanen, reset manual via DEL kalau perlu histori
  // baru). 'considered' = penyebut (kandidat yang lolos guard dup/blockedByOpenPosition
  // lama, dievaluasi ke-3 gate sisa); 'saved' = lolos semua gate; 3 sisanya = alasan
  // ditahan. considered = saved + correlation_cap + drawdown_circuit_breaker +
  // critic_veto berlaku untuk data SEBELUM 2026-08-20 DAN SESUDAH 2026-08-22 (invarian,
  // boleh dicek manual) — TIDAK berlaku untuk jendela 20-22 Agustus (POLICY_EPOCHS v29,
  // Gate B beku sementara sebelum diaktifkan ulang v30 dengan katup darurat waktu, lihat
  // isDrawdownEmergencyValveOpen di api/_auto_entry_guard.js). Gate C (regime_confidence)
  // DIHAPUS sesi sama (2026-07-28) — lihat DEPRECATED_KEYS + api/_auto_entry_guard.js.
  { key: 'auto_guard_stats:considered',              owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard: total kandidat auto-entry yang dievaluasi ke-3 gate sisa' },
  { key: 'auto_guard_stats:saved',                   owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard: kandidat lolos semua gate, tersimpan ke setup_log_auto:v1' },
  { key: 'auto_guard_stats:correlation_cap',         owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard Gate D: ditahan (correlated exposure XAU/USD-EUR/USD)' },
  { key: 'auto_guard_stats:drawdown_circuit_breaker', owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard Gate B: beku 20-22 Agustus 2026 (v29), aktif lagi sejak v30 dengan katup darurat waktu (isDrawdownEmergencyValveOpen)' },
  { key: 'auto_guard_stats:critic_veto',              owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard Gate A: AI Kritikus verdict "batalkan"' },
  // Gate A juga menimbang refine-in-place (2026-08-18) — counter TERPISAH dari yang di atas
  // (bukan campur ke 'considered'/'saved'/'critic_veto' milik kandidat BARU) karena semantiknya
  // beda: refine yang ditahan tidak membatalkan posisi pending-nya, cuma level baru yang tidak
  // diterapkan. '_refine' bisa nempel ke gateKey manapun (critic_veto/correlation_cap/
  // drawdown_circuit_breaker) tergantung gate mana yang menahan.
  { key: 'auto_guard_stats:saved_refine',             owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard: refine-in-place lolos semua gate, level baru diterapkan ke setup pending' },
  { key: 'auto_guard_stats:critic_veto_refine',        owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard Gate A: AI Kritikus verdict "batalkan" pada REFINE — level lama dipertahankan' },
  // Gate E DILONGGARKAN (2026-08-04, sesi sama dengan pembuatannya) dari hard block jadi
  // flag observasi non-blocking + konteks tambahan ke Gate A — lihat api/_auto_entry_guard.js.
  // TIDAK ikut invarian considered=saved+correlation_cap+drawdown+critic_veto di atas
  // (kandidat conflict:'waktu' tetap lanjut ke gate lain, jadi bisa dobel-hitung di sini).
  { key: 'auto_guard_stats:conflict_waktu_flagged',   owner: 'api/admin.js', ttl_expected: null, note: 'Audit-guard: kandidat bertanda conflict:"waktu" dari AI (observasi saja, TIDAK menahan — diteruskan ke Gate A dgn konteks tambahan)' },
  // AATAS v2 (2026-08-25): dua key observabilitas baru. Counter di bawah mengukur
  // KETATNYA ATURAN, bukan kejujuran model — dia hanya naik kalau Step 1-2 digagalkan
  // oleh pemeriksaan KODE (strong_vs_weak/jumlah konfirmasi/kata indikator terlarang)
  // padahal AI sendiri melaporkan lolos atau diam. TIDAK ikut invarian
  // considered=saved+... di atas (gate ini jalan SEBELUM kandidat sampai ke gate itu).
  { key: 'auto_guard_stats:gate1_code_override',      owner: 'api/admin.js', ttl_expected: null, note: 'AATAS v2 Gate 1: Step 1-2 digagalkan pemeriksaan KODE (bukan laporan AI) — indikator penilaian apakah aturan barunya terlalu ketat/longgar' },
  { key: 'aatas_reject_log:v1',                       owner: 'api/admin.js', ttl_expected: null, note: 'List (cap 200): kandidat auto-entry AATAS yang ditolak (alasan + seluruh field checklist + reasoning_note). Key TERPISAH dari setup_log_auto:v1 supaya cap 200 sampel nyata tidak tergeser keluar' },
  // Audit 2026-08-27: arsip preventif sebelum setup_log_auto:v1 (cap 200) menggeser
  // keluar entri lama secara permanen — lihat komentar lengkap di setupLogArchiveHandler.
  { key: 'setup_log_auto_archive:v1',                 owner: 'api/admin.js', ttl_expected: null, note: 'List gabungan (cap 5000) dari setup_log_auto:v1, di-merge dedup-by-id via action=setup_log_archive (GH Actions terjadwal). TIDAK PERNAH dibaca alur trading — murni cadangan sebelum cap 200 tergeser' },
  // [SISTEM HAKIM] aktivasi jalur cron (2026-07-29) — counter INCR polos terpisah dari
  // auto_guard_stats:* karena BUKAN gate (tidak pernah membatalkan penyimpanan sendiri).
  // 'considered' = setup auto-entry di mana cbDir tersedia (client/manual atau fallback
  // server _computeCbDirServerSide) & dicek terhadap bias; 'fired' = subset yang
  // konflik, forced conflict='arah'. Ukuran dampaknya yang sebenarnya (menang/kalah,
  // bukan cuma frekuensi) ada di setup_stats?scope=auto -> global.sistem_hakim_calibration.
  { key: 'sistem_hakim_stats:considered', owner: 'api/admin.js', ttl_expected: null, note: '[SISTEM HAKIM] auto-entry: cbDir tersedia & dicek vs bias teknikal' },
  { key: 'sistem_hakim_stats:fired',      owner: 'api/admin.js', ttl_expected: null, note: '[SISTEM HAKIM] auto-entry: konflik terdeteksi, conflict dipaksa "arah"' },
  { key: 'sistem_hakim_stats:corrected',   owner: 'api/admin.js', ttl_expected: null, note: '[SISTEM HAKIM] auto-entry (2026-08-05): cbDir SEARAH tapi AI salah klaim "konflik" — dikoreksi balik ke searah/none' },
  // Sapuan celah observabilitas (2026-08-05, audit "apa yang mengganggu pengumpulan
  // data" auto-entry): 9 key ini SUDAH lama ditulis (LPUSH/SET dari vps/daemon.js &
  // api/admin.js) tapi tidak pernah didaftarkan di sini — satu-satunya jalan bacanya
  // sebelum ini adalah akses Redis mentah langsung (di luar API resmi aplikasi).
  // Murni tambahan visibilitas baca, TIDAK mengubah perilaku auto-entry apa pun.
  { key: 'auto_skip_log',                  owner: 'vps/daemon.js', ttl_expected: null, note: 'List (cap 200): alasan auto-entry di-skip sebelum AI dipanggil (hard news/breaking news/kejutan ekonomi)' },
  { key: 'posreview_skip_log',             owner: 'vps/daemon.js', ttl_expected: null, note: 'List (cap 50): alasan review posisi berbasis berita di-skip (berita belum terkonfirmasi/UNCONFIRMED)' },
  { key: 'surprise_log:v1',                owner: 'vps/daemon.js', ttl_expected: null, note: 'List (cap 300): kejutan data ekonomi yang dievaluasi Gate "kejutan ekonomi" (Plan X, checkSurpriseSkip)' },
  { key: 'calendar_actual_latency_log:v1', owner: 'vps/daemon.js', ttl_expected: null, note: 'List (cap 100): sampel keterlambatan calendar_v1.actual vs waktu rilis asli (pollCalendarLatency, Plan U-3 sub-riset)' },
  { key: 'consistency_log:v1',             owner: 'vps/daemon.js', ttl_expected: null, note: 'List (cap 60): skor uji konsistensi jawaban AI (1 slot/hari, jalur diagnostik terpisah dari produksi)' },
  { key: 'position_review_log:v1',         owner: 'api/admin.js',  ttl_expected: null, note: 'List (cap 100): log tiap kali AI mengevaluasi ulang posisi terbuka (tighten_sl/close_early/hold)' },
  { key: 'xau_history',                    owner: 'api/market-digest.js', ttl_expected: null, note: 'List (cap 4): riwayat harga XAU untuk market-digest (beda fitur dari auto-entry)' },
  { key: 'daemon_news_cursor',             owner: 'vps/daemon.js', ttl_expected: 172800, note: 'Epoch ms terakhir polling berita diproses — indikasi daemon masih aktif memproses feed' },
  { key: 'daemon_degraded_alert_ts',       owner: 'vps/daemon.js', ttl_expected: null,   note: 'Epoch ms alert Telegram terakhir "Deriv WS reconnect gagal >10 menit" (dedup 6 jam, bukan indikator daemon mati total)' },
];

// Key list-type (LPUSH) & timestamp-string yang bernilai dibaca isinya, bukan cuma
// exists/ttl — dipisah dari auto_guard_stats:*/sistem_hakim_stats:* (integer INCR)
// di getKeyInfo karena tipe Redis-nya beda (LIST vs STRING).
const LIST_LOG_KEYS = new Set([
  'auto_skip_log', 'posreview_skip_log', 'surprise_log:v1',
  'calendar_actual_latency_log:v1', 'consistency_log:v1',
  'position_review_log:v1', 'xau_history', 'aatas_reject_log:v1',
]);
const TIMESTAMP_KEYS = new Set(['daemon_news_cursor', 'daemon_degraded_alert_ts']);

const DEPRECATED_KEYS = [
  { key: 'cot_cache',          replaced_by: 'cot_cache_v2',    note: 'Old COT format, superseded in Task 10b' },
  { key: 'fundamentals_cache', replaced_by: null,              note: 'Fundamentals tab removed from UI' },
  { key: 'seen_guids',         replaced_by: 'seen_guids_set',  note: 'JSON array replaced by Redis native SET for atomic dedup' },
  { key: 'auto_guard_stats:regime_confidence', replaced_by: null, note: 'Gate C dihapus (2026-07-28, sesi sama dengan pembuatannya) - buta arah, keputusan user' },
];

async function getKeyInfo(key) {
  if (key.includes('*')) return { exists: 'wildcard_pattern', ttl_actual: null };
  const [exists, ttl] = await Promise.all([redisCmd('EXISTS', key), redisCmd('TTL', key)]);
  const ttl_actual = ttl === -1 ? 'no_ttl' : ttl === -2 ? 'not_set' : ttl;
  // auto_guard_stats:* (Session 250) — counter INCR polos, nilainya sendiri yang
  // ingin dilihat (bukan cuma exists/ttl kayak key lain di registry). Dibatasi
  // prefix ini saja supaya tidak GET key non-string lain (hash/set/sorted-set)
  // yang bisa error/salah baca via GET biasa.
  if (key.startsWith('auto_guard_stats:') || key.startsWith('sistem_hakim_stats:')) {
    const raw = await redisCmd('GET', key);
    return { exists: exists === 1, ttl_actual, value: raw ? parseInt(raw, 10) : 0 };
  }
  if (TIMESTAMP_KEYS.has(key)) {
    const raw = await redisCmd('GET', key);
    return { exists: exists === 1, ttl_actual, value: raw ? new Date(Number(raw)).toISOString() : null };
  }
  if (LIST_LOG_KEYS.has(key)) {
    const raw = await redisCmd('LRANGE', key, '0', '19');
    let entries = raw || [];
    try { entries = entries.map(x => JSON.parse(x)); } catch (e) { /* biarkan mentah kalau bukan JSON */ }
    return { exists: exists === 1, ttl_actual, shown: entries.length, note: 'menampilkan 20 entri terbaru saja', entries };
  }
  return { exists: exists === 1, ttl_actual };
}

async function redisKeysHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || !safeEqual(req.headers['x-admin-secret'] || '', CRON_SECRET)) {
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
  if (!CRON_SECRET || !safeEqual(req.headers['x-admin-secret'] || '', CRON_SECRET)) {
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

  if (!CRON_SECRET || !safeEqual(req.headers['x-cron-secret'] || '', CRON_SECRET)) {
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

  // Telegram batch "N berita baru" DIHAPUS 2026-08-11 (Session 305 lanjutan) —
  // duplikat dengan alert Telegram Q-4/S304 (vps/daemon.js, sumber berita sama
  // FinancialJuice), sekarang jalur satu-satunya untuk Telegram. Push
  // notification ke device/browser subscriber (di bawah) TIDAK terdampak,
  // fitur beda (push_subs, bukan Telegram).

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

// ── Inflation staleness reminder (2026-08-15) ───────────────────────────────
// GBP/AUD INFLATION_EXPECTATIONS (real-yields.js) ketahuan lewat ambang stale
// 90 hari cuma karena diaudit manual — nilainya sendiri butuh riset per-currency
// ke sumber resmi bank sentral tiap update (BoE IAS/RBA SoMP/dst berbeda format,
// TIDAK aman di-auto-scrape, lihat daun_merah_progress.md). Daripada nunggu
// ketahuan manual lagi, cron mingguan ping ini + kirim Telegram begitu ada
// currency yang MELEWATI ambang — dedup per as_of (1x alert per rilis basi,
// bukan spam tiap minggu untuk currency yang sama sampai user update).
async function inflationStalenessCheckHandler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || !safeEqual(req.headers['x-cron-secret'] || '', CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized — set x-cron-secret header' });
  }
  const { INFLATION_EXPECTATIONS } = require('./real-yields');
  const now = Date.now();
  const stale = [];
  for (const [cur, inf] of Object.entries(INFLATION_EXPECTATIONS || {})) {
    const staleDays = Math.floor((now - new Date(inf.as_of).getTime()) / 86400000);
    if (staleDays > 90) stale.push({ cur, staleDays, source: inf.source, as_of: inf.as_of });
  }

  const toAlert = [];
  for (const s of stale) {
    const dedupKey = `inflation_stale_alerted:${s.cur}`;
    const lastAlertedAsOf = await redisCmd('GET', dedupKey).catch(() => null);
    if (lastAlertedAsOf === s.as_of) continue; // sudah pernah dialert untuk rilis yang sama
    toAlert.push(s);
    await redisCmd('SET', dedupKey, s.as_of).catch(() => {});
  }

  if (toAlert.length > 0) {
    const lines = toAlert.map(s => `• *${s.cur}*: ${s.staleDays} hari sejak ${s.as_of} (${s.source})`).join('\n');
    await sendHealthTelegram(
      `🟡 *Daun Merah — Data Inflasi Basi*\n\nReal yield ${toAlert.map(s => s.cur).join('/')} pakai ekspektasi inflasi >90 hari — cari rilis kuartalan terbaru & update \`INFLATION_EXPECTATIONS\` di \`api/real-yields.js\`:\n\n${lines}\n\n_Dicek: ${new Date(now).toISOString().substring(0, 16)} UTC_`
    );
  }

  return res.status(200).json({ stale_count: stale.length, alerted: toAlert.map(s => s.cur), stale: stale.map(s => s.cur) });
}

// ── Push Subscribe (dev-only, alert TP/SL setup_log_auto:v1) ────────────────
// TERPISAH TOTAL dari `push_subs` publik (api/subscribe.js, dipakai berita/
// digest) — auto-entry tetap scope developer-only (Plan U-7 REVISI
// VISIBILITAS, lihat dev-auto-entry.html). Kalau numpang hash publik, siapa
// pun user biasa yang subscribe notif berita bisa kebagian alert TP/SL
// eksperimen ini — bocor eksistensi fitur yang sengaja disembunyikan. Auth
// SAMA seperti aksi dev lain di file ini (x-admin-secret/x-cron-secret ==
// CRON_SECRET), BUKAN requireAppKey publik dari api/subscribe.js.
function _validDevPushSub(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || sub.endpoint.length > 1024) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  if (sub.keys.p256dh.length > 256 || sub.keys.auth.length > 64) return false;
  return true;
}

async function pushSubscribeDevHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  if (!CRON_SECRET || !safeEqual(secret || '', CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    if (req.method === 'DELETE') {
      const { endpoint } = body ? JSON.parse(body) : {};
      if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1024) {
        return res.status(400).json({ error: 'endpoint required' });
      }
      await redisCmd('HDEL', 'push_subs_dev', subKey(endpoint));
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const sub = parsed?.subscription;
    if (!_validDevPushSub(sub)) return res.status(400).json({ error: 'Invalid subscription' });
    const subData = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    };
    await redisCmd('HSET', 'push_subs_dev', subKey(sub.endpoint), JSON.stringify(subData));
    return res.status(201).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Kirim push (subscriber dev SAJA, lihat pushSubscribeDevHandler) saat setup
// setup_log_auto:v1 baru transisi ke tp/sl/ambiguous — dipanggil dari
// _buildAutoScopeStats setiap kali _evaluateSetups jalan (manual dev-console,
// trigger event-driven daemon.js Q-7, atau slot auto-entry 2x/hari), supaya
// TIDAK bergantung user membuka dev-auto-entry.html manual untuk tahu hasil.
async function _notifySetupOutcome(setup) {
  if (!configureVapid()) return;
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs_dev');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) { try { subs.push(JSON.parse(raw[i + 1])); } catch (e) {} }
    }
  } catch (e) {}
  if (!subs.length) return;
  const label = setup.label || setup.symbol;
  const outcomeText = setup.status === 'tp' ? 'kena TP' : setup.status === 'sl' ? 'kena SL' : 'ambigu (SL & TP di candle sama)';
  const level = setup.status === 'tp' ? setup.tp : setup.status === 'sl' ? setup.sl : `${setup.sl} / ${setup.tp}`;
  const payload = {
    title: `${label} ${outcomeText}`,
    body: `${setup.bias === 'bearish' ? 'Bearish' : 'Bullish'} entry ${setup.entry_zone} — level ${level}`,
    url: '/dev-auto-entry.html',
    icon: '/icon.svg',
  };
  try {
    const staleKeys = await sendWebPush(subs, payload);
    if (staleKeys.length) await redisCmd('HDEL', 'push_subs_dev', ...staleKeys).catch(() => {});
  } catch (e) { console.warn('_notifySetupOutcome: sendWebPush gagal:', e.message); }
}

// Push terpisah untuk transisi tp/sl yang DITAHAN oleh _corroborateGoldTransitions
// (lihat komentar di sana) — supaya user tahu ada breach yang ditunda verifikasi,
// bukan diam-diam ketinggalan sampai ada yang curiga manual (insiden GC=F:1785244513683,
// Session 260-261 daun_merah.md).
async function _notifyDivergenceHold(setup) {
  if (!configureVapid()) return;
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs_dev');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) { try { subs.push(JSON.parse(raw[i + 1])); } catch (e) {} }
    }
  } catch (e) {}
  if (!subs.length) return;
  const label = setup.label || setup.symbol;
  const wouldBe = setup.divergence_hold?.would_be_status === 'tp' ? 'TP' : 'SL';
  const payload = {
    title: `${label}: kena ${wouldBe} ditahan — perlu verifikasi`,
    body: `Candle ${setup.symbol} tembus level tapi sumber kedua (spot) tidak konfirmasi — kemungkinan divergensi futures/expiry, bukan pasar riil. Status tetap open, cek manual.`,
    url: '/dev-auto-entry.html',
    icon: '/icon.svg',
  };
  try {
    const staleKeys = await sendWebPush(subs, payload);
    if (staleKeys.length) await redisCmd('HDEL', 'push_subs_dev', ...staleKeys).catch(() => {});
  } catch (e) { console.warn('_notifyDivergenceHold: sendWebPush gagal:', e.message); }
}

function parsePushRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1 || r2)?.[1]?.trim() || ''; };
    const title = decodeXmlEntitiesAdmin(get('title')).replace(/^FinancialJuice:\s*/i, '').trim(), guid = get('guid'), link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title && !BLOCKED_HEADLINE_RE.test(title)) items.push({ title, guid, link });
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

// Judul auto-generated FinancialJuice yang pernah rusak ("Currency Strength Chart:
// Strongest: GBP, USD, AUD, CAD, NZD, JPY, CHF, NZD - Weakest") ikut disaring di sini
// juga — handler ini fetch FJ_RSS_URL LANGSUNG (bukan lewat /api/feeds?type=rss),
// jadi filter di feeds.js:stripBlockedHeadlines tidak menjangkau jalur ini. Sama
// persis pola/alasan dengan filter di feeds.js — lihat komentar di sana.
const BLOCKED_HEADLINE_RE = /currency strength chart/i;

// Duplikat dari feeds.js:decodeXmlEntities (bukan module `_*` bersama, sama alasan
// duplikasi BLOCKED_HEADLINE_RE di atas — jalur ini fetch XML FinancialJuice
// LANGSUNG, bukan lewat feeds.js). BUG DITEMUKAN & DIFIX (2026-08-15, audit §3.1):
// parseRSSHeadlines TIDAK decode entity ("&amp;" tetap literal), beda dari
// parseRSSItems (feeds.js, sudah didecode sejak fix S162) — akibatnya title yang
// sama ("External Migration & Visitors") menghasilkan 2 key fundamental berbeda
// tergantung pipeline mana yang memproses duluan (fragmentasi key NZD, ketahuan
// live saat audit). Pasang decode yang sama di sini & parsePushRSS di bawah (pola
// sama, XML mentah yang sama) supaya title selalu ternormalisasi sebelum dipakai
// jadi key Redis atau ditampilkan di push notification.
const XML_NAMED_ENTITIES_ADMIN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeXmlEntitiesAdmin(s) {
  if (!s) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = (ent[1] === 'x' || ent[1] === 'X') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_NAMED_ENTITIES_ADMIN[ent] !== undefined ? XML_NAMED_ENTITIES_ADMIN[ent] : m;
  });
}

function parseRSSHeadlines(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=decodeXmlEntitiesAdmin(get('title')).replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate');
    if (guid && title && !BLOCKED_HEADLINE_RE.test(title)) items.push({ title, guid, pubDate });
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

    // Plan W-5 (2026-08-03): calendar_v1.actual (TradingView, terstruktur) dicoba
    // DULU sebagai lapis tambahan sebelum parsing headline FinancialJuice — kalau
    // rilis yang sama juga muncul di headline, nilainya konsisten (real-world sama).
    let calendarUpdated = {};
    try {
      const calendarEvents = await _fetchCalendarEventsForFund(redisCmd);
      if (calendarEvents.length > 0) calendarUpdated = await autoUpdateFundamentalsFromCalendar(calendarEvents, redisCmd);
    } catch(e) { console.warn('fundamental_refresh: calendar layer gagal:', e.message); }

    // Audit 2026-08-12 (laporan user, confidence JPY selalu "rendah"): bersihkan key
    // yatim (case-mismatch/sinonim rilis) tiap refresh — lihat komentar
    // reconcileFundamentalKeys di _fundamental_parser.js. Idempotent, aman gagal-diam.
    let reconciled = {};
    try { reconciled = await reconcileFundamentalKeys(redisCmd); } catch(e) { console.warn('fundamental_refresh: reconcile gagal:', e.message); }

    if (headlines.length === 0) return res.status(200).json({ updated: calendarUpdated, calendar_updated: calendarUpdated, reconciled, headlines: 0 });

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

    // BUG DITEMUKAN & DIFIX (2026-08-15, audit §3.1, laporan user): 'CPI YoY'/
    // 'CPI MoM' EUR ternyata rilis INSEE Prancis (actual 2.1%/prev 2.9% YoY,
    // actual 0.6%/prev 0.3% MoM — dikonfirmasi cocok persis data resmi INSEE 14
    // Agu 2026, BUKAN Eurostat/Eurozone yang seharusnya ~2.9% YoY, lihat 'CPI
    // Flash YoY' yang tetap benar). Root cause: nilai ini DITULIS SEBELUM guard
    // EUR_INFLATION_KEYS (commit 71ee23a, 2026-08-15 pagi) dideploy — guard
    // sekarang mencegah tulisan BARU dari rilis 1 negara anggota, tapi tidak
    // retroaktif membersihkan nilai lama yang sudah kepalang tertulis (beda dari
    // reconcileFundamentalKeys yang menangani key DUPLIKAT, bukan value SALAH di
    // key yang namanya sudah benar). One-time cleanup: hapus KALAU nilai masih
    // persis kombinasi yang sudah diverifikasi salah ini (exact-match, bukan
    // heuristik umum — supaya tidak pernah menghapus data baru yang sah begitu
    // rilis Eurozone-wide resmi berikutnya masuk). Auto no-op selamanya setelah
    // sukses sekali.
    try {
      const EUR_FR_CONTAMINATION = {
        'CPI YoY': { actual: '2.1%', previous: '2.9%' },
        'CPI MoM': { actual: '0.6%', previous: '0.3%' },
      };
      const eurBadKeys = Object.keys(EUR_FR_CONTAMINATION);
      const eurRaw = await redisCmd('HMGET', 'fundamental:EUR', ...eurBadKeys);
      const eurDelArgs = ['HDEL', 'fundamental:EUR'];
      for (let i = 0; i < eurBadKeys.length; i++) {
        const raw = eurRaw?.[i];
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw);
          const bad = EUR_FR_CONTAMINATION[eurBadKeys[i]];
          if (entry.actual === bad.actual && entry.previous === bad.previous) {
            eurDelArgs.push(eurBadKeys[i]);
          }
        } catch(_) {}
      }
      if (eurDelArgs.length > 2) await redisCmd(...eurDelArgs);
    } catch(e) { console.warn('sanitize EUR France-contamination failed:', e.message); }

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

    return res.status(200).json({ updated, calendar_updated: calendarUpdated, reconciled, headlines: headlines.length, gdp_nowcast_refreshed: gdpUpdated });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
// Gemini AI Studio — PRIMARY fundamental_analysis (2026-08-10 satu-satunya provider;
// 2026-08-11 sempat didemote jadi fallback di belakang SambaNova akun 2; 2026-08-12
// dipromosikan BALIK jadi primary/satu-satunya — SambaNova akun 2 diputus kontrak
// total setelah akunnya diblokir billing SambaNova sendiri, "A payment method is
// required", dan ganti API key TIDAK memperbaikinya, lihat daun_merah_vendor.md)
// + fallback terakhir journal AI Coach (2026-07-19).
// Konstanta sama dengan market-digest.js (GEMINI_URL/GEMINI_MODEL/CB_GEMINI di
// sana): endpoint OpenAI-compat resmi, alias -latest supaya tidak basi saat Google
// ganti generasi (sekarang resolve ke gemini-3.5-flash). Lolos gate ToS produksi
// (daun_merah_riset.md S183: free tier boleh produksi, prompt = berita publik).
// Budget guard 'gemini' sudah ada di _ai_guard.js. NVIDIA API (GLM 5.2/Nemotron)
// SENGAJA tidak dipakai — ToS Trial melarang produksi (dicek ulang live 2026-08-11,
// masih berlaku) DAN riwayat tes live proyek ini sendiri gagal teknis (Plan N,
// session 145-147) — lihat KEPUTUSAN GATE AWAL di daun_merah_riset.md.
const GEMINI_URL_FUND   = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL_FUND = 'gemini-flash-latest';
// Circuit key SENGAJA khusus fitur ini (2026-08-25, sebelumnya 'ai:gemini' dipakai
// bersama market-digest.js & journal.js) — lihat penjelasan lengkap di CB_GEMINI
// market-digest.js & daun_merah.md Session 328.
const CB_GEMINI_ADMIN   = 'ai:gemini:fundamental';

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
    // "Retail Sales MoM" DIHAPUS 2026-08-10 (permintaan user, riset web terverifikasi):
    // ABS resmi menghentikan publikasi "Retail Trade, Australia" setelah rilis Juni
    // 2025, digantikan indikator ini — seed lama tidak akan PERNAH bisa ke-update lagi
    // lewat jalur otomatis apa pun karena rilis aslinya sudah tidak diterbitkan. Lihat
    // daun_merah.md Session 298 lanjutan.
    'Household Spending MoM': { actual:'0.8%',   period:'Jun 2026',    date:'—', source:'seed' },
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
    // Ditambah 2026-07-29 — parser sudah kenal keyword ini (prefix 'nz pmi'/'new
    // zealand pmi', 'new zealand business'), tapi belum pernah diseed sebagai
    // starting point. Sebelumnya NZD cuma 6 indikator (mentok tier "Med").
    'Manufacturing PMI': { actual:'48.5',       period:'Apr 2026',    date:'—', source:'seed' },
    'Business Confidence':{ actual:'15',        period:'Apr 2026',    date:'—', source:'seed' },
  },
  CHF: {
    'GDP QoQ':           { actual:'0.2%',       period:'Q4 2025',     date:'—', source:'seed' },
    'SNB Rate':          { actual:'0.0%',       period:'Mar 2026',    date:'—', source:'seed' },
    'CPI YoY':           { actual:'0.6%',       period:'Apr 2026',    date:'—', source:'seed' },
    'KOF Barometer':     { actual:'97.9',       period:'Apr 2026',    date:'—', source:'seed' },
    'Unemployment Rate': { actual:'2.8%',       period:'Q1 2026',     date:'—', source:'seed' },
    // Ditambah 2026-07-29 — parser sudah kenal keyword ini (prefix 'swiss trade'/
    // 'switzerland trade', 'swiss retail'/'switzerland retail'), tapi belum pernah
    // diseed. CHF sebelumnya cuma 5 indikator, currency paling sedikit datanya.
    'Trade Balance':     { actual:'3200M CHF',  period:'Mar 2026',    date:'—', source:'seed' },
    'Retail Sales MoM':  { actual:'0.3%',       period:'Mar 2026',    date:'—', source:'seed' },
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

// Query opsional (2026-08-03, Plan W-3/W-4 temuan 3): `?currency=AUD&key=GDP%20QoQ`
// men-scope seed HANYA ke 1 currency/indikator, dipakai buat tambal seed drift
// (kode FUND_SEED sudah diupdate manual tapi endpoint ini belum pernah dipicu ulang
// untuk field itu) TANPA nge-overwrite indikator lain di currency yang sama yang
// sudah ter-update live dari berita asli (lihat AUD contoh nyata: Employment
// Change/Unemployment Rate/Trade Balance/NAB Business Conf sudah source:'headline',
// full reseed AUD akan menimpa balik ke nilai seed lama — HARUS scoped per-field).
// Tanpa param = perilaku lama (full reseed semua currency), backward-compatible.
async function fundamentalSeedHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || !safeEqual(req.headers['x-admin-secret'] || '', CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const onlyCurrency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
  const onlyKey = req.query.key || null;
  const seededAt = new Date().toISOString();
  try {
    const written = [];
    for (const [cur, indicators] of Object.entries(FUND_SEED)) {
      if (onlyCurrency && cur !== onlyCurrency) continue;
      const args = ['HSET', `fundamental:${cur}`];
      let any = false;
      for (const [key, val] of Object.entries(indicators)) {
        if (onlyKey && key !== onlyKey) continue;
        args.push(key, JSON.stringify({ ...val, seeded_at: seededAt }));
        any = true;
      }
      if (any) {
        await redisCmd(...args);
        written.push(cur);
      }
    }
    return res.status(200).json({ ok: true, seeded: written, scoped: !!(onlyCurrency || onlyKey) });
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

// Umur SEJAK SEED (bukan sejak rilis data asli — itu tidak diketahui untuk entri
// seed, lihat _fundAgeDays). Dipakai HANYA saat `date` masih '—' (Plan W-3,
// 2026-08-03): entri seed sebelumnya lolos tanpa peringatan umur sama sekali,
// beda dari real-yields.js yang punya flag stale eksplisit setelah 90 hari.
function _fundSeedAgeDays(seededAt, nowMs = Date.now()) {
  if (!seededAt) return null;
  const ms = nowMs - new Date(seededAt).getTime();
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
  if (age !== null) {
    extras.push(age === 0 ? 'rilis hari ini' : `rilis ${age} hari lalu`);
  } else {
    const seedAge = _fundSeedAgeDays(v.seeded_at, nowMs);
    if (seedAge !== null) extras.push(seedAge === 0 ? 'berdasar data seed, belum terkonfirmasi update — diseed hari ini' : `berdasar data seed, belum terkonfirmasi update — sejak ${seedAge} hari lalu`);
  }
  if (v.previous && v.previous !== '—' && v.previous !== v.actual) extras.push(`sebelumnya ${v.previous}`);
  // Audit 2026-08-12: forecast (ekspektasi konsensus pasar sebelum rilis) — dulu
  // dibuang di parser walau sudah ada di sumber (FinancialJuice & calendar_v1),
  // AI cuma bisa lihat actual vs previous (arah bulan-ke-bulan), tidak pernah tahu
  // apakah rilis itu beat/miss ekspektasi pasar (sering lebih market-moving).
  if (v.forecast && v.forecast !== '—' && v.forecast !== v.actual) extras.push(`forecast ${v.forecast}`);
  if (extras.length > 0) parts.push(` [${extras.join('; ')}]`);
  return parts.join('');
}

// Backstop terhadap Gemini yang tetap menulis markdown (**tebal**, *miring*, ### header,
// bullet "-"/"*", pemisah "---") walau prompt sudah eksplisit melarangnya (2026-08-10,
// terbukti di produksi — instruksi prompt saja tidak cukup diandalkan). Output fitur ini
// ditampilkan lewat textContent (plain text, bukan parser markdown), jadi karakter itu
// harus dibuang di sisi kode, bukan cuma diminta lewat prompt.
function _stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')            // baris pemisah "---"/"***"/"___"
    .replace(/^#{1,6}\s+/gm, '')                    // header "### Judul" -> "Judul"
    .replace(/^([ \t]*)[-*]\s+/gm, '$1')            // bullet "- " / "* " di awal baris
    .replace(/\*\*(.+?)\*\*/g, '$1')                // **tebal** -> tebal
    .replace(/__(.+?)__/g, '$1')                    // __tebal__ -> tebal
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1') // *miring* -> miring
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '$1')   // _miring_ -> miring
    .replace(/`([^`]+)`/g, '$1')                    // `kode` -> kode
    .replace(/\n{3,}/g, '\n\n')                     // rapikan baris kosong beruntun bekas "---"
    .trim();
}

// Ekstrak urutan 8 currency dari section "RANKING KEKUATAN FUNDAMENTAL:" di output AI
// (2026-08-11 — fitur "pergerakan ranking vs update sebelumnya", respons user "gimana
// kalau dikembangkan"). Parse murni deterministik dari teks yang SUDAH di-generate —
// TIDAK minta AI menghitung delta sendiri (rawan salah hitung/hallucinate), delta
// dihitung di kode lewat _formatFundRankingDelta di bawah. Gagal parse (format AI
// menyimpang) -> null, fail-open (delta cuma tidak ditampilkan, bukan error).
function _parseFundRankingOrder(text) {
  if (!text) return null;
  const m = text.match(/RANKING KEKUATAN FUNDAMENTAL:\s*([\s\S]*?)(?:\n\s*\n|TERKUAT:|$)/i);
  if (!m) return null;
  const CUR_RE = /\b(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF)\b/;
  const order = [];
  for (const line of m[1].split('\n')) {
    const lm = line.trim().match(/^\d+\.\s*(.*)$/);
    if (!lm) continue;
    const cm = lm[1].match(CUR_RE);
    if (cm) order.push(cm[1]);
  }
  const uniq = [...new Set(order)];
  return uniq.length === 8 ? uniq : null;
}

// Bandingkan ranking baru vs sebelumnya, hasilkan 1 blok teks deterministik (bukan
// ditulis AI) yang ditempel ke akhir `analysis`. hoursLabel sudah diformat pemanggil.
function _formatFundRankingDelta(prevOrder, newOrder, hoursLabel) {
  if (!Array.isArray(prevOrder) || !Array.isArray(newOrder) || prevOrder.length !== 8 || newOrder.length !== 8) return null;
  const prevPos = {}; prevOrder.forEach((c, i) => { prevPos[c] = i + 1; });
  const clauses = newOrder.map((cur, i) => {
    const np = i + 1, pp = prevPos[cur];
    if (pp == null) return `${cur} baru di #${np}`;
    if (pp === np) return `${cur} tetap #${np}`;
    return `${cur} ${pp > np ? 'naik' : 'turun'} ke #${np} (dari #${pp})`;
  });
  return `PERGERAKAN RANKING VS UPDATE SEBELUMNYA (${hoursLabel}):\n${clauses.join('. ')}.`;
}

async function fundamentalAnalysisHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'No AI provider configured (GEMINI_API_KEY)' });
  }

  // Return cached if fresh (6h). Cache lama juga dipertahankan sebagai `previousObj`
  // (dipakai di bawah untuk hitung pergerakan ranking vs update sebelumnya, 2026-08-11)
  // BAHKAN kalau sudah basi/force=true — delta tetap valid selama ada angka lama untuk
  // dibandingkan, cuma label "X jam lalu" jadi lebih besar.
  let previousObj = null;
  try {
    const cached = await redisCmd('GET', 'fundamental_analysis');
    if (cached) {
      previousObj = JSON.parse(cached);
      if (req.query.force !== 'true' && Date.now() - new Date(previousObj.generated_at).getTime() < 6 * 3600 * 1000) {
        return res.status(200).json({ ...previousObj, from_cache: true });
      }
    }
  } catch(e) {}

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

  const prompt = `Kamu adalah analis forex makro senior. Berikut data fundamental ekonomi terbaru per currency:

${dataBlock}

Tugasmu BUKAN sekadar mengurutkan 8 currency dari terkuat ke terlemah — itu cuma kesimpulan akhir. Yang lebih penting adalah SINTESA: gambaran koheren tiap currency (rezim pertumbuhan-inflasi, arah kebijakan moneter, tenaga kerja) dan tema besar yang menghubungkan mereka, bukan daftar angka yang dibaca ulang.

ATURAN BOBOT WAKTU (penting — pasar men-trade data terbaru, bukan level lama):
- Beri bobot TERBESAR pada data dengan tag "rilis <=14 hari lalu", terutama yang berubah vs "sebelumnya" — arah perubahan (membaik/memburuk) lebih penting daripada level absolutnya.
- Data tanpa tag rilis atau lebih tua dari ~45 hari perlakukan sebagai latar belakang, BUKAN bukti utama ranking.
- Currency yang beberapa rilis terbarunya konsisten membaik layak naik ranking meski levelnya biasa saja; sebaliknya level bagus yang datanya basi dan mulai memburuk harus turun.
- Indikator yang MEMANG kuartalan/musiman menurut sifatnya (mis. GDP QoQ, CPI QoQ negara yang rilis inflasinya per-kuartal seperti AUD/NZD) WAJAR berumur 1-3 bulan di antara rilis — itu bukan tanda data rusak/diabaikan, cuma siklus rilis normal. Bedakan dari indikator yang SEHARUSNYA rilis bulanan tapi tag-nya "berdasar data seed, belum terkonfirmasi update" — itu baru sinyal data benar-benar tidak ter-update, bukan sekadar tenor rilisnya panjang.
- Kalau ada tag "forecast X" di suatu indikator, itu ekspektasi konsensus pasar SEBELUM rilis — bandingkan actual vs forecast (beat/in-line/miss), bukan cuma actual vs "sebelumnya". Rilis yang beat ekspektasi (walau levelnya turun dari bulan lalu) sering lebih bullish bagi currency itu daripada rilis yang cuma sama dengan bulan lalu tapi miss ekspektasi — beat/miss vs konsensus adalah sinyal yang biasanya lebih menggerakkan pasar daripada arah vs previous saja.

KERANGKA ANALISIS per currency (pakai ini untuk menyusun OUTLOOK, bukan buat mengarang indikator yang tidak ada di data):
1. Arah & momentum kebijakan moneter: level suku bunga + status (baru dinaikkan/dipangkas/ditahan) = hawkish/netral/dovish. PAKAI KRITERIA INI KONSISTEN untuk SEMUA 8 currency TERMASUK CHF — status "safe-haven" CHF adalah karakteristik struktural, BUKAN alasan untuk mengabaikan suku bunga rendah/inflasi ultra-rendahnya sendiri. Kalau CHF tetap dinaikkan ranking meski suku bunganya terendah, jelaskan alasan konkret (mis. capital inflow risk-off), bukan cuma label "safe-haven" generik.
2. Rezim pertumbuhan-inflasi: klasifikasikan tiap currency sebagai salah satu — "reflasi" (growth & inflasi sama-sama naik), "disinflasi sehat" (inflasi turun, growth tetap positif — goldilocks), "stagflasi" (growth lemah, inflasi masih tinggi), atau "perlambatan" (growth & inflasi sama-sama turun). Dasarkan pada GDP/PMI vs CPI/PPI yang ADA di data, jangan menebak angka yang tidak disebutkan.
3. Tenaga kerja: unemployment rate + employment change + klaim (kalau datanya ada) — ketat/melonggar/lemah.
4. Sensitivitas komoditas kalau relevan: AUD terhadap commodity prices (terutama minerals), NZD terhadap ekspor dairy & demand Asia, CAD terhadap harga minyak.
5. PMI: >50 = ekspansi, <50 = kontraksi.
6. JANGAN memakai satu indikator sebagai bukti kesimpulan indikator lain yang tidak berkaitan langsung — misal PPI (harga di level produsen) TIDAK membuktikan kuat/lemahnya permintaan konsumen (itu urusan Retail Sales/Consumer Spending); PPI turun/negatif berarti tekanan deflasi di sisi produsen, BUKAN bukti demand domestik kuat.
7. Confidence data: kalau mayoritas indikator currency itu bertag data seed / belum terkonfirmasi update, atau usianya lebih dari ~45 hari, tandai confidence currency itu "rendah" secara eksplisit — jangan menutupi kelemahan data dengan narasi yang terdengar percaya diri.

JANGAN mengarang tanggal rilis, angka, atau event kalender yang tidak ada di data di atas.

JANGAN pakai markdown sama sekali (tanpa **tebal**, *miring*, tanda pagar #, bullet "-"/"*", atau pemisah "---") — outputmu ditampilkan APA ADANYA sebagai teks polos, bukan lewat parser markdown, jadi karakter-karakter itu akan muncul literal dan merusak tampilan. Pakai HURUF KAPITAL untuk nama currency/header seperti contoh format di bawah, dan angka urut biasa (1. 2. 3.) untuk daftar.

Format jawaban WAJIB (Bahasa Indonesia, padat tapi tersintesa — fokus pada MAKNA & keterkaitan antar indikator, bukan menyalin ulang angka mentah yang sudah ada di grid data):

TEMA MAKRO LINTAS-CURRENCY:
[2-3 kalimat: pola besar yang terlihat lintas 8 currency — misal rate divergence yang melebar/menyempit, kelompok currency yang bergerak searah karena tema sama (commodity, risk sentiment, dsb)]

OUTLOOK PER CURRENCY:
USD — [rezim growth-inflasi] + [arah/momentum kebijakan moneter] + [tenaga kerja singkat]. Confidence data: [tinggi/sedang/rendah].
EUR — ...
GBP — ...
JPY — ...
CAD — ...
AUD — ...
NZD — ...
CHF — ...
(1-2 kalimat per currency; jelaskan MAKNA gabungan datanya, bukan sekadar sebut ulang angka)

RANKING KEKUATAN FUNDAMENTAL:
1. [currency] — [alasan satu kalimat, merujuk outlook di atas]
2. [currency] — [alasan satu kalimat]
... (8 currency)

TERKUAT: [currency]
[2 kalimat ringkasan kenapa paling kuat]

TERLEMAH: [currency]
[2 kalimat ringkasan kenapa paling lemah]

SETUP FUNDAMENTAL PALING SEARAH:
1. [currency A] vs [currency B] — [1 kalimat kenapa fundamental dua sisi paling mendukung satu arah]
2. [currency C] vs [currency D] — [1 kalimat]
3. [currency E] vs [currency F] — [1 kalimat]
(Ini untuk identifikasi pair dengan setup fundamental paling kuat — bukan rekomendasi entry)

PERLU DIWASPADAI:
[1-3 poin singkat: currency dengan confidence data rendah yang rankingnya jangan terlalu dipercaya, ATAU currency yang arah fundamentalnya baru mulai berbalik (momentum belum established) sehingga posisinya di ranking rawan berubah di rilis berikutnya. Kalau tidak ada yang perlu diwaspadai, tulis satu baris: "Tidak ada — data cukup segar dan konsisten."]`;

  const fundMessages = [{ role: 'user', content: prompt }];
  let analysis = null;

  // Primary — SATU-SATUNYA provider (2026-08-12: SambaNova akun 2 diputus kontrak
  // total, akunnya diblokir billing SambaNova sendiri — "A payment method is required" —
  // ganti API key TIDAK memperbaikinya, jadi diputuskan cabut daripada terus retry
  // provider yang butuh bayar. Gemini dipromosikan balik jadi primary, lihat
  // daun_merah_vendor.md). Retry 1x — Gemini free tier sesekali balas 503 overloaded,
  // transient, percobaan ulang identik langsung sukses (temuan Session 307).
  // Jeda 2s antar percobaan (2026-08-25): dibuktikan manual 2x retry BERUNTUN tanpa
  // jeda kena 503 "high demand" identik berturut-turut — kemungkinan overload belum
  // sempat reda. Timeout per percobaan dikecilkan 25s->22s supaya 2 percobaan + jeda
  // (22+22+2=46s) tetap muat aman di bawah maxDuration 60s & AbortSignal client 55s.
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (GEMINI_KEY && await cb.canCall(CB_GEMINI_ADMIN)) {
    for (let attempt = 1; attempt <= 2 && !analysis; attempt++) {
      try {
        if (!await allowAiCall('gemini')) throw new Error('AI daily budget exceeded');
        if (attempt === 2) await new Promise(r => setTimeout(r, 2000));
        const r = await fetch(GEMINI_URL_FUND, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_KEY}` },
          body: JSON.stringify({ model: GEMINI_MODEL_FUND, messages: fundMessages, max_tokens: 3500, temperature: 0.3, reasoning_effort: 'low' }),
          signal: AbortSignal.timeout(22000),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
        const data = await r.json();
        const txt = data?.choices?.[0]?.message?.content?.trim() || '';
        if (!txt) throw new Error('Empty response');
        if (data?.choices?.[0]?.finish_reason === 'length') console.warn('fundamental_analysis: Gemini output truncated (finish_reason=length) — pertimbangkan naikkan max_tokens lagi');
        analysis = _stripMarkdown(txt);
        await cb.onSuccess(CB_GEMINI_ADMIN);
        console.log(`fundamental_analysis: Gemini OK (attempt ${attempt})`);
      } catch(e) {
        console.warn(`fundamental_analysis Gemini failed (attempt ${attempt}):`, e.message);
      }
    }
    if (!analysis) await cb.onFailure(CB_GEMINI_ADMIN);
  }

  if (!analysis) return res.status(500).json({ error: 'Gemini AI provider failed for fundamental_analysis' });

  // Pergerakan ranking vs update sebelumnya (2026-08-11) — murni dihitung di kode dari
  // ranking yang barusan di-generate vs ranking tersimpan dari cache lama (`previousObj`,
  // lihat atas). Fail-open total: parse gagal / belum ada cache lama -> analysis tetap
  // dikirim apa adanya tanpa blok delta, bukan error.
  const rankingOrder = _parseFundRankingOrder(analysis);
  if (rankingOrder && previousObj && Array.isArray(previousObj.ranking) && previousObj.generated_at) {
    const hoursAgo = Math.max(1, Math.round((Date.now() - new Date(previousObj.generated_at).getTime()) / 3600000));
    const deltaBlock = _formatFundRankingDelta(previousObj.ranking, rankingOrder, `~${hoursAgo} jam lalu`);
    if (deltaBlock) analysis = `${analysis}\n\n${deltaBlock}`;
  }

  try {
    const result = { analysis, generated_at: new Date().toISOString(), from_cache: false, ranking: rankingOrder || undefined };
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
  if (!process.env.CRON_SECRET || !secret || !safeEqual(secret || '', process.env.CRON_SECRET || '')) return res.status(403).json({ error: 'Forbidden' });

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

const KNOWN_CIRCUITS = ['ai:deepseek', 'fred', 'stooq', 'ff', 'fj', 'cftc', 'redis', 'fxssi', 'actionforex',
  // PLAN V-3 (2026-07-20): breaker terpisah untuk call isAutoCall/test_deepseek=1 (developer-only)
  'ai:deepseek:experimental',
  // Translate NEWS (api/_news_translate.js) — TADINYA absen dari daftar ini, ketahuan
  // 2026-08-05 saat circuit-nya trip berulang (macet total) TAPI tak kelihatan sama
  // sekali di endpoint diagnostik ?action=circuit-status/circuit-reset ini.
  'ai:mistral:newstranslate',
  // 2026-08-25 (Session 328): 'ai:gemini' dipecah 3 karena dulu dipakai bersama lintas
  // fitur (lihat CB_GEMINI di market-digest.js) — burst kegagalan di satu fitur men-trip
  // circuit fitur lain yang tidak pernah gagal sendiri.
  'ai:gemini:digest', 'ai:gemini:journal', 'ai:gemini:fundamental'];

async function circuitStatusHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secret = req.headers['x-admin-secret'];
  if (!secret || !safeEqual(secret || '', process.env.CRON_SECRET || '')) return res.status(401).json({ error: 'Unauthorized' });

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

// Cek saldo DeepSeek (2026-07-30, diskusi user — "aku perlu tahu batas credit itu
// kapan"): satu-satunya deteksi saldo habis sebelum ini murni REAKTIF (HTTP 402 saat
// generate call sungguhan, baru ketahuan setelah kejadian, auto-fallback ke SambaNova
// tanpa notifikasi apa pun). Endpoint ini query langsung `GET /user/balance` resmi
// DeepSeek (read-only, TIDAK lewat allowAiCall/circuit breaker — bukan generate call,
// tidak masuk hitungan pagar biaya 50/hari) supaya bisa dicek kapan saja on-demand.
async function deepseekBalanceHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  if (!secret || !safeEqual(secret || '', process.env.CRON_SECRET || '')) return res.status(401).json({ error: 'Unauthorized' });

  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_KEY) return res.status(200).json({ error: 'DEEPSEEK_API_KEY belum diset' });

  try {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(200).json({ error: `HTTP ${r.status}` });
    const j = await r.json();
    return res.status(200).json({ is_available: j.is_available, balance_infos: j.balance_infos || [], checked_at: Date.now() });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
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
  // Plan U (2026-07-26, redesain independensi Golden Trio — lihat
  // daun_merah_riset.md): AUD/NZD & EUR/GBP masuk pair auto-entry baru,
  // butuh cache ohlcv:*:1h/4h/1d terjaga sama seperti 8 pair di atas.
  // EUR/GBP juga sudah di YAHOO_TO_DERIV_SYMBOL (vps/daemon.js) — dobel
  // sumber (Deriv stream + fallback cron ini) sama seperti EUR/USD/GBP/USD.
  // AUD/NZD TIDAK ada di Deriv map, tetap Yahoo-only (beda dari GC=F yang sudah
  // dimigrasi ke Deriv spot 2026-07-30 — lihat _ohlcv_fetch.js).
  { symbol: 'AUDNZD=X', label: 'AUD/NZD' },
  { symbol: 'EURGBP=X', label: 'EUR/GBP' },
  // Pair ke-5 auto-entry (2026-08-08, pair_workflow.md folder professional_llm_trader) —
  // Yahoo-only sama pola AUD/NZD, TIDAK ada di YAHOO_TO_DERIV_SYMBOL.
  { symbol: 'CHFJPY=X', label: 'CHF/JPY' },
];

const OHLCV_PAIR_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
  'NZD/USD': 'NZDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X', 'AUD/JPY': 'AUDJPY=X', 'EUR/AUD': 'EURAUD=X',
  'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X', 'XAU/USD': 'GC=F',
};

// PLAN U-2: 14 pair FX (XAU/USD dikecualikan — bukan currency) dipakai untuk
// currency strength lintas pair di api/_pair_context.js.
const FX_PAIRS_FOR_STRENGTH = Object.entries(OHLCV_PAIR_SYMBOL_MAP)
  .filter(([label]) => label !== 'XAU/USD')
  .map(([label, symbol]) => ({ label, symbol }));

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
  if (!isVercelCron && (!cronSecret || !safeEqual(cronSecret || '', process.env.CRON_SECRET || ''))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // V-2 (Plan V, 2026-07-20): ohlcv_sync dipicu 2x/jam tanpa saling tahu — GH
  // Actions ohlcv-sync.yml (menit :00) DAN Railway daemon Q-6 (menit :05) —
  // keduanya full fetch Deriv+Yahoo/TwelveData ~15 pair + TA-warm 8 pair, sia-sia
  // karena datanya identik. Window 45 menit: lebih pendek dari interval 60 menit
  // (sync jam berikutnya tetap jalan), lebih panjang dari offset 5 menit antara
  // kedua sumber cron (pemicu kedua pasti ke-dedup).
  const OHLCV_SYNC_DEDUP_WINDOW_MS = 45 * 60 * 1000;
  if (_isCronCallReq(req)) {
    try {
      const lastRunAt = await redisCmd('GET', 'ohlcv_sync:last_run_at');
      if (isCronDedupFresh(lastRunAt, Date.now(), OHLCV_SYNC_DEDUP_WINDOW_MS)) {
        console.log('ohlcv_sync: cron call kedua (last_run_at masih fresh) — skip sync ulang');
        return res.status(200).json({ ok: true, skipped: true, reason: 'cron_dedup', synced_at: lastRunAt });
      }
    } catch(e) { console.warn('ohlcv_sync: cron dedup check gagal (fail-open, tetap sync):', e.message); }
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
  // satu function") sebelum masuk fan-out Yahoo di bawah. GC=F (XAU/USD) ikut Deriv
  // sejak 2026-07-30 (lihat _ohlcv_fetch.js) — mapYahooSymbolToDeriv('GC=F') sekarang
  // truthy, jadi otomatis masuk loop ini seperti pair FX lain. Hasil disimpan per symbol,
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
      const isDerivPrimary = !!mapYahooSymbolToDeriv(symbol);

      let candles1h, source1h, skip1h = false;
      if (deriv?.candles1h) {
        candles1h = deriv.candles1h; source1h = 'deriv';
        // Volume XAU: Deriv tidak punya volume — tarik terpisah dari Yahoo GC=F dan
        // gabung by-timestamp (field v saja, harga Deriv tidak tersentuh). Lihat
        // catatan lengkap di refreshOhlcvFromYahoo. Sebelum resample ke 4H supaya
        // agregat volume 4H ikut benar.
        if (symbol === 'GC=F') {
          try { candles1h = mergeVolumeByTimestamp(candles1h, await fetchYahooOhlcv1h(symbol)); } catch (e) {}
        }
      } else if (isDerivPrimary) {
        // 2026-08-13 (diskusi user, daun_merah.md Session 313): pair yang MEMANG
        // primary-nya Deriv (14 pair FX + GC=F) TIDAK BOLEH jatuh ke Yahoo/Twelve
        // Data kalau Deriv gagal — candle campur vendor beda skala harga di array
        // yang sama dipakai evaluasi SL/TP auto-entry lebih berisiko daripada cache
        // sedikit basi (lihat insiden basis blowout GC=F & audit AUD/NZD S313).
        // Biarkan cache LAMA (Deriv) apa adanya sampai Deriv pulih — trackDerivHealth
        // di bawah alert Telegram kalau sistemik (bukan hiccup 1 pair).
        skip1h = true;
        source1h = 'skipped_deriv_down';
      } else {
        // AUD/NZD & CHF/JPY: TIDAK ada di Deriv map sama sekali, Yahoo memang
        // primary-nya sendiri (bukan fallback lintas-vendor dari Deriv) — perilaku
        // tidak berubah.
        source1h = 'yahoo';
        try {
          candles1h = await fetchYahooOhlcv1h(symbol);
          if (candles1h.length === 0) throw new Error(`${symbol}: empty candles`);
        } catch (yahooErr) {
          candles1h = await fetchFallbackCandles(symbol, '1h');
          source1h = 'twelvedata';
        }
      }

      const candles4h = skip1h ? null : resampleTo4h(candles1h);

      let candles1d, source1d, skip1d = false;
      if (deriv?.candles1d) {
        candles1d = deriv.candles1d; source1d = 'deriv';
        if (symbol === 'GC=F') {
          try { candles1d = mergeVolumeByTimestamp(candles1d, await fetchYahooOhlcvDaily(symbol)); } catch (e) {}
        }
      } else if (isDerivPrimary) {
        skip1d = true;
        source1d = 'skipped_deriv_down';
      } else {
        source1d = 'yahoo';
        try {
          candles1d = await fetchYahooOhlcvDaily(symbol);
          if (candles1d.length === 0) throw new Error(`${symbol}: empty daily candles`);
        } catch (yahooErr) {
          candles1d = await fetchFallbackCandles(symbol, '1d');
          source1d = 'twelvedata';
        }
      }

      // Store 3 TFs + source tag (diagnosa M1) in parallel — timeframe yang di-skip
      // (skip1h/skip1d) TIDAK ditulis sama sekali, cache lama (TTL 25h) tetap dipakai
      // apa adanya sampai Deriv pulih.
      const writes = [
        redisCmd('SET', `ohlcv:${symbol}:source`, JSON.stringify({ '1h': source1h, '1d': source1d }), 'EX', '90000'),
      ];
      if (!skip1h) {
        writes.push(redisCmd('SET', `ohlcv:${symbol}:1h`, JSON.stringify(candles1h.slice(-120)), 'EX', '90000'));
        writes.push(redisCmd('SET', `ohlcv:${symbol}:4h`, JSON.stringify(candles4h.slice(-60)),  'EX', '90000'));
      }
      if (!skip1d) {
        writes.push(redisCmd('SET', `ohlcv:${symbol}:1d`, JSON.stringify(candles1d.slice(-135)), 'EX', '90000'));
      }
      await Promise.all(writes);

      const n1h = skip1h ? 0 : Math.min(120, candles1h.length);
      const n4h = skip1h ? 0 : Math.min(60, candles4h.length);
      const n1d = skip1d ? 0 : Math.min(135, candles1d.length);
      console.log(`ohlcv_sync: ${label} — 1H:${n1h}(${source1h}) 4H:${n4h} 1D:${n1d}(${source1d})`);
      return { symbol, label, count1h: n1h, count4h: n4h, count1d: n1d, source1h, source1d, skipped: skip1h || skip1d };
    })
  );

  // BUG DITEMUKAN & DIFIX (2026-08-13, Session 313, ketahuan lewat test skenario
  // campuran skip+gagal): sebelumnya `.filter(rejected).map((r,i)=>pairsToSync[i])`
  // memakai index HASIL FILTER, bukan index ASLI di `results`/`pairsToSync` — begitu
  // filter membuang elemen, index-nya bergeser dan symbol yang dilaporkan gagal jadi
  // SALAH (menunjuk pair lain). Selama ini masih ketutupan karena skenario yang
  // pernah diuji cuma "semua gagal" atau "semua sukses" (filter tidak mengubah
  // panjang/urutan relatif index 0..n secara kebetulan) — begitu kebijakan skip
  // pair-Deriv (Session 313) menciptakan skenario CAMPURAN (sebagian fulfilled,
  // sebagian rejected) untuk pertama kali, baru ketahuan. Fix: zip index ASLI dulu
  // SEBELUM filter.
  const zipped = results.map((r, i) => ({ symbol: pairsToSync[i]?.symbol, r }));
  const synced = zipped.filter(z => z.r.status === 'fulfilled').map(z => z.r.value);
  const failed = zipped.filter(z => z.r.status === 'rejected')
    .map(z => ({ symbol: z.symbol, error: z.r.reason?.message }));

  // M1: run ini dianggap "Yahoo down sistemik" kalau TIDAK ADA satu pair pun yang
  // berhasil via Yahoo (semua fallback/gagal) — hindari alert dari hiccup 1 simbol.
  await trackYahooHealth(!synced.some(s => s.source1h === 'yahoo'));

  // 2026-08-13 (Session 313): sama semangat trackYahooHealth di atas — run ini
  // dianggap "Deriv down sistemik" kalau SEMUA pair primary Deriv (14 FX + GC=F)
  // di-skip (bukan cuma 1 pair hiccup). synced-nya sendiri dijamin ADA (skip tidak
  // pernah throw), jadi cek `every` di sini aman dari false-positive kosong.
  const derivPrimarySynced = synced.filter(s => mapYahooSymbolToDeriv(s.symbol));
  await trackDerivHealth(derivPrimarySynced.length > 0 && derivPrimarySynced.every(s => s.source1h === 'skipped_deriv_down'));

  // V-2: tandai "baru saja sync" HANYA kalau run ini benar-benar dapat sesuatu —
  // run yang gagal total tidak boleh menahan pemicu berikutnya (fail-open, biar
  // sync berikutnya tetap coba lagi, bukan didedup gara-gara run yang gagal).
  if (synced.length > 0) {
    try {
      await redisCmd('SET', 'ohlcv_sync:last_run_at', new Date().toISOString(), 'EX', '5400');
    } catch(e) { console.warn('ohlcv_sync: gagal set last_run_at (non-fatal):', e.message); }
  }

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

// ── Struktur teknikal untuk AI Analisa (semua pure function — dites di test/admin/ta_struct.test.js) ──

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

  // Plan P (2026-07-18): Deriv primary untuk pair FX — dicoba dulu SEBELUM Yahoo.
  // GC=F (XAU/USD) ikut Deriv sejak 2026-07-30 (lihat catatan REVISI di _ohlcv_fetch.js).
  // REVISI 2026-08-13 (Session 313): gagal Deriv untuk pair `derivEligible` TIDAK LAGI
  // fallback ke Yahoo/TwelveData (lihat catatan di bawah, dekat `need1h`/`need1d`) —
  // cache lama dibiarkan, bukan diganti vendor lain.
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

  // Volume XAU (diskusi user 2026-07-30, lanjutan migrasi Deriv di atas): Deriv
  // frxXAUUSD tidak punya volume sama sekali (v:0) — satu-satunya sumber volume
  // riil gold adalah Yahoo GC=F futures (dipakai `computeOhlcvMetrics`/market-digest.js
  // untuk anotasi "Volume avg/Today [HIGH/low]"). Harga tetap dari Deriv (spot, alasan
  // migrasi di atas) — HANYA field v yang ditarik dari Yahoo dan digabung by-timestamp
  // (`mergeVolumeByTimestamp`), o/h/l/c Deriv tidak pernah tersentuh. Ini BUKAN
  // pelanggaran aturan anti-campur-sumber Plan P-3 di bawah (itu soal harga candle,
  // bukan volume — volume orthogonal, tidak dipakai untuk level SL/TP/zona apa pun).
  // Best-effort: gagal = candle Deriv tetap v:0 (graceful, sama seperti FX yang memang
  // tidak pernah punya volume — konsumen sudah guard `v > 0`).
  if (symbol === 'GC=F') {
    if (candles1h) {
      try { candles1h = mergeVolumeByTimestamp(candles1h, await fetchYahooOhlcv1h(symbol)); } catch (e) {}
    }
    if (candles1d) {
      try { candles1d = mergeVolumeByTimestamp(candles1d, await fetchYahooOhlcvDaily(symbol)); } catch (e) {}
    }
  }

  // Aturan anti-campur-sumber (Plan P-3): hanya minta Yahoo untuk interval yang BELUM
  // didapat dari Deriv — satu array candle HARUS dari satu sumber, tidak pernah gabung.
  //
  // 2026-08-13 (diskusi user, daun_merah.md Session 313): kalau pair-nya MEMANG
  // primary-nya Deriv (`derivEligible`) tapi Deriv-nya gagal, JANGAN fallback ke
  // Yahoo/Twelve Data di sini juga — endpoint on-demand ini menulis key Redis
  // (`ohlcv:<symbol>:1h`) yang SAMA dipakai `_evaluateSetups` untuk SL/TP auto-entry,
  // jadi risikonya identik dengan ohlcvSyncHandler (campur skala harga vendor beda
  // di array yang sama). Cache lama (Deriv) dibiarkan apa adanya, bukan ditimpa.
  const need1h = !candles1h && !derivEligible, need1d = !candles1d && !derivEligible;
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
    writes.push(redisCmd('SET', `ohlcv:${symbol}:source`, JSON.stringify({
      '1h': source1h || (derivEligible ? 'skipped_deriv_down' : 'yahoo'),
      '1d': source1d || (derivEligible ? 'skipped_deriv_down' : 'yahoo'),
    }), 'EX', '90000'));
  }
  if (writes.length === 0) {
    // Arm a short throttle so a Yahoo outage doesn't make every read pay the full fetch timeout —
    // reads within 30s skip the retry and serve the last snapshot immediately.
    try { await redisCmd('SET', `ohlcv_fresh:${symbol}`, '0', 'EX', '30'); } catch (e) {}
    const reason = derivEligible
      ? 'Deriv gagal, tidak di-fallback ke vendor lain (kebijakan Session 313) — cache lama tetap dipakai'
      : `Yahoo fetch failed (1h: ${r1h.reason?.message || 'ok'}, 1d: ${r1d.reason?.message || 'ok'})`;
    throw new Error(`${symbol}: ${reason}`);
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
// diuji end-to-end tanpa infra (test/admin/ta_struct.test.js + scripts smoke test).
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

// Candle mentah (bukan metrik turunan seperti ohlcv_read/computeOhlcvMetrics) untuk
// chart Lightweight Charts di dev-auto-entry.html (revamp dashboard Professional LLM
// Trader, 2026-08-18) — baca langsung snapshot `ohlcv:<symbol>:<tf>` yang SUDAH ada di
// Redis (dipopulasi ohlcv_sync cron + refresh-on-read di bawah), tanpa fetch/hitung baru.
// Same throttled-refresh pattern dengan loadOhlcvData supaya candle tidak basi kalau
// tab chart baru dibuka lama setelah sync cron terakhir.
async function ohlcvChartHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const tf = ['1h', '4h', '1d'].includes(req.query.tf) ? req.query.tf : '1h';
  try {
    try { await refreshOhlcvFromYahoo(symbol); } catch (e) {
      console.warn(`ohlcv_chart: fresh fetch failed for ${symbol}, using snapshot:`, e.message);
    }
    const raw = await redisCmd('GET', `ohlcv:${symbol}:${tf}`);
    return res.status(200).json({ symbol, tf, candles: raw ? JSON.parse(raw) : [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Ambil max 6 level expiry milik pair ini, diurutkan dari yang paling dekat ke harga
// sekarang (magnet paling relevan duluan). Pure function — dites di test/lib/guards.test.js.
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
// Pure function — dites di test/admin/ta_struct.test.js.
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
// Pure function — dites di test/admin/ta_struct.test.js.
//
// PLAN U-1 (2026-07-20): saat status jadi 'sl', dua deteksi label penyebab loss
// otomatis (lihat _detectLossLabel) — mencegah AI "salah belajar" saat SL sebenarnya
// dipicu news shock/fakeout, bukan level teknikal buruk. Deteksi HANYA jalan pada
// transisi open->sl di tick evaluasi ini (bukan re-scan entri 'sl' lama dari sebelum
// fitur ini ada — entri lama tetap tereevaluasi normal, cuma tidak dapat label
// retroaktif). `calendarEvents` opsional (default []) = backward-compatible, caller
// lama yang panggil dengan 3 argumen tetap jalan tanpa fundamental_shock.
// `newsItems` opsional (audit 2026-08-03, S274) = breaking news (news_history)
// untuk deteksi fundamental_shock TIDAK terjadwal — lihat _detectLossLabel.
function _evaluateSetups(setups, candlesBySymbol, nowMs, calendarEvents, newsItems) {
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
    const rawCandles = candlesBySymbol?.[st.symbol] || [];
    const all = Array.isArray(rawCandles) ? [...rawCandles].sort((a, b) => a.t - b.t) : [];
    // Gap data: setup masih pending tapi candle tertua yang tersedia sudah > 24 jam
    // setelah setup dibuat — kejadian di gap tidak diketahui, jangan mengarang hasil.
    if (st.status === 'pending' && all.length && all[0].t * 1000 > st.ts + DAY) {
      st.status = 'stale';
      continue;
    }
    // BUG DITEMUKAN & DIFIX (2026-07-25, diskusi user — status 'tp' palsu di GC=F): kalau
    // status SUDAH 'open' dari pass evaluasi SEBELUMNYA (bukan transisi baru di pass ini),
    // scan SL/TP di bawah HARUS mulai dari `filled_t` (kapan posisi benar-benar live),
    // BUKAN dari `ts` (waktu sinyal/refine dibuat). Sebelum fix ini, re-evaluasi record
    // 'open' selalu scan ulang dari `ts` — kalau harga kebetulan menyentuh level TP/SL di
    // SATU candle mana pun antara `ts` dan `filled_t` (periode SEBELUM posisi live sama
    // sekali), evaluator salah menganggap itu TP/SL posisi ini. Ini akar masalah yang lebih
    // dalam dari sekadar bug reset `ts` saat refine (sudah difix terpisah) — bug ini bisa
    // muncul kapan pun `filled_t` > `ts` secara wajar (bukan cuma gara-gara refine).
    //
    // BUG DITEMUKAN & DIFIX (2026-08-28, kasus XAU/USD false-fill): untuk transisi
    // pending->open PERTAMA KALI (belum `wasAlreadyOpen`), scan dulu SELALU mulai dari
    // `st.ts` — waktu ide trade ini PERTAMA lahir, bukan waktu level entry YANG BERLAKU
    // SEKARANG dipasang. Kalau setup ini sempat di-refine (level entry berubah), harga
    // yang kebetulan menyentuh level baru itu SEBELUM refine terjadi (periode SEBELUM
    // level itu sendiri ada) salah dianggap fill — phantom fill varian baru, tidak
    // ditutup oleh guard v33 (guard v33 cuma memvalidasi sisi harga SAAT refine, bukan
    // titik mulai scan histori). `level_set_at` (fallback ke `ts` untuk record lama
    // sebelum field ini ada) menandai kapan level entry TERBARU mulai berlaku — dipakai
    // di sini SUPAYA scan fill pertama kali tidak menengok ke histori sebelum level itu
    // ada. `ts` sendiri tetap dipertahankan apa adanya (horizon_days masih dihitung dari
    // `ts` ASLI, lihat catatan di blok refine `_evaluateSetups`).
    const wasAlreadyOpen = st.status === 'open';
    const scanFromMs = (wasAlreadyOpen && st.filled_t) ? st.filled_t * 1000 : (st.level_set_at || st.ts);
    for (const c of all) {
      if (c.t * 1000 <= scanFromMs) continue;
      if (st.status === 'pending') {
        const filled = st.bias === 'bearish' ? c.h >= eLo : c.l <= eHi;
        if (filled) { st.status = 'open'; st.filled_t = c.t; }
      }
      if (st.status === 'open') {
        const hitSl = st.bias === 'bearish' ? c.h >= sl : c.l <= sl;
        const hitTp = st.bias === 'bearish' ? c.l <= tp : c.h >= tp;
        if (hitSl && hitTp) { st.status = 'ambiguous'; st.closed_t = c.t; break; }
        if (hitSl) {
          st.status = 'sl'; st.closed_t = c.t;
          const label = _detectLossLabel({ closedT: c.t, eLo, eHi, tp, bias: st.bias, pairLabel: st.label }, all, calendarEvents, newsItems);
          if (label) { st.loss_label = label.loss_label; st.label_reason = label.reason; st.label_by = 'auto'; st.label_criteria_v = label.criteria_v; }
          break;
        }
        if (hitTp) {
          st.status = 'tp'; st.closed_t = c.t;
          const tpLabel = _detectTpLabel({ closedT: c.t, eLo, eHi, sl, bias: st.bias }, all);
          if (tpLabel) { st.tp_label = tpLabel.tp_label; st.tp_label_reason = tpLabel.reason; }
          break;
        }
      }
    }
    const horizonMs = Math.max(2, st.horizon_days || 5) * 1.5 * DAY;
    if (st.status === 'pending' && nowMs - st.ts > horizonMs) st.status = 'expired';
  }
  return setups;
}

// Track 1 (Road to Professional LLM Trader, 2026-08-04): tegakkan invalidasi
// teknikal terstruktur (`invalidation_trigger`, diisi AI sendiri saat generate
// sinyal) sebagai exit dini DETERMINISTIK — nol biaya AI tambahan, reuse candle
// H1 yang SAMA dengan _evaluateSetups di atas (dipanggil SETELAH-nya, supaya
// `closed_t` yang baru saja di-set jadi boundary prioritas TP/SL — lihat komentar
// isInvalidationTriggered, api/_auto_entry_guard.js). Status/tp/sl MENTAH tetap
// dievaluasi _evaluateSetups apa adanya (prinsip U-5a, ghost/counterfactual tidak
// boleh ditimpa).
//
// BUG DITEMUKAN & DIFIX (2026-08-04, sesi sama — user tanya "gimana kalau dia
// ngasal batalkan trade"): versi pertama menulis hasil ke `intervention`/
// `managed_status` (field bersama U-5a) — field itu JUGA dipakai guard "1
// intervensi per posisi" di positionReviewHandler (~baris 3746, `if
// (st.intervention) skip 'already_managed'`) dan runFridayTightenCycle (~baris
// 3969, `candidates = ...filter(!s.intervention)`). Akibatnya kalau AI menulis
// `invalidation_trigger` yang ASAL (level ngawur, gampang kesenggol noise
// biasa) dan kode ini menyalakannya duluan, posisi itu jadi TIDAK PERNAH
// kebagian giliran direview AI position-review yang MERESPONS BERITA ASLI —
// mekanisme kode-murni yang belum terverifikasi kualitasnya jadi menghalangi
// mekanisme AI yang jauh lebih penting. Field SEKARANG dipisah total
// (`tech_invalidated`, BUKAN `intervention`) — murni observasional, TIDAK
// pernah menghalangi AI position review atau tighten preventif Jumat menyentuh
// posisi yang sama. Konsekuensinya: `tech_invalidated` bisa hidup BERDAMPINGAN
// dengan `intervention` AI di posisi yang sama (dua catatan independen, bukan
// satu slot rebutan) — ini yang diinginkan, bukan bug.
function _evaluateTechInvalidation(setups, candlesBySymbol) {
  const ACTIVE_OR_JUST_RESOLVED = new Set(['pending', 'open', 'tp', 'sl', 'ambiguous']);
  for (const st of setups || []) {
    if (!st || !st.invalidation_trigger || st.tech_invalidated) continue;
    if (!ACTIVE_OR_JUST_RESOLVED.has(st.status)) continue;
    const candles = candlesBySymbol?.[st.symbol] || [];
    const boundaryMs = st.closed_t ? st.closed_t * 1000 : Infinity;
    const result = isInvalidationTriggered({
      invalidation_trigger: st.invalidation_trigger, candles, startMs: st.ts, boundaryMs,
    });
    if (result?.triggered) {
      st.tech_invalidated = {
        at: result.at,
        level: st.invalidation_trigger.level,
        type: st.invalidation_trigger.type,
        direction: st.invalidation_trigger.direction,
      };
    }
  }
  return setups;
}

// PLAN U-3 lanjutan (2026-07-24, diskusi user soal "setup bagus keburu ditarik karena
// noise"): counterfactual untuk pending yang DIBATALKAN via Flip Guard non-whipsaw
// (canceled_reason:'bias_flip', lihat penulisan setup_log auto sekitar "Skenario
// Pembalikan Bias"). Begitu status jadi 'canceled', _evaluateSetups DI ATAS berhenti
// mengevaluasi setup itu selamanya (loop-nya cuma jalan utk status pending/open) — jadi
// pembatalan itu tidak pernah diukur tepat atau tidaknya. Fungsi ini SENGAJA terpisah
// (bukan menyambung status asli) supaya prinsip "data mentah/status TIDAK PERNAH ditimpa"
// (U-5a) tetap berlaku — hasilnya ditulis ke field ghost_* baru, status tetap 'canceled'
// apa adanya. Logikanya sengaja MIRIP _evaluateSetups (pending->open->sl/tp/expired),
// cuma start dari waktu pembatalan (canceled_t) memakai level entry_zone/sl/tp yang sudah
// dibekukan sejak sebelum di-cancel.
//
// (2026-08-08, diskusi user) Digeneralisasi: awalnya cuma 'bias_flip', sekarang juga
// menyertakan kandidat yang DITAHAN Gate D/B/A (correlation_cap/drawdown/critic_veto,
// lihat penulisan ghost entry di ohlcvAnalyzeHandler) — pertanyaannya sama persis
// ("apakah pembatalan/penahanan ini tepat atau kandidat yang dibuang sebenarnya
// benar?"), cuma sumber pembatalannya beda. Satu fungsi, satu logic, filter diperluas.
const GHOST_TRACKED_CANCEL_REASONS = new Set([
  'bias_flip', 'gate_correlation_cap', 'gate_drawdown_circuit_breaker', 'gate_critic_veto',
]);
function _evaluateCanceledGhost(setups, candlesBySymbol, nowMs) {
  const DAY = 86400000;
  const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
  for (const st of setups || []) {
    if (!st || st.status !== 'canceled' || !GHOST_TRACKED_CANCEL_REASONS.has(st.canceled_reason)) continue;
    if (st.ghost_status) continue; // sudah resolved, jangan re-evaluasi
    const startTs = st.canceled_t || st.ts;
    if (!Number.isFinite(startTs)) continue;
    const e = nums(st.entry_zone), sl = nums(st.sl)[0], tp = nums(st.tp)[0];
    if (!e.length || sl == null || tp == null || (st.bias !== 'bullish' && st.bias !== 'bearish')) {
      st.ghost_status = 'invalid';
      continue;
    }
    const eLo = Math.min(...e), eHi = Math.max(...e);
    const rawCandles = candlesBySymbol?.[st.symbol] || [];
    const all = Array.isArray(rawCandles) ? [...rawCandles].sort((a, b) => a.t - b.t) : [];
    let ghostPhase = 'pending';
    for (const c of all) {
      if (c.t * 1000 <= startTs) continue;
      if (ghostPhase === 'pending') {
        const filled = st.bias === 'bearish' ? c.h >= eLo : c.l <= eHi;
        if (filled) { ghostPhase = 'open'; st.ghost_filled_t = c.t; }
      }
      if (ghostPhase === 'open') {
        const hitSl = st.bias === 'bearish' ? c.h >= sl : c.l <= sl;
        const hitTp = st.bias === 'bearish' ? c.l <= tp : c.h >= tp;
        if (hitSl && hitTp) { st.ghost_status = 'ambiguous'; st.ghost_closed_t = c.t; break; }
        if (hitSl) { st.ghost_status = 'sl'; st.ghost_closed_t = c.t; break; }
        if (hitTp) { st.ghost_status = 'tp'; st.ghost_closed_t = c.t; break; }
      }
    }
    const horizonMs = Math.max(2, st.horizon_days || 5) * 1.5 * DAY;
    if (!st.ghost_status && nowMs - startTs > horizonMs) st.ghost_status = 'expired';
  }
  return setups;
}

// Agregat ghost cancel-flip untuk _aggSetupStats di bawah — pola sama _aggManagementStats
// (api/_position_review.js): saved = flip TEPAT (harga aslinya lanjut ke SL), cost = flip
// SALAH (harga aslinya lanjut ke TP, berarti setup yang dibatalkan sebenarnya benar —
// PERSIS ketakutan "setup bagus ditarik karena noise"), pending = belum resolve (belum
// kena entry_zone sama sekali/masih ditunggu).
function _aggCancelFlipGhostStats(arr) {
  const list = (Array.isArray(arr) ? arr : []).filter(x => x && x.canceled_reason === 'bias_flip');
  return {
    total: list.length,
    saved: list.filter(x => x.ghost_status === 'sl').length,
    cost: list.filter(x => x.ghost_status === 'tp').length,
    ambiguous: list.filter(x => x.ghost_status === 'ambiguous').length,
    expired_no_fill: list.filter(x => x.ghost_status === 'expired').length,
    pending: list.filter(x => !x.ghost_status).length,
  };
}

// Agregat ghost KHUSUS kandidat yang ditahan Gate D/B/A (2026-08-08, diskusi user —
// gap yang sebelumnya "sengaja belum dibuat" karena dianggap kerja lebih besar dari
// pencatatan ringan `auto_guard_stats:*`, lihat komentar di ohlcvAnalyzeHandler dekat
// `autoGuardConsidered`). Dipecah PER GATE (bukan digabung 1 angka) — correlation_cap/
// drawdown/critic_veto jawab pertanyaan berbeda (masing-masing "apakah gate ini
// beneran nyaring yang jelek, atau kebetulan buang kandidat yang sebenarnya menang").
// saved = gate BENAR menahan (ghost_status sl — kandidat itu memang bakal kalah kalau
// diambil), cost = gate SALAH menahan (ghost_status tp — kandidat itu sebenarnya menang).
function _aggGateRejectGhostStats(arr) {
  const list = (Array.isArray(arr) ? arr : [])
    .filter(x => x && typeof x.canceled_reason === 'string' && x.canceled_reason.startsWith('gate_'));
  const byGate = {};
  for (const x of list) {
    const g = byGate[x.canceled_reason] || (byGate[x.canceled_reason] = {
      total: 0, saved: 0, cost: 0, ambiguous: 0, expired_no_fill: 0, pending: 0,
    });
    g.total++;
    if (x.ghost_status === 'sl') g.saved++;
    else if (x.ghost_status === 'tp') g.cost++;
    else if (x.ghost_status === 'ambiguous') g.ambiguous++;
    else if (x.ghost_status === 'expired') g.expired_no_fill++;
    else g.pending++;
  }
  return byGate;
}

// Keyword currency-leg untuk breaking news (audit 2026-08-03: _detectLossLabel
// sebelumnya CUMA cek kalender terjadwal, buta breaking news mendadak — SL
// gara-gara headline geopolitical/energy jatuh ke bucket 'teknikal' yang salah).
// DUPLIKASI SADAR dari POSREVIEW_CURRENCY_KEYWORDS/detectCurrencyLegs
// (vps/daemon.js — Docker terisolasi dari build context Vercel ini), pola sama
// newscat.js/isCorroborated yang sudah diduplikasi lintas file di proyek ini.
// XAU ikut disertakan (bukan cuma 8 major FX) — pola sama _detectLossLabel
// sendiri yang sudah memetakan XAU->leg USD untuk kalender.
const LOSS_LABEL_CURRENCY_KEYWORDS = {
  USD: ['fed', 'fomc', 'dollar', 'usd', 'powell', 'nonfarm', 'nfp', 'treasury'],
  EUR: ['ecb', 'euro', 'eur', 'lagarde', 'eurozone'],
  GBP: ['boe', 'pound', 'gbp', 'sterling', 'bailey'],
  JPY: ['boj', 'yen', 'jpy', 'ueda'],
  AUD: ['rba', 'aussie', 'aud', 'australia'],
  CAD: ['boc', 'loonie', 'cad', 'canada'],
  CHF: ['snb', 'franc', 'chf', 'swiss'],
  NZD: ['rbnz', 'kiwi', 'nzd', 'zealand'],
  XAU: ['gold', 'xau', 'bullion', 'hormuz', 'opec', 'gulf oil', 'oil supply'],
};

// Audit S277 (2026-08-04): dulu `t.includes(kw)` polos (substring) — "Saudi
// official..." salah match leg AUD gara-gara "Saudi" mengandung "aud" (pola sama
// yang sudah difix di detectCurrencyLegs, vps/daemon.js — duplikasi sadar, jaga
// tetap sinkron). Word-boundary regex, precompiled sekali di module scope.
const LOSS_LABEL_CURRENCY_KEYWORD_RE = Object.fromEntries(
  Object.entries(LOSS_LABEL_CURRENCY_KEYWORDS).map(([ccy, kws]) => [
    ccy,
    kws.map(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')),
  ])
);

function _newsMatchesLegs(title, legs) {
  const t = String(title || '');
  return (legs || []).some(leg => (LOSS_LABEL_CURRENCY_KEYWORD_RE[leg] || []).some(re => re.test(t)));
}

// news_history (api/feeds.js) cuma retensi 36 jam (ZREMRANGEBYSCORE arsip) —
// cukup karena _detectLossLabel breaking-news HANYA jalan pada transisi
// open->sl SAAT tick evaluasi ini (bukan re-scan retroaktif, lihat komentar di
// atas _evaluateSetups), jadi closedT selalu baru. Best-effort/fail-open ke
// array kosong — Redis gagal TIDAK BOLEH menggagalkan evaluasi tp/sl utama.
async function _fetchRecentNewsItems() {
  try {
    const cutoff = Date.now() - 36 * 3600000;
    const raw = await redisCmd('ZRANGEBYSCORE', 'news_history', String(cutoff), '+inf');
    if (!Array.isArray(raw)) return [];
    return raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Deteksi penyebab loss otomatis (PLAN U-1, diperluas 2026-08-03 audit S274).
// Prioritas: fundamental_shock (kalender TERJADWAL) > fundamental_shock (breaking
// news TIDAK terjadwal) > fakeout_sl — satu label saja, tidak menumpuk. Pure
// function, dites unit.
// - fundamental_shock (kalender): ada event kalender impact 'High' untuk currency
//   salah satu kaki pair (dari `pairLabel`, mis. "XAU/USD" -> legs ['XAU','USD'])
//   dalam ±2 jam dari closedT. XAU otomatis lolos ke leg USD saja (calendar tidak
//   pernah punya currency "XAU"), pola sama seperti _buildAnalyzeCalBlock.
// - fundamental_shock (breaking news): pola SAMA dengan isCorroborated yang dipakai
//   review posisi terbuka (api/_position_review.js) — market-moving lolos otomatis,
//   geopolitical/energy butuh >=2 sumber (guid beda, overlap >=2 token, dalam 30
//   menit). Filter currency legs via LOSS_LABEL_CURRENCY_KEYWORDS di atas supaya
//   tidak salah atribusi ke berita global yang tidak relevan pair ini. Window ±2
//   jam dari closedT, sama seperti cek kalender.
// - fakeout_sl (kriteria KETAT, jangan jadi mesin pemaaf): dalam <=4 jam setelah
//   closedT, harga KEMBALI menembus zona entry DAN menyentuh TP asli — butuh KEDUA
//   syarat, bukan salah satu.
//
// v2 (2026-08-13, diskusi user — daun_merah.md Session 313): jendela fundamental_shock
// SEBELUMNYA simetris ±2 jam (Math.abs), jadi SL yang sebenarnya murni teknikal tapi
// KEBETULAN ada event high-impact dalam 2 jam SEBELUM closedT ikut dilabel "bukan
// salah AI" — bukti nyata ditemukan: EURUSD=X:1786004144720 & GC=F:1786004121103
// closed_t 2026-08-07T12:00Z, dilabel "Non Farm Payrolls" padahal NFP baru rilis
// 12:30 UTC (30 menit SETELAH SL kena). Diperbaiki jadi SATU ARAH: event/berita
// HARUS terjadi PADA/SEBELUM closedT (SL adalah REAKSI atas shock, bukan kebetulan
// mendahuluinya), maksimal 2 jam sebelumnya. `criteria_v` distempel di return value
// SETIAP kali label diberikan (termasuk fakeout_sl, supaya field ini konsisten
// menandai "ruleset versi berapa yang menghasilkan label ini") — label lama di
// data historis TIDAK punya field ini sama sekali (null/absent = v1, jangan
// diasumsikan kriteria v2 tanpa cek field ini eksplisit). Pola sama seperti
// `cme_priority_prompt_v` (S292).
const LOSS_LABEL_CRITERIA_V = 2;

function _detectLossLabel({ closedT, eLo, eHi, tp, bias, pairLabel }, allCandles, calendarEvents, newsItems) {
  const legs = String(pairLabel || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  const closedMs = closedT * 1000;
  if (legs.length && Array.isArray(calendarEvents)) {
    const TWO_H = 2 * 3600000;
    const shock = calendarEvents.find(ev => {
      if (!ev || ev.impact !== 'High') return false;
      if (!legs.includes(String(ev.currency || '').toUpperCase())) return false;
      const evMs = _calEventMsWib(ev.date, ev.time_wib);
      return evMs != null && closedMs >= evMs && (closedMs - evMs) <= TWO_H;
    });
    if (shock) return { loss_label: 'fundamental_shock', reason: shock.event || 'event high-impact', criteria_v: LOSS_LABEL_CRITERIA_V };
  }

  if (legs.length && Array.isArray(newsItems)) {
    const TWO_H = 2 * 3600000;
    const relevant = newsItems.filter(n => n && _newsMatchesLegs(n.title, legs));
    const nearby = relevant.filter(n => {
      const t = Date.parse(n.pubDate);
      return Number.isFinite(t) && closedMs >= t && (closedMs - t) <= TWO_H;
    });
    const shock = nearby.find(n => isCorroborated(n, relevant));
    if (shock) return { loss_label: 'fundamental_shock', reason: shock.title || 'breaking news', criteria_v: LOSS_LABEL_CRITERIA_V };
  }

  const FOUR_H = 4 * 3600000;
  let reenteredEntry = false, touchedTp = false;
  for (const c of allCandles || []) {
    const cMs = c.t * 1000;
    if (cMs <= closedMs) continue;
    if (cMs - closedMs > FOUR_H) break;
    // Reentry ke zona entry: SL yang membalik bisa datang dari arah manapun (beda
    // dari fill awal yang selalu dari luar zona ke arah favorit) — overlap range
    // candle [l,h] vs zona [eLo,eHi] agnostik arah, bukan cek satu sisi seperti fill.
    if (c.h >= eLo && c.l <= eHi) reenteredEntry = true;
    if (bias === 'bearish' ? c.l <= tp : c.h >= tp) touchedTp = true;
  }
  if (reenteredEntry && touchedTp) {
    return { loss_label: 'fakeout_sl', reason: 'harga kembali ke zona entry dan mencapai TP asli dalam 4 jam setelah SL', criteria_v: LOSS_LABEL_CRITERIA_V };
  }
  return null;
}

// Deteksi nuansa TP (2026-08-04, "jurnal end-to-end" — mirror fakeout_sl di atas, TP
// sebelum ini tidak punya klasifikasi sama sekali beda dari SL yang sudah 3 kategori).
// Kriteria KETAT sama seperti fakeout_sl (butuh KEDUA syarat, bukan salah satu): dalam
// <=4 jam setelah TP kena, harga kembali ke zona entry DAN sempat menyentuh SL asli —
// artinya TP itu kemungkinan cuma "grazed" (nyentuh sekali lalu balik ke arah SL),
// bukan gerakan bersih sesuai thesis. SENGAJA TIDAK meniru fundamental_shock: label itu
// dibuat untuk MENGECUALIKAN SL dari win_rate_adjusted (SL akibat news bukan salah
// teknikal) — TP tidak punya keperluan analog (menang tetap menang, terlepas sebabnya).
// Default null (bukan 'clean') kalau tidak terdeteksi — konsisten dengan _detectLossLabel:
// null = kategori teknikal/default implisit, bukan "belum pernah dicek".
function _detectTpLabel({ closedT, eLo, eHi, sl, bias }, allCandles) {
  const FOUR_H = 4 * 3600000;
  const closedMs = closedT * 1000;
  let reenteredEntry = false, touchedSl = false;
  for (const c of allCandles || []) {
    const cMs = c.t * 1000;
    if (cMs <= closedMs) continue;
    if (cMs - closedMs > FOUR_H) break;
    if (c.h >= eLo && c.l <= eHi) reenteredEntry = true;
    if (bias === 'bearish' ? c.h >= sl : c.l <= sl) touchedSl = true;
  }
  if (reenteredEntry && touchedSl) {
    return { tp_label: 'grazed_tp', reason: 'harga kembali ke zona entry dan mencapai SL asli dalam 4 jam setelah TP' };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// Korroborasi sumber kedua untuk simbol proxy futures (PLAN U, 2026-07-29,
// insiden GC=F:1785244513683 — lihat daun_merah.md Session 260-261): GC=F
// (COMEX gold futures) dipakai sebagai harga acuan "XAU/USD" karena punya
// volume asli (dipakai analisis, lihat catatan _ohlcv_fetch.js), tapi rawan
// basis blowout vs spot beberapa hari menjelang kontrak aktif expiry (likuiditas
// menipis, thin trading — fenomena pasar riil, BUKAN cuma bad print/glitch).
// Kejadian nyata: candle GC=F 2026-07-29T07:00Z H 4106.70 dengan volume riil
// 12607 (dikonfirmasi Yahoo regularMarketDayHigh resmi + candle 1m volume
// berkelanjutan) padahal Twelve Data XAU/USD spot cuma H 4047.76 jam yang sama
// — kalau dipercaya mentah-mentah, SL/TP GC=F bisa "benar" secara harga futures
// tapi TIDAK merepresentasikan apa yang benar-benar bisa ditradingkan user di
// broker spot (persis yang bikin user curiga lewat chart MT5-nya).
//
// Guard ini TIDAK mencoba membedakan "bad print" vs "basis blowout riil" (dua-
// duanya sama-sama harus tidak dipercaya mentah untuk finalisasi tp/sl) — cukup
// cross-check candle jam yang sama dari Twelve Data XAU/USD (sumber independen,
// SUDAH ada di codebase sbg fallback Yahoo, tidak ada integrasi vendor baru).
// Toleransi 15 USD basis normal futures-vs-spot (lihat catatan "beda beberapa
// dolar" _ohlcv_fetch.js) — cukup longgar untuk spread wajar, cukup ketat
// menangkap divergensi >$50 seperti insiden ini.
//
// UPDATE 2026-07-30: insiden basis blowout TERULANG (divergensi ~$60, lihat
// [[project-gcf-futures-spot-basis-blowout]]) — DAN ketahuan guard ini cuma jalan
// di scope=auto (setup_log_auto:v1, lihat _buildAutoScopeStats/positionReviewHandler),
// TIDAK PERNAH menyentuh setup_log:v1 (manual, yang user pantau di UI — lihat
// setupStatsHandler yang tidak memanggil _finalizeSetupTransitions sama sekali).
// Root cause sebenarnya diperbaiki di sumbernya: GC=F sekarang fetch dari Deriv
// frxXAUUSD (spot) sebagai primary, bukan lagi futures (lihat _ohlcv_fetch.js) —
// otomatis berlaku untuk SEMUA konsumen (manual + auto), tidak perlu menambal guard
// ini ke jalur ketiga. Guard di bawah TETAP dipertahankan untuk scope=auto sebagai
// lapis kedua (cross-check Deriv vs Twelve Data, dua-duanya spot) — sekarang
// menangkap anomali/glitch feed, bukan lagi mismatch futures-vs-spot yang sudah
// hilang di sumbernya.
const GOLD_BASIS_TOLERANCE_USD = 15;
const CORROBORATION_SYMBOLS = new Set(['GC=F']);

// Pure function, dites unit terpisah dari network. direction: 'above' kalau
// breach dari bawah ke atas (level perlu dikonfirmasi candle spot h >= level -
// toleransi), 'below' sebaliknya. Return null (BUKAN false) kalau tidak bisa
// diverifikasi (candle spot jam itu tidak ketemu) — caller WAJIB fail-open pada
// null, beda dari false (gagal konfirmasi tegas).
function _corroborateLevel(level, direction, spotCandles, breachTMs) {
  if (!Array.isArray(spotCandles) || !spotCandles.length) return null;
  const HOUR_MS = 3600000;
  const match = spotCandles.find(c => Math.abs(c.t * 1000 - breachTMs) < HOUR_MS);
  if (!match) return null;
  return direction === 'above'
    ? match.h >= (level - GOLD_BASIS_TOLERANCE_USD)
    : match.l <= (level + GOLD_BASIS_TOLERANCE_USD);
}

function _breachDirection(bias, status) {
  if (status === 'sl') return bias === 'bearish' ? 'above' : 'below';
  if (status === 'tp') return bias === 'bearish' ? 'below' : 'above';
  return null; // 'ambiguous' sengaja tidak ditangani — kasus langka, di luar scope guard ini
}

// Dipanggil SETELAH _evaluateSetups mendeteksi transisi baru ke tp/sl untuk
// simbol di CORROBORATION_SYMBOLS. Kalau spot TIDAK mengkonfirmasi breach,
// revert status -> 'open' + catat `divergence_hold` (audit trail, pola sama
// seperti `data_fix_*` — data mentah lain TIDAK disentuh) supaya evaluasi tick
// berikutnya tetap jalan normal (kalau breach berlanjut & kali ini terkonfirmasi,
// akan closed dengan benar; kalau divergensi mereda, tidak pernah ke-tp/sl-kan).
//
// Fetch Twelve Data dilakukan DI LUAR lock utama pemanggil (bisa sampai ~10
// detik, hampir sama dengan TTL lock `lock:setuplog_write:*` — kalau ikut
// ditahan di dalam lock yang sama berisiko race lock kadaluarsa saat masih
// dipegang). Revert (kalau ada) pakai siklus lock SENDIRI yang pendek, re-read
// Redis fresh dan cek status/closed_t belum berubah lagi sebelum menimpa —
// fail-open (skip, dicoba tick berikutnya) kalau lock gagal diambil atau entri
// sudah keburu berubah oleh proses lain sejak snapshot awal.
async function _corroborateGoldTransitions(log, transitioned) {
  const candidates = transitioned.filter(s => s && CORROBORATION_SYMBOLS.has(s.symbol) && s.status !== 'ambiguous');
  if (!candidates.length) return [];
  const toRevert = [];
  for (const st of candidates) {
    const direction = _breachDirection(st.bias, st.status);
    const level = parseFloat(st.status === 'tp' ? st.tp : st.sl);
    if (direction == null || isNaN(level) || !st.closed_t) continue;
    let spotCandles;
    try { spotCandles = await fetchFallbackCandles(st.symbol, '1h'); }
    catch (e) { continue; } // fail-open: Twelve Data gagal/limit habis -> percaya _evaluateSetups apa adanya
    const ok = _corroborateLevel(level, direction, spotCandles, st.closed_t * 1000);
    if (ok === false) toRevert.push({ id: st.id, status: st.status, closed_t: st.closed_t, level, direction });
  }
  if (!toRevert.length) return [];

  const lockKey = 'lock:setuplog_write:setup_log_auto:v1';
  const got = await _acquireLockWithRetry(lockKey);
  if (!got) return []; // fail-open: dicoba lagi tick berikutnya
  const flagged = [];
  try {
    const raw = await redisCmd('GET', 'setup_log_auto:v1');
    let fresh = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(fresh)) fresh = [];
    for (const r of toRevert) {
      const idx = fresh.findIndex(x => x && x.id === r.id);
      if (idx === -1) continue;
      const cur = fresh[idx];
      // Entri sudah berubah lagi sejak snapshot (proses lain sempat proses) -> skip,
      // jangan timpa perubahan yang lebih baru.
      if (cur.status !== r.status || cur.closed_t !== r.closed_t) continue;
      cur.status = 'open';
      delete cur.closed_t;
      cur.loss_label = null; cur.label_reason = null; cur.label_by = null;
      cur.divergence_hold = {
        would_be_status: r.status, level: r.level, direction: r.direction,
        reason: 'gc_f_vs_spot_divergence', flagged_at: Date.now(),
      };
      // Sinkronkan objek in-memory `log` (referensi sama dengan `st`/`transitioned`)
      // supaya payload response tick ini konsisten, bukan cuma Redis. Object.assign
      // TIDAK menghapus properti yang sudah tidak ada di `cur` (closed_t dihapus di
      // atas) — delete eksplisit dulu sebelum assign supaya in-memory match persis.
      const inMemory = log.find(x => x && x.id === r.id);
      if (inMemory) { delete inMemory.closed_t; Object.assign(inMemory, cur); }
      flagged.push(cur);
    }
    if (flagged.length) await redisCmd('SET', 'setup_log_auto:v1', JSON.stringify(fresh));
  } finally { redisCmd('DEL', lockKey).catch(() => {}); }
  return flagged;
}

// Wrapper bersama dipakai _buildAutoScopeStats & positionReviewHandler supaya
// kedua jalur yang bisa memfinalisasi transisi tp/sl konsisten — sama-sama lewat
// korroborasi sebelum notifikasi, tidak ada jalur yang lolos tanpa guard ini.
async function _finalizeSetupTransitions(log, statusBeforeById) {
  const transitioned = log.filter(s => s && statusBeforeById.has(s.id) &&
    statusBeforeById.get(s.id) !== s.status && (s.status === 'tp' || s.status === 'sl' || s.status === 'ambiguous'));
  if (!transitioned.length) return;
  const divergenceFlagged = await _corroborateGoldTransitions(log, transitioned);
  const divergenceIds = new Set(divergenceFlagged.map(s => s.id));
  const confirmed = transitioned.filter(s => !divergenceIds.has(s.id));
  await Promise.allSettled([
    ...confirmed.map(s => _notifySetupOutcome(s)),
    ...divergenceFlagged.map(s => _notifyDivergenceHold(s)),
  ]);
}

// Riset tambahan (2026-07-20, diskusi user pasca-Plan U): estimasi spread retail
// standar per pair, dalam satuan HARGA (bukan pip) — dipakai HANYA untuk expectancy
// biaya transaksi di _costAdjustedR di bawah. Angka ESTIMASI ballpark broker retail
// menengah (BUKAN kutipan broker riil tertentu, BUKAN diverifikasi live) — cukup
// untuk arah besar "apakah edge borderline termakan biaya", bukan presisi akuntansi.
// Fallback null (tidak ada di tabel) -> expectancy cost-adjusted diskip utuh untuk
// setup itu (fail-open, sama pola dengan field lain di file ini).
const SPREAD_PRICE_ESTIMATE = {
  'XAU/USD': 0.30,
  'EUR/USD': 0.00012, 'GBP/USD': 0.00016, 'AUD/USD': 0.00018, 'NZD/USD': 0.00025,
  'USD/CAD': 0.00020, 'USD/CHF': 0.00020, 'USD/JPY': 0.017,
  'EUR/JPY': 0.025, 'GBP/JPY': 0.035, 'AUD/JPY': 0.025,
  'EUR/GBP': 0.00020, 'EUR/AUD': 0.00035, 'GBP/AUD': 0.00045, 'GBP/CAD': 0.00040,
  // AUD/NZD ditambahkan 2026-07-28 (riset akurasi auto-entry, daun_merah_riset.md):
  // pair ini masuk AUTO_ENTRY_PAIRS sejak redesain 4-pair Session 247 tapi tidak pernah
  // ada di tabel ini, jadi SEMUA setup AUD/NZD diam-diam di-skip dari cost_expectancy
  // (fallback null di _costAdjustedR) — angka expectancy net cuma mewakili 3 dari 4 pair
  // tanpa tanda apa pun di payload. Ballpark konsisten tabel (NZD/USD 0.00025, EUR/AUD
  // 0.00035); cross AUD-NZD likuiditasnya di antara keduanya.
  'AUD/NZD': 0.00030,
  // CHF/JPY ditambahkan 2026-08-08 (pair_workflow.md folder professional_llm_trader,
  // Tahap 2d) — WAJIB diisi sebelum pair ini live, pelajaran dari insiden AUD/NZD di
  // atas (lupa isi = diam-diam ke-skip dari cost_expectancy tanpa tanda apa pun).
  // Skala satuan sama seperti pair JPY-quoted lain (EUR/JPY 0.025, GBP/JPY 0.035,
  // AUD/JPY 0.025) — CHF/JPY likuiditasnya di antara EUR/JPY & GBP/JPY.
  'CHF/JPY': 0.030,
};

// R-multiple realized SEBELUM vs SESUDAH biaya spread, per setup closed (tp/sl).
// Risk (1R) = |entry_mid - sl|; gross R menang = st.rr (risk_reward tersimpan saat
// setup dibuat) atau dihitung ulang dari tp kalau rr kosong; gross R kalah = -1 by
// definisi. Cost dalam satuan R = spread_price / risk (dibayar sekali round-trip,
// masuk DAN keluar posisi) — dikurangkan dari gross R either arah (menang jadi
// lebih kecil, kalah jadi lebih besar), sama seperti biaya riil bekerja. Pure
// function, tidak menyentuh data mentah setup — murni untuk agregat expectancy.
function _costAdjustedR(st) {
  if (st.status !== 'tp' && st.status !== 'sl') return null;
  const spread = SPREAD_PRICE_ESTIMATE[st.label];
  if (spread == null) return null;
  const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
  const e = nums(st.entry_zone), slNum = nums(st.sl)[0], tpNum = nums(st.tp)[0];
  if (!e.length || slNum == null) return null;
  const entryMid = (Math.min(...e) + Math.max(...e)) / 2;
  const risk = Math.abs(entryMid - slNum);
  if (!risk) return null;
  let grossR;
  if (st.status === 'sl') {
    grossR = -1;
  } else {
    // BUG DITEMUKAN & DIFIX (2026-07-29, audit lanjutan celah kesalahan trader):
    // prioritas dibalik — geometri RIIL (tp/entry_zone/sl yang benar-benar tersimpan)
    // sekarang menang atas `rr` (target saat setup dibuat/direfine). `rr` cuma cache;
    // kalau level di-refine tapi `structured.risk_reward` kebetulan null di generate
    // itu, `rr` lama bisa meleset dari level FINAL yang sebenarnya dipakai. Fallback ke
    // `rr` tersimpan HANYA kalau tp memang tidak ada (data lama/tak lengkap).
    grossR = tpNum != null ? Math.round((Math.abs(tpNum - entryMid) / risk) * 100) / 100
      : (typeof st.rr === 'number' ? st.rr : null);
    if (grossR == null) return null;
  }
  const costR = spread / risk;
  return { grossR, netR: grossR - costR };
}

// Rata-rata expectancy R gross vs net-biaya lintas setup closed yang punya data
// spread & level lengkap. n bisa < (tp+sl) kalau sebagian pair/level tidak
// terhitung (fail-open per-entri, bukan all-or-nothing).
// BUG DITEMUKAN & DIFIX (2026-07-29, audit lanjutan): pair yang tidak ada di
// SPREAD_PRICE_ESTIMATE dulu diam-diam dikecualikan dari n tanpa tanda apa pun sama
// sekali (persis insiden AUD/NZD 2026-07-28, baru ketahuan manual). `missing_spread_table`
// sekarang merekam label pair closed (tp/sl) mana saja yang hilang dari tabel spread —
// supaya gap serupa di pair baru langsung kelihatan di payload, bukan nunggu ketahuan lagi.
function _aggCostExpectancy(arr) {
  const rs = arr.map(_costAdjustedR).filter(Boolean);
  const missingSpreadTable = [...new Set(
    (arr || [])
      .filter(x => x && (x.status === 'tp' || x.status === 'sl') && SPREAD_PRICE_ESTIMATE[x.label] == null)
      .map(x => x.label)
  )];
  if (!rs.length) return { n: 0, avg_r_gross: null, avg_r_net: null, missing_spread_table: missingSpreadTable };
  const avg = key => +(rs.reduce((a, r) => a + r[key], 0) / rs.length).toFixed(2);
  return { n: rs.length, avg_r_gross: avg('grossR'), avg_r_net: avg('netR'), missing_spread_table: missingSpreadTable };
}

// PLAN (2026-07-20, item #5 diskusi user): kalibrasi confidence AI — win-rate
// dipecah per level confidence yang AI nyatakan sendiri saat setup dibuat (field
// `confidence` di setup_log, lihat instruksi JSON ohlcv_analyze). Tujuan: AI yang
// terkalibrasi baik seharusnya win-rate "tinggi" > "sedang" > "rendah"; kalau flat
// atau terbalik, confidence-nya tidak informatif (jangan dipakai untuk sizing).
// Hanya closed (tp/sl) yang dihitung, sama seperti win_rate_raw.
function _confidenceCalibration(arr) {
  const out = {};
  for (const level of ['tinggi', 'sedang', 'rendah']) {
    const sub = arr.filter(x => x.confidence === level && (x.status === 'tp' || x.status === 'sl'));
    const tp = sub.filter(x => x.status === 'tp').length;
    out[level] = { n: sub.length, win_rate: sub.length ? Math.round(tp / sub.length * 100) : null };
  }
  return out;
}

// [SISTEM HAKIM] kalibrasi (2026-07-29, diskusi user — "cari cara mengukurnya tanpa
// merusak statistika kita"): pola PERSIS _confidenceCalibration di atas, field BARU
// murni aditif (`sistem_hakim`, ditulis saat setup dibuat/di-refine — lihat penulisan
// setup_log_auto), TIDAK menyentuh field/kalibrasi yang sudah ada. Tujuannya membedakan
// win-rate setup yang "fired" (Sistem Hakim memaksa conflict='arah', biasanya lalu
// ditahan Flip Guard sebagai whipsaw) vs "clear" (cbDir tersedia & dicek, tidak ada
// konflik) — kalau "fired" TIDAK kalah dari "clear" dalam sampel yang cukup, itu sinyal
// Sistem Hakim mungkin cuma menahan sinyal yang sebenarnya sah (noise, bukan filter
// berguna). n kecil di awal (fitur baru) — jangan disimpulkan apa pun sebelum n memadai.
// Bucket ketiga "corrected" (2026-08-05, audit kasus AUDNZD:1785849311337): cbDir
// SEARAH dgn bias teknikal tapi AI sendiri salah mengklaim 'konflik' — Sistem Hakim
// mengoreksi balik ke 'searah'/'none'. Dipisah dari "clear" supaya kalibrasi bisa
// melihat apakah koreksi ini justru menyelamatkan setup yang sebenarnya valid.
function _sistemHakimCalibration(arr) {
  const out = {};
  for (const tag of ['fired', 'clear', 'corrected']) {
    const sub = arr.filter(x => x.sistem_hakim === tag && (x.status === 'tp' || x.status === 'sl'));
    const tp = sub.filter(x => x.status === 'tp').length;
    out[tag] = { n: sub.length, win_rate: sub.length ? Math.round(tp / sub.length * 100) : null };
  }
  return out;
}

// Agregat statistik dari log setup. Ambiguous TIDAK masuk pembagi win-rate manapun.
// PLAN U-1: dua metrik — win_rate_raw (semua tp/sl apa adanya, TIDAK PERNAH disensor)
// dan win_rate_adjusted (sl berlabel loss_label dikeluarkan dari pembagi). `win_rate`
// lama tetap ada = alias raw (kompatibilitas UI/prompt existing). `canceled` (status
// baru U-3, auto-cancel virtual) TIDAK masuk pembagi win-rate manapun, sama seperti
// ambiguous — cukup dihitung terpisah.
function _aggSetupStats(arr) {
  const by = s => arr.filter(x => x.status === s).length;
  const tp = by('tp'), sl = by('sl');
  const slEntries = arr.filter(x => x.status === 'sl');
  const lossCauses = { teknikal: 0, fundamental_shock: 0, fakeout_sl: 0 };
  for (const x of slEntries) {
    if (x.loss_label === 'fundamental_shock') lossCauses.fundamental_shock++;
    else if (x.loss_label === 'fakeout_sl') lossCauses.fakeout_sl++;
    else lossCauses.teknikal++;
  }
  const slAdjusted = lossCauses.teknikal; // sl berlabel dikeluarkan dari pembagi adjusted
  const winRateRaw = (tp + sl) > 0 ? Math.round(tp / (tp + sl) * 100) : null;
  return {
    total: arr.length,
    pending: by('pending'), open: by('open'),
    tp, sl, ambiguous: by('ambiguous'), expired: by('expired'), stale: by('stale') + by('invalid'),
    canceled: by('canceled'),
    win_rate: winRateRaw,
    win_rate_raw: winRateRaw,
    win_rate_adjusted: (tp + slAdjusted) > 0 ? Math.round(tp / (tp + slAdjusted) * 100) : null,
    loss_causes: lossCauses,
    // Expectancy R gross vs net-biaya spread (estimasi) — lihat _aggCostExpectancy.
    cost_expectancy: _aggCostExpectancy(arr),
    // Kalibrasi confidence AI (win-rate per level tinggi/sedang/rendah).
    confidence_calibration: _confidenceCalibration(arr),
    // [SISTEM HAKIM] kalibrasi win-rate fired vs clear — lihat _sistemHakimCalibration.
    sistem_hakim_calibration: _sistemHakimCalibration(arr),
    // PLAN U-5a: manajemen posisi VIRTUAL dilaporkan TERPISAH — makna win_rate di
    // atas TIDAK berubah (tetap kinerja ghost/pasif apa adanya).
    management: _aggManagementStats(arr),
    // PLAN U-3 lanjutan (2026-07-24): counterfactual pending yang dibatalkan via Flip
    // Guard non-whipsaw — lihat _evaluateCanceledGhost/_aggCancelFlipGhostStats di atas.
    cancel_flip_ghost: _aggCancelFlipGhostStats(arr),
    // (2026-08-08) counterfactual kandidat yang ditahan Gate D/B/A — lihat
    // _aggGateRejectGhostStats di atas.
    gate_reject_ghost: _aggGateRejectGhostStats(arr),
  };
}

// PLAN U-7: hapus blok `management`/`cancel_flip_ghost`/`gate_reject_ghost` (U-5a/U-3
// lanjutan/2026-08-08) dari agregat sebelum dikirim ke payload PUBLIK — diagnostik
// keputusan AI eksperimen HANYA boleh terlihat lewat scope=auto (REVISI VISIBILITAS).
// Field informasi U-1 (win_rate_raw/adjusted, loss_causes) tetap ikut apa adanya karena
// bukan bagian tiga blok itu.
function _omitManagement(stats) {
  const { management, cancel_flip_ghost, gate_reject_ghost, ...rest } = stats;
  return rest;
}

// PLAN U-7: ringkasan consistency_log:v1 (uji konsistensi LLM 3x/hari, U-3) untuk
// payload developer scope=auto. List Redis (LPUSH+LTRIM cap 60 di daemon) — dibaca
// penuh di sini (bukan endpoint publik/sering-dipanggil, hemat Redis tidak kritis).
async function _consistencySummary() {
  try {
    const raw = await redisCmd('LRANGE', 'consistency_log:v1', '0', '-1');
    const entries = Array.isArray(raw)
      ? raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
      : [];
    // AATAS (2026-08-22): angka agregat discope ke populasi kebijakan AATAS, alasan yang
    // SAMA dengan reset statistik setup (_statsPayloadFromLog). Konsistensi = properti
    // PROMPT + model ("kalau AI ditanya 3x, jawabannya sama tidak?"). AATAS mengganti
    // prompt jalur auto seluruhnya, jadi 24 sampel lama menjawab pertanyaan tentang
    // prompt yang sudah tidak dipakai auto-entry — menggabungkannya membuat angkanya
    // tidak berarti apa-apa, persis kesalahan yang dihindari di reset win rate.
    // Entri tidak punya `policy_v` (probe tidak menyimpan setup), jadi keanggotaan
    // populasi direkonstruksi dari `ts` — sah di sini karena `ts`-nya waktu probe
    // benar-benar jalan, bukan estimasi retroaktif atas data pihak lain.
    // `recent` TIDAK difilter (pola sama tabel Riwayat Setup): riwayat mentah tetap
    // bisa dibaca, cuma tidak ikut dihitung.
    const inAatas = e => {
      const v = policyVersionForTs(e && e.ts);
      return typeof v === 'number' && v >= AATAS_EPOCH;
    };
    const scoped = entries.filter(inAatas);
    const identical = scoped.filter(e => e.bias_identical).length;
    return {
      total: scoped.length,
      bias_identical: identical,
      bias_identical_pct: scoped.length ? Math.round(identical / scoped.length * 100) : null,
      recent: entries.slice(0, 10),
      from_policy_v: AATAS_EPOCH,
    };
  } catch (e) { return { total: 0, bias_identical: 0, bias_identical_pct: null, recent: [], from_policy_v: AATAS_EPOCH }; }
}

// Baca `calendar_actual_latency_log:v1` (list Redis, cap 100 — vps/daemon.js) dan
// ringkas via _summarizeLatency. Best-effort seperti _consistencySummary.
// SENGAJA TIDAK discope ke populasi AATAS (beda dari _consistencySummary di atas):
// ini mengukur seberapa cepat pipeline data kalender mendapat angka rilis aktual —
// murni infrastruktur, tidak ada hubungannya dengan cara AI mengambil keputusan.
// Membuangnya cuma akan menghapus data infra yang masih berlaku tanpa alasan.
async function _pipelineLatencySummary() {
  try {
    const raw = await redisCmd('LRANGE', 'calendar_actual_latency_log:v1', '0', '-1');
    const entries = Array.isArray(raw)
      ? raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
      : [];
    return _summarizeLatency(entries);
  } catch (e) { return { n: 0, avg_min: null, median_min: null, min_min: null, max_min: null }; }
}

// Riset tambahan (2026-07-20, item #4 diskusi user): ringkas seberapa cepat pipeline
// Daun Merah "tahu" angka rilis makro aktual, dari `calendar_actual_latency_log:v1`
// (ditulis daemon `pollCalendarLatency`, poll tiap 10 menit — lihat vps/daemon.js).
// latency_ms = jarak waktu rilis terjadwal -> field `actual` calendar_v1 terisi.
// Pure function atas array entries (bukan I/O) supaya testable tanpa Redis.
function _summarizeLatency(entries) {
  const ms = (entries || []).map(e => e && e.latency_ms).filter(n => typeof n === 'number' && n >= 0);
  if (!ms.length) return { n: 0, avg_min: null, median_min: null, min_min: null, max_min: null };
  const sorted = [...ms].sort((a, b) => a - b);
  const toMin = v => Math.round(v / 60000);
  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    n: ms.length,
    avg_min: toMin(ms.reduce((a, b) => a + b, 0) / ms.length),
    median_min: toMin(mid),
    min_min: toMin(sorted[0]),
    max_min: toMin(sorted[sorted.length - 1]),
  };
}

// PLAN U-7: payload developer-only scope=auto — agregat `setup_log_auto:v1`
// dievaluasi TERPISAH dari `setup_log:v1` (tidak pernah digabung satu array, aturan
// satu-array-satu-sumber), + blok `management` (U-5a) + ringkasan konsistensi (U-3).
function _statsPayloadFromLog(log) {
  // Rekonstruksi versi kebijakan untuk entri LAMA (dibuat sebelum stempel `policy_v`
  // ada, 2026-08-18) — dihitung SAAT DIBACA, TIDAK pernah ditulis balik ke Redis:
  // `policy_v` = fakta yang direkam saat setup lahir, `policy_v_est` = perkiraan dari
  // `ts` (prinsip U-5a — rekonstruksi tidak boleh menyamar jadi data asli). Salinan
  // dangkal HANYA untuk entri yang perlu (entri baru dipakai apa adanya, nol overhead).
  const decorated = (log || []).map(s => {
    if (!s || s.policy_v != null) return s;
    const est = policyVersionForTs(s.ts);
    return est == null ? s : { ...s, policy_v_est: est };
  });
  log = decorated;
  // AATAS (2026-08-22, permintaan eksplisit user): angka AGREGAT direset ke populasi
  // kebijakan baru — dihitung ULANG hanya dari setup ber-`policy_v` (atau `policy_v_est`
  // untuk entri lama) >= AATAS_EPOCH. Alasannya bukan kosmetik: sebelum AATAS, arah
  // trade ditentukan teknikal dulu dengan makro sebagai catatan kaki; sesudahnya makro
  // yang jadi gate. Win-rate gabungan dua arsitektur itu tidak menjawab pertanyaan apa
  // pun. Entri TANPA policy_v maupun policy_v_est (ts korup) DIKELUARKAN dari agregat —
  // tidak bisa dipastikan milik populasi mana, jangan ditebak.
  //
  // `recent` (tabel Riwayat Setup) & `symbols[k].history` SENGAJA TIDAK difilter: histori
  // lengkap tetap terlihat apa adanya, cuma tidak ikut dihitung. Ini permintaan user yang
  // spesifik — reset statistik, BUKAN menyembunyikan riwayat.
  const aatasLog = log.filter(_isAatasEpochSetup);
  const bySymbol = {};
  for (const s of log) { (bySymbol[s.symbol] = bySymbol[s.symbol] || []).push(s); }
  const symbols = {};
  for (const k of Object.keys(bySymbol)) {
    symbols[k] = _aggSetupStats(bySymbol[k].filter(_isAatasEpochSetup));
    symbols[k].history = bySymbol[k];
  }
  // `recent` dulu di-cap slice(0,10) di sini + dashboard sengaja bikin tabel selalu
  // 10 baris tanpa filter/paginasi. Sekarang dikirim penuh (log sudah newest-first,
  // ditulis via unshift) — dashboard yang paginasi client-side supaya bisa filter
  // status/pair tanpa kehilangan baris lama di luar 10 teratas.
  // `policy_epochs` ikut dikirim (developer scope saja — kedua pemanggil fungsi ini
  // adalah jalur scope=auto) supaya siapa pun yang menganalisis statistiknya tidak
  // perlu membuka source code untuk tahu versi berapa artinya apa: tiap epoch bawa
  // tanggal, label perubahan, dan `impact` (entry/pair_set/levels/exit/context/eval)
  // sebagai panduan di mana sampel LAYAK dibelah.
  // `stats_from_policy_v` ikut dikirim supaya dashboard bisa menjelaskan sendiri kenapa
  // angkanya nol/kecil (bukan "data hilang") tanpa siapa pun harus membuka source code.
  return { symbols, global: _aggSetupStats(aatasLog), recent: log, policy_epochs: POLICY_EPOCHS, stats_from_policy_v: AATAS_EPOCH };
}

// BUG DITEMUKAN & DIFIX (2026-07-25, diskusi user — status 'tp' palsu tersimpan di
// GC=F ts 1784708110704 padahal harga riil belum kena TP): siklus GET->evaluate->SET
// pasif di sini dulu TANPA lock, sementara jalur refine (ohlcv_analyze?auto=1, lihat
// `stalePending`) menulis array yang SAMA pakai lock `lock:setuplog_write:*`. Kalau
// keduanya jalan berdekatan waktu, yang menang timpa-menimpa (last-write-wins di
// seluruh array) — bisa membekukan hasil evaluasi basi (dihitung dari level SEBELUM
// refine) sambil field lain (entry/sl/tp/ts) sudah keburu ter-refine. Sekarang seluruh
// siklus GET->evaluate->SET di sini dibungkus lock YANG SAMA supaya saling eksklusif
// dengan refine. Kalau lock sedang dipegang pihak lain, skip evaluasi pasif tick ini
// (fail-open — baca snapshot mentah apa adanya, dicoba lagi tick berikutnya) daripada
// ikut menulis dan berpotensi menimpa balik perubahan yang sedang berlangsung.
// Efisiensi command Redis (2026-08-15, audit dashboard Upstash — 326K/500K
// command/bulan): 3 titik di _buildAutoScopeStats dulu masing-masing loop N
// GET ohlcv:<sym>:1h terpisah (1 command/symbol). MGET satu command untuk
// semua symbol yang belum ada di cache lokal candlesBySymbol — fail-open per
// BATCH (bukan per-symbol lagi, tapi filosofi sama: gagal = dicoba tick
// berikutnya, bukan macet permanen).
async function _fetchCandlesInto(symbols, candlesBySymbol) {
  const missing = [...new Set(symbols)].filter(sym => sym && !candlesBySymbol[sym]);
  if (!missing.length) return;
  try {
    const results = await redisCmd('MGET', ...missing.map(sym => `ohlcv:${sym}:1h`));
    missing.forEach((sym, i) => {
      const r = results && results[i];
      if (!r) return;
      try { candlesBySymbol[sym] = JSON.parse(r); } catch (e) { /* candle korup -> symbol itu tetap pending */ }
    });
  } catch (e) { /* Redis gagal -> semua symbol di batch ini tetap tak ter-update, dicoba lagi tick berikutnya */ }
}

// Dedup KHUSUS sumber cron 5-menit yang dobel (GH Actions setup-tp-sl-watch.yml
// + node-cron internal vps/daemon.js, keduanya `*/5 * * * *` tanpa saling tahu —
// lihat komentar startScheduler Q-7). Trigger event-driven (harga baru saja
// sentuh TP/SL, `maybeTriggerSetupWatch`) TIDAK PERNAH kirim `source=cron5`,
// jadi TIDAK PERNAH kena skip di sini — itu jalur cepat Q-7 yang justru harus
// selalu diproses penuh. Window (3 menit) SENGAJA lebih pendek dari interval
// cron (5 menit) — pola sama `OHLCV_SYNC_DEDUP_WINDOW_MS`, supaya tiap siklus
// tetap dapat 1x evaluasi penuh, cuma pemicu KEDUA yang datang belakangan
// (dobel identik) yang di-skip. Dev console (dev-auto-entry.html) tidak pernah
// kirim `source=cron5` — refresh manual tetap selalu full evaluasi seperti biasa.
const SETUP_STATS_CRON5_DEDUP_WINDOW_MS = 3 * 60 * 1000;
const SETUP_STATS_LAST_RUN_KEY = 'setup_stats_auto:last_run_at';

async function _cheapAutoScopeStats() {
  const rawFallback = await redisCmd('GET', 'setup_log_auto:v1');
  let logFallback = rawFallback ? JSON.parse(rawFallback) : [];
  if (!Array.isArray(logFallback)) logFallback = [];
  return {
    scope: 'auto', ..._statsPayloadFromLog(logFallback),
    consistency: await _consistencySummary(), pipeline_latency: await _pipelineLatencySummary(),
  };
}

async function _buildAutoScopeStats() {
  const setupLogKey = 'setup_log_auto:v1';
  const lockKey = `lock:setuplog_write:${setupLogKey}`;
  const gotLock = await redisCmd('SET', lockKey, '1', 'NX', 'EX', '10').catch(() => null);
  if (gotLock !== 'OK') return _cheapAutoScopeStats();
  try {
  const raw = await redisCmd('GET', setupLogKey);
  if (!raw) {
    await redisCmd('SET', SETUP_STATS_LAST_RUN_KEY, new Date().toISOString(), 'EX', '900').catch(() => {});
    return {
      scope: 'auto', symbols: {}, global: _aggSetupStats([]), recent: [], policy_epochs: POLICY_EPOCHS, stats_from_policy_v: AATAS_EPOCH,
      consistency: await _consistencySummary(), pipeline_latency: await _pipelineLatencySummary(),
    };
  }
  let log = JSON.parse(raw);
  if (!Array.isArray(log)) log = [];
  const active = [...new Set(log.filter(s => s && (s.status === 'pending' || s.status === 'open')).map(s => s.symbol))];
  const candlesBySymbol = {};
  let calendarEvents = [];
  let newsItems = [];
  await Promise.all([
    _fetchCandlesInto(active, candlesBySymbol),
    (async () => {
      if (!active.length) return;
      try {
        const [thisWeek, nextWeek] = await Promise.all([
          redisCmd('GET', 'calendar_v1'),
          redisCmd('GET', 'calendar_next_v1'),
        ]);
        const ev1 = thisWeek ? (JSON.parse(thisWeek).events || []) : [];
        const ev2 = nextWeek ? (JSON.parse(nextWeek).events || []) : [];
        calendarEvents = [...ev1, ...ev2];
      } catch (e) { /* kalender gagal -> deteksi fundamental_shock diskip */ }
    })(),
    (async () => {
      if (!active.length) return;
      newsItems = await _fetchRecentNewsItems();
    })(),
  ]);
  const before = JSON.stringify(log);
  // Q-7 (2026-07-28, diskusi user — TP/SL telat diketahui karena satu-satunya
  // trigger evaluasi sebelumnya cuma buka dev-auto-entry.html manual/slot
  // auto-entry 2x/hari): snapshot status SEBELUM _evaluateSetups mutasi objek
  // in-place, supaya transisi ke tp/sl/ambiguous di bawah bisa dideteksi lalu
  // di-push ke dev (lihat _notifySetupOutcome) — bukan diam-diam ketinggalan
  // sampai request berikutnya.
  const statusBeforeById = new Map(JSON.parse(before).map(s => [s.id, s.status]));
  log = _evaluateSetups(log, candlesBySymbol, Date.now(), calendarEvents, newsItems);
  // Track 1 (2026-08-04): invalidasi teknikal deterministik — SETELAH _evaluateSetups
  // supaya `closed_t` (kalau ada) jadi boundary prioritas TP/SL asli. Candle SAMA
  // (candlesBySymbol sudah difetch di atas untuk `active`), nol fetch tambahan.
  log = _evaluateTechInvalidation(log, candlesBySymbol);
  const managedPending = log.filter(s => s && s.intervention?.type === 'tighten_sl' && !s.managed_status);
  if (managedPending.length) {
    await _fetchCandlesInto(managedPending.map(s => s.symbol), candlesBySymbol);
    log = _evaluateManaged(log, candlesBySymbol);
  }
  // PLAN U-3 lanjutan (2026-07-24): sama pola managedPending di atas, tapi untuk ghost
  // cancel-flip (lihat _evaluateCanceledGhost) — symbol yang cuma dikenal lewat pending
  // yang sudah dibatalkan mungkin belum ada di `active`/candlesBySymbol sama sekali.
  const ghostPending = log.filter(s => s && s.status === 'canceled' && GHOST_TRACKED_CANCEL_REASONS.has(s.canceled_reason) && !s.ghost_status);
  if (ghostPending.length) {
    await _fetchCandlesInto(ghostPending.map(s => s.symbol), candlesBySymbol);
    log = _evaluateCanceledGhost(log, candlesBySymbol, Date.now());
  }
  const after = JSON.stringify(log);
  if (after !== before) await redisCmd('SET', setupLogKey, after);
  await _finalizeSetupTransitions(log, statusBeforeById);
  await redisCmd('SET', SETUP_STATS_LAST_RUN_KEY, new Date().toISOString(), 'EX', '900').catch(() => {});
  return {
    scope: 'auto', ..._statsPayloadFromLog(log),
    consistency: await _consistencySummary(), pipeline_latency: await _pipelineLatencySummary(),
  };
  } finally { redisCmd('DEL', lockKey).catch(() => {}); }
}

async function setupStatsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    // PLAN U-7 (REVISI VISIBILITAS): scope=auto developer-only dicek PALING AWAL —
    // jalur ini TIDAK PERNAH menyentuh setup_log:v1, murni terpisah dari payload
    // publik di bawah. Tanpa CRON_SECRET valid, JANGAN masuk sini (fall through ke
    // publik biasa — tidak ada respons yang membocorkan keberadaan scope ini).
    if (req.query.scope === 'auto' && _isCronCallReq(req)) {
      if (req.query.source === 'cron5') {
        try {
          const lastRunAt = await redisCmd('GET', SETUP_STATS_LAST_RUN_KEY);
          if (isCronDedupFresh(lastRunAt, Date.now(), SETUP_STATS_CRON5_DEDUP_WINDOW_MS)) {
            return res.status(200).json(await _cheapAutoScopeStats());
          }
        } catch (e) { /* dedup check gagal -> fail-open, tetap evaluasi penuh */ }
      }
      return res.status(200).json(await _buildAutoScopeStats());
    }

    const raw = await redisCmd('GET', 'setup_log:v1');
    if (!raw) return res.status(200).json({ symbols: {}, global: _omitManagement(_aggSetupStats([])), recent: [] });
    let log = JSON.parse(raw);
    if (!Array.isArray(log)) log = [];
    // Evaluasi lazy hanya symbol yang punya setup aktif — hemat Redis call
    const active = [...new Set(log.filter(s => s && (s.status === 'pending' || s.status === 'open')).map(s => s.symbol))];
    // PLAN U-2: currency strength (global, lintas 14 pair FX) numpang response ini
    // supaya U-4 bisa tampil tanpa call baru — gabung ke fetch candle yang sudah ada
    // (dedup symbol yang overlap dengan `active`, bukan fetch dobel).
    const strengthSymbols = [...new Set(FX_PAIRS_FOR_STRENGTH.map(p => p.symbol))];
    const candlesBySymbol = {};
    let calendarEvents = [];
    let newsItems = [];
    await Promise.all([
      ...[...new Set([...active, ...strengthSymbols])].map(async sym => {
        try {
          const r = await redisCmd('GET', `ohlcv:${sym}:1h`);
          if (r) candlesBySymbol[sym] = JSON.parse(r);
        } catch (e) { /* candle hilang → setup symbol itu tetap pending / strength skip pair ini */ }
      }),
      // Kalender dipakai deteksi fundamental_shock (PLAN U-1) — hanya perlu kalau ada
      // setup aktif yang bisa berpindah status ke 'sl' di tick ini. calendar_v1/next_v1
      // sama seperti dipakai ohlcvAnalyzeHandler, gagal fetch = fail-open (label kosong).
      (async () => {
        if (!active.length) return;
        try {
          const [thisWeek, nextWeek] = await Promise.all([
            redisCmd('GET', 'calendar_v1'),
            redisCmd('GET', 'calendar_next_v1'),
          ]);
          const ev1 = thisWeek ? (JSON.parse(thisWeek).events || []) : [];
          const ev2 = nextWeek ? (JSON.parse(nextWeek).events || []) : [];
          calendarEvents = [...ev1, ...ev2];
        } catch (e) { /* kalender gagal → deteksi fundamental_shock diskip, bukan crash */ }
      })(),
      (async () => {
        if (!active.length) return;
        newsItems = await _fetchRecentNewsItems();
      })(),
    ]);
    const before = JSON.stringify(log);
    log = _evaluateSetups(log, candlesBySymbol, Date.now(), calendarEvents, newsItems);
    // Track 1 (2026-08-04): invalidasi teknikal deterministik — SETELAH _evaluateSetups
    // supaya `closed_t` (kalau ada) jadi boundary prioritas TP/SL asli. Candle SAMA
    // (candlesBySymbol sudah difetch di atas untuk `active`), nol fetch tambahan.
    log = _evaluateTechInvalidation(log, candlesBySymbol);
    // PLAN U-5a: outcome manajemen (tighten_sl) dievaluasi SETELAH ghost pasif —
    // butuh candle symbol yang sudah punya intervention, mungkin di luar `active`
    // (posisi yang di-manage tapi status ghost-nya sudah tp/sl/dst) — fetch tambahan
    // best-effort, gagal = _evaluateManaged tetap jalan tanpa update (fail-open).
    const managedPending = log.filter(s => s && s.intervention?.type === 'tighten_sl' && !s.managed_status);
    if (managedPending.length) {
      await Promise.all([...new Set(managedPending.map(s => s.symbol))].map(async sym => {
        if (candlesBySymbol[sym]) return;
        try {
          const r = await redisCmd('GET', `ohlcv:${sym}:1h`);
          if (r) candlesBySymbol[sym] = JSON.parse(r);
        } catch (e) { /* symbol itu tetap tak ter-update, dicoba lagi tick berikutnya */ }
      }));
      log = _evaluateManaged(log, candlesBySymbol);
    }
    const after = JSON.stringify(log);
    // BUG DITEMUKAN & DIFIX (2026-07-25, audit lanjutan pasca-insiden GC=F): tick
    // evaluasi pasif di sini menulis setup_log:v1 TANPA lock, sementara jalur append
    // manual (ohlcvAnalyzeHandler, non-auto) SUDAH pakai lock `lock:setuplog_write:*`
    // untuk key yang sama. Race-nya lebih ringan dari kasus auto (manual tidak pernah
    // refine in-place, jadi tidak bisa fabrikasi status salah) tapi tetap bisa
    // lost-update: entri baru dari append hilang, atau transisi status hasil evaluate
    // ketimpa balik. Response tetap pakai `log` hasil evaluasi in-memory (selalu akurat
    // untuk request ini); yang dijaga lock cuma PERSIST-nya — fail-open kalau lock
    // dipegang pihak lain (dicoba lagi request berikutnya, pola sama _buildAutoScopeStats).
    if (after !== before) {
      const lk = 'lock:setuplog_write:setup_log:v1';
      const got = await redisCmd('SET', lk, '1', 'NX', 'EX', '10').catch(() => null);
      if (got === 'OK') {
        try { await redisCmd('SET', 'setup_log:v1', after); }
        finally { redisCmd('DEL', lk).catch(() => {}); }
      }
    }
    const bySymbol = {};
    for (const s of log) { (bySymbol[s.symbol] = bySymbol[s.symbol] || []).push(s); }
    const symbols = {};
    for (const k of Object.keys(bySymbol)) { symbols[k] = _aggSetupStats(bySymbol[k]); symbols[k].history = bySymbol[k]; }
    const strengthInput = FX_PAIRS_FOR_STRENGTH.map(p => ({ label: p.label, candles: candlesBySymbol[p.symbol] }));
    // PLAN U-7: blok `management` (U-5a) DIPINDAH keluar payload PUBLIK — hanya
    // muncul di scope=auto (di atas). Field informasi U-1 tetap publik apa adanya.
    const publicSymbols = {};
    for (const k of Object.keys(symbols)) publicSymbols[k] = _omitManagement(symbols[k]);
    return res.status(200).json({
      symbols: publicSymbols, global: _omitManagement(_aggSetupStats(log)), recent: log.slice(0, 10),
      pair_context: { strength: computeCurrencyStrength(strengthInput) },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

const LOSS_LABELS = new Set(['fundamental_shock', 'fakeout_sl', 'invalid_manual']);
const SETUP_STATUSES = new Set(['pending', 'open', 'tp', 'sl', 'ambiguous', 'expired', 'stale', 'canceled', 'invalid']);

// PLAN U-1 Lapis 4: override admin — set/hapus loss_label + label_reason per id setup.
// Sama seperti fundamentalSeedHandler/journalImportHandler: header x-admin-secret ATAU
// x-cron-secret sama dengan CRON_SECRET.
//
// EXTENSION (2026-07-25, diskusi user — status 'tp' palsu di GC=F ts 1784708110704
// akibat race condition evaluate-vs-refine, lihat komentar _buildAutoScopeStats):
// selain loss_label, endpoint ini sekarang juga menerima `data_fix` opsional untuk
// mengoreksi status/filled_t/closed_t yang TERBUKTI korup oleh bug — BUKAN untuk
// mengubah hasil trade sesuka hati. `reason` WAJIB diisi (jejak audit), tersimpan di
// `data_fix_reason`/`data_fix_by:'admin'`/`data_fix_at`, terpisah dari `label_by`
// (auto/manual detection biasa) supaya jelas mana koreksi manual atas bug. Read-modify-
// write dibungkus lock yang SAMA dengan _buildAutoScopeStats/refine supaya endpoint ini
// sendiri tidak menambah race condition baru.
async function setupOverrideHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  if (!CRON_SECRET || !safeEqual(secret || '', CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const { id } = parsed || {};
    const lossLabel = parsed?.loss_label ?? null;
    const labelReason = parsed?.label_reason;
    const dataFix = parsed?.data_fix ?? null;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (lossLabel !== null && !LOSS_LABELS.has(lossLabel)) {
      return res.status(400).json({ error: 'loss_label harus salah satu: fundamental_shock, fakeout_sl, invalid_manual, atau null' });
    }
    if (lossLabel !== null && (!labelReason || !String(labelReason).trim())) {
      return res.status(400).json({ error: 'label_reason wajib saat mengisi loss_label' });
    }
    if (dataFix) {
      if (!dataFix.reason || !String(dataFix.reason).trim()) {
        return res.status(400).json({ error: 'data_fix.reason wajib diisi' });
      }
      if (dataFix.status != null && !SETUP_STATUSES.has(dataFix.status)) {
        return res.status(400).json({ error: `data_fix.status harus salah satu: ${[...SETUP_STATUSES].join(', ')}` });
      }
      for (const k of ['filled_t', 'closed_t']) {
        if (dataFix[k] !== undefined && dataFix[k] !== null && !(Number.isFinite(dataFix[k]) && dataFix[k] > 0)) {
          return res.status(400).json({ error: `data_fix.${k} harus unix timestamp detik (angka > 0) atau null` });
        }
      }
    }

    // PLAN U-7: scope=auto melabel setup EKSPERIMEN (setup_log_auto:v1), default
    // (tanpa scope) tetap setup_log:v1 (manual) seperti semula U-1.
    const logKey = parsed?.scope === 'auto' ? 'setup_log_auto:v1' : 'setup_log:v1';
    const lockKey = `lock:setuplog_write:${logKey}`;
    const gotLock = await _acquireLockWithRetry(lockKey);
    if (!gotLock) {
      return res.status(409).json({ error: 'setup_log sedang ditulis proses lain, coba lagi sesaat lagi' });
    }
    try {
      const raw = await redisCmd('GET', logKey);
      let log = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(log)) log = [];
      const idx = log.findIndex(x => x && x.id === id);
      if (idx === -1) return res.status(404).json({ error: 'setup id tidak ditemukan' });

      if (parsed?.loss_label !== undefined) {
        log[idx].loss_label = lossLabel;
        log[idx].label_reason = lossLabel !== null ? String(labelReason).trim() : null;
        log[idx].label_by = lossLabel !== null ? 'admin' : null;
      }
      if (dataFix) {
        if (dataFix.status != null) log[idx].status = dataFix.status;
        for (const k of ['filled_t', 'closed_t']) {
          if (dataFix[k] === undefined) continue;
          if (dataFix[k] === null) delete log[idx][k]; else log[idx][k] = dataFix[k];
        }
        log[idx].data_fix_reason = String(dataFix.reason).trim();
        log[idx].data_fix_by = 'admin';
        log[idx].data_fix_at = Date.now();
      }

      await redisCmd('SET', logKey, JSON.stringify(log));
      return res.status(200).json({ ok: true, setup: log[idx] });
    } finally { redisCmd('DEL', lockKey).catch(() => {}); }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// PLAN U-5a — Review posisi VIRTUAL dipicu event-driven dari daemon (U-5b) saat
// headline market-moving/geopolitical menyentuh currency kaki pair setup `open`.
// Auth SAMA seperti setupOverrideHandler (x-admin-secret/x-cron-secret===CRON_SECRET)
// — endpoint ini TIDAK PERNAH publik, daemon adalah satu-satunya pemanggil produksi.
// Data mentah (entry_zone/sl/tp/status) TIDAK PERNAH disentuh (prinsip #2 §U-5) —
// hanya field `intervention`/`managed_status`/`review_count` yang ditulis di sini.
async function positionReviewHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const CRON_SECRET = process.env.CRON_SECRET;
  const secret = req.headers['x-admin-secret'] || req.headers['x-cron-secret'];
  if (!CRON_SECRET || !safeEqual(secret || '', CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const { id, trigger } = parsed || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!trigger || typeof trigger.guid !== 'string' || !trigger.guid.trim()
      || typeof trigger.title !== 'string' || !trigger.title.trim()) {
      return res.status(400).json({ error: 'trigger.guid dan trigger.title wajib' });
    }

    // PLAN U-7 (REVISI VISIBILITAS): position_review HANYA melayani setup EKSPERIMEN
    // di setup_log_auto:v1 — setup manual pengguna TIDAK PERNAH direview/diintervensi.
    const raw = await redisCmd('GET', 'setup_log_auto:v1');
    let log = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(log)) log = [];
    const idx = log.findIndex(x => x && x.id === id);
    if (idx === -1) {
      // id bisa jadi setup MANUAL (setup_log:v1) — tolak eksplisit TANPA call AI,
      // beda dari 404 generik (id benar-benar tidak ditemukan di kedua log).
      try {
        const rawManual = await redisCmd('GET', 'setup_log:v1');
        const manualLog = rawManual ? JSON.parse(rawManual) : [];
        if (Array.isArray(manualLog) && manualLog.some(x => x && x.id === id)) {
          return res.status(200).json({ skipped: 'not_experiment' });
        }
      } catch (e) { /* fail-open -> 404 generik di bawah */ }
      return res.status(404).json({ error: 'setup id tidak ditemukan' });
    }

    // Langkah 2a: re-cek murah SEBELUM call AI — tick _evaluateSetups pakai candle
    // symbol ini + kalender, sama pola setupStatsHandler (fail-open kalau gagal fetch).
    const symbol = log[idx].symbol;
    let candles = [];
    try {
      const rawC = await redisCmd('GET', `ohlcv:${symbol}:1h`);
      if (rawC) candles = JSON.parse(rawC);
    } catch (e) { /* fail-open: evaluate tetap jalan, status apa adanya tanpa candle baru */ }
    let calendarEvents = [];
    try {
      const [thisWeek, nextWeek] = await Promise.all([
        redisCmd('GET', 'calendar_v1'),
        redisCmd('GET', 'calendar_next_v1'),
      ]);
      const ev1 = thisWeek ? (JSON.parse(thisWeek).events || []) : [];
      const ev2 = nextWeek ? (JSON.parse(nextWeek).events || []) : [];
      calendarEvents = [...ev1, ...ev2];
    } catch (e) { /* opsional — deteksi fundamental_shock ghost diskip, bukan crash */ }
    const newsItems = await _fetchRecentNewsItems();

    // BUG DITEMUKAN & DIFIX (2026-07-25, diskusi user — lihat komentar _buildAutoScopeStats
    // soal race condition evaluate-vs-refine): tick evaluasi pasif di sini JUGA menulis
    // setup_log_auto:v1 tanpa lock — sumber race yang sama, TERBUKTI nyata (koreksi manual
    // GC=F sempat ketiban balik oleh handler ini). persistTick sekarang pakai lock yang sama.
    const before = JSON.stringify(log);
    const statusBeforeById = new Map([[log[idx].id, log[idx].status]]);
    _evaluateSetups(log, { [symbol]: candles }, Date.now(), calendarEvents, newsItems);
    await _finalizeSetupTransitions(log, statusBeforeById);
    const persistTick = async () => {
      if (JSON.stringify(log) === before) return;
      const lk = 'lock:setuplog_write:setup_log_auto:v1';
      const got = await redisCmd('SET', lk, '1', 'NX', 'EX', '10').catch(() => null);
      if (got !== 'OK') return; // fail-open: skip tick ini, dicoba lagi request berikutnya
      try { await redisCmd('SET', 'setup_log_auto:v1', JSON.stringify(log)); }
      finally { redisCmd('DEL', lk).catch(() => {}); }
    };
    const st = log[idx];

    if (st.status !== 'open') {
      await persistTick();
      return res.status(200).json({ skipped: 'not_open', status: st.status });
    }
    // Langkah 2b: satu intervensi per posisi — sudah ada tipe apa pun -> skip.
    if (st.intervention) {
      await persistTick();
      return res.status(200).json({ skipped: 'already_managed' });
    }

    // Langkah 2c: fact sheet ringkas + 1 AI call (DeepSeek v4-flash, pool eksperimen
    // — fitur ini developer-only, HANYA melayani id dari setup_log_auto:v1, lihat
    // langkah 2a di atas — fail-safe downgrade ke HOLD kalau offline/limit habis).
    // SambaNova akun 1 (primary lama di sini) diputus kontrak 2026-08-12 bareng akun 2
    // — lihat daun_merah_vendor.md.
    const closeLast = candles.length ? candles[candles.length - 1].c : null;
    const recentCandles = candles.slice(-12);
    const candleLines = recentCandles.length
      ? recentCandles.map(c => `t=${new Date(c.t * 1000).toISOString()} O:${c.o} H:${c.h} L:${c.l} C:${c.c}`).join('\n')
      : '(candle tidak tersedia)';
    const legs = String(st.label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
    let calBlock = '(tidak ada event kalender high/medium ±12 jam untuk pair ini)';
    try {
      const now = Date.now();
      const nearby = calendarEvents
        .filter(e => e && (e.impact === 'High' || e.impact === 'Medium') && legs.includes(String(e.currency || '').toUpperCase()))
        .map(e => ({ ...e, _ms: _calEventMsWib(e.date, e.time_wib) }))
        .filter(e => e._ms != null && Math.abs(e._ms - now) <= 12 * 3600 * 1000)
        .sort((a, b) => Math.abs(a._ms - now) - Math.abs(b._ms - now));
      if (nearby.length) {
        calBlock = nearby.map(e => `- ${e.event} (${e.currency}, impact ${e.impact}) ${e._ms > now ? 'dalam' : 'sudah lewat'} ${Math.abs((e._ms - now) / 3600000).toFixed(1)} jam`).join('\n');
      }
    } catch (e) { /* opsional */ }

    const corroborated = trigger.corroborated === true;
    const triggerBlock = [
      `[TRIGGER PEMICU REVIEW]`,
      `Headline: ${trigger.title}`,
      `Kategori: ${trigger.cat || '—'}`,
      corroborated
        ? 'Status: TERKONFIRMASI (>=2 sumber berbeda dalam 30 menit).'
        : 'Status: BELUM TERKONFIRMASI — headline BELUM terkonfirmasi, diskon berat, DILARANG keputusan agresif dua arah, default HOLD kecuali fakta lain sangat kuat.',
    ].join('\n');

    const setupBlock = [
      `[SETUP SEDANG BERJALAN]`,
      `Pair: ${st.label} | Bias: ${st.bias} | Entry: ${st.entry_zone} | SL: ${st.sl} | TP: ${st.tp}`,
      `Filled: ${st.filled_t ? new Date(st.filled_t * 1000).toISOString() : '—'}`,
    ].join('\n');

    const candleBlock = `[±12 CANDLE H1 TERAKHIR]\n${candleLines}`;

    const userMsg = [setupBlock, triggerBlock, candleBlock, `[KALENDER ±12 JAM]\n${calBlock}`].join('\n\n')
      + '\n\nBalas HANYA satu objek JSON valid (tanpa markdown fence, tanpa teks lain) persis format ini: '
      + '{"decision":"HOLD","new_sl":null,"reason":"...","confidence":"rendah"}. '
      + 'decision salah satu: HOLD, TIGHTEN_SL, CLOSE_EARLY. new_sl WAJIB angka saat TIGHTEN_SL (arah lebih ketat dari SL lama), null selain itu. confidence salah satu: rendah, sedang, tinggi.';

    const messages = [
      { role: 'system', content: 'Kamu manajer risiko posisi trading yang sedang berjalan (VIRTUAL, bukan eksekusi broker nyata). Tugasmu menilai apakah posisi terbuka ini perlu diintervensi karena headline pemicu terlampir. HOLD = default aman kalau tidak ada alasan kuat. TIGHTEN_SL = geser stop loss lebih ketat (mengunci kerugian lebih kecil / profit) karena risiko meningkat, BUKAN memperlebar. CLOSE_EARLY = tutup posisi sekarang karena tesis awal sudah tidak valid. Kalau trigger BELUM TERKONFIRMASI, default HOLD kecuali bukti lain (candle/kalender) sangat kuat. Jangan mengarang harga — new_sl HARUS masuk akal relatif terhadap SL lama dan harga sekarang. Saat menilai apakah trigger ini MENDUKUNG atau MENGANCAM bias posisi (field "reason"): bias bullish = mata uang BASE (kiri label pair) menguat vs QUOTE (kanan); bias bearish = mata uang QUOTE menguat vs BASE — berlaku SAMA untuk pair silang non-USD (misal AUD/NZD bearish = diuntungkan kalau NZD menguat, BUKAN diancam olehnya). Cek dulu mata uang mana yang diuntungkan bias ini sebelum menyimpulkan trigger itu mendukung atau mengancam — jangan terbalik. Bahasa Indonesia.' },
      { role: 'user', content: userMsg },
    ];

    let rawText = null, model = null;

    // DeepSeek v4-flash, pool eksperimen ('ai:deepseek:experimental'/'deepseek_experimental'
    // — BUKAN pool produksi publik) karena fitur ini developer-only, hanya melayani id
    // dari setup_log_auto:v1 — sama isolasi dengan Gate A Kritikus & ohlcv_analyze
    // auto-entry. SambaNova akun 1 (primary lama di sini) diputus kontrak 2026-08-12.
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
    if (!rawText && DEEPSEEK_KEY && await cb.canCall('ai:deepseek:experimental')) {
      try {
        if (!await allowAiCall('deepseek_experimental')) throw new Error('AI daily budget exceeded');
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 400, temperature: 0, thinking: { type: 'disabled' } }),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) {
          const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
          if (rawText) await cb.onSuccess('ai:deepseek:experimental');
          else throw new Error('Empty response');
        } else {
          const errJ = await r.json().catch(() => ({}));
          throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
        }
      } catch (e) { console.warn('position_review DeepSeek failed:', e.message); await cb.onFailure('ai:deepseek:experimental'); }
    } else if (!rawText && DEEPSEEK_KEY) { console.log('position_review: DeepSeek circuit OPEN/budget habis'); }

    // Langkah 2d: parse + validasi kode (fail-safe -> downgrade HOLD).
    let decision = 'HOLD', confidence = 'rendah', reason = null, newSlRaw = null, downgraded = false;
    if (!rawText) {
      downgraded = true; reason = 'AI tidak tersedia (DeepSeek offline/timeout/limit habis)';
    } else {
      try {
        const s = rawText.indexOf('{'), e = rawText.lastIndexOf('}');
        const cleaned = s !== -1 && e !== -1 ? rawText.slice(s, e + 1) : rawText;
        const p = JSON.parse(cleaned);
        const DECISIONS = new Set(['HOLD', 'TIGHTEN_SL', 'CLOSE_EARLY']);
        decision = DECISIONS.has(p.decision) ? p.decision : 'HOLD';
        confidence = ['rendah', 'sedang', 'tinggi'].includes(p.confidence) ? p.confidence : 'rendah';
        reason = (typeof p.reason === 'string' && p.reason.trim()) ? p.reason.trim() : null;
        newSlRaw = Number.isFinite(p.new_sl) ? p.new_sl : (typeof p.new_sl === 'string' ? parseFloat(p.new_sl) : null);
        if (!DECISIONS.has(p.decision)) { downgraded = true; }
      } catch (e) {
        downgraded = true; decision = 'HOLD'; reason = 'output AI tidak patuh skema JSON';
        console.warn('position_review: JSON parse gagal:', e.message);
      }
    }

    if (decision === 'TIGHTEN_SL') {
      const eNums = (String(st.entry_zone).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
      const eLo = eNums.length ? Math.min(...eNums) : null;
      const eHi = eNums.length ? Math.max(...eNums) : null;
      const slOld = parseFloat((String(st.sl).match(/[\d.]+/) || [])[0]);
      const ok = validateTightenSl({ bias: st.bias, slOld, newSl: newSlRaw, closeLast, eLo, eHi });
      if (!ok) {
        decision = 'HOLD'; downgraded = true;
        reason = (reason ? reason + ' — ' : '') + 'TIGHTEN_SL ditolak validasi kode (SL melebar/menyalip zona entry/tidak valid)';
      }
    }
    if (decision === 'CLOSE_EARLY' && closeLast == null) {
      decision = 'HOLD'; downgraded = true;
      reason = (reason ? reason + ' — ' : '') + 'candle terakhir tidak tersedia untuk CLOSE_EARLY';
    }

    // Langkah 2e: terapkan HANYA field manajemen — data mentah/status TIDAK disentuh.
    // BUG DITEMUKAN & DIFIX (2026-07-25): `log`/`st` di sini adalah snapshot dari SEBELUM
    // call AI (bisa puluhan detik lalu, lihat langkah 2c) — menulisnya langsung berisiko
    // menimpa balik perubahan lain yang terjadi SELAMA AI mikir (persis race condition yang
    // ditemukan di _buildAutoScopeStats). Lock TIDAK dipegang selama call AI (lock TTL 10s,
    // AI call bisa puluhan detik) — sebagai gantinya, baca ULANG state TERBARU di bawah lock
    // tepat sebelum menulis, dan batalkan kalau posisi sudah berubah (sudah dikelola pihak
    // lain / bukan 'open' lagi) daripada menimpa buta.
    const lockKey2 = 'lock:setuplog_write:setup_log_auto:v1';
    const gotLock2 = await _acquireLockWithRetry(lockKey2);
    if (!gotLock2) {
      return res.status(409).json({ error: 'setup_log_auto sedang ditulis proses lain, keputusan AI dibuang, coba lagi' });
    }
    try {
      const rawFresh = await redisCmd('GET', 'setup_log_auto:v1');
      let logFresh = rawFresh ? JSON.parse(rawFresh) : [];
      if (!Array.isArray(logFresh)) logFresh = [];
      const idxFresh = logFresh.findIndex(x => x && x.id === id);
      if (idxFresh === -1) return res.status(404).json({ error: 'setup id hilang saat AI memproses' });
      const stFresh = logFresh[idxFresh];
      if (stFresh.status !== 'open' || stFresh.intervention) {
        return res.status(200).json({ skipped: 'race_detected', status: stFresh.status, note: 'posisi sudah berubah selama AI memproses, keputusan dibuang' });
      }
      stFresh.review_count = (stFresh.review_count || 0) + 1;
      if (decision === 'TIGHTEN_SL') {
        stFresh.intervention = { type: 'tighten_sl', t: Date.now(), price: null, new_sl: newSlRaw, reason, trigger_guid: trigger.guid };
      } else if (decision === 'CLOSE_EARLY') {
        stFresh.intervention = { type: 'close_early', t: Date.now(), price: closeLast, new_sl: null, reason, trigger_guid: trigger.guid };
        stFresh.managed_status = 'closed_early';
        stFresh.managed_closed_t = Math.floor(Date.now() / 1000);
      }
      await redisCmd('SET', 'setup_log_auto:v1', JSON.stringify(logFresh));
      st.review_count = stFresh.review_count; st.intervention = stFresh.intervention;
      st.managed_status = stFresh.managed_status; st.managed_closed_t = stFresh.managed_closed_t;
    } finally { redisCmd('DEL', lockKey2).catch(() => {}); }
    await redisCmd('LPUSH', 'position_review_log:v1', JSON.stringify({
      id, t: Date.now(), trigger: { guid: trigger.guid, title: trigger.title }, decision, confidence, downgraded,
    }));
    await redisCmd('LTRIM', 'position_review_log:v1', '0', '99');

    return res.status(200).json({ ok: true, decision, confidence, downgraded, model, setup: st });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// PLAN U-3 lanjutan (2026-07-24, diskusi user soal weekend gap risk): tighten SL
// PREVENTIF sekali tiap Jumat sebelum market tutup, untuk SEMUA posisi eksperimen
// OPEN di setup_log_auto:v1 — beda dari position_review di atas (itu reaktif, dipicu
// berita spesifik + keputusan LLM). Ini murni kode (computePreventiveTightenSl), TIDAK
// ADA call AI — tidak butuh alasan/konteks per posisi, cuma "market mau tutup 2 hari,
// kita tidak bisa react apa-apa selama itu". Dipicu vps/daemon.js (runFridayTightenCycle)
// via cron Jumat, jam diatur env FRIDAY_TIGHTEN_HOUR_UTC di sisi daemon (bukan di sini).
async function fridayTightenHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret   = req.headers['x-cron-secret'];
  if (!isVercelCron && (!cronSecret || !safeEqual(cronSecret || '', process.env.CRON_SECRET || ''))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // BUG DITEMUKAN & DIFIX (2026-07-25): GET->mutate->SET di sini dulu TANPA lock, sumber
  // race yang sama dengan _buildAutoScopeStats/positionReviewHandler (lihat komentar di
  // situ). Tidak ada call AI di handler ini (murni kode) jadi seluruh siklus aman dibungkus
  // SATU lock, sama seperti _buildAutoScopeStats.
  const lockKey = 'lock:setuplog_write:setup_log_auto:v1';
  const gotLock = await _acquireLockWithRetry(lockKey);
  if (!gotLock) {
    return res.status(409).json({ error: 'setup_log_auto sedang ditulis proses lain, coba lagi' });
  }
  try {
    const raw = await redisCmd('GET', 'setup_log_auto:v1');
    let log = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(log)) log = [];
    // Satu intervensi per posisi (pola sama position_review langkah 2b) — kalau sudah
    // dikelola (reaktif ATAU preventif minggu lalu kalau entah bagaimana belum resolved),
    // jangan numpuk intervensi kedua di atasnya.
    const candidates = log.filter(s => s && s.status === 'open' && !s.intervention);
    if (!candidates.length) return res.status(200).json({ ok: true, checked: 0, tightened: 0 });

    const candlesBySymbol = {};
    await Promise.all([...new Set(candidates.map(s => s.symbol))].map(async sym => {
      try {
        const r = await redisCmd('GET', `ohlcv:${sym}:1h`);
        if (r) candlesBySymbol[sym] = JSON.parse(r);
      } catch (e) { /* symbol itu dilewati minggu ini, dicoba lagi Jumat berikutnya */ }
    }));

    let tightened = 0;
    const results = [];
    for (const st of candidates) {
      const candles = candlesBySymbol[st.symbol];
      const closeLast = Array.isArray(candles) && candles.length ? candles[candles.length - 1].c : null;
      if (closeLast == null) { results.push({ id: st.id, tightened: false, reason: 'no_candle' }); continue; }
      const eNums = (String(st.entry_zone).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
      const eLo = eNums.length ? Math.min(...eNums) : null;
      const eHi = eNums.length ? Math.max(...eNums) : null;
      const slOld = parseFloat((String(st.sl).match(/[\d.]+/) || [])[0]);
      const newSl = computePreventiveTightenSl({ bias: st.bias, slOld, closeLast, eLo, eHi });
      if (newSl == null) { results.push({ id: st.id, tightened: false, reason: 'invalid_or_too_close' }); continue; }
      st.intervention = {
        type: 'tighten_sl_preventive', t: Date.now(), price: null, new_sl: newSl,
        reason: 'Tighten preventif sebelum weekend close — proteksi gap, bukan reaksi berita.',
        trigger_guid: null,
      };
      tightened++;
      results.push({ id: st.id, tightened: true, new_sl: newSl });
    }
    if (tightened > 0) await redisCmd('SET', 'setup_log_auto:v1', JSON.stringify(log));
    return res.status(200).json({ ok: true, checked: candidates.length, tightened, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally { redisCmd('DEL', lockKey).catch(() => {}); }
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

// Render blok [KANDIDAT SL/TP] untuk prompt AI (PLAN Z, 2026-08-18) — perluasan pola
// [ZONA KONFLUENSI] di atas ke sl/tp. Bias belum diketahui saat prompt dibangun (sama
// seperti entryZoneInstr), jadi dua varian (bearish & bullish) disajikan sekaligus;
// AI memilih sesuai bias yang ia tentukan sendiri di respons yang sama. Lihat
// api/_levels.js untuk cara kandidat ini dihitung & alasan desainnya.
function _formatLevelCandidatesBlock(lc) {
  if (!lc || (!lc.bearish && !lc.bullish)) return '';
  const f = n => n.toFixed(lc.dec ?? 5);
  const fmtList = (list, prefix) => list.map((c, i) => `    ${prefix}${i + 1}. ${f(c.price)} = ${c.label}`).join('\n');
  const lines = ['[KANDIDAT SL/TP — dihitung DETERMINISTIK oleh kode dari struktur yang sama dengan ZONA KONFLUENSI; pilih SATU sesuai bias yang kamu tentukan, JANGAN mengarang angka di luar daftar ini]'];
  if (lc.bearish) {
    lines.push('  Kalau bias BEARISH:');
    lines.push('    SL (di atas Now, melindungi entry):');
    lines.push(fmtList(lc.bearish.sl, 'S'));
    lines.push('    TP (di bawah Now, sisi profit):');
    lines.push(fmtList(lc.bearish.tp, 'T'));
  }
  if (lc.bullish) {
    lines.push('  Kalau bias BULLISH:');
    lines.push('    SL (di bawah Now, melindungi entry):');
    lines.push(fmtList(lc.bullish.sl, 'S'));
    lines.push('    TP (di atas Now, sisi profit):');
    lines.push(fmtList(lc.bullish.tp, 'T'));
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
    // Blok XAUUSD self-contained = tertarget, cap longgar 2500 (sama seperti FX tertarget
    // di bawah) supaya segmen geopolitik di ekor tidak terpotong; fallback non-blok tetap
    // ikut jalur 3-paragraf yang di-cap ketat.
    return excerpt ? cap(excerpt, xauIdx !== -1 ? 2500 : 700) : null;
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
  // Cap 2500 (dinaikkan dari 900, S194): excerpt tertarget sudah minim noise dan isi
  // picked realistis 1.200-1.800 char — 900 masih memotong ekor blok Konfirmasi. 2500
  // praktis tak pernah memotong; tambahan ~500 token input tidak signifikan (DeepSeek
  // konteks 128K, biaya ~$0.00015/analisa). Fallback tanpa-tag SENGAJA tetap 700
  // (isinya "3 paragraf pertama" apapun pair-nya = noisy, jangan diperbesar).
  return cap(picked.join('\n\n'), 2500);
}

// Duplikasi SADAR dari CB_BIAS_LEVEL/_ckInferDirFromCbBias di index.html — pola sama
// dengan duplikasi vps/daemon.js<->api/*.js (lihat catatan drift di sana): kalau label
// bank sentral baru ditambah di index.html, ingat replikasi mapping ini juga.
const CB_BIAS_LEVEL = {
  'hawkish': 6, 'cautious hawkish': 5,
  'neutral': 4, 'data dependent': 4, 'on hold': 4, 'split': 4,
  'cautious dovish': 3, 'dovish': 2,
};
const CB_BIAS_NEUTRAL_LVL = 4;

// [SISTEM HAKIM] cbDir server-side (2026-07-29, diskusi user) — dulu HANYA dihitung
// client (index.html, _ckInferDirFromCbBias) dan dikirim lewat body POST manual;
// trigger cron auto-entry (vps/daemon.js) adalah GET tanpa body, jadi guard "Sistem
// Hakim" di ohlcvAnalyzeHandler diam-diam TIDAK PERNAH menyala di jalur otomatis.
// Dipanggil HANYA sebagai fallback saat body tidak mengirim cbDir (lihat pemanggil) —
// perilaku manual yang sudah ada tidak disentuh.
// Syarat kekuatan bukti SENGAJA lebih ketat dari versi client: client memaksa veto
// dari bias apa pun (termasuk confidence Medium/Low). User eksplisit tidak mau "Sistem
// Hakim" jadi pembuat keputusan di jalur otomatis — hanya aktif kalau confidence KEDUA
// leg 'High' (bukan Medium/Low) dan tidak sedang di-flag divergence_warning (Call 2
// digest menahan bias lama karena sinyal baru belum cukup kuat — jangan dipakai
// memaksa apa pun selama masih disputed). Untuk XAU, xau_confidence (skala 1-5) harus
// >=4. Fail-closed: data kurang/lemah -> null (Sistem Hakim diam, bukan menebak).
function _computeCbDirServerSide({ label, isXau, cbBiasObj, xauThesis }) {
  if (isXau) {
    if (!xauThesis || typeof xauThesis.xau_confidence !== 'number' || xauThesis.xau_confidence < 4) return null;
    if (xauThesis.xau_bias === 'bullish') return 'long';
    if (xauThesis.xau_bias === 'bearish') return 'short';
    return null;
  }
  const legs = String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  if (legs.length !== 2) return null;
  const [base, quote] = legs;
  const bCb = cbBiasObj?.[base], qCb = cbBiasObj?.[quote];
  if (!bCb?.bias || !qCb?.bias) return null;
  if (bCb.confidence !== 'High' || qCb.confidence !== 'High') return null;
  if (bCb.divergence_warning || qCb.divergence_warning) return null;
  const bL = CB_BIAS_LEVEL[String(bCb.bias).toLowerCase()] ?? CB_BIAS_NEUTRAL_LVL;
  const qL = CB_BIAS_LEVEL[String(qCb.bias).toLowerCase()] ?? CB_BIAS_NEUTRAL_LVL;
  return bL === qL ? null : (bL > qL ? 'long' : 'short');
}

// [CEK KONTRADIKSI] (2026-08-10) — independen dari Sistem Hakim di atas (yang butuh cbDir,
// artinya bias bank sentral KEDUA kaki confidence High). Ditemukan dari kasus nyata CHF/JPY:
// AI menulis "...mendukung penguatan JPY vs CHF, searah dengan bias bullish CHF/JPY karena
// JPY... yang melemah" — JPY diklaim MENGUAT dan MELEMAH sekaligus di kalimat yang sama.
// cbDir tidak menyala waktu itu (bias CHF/SNB kemungkinan tidak confidence High), jadi
// setup ini lolos tanpa penjaga apa pun. Guard ini cek pola teksnya sendiri: kalau mata
// uang yang SAMA disebut menguat DAN melemah dalam satu makro_alignment_reason, itu tanda
// AI salah nalar arah (bukan halusinasi data — datanya bisa saja asli — tapi kesimpulan
// arahnya kontradiktif). Tiap kata arah (menguat/melemah) dipasangkan ke currency code
// TERDEKAT — jarak dihitung antar TEPI kata (gap), bukan index-ke-index mentah, supaya
// panjang kata arah sendiri tidak bikin currency yang sebenarnya nempel jadi kelihatan
// "lebih jauh" dari currency lain yang cuma kebetulan berdekatan (lihat riwayat commit
// test untuk kasus nyata yang menemukan ini: "menguatkan JPY dan melemahkan USD" — tanpa
// gap-distance, "melemahkan" salah nempel ke JPY yang cuma numpang lewat di klausa
// sebelumnya, bukan ke USD yang jadi objeknya). Currency yang didahului "terhadap"/"vs"
// (pola umum "A menguat/melemah TERHADAP B") dikecualikan dari pencarian — B di situ
// cuma pembanding, bukan subjek yang benar-benar bergerak, jadi tidak boleh ikut ditarik
// jadi pasangan kata arah. Maks jarak 45 karakter (di luar itu dianggap tak terkait).
const ALIGNMENT_CCY_RE = /\b(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF)\b/g;
const ALIGNMENT_STRENGTHEN_RE = /menguat|penguatan/gi;
const ALIGNMENT_WEAKEN_RE = /melemah|pelemahan/gi;
const ALIGNMENT_REF_PREFIX_RE = /\b(terhadap|vs)\s*$/i;
const ALIGNMENT_MAX_DIST = 45;
function _detectAlignmentReasonContradiction(reason) {
  if (!reason || typeof reason !== 'string') return false;
  const ccyPositions = [];
  {
    const re = new RegExp(ALIGNMENT_CCY_RE.source, 'g');
    let m;
    while ((m = re.exec(reason))) {
      const start = m.index, end = m.index + m[0].length;
      const isReference = ALIGNMENT_REF_PREFIX_RE.test(reason.slice(Math.max(0, start - 15), start));
      ccyPositions.push({ ccy: m[1], start, end, isReference });
    }
  }
  if (ccyPositions.length === 0) return false;

  const dirWords = [];
  {
    const re = new RegExp(ALIGNMENT_STRENGTHEN_RE.source, 'gi');
    let m;
    while ((m = re.exec(reason))) dirWords.push({ dir: 'strengthen', start: m.index, end: m.index + m[0].length });
  }
  {
    const re = new RegExp(ALIGNMENT_WEAKEN_RE.source, 'gi');
    let m;
    while ((m = re.exec(reason))) dirWords.push({ dir: 'weaken', start: m.index, end: m.index + m[0].length });
  }

  const dirByCcy = {};
  for (const d of dirWords) {
    let nearest = null, nearestGap = Infinity;
    for (const c of ccyPositions) {
      if (c.isReference) continue;
      const gap = c.start >= d.end ? c.start - d.end : (d.start >= c.end ? d.start - c.end : 0);
      if (gap < nearestGap) { nearestGap = gap; nearest = c; }
    }
    if (!nearest || nearestGap > ALIGNMENT_MAX_DIST) continue;
    const prevDir = dirByCcy[nearest.ccy];
    if (prevDir && prevDir !== d.dir) return true;
    dirByCcy[nearest.ccy] = d.dir;
  }
  return false;
}

// Format blok fundamental terstruktur per pair untuk prompt Analisa (pure — dites unit).
// Sumber: cb_bias (dirawat Call 2 digest), cot_cache_v2 (CFTC; USD = Dollar Index),
// risk_regime — data langsung dari cache server, BUKAN turunan prosa artikel, jadi
// Analisa tetap dapat fundamental kedua leg meski artikel hari itu tidak membahasnya.
function _formatFundamentalBlock({ label, isXau, cbBias, cot, risk, retail, drivers, nowMs, hasCmeData }) {
  const legs = String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  if (legs.length === 0) return '';
  const ageH = iso => {
    if (!iso) return null;
    const ms = nowMs - new Date(iso).getTime();
    return (isNaN(ms) || ms < 0) ? null : Math.round(ms / 3600000);
  };
  const lines = [];
  let hasCotData = false;
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
      // Umur laporan (2026-08-10, diskusi user): report_date CFTC cuma tanggal (bukan
      // timestamp) — tetap dipakai untuk kasih AI angka konkret seberapa basi data ini,
      // bukan cuma label "mingguan" generik. Age dibulatkan ke hari (bukan jam) karena
      // granularitas sumbernya memang harian.
      const cotAgeD = cot?.report_date ? Math.floor((nowMs - new Date(cot.report_date).getTime()) / 86400000) : null;
      const extras = [
        typeof cp.lev_change_net === 'number' ? `${k(cp.lev_change_net)} w/w` : null,
        cp.lev_net_pct_oi != null ? `${cp.lev_net_pct_oi > 0 ? '+' : ''}${cp.lev_net_pct_oi}% dari OI` : null,
        pctile?.lev_pctile != null ? `persentil 3thn P${pctile.lev_pctile}${pctile.lev_pctile >= 90 ? ' — CROWDED LONG, rawan squeeze turun' : pctile.lev_pctile <= 10 ? ' — CROWDED SHORT, rawan squeeze naik' : ''}` : null,
        (cotAgeD != null && cotAgeD >= 0) ? `laporan ${cotAgeD} hari lalu` : null,
      ].filter(Boolean).join(', ');
      parts.push(`COT leveraged net ${k(cp.lev_net)}${extras ? ` (${extras})` : ''}`);
      hasCotData = true;
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
  // Driver dolar/komoditas (2026-07-21, diskusi user): sebelumnya AI cuma dikasih label
  // ("geopolitik eskalasi", "real yield tinggi") tanpa angka mentah untuk menelusuri
  // mekanismenya sendiri — DXY/WTI di sini + breakdown real yield di bawah supaya klaim
  // makro_alignment_reason bisa mengutip data konkret (level & %chg), bukan template
  // generik. DXY/WTI selalu relevan (barometer dolar broad/risk-off berlaku lintas pair).
  const dxy = drivers?.dxy, wti = drivers?.wti;
  const dcParts = [];
  if (dxy?.pct != null) dcParts.push(`DXY ${dxy.level != null ? dxy.level.toFixed(2) : '?'} (${dxy.pct >= 0 ? '+' : ''}${dxy.pct.toFixed(2)}% hari ini)`);
  if (wti?.pct != null) dcParts.push(`WTI $${wti.level != null ? wti.level.toFixed(2) : '?'} (${wti.pct >= 0 ? '+' : ''}${wti.pct.toFixed(2)}% hari ini)`);
  if (dcParts.length > 0) lines.push(`DOLLAR & KOMODITAS: ${dcParts.join(' | ')}`);
  // Real yield per-leg (2026-08-04, rapat user): dulu cuma dicek untuk leg USD — real_yields
  // cache sebenarnya sudah punya nominal/inflation_exp/real untuk EUR/GBP/JPY/CAD/AUD/NZD/CHF
  // juga (lihat api/real-yields.js), jadi AUD/NZD & EUR/GBP (dua leg NON-USD) selama ini tidak
  // pernah dapat baris ini walau datanya sudah ada di cache. Loop semua leg pair ini, bukan
  // hardcode USD — cakupan otomatis ikut legs, tidak perlu daftar pair manual.
  const realYields = drivers?.realYields || {};
  for (const leg of legs) {
    const ry = realYields[leg];
    if (!ry || ry.nominal == null || ry.inflation_exp == null || ry.real == null) continue;
    const goldNote = (isXau && leg === 'USD')
      ? ' (driver utama gold — kalau mau klaim "real yield naik/turun karena X", cek dulu apakah X ini sejalan dengan komponen nominal atau inflasi di atas, bukan cuma angka real yield akhir)'
      : '';
    lines.push(`REAL YIELD ${leg}: nominal ${ry.nominal}% − ekspektasi inflasi ${ry.inflation_exp}% = real yield ${ry.real}%${goldNote}`);
  }
  // Catatan kausal EUR/USD (2026-08-08, pair_workflow.md folder professional_llm_trader
  // §"Faktor Kekuatan/Kelemahan per Pair"): driver dominan EUR/USD horizon 1-3 tahun
  // adalah DIFFERENTIAL suku bunga Fed-ECB (bukan level tiap kaki sendiri-sendiri) —
  // riset pasar: tiap penyempitan 50bp differential historisnya berasosiasi ~300-400
  // pip pergerakan EUR/USD, non-linear (dampak proporsional lebih besar saat level suku
  // bunga sudah rendah). Pola sama goldNote di atas — kasih arah kausal eksplisit,
  // bukan cuma angka mentah dua kaki terpisah yang AI harus simpulkan sendiri.
  if (label === 'EUR/USD' && realYields.EUR && realYields.USD
    && realYields.EUR.nominal != null && realYields.USD.nominal != null) {
    const diff = realYields.EUR.nominal - realYields.USD.nominal;
    lines.push(`DIFFERENTIAL SUKU BUNGA EUR-USD: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp (nominal, EUR minus USD) — ini driver dominan EUR/USD horizon 1-3 tahun (lebih penting dari level tiap kaki sendiri-sendiri); differential MENYEMPIT (ECB relatif lebih hawkish / Fed relatif lebih dovish) historisnya EUR/USD-bullish, MELEBAR sebaliknya bearish.`);
  }
  if (lines.length === 0) return '';
  const baseNote = isXau
    ? 'catatan: XAU tidak punya bank sentral — pakai bias Fed (USD) + risk regime sebagai proxy arah dolar/haven'
    : 'gunakan untuk menilai apakah setup teknikal searah atau melawan fundamental kedua leg';
  // (2026-08-08, diskusi user — reordering prioritas COT vs CME) COT CFTC TIDAK
  // dihapus, tetap konteks positioning yang valid — cuma diturunkan bobotnya untuk
  // urusan MENENTUKAN ARAH, karena COT itu data mingguan yang bisa lag beberapa hari
  // (vs horizon trading sistem ini yang cuma ~3 hari). Ini framing/penekanan kalimat,
  // BUKAN aturan keras dengan angka ambang — AI tetap yang memutuskan, tidak ada
  // auto-block di sini.
  // (2026-08-10, diskusi user — perluas cakupan) Sebelumnya catatan "data mingguan,
  // bobot lebih rendah" HANYA muncul kalau hasCmeData true (pair itu juga punya blok
  // CME real-time) — pair TANPA CME (mis. CHF/JPY) sama sekali tidak dapat pengingat
  // staleness ini walau COT-nya sama basinya. Sekarang catatan dasar selalu muncul
  // kalau ada data COT sama sekali; kalimat tambahan soal prioritas CME cuma nempel
  // kalau hasCmeData true.
  const cotNote = hasCotData
    ? ` COT CFTC di atas itu data MINGGUAN (bisa lag beberapa hari dari tanggal laporan) — untuk MENENTUKAN ARAH beri bobot lebih rendah dibanding sinyal yang lebih real-time (bias CB terbaru, DXY/real yield, retail sentiment intraday${hasCmeData ? ', CME options skew' : ''}); COT lebih andal untuk mendeteksi CROWDING/ekstremitas positioning (lihat persentil) daripada arah harian.${hasCmeData ? ' Kalau prompt ini juga berisi blok SENTIMEN PASAR OPTIONS CME untuk pair yang sama, itu real-time dan LEBIH DIPRIORITASKAN untuk menentukan arah dibanding COT.' : ''}`
    : '';
  return `FUNDAMENTAL TERSTRUKTUR (cache server, bukan dari artikel — ${baseNote}.${cotNote}):\n${lines.join('\n')}`;
}

// Snapshot numerik ringkas dari SEMUA input makro yang dilihat AI saat itu (cb_bias,
// COT per leg, retail sentiment, DXY/WTI, real yield per leg, risk regime, CME skew) —
// disimpan ke tiap setup auto-entry (2026-08-08, diskusi user pasca-audit skew XAU/
// EUR-GBP: dari 4 trade lama, cuma 1 yang kebetulan nyebut angka skew di teks bebas
// `makro_alignment_reason`, 3 sisanya buta total karena tidak pernah direkam terpisah).
// Sebelumnya HANYA `regime` yang direkam (Track 1b) — field lain numpang lewat prompt
// lalu hilang, sama sekali tidak bisa direkonstruksi buat audit/kalibrasi nanti.
// Pure function — irisan per-leg pair ini SAJA (bukan seluruh cache global currency),
// biar ringan & relevan. Return null kalau semua sumber kosong (fail-open, konsisten
// dengan blok prompt lain di fungsi ini).
function _buildMacroSnapshot({ label, isXau, cbBias, cot, retail, risk, drivers, rrPair }) {
  const legs = String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  const cbByLeg = {}, cotByLeg = {}, realYieldByLeg = {};
  for (const leg of legs) {
    const cb = cbBias?.[leg];
    if (cb?.bias) cbByLeg[leg] = { bias: cb.bias, confidence: cb.confidence ?? null };
    const cp = cot?.positions?.[leg];
    if (cp && typeof cp.lev_net === 'number') {
      const pctile = cot?.percentiles?.[leg];
      cotByLeg[leg] = {
        lev_net: cp.lev_net,
        lev_change_net: cp.lev_change_net ?? null,
        lev_net_pct_oi: cp.lev_net_pct_oi ?? null,
        lev_pctile: pctile?.lev_pctile ?? null,
      };
    }
    const ry = drivers?.realYields?.[leg];
    if (ry && ry.nominal != null && ry.inflation_exp != null && ry.real != null) {
      realYieldByLeg[leg] = { nominal: ry.nominal, inflation_exp: ry.inflation_exp, real: ry.real };
    }
  }
  const pairKey = isXau ? 'XAUUSD' : legs.join('');
  const rt = retail?.positions?.[pairKey];
  const retailSnap = (rt && rt.long_pct != null)
    ? { long_pct: rt.long_pct, short_pct: rt.short_pct, signal: rt.signal ?? null }
    : null;
  const rrSnap = rrPair ? {
    rr_value: rrPair.rr_value ?? null,
    call_iv: rrPair.call_iv ?? null,
    put_iv: rrPair.put_iv ?? null,
    skew_change_pct: rrPair.skew_change_pct ?? null,
    vol_level: rrPair.vol_level ?? null,
    convexity: rrPair.convexity ?? null,
  } : null;
  const hasAny = Object.keys(cbByLeg).length || Object.keys(cotByLeg).length
    || Object.keys(realYieldByLeg).length || retailSnap || rrSnap
    || drivers?.dxy?.pct != null || drivers?.wti?.pct != null || risk?.regime;
  if (!hasAny) return null;
  return {
    v: 1,
    cb_bias: Object.keys(cbByLeg).length ? cbByLeg : null,
    cot: Object.keys(cotByLeg).length ? cotByLeg : null,
    retail: retailSnap,
    real_yields: Object.keys(realYieldByLeg).length ? realYieldByLeg : null,
    dxy: drivers?.dxy?.pct != null ? { level: drivers.dxy.level ?? null, pct: drivers.dxy.pct } : null,
    wti: drivers?.wti?.pct != null ? { level: drivers.wti.level ?? null, pct: drivers.wti.pct } : null,
    vix: risk?.vix ?? null,
    move: risk?.move ?? null,
    rr: rrSnap,
  };
}

// Ekstrak {dxy, wti, realYieldUsd, realYields} dari cache 'daily_snapshot'
// (correlations.js, action=daily-snapshot) + 'real_yields' (real-yields.js) — dipakai
// kedua caller _formatFundamentalBlock (ohlcvAnalyzeHandler & ohlcv_critic) supaya
// parsing tidak dobel-tulis. Fail-open per sumber: cache kosong/korup di salah satu
// tidak menghapus yang lain (pola sama dengan blok fundamental lain).
// realYields = peta LENGKAP semua currency di cache (EUR/GBP/JPY/CAD/AUD/NZD/CHF/USD),
// dipakai _formatFundamentalBlock untuk loop per-leg (2026-08-04). realYieldUsd tetap
// diekspor terpisah — alias realYields.USD, kompatibilitas caller lama.
function _extractMacroDrivers(rawSnap, rawRY) {
  let dxy = null, wti = null;
  try {
    if (rawSnap) {
      const snap = JSON.parse(rawSnap);
      dxy = snap?.drivers?.DXY || null;
      wti = snap?.drivers?.WTI || null;
    }
  } catch (e) { /* opsional */ }
  let realYields = null, realYieldUsd = null;
  try {
    if (rawRY) {
      realYields = JSON.parse(rawRY)?.currencies || null;
      realYieldUsd = realYields?.USD || null;
    }
  } catch (e) { /* opsional */ }
  return { dxy, wti, realYieldUsd, realYields };
}

// Session 157 lanjutan 7: konteks sentimen pasar options (CME CVOL) per pair, bahasa
// sederhana bukan istilah teknis mentah (skew/convexity) — supaya AI meneruskan
// dengan nada yang sama ke commentary, bukan sekadar dump angka jargon. 3 sinyal
// terpisah (lihat correlations.js untuk sumber field, dan diskusi kenapa 3 axis ini
// tidak saling redundant — level vs arah vs kelengkungan smile):
// 1. Arah + momentum sentimen (skew + skewPercentChange)
// 2. Level volatilitas yang diharapkan pasar (cvolPrice + %chg)
// 3. Antisipasi kejutan mendadak 2 arah sekaligus, independen dari arah (convexInd + %chg)
// Versi framing prompt CME-vs-COT (2026-08-08) — dipakai `_formatOptionsSentimentBlock`
// (implisit, lewat parameter `prioritized`) & direkam ke tiap setup auto-entry
// (`cme_priority_prompt_v` di buildNewSetupEntry, ohlcvAnalyzeHandler) supaya generasi
// data sebelum/sesudah perubahan framing bisa dibedakan tanpa nebak dari timestamp.
// Naikkan angka ini setiap kali TEKS framing di bawah direvisi lagi.
const COT_CME_PROMPT_VERSION = 1;

// ── AATAS — "Auto AI to Auto System" (2026-08-22) ─────────────────────────────
// Porting checklist SMC/ICT manual (index.html PB_REGIME_CHECK + PLAYBOOKS.smc_ict)
// ke jalur auto-entry, dengan 8 delta hasil rekonsiliasi dengan cara trading nyata
// user. Latar: audit 2026-08-21/22 menemukan win rate auto-entry anjlok 64% -> 25%
// dengan DUA pola mekanistik (bukan sekadar variasi statistik):
//   1. conflict='waktu' (AI menandai sendiri risiko event lalu tetap entry) -> 20% WR.
//   2. Fade-tren GC=F & CHF/JPY — short di tengah uptrend kuat karena "RSI overbought".
// Root cause: bias ditentukan dari TEKNIKAL dulu, makro cuma catatan kaki non-blocking.
// AATAS membalik urutannya: makro jadi GATE di depan, teknikal cuma presisi timing.
//
// ISOLASI (Opsi A plan AATAS, keputusan arsitektur wajib — dipilih & dicatat 2026-08-22):
// SELURUH blok ini HANYA aktif saat `isAutoCall === true`. Jalur manual publik ("Analisa
// AI") tetap memakai makro_alignment/confidence/Sistem Hakim/contradiction-guard APA
// ADANYA — dua tempat render badge "Keselarasan Makro" di index.html adalah fitur PUBLIK,
// mengganti field-nya = memutus fitur publik. Preseden pola karantina yang sama:
// framing CME-priority (`hasCmeData && isAutoCall`, 2026-08-08).
//
// Naikkan AATAS_PROMPT_VERSION setiap kali TEKS checklist di bawah direvisi — angka ini
// direkam per setup (`aatas_v`) supaya generasi prompt lama/baru bisa dibedakan tanpa
// menebak dari `ts`.
//
// v2 (2026-08-25) — AATAS v2 "Penegakan Kode": satu panggilan AI serba-ada dipecah jadi
// DUA panggilan ramping (Call 1 makro-only, Call 2 teknikal-only), AI Kritikus (Gate A)
// dibuang dari jalur auto, dan gate/skor/pilihan level TIDAK LAGI laporan bebas AI —
// ditegakkan/dihitung kode. Latar: 2 dari 4 setup live pertama v1 melanggar aturan v1
// sendiri (RSI 76.5 dipakai sebagai driver bearish XAU/USD; arah AUD/NZD dipinjam dari
// "struktur teknikal H4" padahal `strong_vs_weak:false`) — dua-duanya lolos karena
// larangan itu cuma imbauan teks di prompt.
const AATAS_PROMPT_VERSION = 2;

// Label verdict SENGAJA sama persis dengan ckGetVerdict() di index.html (checklist
// manual) — supaya angka checklist_pct/verdict auto-entry bisa dibandingkan langsung
// dengan jurnal manual user tanpa tabel penerjemah.
const AATAS_VERDICT_CANON = new Map([
  ['NOTRADE', 'NO TRADE'], ['NO TRADE', 'NO TRADE'],
  ['KONFLIKREVIEW', 'KONFLIK-REVIEW'], ['KONFLIK REVIEW', 'KONFLIK-REVIEW'], ['KONFLIK', 'KONFLIK-REVIEW'],
  ['PERTIMBANGKAN', 'PERTIMBANGKAN'],
  ['SIAPTRADE', 'SIAP TRADE'], ['SIAP TRADE', 'SIAP TRADE'],
  ['ENTRY', 'ENTRY'],
]);

// Anomali korelasi live yield-emas dari cache `correlations_v3` (api/correlations.js
// `gold_correlations.RealYield`). Ambang |r20-r60| > 0,4 = ambang anomali yang SUDAH
// tervalidasi & dipakai modul korelasi itu sendiri — bukan angka baru yang dikarang di
// sini (pelajaran 2026-08-16: jangan pakai r20 mentah harian sebagai pemicu, itu noise).
// Return null = TIDAK DIKETAHUI (cache kosong / seri RealYield tidak terhitung) — caller
// WAJIB memperlakukannya fail-open, bukan sebagai "tidak anomali".
function _goldYieldCorrAnomaly(corrData) {
  const ry = corrData && corrData.gold_correlations && corrData.gold_correlations.RealYield;
  if (!ry || ry.r20 == null || ry.r60 == null) return null;
  return Math.abs(ry.r20 - ry.r60) > 0.4;
}

// ── AATAS v2 (2026-08-25): checklist dipecah dua ──────────────────────────────
// v1 memakai SATU blok checklist Step 0-9 untuk satu panggilan AI yang melihat semua
// data. v2 memecahnya jadi dua blok yang dikirim ke dua panggilan berbeda, karena
// pemisahan DATA-nya (bukan cuma teksnya) yang bikin pelanggaran mustahil: Call 1
// tidak menerima satu byte pun data teknikal, jadi "RSI overbought" tidak bisa bocor
// ke driver fundamental walau modelnya ingin.
//
// Pembagian step: Call 1 = Step 0-3 (arah), Call 2 = Step 4-8 (lokasi, waktu, risiko,
// validasi akhir) + skor gabungan. Step 1-2 TIDAK cuma dinilai AI lagi — hasil
// laporannya ditegakkan ulang kode lewat `_evaluateAatasGate1`.
// Murni string-building (pure) supaya bisa diuji tanpa Redis/AI.

// Regex penegakan larangan indikator. Dipakai memindai teks driver+konfirmasi Call 1
// (kode, bukan imbauan) — kasus nyata yang ditutup: XAU/USD 2026-08-24 menyebut
// "RSI 76.5" sebagai alasan bearish di `fundamental_bias.driver`.
const AATAS_FORBIDDEN_INDICATOR_RE = /\b(RSI|MACD|SMA|EMA|pivot)\b/i;

// Blok checklist Call 1 — MAKRO SAJA (Step 0-3). Tidak menyebut chart sama sekali.
function _buildAatasMacroChecklistBlock({ label, isXau, goldCorr }) {
  const legs = String(label || '').toUpperCase().split('/').map(x => x.trim()).filter(Boolean);
  const legA = legs[0] || 'BASE', legB = legs[1] || 'QUOTE';
  const L = [];
  L.push('[CHECKLIST AATAS — BAGIAN 1 DARI 2: MAKRO/FUNDAMENTAL]');
  L.push('Tugasmu di sini HANYA menentukan ARAH dari makro/fundamental. Kamu SENGAJA tidak diberi data chart/indikator apa pun — lokasi & waktu masuk ditentukan di tahap terpisah setelah kamu selesai. DILARANG menyebut RSI, MACD, SMA, EMA, pivot, atau struktur chart sebagai alasan apa pun; teks yang menyebutnya akan otomatis ditolak kode dan setup dibatalkan.');
  L.push('GATE = wajib lolos penuh, tidak bisa ditawar: kalau gagal, TIDAK ADA setup. Bobot biasa = menyumbang skor persen, tidak menggagalkan sendirian.');
  L.push('');
  if (isXau) {
    L.push('STEP 0 REGIME CHECK (PRE-GATE, cabang XAU/USD):');
    L.push('- Real Yield + DXY + Risk Regime: nilai satu per satu apakah masing-masing mendukung emas NAIK (bullish), TURUN (bearish), atau netral. Ketiganya WAJIB sepakat (3/3) supaya arah makro dianggap bulat. Laporkan hasilnya di regime_check.gold (termasuk unanimous true/false).');
    const corrTxt = goldCorr && goldCorr.r20 != null && goldCorr.r60 != null
      ? `Korelasi live emas vs real yield saat ini: r20 ${goldCorr.r20.toFixed(2)} vs r60 ${goldCorr.r60.toFixed(2)} (selisih ${Math.abs(goldCorr.r20 - goldCorr.r60).toFixed(2)}) — status: ${goldCorr.anomaly ? 'ANOMALI (di luar ambang 0,4)' : 'NORMAL'}.`
      : 'Korelasi live emas vs real yield: data tidak tersedia saat ini.';
    L.push(`- Kalau TIDAK bulat 3/3: ${corrTxt} Korelasi NORMAL berarti Real Yield sendiri boleh jadi penentu arah, lanjut. Korelasi ANOMALI berarti TIDAK ENTRY sama sekali (satu-satunya hard-stop baru di Step 0), karena penentu tunggal yang tersisa sedang tidak bisa dipercaya.`);
    L.push('- Rate Path Fed implied (kalau ada di data di atas): konteks tambahan saja, TIDAK memblokir.');
    L.push('- Event high-impact <6 jam ke depan untuk USD/emas: TUNGGU sampai lewat (entry ditunda, ukuran risiko TIDAK dikecilkan) — set regime_check.event_wait=true dan jelaskan di conflict_note. Ini BUKAN alasan membatalkan tesis.');
    L.push('- COT & retail sentiment TIDAK dipakai di sini — dipindah ke Step 8 (catatan: laporan COT gold beda skema CFTC dari FX, jangan disamakan).');
  } else {
    L.push('STEP 0 REGIME CHECK (PRE-GATE):');
    L.push('- Regime saat ini (risk_on/neutral/elevated/risk_off) dari baris RISK REGIME.');
    L.push(`- CB Bias ${legA} dan ${legB} dari DUA sumber sekaligus: (a) bias resmi bank sentral di FUNDAMENTAL TERSTRUKTUR, dan (b) pembacaanmu sendiri atas data inflasi/GDP/tenaga kerja mentah di blok fundamental/konteks makro. Kalau dua sumber ini BERBEDA untuk leg yang sama, itu TIDAK memblokir — set regime_check.cb_source_conflict=true dan turunkan checklist_pct sedikit.`);
    L.push('- Event high-impact <6 jam ke depan untuk pair ini: TUNGGU sampai lewat (entry ditunda, ukuran risiko TIDAK dikecilkan) — set regime_check.event_wait=true dan jelaskan di conflict_note. Ini BUKAN alasan membatalkan tesis, dan BUKAN alasan mengecilkan size.');
    L.push('- Real yield differential TIDAK dipakai sebagai pre-gate di pair FX (hanya relevan untuk XAU/USD).');
    L.push('- COT & retail sentiment TIDAK dipakai di sini — dipindah ke Step 8.');
  }
  L.push('');
  L.push('STEP 1 VALIDITAS DRIVER (GATE): driver makro yang kamu pakai WAJIB (a) bukan asumsi pribadi, (b) punya bukti nyata — data rilis/statement resmi/event aktual yang ADA di konteks di atas, (c) bisa diverifikasi, (d) sudah mulai tercermin di harga, dan (e) dirumuskan TANPA kata "akan"/"harusnya"/"kemungkinan"/"biasanya". Kalau salah satu tidak terpenuhi: gate_validitas_driver.pass=false dan TIDAK ADA setup.');
  L.push('');
  L.push(`STEP 2 FUNDAMENTAL BIAS (GATE, bobot tinggi): ada driver utama yang jelas; ${legA} jelas menguat atau melemah; ${legB} kebalikannya; minimal 2 konfirmasi dari kategori berbeda (data ekonomi / kebijakan moneter / geopolitik-risk sentiment); tidak ada konflik antar faktor; pair ini strong-vs-weak (bukan strong-vs-strong atau weak-vs-weak). Arah hasil step inilah bias-mu, dan itu FINAL — tahap teknikal setelah ini TIDAK BOLEH mengubahnya.`);
  L.push(`- strong_vs_weak WAJIB kamu nilai sendiri, dan kode MEMERIKSA jawabannya: kalau kamu isi false, setup otomatis dibatalkan. Jangan mengisi true supaya "lolos" — isi apa adanya.`);
  L.push(`- SEBELUM menjawab strong_vs_weak, telusuri MEKANISME lintas-faktornya, jangan cuma membandingkan label bias bank sentral mentah. Dua mata uang bisa sama-sama berlabel "hawkish" tapi salah satunya relatif lebih kuat karena faktor lain: pair komoditas WAJIB dicek ke penggeraknya (CAD ke harga minyak/WTI, NOK ke minyak, AUD & NZD ke logam industri/produk susu dan selera risiko China, JPY & CHF ke arus safe haven, EUR ke differential suku bunga vs Fed) — pola yang sama seperti instruksi WTI -> ekspektasi inflasi -> real yield. Kalau angka penggeraknya ada di data di atas, sebut angkanya.`);
  L.push('- konfirmasi WAJIB minimal 2 item dari KATEGORI BERBEDA, masing-masing menyebut data konkret. Kode menghitung jumlahnya — kurang dari 2 berarti setup dibatalkan.');
  L.push('- Boleh memakai TREN DATA AKUMULATIF sebagai fakta terhitung (contoh: "3 dari 3 rilis data CAD terakhir meleset di bawah forecast") dan data pasar forward-looking RIIL kalau tersedia di atas (rate path). Yang tetap DILARANG: spekulasi ("akan"/"harusnya"/"kemungkinan"/"biasanya") tanpa angka di baliknya.');
  L.push('');
  L.push('STEP 3 PRE-MARKET DECISION: bias dikunci dan tidak berubah kecuali ada berita besar (market-moving/geopolitik/data ekonomi penting). Pembatalan karena berita besar SUDAH ditangani mekanisme kode terpisah (filter breaking-news + deteksi kejutan ekonomi actual-vs-forecast) — kamu cukup memastikan arahmu eksplisit.');
  L.push('');
  L.push('YANG BUKAN URUSANMU DI SINI (ditangani tahap/kode lain, jangan dinilai): struktur teknikal & lokasi entry, level SL/TP & risk/reward, posisi COT/retail, skor akhir checklist. Fokus penuh ke arah makro + buktinya.');
  return L.join('\n');
}

// Blok checklist Call 2 — TEKNIKAL SAJA (Step 4-5 + timing Step 7). Bias sudah dikunci
// Call 1 dan dikirim sebagai FAKTA; tugas panggilan ini cuma menilai apakah lokasi yang
// SUDAH dipilih kode layak dimasuki, atau pasar sedang tidak layak entry sama sekali.
function _buildAatasTechnicalChecklistBlock({ isXau, lockedBias }) {
  const L = [];
  L.push('[CHECKLIST AATAS — BAGIAN 2 DARI 2: STRUKTUR & LOKASI ENTRY]');
  L.push(`Arah trade SUDAH DIKUNCI dari analisa makro/fundamental: ${lockedBias.toUpperCase()}. Itu FAKTA yang TIDAK BOLEH kamu ubah, tawar, atau balik — tugasmu bukan menentukan arah, tapi menentukan DI MANA dan KAPAN masuk (dan apakah struktur mengizinkan masuk sama sekali).`);
  L.push('INDIKATOR MOMENTUM DIBUANG: pembacaan RSI dan MACD sengaja TIDAK dikirim ke kamu, dan DILARANG dipakai sebagai alasan apa pun — "RSI overbought/oversold" sebagai alasan melawan tren adalah penyebab langsung rentetan kerugian sistem ini sebelumnya. SMA dan pivot boleh dipakai sebagai LEVEL HARGA struktural (setara cluster S/R), TIDAK PERNAH sebagai sinyal arah atau momentum.');
  L.push('GATE = wajib lolos penuh, tidak bisa ditawar: kalau gagal, TIDAK ADA setup (entry_zone/sl/tp/entry_basis = null). Bobot biasa = menyumbang skor persen, tidak menggagalkan sendirian.');
  L.push('');
  L.push('STEP 4 STRUKTUR TEKNIKAL (bobot tinggi): arah teknikal WAJIB sejalan dengan bias terkunci; ada Break of Structure (BOS)/shift; market tidak dalam ranging sempit; ada area jelas (supply-demand / cluster S/R). Konteks likuiditas (equal highs/lows, stop hunt/sweep) boleh disebut sebagai sinyal TAMBAHAN dengan bobot LEBIH RENDAH dari BOS/S-R — jangan pernah menjadikannya satu-satunya alasan entry.');
  if (isXau) L.push('- Tambahan XAU/USD: option expiry/volume sebagai lapis konfirmasi, dan sentimen options CME (kalau ada di atas) sebagai pemanis konfirmasi — TIDAK PERNAH jadi penentu sendiri.');
  L.push('- Kalau struktur teknikal jelas BERLAWANAN dengan bias terkunci, atau pasar ranging sempit: JANGAN membalik bias dan JANGAN memaksakan setup. Set entry_zone/sl/tp null, verdict "NO TRADE", dan jelaskan kondisi yang ditunggu di trigger.');
  L.push('');
  L.push('STEP 5 ENTRY LOCATION + TRIGGER: entry HANYA di area valid (pullback/retest/liquidity sweep), bukan di tengah impuls. Fibonacci dipakai sebagai ZONA 0,382-0,618, bukan titik tunggal 0,618: tren KUAT (BOS bermomentum kuat) berarti retracement dangkal, condong ke 0,382; tren LEMAH/ranging berarti retracement dalam, condong ke 0,618; kalau kekuatan tren AMBIGU, pakai titik tengah zona (~0,5). Wajib ada konfirmasi candle di trigger.');
  L.push('');
  L.push('STEP 6 RISK MANAGEMENT (GATE): RR minimal 1:2 (ideal 1:3 ke atas) dan SL di balik struktur (bukan angka random). Risiko per entry FLAT 2% tanpa pengecualian kondisi apa pun — konflik/keraguan TIDAK PERNAH mengecilkan ukuran posisi, itu hanya alarm perhatian. Kalau RR di bawah 1:2 atau SL tidak punya dasar struktural: gate_risk_management.pass=false dan TIDAK ADA setup.');
  L.push('');
  L.push('STEP 7 TIMING: utamakan sesi London/New York; hindari sesi Tokyo kecuali setup sangat jelas; jangan entry berdempetan dengan rilis high-impact. Event high-impact di dalam horizon skenario = CHECKPOINT tesis (laporkan di conflict="waktu"), BUKAN alasan otomatis membatalkan setup atau mengecilkan ukuran posisi.');
  L.push('');
  L.push('STEP 8 VALIDASI TERAKHIR (bobot RENDAH): COT selaras + retail sentiment kontrarian tidak melawan arah. Kalau tidak selaras, ini TIDAK PERNAH menggagalkan setup — hanya menurunkan checklist_pct sedikit.');
  L.push('');
  L.push('STEP 9 DISIPLIN: urusan setelah entry (manajemen posisi berjalan), BUKAN syarat sebelum entry — tidak dinilai di sini.');
  L.push('');
  L.push('YANG BUKAN URUSANMU DI SINI: arah/bias (sudah dikunci Step 0-2 dan sudah diverifikasi kode) dan penilaian ulang fundamental. Kalau kamu merasa fundamentalnya lemah, itu bukan alasan membalik arah — sampaikan di conflict/commentary.');
  return L.join('\n');
}

// Buang baris indikator murni dari teks DATA TEKNIKAL sebelum dikirim ke Call 2.
// v1 sudah melarang RSI/MACD/SMA/pivot memengaruhi keputusan lewat teks prompt, dan
// justru larangan itu yang dilanggar — jadi di v2 datanya tidak dikirim sama sekali,
// bukan cuma dilarang dipakai. Bonus: prompt Call 2 ikut mengecil.
// BATASNYA — yang dibuang HANYA baris yang menyajikan indikator sebagai PEMBACAAN
// MOMENTUM ("RSI 76.5 overbought", "MACD bullish crossover"): itu bentuk yang dipakai
// untuk melawan tren, dan itulah penyebab langsung rentetan kerugian sistem ini.
// Yang TETAP dikirim adalah baris yang menyajikan LEVEL HARGA struktural (pivot harian,
// prev day/week H-L, S/R, fibonacci) — termasuk nama struktur penyusun [ZONA KONFLUENSI]/
// [KANDIDAT SL/TP] yang masih bisa menyebut "SMA50 Daily"/"pivot S1" sebagai asal-usul
// angka. Dua alasannya: (1) level bukan sinyal arah, dan arah di v2 sudah dikunci Call 1
// sebelum panggilan ini ada; (2) instruksi pemilihan entry/SL/TP yang dipakai BERSAMA
// jalur manual memang merujuk level-level itu — menyensor datanya sambil tetap menyuruh
// AI memilih darinya cuma menghasilkan prompt yang menunjuk data yang tidak ada.
function _stripIndicatorLines(text) {
  if (typeof text !== 'string' || !text) return '';
  const DROP = ['[INDIKATOR Daily]', '[MACD H4', '[RSI-14 H4]'];
  return text.split('\n').filter(line => !DROP.some(p => line.startsWith(p))).join('\n');
}

// Normalisasi field AATAS dari jawaban model (pure, dipakai hanya di jalur isAutoCall).
// Prinsip sama seluruh normalisasi lain di handler ini: model tidak patuh skema ->
// null, JANGAN dipaksa ke satu nilai (nilai keliru mencemari data evaluasi lebih parah
// daripada nilai kosong). Tidak melempar apa pun — dipanggil di dalam try parse.
function _normalizeAatasFields(structured) {
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const str = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
  const gate = v => {
    const o = obj(v);
    if (!o) return null;
    return { pass: (o.pass === true || o.pass === false) ? o.pass : null, note: str(o.note) };
  };
  const pctRaw = Number(structured.checklist_pct);
  const verdictRaw = String(structured.verdict || '').toUpperCase().replace(/[^A-Z ]/g, '').trim().replace(/\s+/g, ' ');
  return {
    regime_check: obj(structured.regime_check),
    gate_validitas_driver: gate(structured.gate_validitas_driver),
    gate_risk_management: gate(structured.gate_risk_management),
    fundamental_bias: obj(structured.fundamental_bias),
    technical: obj(structured.technical),
    final_validation: obj(structured.final_validation),
    checklist_pct: Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, Math.round(pctRaw))) : null,
    verdict: AATAS_VERDICT_CANON.get(verdictRaw) || AATAS_VERDICT_CANON.get(verdictRaw.replace(/ /g, '')) || null,
    reasoning_note: str(structured.reasoning_note),
  };
}

// AATAS Step 0 cabang XAU/USD: "Rate Path Fed implied" sebagai konteks tambahan
// (non-blocking, sesuai plan). Datanya SUDAH ada di cache `rate_path` (api/rate-path.js)
// tapi selama ini hanya dipakai Ringkasan (market-digest.js) — tidak pernah sampai ke
// prompt analisa per-pair. Formatter pure, pola sama _formatOptionsSentimentBlock.
// Return '' kalau data tidak ada (fail-open, jangan bikin blok kosong di prompt).
function _formatRatePathBlock(ratePathData) {
  const rp = ratePathData && ratePathData.USD;
  if (!rp || rp.cumulative_3m_bps == null) return '';
  const arah = bps => bps < 0 ? `${Math.abs(bps)}bps PEMANGKASAN sudah diharga`
    : bps > 0 ? `${bps}bps KENAIKAN sudah diharga` : 'tidak ada perubahan diharga';
  const parts = [`3 bulan: ${arah(rp.cumulative_3m_bps)}`];
  if (rp.cumulative_6m_bps != null) parts.push(`6 bulan: ${arah(rp.cumulative_6m_bps)}`);
  return `RATE PATH FED (implied dari pasar suku bunga — konteks tambahan untuk emas, BUKAN penentu arah sendiri; ekspektasi pemangkasan biasanya menekan real yield dan mendukung emas, kenaikan sebaliknya):
${parts.join(' | ')}`;
}

// Apakah satu entri setup termasuk POPULASI AATAS (arsitektur macro-first)?
// Urutan sumber: `policy_v` (fakta yang direkam) -> `policy_v_est` (kalau caller sudah
// mendekorasi) -> rekonstruksi dari `ts`. Entri yang tidak bisa ditentukan versinya
// (ts korup) dianggap BUKAN populasi AATAS — jangan menebak keanggotaan populasi.
function _isAatasEpochSetup(s) {
  if (!s) return false;
  const v = s.policy_v != null ? s.policy_v
    : (s.policy_v_est != null ? s.policy_v_est : policyVersionForTs(s.ts));
  return typeof v === 'number' && v >= AATAS_EPOCH;
}

// ── AATAS v2: penegakan kode atas laporan AI (semua pure, dites unit) ─────────

// GATE Step 1+2 versi v2. `pass` FINAL = laporan AI **DAN** tiga pemeriksaan kode.
// Alasan gate keras (bukan pengurangan skor) sudah didebat & diputuskan: kasus nyata
// AUD/NZD 2026-08-24 punya score_pct 55 — pengurangan poin tetap menyisakan verdict
// "PERTIMBANGKAN" dan setup tetap lahir; hanya gate keras yang menutup polanya.
//
// `override_reason` != null berarti KODE yang menggagalkan (AI-nya sendiri lapor lolos
// atau diam) — dibedakan dari kegagalan yang AI akui sendiri, supaya counter
// observability `auto_guard_stats:gate1_code_override` mengukur ketatnya ATURAN INI,
// bukan kejujuran modelnya.
//
// Fail-CLOSED kalau `fundamental_bias` tidak ada sama sekali — beda sengaja dari
// fail-open v1: di v2 seluruh tugas Call 1 adalah menghasilkan objek ini, jadi
// ketiadaannya berarti panggilan itu gagal, bukan "model tidak menilai".
function _evaluateAatasGate1({ fundamental_bias, aiPass }) {
  if (aiPass === false) return { pass: false, override_reason: null };
  const fb = (fundamental_bias && typeof fundamental_bias === 'object' && !Array.isArray(fundamental_bias)) ? fundamental_bias : null;
  if (!fb) return { pass: false, override_reason: 'fundamental_bias_kosong' };
  if (fb.strong_vs_weak !== true) return { pass: false, override_reason: 'strong_vs_weak_bukan_true' };
  const konfirmasi = Array.isArray(fb.konfirmasi)
    ? fb.konfirmasi.filter(x => typeof x === 'string' && x.trim())
    : [];
  if (konfirmasi.length < 2) return { pass: false, override_reason: 'konfirmasi_kurang_dari_2' };
  const teks = [typeof fb.driver === 'string' ? fb.driver : '', ...konfirmasi].join(' ');
  if (AATAS_FORBIDDEN_INDICATOR_RE.test(teks)) return { pass: false, override_reason: 'indikator_teknikal_di_driver' };
  return { pass: true, override_reason: null };
}

// Pisahkan bagian JSON dan bagian prosa dari jawaban dua-bagian model (pure).
// Diekstrak dari jalur parse tunggal v1 supaya dipakai ulang oleh Call 1 & Call 2 —
// delimiter yang sama menjaga prosa keluar dari string JSON (akar QUAL-14 dulu).
function _splitJsonCommentary(rawText) {
  const DELIM = '===COMMENTARY===';
  const s = typeof rawText === 'string' ? rawText : '';
  const idx = s.indexOf(DELIM);
  const jsonPart = idx !== -1 ? s.slice(0, idx) : s;
  const prose = idx !== -1 ? s.slice(idx + DELIM.length).trim() : null;
  const jsonStart = jsonPart.indexOf('{');
  const jsonEnd = jsonPart.lastIndexOf('}');
  const cleaned = (jsonStart !== -1 && jsonEnd !== -1)
    ? jsonPart.slice(jsonStart, jsonEnd + 1)
    : jsonPart.replace(/```(?:json)?/gi, '').trim();
  return { jsonText: cleaned, commentary: prose || null };
}

// Keputusan "setup ini boleh lahir atau tidak" versi AATAS — pure & deterministik di
// KODE, bukan cuma imbauan di prompt (kriteria selesai plan AATAS: delta wajib ter-wire
// ke prompt DAN/ATAU logika gate kode). Return alasan (string) kalau setup harus
// dibatalkan, null kalau boleh lanjut. Fail-open: gate yang TIDAK dilaporkan model
// (null) tidak memblokir — pola sama seluruh guard lain di codebase ini.
// v2: `gate1Override` membedakan "KODE yang menggagalkan Step 1-2" dari "AI sendiri
// yang lapor gagal". Bedanya penting: satu mengukur ketatnya aturan baru, satunya
// mengukur kejujuran model — kalau dilebur jadi satu label, data itu hilang dan
// pertanyaan "apakah gate ini kelewat ketat?" tidak bisa dijawab dari log nanti.
function _aatasRejectReason({ gate_validitas_driver, gate_risk_management, verdict, goldBlocked, gate1Override }) {
  if (goldBlocked) return 'gold_regime_split_corr_anomali';
  if (gate1Override) return `gate_validitas_driver_kode:${gate1Override}`;
  if (gate_validitas_driver && gate_validitas_driver.pass === false) return 'gate_validitas_driver';
  if (gate_risk_management && gate_risk_management.pass === false) return 'gate_risk_management';
  if (verdict === 'NO TRADE') return 'verdict_no_trade';
  return null;
}

// Satu panggilan DeepSeek untuk jalur Analisa (manual 1x, AATAS v2 auto 2x). Diekstrak
// dari blok fetch inline v1 supaya tiga pemanggil memakai jalur circuit-breaker/budget/
// timeout yang SAMA — dulu tiap blok menyalin logikanya sendiri dan gampang divergen.
// Config default = config PERSIS jalur manual produksi (max_tokens 1500, timeout 25s,
// pool publik) — jangan diubah tanpa sadar, itu mengubah fitur publik.
async function _callDeepSeekAnalyze(messages, {
  maxTokens = 1500, timeoutMs = 25000, cbKey = 'ai:deepseek', budgetKey = 'deepseek',
  modelName = 'deepseek-v4-flash', tag = 'ohlcv_analyze',
} = {}) {
  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_KEY) return { rawText: null, model: null, error: 'no_key', elapsedMs: null };
  if (!await cb.canCall(cbKey)) {
    console.log(`${tag}: DeepSeek circuit OPEN (${cbKey})`);
    return { rawText: null, model: null, error: 'circuit_open', elapsedMs: null };
  }
  const t0 = Date.now();
  try {
    if (!await allowAiCall(budgetKey)) throw new Error('AI daily budget exceeded');
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({ model: modelName, messages, max_tokens: maxTokens, temperature: 0, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const errJ = await r.json().catch(() => ({}));
      throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
    }
    const j = await r.json();
    const rawText = j.choices?.[0]?.message?.content?.trim() || null;
    if (!rawText) throw new Error('Empty response');
    // Deteksi output kepotong (2026-08-18, audit kinerja): urutan output = JSON dulu,
    // lalu prosa — kalau kena batas max_tokens yang hilang justru EKOR prosa, jadi JSON
    // tetap valid dan tidak ada tanda apa pun bahwa narasinya terputus. Warn-only.
    if (j.choices?.[0]?.finish_reason === 'length') {
      console.warn(`${tag}: output KEPOTONG di batas max_tokens (finish_reason=length) — prosa kemungkinan terputus`);
    }
    await cb.onSuccess(cbKey);
    return { rawText, model: modelName, error: null, elapsedMs: Date.now() - t0 };
  } catch (e) {
    console.warn(`${tag}: DeepSeek gagal:`, e.message);
    await cb.onFailure(cbKey);
    return { rawText: null, model: null, error: e.message, elapsedMs: Date.now() - t0 };
  }
}

// ── AATAS v2: pipeline dua panggilan untuk jalur `isAutoCall` ─────────────────
// Call 1 = makro/fundamental. Menerima NOL data teknikal — itulah fix strukturalnya:
// "RSI overbought" tidak bisa bocor ke `fundamental_bias.driver` walau modelnya ingin,
// karena angkanya memang tidak pernah sampai ke sana.
// Call 2 = struktur & lokasi entry, dengan bias Call 1 masuk sebagai FAKTA terkunci.
//
// Call 2 TIDAK dipanggil kalau Gate 1 gagal (short-circuit) — itu penghematannya:
// kandidat yang sudah pasti mati tidak pernah membayar panggilan kedua.
//
// LINGKUP yang SENGAJA TIDAK diambil (keputusan user 2026-08-25, saat plan AATAS v2
// ditinjau ulang sebelum eksekusi): pemilihan level oleh kode, Gate 6 & checklist_pct
// dihitung kode, Step 8 mekanis, dan penghapusan AI Kritikus. Semuanya TIDAK menutup
// dua pelanggaran yang jadi latar plan ini (dua-duanya di lapisan fundamental), dan
// masing-masing memperkenalkan konstanta/heuristik baru yang belum tervalidasi. Call 2
// karena itu tetap memilih level dari menu deterministik seperti v1, dan seluruh
// jaring pengaman hilir (snap ke [KANDIDAT SL/TP], sanity-check arah & RR, Gate A/B/D)
// dipakai APA ADANYA — jalur ini menghasilkan objek `parsed` dengan bentuk yang sama
// persis seperti jawaban satu-panggilan v1, lalu menyerahkannya ke logika hilir yang
// sudah ada. Jangan menduplikasi logika itu di sini.
//
// Return:
//   { parsed, commentary, model, gate1, prompts, error }
//   parsed = objek gabungan Call 1 + Call 2 (null kalau Call 1 gagal total — perilaku
//            sama seperti kegagalan AI tunggal di v1: tidak ada setup untuk siklus itu)
//   gate1  = { pass, override_reason } hasil penegakan kode atas Step 1-2
async function _runAatasTwoCall({
  label, isXau, macroParts, technicalParts, goldCorrLive, levelInstrs, invalidationTail, aiCfg,
}) {
  const prompts = { call1: null, call2: null };

  // ── Call 1: makro/fundamental ──────────────────────────────────────────────
  const call1Sys = 'Kamu analis makro/fundamental senior. Kamu HANYA menerima data makro — TIDAK ADA data chart, candle, atau indikator sama sekali, dan lokasi entry bukan urusanmu. WAJIB jawab dalam DUA bagian: (1) SATU objek JSON valid tanpa markdown fence berisi HANYA field {"regime_check":{...},"gate_validitas_driver":{"pass":true,"note":"..."},"fundamental_bias":{...},"bias":"..."}; (2) setelah JSON, baris berisi PERSIS "===COMMENTARY===", lalu SATU paragraf prosa (bukan JSON, bebas tanda kutip). Bahasa Indonesia.';
  const call1User = [
    `Analisa MAKRO/FUNDAMENTAL ${label}:`,
    '',
    macroParts.filter(Boolean).join('\n\n'),
    '',
    _buildAatasMacroChecklistBlock({ label, isXau, goldCorr: goldCorrLive }),
    '',
    'Isi field JSON berikut:',
    '- regime_check: hasil Step 0 sebagai objek — {"regime":"risk_on|neutral|elevated|risk_off" atau null, "cb_bias":{"<LEG>":"hawkish|dovish|netral"} untuk kedua leg pair (null kalau tidak ada data), "cb_source_conflict":true/false (bias resmi bank sentral vs pembacaanmu atas data mentah berbeda), "event_wait":true/false, "event_note":"..." atau null, "gold":null untuk pair FX}. Khusus XAU/USD, "gold" WAJIB diisi {"real_yield":"bullish|bearish|netral","dxy":"bullish|bearish|netral","risk_regime":"bullish|bearish|netral","unanimous":true/false} — ketiganya dinilai dari sudut pandang EMAS (bullish = mendukung emas naik). Isi apa adanya dari data di atas, jangan mengarang angka yang tidak dikirim.',
    '- gate_validitas_driver: hasil GATE Step 1 — {"pass":true/false,"note":"satu kalimat, sebut driver + buktinya"}. false kalau driver tidak punya bukti nyata di data, tidak bisa diverifikasi, belum tercermin di harga, atau cuma bisa dirumuskan dengan kata "akan/harusnya/kemungkinan/biasanya".',
    '- fundamental_bias: hasil Step 2 — {"score_pct":0-100,"arah":"bullish|bearish|netral","driver":"...","konfirmasi":["...","..."],"konflik":"..." atau null,"strong_vs_weak":true/false}. konfirmasi minimal 2 item dari kategori berbeda, masing-masing menyebut data konkret.',
    '- bias: ARAH AKHIR hasil Step 0-2 — bullish/bearish/neutral/mixed, MURNI dari makro/fundamental. Pakai "neutral" kalau fundamental memang tidak punya arah, "mixed" kalau faktor-faktornya saling bertabrakan. DILARANG menyebut atau memakai RSI/MACD/SMA/EMA/pivot/struktur chart sebagai alasan di field manapun.',
    '',
    'Setelah objek JSON, di baris baru tulis PERSIS "===COMMENTARY===" lalu tulis SATU paragraf ringkas (3-5 kalimat) sebagai teks biasa: kenapa tiap step dinilai begitu, dengan angka konkret. WAJIB diisi — paragraf inilah satu-satunya jejak naratif makro untuk audit nanti.',
  ].join('\n');
  prompts.call1 = { system: call1Sys, user: call1User };

  const r1 = await _callDeepSeekAnalyze(
    [{ role: 'system', content: call1Sys }, { role: 'user', content: call1User }],
    { ...aiCfg, maxTokens: 900, tag: 'aatas_call1' },
  );
  if (!r1.rawText) return { parsed: null, commentary: null, model: null, gate1: null, prompts, error: r1.error };

  let p1 = null, macroNote = null;
  try {
    const split = _splitJsonCommentary(r1.rawText);
    p1 = JSON.parse(split.jsonText);
    macroNote = split.commentary;
  } catch (e) {
    console.warn('AATAS: Call 1 JSON parse gagal:', e.message);
    return { parsed: null, commentary: null, model: r1.model, gate1: null, prompts, error: 'call1_parse_gagal' };
  }

  const fb = (p1.fundamental_bias && typeof p1.fundamental_bias === 'object' && !Array.isArray(p1.fundamental_bias))
    ? p1.fundamental_bias : null;
  const aiGate1 = (p1.gate_validitas_driver && typeof p1.gate_validitas_driver === 'object')
    ? p1.gate_validitas_driver : null;
  const gate1 = _evaluateAatasGate1({
    fundamental_bias: fb,
    aiPass: (aiGate1 && (aiGate1.pass === true || aiGate1.pass === false)) ? aiGate1.pass : null,
  });
  // Laporan gate yang tersimpan = hasil FINAL (kode), dengan jejak siapa yang
  // menggagalkan. Laporan asli AI tidak dibuang — ikut di note supaya perbedaan
  // "AI bilang lolos tapi kode menolak" bisa dibaca lagi dari log, bukan ditebak.
  const gate1Field = {
    pass: gate1.pass,
    note: gate1.override_reason
      ? `[OVERRIDE KODE] ${gate1.override_reason} — laporan AI: ${(aiGate1 && aiGate1.note) || 'tidak ada'}`
      : ((aiGate1 && aiGate1.note) || null),
  };

  const biasRaw = String(p1.bias || '').toLowerCase().replace(/[^a-z]/g, '');
  const lockedBias = ['bullish', 'bearish', 'neutral'].includes(biasRaw)
    ? biasRaw
    : (['mixed', 'conflicting', 'campuran', 'konflik'].includes(biasRaw) ? 'mixed' : 'neutral');

  // Bentuk jawaban gabungan — sengaja SAMA PERSIS dengan skema jawaban satu-panggilan
  // v1, supaya seluruh logika hilir (normalisasi, gate, penulisan setup_log) tidak
  // perlu tahu bahwa sumbernya sekarang dua panggilan.
  const base = {
    bias: lockedBias,
    regime_check: p1.regime_check ?? null,
    gate_validitas_driver: gate1Field,
    fundamental_bias: fb,
    entry_zone: null, entry_basis: null, sl: null, tp: null,
    trigger: null, invalidation_condition: null, invalidation_trigger: null,
    time_horizon_days: null,
    technical: null, gate_risk_management: null, final_validation: null,
    conflict: 'none', conflict_note: null,
    checklist_pct: null, verdict: null,
    reasoning_note: macroNote,
  };

  // Short-circuit: Gate 1 gagal -> Call 2 TIDAK dipanggil sama sekali. Verdict dipaksa
  // NO TRADE di sini (bukan menunggu penilaian AI yang tidak akan pernah datang), dan
  // seluruh field makro tetap terisi supaya alasan penolakannya tersimpan utuh.
  if (!gate1.pass) {
    base.verdict = 'NO TRADE';
    base.checklist_pct = fb && Number.isFinite(Number(fb.score_pct))
      ? Math.min(45, Math.max(0, Math.round(Number(fb.score_pct))))
      : null;
    return { parsed: base, commentary: macroNote, model: r1.model, gate1, prompts, error: null };
  }

  // ── Call 2: struktur & lokasi entry ────────────────────────────────────────
  const call2Sys = 'Kamu analis struktur pasar. Arah trade SUDAH DIKUNCI oleh analisa makro terpisah dan TIDAK BOLEH kamu ubah — tugasmu menentukan DI MANA dan KAPAN masuk, plus menilai apakah struktur mengizinkan masuk sama sekali. Kamu sengaja TIDAK menerima pembacaan momentum RSI/MACD, dan DILARANG memakainya sebagai alasan; SMA/pivot boleh dipakai hanya sebagai level harga struktural, tidak pernah sebagai sinyal arah. WAJIB jawab dalam DUA bagian: (1) SATU objek JSON valid tanpa markdown fence berisi HANYA field {"entry_zone":"...","entry_basis":"...","sl":"...","tp":"...","trigger":"...","invalidation_condition":"...","invalidation_trigger":{"type":"...","level":0,"timeframe":"...","direction":"..."},"time_horizon_days":0,"technical":{...},"gate_risk_management":{"pass":true,"note":"..."},"final_validation":{...},"conflict":"...","conflict_note":"...","checklist_pct":0,"verdict":"..."} — invalidation_trigger boleh null kalau tidak bisa distrukturkan; (2) setelah JSON, baris berisi PERSIS "===COMMENTARY===", lalu SATU paragraf prosa (bukan JSON, bebas tanda kutip). Bahasa Indonesia.';
  const call2User = [
    `Tentukan lokasi & waktu entry ${label}:`,
    '',
    '[HASIL ANALISA MAKRO — FAKTA TERKUNCI, TIDAK BOLEH DIUBAH ATAU DIBALIK]',
    `Arah (bias): ${lockedBias.toUpperCase()}`,
    fb && fb.driver ? `Driver utama: ${fb.driver}` : null,
    fb && Number.isFinite(Number(fb.score_pct)) ? `Skor fundamental (Step 2): ${Math.round(Number(fb.score_pct))}%` : null,
    'GATE Step 1 (validitas driver) dan Step 2 (fundamental bias): SUDAH LOLOS, diverifikasi kode.',
    macroNote ? `Ringkasan penilaian makro: ${macroNote}` : null,
    '',
    technicalParts.filter(Boolean).join('\n\n'),
    '',
    _buildAatasTechnicalChecklistBlock({ isXau, lockedBias }),
    '',
    'Isi field JSON berikut:',
    ...(Array.isArray(levelInstrs) ? levelInstrs : []),
    '- trigger: SATU kondisi price action spesifik yang HARUS terpenuhi sebelum entry — utamakan konfirmasi berbasis candle/pola di level konkret (misal "tunggu candle H4 close di bawah 1.1710" atau "tunggu rejection/pin bar H1 di area 3340"). Jangan sebut dua kondisi alternatif yang saling kontradiksi relatif ke harga sekarang. Manfaatkan [POLA CANDLE terdeteksi] kalau relevan.',
    '- invalidation_condition: kondisi spesifik yang membatalkan skenario ini sepenuhnya (beda dari sl — ini soal struktur/tesis).',
    '- invalidation_trigger: versi TERSTRUKTUR dari invalidation_condition supaya KODE bisa mendeteksinya otomatis — {"type":"ma_break"|"price_level"|"swing_break","level":<satu angka>,"timeframe":"1h"|"4h"|"1d","direction":"above"|"below"}. "level" WAJIB satu angka konkret yang ADA di data di atas, "direction" = arah CLOSE candle yang membatalkan skenario. Kalau tidak bisa diringkas jadi satu level tunggal, set null — JANGAN mengarang angka.' + (invalidationTail || ''),
    '- time_horizon_days: estimasi jumlah hari realistis skenario ini main out (angka, misal 3, 5, 10) berdasarkan jarak entry-tp dibanding rata-rata gerak harian (ATR/sigma) di data.',
    '- technical: hasil Step 4-5 — {"score_pct":0-100,"bos":"ada|lemah|tidak ada","area":"level/zona yang dipakai + angkanya","fib_zone":"angka level fib yang dipakai","fib_reason":"kenapa dangkal (~0,382) / dalam (~0,618) / tengah (~0,5), dikaitkan ke kekuatan BOS","liquidity_context":"..." atau null,"ranging":true/false}. liquidity_context bobotnya LEBIH RENDAH dari BOS/S-R.',
    '- gate_risk_management: hasil GATE Step 6 — {"pass":true/false,"note":"sebut RR aktual dan dasar struktural SL"}. false kalau RR di bawah 1:2 atau SL tidak berpijak struktur. Risiko per entry selalu flat 2%, jangan pernah mengusulkan mengecilkan size.',
    '- final_validation: hasil Step 8 (bobot RENDAH, non-blocking) — {"cot":"searah|melawan|tidak tersedia","retail":"searah|melawan|netral|tidak tersedia","efek":"kalimat singkat pengaruhnya ke checklist_pct"}. Ini TIDAK PERNAH boleh menggagalkan setup.',
    '- conflict: "waktu" kalau ada event high-impact relevan yang jatuh sebelum skenario selesai (termasuk event <6 jam yang bikin entry ditunda) — ini yang paling sering terjadi dan WAJIB dilaporkan jujur. "arah" HANYA kalau kamu tetap mengeluarkan setup padahal struktur berlawanan dengan bias terkunci (seharusnya tidak pernah terjadi — kalau terjadi, laporkan apa adanya, jangan disamarkan jadi "none"). "none" kalau tidak ada keduanya.',
    '- conflict_note: SATU kalimat pendek alasan konkret (sebut data/event spesifik) kalau conflict bukan "none"; null kalau "none".',
    '- checklist_pct: skor akhir gabungan seluruh step dalam persen (angka bulat 0-100), tertimbang: GATE (Step 1 & 6) bobot dua kali lipat, Step 2 & 4-5 bobot tinggi, Step 8 bobot rendah. Step 1 & 2 sudah lolos dengan skor fundamental yang disebut di atas — pakai angka itu apa adanya, jangan menilai ulang makro.',
    '- verdict: label akhir dari checklist_pct + status gate, salah satu PERSIS: "NO TRADE" (di bawah 50% atau GATE Step 6 gagal atau struktur tidak mengizinkan), "KONFLIK-REVIEW" (skor cukup tapi ada konflik arah yang belum selesai), "PERTIMBANGKAN" (50-74%), "SIAP TRADE" (75-89%), "ENTRY" (90% ke atas). "NO TRADE" berarti setup TIDAK dikeluarkan (entry_zone/sl/tp null).',
    '',
    'Setelah objek JSON, di baris baru tulis PERSIS "===COMMENTARY===" lalu tulis SATU paragraf ringkas (3-5 kalimat, minimal 2 angka konkret) sebagai teks biasa tentang struktur, lokasi entry, dan risiko utamanya.',
  ].filter(x => x !== null).join('\n');
  prompts.call2 = { system: call2Sys, user: call2User };

  const r2 = await _callDeepSeekAnalyze(
    [{ role: 'system', content: call2Sys }, { role: 'user', content: call2User }],
    { ...aiCfg, maxTokens: 900, tag: 'aatas_call2' },
  );
  if (!r2.rawText) {
    // Call 2 gagal = tidak ada yang pernah memeriksa struktur/lokasi. Menyimpan setup
    // tanpa itu lebih buruk daripada tidak ada setup — verdict dipaksa NO TRADE, tapi
    // seluruh hasil Call 1 tetap dikembalikan supaya siklusnya tidak hilang tanpa jejak.
    base.verdict = 'NO TRADE';
    base.gate_risk_management = { pass: null, note: 'Call 2 (struktur & lokasi) gagal — tidak ada penilaian teknikal untuk siklus ini' };
    return { parsed: base, commentary: macroNote, model: r1.model, gate1, prompts, error: r2.error };
  }

  let p2 = null, techNote = null;
  try {
    const split2 = _splitJsonCommentary(r2.rawText);
    p2 = JSON.parse(split2.jsonText);
    techNote = split2.commentary;
  } catch (e) {
    console.warn('AATAS: Call 2 JSON parse gagal:', e.message);
    base.verdict = 'NO TRADE';
    base.gate_risk_management = { pass: null, note: 'Jawaban Call 2 tidak bisa diparse — tidak ada penilaian teknikal untuk siklus ini' };
    return { parsed: base, commentary: macroNote, model: r1.model, gate1, prompts, error: 'call2_parse_gagal' };
  }

  // Gabung: field Call 2 menimpa placeholder, KECUALI yang milik Call 1 (bias, gate 1,
  // fundamental_bias, regime_check) — urutannya sengaja begini supaya Call 2 tidak bisa
  // membalik arah lewat field yang tidak diminta darinya.
  const parsed = {
    ...base, ...p2,
    bias: base.bias,
    regime_check: base.regime_check,
    gate_validitas_driver: base.gate_validitas_driver,
    fundamental_bias: base.fundamental_bias,
    reasoning_note: [macroNote, techNote].filter(Boolean).join(' ') || null,
  };
  return { parsed, commentary: parsed.reasoning_note, model: r1.model, gate1, prompts, error: null };
}

// Ringkasan satu-dua baris hasil checklist AATAS untuk fact sheet AI Kritikus (Gate A).
// Sengaja padat: Kritikus sudah menerima blok fundamental/COT/CME/kalender lengkap di
// bawahnya — yang belum dia punya cuma HASIL PENILAIAN step-nya sendiri.
function _formatAatasCriticLine(structured) {
  if (!structured) return null;
  const parts = [];
  if (structured.checklist_pct != null || structured.verdict) {
    parts.push(`Checklist AATAS: ${structured.checklist_pct != null ? structured.checklist_pct + '%' : '—'}${structured.verdict ? ` (${structured.verdict})` : ''}`);
  }
  const rc = structured.regime_check;
  if (rc) {
    const rcBits = [];
    if (rc.regime) rcBits.push(`regime ${rc.regime}`);
    if (rc.cb_source_conflict === true) rcBits.push('CB bias dua sumber BERBEDA');
    if (rc.event_wait === true) rcBits.push(`menunggu event${rc.event_note ? ` (${rc.event_note})` : ''}`);
    if (rc.gold && rc.gold.unanimous === false) rcBits.push('gold: real yield/DXY/regime TIDAK bulat');
    if (rcBits.length) parts.push(`Regime check: ${rcBits.join('; ')}`);
  }
  const fb = structured.fundamental_bias;
  if (fb && (fb.arah || fb.driver)) {
    parts.push(`Fundamental bias: ${fb.arah || '—'}${fb.driver ? ` — ${fb.driver}` : ''}${fb.konflik ? ` [konflik: ${fb.konflik}]` : ''}`);
  }
  const tc = structured.technical;
  if (tc && (tc.bos || tc.area)) {
    parts.push(`Teknikal: BOS ${tc.bos || '—'}${tc.area ? `, area ${tc.area}` : ''}${tc.fib_zone ? `, fib ${tc.fib_zone}` : ''}`);
  }
  const fv = structured.final_validation;
  if (fv && (fv.cot || fv.retail)) parts.push(`Validasi akhir: COT ${fv.cot || '—'}, retail ${fv.retail || '—'}`);
  if (structured.reasoning_note) parts.push(`Catatan analis: ${structured.reasoning_note}`);
  return parts.length ? parts.join('\n') : null;
}

function _formatOptionsSentimentBlock(rr, prioritized) {
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

  // (2026-08-08, diskusi user — reordering prioritas COT vs CME) Framing baru ("CME
  // DIPRIORITASKAN di atas COT untuk arah") HANYA dipakai kalau `prioritized` true
  // (isAutoCall — eksperimen developer-only). Jalur manual publik ("Analisa AI" +
  // tombol "UJI KELEMAHAN") TETAP pakai framing lama ("cross-check tambahan, jangan
  // mengubah bias") — justifikasi reordering ini (klaim "0% win rate") sudah terbukti
  // salah hitung, jadi dikarantina ke eksperimen dulu sampai tervalidasi data
  // (macro_snapshot, lihat daun_merah_progress.md), tidak langsung memengaruhi apa
  // yang dibaca publik hari ini (prinsip isolasi Plan U/U-7).
  return prioritized
    ? `SENTIMEN PASAR OPTIONS (dari CME, real-time — DIPRIORITASKAN di atas data COT mingguan untuk konfirmasi ARAH karena lebih up-to-date; kalau searah dengan bias teknikal, jadikan penguat keyakinan; kalau BERLAWANAN dengan bias teknikal, pertimbangkan serius sebagai alasan menurunkan keyakinan atau meninjau ulang arah — tetap keputusanmu berdasarkan kekuatan bukti lain, bukan otomatis dibatalkan):\n${lines.join('\n')}`
    : `SENTIMEN PASAR OPTIONS (dari CME, sumber terpisah dari data teknikal chart — pakai sebagai cross-check tambahan, BUKAN sinyal utama; kalau bertentangan dengan bias teknikal, sebut sebagai catatan risiko di paragraf integrasi, jangan mengubah bias):\n${lines.join('\n')}`;
}

// Track record historis disuapkan ke prompt Analisa (Plan I item 2, session 180) —
// AI menimbang rapornya sendiri sebelum percaya diri, bukan self-assessment
// "keyakinan" tanpa dasar. HANYA tp/sl (hasil final) yang dihitung — ambiguous
// (TP&SL sama-sama tersentuh, urutan tak diketahui), expired/stale/invalid/pending/
// open TIDAK dihitung sebagai menang/kalah (lihat _evaluateSetups). Sampel < 5 =
// noise, jangan disuap ke AI (return ''). Pure function — dites di ta_struct.test.js.
// PLAN U-3 lanjutan (2026-07-20): param `combined` opsional — true kalau `log` sudah
// digabung dari >1 sumber (manual + auto), cuma mengubah label supaya jejaknya jelas
// kalau prompt/log diperiksa nanti, tidak mengubah cara hitung.
function _formatTrackRecordBlock(log, symbol, combined) {
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
  const label = combined ? '[TRACK RECORD setup AI pair ini — gabungan seluruh sumber]' : '[TRACK RECORD setup AI pair ini]';
  return `${label}\n${total} setup selesai (segala arah): ${tp} TP / ${sl} SL (win rate ${winRate}%).${advice}`;
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
  // Umur cache: calendar_v1/calendar_next_v1 (TTL 6 jam) cuma dijaga fresh oleh
  // polling tab Kalender manual — beda dari blok lain (fundamental/makro) yang semua
  // sudah punya age-guard eksplisit. Fail-open kalau fetched_at tidak ada (fixture
  // lama/format belum punya field ini) — TIDAK menambah baris, pola sama makroAgeH.
  const ages = [calThis?.fetched_at, calNext?.fetched_at]
    .map(ts => { const ms = ts ? nowMs - new Date(ts).getTime() : NaN; return (!isNaN(ms) && ms >= 0) ? ms / 3600000 : null; })
    .filter(h => h != null);
  const ageH = ages.length > 0 ? Math.round(Math.max(...ages) * 10) / 10 : null;
  const staleNote = (ageH != null && ageH > 4)
    ? `\n(Cache kalender ${ageH} jam lalu — SUDAH AGAK BASI, mungkin ada event/rilis baru yang belum masuk daftar ini.)`
    : '';
  return `[EVENT HIGH-IMPACT 7 HARI KE DEPAN]\n${lines.join('\n')}${staleNote}\nKalau event di atas jatuh dalam rentang time_horizon_days yang kamu tulis, WAJIB disebut di invalidation_condition atau trigger.`;
}

async function ohlcvAnalyzeHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = req.query.symbol || req.body?.symbol;
  const label  = req.query.label  || req.body?.label;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Read-only path: return whatever the last successful analysis for this symbol
  // was (manual click, or — for XAU/USD only — an auto-entry Plan U auto=1 run)
  // without spending an AI call. Frontend fallback: dipanggil hanya kalau
  // localStorage klien untuk XAU/USD masih kosong (device/browser baru) — REVISI
  // 2026-08-10, digest cron 3x/hari yang dulu memicu ANALISA XAU/USD sudah
  // dihapus (lihat runDigestCycle di vps/daemon.js & market-digest.yml), Analisa
  // XAU/USD sekarang murni tombol "Analisa Pair Ini" seperti pair lain.
  if (req.query.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', `ohlcv_analysis:${symbol}`);
      if (!raw) return res.status(200).json({ commentary: null, structured: null, cached: false });
      // market_closed disertakan (bukan cuma di jalur generate) supaya auto-load XAU/USD
      // (frontend: _autoLoadXauAnalysis) juga bisa menampilkan banner "pasar tutup" saat
      // Sabtu/Minggu menyajikan analisa terakhir Jumat, bukan diam-diam tanpa keterangan.
      return res.status(200).json({ ...JSON.parse(raw), cached: true, market_closed: !marketHours.isFxMarketOpen() });
    } catch(e) {
      return res.status(200).json({ commentary: null, structured: null, cached: false });
    }
  }

  // PLAN T-1 (2026-07-19, rapat mitigasi weekend): pasar FX tutup Jumat 21:00 UTC
  // s/d Minggu ~22:00 UTC — generate baru selama itu cuma menganalisa candle
  // penutupan Jumat yang beku, nol nilai tambah tapi tetap makan AI call tiap
  // slot cron/klik manual. Gate ini cover cron GH Actions + daemon VPS + klik
  // manual sekaligus (semua lewat fungsi ini): nol AI call selama pasar tutup.
  if (!marketHours.isFxMarketOpen()) {
    try {
      const raw = await redisCmd('GET', `ohlcv_analysis:${symbol}`);
      if (raw) {
        return res.status(200).json({ ...JSON.parse(raw), cached: true, market_closed: true, ai_skipped: true });
      }
    } catch(e) { console.warn('ohlcv_analyze: market_closed cache read gagal:', e.message); }
    return res.status(200).json({
      commentary: null, structured: null, cached: false, market_closed: true, ai_skipped: true,
      error: 'Pasar forex sedang tutup (Sabtu/Minggu) — belum ada analisa tersimpan untuk pair ini.',
    });
  }

  // Q-6 (Plan Q, 2026-07-18) — REVISI 2026-08-10: market-digest.yml (GH Actions)
  // & vps/daemon.js DULU sama-sama memicu ANALISA XAU/USD tiap slot digest
  // (3x/hari); trigger itu sudah dihapus, Analisa XAU/USD kini murni tombol
  // manual seperti pair lain. Dedup 30 menit di bawah ini TETAP relevan untuk
  // cron sumber lain yang masih memanggil endpoint ini dengan header cron
  // (mis. auto-entry Plan U, flag auto=1, lihat isAutoCall) — tanpa guard ini,
  // slot auto-entry yang jatuh berdekatan bisa memanggil AI 2x untuk data yang
  // identik. Endpoint ini TIDAK PERNAH punya guard "jangan generate ulang kalau
  // baru saja generate" di luar jalur cron (beda dari market-digest.js yang
  // setidaknya punya single-flight 55 detik).
  const isCronCall = _isCronCallReq(req);
  // PLAN U-2: flag auto=1 menandai source:'auto' di setup_log (dipakai U-3 daemon
  // scheduler auto-entry). HANYA berlaku kalau request terautentikasi sebagai cron
  // call (CRON_SECRET valid) — publik TIDAK BISA spoof source:'auto' dan merusak
  // integritas statistik gate-live (n>=100 setup auto, kriteria fase tes plan U).
  const isAutoCall = isCronCall && (req.query.auto === '1' || req.body?.auto === 1 || req.body?.auto === true);
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

  // Input klien di-cap defensif: excerpt resmi max 2500 char (lihat _extractRingkasanExcerpt) —
  // body adalah input publik, jangan biarkan string raksasa menggelembungkan prompt AI.
  let ringkasanContext = req.body?.ringkasanContext || null;
  if (typeof ringkasanContext !== 'string' || !ringkasanContext.trim()) ringkasanContext = null;
  else if (ringkasanContext.length > 3000) ringkasanContext = ringkasanContext.slice(0, 2997) + '...';
  let ringkasanAt      = req.body?.ringkasanGeneratedAt || null;
  const clientOhlcv    = req.body?.ohlcvData       || null;
  // cbDir dari body: manual (index.html) selalu mengirim ini. Cron/auto tidak pernah
  // (GET tanpa body) — fallback server-side dihitung di bawah (_computeCbDirServerSide)
  // setelah cbBiasParsed/xauThesis siap, HANYA untuk isAutoCall (lihat di bawah), supaya
  // perilaku manual yang sudah ada persis sama seperti sebelumnya.
  let cbDir            = req.body?.cbDir           || null;
  let xauThesis        = null;

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
        xauThesis = artObj.thesis || null;
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
    if (!data.h1.available) return res.status(200).json({ commentary: null, ai_skipped: true, error: 'OHLCV belum tersedia — tunggu GitHub Actions sync pertama.' });

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

    // Sentimen pasar options (CME CVOL) per pair — session 157 lanjutan 7. Cache
    // ditulis correlations.js (rr_cache_v2, TTL 1h), dibaca read-only di sini (tidak
    // memicu fetch CME baru — kalau cache kosong/expired, blok ini kosong, tidak
    // menunggu/gagalkan analisa). NZD/USD & USD/CHF tidak punya data (options CME
    // terlalu illiquid) — blok otomatis kosong untuk keduanya, bukan bug.
    // (2026-08-08) Diangkat ke SEBELUM blok fundamental (dulu sesudah) supaya
    // rrPairSnapshot siap dipakai `hasCmeData` di _formatFundamentalBlock di bawah —
    // reordering prioritas COT vs CME (diskusi user), bukan mengubah data yang ditarik.
    let rrBlock = '';
    let rrPairSnapshot = null;
    try {
      const rawRR = await redisCmd('GET', 'rr_cache_v2');
      if (rawRR) {
        const rrCache = JSON.parse(rawRR);
        rrPairSnapshot = rrCache?.pairs?.[data.label] || null;
        // (2026-08-08, diskusi user) Framing "CME diprioritaskan" HANYA untuk
        // isAutoCall (eksperimen developer-only) — bukan jalur manual publik ("Analisa
        // AI" yang siapa saja bisa klik). Justifikasi awal reordering ini (klaim "0%
        // win rate") sudah terbukti salah hitung; sampai ada data yang benar-benar
        // memvalidasi, framing baru DIKARANTINA ke eksperimen dulu, tidak langsung
        // memengaruhi apa yang dibaca publik (prinsip isolasi Plan U/U-7).
        rrBlock = _formatOptionsSentimentBlock(rrPairSnapshot, isAutoCall);
      }
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache RR kosong */ }

    // Blok fundamental terstruktur per pair — langsung dari cache Redis (cb_bias, COT,
    // risk regime), bukan turunan artikel. Best-effort: gagal baca = blok kosong.
    let fundBlock = '';
    // Gate B auto-entry (drawdown circuit breaker adaptif, audit celah kesalahan
    // trader 2026-07-28) butuh label regime MENTAH terpisah dari fundBlock (yang cuma
    // teks prompt) — diisi di try yang sama supaya tidak fetch 'risk_regime' dua kali.
    let autoGuardRegime = null;
    // [SISTEM HAKIM] butuh objek cb_bias mentah (bukan fundBlock yang cuma teks prompt)
    // untuk _computeCbDirServerSide di bawah — diisi di try yang sama, tidak fetch dobel.
    let cbBiasParsed = null;
    // Snapshot makro (2026-08-08, diskusi user) — sebelumnya cot/retail/drivers/risk
    // cuma di-parse INLINE di parameter _formatFundamentalBlock di bawah, tidak pernah
    // disimpan ke variabel scope luar, jadi hilang begitu selesai dipakai buat prompt.
    // Diangkat ke sini supaya bisa dipakai lagi oleh _buildMacroSnapshot di
    // buildNewSetupEntry (~600 baris di bawah, fungsi yang sama, closure yang sama) —
    // TANPA fetch Redis kedua.
    let cotParsed = null;
    let retailParsed = null;
    let macroDrivers = null;
    let riskParsed = null;
    try {
      const [rawBias, rawCot, rawRisk, rawRetail, rawSnap, rawRY] = await Promise.all([
        redisCmd('GET', 'cb_bias'),
        redisCmd('GET', 'cot_cache_v2'),
        redisCmd('GET', 'risk_regime'),
        redisCmd('GET', 'retail_sentiment_cache'),
        redisCmd('GET', 'daily_snapshot'),
        redisCmd('GET', 'real_yields'),
      ]);
      riskParsed = rawRisk ? JSON.parse(rawRisk) : null;
      autoGuardRegime = riskParsed?.regime || null;
      cbBiasParsed = rawBias ? JSON.parse(rawBias) : null;
      cotParsed = rawCot ? JSON.parse(rawCot) : null;
      retailParsed = rawRetail ? JSON.parse(rawRetail) : null;
      macroDrivers = _extractMacroDrivers(rawSnap, rawRY);
      fundBlock = _formatFundamentalBlock({
        label: data.label, isXau: data.is_xau,
        cbBias: cbBiasParsed,
        cot:    cotParsed,
        risk:   riskParsed,
        retail: retailParsed,
        drivers: macroDrivers,
        nowMs:  Date.now(),
        // (2026-08-08, diskusi user, khusus XAU/USD & EUR/USD — satu-satunya pair
        // auto-entry yang punya data CME) reordering prioritas: COT (mingguan, lag)
        // diberi catatan eksplisit bahwa CME (real-time) lebih diutamakan untuk arah
        // KALAU datanya tersedia untuk pair ini. AUD/NZD & EUR/GBP otomatis TIDAK
        // kena (rrPairSnapshot selalu null buat mereka — bukan pair CVOL) — 0 baris
        // kode berubah untuk 2 pair itu, sesuai batas scope Section 4 rapat CME.
        // && isAutoCall (ditambah kemudian, sama hari): dikarantina ke eksperimen
        // developer-only saja, lihat komentar rrBlock di atas — TIDAK bocor ke jalur
        // manual publik sampai tervalidasi data.
        hasCmeData: !!rrPairSnapshot && isAutoCall,
      });
    } catch (e) { /* opsional — jangan gagalkan analisa kalau cache fundamental kosong */ }
    // Fallback HANYA untuk isAutoCall (cron auto-entry) — manual selalu sudah kirim
    // cbDir sendiri (atau sengaja null), perilakunya tidak disentuh sama sekali.
    if (!cbDir && isAutoCall) {
      cbDir = _computeCbDirServerSide({ label: data.label, isXau: data.is_xau, cbBiasObj: cbBiasParsed, xauThesis });
    }

    // Track record historis setup AI pair ini (Plan I item 2) — 1 GET Redis, 0 AI call.
    // BUG LAMA DITEMUKAN & DIFIX (2026-07-20, saat kerja Plan U-3 lanjutan): parameter
    // kedua di bawah HARUS `symbol` (ticker, mis. "GBPUSD=X"/"GC=F" — sama dengan field
    // `.symbol` yang disimpan tiap entri setup_log), BUKAN `data.label` (label manusia,
    // mis. "GBP/USD"). Sejak fitur ini dibuat (Plan I item 2, session 180) kodenya
    // memakai `data.label`, yang TIDAK PERNAH cocok dengan `.symbol` manapun di
    // setup_log — filter `_formatTrackRecordBlock` gagal total untuk SEMUA pair,
    // blok "TRACK RECORD" tidak pernah benar-benar disuap ke prompt sejak awal. Baru
    // ketahuan sekarang lewat test end-to-end baru (isolation_auto.test.js) yang benar-
    // benar memeriksa isi prompt, bukan cuma pure-function `_formatTrackRecordBlock`
    // dengan data mock yang kebetulan konsisten (lihat ta_struct.test.js — semua test
    // lama pakai symbol sama untuk kedua argumen, tidak pernah menangkap mismatch ini).
    // PLAN U-3 lanjutan (2026-07-20, diskusi user): auto-entry (developer-only) baru mulai
    // mengumpulkan datanya sendiri (setup_log_auto:v1) — kalau cuma baca itu, ia "buta"
    // tanpa rapor sama sekali selama minggu-minggu pertama (gate _formatTrackRecordBlock
    // butuh >=5 setup selesai). KHUSUS isAutoCall: gabungkan setup_log:v1 + setup_log_auto:v1
    // (bootstrap dari data manual sambil datanya sendiri menumpuk). Call MANUAL SENGAJA
    // TIDAK diubah (tetap murni setup_log:v1) — commentary hasil call manual tampil ke
    // publik, menggabungkan data eksperimen developer-only ke situ berisiko membocorkan
    // pengaruhnya secara tidak langsung (lewat nada/kalimat komentar) — pelanggaran senyap U-7.
    let trackBlock = '';
    try {
      const rawSetupLog = await redisCmd('GET', 'setup_log:v1');
      let combinedLog = rawSetupLog ? JSON.parse(rawSetupLog) : [];
      if (!Array.isArray(combinedLog)) combinedLog = [];
      if (isAutoCall) {
        const rawAutoLog = await redisCmd('GET', 'setup_log_auto:v1');
        const autoLog = rawAutoLog ? JSON.parse(rawAutoLog) : [];
        if (Array.isArray(autoLog)) combinedLog = combinedLog.concat(autoLog);
      }
      trackBlock = _formatTrackRecordBlock(combinedLog, symbol, isAutoCall);
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

    // Gate D live-sign (audit 2026-08-16): fetch di luar lock (pola sama trackBlock/
    // calAnalyzeBlock di atas — JANGAN tambah I/O di dalam critical section mutasi
    // log di bawah). Hanya perlu untuk isAutoCall (Gate D cuma jalan untuk auto-entry).
    // AATAS (2026-08-22): cache yang SAMA juga membawa `gold_correlations.RealYield`
    // (korelasi live emas vs real yield) — dipakai sebagai arbitrase Step 0 cabang gold.
    // Numpang fetch ini, NOL I/O tambahan.
    let liveCorrSign = null;
    let goldCorrLive = null;
    if (isAutoCall) {
      try {
        const rawCorr = await redisCmd('GET', 'correlations_v3');
        const corrData = rawCorr ? JSON.parse(rawCorr) : null;
        liveCorrSign = corrData ? _buildLiveCorrSign(corrData) : null;
        if (data.is_xau && corrData) {
          const ry = corrData.gold_correlations && corrData.gold_correlations.RealYield;
          const anomaly = _goldYieldCorrAnomaly(corrData);
          goldCorrLive = ry ? { r20: ry.r20, r60: ry.r60, anomaly } : { r20: null, r60: null, anomaly };
        }
      } catch (e) { /* opsional — fallback ke sign statis di isCorrelatedExposureBlocked */ }
    }

    // AATAS Step 0 gold: rate path Fed implied (non-blocking). HANYA untuk XAU/USD jalur
    // auto — satu GET tambahan yang tidak menyentuh jalur manual publik sama sekali.
    let ratePathBlock = '';
    if (isAutoCall && data.is_xau) {
      try {
        const rawRate = await redisCmd('GET', 'rate_path');
        ratePathBlock = rawRate ? _formatRatePathBlock(JSON.parse(rawRate)) : '';
      } catch (e) { /* opsional — konteks tambahan, bukan syarat */ }
    }

    // PLAN U-2 (2026-07-20): rezim volatilitas (ATR14 H1 pair ini) + currency
    // strength (14 pair FX, %change H1 ~3 hari) — modul murni api/_pair_context.js,
    // I/O Redis di sini saja. Fail-open: gagal fetch/data kurang -> pairCtx.block
    // kosong, TIDAK menggagalkan analisa (pola sama semua blok di atas).
    let pairCtx = { regime: null, strength: null, block: '' };
    try {
      const symbolsToFetch = [...new Set([symbol, ...FX_PAIRS_FOR_STRENGTH.map(p => p.symbol)])];
      const rawCandles = await Promise.all(symbolsToFetch.map(s => redisCmd('GET', `ohlcv:${s}:1h`)));
      const candlesBySymbol = {};
      symbolsToFetch.forEach((s, i) => {
        if (!rawCandles[i]) return;
        try { candlesBySymbol[s] = JSON.parse(rawCandles[i]); } catch (e) { /* skip pair korup */ }
      });
      pairCtx = buildPairContext({ candlesBySymbol, symbol, label: data.label, fxPairs: FX_PAIRS_FOR_STRENGTH });
    } catch (e) { console.warn('ohlcv_analyze: pair context gagal (fail-open):', e.message); }

    const makroHeader = makroAgeH != null
      ? `KONTEKS MAKRO (dari Ringkasan ${makroAgeH} jam lalu${makroAgeH > 4 ? ' — SUDAH AGAK BASI: kalau ada rilis/berita besar setelah itu, beri bobot lebih rendah dan sebut ketidakpastiannya' : ''}):`
      : 'KONTEKS MAKRO:';
    // Zona konfluensi deterministik — dihitung SEKALI di kode dari struktur yang sama
    // dengan yang dilihat AI, supaya entry/SL/TP tidak "di-reroll" tiap re-generate.
    const confZones = _confluenceZones(data, expiryLvls);
    const confBlock = _formatConfluenceBlock(confZones, data.dec);
    // PLAN Z (2026-08-18): kandidat SL/TP deterministik — perluasan pola confZones
    // di atas. null kalau confZones sendiri null (data minim) ATAU tidak ada arah
    // (bearish/bullish) yang punya SL+TP layak (lihat api/_levels.js) — di kedua
    // kasus, levelBlock kosong dan slInstr/tpInstr di bawah JATUH ke instruksi lama.
    const levelCandidates = confZones
      ? computeLevelCandidates({ zones: confZones, atrD: (data.d1_ext?.available ? data.d1_ext.atr_d : null), isXau: data.is_xau, dec: data.dec })
      : null;
    const levelBlock = _formatLevelCandidatesBlock(levelCandidates);

    const ctxParts = [];
    if (ringkasanContext) ctxParts.push(`${makroHeader}\n${ringkasanContext}`);
    if (fundBlock)        ctxParts.push(fundBlock);
    if (ratePathBlock)    ctxParts.push(ratePathBlock);
    if (rrBlock)          ctxParts.push(rrBlock);
    if (trackBlock)       ctxParts.push(trackBlock);
    if (calAnalyzeBlock)  ctxParts.push(calAnalyzeBlock);
    if (pairCtx.block)    ctxParts.push(pairCtx.block);
    ctxParts.push(`DATA TEKNIKAL:\n${textBlock}${expiryBlock}${confBlock ? '\n\n' + confBlock : ''}${levelBlock ? '\n\n' + levelBlock : ''}`);
    const makroBlock = ctxParts.join('\n\n');

    // AATAS v2 (2026-08-25): jalur `isAutoCall` memakai DUA kelompok data terpisah,
    // bukan satu `makroBlock` gabungan di atas. Ini inti fix-nya — bukan sekadar
    // penataan ulang teks: Call 1 (penentu arah) tidak pernah menerima satu byte pun
    // data teknikal, jadi "RSI overbought" tidak bisa jadi driver fundamental.
    //
    // Pembagian yang perlu dijelaskan:
    //  - `pairCtx.block` (currency strength + rezim volatilitas) masuk TEKNIKAL, bukan
    //    makro — isinya price-derived (turunan %perubahan harga H1). Pernah jadi bug
    //    nyata: ranking currency strength dipakai sebagai "bukti fundamental" (2026-08-10).
    //    Sudah dicek: `regime_check.regime` bersumber dari baris RISK REGIME di
    //    `fundBlock`, BUKAN dari sini, jadi Call 1 tidak kehilangan apa pun.
    //  - `calAnalyzeBlock` dikirim ke KEDUA call, bukan salah satu: Call 1 butuh untuk
    //    Step 0 (event <6 jam menunda entry), Call 2 butuh untuk conflict='waktu'
    //    terhadap time_horizon_days yang baru dihitung di sana. Bukan duplikasi keliru.
    //  - `trackBlock` (win-rate historis pair) masuk TEKNIKAL: yang membacanya adalah
    //    penilaian kelayakan setup, bukan penentuan arah makro.
    const aatasMacroParts = [];
    const aatasTechParts = [];
    if (isAutoCall) {
      if (ringkasanContext) aatasMacroParts.push(`${makroHeader}\n${ringkasanContext}`);
      if (fundBlock)        aatasMacroParts.push(fundBlock);
      if (ratePathBlock)    aatasMacroParts.push(ratePathBlock);
      if (rrBlock)          aatasMacroParts.push(rrBlock);
      if (calAnalyzeBlock)  aatasMacroParts.push(calAnalyzeBlock);

      if (trackBlock)       aatasTechParts.push(trackBlock);
      if (calAnalyzeBlock)  aatasTechParts.push(calAnalyzeBlock);
      if (pairCtx.block)    aatasTechParts.push(pairCtx.block);
      aatasTechParts.push(`DATA TEKNIKAL:\n${_stripIndicatorLines(textBlock)}${expiryBlock}${confBlock ? '\n\n' + confBlock : ''}${levelBlock ? '\n\n' + levelBlock : ''}`);
    }

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
      pairCtx.regime         ? 'rezim volatilitas' : null,
      pairCtx.strength       ? 'currency strength' : null,
    ].filter(Boolean).join(' + ');

    const p4Macro = (ringkasanContext || fundBlock)
      ? ' — kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR berlawanan jelas dengan struktur teknikal (misal makro risk-off tapi teknikal breakout bullish), sebut konflik itu eksplisit dan turunkan keyakinan setup, jangan diam-diam diabaikan; kesimpulanmu di sini harus konsisten dengan field makro_alignment. Kalau konfliknya bertipe "berita/geopolitik seharusnya mendorong arah A tapi harga malah arah B", JANGAN cuma menempelkan dua fakta lepas (misal "geopolitik naik, tapi real yield tinggi") — telusuri mekanismenya pakai angka DXY/WTI/breakdown real yield di FUNDAMENTAL TERSTRUKTUR kalau tersedia (contoh: naik/turunnya WTI menjelaskan naik/turunnya ekspektasi inflasi, yang lalu menjelaskan kenapa real yield bergerak begitu — bukan cuma menyebut real yield sebagai fakta berdiri sendiri)'
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
    // AATAS (2026-08-22): klausa "kapan TIDAK boleh keluarkan setup" beda antara jalur
    // manual (dasar lama: makro_alignment konflik) dan jalur auto (dasar baru: gate Step
    // 1/2 tidak lolos — makro sekarang PENENTU arah, bukan pembanding terpisah). Sisa
    // instruksi entry/sl/tp identik untuk dua jalur, jadi cuma klausa ini yang bercabang.
    // AATAS v2: klausa "kapan TIDAK boleh keluarkan setup" beda antara jalur manual
    // (dasar lama: makro_alignment konflik) dan jalur auto (dasar baru: bias sudah
    // dikunci makro, jadi yang membatalkan adalah struktur yang melawan/ranging).
    // Sisa instruksi entry/sl/tp IDENTIK untuk dua jalur — makanya cuma klausa ini yang
    // diparameterkan, bukan seluruh instruksinya disalin dua kali (salinan kedua pasti
    // divergen diam-diam suatu saat).
    const noSetupClause = 'ATAU jika makro_alignment adalah "konflik", set entry_zone, sl, tp, entry_basis ke null dan jelaskan di trigger kondisi apa yang ditunggu — JANGAN memaksakan setup saat makro dan teknikal bertabrakan.';
    const noSetupClauseAuto = 'ATAU jika struktur teknikal berlawanan dengan bias yang SUDAH DIKUNCI analisa makro, ATAU pasar sedang ranging sempit, set entry_zone, sl, tp, entry_basis ke null dan jelaskan di trigger kondisi apa yang ditunggu — JANGAN membalik bias mengikuti chart, dan JANGAN memaksakan setup supaya ada.';
    const buildEntryZoneInstr = (noSetupClause) => {
      return confBlock
      ? `- entry_zone: WAJIB pilih dari daftar [ZONA KONFLUENSI] di atas — ambil zona dengan SKOR TERTINGGI yang searah bias dan konsisten dengan harga "Now": bias bearish → zona di ATAS Now (jual di rally ke resistance); bias bullish → zona di BAWAH Now (beli di pullback ke support); pengecualian hanya breakout/breakdown confirmation dengan trigger jelas. Tulis center zona itu atau range sempit di sekitarnya — JANGAN mengarang level di luar daftar. Kalau dua zona skornya sama, pilih yang lebih dekat ke Now. KALAU TIDAK ADA zona layak searah bias (struktur Mixed, harga di tengah range, semua zona skor rendah), ${noSetupClause}`
      : `- entry_zone: level atau range harga ideal untuk entry (angka konkret). WAJIB berpijak pada level STRUKTUR yang benar-benar ada di DATA TEKNIKAL: cluster [LEVEL S/R], level [FIBONACCI], [PIVOT HARIAN], Prev Day/Week H-L, swing H4, SMA, atau option expiry — jangan mengarang angka yang tidak ada di data. PRIORITASKAN KONFLUENSI: area di mana 2+ struktur berbeda jatuh berdekatan (misal fib 61.8% bertepatan dengan cluster S/R yang banyak disentuh dan pivot S1) — itu entry dengan dasar terkuat. WAJIB konsisten dengan harga "Now": kalau bias bearish, entry_zone >= Now (jual di rally ke resistance) ATAU di bawah Now kalau memang breakdown confirmation, TAPI jangan keduanya sekaligus. Kalau Now sudah melewati level breakdown/breakout relevan, jangan minta retracement ke arah berlawanan — definisikan entry di struktur terdekat dari Now. KALAU TIDAK ADA setup dengan dasar struktur jelas searah bias (misal struktur Mixed dan harga di tengah range, jauh dari semua level kuat), ${noSetupClause}`;
    };
    const entryZoneInstr = buildEntryZoneInstr(noSetupClause);
    const entryBasisInstr = confBlock
      ? '- entry_basis: salin daftar struktur penyusun zona yang kamu pilih dari [ZONA KONFLUENSI] (bagian setelah tanda "=" di baris zona itu; boleh diringkas tapi minimal satu struktur bernama dengan angkanya). Kalau entry_zone null, field ini juga null.'
      : '- entry_basis: sebutkan struktur mana saja dari DATA TEKNIKAL yang jadi dasar entry_zone, dengan angkanya (contoh format: "fib 61.8% 1.1712 + cluster S/R 1.1709 (4x sentuh) + pivot S1 1.1705"). Minimal satu struktur bernama; makin banyak konfluensi makin baik. Kalau entry_zone null, field ini juga null.';
    // Buffer XAU dinaikkan ke 1x ATR (dari 0.5x default FX) — diskusi user 2026-07-30:
    // gold historically punya wick/fakeout jauh lebih agresif per-jam daripada FX
    // major (rentang harian ratusan dolar bukan tak lazim), 0.5x ATR-14 H1 terlalu
    // sempit dan kena stop dari noise normal, bukan invalidasi struktur asli.
    const slBufferMult = data.is_xau ? '1x' : '0.5x';
    // PLAN Z (2026-08-18): tiga varian sekarang, bukan dua. levelCandidates (paling
    // ketat, [KANDIDAT SL/TP] terhitung) > confBlock (fallback lama, struktur bebas
    // tapi tetap dari DATA TEKNIKAL) > generic (data paling minim). Kode DI LUAR sini
    // (blok snap/tolak dekat sanity-check RR) yang menegakkan varian pertama — instruksi
    // ini hanya mengarahkan AI, bukan satu-satunya jaring pengaman.
    //
    // levelCandidates BISA cuma punya SATU arah (mis. bearish ada, bullish null —
    // umum terjadi kalau filter RR di api/_levels.js membuang semua TP satu sisi).
    // Kalau AI akhirnya pilih bias yang arahnya TIDAK punya kandidat, instruksi
    // "wajib pilih dari daftar" itu mustahil dipatuhi — makanya varian levelCandidates
    // di bawah SELALU menyertakan klausa fallback eksplisit ke instruksi lama untuk
    // kasus itu, supaya AI tidak dipaksa taat pada daftar yang tidak ada.
    const slFallbackTail = confBlock
      ? ` struktur berikutnya setelah entry_zone dari [ZONA KONFLUENSI]/[LEVEL S/R], dengan buffer minimal ~${slBufferMult} ATR-14 H1 dari level itu`
      : ` swing H4, cluster S/R, atau Prev Day H/L yang ADA di data, dengan buffer minimal ~${slBufferMult} ATR-14 H1 dari level itu`;
    const slInstr = levelCandidates
      ? `- sl: WAJIB pilih SATU angka PERSIS dari [KANDIDAT SL/TP] di atas, baris SL sesuai bias yang kamu tentukan (bearish pakai daftar SL di bawah "Kalau bias BEARISH", bullish pakai daftar SL di bawah "Kalau bias BULLISH") — JANGAN mengarang angka lain. KALAU bias yang kamu pilih TIDAK punya baris SL sendiri di [KANDIDAT SL/TP] (daftar itu bisa cuma render satu arah), baru gunakan level di${slFallbackTail} (jangan tepat di level, rawan wick hunt). Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.`
      : confBlock
      ? `- sl: level stop loss konkret DI LUAR zona konfluensi yang melindungi entry — di balik zona [ZONA KONFLUENSI] atau struktur berikutnya setelah entry_zone, dengan buffer minimal ~${slBufferMult} ATR-14 H1 dari level itu (jangan tepat di level, rawan wick hunt)${data.is_xau ? '. XAU/USD historis lebih volatile per-jam dari FX major — buffer sempit gampang kena stop oleh noise, bukan invalidasi struktur asli' : ''}. Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.`
      : `- sl: level stop loss konkret DI LUAR struktur yang melindungi entry — di balik swing H4, cluster S/R, atau Prev Day H/L yang ADA di data, dengan buffer minimal ~${slBufferMult} ATR-14 H1 dari level itu (jangan tepat di level, rawan wick hunt)${data.is_xau ? '. XAU/USD historis lebih volatile per-jam dari FX major — buffer sempit gampang kena stop oleh noise, bukan invalidasi struktur asli' : ''}. Untuk bearish, sl harus di atas entry_zone. Untuk bullish, sl harus di bawah entry_zone.`;
    const tpFallbackTail = confBlock
      ? ' zona konfluensi BERIKUTNYA searah bias dari [ZONA KONFLUENSI] (atau struktur [LEVEL S/R] berikutnya)'
      : ' struktur berikutnya searah bias yang ADA di data (cluster S/R, swing, pivot, fib)';
    const tpInstr = levelCandidates
      ? `- tp: WAJIB pilih SATU angka PERSIS dari [KANDIDAT SL/TP] di atas, baris TP sesuai bias yang kamu tentukan — JANGAN mengarang angka lain. KALAU bias yang kamu pilih TIDAK punya baris TP sendiri di [KANDIDAT SL/TP], baru gunakan${tpFallbackTail}. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. Daftar TP (kalau ada untuk bias-mu) sudah disaring kode supaya risk/reward minimal 1:1 terhadap SL terdekat; kalau pakai fallback, WAJIB risk/reward minimal 1:1 sendiri — kalau tidak memungkinkan, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.`
      : confBlock
      ? '- tp: zona konfluensi BERIKUTNYA searah bias dari daftar [ZONA KONFLUENSI] (atau struktur [LEVEL S/R] berikutnya kalau tidak ada zona lagi searah itu) — jangan mengarang. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. WAJIB risk/reward (jarak entry→tp dibanding entry→sl) minimal 1:1 — kalau struktur data tidak memungkinkan RR ≥1, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.'
      : '- tp: level take profit konkret = struktur berikutnya searah bias yang ADA di data (cluster S/R, swing, pivot, fib) — jangan mengarang. Untuk bearish, tp harus di bawah entry_zone. Untuk bullish, tp harus di atas entry_zone. WAJIB risk/reward (jarak entry→tp dibanding entry→sl) minimal 1:1 — kalau struktur data tidak memungkinkan RR ≥1, sebutkan itu di trigger/commentary alih-alih memaksakan level palsu.';
    // AATAS (2026-08-22, direvisi v2 2026-08-25) — jalur `isAutoCall` TIDAK LAGI lewat
    // sini. Prompt auto-entry sekarang dibangun terpisah di `_runAatasTwoCall` (dua
    // panggilan: makro-only lalu teknikal-only). Seluruh instruksi di bawah ini murni
    // jalur MANUAL publik ("Analisa AI"), teksnya PERSIS seperti sebelum AATAS ada —
    // dulu tiap variabel bercabang `isAutoCall ? ... : ...`, cabang auto-nya sekarang
    // tidak punya pemanggil lagi jadi dibuang. Isolasi Opsi A tetap berlaku: fitur
    // publik ini tidak boleh berubah satu karakter pun saat auto-entry berevolusi
    // (dijaga test byte-identik di test/admin/aatas.test.js).
    const biasInstr = '- bias: trend dominan — bullish/bearish/neutral/mixed. Dasarkan pada GABUNGAN trend Daily + [STRUKTUR H4] (HH+HL vs LH+LL) + BOS kalau ada — bukan cuma perubahan %. Pakai "mixed" kalau timeframe saling kontradiksi (misal Daily naik tapi struktur H4 LH+LL) atau makro vs teknikal berlawanan jelas — jangan paksa ke "neutral" kalau sebenarnya konflik, bukan tanpa-trend.';
    const timeHorizonInstr = '- time_horizon_days: estimasi jumlah hari realistis skenario ini main out (angka, misal 3, 5, 10) berdasarkan jarak entry-tp dibanding rata-rata gerak harian (ATR/sigma) yang ada di data';
    const decisionFieldInstr = [
        '- makro_alignment: "searah" kalau KONTEKS MAKRO / FUNDAMENTAL TERSTRUKTUR mendukung arah bias teknikalmu, "konflik" kalau berlawanan, "netral" kalau sinyal makro tidak jelas/campuran. Kalau blok makro dan fundamental dua-duanya tidak tersedia di atas, isi null. JANGAN pakai ranking currency strength / rezim volatilitas (kalau ada di atas) sebagai bukti di sini — itu price-derived teknikal (turunan %perubahan harga H1), bukan fundamental catalyst, sama seperti headline "Currency Strength Chart" yang historisnya sering salah dibaca sebagai sinyal fundamental; field ini HANYA boleh berdasar KONTEKS MAKRO (Ringkasan) dan FUNDAMENTAL TERSTRUKTUR (cb_bias, COT, real yield, dsb) — kalau HANYA currency strength/rezim yang mendukung suatu arah tanpa dukungan fundamental sungguhan, itu BUKAN alasan valid untuk "searah". SEBELUM memutuskan searah/konflik, tentukan dulu mata uang mana yang diuntungkan oleh bias teknikalmu: bias bullish = mata uang BASE (kiri) menguat vs QUOTE (kanan); bias bearish = mata uang QUOTE menguat vs BASE — berlaku SAMA untuk pair mayor maupun pair silang non-USD (misal AUD/NZD bearish = NZD menguat vs AUD, EUR/GBP bearish = GBP menguat vs EUR, BUKAN sebaliknya). Baru bandingkan: kalau sinyal fundamental mendukung penguatan mata uang yang SAMA itu, itu "searah" — JANGAN dibalik jadi "konflik" hanya karena satu mata uang disebut "hawkish/kuat" tanpa mengecek dulu apakah itu mata uang yang diuntungkan atau dirugikan oleh biasmu. WAJIB cek ulang sebelum menjawab: kalau kesimpulanmu "searah", pastikan mata uang yang kamu anggap "diuntungkan" oleh biasmu itu SAMA dengan mata uang yang sinyal fundamentalnya (bias CB hawkish, COT crowded short berisiko short-squeeze, dsb) menunjukkan MENGUAT — jangan sampai makro_alignment_reason-mu menyebut mata uang yang SAMA "menguat" sekaligus "melemah" hanya karena kamu ingin memaksakan "searah". Contoh kesalahan nyata yang harus dihindari: bias BoJ hawkish + COT JPY net short crowded (persentil rendah, rawan short-squeeze naik) dua-duanya sinyal JPY MENGUAT — untuk pair CHF/JPY itu berarti QUOTE menguat, jadi sinyal itu searah dengan bias BEARISH CHF/JPY (bukan bullish); kalau biasmu justru bullish CHF/JPY, sinyal itu KONFLIK, bukan searah.',
        '- makro_alignment_reason: SATU kalimat pendek alasannya dengan menyebut data spesifik (misal "bias Fed Dovish + COT USD net short searah dengan bias bearish USD/JPY"). Kalau alasannya menyangkut mekanisme dolar/komoditas/yield (misal "safe-haven vs real yield", "geopolitik vs oil"), WAJIB pakai angka konkret dari baris DOLLAR & KOMODITAS / REAL YIELD USD di FUNDAMENTAL TERSTRUKTUR kalau tersedia (level DXY/WTI, atau breakdown nominal-vs-ekspektasi inflasi) — jangan cuma bilang "real yield tinggi" tanpa angka atau tanpa menjelaskan apakah itu didorong sisi nominal atau sisi inflasi. Kalau data itu tidak tersedia di atas, jangan mengarang angka — tetap boleh pakai bahasa umum. Null kalau makro_alignment null.',
      ];
    const conflictInstr = '- conflict: bandingkan bias TEKNIKALMU vs (a) arah yang tersirat KONTEKS MAKRO/FUNDAMENTAL TERSTRUKTUR di atas (kalau ada), DAN (b) [EVENT HIGH-IMPACT 7 HARI KE DEPAN] (kalau ada). Isi "arah" kalau makro/fundamental berlawanan jelas dengan bias teknikalmu — INI BUKAN alasan otomatis untuk tidak keluarkan setup, tapi WAJIB dilaporkan di sini. Isi "waktu" kalau ada event high-impact dalam beberapa jam ke depan (sebelum time_horizon_days-mu selesai) yang bisa membatalkan skenario mendadak — ini LEBIH SERIUS dari konflik arah, pilih "waktu" kalau dua-duanya terjadi sekaligus. Isi "none" kalau tidak ada konflik terdeteksi atau data pembanding tidak tersedia.';
    const tailFieldInstr = [
        '- confidence: level keyakinanmu sendiri atas SELURUH setup ini (bukan cuma bias arah) — salah satu "tinggi"/"sedang"/"rendah". HARUS konsisten dengan level keyakinan yang kamu sebut di paragraf KESIMPULAN nanti (field ini SATU-SATUNYA sumber terstruktur untuk itu, dibaca kode/statistik — paragraf teks tidak diparsing). Null HANYA kalau entry_zone null (tidak ada setup untuk dinilai).',
      ];
    const commentaryParas = [
        `Isi paragraf pertama (tanpa header) — bias & posisi makro harga: arah trend Daily dengan alasan konkret (perubahan %, close vs open, posisi dalam range 6 bulan dari [KONTEKS 6 BULAN] — dekat puncak/lembah/tengah).`,
        `Isi paragraf kedua (tanpa header) — struktur H4: pakai [STRUKTUR H4] (HH+HL / LH+LL / mixed) dan posisi harga terhadap cluster [LEVEL S/R] terdekat; fase akumulasi/distribusi/breakout; MACD H4 konfirmasi atau divergensi.`,
        `Isi paragraf ketiga (tanpa header) — momentum & pola: momentum H1 terkini, RSI H4 (arah naik/turun), pola candle yang terdeteksi dan artinya di posisi sekarang${p3Atr}, konfluensi atau perbedaan arah dengan H4.`,
        `Isi paragraf keempat (tanpa header) — integrasi ${p4Label}: simpulkan kekuatan setup (berapa struktur yang konfluens di entry_zone), risiko utama, dan kondisi pasar yang memvalidasi atau membatalkan skenario ini${p4Macro}.`,
        `Isi paragraf kelima — mulai literal dengan "KESIMPULAN:" lalu isi (WAJIB, paragraf penutup terpisah — jangan digabung ke paragraf keempat): 3-4 kalimat MAKSIMAL setelah kata "KESIMPULAN:", jangan mengulang detail/angka yang sudah dijelaskan panjang di paragraf sebelumnya. Harus BISA BERDIRI SENDIRI untuk trader yang cuma sempat baca satu paragraf ini: (1) bias akhir + level keyakinan (tinggi/sedang/rendah) dengan alasan singkat kenapa segitu, (2) SATU kondisi konkret yang ditunggu sebelum entry (ulangi trigger utama secara ringkas, minimal sebutkan levelnya), (3) SATU risiko/pembatal utama dalam satu kalimat. Nada tegas dan actionable, bukan mengulang narasi eksploratif paragraf sebelumnya.${p5Track}`,
      ];
    const userMsg = [
      `Analisa ${data.label}:`,
      '',
      makroBlock,
      '',
      'Isi field JSON berikut:',
      biasInstr,
      entryZoneInstr,
      entryBasisInstr,
      slInstr,
      tpInstr,
      '- trigger: SATU kondisi price action spesifik yang HARUS terpenuhi sebelum entry — utamakan konfirmasi berbasis candle/pola di level konkret (misal "tunggu candle H4 close di bawah 1.1710" atau "tunggu rejection/pin bar H1 di area 3340") daripada indikator murni. Jangan sebut dua kondisi alternatif yang saling kontradiksi relatif ke Now. Manfaatkan [POLA CANDLE terdeteksi] kalau relevan.',
      '- invalidation_condition: kondisi spesifik yang membatalkan skenario ini sepenuhnya (beda dari sl — ini soal struktur/tesis, misal "kalau Daily close balik di bawah SMA50 atau swing low H4 terakhir jebol, bias bullish batal")',
      '- invalidation_trigger: versi TERSTRUKTUR dari invalidation_condition di atas, supaya KODE (bukan AI) bisa mendeteksi otomatis tanpa call AI tambahan — objek {"type":"ma_break"|"price_level"|"swing_break","level":<satu angka>,"timeframe":"1h"|"4h"|"1d","direction":"above"|"below"}. "level" WAJIB satu angka konkret yang ADA di data (nilai SMA/level struktur/swing yang kamu sebut di invalidation_condition), "direction" = arah CLOSE candle yang membatalkan skenario ("below" kalau close balik ke bawah level itu membatalkan, "above" kalau close balik ke atas). Kalau invalidation_condition-mu TIDAK BISA diringkas jadi satu level angka tunggal (butuh multi-kondisi atau deskripsi kualitatif), set invalidation_trigger ke null — JANGAN mengarang angka.'
        + (levelCandidates ? ' Kalau type-nya "price_level" atau "swing_break", SEBAIKNYA level ini sama dengan salah satu angka di [KANDIDAT SL/TP] atau [ZONA KONFLUENSI] di atas (bukan angka baru yang tidak berkaitan) — konsisten dengan sl yang kamu pilih.' : ''),
      timeHorizonInstr,
      ...decisionFieldInstr,
      conflictInstr,
      '- conflict_note: SATU kalimat pendek alasan konkret (sebut data/event spesifik) kalau conflict bukan "none"; null kalau conflict "none".',
      ...tailFieldInstr,
      '',
      'Setelah objek JSON, di baris baru tulis PERSIS "===COMMENTARY===" lalu tulis commentary sebagai teks biasa (BUKAN di dalam JSON): analisa naratif mendalam 5 paragraf, pisah tiap paragraf dengan baris baru. PENTING — label "paragraf 1/2/3/4/5" di instruksi di bawah ini HANYA panduan urutan untukmu menulis, BUKAN teks yang harus muncul di output: paragraf 1-4 WAJIB ditulis sebagai prosa mengalir TANPA header/judul/angka urutan apapun di depannya (langsung mulai dengan kalimat isi). Paragraf 5 SATU-SATUNYA pengecualian yang harus mulai literal dengan kata "KESIMPULAN:" — jangan tambahkan header serupa di paragraf lain.',
      ...commentaryParas,
      '4 paragraf pertama wajib sebut minimal 2 angka konkret masing-masing (harga, %, atau nilai indikator); paragraf kelima minimal 1 angka (level trigger). DILARANG kalimat generik tanpa angka (misal "harga bergerak sideways", "momentum masih lemah", "perlu konfirmasi lebih lanjut" tanpa data pendukung) — setiap klaim harus berpijak pada angka yang ada di DATA TEKNIKAL.',
    ].join('\n');

    // QUAL-14: commentary dikeluarkan dari JSON (lihat delimiter "===COMMENTARY===" di userMsg)
    // — prosa panjang 4-5 paragraf sebagai string JSON rawan gagal JSON.parse (kutip/newline
    // tak ter-escape), yang dulu bikin structured null dan bias/entry/sl/tp hilang total.
    const messages = [
      { role: 'system', content: 'Kamu analis senior teknikal dan makro. WAJIB jawab dalam DUA bagian persis seperti diminta: (1) SATU objek JSON valid tanpa markdown fence berisi HANYA field {"bias":"...","entry_zone":"...","entry_basis":"...","sl":"...","tp":"...","trigger":"...","invalidation_condition":"...","invalidation_trigger":{"type":"...","level":0,"timeframe":"...","direction":"..."},"time_horizon_days":0,"makro_alignment":"...","makro_alignment_reason":"...","conflict":"...","conflict_note":"...","confidence":"..."} — invalidation_trigger boleh null kalau tidak bisa distrukturkan; JANGAN sertakan field commentary di JSON ini; (2) setelah JSON, baris berisi PERSIS "===COMMENTARY===", lalu teks commentary biasa (bukan JSON, bebas tanda kutip/baris baru). Bahasa Indonesia.' },
      { role: 'user',   content: userMsg },
    ];

    let rawText = null, model = null;

    // Diagnostik DeepSeek v4-flash API resmi (Plan O-6, 2026-07-18) — gate SEBELUM
    // promosi jadi primary Analisa per Pair (beda dari Ringkasan yang sudah dipromosikan
    // langsung di Plan O-3/market-digest.js: di sini kualitas belum divalidasi live untuk
    // tugas Entry/SL/TP numerik, jadi TETAP terisolasi total dari cache produksi sampai
    // dinilai). response_format json_object
    // TIDAK dipakai (beda dari Call 2/3 market-digest.js) karena skema jawaban di sini
    // dua-bagian (JSON + "===COMMENTARY===" + prosa), bukan JSON murni.
    const testDeepseekOnly = req.query.test_deepseek === '1' || req.body?.test_deepseek === true;
    let deepseekError = null, deepseekElapsedMs = null;

    // AATAS v2: jalur `isAutoCall` tidak lewat blok diagnostik ini lagi — prompt-nya
    // beda total (dua panggilan). Kombinasi `auto=1&test_deepseek=1` (uji konsistensi
    // daemon) tetap jalan: pipeline AATAS di bawah yang dipakai, dan `isDiagnosticOnly`
    // tetap menggerbang semua penulisan cache/setup_log seperti sebelumnya.
    if (testDeepseekOnly && !isAutoCall) {
      const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
      // PLAN V-3: breaker key khusus ':experimental' — blok ini SELALU diagnostik developer-only,
      // kegagalannya TIDAK BOLEH mentrip 'ai:deepseek' yang dipakai Ringkasan/Analisa/Pre-Entry publik.
      if (DEEPSEEK_KEY && await cb.canCall('ai:deepseek:experimental')) {
        const t0ds = Date.now();
        try {
          // Audit S218: counter kuota juga dipisah dari produksi ('deepseek_experimental'),
          // senada dengan circuit breaker ':experimental' di atas — blok ini SELALU
          // developer-only (test_deepseek=1), jangan makan pagar biaya publik.
          if (!await allowAiCall('deepseek_experimental')) throw new Error('AI daily budget exceeded');
          console.log('ohlcv_analyze: trying DeepSeek v4-flash (API resmi) — diagnostik test_deepseek=1');
          const r = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
            body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 1500, temperature: 0, thinking: { type: 'disabled' } }),
            signal: AbortSignal.timeout(20000),
          });
          if (r.ok) {
            const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
            if (rawText) await cb.onSuccess('ai:deepseek:experimental');
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
          await cb.onFailure('ai:deepseek:experimental');
        }
      } else if (DEEPSEEK_KEY) {
        deepseekError = 'circuit_open';
        console.log('ohlcv_analyze: test_deepseek=1 — circuit OPEN');
      } else {
        deepseekError = 'no_key';
        console.log('ohlcv_analyze: test_deepseek=1 — DEEPSEEK_API_KEY belum diset');
      }
    }

    // Diagnostik one-off (2026-08-17) — bandingkan deepseek-v4-pro vs flash persis di
    // titik Analisa AI per Pair (bukan cuma Ringkasan), pola isolasi identik dengan
    // blok flash di atas: circuit terpisah (ai:deepseek:pro_test), TIDAK PERNAH promosi
    // otomatis ke primary, TIDAK menyentuh cache produksi (lihat isDiagnosticOnly).
    const testDeepseekProOnly = req.query.test_deepseek_pro === '1' || req.body?.test_deepseek_pro === true;
    let deepseekProError = null, deepseekProElapsedMs = null;

    if (testDeepseekProOnly && !isAutoCall) {
      const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
      if (DEEPSEEK_KEY && await cb.canCall('ai:deepseek:pro_test')) {
        const t0dsp = Date.now();
        try {
          if (!await allowAiCall('deepseek_experimental')) throw new Error('AI daily budget exceeded');
          console.log('ohlcv_analyze: trying DeepSeek v4-pro — diagnostik test_deepseek_pro=1');
          const r = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
            body: JSON.stringify({ model: 'deepseek-v4-pro', messages, max_tokens: 1500, temperature: 0, thinking: { type: 'disabled' } }),
            signal: AbortSignal.timeout(30000),
          });
          if (r.ok) {
            const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-pro';
            if (rawText) await cb.onSuccess('ai:deepseek:pro_test');
            else throw new Error('Empty response');
          } else {
            const errJ = await r.json().catch(() => ({}));
            throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
          }
          deepseekProElapsedMs = Date.now() - t0dsp;
          console.log('ohlcv_analyze: DeepSeek v4-pro OK,', deepseekProElapsedMs, 'ms');
        } catch(e) {
          deepseekProElapsedMs = Date.now() - t0dsp;
          deepseekProError = e.message;
          console.warn('ohlcv_analyze DeepSeek v4-pro failed:', e.message);
          await cb.onFailure('ai:deepseek:pro_test');
        }
      } else if (DEEPSEEK_KEY) {
        deepseekProError = 'circuit_open';
        console.log('ohlcv_analyze: test_deepseek_pro=1 — circuit OPEN');
      } else {
        deepseekProError = 'no_key';
        console.log('ohlcv_analyze: test_deepseek_pro=1 — DEEPSEEK_API_KEY belum diset');
      }
    }

    // Dipakai untuk menggerbang cache produksi — SATU flag untuk SEMUA diagnostik
    // terisolasi (DeepSeek dkk), supaya nambah kandidat baru nanti tinggal OR ke sini,
    // bukan cari-cari tiap titik guard satu-satu.
    const isDiagnosticOnly = testDeepseekOnly || testDeepseekProOnly;
    // Scope terpisah dari DEEPSEEK_KEY di blok testDeepseekOnly di atas (itu lokal ke
    // if-block-nya sendiri) — dibutuhkan lagi di sini untuk tier primary produksi.
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

    // PLAN V-3 (2026-07-20): call isAutoCall (auto-entry, developer-only) berbagi provider
    // dengan traffic publik (Ringkasan/Analisa manual/Pre-Entry Check) — tanpa isolasi ini,
    // kegagalan eksperimen auto-entry bisa mentrip breaker yang sama dan menjatuhkan fitur
    // publik ke fallback padahal provider publik sebenarnya sehat. Key ':experimental'
    // terpisah total dari key produksi; 1 call = 1 key konsisten dari canCall sampai
    // onSuccess/onFailure (pakai konstanta ini, jangan tulis literal lagi).
    const isExperimental  = isAutoCall || testDeepseekOnly;
    const CB_DEEPSEEK_KEY   = isExperimental ? 'ai:deepseek:experimental' : 'ai:deepseek';
    // Audit S218: counter KUOTA HARIAN (beda dari circuit breaker di atas) sempat lupa
    // ikut dipisah — auto-entry & manual rebutan pool sama walau breaker-nya sudah
    // terisolasi sejak V-3.
    const AI_BUDGET_DEEPSEEK_KEY     = isExperimental ? 'deepseek_experimental' : 'deepseek';

    // Primary/satu-satunya (Plan O-6, 2026-07-18 promosi dari diagnostik ?test_deepseek=1;
    // 2026-08-12: SambaNova akun-1/akun-2 yang dulu jadi fallback berurutan di sini
    // DIPUTUS KONTRAK TOTAL — akunnya diblokir billing SambaNova sendiri, ganti API key
    // tidak memperbaikinya, lihat daun_merah_vendor.md). Kalau DeepSeek gagal/limit, fitur
    // ini sekarang tanpa fallback AI (tetap fungsional dengan data teknikal deterministik
    // saja, cuma commentary/structured setup AI-nya kosong).
    // AATAS v2 (2026-08-25): panggilan ini diekstrak ke `_callDeepSeekAnalyze` — config
    // (model, max_tokens 1500, temperature 0, timeout 25s, pool circuit/budget) SAMA
    // PERSIS seperti sebelumnya, cuma pindah tempat, supaya jalur manual dan dua
    // panggilan AATAS memakai satu implementasi circuit-breaker/budget yang sama.
    // Jalur `isAutoCall` TIDAK lewat sini — pipeline dua panggilannya tepat di bawah.
    if (!isAutoCall && !isDiagnosticOnly) {
      const r = await _callDeepSeekAnalyze(messages, {
        maxTokens: 1500, timeoutMs: 25000,
        cbKey: CB_DEEPSEEK_KEY, budgetKey: AI_BUDGET_DEEPSEEK_KEY,
        tag: `ohlcv_analyze ${data.label}`,
      });
      rawText = r.rawText;
      model = r.model;
    }

    // ── AATAS v2: pipeline dua panggilan (HANYA jalur auto-entry) ──────────────
    // Call 1 makro-only menentukan & mengunci arah, Gate 1 ditegakkan kode, baru Call 2
    // teknikal-only menentukan lokasi/waktu. Gate 1 gagal = Call 2 tidak pernah dipanggil.
    let aatasParsed = null, aatasCommentary = null, aatasGate1 = null, aatasPrompts = null;
    if (isAutoCall) {
      const run = await _runAatasTwoCall({
        label: data.label, isXau: data.is_xau,
        macroParts: aatasMacroParts, technicalParts: aatasTechParts,
        goldCorrLive,
        // Instruksi pemilihan level dipakai BERSAMA jalur manual — satu-satunya yang
        // berbeda klausanya (noSetupClauseAuto). Kalau tidak dikirim ke Call 2, AI tidak
        // tahu wajib memilih dari [ZONA KONFLUENSI]/[KANDIDAT SL/TP] dan snap-atau-tolak
        // di hilir akan menolak hampir semua levelnya.
        levelInstrs: [
          buildEntryZoneInstr(noSetupClauseAuto),
          entryBasisInstr,
          slInstr,
          tpInstr,
        ],
        invalidationTail: levelCandidates
          ? ' Kalau type-nya "price_level" atau "swing_break", SEBAIKNYA level ini sama dengan salah satu angka di [KANDIDAT SL/TP] atau [ZONA KONFLUENSI] di atas (bukan angka baru yang tidak berkaitan) — konsisten dengan sl yang kamu pilih.'
          : '',
        aiCfg: {
          // isExperimental sudah true untuk isAutoCall -> pool ':experimental' terpisah
          // dari traffic publik (isolasi PLAN V-3), berlaku juga saat probe konsistensi
          // daemon memakai test_deepseek=1 bersamaan.
          cbKey: CB_DEEPSEEK_KEY, budgetKey: AI_BUDGET_DEEPSEEK_KEY,
          modelName: testDeepseekProOnly ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
        },
      });
      aatasParsed = run.parsed;
      aatasCommentary = run.commentary;
      aatasGate1 = run.gate1;
      aatasPrompts = run.prompts;
      model = run.model;
      if (run.error) deepseekError = run.error;
    }

    let structured = null, commentary = aatasParsed ? aatasCommentary : rawText;
    // [SISTEM HAKIM] tag pengukuran (2026-07-29) — TIDAK dipakai gate/keputusan apa pun,
    // murni observasi ditulis ke setup_log_auto untuk analisis kalibrasi terpisah (lihat
    // _sistemHakimCalibration). evaluated=false berarti cbDir tidak tersedia sama sekali
    // (beda dari "dicek, ternyata selaras" — sama filosofi confidence:null vs 'rendah').
    let sistemHakimEvaluated = false, sistemHakimFired = false, conflictForcedBySistemHakim = false, sistemHakimCorrected = false;
    // [CEK KONTRADIKSI] lihat _detectAlignmentReasonContradiction — independen dari cbDir,
    // bisa nyala walau Sistem Hakim di atas diam (data central-bank-bias tidak lengkap).
    let contradictionGuardFired = false;
    if (rawText || aatasParsed) {
      try {
        // Pemisahan JSON vs prosa dilakukan SEBELUM menyentuh JSON — prosa hidup sebagai
        // teks biasa setelah delimiter, jadi tidak pernah perlu selamat dari escaping
        // string JSON (akar kegagalan parse QUAL-14 dulu). Logikanya sekarang di
        // `_splitJsonCommentary` supaya dipakai bersama dua panggilan AATAS.
        //
        // AATAS v2: jalur auto sudah membawa objek hasil parse dari `_runAatasTwoCall`,
        // bentuknya SENGAJA sama persis dengan jawaban satu-panggilan jalur manual —
        // supaya SELURUH logika hilir di bawah (snap ke [KANDIDAT SL/TP], sanity-check
        // arah & RR, normalisasi, gate AATAS, Gate A/B/D, penulisan setup_log) dipakai
        // bersama, bukan diduplikasi jadi dua jalur yang gampang divergen.
        let parsed, commentaryPart;
        if (aatasParsed) {
          parsed = aatasParsed;
          commentaryPart = aatasCommentary;
        } else {
          const split = _splitJsonCommentary(rawText);
          parsed = JSON.parse(split.jsonText);
          commentaryPart = split.commentary;
        }
        // Normalize bias (incl. "mixed/conflicting" per QUAL-7 — don't force into neutral)
        const biasRaw = (parsed.bias || '').toLowerCase().replace(/[^a-z]/g, '');
        const mixedAliases = ['mixed', 'conflicting', 'campuran', 'konflik'];
        parsed.bias = ['bullish', 'bearish', 'neutral'].includes(biasRaw) ? biasRaw
          : mixedAliases.includes(biasRaw) ? 'mixed' : 'neutral';
        structured    = parsed;
        commentary    = commentaryPart || parsed.commentary || rawText;
        // AATAS v2: narasi 5 paragraf DIHAPUS untuk jalur auto (dashboard developer sudah
        // merender tiap field checklist sebagai kartu terpisah — narasinya duplikat &
        // boros token). `reasoning_note` (gabungan 1 paragraf makro + 1 paragraf teknikal)
        // TETAP ada dan tersimpan; itu satu-satunya jejak naratif untuk audit kualitatif,
        // dan justru teks bebas seperti itu yang dulu membuat pola kesalahan ketahuan.
        if (isAutoCall) commentary = null;
        if (structured.time_horizon_days != null) {
          const h = Number(structured.time_horizon_days);
          structured.time_horizon_days = isNaN(h) ? null : h;
        }

        // PLAN Z (2026-08-18): snap sl/tp ke [KANDIDAT SL/TP] (api/_levels.js) kalau
        // tersedia untuk bias yang dipilih AI — samakan filosofi dengan entry_zone
        // (sudah lama dipaksa dari [ZONA KONFLUENSI]). AI yang menulis angka DALAM
        // toleransi cluster zona (levelCandidates.tolerance — granularitas SAMA yang
        // dipakai _confluenceZones menyatukan level berdekatan) disamakan presisinya
        // ke kandidat itu (snap, hilangkan drift pembulatan AI); yang menyimpang jauh
        // dari SEMUA kandidat dianggap tidak patuh instruksi -> level trio di-null-kan
        // (perlakuan SAMA seperti sanity-check RR/direction di bawah — BUKAN mekanisme
        // penolakan baru). levelCandidates null (data minim) atau bias bukan
        // bullish/bearish -> langkah ini dilewati total, fallback ke instruksi lama
        // tanpa constraint tambahan (pola dua-varian yang sama seperti entryZoneInstr).
        if (levelCandidates && structured.sl && structured.tp
          && (structured.bias === 'bearish' || structured.bias === 'bullish')) {
          const dir = levelCandidates[structured.bias]; // { sl:[...], tp:[...] } | null
          if (dir) {
            const numsLC = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
            const snapTo = (rawVal, pool) => {
              const val = numsLC(rawVal)[0];
              if (val == null || !pool?.length) return null;
              let best = null, bestDist = Infinity;
              for (const c of pool) {
                const dist = Math.abs(c.price - val);
                if (dist < bestDist) { bestDist = dist; best = c; }
              }
              return bestDist <= levelCandidates.tolerance ? best : null;
            };
            const slSnap = snapTo(structured.sl, dir.sl);
            const tpSnap = snapTo(structured.tp, dir.tp);
            if (slSnap && tpSnap) {
              structured.sl = slSnap.price.toFixed(levelCandidates.dec);
              structured.tp = tpSnap.price.toFixed(levelCandidates.dec);
            } else {
              console.warn('ohlcv_analyze: sl/tp di luar [KANDIDAT SL/TP] — level trio di-null-kan', { bias: structured.bias, sl: structured.sl, tp: structured.tp });
              structured.entry_zone = structured.sl = structured.tp = null;
            }
          }
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
            // BUG DITEMUKAN & DIFIX (2026-08-25, user melihat chart CHF/JPY di dashboard:
            // marker "Filled" jauh dari garis Entry, harga tidak pernah menyentuh entry tapi
            // status sudah `open`). Pemeriksaan di atas membandingkan harga berjalan dengan
            // SL dan TP, tapi TIDAK PERNAH dengan entry_zone itu sendiri — satu-satunya
            // level yang justru menentukan kapan posisi dianggap terisi.
            //
            // Akibatnya (khusus jalur auto, lewat refine-in-place): level baru bisa mendarat
            // di sisi SALAH dari harga — entry jual di BAWAH harga berjalan, atau entry beli
            // di ATAS harga berjalan. Deteksi fill (`_evaluateSetups`, cari "const filled =")
            // menyimpulkan arah tunggu dari `bias` saja: bearish -> terisi begitu ada candle
            // dengan high >= entry. Kalau entry sudah di bawah harga, syarat itu dipenuhi
            // candle APA PUN — setup langsung ditandai `open` di harga yang tidak pernah
            // dipakai, bahkan retroaktif ke jam sebelum level itu ditulis.
            //
            // Kasus nyata: CHF/JPY entry di-refine ke 198.011 saat harga 198.424 -> ditandai
            // terisi pada candle 198.285-198.470; EUR/GBP entry di-refine ke 0.85613 saat
            // harga 0.85600 -> ditandai terisi pada candle 0.85560-0.85606. Dari 13 setup
            // yang candle-nya masih bisa dicek, 3 entry-nya di sisi salah dan KETIGANYA
            // hasil refine — nol setup yang LAHIR di sisi salah.
            //
            // Fix: entry wajib di sisi TUNGGU yang benar terhadap harga berjalan (jual =
            // entry >= harga, tunggu rally; beli = entry <= harga, tunggu pullback). Ini
            // sekaligus membuat rumus deteksi fill yang ada BENAR DENGAN SENDIRINYA, tanpa
            // mengubah rumusnya. Harga yang sedang berada DI DALAM zona tetap sah (batas
            // pakai <=/>=) — itu fill sah pada harga zona itu juga.
            //
            // Entry breakout/breakdown (sisi sebaliknya, ditunggu dari arah lain) SENGAJA
            // TIDAK didukung: AATAS Step 5 sendiri meminta entry di area pullback/retest
            // "bukan di tengah impuls", dan data live menunjukkan AI tidak pernah sekali pun
            // membuatnya saat setup lahir. Membangun jalur khusus untuknya berarti menambah
            // mekanisme yang tidak pernah terpakai dan belum tervalidasi.
            //
            // DIGERBANG `isAutoCall`: jalur manual publik ("Analisa AI") TIDAK disentuh —
            // isolasi Opsi A. Manual juga tidak pernah kena refine (refine hanya untuk auto),
            // jadi jalur itu tidak punya mekanisme yang memindahkan entry ke sisi salah.
            // Gate untuk refine-nya sendiri TIDAK perlu kode terpisah: blok penulisan
            // setup_log di bawah (termasuk cabang refineCandidate) mensyaratkan
            // entry_zone+sl+tp non-null, jadi menolak level di sini otomatis membatalkan
            // refine dan MEMPERTAHANKAN level lama apa adanya.
            if (valid && isAutoCall) {
              const entrySideOk = structured.bias === 'bearish' ? nowPrice <= entryHigh
                : structured.bias === 'bullish' ? nowPrice >= entryLow
                  : true;
              if (!entrySideOk) {
                console.warn('ohlcv_analyze: entry di sisi SALAH dari harga berjalan — level ditolak (refine dibatalkan, level lama dipertahankan)', {
                  symbol, bias: structured.bias, entry_zone: structured.entry_zone, nowPrice,
                });
                valid = false;
              }
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

        // PLAN U-2: normalisasi conflict (none/arah/waktu) — dipakai U-4 (checklist
        // dua-kelas) & setup_log.alignment di bawah. Default "none" kalau model tidak
        // patuh skema, bukan null (beda dari makro_alignment yang boleh null-tanpa-data
        // — conflict SELALU punya jawaban karena tidak bergantung sumber makro saja).
        const CONFLICT_CANON = new Set(['none', 'arah', 'waktu']);
        const conflictRaw = String(structured.conflict || '').toLowerCase().replace(/[^a-z]/g, '');
        structured.conflict = CONFLICT_CANON.has(conflictRaw) ? conflictRaw : 'none';
        structured.conflict_note = (structured.conflict !== 'none' && typeof structured.conflict_note === 'string' && structured.conflict_note.trim())
          ? structured.conflict_note.trim()
          : null;

        // Riset tambahan (2026-07-20, item #5 diskusi user): normalisasi confidence
        // (tinggi/sedang/rendah) — dipakai kalibrasi win-rate per level di setup_stats
        // (_confidenceCalibration). BEDA dari conflict: kalau model tidak patuh skema,
        // default NULL (bukan dipaksa satu nilai) — memaksa nilai keliru mencemari data
        // kalibrasi, lebih aman diskip daripada dilabeli salah.
        const CONFIDENCE_CANON = new Set(['tinggi', 'sedang', 'rendah']);
        const confidenceRaw = String(structured.confidence || '').toLowerCase().replace(/[^a-z]/g, '');
        structured.confidence = (structured.entry_zone && CONFIDENCE_CANON.has(confidenceRaw)) ? confidenceRaw : null;

        // Track 1 (Road to Professional LLM Trader, 2026-08-04): invalidation_trigger
        // terstruktur, PARALEL dengan invalidation_condition (teks bebas, tidak diubah
        // di sini). Validasi ketat — fail-open ke null kalau AI tidak patuh skema atau
        // level bukan angka valid (prinsip sama confidence di atas: JANGAN paksa AI
        // mengarang angka, mending kosong daripada salah).
        {
          const t = structured.invalidation_trigger;
          const level = Number(t?.level);
          const validTrigger = t && INVALIDATION_TRIGGER_TYPES.has(t.type)
            && INVALIDATION_TRIGGER_DIRECTIONS.has(t.direction)
            && Number.isFinite(level);
          structured.invalidation_trigger = validTrigger ? {
            type: t.type, level,
            timeframe: INVALIDATION_TRIGGER_TIMEFRAMES.has(t.timeframe) ? t.timeframe : '1h',
            direction: t.direction,
          } : null;
        }

        // ── AATAS (2026-08-22): normalisasi field checklist + penegakan GATE ────────
        // Dijalankan SETELAH seluruh sanity-check level (arah vs harga, RR, snap ke
        // [KANDIDAT SL/TP]) supaya keputusan "batalkan setup" di bawah punya gambaran
        // final, bukan level yang masih mungkin di-null-kan blok lain sesudahnya.
        if (isAutoCall) {
          Object.assign(structured, _normalizeAatasFields(structured));
          // makro_alignment/reason BUKAN bagian skema AATAS lagi. Dinolkan EKSPLISIT
          // (bukan sekadar "tidak diminta") supaya model yang tetap mengirimnya karena
          // kebiasaan tidak meninggalkan label menyesatkan di log auto — pembaca data
          // nanti akan mengira konsep alignment masih hidup di populasi ini.
          structured.makro_alignment = null;
          structured.makro_alignment_reason = null;
          // Step 0 cabang gold — SATU-SATUNYA hard-block baru dari porting AATAS.
          // Pembagian sumber disengaja: penilaian kualitatif (apakah Real Yield/DXY/
          // Risk Regime sepakat) milik model, sedangkan FAKTA anomali korelasi dihitung
          // KODE dari cache correlations_v3 — angka tidak boleh ikut dikarang model.
          const goldReport = (data.is_xau && structured.regime_check) ? structured.regime_check.gold : null;
          const goldUnanimous = (goldReport && (goldReport.unanimous === true || goldReport.unanimous === false))
            ? goldReport.unanimous : null;
          const goldBlocked = !!data.is_xau && isGoldRegimeBlocked({
            unanimous: goldUnanimous,
            corrAnomaly: goldCorrLive ? goldCorrLive.anomaly : null,
          });
          const rejectReason = _aatasRejectReason({
            gate_validitas_driver: structured.gate_validitas_driver,
            gate_risk_management: structured.gate_risk_management,
            verdict: structured.verdict,
            goldBlocked,
            gate1Override: aatasGate1 ? aatasGate1.override_reason : null,
          });
          structured.aatas_reject_reason = rejectReason;
          // Observabilitas v2 (poin 11 plan): berapa kali KODE — bukan laporan AI —
          // yang menggagalkan Step 1-2. Tanpa angka ini, pertanyaan "apakah gate baru
          // ini kelewat ketat/longgar?" cuma bisa dijawab dengan tebakan. Pola sama
          // `auto_guard_stats:*` yang sudah ada: INCR polos, fire-and-forget, gagal
          // tidak pernah menggagalkan alur auto-entry.
          // `!isDiagnosticOnly` WAJIB: probe uji konsistensi daemon memanggil jalur ini
          // 3x/hari dengan `auto=1&test_deepseek=1` — tanpa gerbang itu, counter yang
          // gunanya mengukur laju penolakan PRODUKSI akan diisi lalu lintas diagnostik.
          if (!isDiagnosticOnly && aatasGate1 && aatasGate1.override_reason) {
            redisCmd('INCR', 'auto_guard_stats:gate1_code_override').catch(() => {});
          }
          if (rejectReason && (structured.entry_zone || structured.sl || structured.tp)) {
            // Level di-null-kan = setup tidak pernah lahir (blok penulisan setup_log di
            // bawah mensyaratkan entry_zone+sl+tp). Bias/commentary/field checklist TETAP
            // dikembalikan ke daemon supaya alasan penolakan tidak hilang dari log runtime.
            console.warn('AATAS: kandidat dibatalkan sebelum jadi setup', {
              symbol, reason: rejectReason, verdict: structured.verdict, pct: structured.checklist_pct,
            });
            structured.entry_zone = structured.sl = structured.tp = structured.entry_basis = null;
            structured.risk_reward = null;
          }
        }

        // [SISTEM HAKIM] Soft Block (Hak Veto User) - Mencegat halusinasi makro_alignment
        // AATAS (2026-08-22): DILEWATI untuk jalur auto — field yang dikoreksinya
        // (`makro_alignment`) sudah tidak diproduksi di jalur itu, dan pekerjaannya
        // (membandingkan arah makro vs bias) sekarang jadi urutan keputusan itu sendiri
        // (Step 0-2 menentukan arah, bukan membandingkannya belakangan). Kodenya TIDAK
        // dihapus: jalur manual publik masih memakainya persis seperti sebelumnya.
        // Konsekuensi yang DISENGAJA & wajib diketahui pembaca berikutnya:
        //  - `sistem_hakim` di setup auto baru selalu null -> _sistemHakimCalibration
        //    (fired/clear/corrected) PERMANEN kosong untuk populasi AATAS. Histori lama
        //    tetap valid. Itu bukan data hilang.
        //  - tidak ada lagi yang men-set conflict='arah' di jalur auto selain model sendiri,
        //    jadi Gate E (isTimingConflictBlocked) di sana praktis cuma akan melihat
        //    'waktu'/'none', dan `isWhipsaw` (conflict==='arah', Flip Guard) nyaris tidak
        //    pernah true lagi di jalur auto. Bukan gate rusak.
        if (cbDir && structured.bias && !isAutoCall) {
          sistemHakimEvaluated = true;
          const techBias = structured.bias.toLowerCase();
          const isTechLong = techBias.includes('bullish') || techBias === 'long';
          const isTechShort = techBias.includes('bearish') || techBias === 'short';

          if ((cbDir === 'long' && isTechShort) || (cbDir === 'short' && isTechLong)) {
            sistemHakimFired = true;
            structured.makro_alignment = 'konflik';
            structured.makro_alignment_reason = '[SISTEM HAKIM] Terdeteksi konflik nyata antara arah Makro/Fundamental dan Teknikal. Setup ini melanggar aturan konfluensi makro.';
            // Veto sistem = konflik arah nyata terverifikasi kode, bukan cuma klaim model —
            // paksa conflict='arah' kecuali model sudah lapor 'waktu' (lebih serius, jangan ditimpa turun).
            if (structured.conflict !== 'waktu') {
              conflictForcedBySistemHakim = structured.conflict !== 'arah';
              structured.conflict = 'arah';
              structured.conflict_note = structured.makro_alignment_reason;
            }
          } else if ((cbDir === 'long' && isTechLong) || (cbDir === 'short' && isTechShort)) {
            // Koreksi arah SEBALIKNYA (2026-08-05, ditemukan dari audit kasus nyata
            // AUDNZD:1785849311337): veto di atas hanya menangkap AI yang GAGAL
            // melihat konflik nyata. Tidak ada rem untuk kebalikannya — AI mengklaim
            // 'konflik'/arah' sendiri (di makro_alignment/conflict, teks bebas) padahal
            // cbDir (hitungan objektif dari cb_bias, sudah lolos syarat confidence
            // High + tanpa divergence_warning) justru SEARAH dengan bias teknikalnya.
            // Klaim salah begini menyeret setup ke jalur "hati-hati" (Gate A/Kritikus,
            // rawan tighten_sl reaktif) tanpa alasan nyata. cbDir tetap sumber kebenaran
            // terverifikasi kode di sini juga, jadi koreksi balik ke 'searah'/'none'.
            if (structured.makro_alignment === 'konflik') {
              sistemHakimCorrected = true;
              structured.makro_alignment = 'searah';
              structured.makro_alignment_reason = '[SISTEM HAKIM] Klaim konflik dari AI dikoreksi — arah Makro/Fundamental (cbDir) sebenarnya SEARAH dengan bias teknikal.';
            }
            if (structured.conflict === 'arah') {
              sistemHakimCorrected = true;
              structured.conflict = 'none';
              structured.conflict_note = null;
            }
          }
        }
        // Telemetri frekuensi murni (2026-07-29) — HANYA jalur auto-entry (baru
        // diaktifkan di sini), supaya tidak bercampur dengan manual yang sudah lama
        // jalan. Beda family dari `auto_guard_stats:*` SENGAJA: Sistem Hakim bukan
        // gate (tidak pernah membatalkan penyimpanan sendiri), jadi jangan disalahpahami
        // sebagai gate ke-4. Baca via redis-keys?key=sistem_hakim_stats:*.
        // AATAS: blok Sistem Hakim di atas digerbang `!isAutoCall`, jadi ketiga counter
        // ini SUDAH TIDAK PERNAH bertambah lagi sejak 2026-08-22. Kondisinya dipertahankan
        // apa adanya (bukan dihapus) supaya kalau suatu saat Sistem Hakim dihidupkan lagi
        // di jalur auto, telemetrinya ikut hidup tanpa perlu diingat ulang.
        if (isAutoCall && sistemHakimEvaluated) {
          redisCmd('INCR', 'sistem_hakim_stats:considered').catch(() => {});
          if (sistemHakimFired) redisCmd('INCR', 'sistem_hakim_stats:fired').catch(() => {});
          if (sistemHakimCorrected) redisCmd('INCR', 'sistem_hakim_stats:corrected').catch(() => {});
        }

        // [CEK KONTRADIKSI] jalan TERPISAH dari blok Sistem Hakim di atas — cek berapa pun
        // status makro_alignment saat ini (termasuk hasil Sistem Hakim, tapi teksnya sendiri
        // tidak pernah menyebut arah currency jadi tidak akan kena regex). Hanya perlu koreksi
        // kalau saat ini masih 'searah' — 'konflik'/'netral' sudah aman.
        // AATAS: `!isAutoCall` ditulis EKSPLISIT walau makro_alignment jalur auto memang
        // selalu null (jadi kondisi ini tidak akan true) — supaya niatnya terbaca, bukan
        // bergantung pada efek samping yang bisa berubah diam-diam nanti.
        if (!isAutoCall && structured.makro_alignment === 'searah'
          && _detectAlignmentReasonContradiction(structured.makro_alignment_reason)) {
          contradictionGuardFired = true;
          const originalReason = structured.makro_alignment_reason;
          structured.makro_alignment = 'konflik';
          structured.makro_alignment_reason = `[CEK KONTRADIKSI] Reasoning asli AI menyebut arah berlawanan untuk mata uang yang sama (dugaan salah nalar arah), otomatis dikoreksi jadi konflik. Teks asli: "${originalReason}"`;
          if (structured.conflict !== 'waktu') {
            structured.conflict = 'arah';
            structured.conflict_note = structured.makro_alignment_reason;
          }
        }
        if (isAutoCall && contradictionGuardFired) {
          redisCmd('INCR', 'contradiction_guard_stats:fired').catch(() => {});
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
      // PLAN U-2: rezim volatilitas + currency strength diikutkan di payload supaya
      // U-4 bisa menampilkan tanpa call baru (numpang response existing).
      pair_context: { regime: pairCtx.regime, strength: pairCtx.strength },
      // Echo prompt persis yang dikirim ke model — HANYA saat diagnostik isolated
      // (2026-08-17, dipakai user buat verifikasi manual di web DeepSeek), tidak pernah
      // di jalur produksi.
      // AATAS v2: jalur auto punya DUA prompt (call1/call2) — dikembalikan apa adanya
      // supaya verifikasi manual di web DeepSeek tetap bisa mereproduksi keduanya.
      debug_prompt: isDiagnosticOnly
        ? (isAutoCall ? aatasPrompts : { system: messages[0].content, user: messages[1].content })
        : undefined,
    };

    if (!commentary && !structured) {
      resultPayload.error = 'DeepSeek sedang offline, timeout, atau limit harian habis';
    }

    // isDiagnosticOnly dikecualikan dari cache produksi — request diagnostik tidak boleh
    // menimpa hasil analisa AI real yang sedang ditampilkan ke user di tab Analisa.
    // PLAN U-7 (REVISI VISIBILITAS): call auto (isAutoCall) JUGA dikecualikan — eksperimen
    // developer-only, pengguna TIDAK PERNAH boleh melihat "Analisa sudah jadi"/auto-tick
    // checklist dari call daemon. Response HTTP ke daemon tetap payload penuh (di bawah),
    // hanya cache yang dibaca `mode=cached`/tab Analisa publik yang senyap.
    if ((commentary || structured) && !isDiagnosticOnly && !isAutoCall) {
      // TTL 4 hari (bukan cuma beberapa jam): analisa terakhir sebelum market tutup Jumat
      // 21:00 UTC harus tetap hidup di Redis sampai market buka lagi Minggu malam/Senin
      // pagi WIB — gate market_closed di atas (baris ~4125) numpang key yang sama untuk
      // menyajikan "analisa terakhir Jumat" sepanjang weekend; TTL pendek bikin key ini
      // hangus sebelum weekend berakhir dan gate jatuh ke pesan "belum ada analisa".
      redisCmd('SET', `ohlcv_analysis:${symbol}`, JSON.stringify(resultPayload), 'EX', 345600).catch(() => {});
    }
    // Outcome logging (Tier 1 riset, session 166): catat setiap setup lengkap supaya
    // win-rate NYATA bisa dihitung via ?action=setup_stats. Best-effort — kegagalan
    // logging tidak boleh menggagalkan response analisa. Dedup: setup aktif dengan
    // level identik di symbol yang sama tidak dicatat dua kali (re-generate tanpa
    // perubahan level = satu keputusan yang sama, bukan dua track record).
    // PLAN U-1 (2026-07-20): setup makro_alignment==='konflik' SEKARANG DICATAT (dulu
    // di-skip total) dengan alignment:'konflik' — supaya statistik bisa membandingkan
    // kinerja setup konflik vs selaras (U-6 gate).
    // PLAN U-2: `source` sekarang 'auto' kalau isAutoCall (auto=1 + CRON_SECRET valid,
    // dipakai U-3), default 'manual'. `alignment` diisi dari `conflict` (U-2) —
    // conflict!=='none' dipetakan ke 'konflik' (menimpa makro_alignment kalau perlu,
    // menangkap kasus model bilang makro_alignment='netral' tapi conflict='arah'/'waktu'
    // dari perbandingan lain), fallback ke makro_alignment kalau conflict 'none'.
    // PLAN U-7: setup dari call auto ditulis ke key TERPISAH `setup_log_auto:v1` (cap 200
    // sendiri) — BUKAN `setup_log:v1` (tracker/win-rate/cap milik pengguna tidak tersentuh).
    // Skema field identik (U-1 + U-5a), tidak ada skema kedua.
    // ── AATAS v2 (poin 11 plan): kandidat yang ditolak TIDAK dibuang ─────────────
    // Sebelum ini, kandidat auto yang gagal gate cuma ada di response HTTP ke daemon —
    // begitu response dibalas, alasan penolakannya hilang permanen (tidak ada manusia
    // yang menonton saat cron jalan). Sekarang direkam.
    //
    // Ditulis ke KEY TERPISAH `aatas_reject_log:v1`, BUKAN menumpang `setup_log_auto:v1`
    // seperti tertulis di plan — perbedaan yang disengaja: setup_log_auto:v1 di-cap 200
    // entri dan itulah sampel n>=30 yang sedang dikumpulkan. Dengan 5 pair x 2 slot/hari,
    // kandidat tertolak bisa mengisi cap itu dalam ~3 minggu dan MENGGESER KELUAR setup
    // nyata yang jadi dasar statistik — merusak persis data yang mau dijaga. Pola list
    // terpisah ini sudah dipakai `auto_skip_log`/`surprise_log:v1` untuk kebutuhan yang
    // sama ("kenapa kita TIDAK entry"). Baca via redis-keys?key=aatas_reject_log:v1.
    if (isAutoCall && !isDiagnosticOnly && structured && structured.aatas_reject_reason) {
      const rejectEntry = {
        ts: Date.now(), symbol, label: data.label,
        reason: structured.aatas_reject_reason,
        bias: structured.bias ?? null,
        regime_check: structured.regime_check ?? null,
        gate_validitas_driver: structured.gate_validitas_driver ?? null,
        gate_risk_management: structured.gate_risk_management ?? null,
        fundamental_bias: structured.fundamental_bias ?? null,
        technical: structured.technical ?? null,
        final_validation: structured.final_validation ?? null,
        checklist_pct: structured.checklist_pct ?? null,
        verdict: structured.verdict ?? null,
        reasoning_note: structured.reasoning_note ?? null,
        conflict: structured.conflict ?? null,
        regime: autoGuardRegime,
        model, policy_v: POLICY_VERSION, aatas_v: AATAS_PROMPT_VERSION,
      };
      // Fire-and-forget: kegagalan pencatatan TIDAK PERNAH boleh menggagalkan response
      // analisa (prinsip sama seluruh logging di handler ini).
      redisCmd('LPUSH', 'aatas_reject_log:v1', JSON.stringify(rejectEntry))
        .then(() => redisCmd('LTRIM', 'aatas_reject_log:v1', '0', '199'))
        .catch(() => {});
    }

    if (structured?.entry_zone && structured.sl && structured.tp && !isDiagnosticOnly) {
      const setupLogKey = isAutoCall ? 'setup_log_auto:v1' : 'setup_log:v1';
      // PLAN U-3 lanjutan (2026-07-20, diskusi user): baca-ubah-tulis array ini TIDAK
      // atomik — kalau AUTO_ENTRY_PAIRS diperluas (>1 pair berbagi array yang sama) dan
      // dua request nyaris bersamaan, yang nulis belakangan bisa menimpa perubahan yang
      // nulis duluan (lost update). Lock singkat (pola sama lock:market_digest_generate)
      // menyerialkan penulisan per key; kalau lock lagi dipegang, skip logging kali ini
      // saja (best-effort — kegagalan logging TIDAK PERNAH boleh menggagalkan response
      // analisa, sama seperti sebelumnya).
      const lockKey = `lock:setuplog_write:${setupLogKey}`;
      // BUG DITEMUKAN & DIFIX (2026-07-29, audit lanjutan celah kesalahan trader): lock
      // ini TTL 10 detik, tapi Gate A (AI Kritikus, _runCriticVerdict) timeout 25 detik —
      // sebelumnya seluruh Gate D/B/A + tulis akhir terjadi di BAWAH SATU lock yang sama,
      // jadi TIAP KALI Gate A benar-benar terpanggil, lock itu sudah kedaluwarsa jauh
      // sebelum selesai (window nyata utk proses lain menulis array yang sama -> lost
      // update). positionReviewHandler SUDAH punya pola yang benar untuk masalah yang
      // SAMA (lihat komentar `race_detected` di dekat lockKey2 di atas): lock dilepas
      // SEBELUM AI call, state dibaca ULANG & divalidasi di bawah lock BARU tepat sebelum
      // menulis. Pola itu direplikasi di sini via 2 fase: Fase 1 (di bawah) = semua
      // keputusan CEPAT (dup/openSame/stalePending refine-atau-flip, Gate D/B) — kalau
      // tidak perlu Gate A, selesai & tersimpan di sini juga (manual SELALU lewat sini,
      // Gate A tidak pernah menyentuh manual). Fase 2 (di bawah, di luar lock) = Gate A
      // (AI) TANPA lock, lalu re-acquire + baca ulang state segar sebelum tulis akhir.
      const buildNewSetupEntry = () => ({
        id: `${symbol}:${Date.now()}`,
        symbol, label: data.label, bias: structured.bias,
        entry_zone: structured.entry_zone, sl: structured.sl, tp: structured.tp,
        rr: structured.risk_reward ?? null,
        // Narasi lengkap AI (2026-08-10, diskusi user — audit CHF/JPY: bias tetap
        // bullish walau makro_alignment "konflik" itu SAH karena bias murni dari
        // teknikal (Daily+H4+BOS), sedangkan makro_alignment field terpisah yang
        // membandingkan.
        // PREMIS DI ATAS SUDAH TIDAK BERLAKU UNTUK JALUR AUTO sejak AATAS (2026-08-22):
        // di sana bias TIDAK LAGI murni teknikal — arah lahir dari makro (Step 0-2) dan
        // teknikal cuma memilih lokasi/timing, jadi "bias melawan makro" bukan lagi
        // kondisi yang sah, melainkan justru yang dicegah. Rasionalisasi lama tetap
        // ditulis di sini apa adanya karena masih berlaku untuk jalur MANUAL publik —
        // jangan dibaca sebagai penjelasan perilaku auto-entry.
        // Alasan `commentary` disimpan tetap sama untuk dua jalur: penjelasan naratif cuma
        // ada di paragraf commentary, yang SEBELUM INI TIDAK PERNAH disimpan ke
        // setup_log_auto:v1 sama sekali — hilang permanen begitu response dibalas,
        // karena tidak ada manusia yang nonton live saat cron jalan). Disimpan apa
        // adanya (bisa null kalau model gagal generate teks), TANPA cap panjang —
        // sudah dibatasi alami oleh instruksi prompt (5 paragraf).
        commentary: commentary || null,
        horizon_days: structured.time_horizon_days ?? null,
        model, ts: Date.now(), level_set_at: Date.now(), status: 'pending',
        source: isAutoCall ? 'auto' : 'manual',
        // `alignment` (turunan lossy dari conflict + makro_alignment) SUPERSEDED untuk
        // jalur auto sejak AATAS: makro_alignment selalu null di sana, jadi nilainya cuma
        // 'konflik' (kalau ada conflict) atau null. Kriteria Plan U "bandingkan kinerja
        // alignment 'konflik' vs selaras untuk memvalidasi multiplier 0.5" TIDAK BOLEH
        // dihitung lagi dari populasi AATAS — pembandingnya sudah tidak ada. Field-nya
        // dipertahankan apa adanya karena masih dipakai jalur manual & histori lama.
        alignment: (structured.conflict && structured.conflict !== 'none')
          ? 'konflik'
          : (structured.makro_alignment || null),
        // `confidence` di jalur auto sekarang SELALU null (model tidak lagi diminta
        // mengisinya) — digantikan checklist_pct/verdict di bawah. Konsekuensi yang
        // disengaja: _confidenceCalibration ikut kosong untuk populasi AATAS.
        confidence: structured.confidence ?? null,
        // PLAN W (2026-07-24): sinyal mentah sebelum digabung jadi `alignment`
        // (lossy) — murni observasi, tidak dipakai keputusan apa pun di sini.
        conflict: structured.conflict ?? null,
        conflict_note: structured.conflict_note ?? null,
        makro_alignment: structured.makro_alignment ?? null,
        makro_alignment_reason: structured.makro_alignment_reason ?? null,
        // [SISTEM HAKIM] tag pengukuran (2026-07-29) — murni observasi, TIDAK dibaca
        // gate/Flip Guard/kalibrasi manapun yang sudah ada (lihat _sistemHakimCalibration
        // untuk agregat terpisah yang MEMBACA field ini). null = cbDir tidak tersedia
        // saat itu (fail-closed _computeCbDirServerSide, atau manual tanpa cbDir).
        sistem_hakim: sistemHakimEvaluated ? (sistemHakimFired ? 'fired' : (sistemHakimCorrected ? 'corrected' : 'clear')) : null,
        // BUG DITEMUKAN & DIFIX (audit end-to-end 2026-08-16): sebelumnya digerbang
        // `structured.conflict === 'arah'` — tapi Sistem Hakim & guard kontradiksi
        // SENGAJA mempertahankan conflict:'waktu' kalau sudah ada (lihat komentar
        // "jangan ditimpa turun" di kedua blok di atas), bukan menimpanya jadi 'arah'.
        // Akibatnya conflict_source diam-diam jatuh ke null persis saat salah satu
        // guard itu benar-benar aktif pada setup conflict:'waktu' — jejak audit hilang
        // padahal makro_alignment_reason sudah membawa prefix [SISTEM HAKIM]/[CEK
        // KONTRADIKSI]. Sekarang provenance guard diprioritaskan dulu, independen dari
        // nilai akhir conflict (contoh nyata ketahuan: CHFJPY=X:1786436246374).
        conflict_source: (conflictForcedBySistemHakim || contradictionGuardFired)
          ? (conflictForcedBySistemHakim ? 'sistem_hakim' : 'contradiction_guard')
          : (structured.conflict === 'arah' ? 'ai' : null),
        loss_label: null, label_reason: null, label_by: null,
        // PLAN U-5a: manajemen posisi VIRTUAL — null/0 = belum pernah direview.
        intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
        // Track 1 (Road to Professional LLM Trader, 2026-08-04): trigger invalidasi
        // teknikal terstruktur (nullable) — dicek deterministik oleh _evaluateTechInvalidation,
        // hasil deteksi ditulis ke `tech_invalidated` — field SENGAJA TERPISAH dari
        // `intervention`/`managed_status` (mekanisme AI U-5a) supaya tidak menghalangi
        // AI position review/tighten preventif Jumat menyentuh posisi yang sama.
        invalidation_trigger: structured.invalidation_trigger ?? null,
        tech_invalidated: null,
        // Snapshot makro (2026-08-08, diskusi user, lihat _buildMacroSnapshot) — nullable
        // kalau semua sumber cache kosong saat itu, sama fail-open-nya dengan `regime`.
        macro_snapshot: _buildMacroSnapshot({
          label: data.label, isXau: data.is_xau,
          cbBias: cbBiasParsed, cot: cotParsed, retail: retailParsed,
          risk: riskParsed, drivers: macroDrivers, rrPair: rrPairSnapshot,
        }),
        // Penanda versi framing prompt CME-vs-COT (2026-08-08, diskusi user — mitigasi
        // "gimana nanti bedain setup sebelum/sesudah reordering ini"). null = framing
        // lama (manual, atau auto tapi pair tanpa data CME); angka = framing baru
        // COT_CME_PROMPT_VERSION AKTIF saat setup ini dibuat. TIDAK sama dengan
        // macro_snapshot.v (itu versi SKEMA data, ini versi LOGIC prompt) — kalau
        // framing-nya direvisi lagi nanti, naikkan angka ini supaya generasi lama/baru
        // tetap bisa dibedakan tanpa nebak dari tanggal `ts`.
        cme_priority_prompt_v: (rrPairSnapshot && isAutoCall) ? COT_CME_PROMPT_VERSION : null,
        // Track 1b (Road to Professional LLM Trader, 2026-08-04, diskusi user):
        // rekam risk_regime SAAT setup dibuat — `autoGuardRegime` sudah dihitung
        // di atas untuk Gate B (nol fetch/panggilan tambahan), tapi cache
        // `risk_regime` (api/risk-regime.js) TTL 5 menit & selalu ditimpa, TIDAK
        // ada arsip historis. Kalau tidak direkam di sini, regime yang berlaku di
        // tanggal setup ini dibuat SULIT direkonstruksi lagi nanti (VIX/MOVE/HY
        // historis publik masih ada, tapi butuh backfill terpisah) — sementara
        // merekamnya sekarang gratis. Dipakai nanti untuk Plan U item #10
        // (`daun_merah_progress.md`, kondisional pada bukti confluence zone
        // regime-dependent) DAN audit apakah bias yang dipilih AI benar-benar
        // konsisten dengan regime (risk_off -> condong safe haven, dst).
        regime: autoGuardRegime,
        // Stempel versi kebijakan auto-entry (2026-08-18, keputusan user pasca-audit
        // menyeluruh) — lihat POLICY_EPOCHS di api/_auto_entry_guard.js untuk daftar
        // lengkap versi + apa yang berubah di tiap versi. Tanpa ini, sampel n>=100
        // yang sedang dikumpulkan tidak bisa dipisahkan per rezim kebijakan (jalur
        // keputusan sudah berubah ±26 kali sejak deploy Plan U). Distempel juga di
        // jalur refine-in-place di bawah — level yang benar-benar live itu lahir dari
        // kebijakan SAAT refine, bukan saat setup pertama dibuat.
        //
        // DIGERBANG `isAutoCall` (bukan distempel ke semua setup): closure ini dipakai
        // BERSAMA oleh setup_log:v1 (manual, payload PUBLIK) dan setup_log_auto:v1
        // (auto). POLICY_EPOCHS seluruhnya bicara soal kebijakan auto-entry — Gate A/B/D
        // bahkan TIDAK PERNAH jalan untuk manual — jadi menempelkan versinya ke entri
        // manual (a) menyesatkan: seolah aturan itu berlaku di sana, dan (b) menyalahi
        // isolasi senyap U-7: field bernuansa eksperimen auto-entry tidak boleh muncul di
        // payload publik. Sengaja DIHILANGKAN SAMA SEKALI untuk manual (spread kondisional),
        // bukan diisi `null` seperti `cme_priority_prompt_v` di atas — U-7 melarang
        // PERUBAHAN payload publik, dan key baru bernilai null tetap perubahan payload.
        // Beda pola dengan tetangganya itu disengaja, bukan kelalaian.
        ...(isAutoCall ? { policy_v: POLICY_VERSION } : {}),
        // AATAS (2026-08-22): jejak keputusan per-step. Pola spread-kondisional yang SAMA
        // dengan policy_v di atas (bukan diisi null untuk manual) — closure ini dipakai
        // bersama setup_log:v1 (payload PUBLIK), dan key baru bernilai null pun tetap
        // perubahan payload publik yang dilarang isolasi senyap U-7.
        // `reasoning_note` WAJIB ikut disimpan walau sudah ada field terstruktur di
        // atasnya: audit yang menemukan pola fade-tren & conflict='waktu' cuma mungkin
        // karena ada teks bebas yang bisa dibaca ulang manusia/AI lain. Skema terstruktur
        // hanya menangkap pertanyaan yang sudah terpikirkan saat skema dibuat.
        ...(isAutoCall ? {
          regime_check: structured.regime_check ?? null,
          gate_validitas_driver: structured.gate_validitas_driver ?? null,
          gate_risk_management: structured.gate_risk_management ?? null,
          fundamental_bias: structured.fundamental_bias ?? null,
          technical: structured.technical ?? null,
          final_validation: structured.final_validation ?? null,
          checklist_pct: structured.checklist_pct ?? null,
          verdict: structured.verdict ?? null,
          reasoning_note: structured.reasoning_note ?? null,
          aatas_v: AATAS_PROMPT_VERSION,
        } : {}),
      });
      let needsGateA = false;
      // Gate A (Kritikus) juga menimbang refine-in-place (2026-08-18, lihat catatan lengkap di
      // blok "Skenario Refinemen" di bawah) — level baru di-stage di sini dulu, diterapkan di
      // Fase 2 SETELAH Gate A, bukan langsung ditulis seperti sebelumnya.
      let refineCandidate = null;
      const gotLock = await _acquireLockWithRetry(lockKey);
      if (!gotLock) {
        console.warn(`setup_log write GAGAL PERMANEN setelah retry: lock ${lockKey} sedang dipegang — sinyal AI hilang, tidak tersimpan`);
      } else { try {
        const rawLog = await redisCmd('GET', setupLogKey);
        let log = rawLog ? JSON.parse(rawLog) : [];
        if (!Array.isArray(log)) log = [];
        const dup = log.find(x => x && x.symbol === symbol
          && (x.status === 'pending' || x.status === 'open')
          && x.entry_zone === structured.entry_zone && x.sl === structured.sl && x.tp === structured.tp);
        // PLAN U-3 lanjutan (2026-07-20, diskusi user): auto-entry berjadwal (2 slot/hari)
        // bisa numpuk >1 posisi virtual PENDING di symbol yang sama kalau AI ganti level
        // antar-slot (bukan exact-match `dup` di atas) — mencemari statistik n>=100 dengan
        // sampel yang berkorelasi (satu pergerakan harga dihitung sebagai >1 kejadian).
        // Kebijakan HANYA untuk auto (manual TIDAK diubah — tiap klik manual = keputusan
        // sengaja per klik, bukan hasil jadwal): kalau symbol sudah punya posisi OPEN
        // (harga sudah masuk zona entry), skip total — jangan numpuk risk di atas posisi
        // yang sudah live, itu ranahnya Review Posisi (U-5) via trigger berita, bukan
        // auto-replace buta di sini. Kalau cuma ada PENDING lama (belum kena harga sama
        // sekali), batalkan (status:'canceled', TIDAK masuk win-rate manapun — U-1) lalu
        // tetap catat analisa terbaru — supaya pandangan AI yang lebih baru tetap kepakai
        // (bukan di-skip begitu saja), tapi cuma 1 ide aktif per symbol setiap saat.
        let blockedByOpenPosition = false;
        let shouldSaveLog = false;
        if (isAutoCall && !dup) {
          const openSame = log.find(x => x && x.symbol === symbol && x.status === 'open');
          if (openSame) {
            blockedByOpenPosition = true;
          } else {
            const stalePending = log.find(x => x && x.symbol === symbol && x.status === 'pending');
            if (stalePending) {
              if (stalePending.bias === structured.bias) {
                // Skenario Refinemen (bias searah): STAGE level baru dulu — JANGAN ditulis
                // langsung. BUG DITEMUKAN & DIFIX (2026-08-18, audit lanjutan investigasi SL
                // AUD/NZD): sebelum ini, refine-in-place LANGSUNG menimpa stalePending +
                // `blockedByOpenPosition = true` dipasang di sini — efek sampingnya,
                // `autoGuardConsidered` (baris ~6018) jadi SELALU false untuk refine, artinya
                // Gate A (Kritikus) TIDAK PERNAH kebagian giliran mengaudit level FINAL yang
                // benar-benar live, cuma sempat lihat generasi PERTAMA (kalau itu pun lolos
                // Gate D/B). Sekarang level baru di-stage ke `refineCandidate`, diterapkan di
                // Fase 2 SETELAH Gate A (pola sama persis `buildNewSetupEntry()` untuk
                // kandidat baru) — kalau Kritikus verdict "batalkan", level lama TETAP
                // dipertahankan apa adanya, refine ini dianggap tidak pernah terjadi.
                refineCandidate = {
                  id: stalePending.id,
                  fields: {
                    entry_zone: structured.entry_zone,
                    sl: structured.sl,
                    tp: structured.tp,
                    rr: structured.risk_reward != null ? structured.risk_reward : stalePending.rr,
                    horizon_days: structured.time_horizon_days != null ? structured.time_horizon_days : stalePending.horizon_days,
                    confidence: structured.confidence != null ? structured.confidence : stalePending.confidence,
                    // Track 1 (2026-08-04): trigger invalidasi ikut diperbarui ke generasi
                    // terbaru, pola sama field lain di blok refine ini — jangan nyimpen
                    // trigger dari generasi pertama yang mungkin sudah tidak relevan.
                    // `tech_invalidated` di-reset (kalaupun sempat kesentuh sebelum refine
                    // ini, itu milik trigger LAMA — thesis baru butuh evaluasi fresh dari nol).
                    invalidation_trigger: structured.invalidation_trigger ?? null,
                    tech_invalidated: null,
                    // Track 1b (2026-08-04): regime ikut diperbarui ke generasi TERBARU —
                    // pola sama field lain di blok refine ini, thesis baru dievaluasi
                    // dengan konteks rezim SAAT refine ini terjadi, bukan snapshot lama.
                    regime: autoGuardRegime,
                    alignment: (structured.conflict && structured.conflict !== 'none')
                      ? 'konflik'
                      : (structured.makro_alignment || null),
                    // PLAN W: field mentah ikut diperbarui ke generasi TERBARU, jangan
                    // sampai nyimpen snapshot conflict dari generasi pertama (bug diam-diam).
                    conflict: structured.conflict ?? null,
                    conflict_note: structured.conflict_note ?? null,
                    makro_alignment: structured.makro_alignment ?? null,
                    makro_alignment_reason: structured.makro_alignment_reason ?? null,
                    // [SISTEM HAKIM] tag pengukuran ikut diperbarui ke generasi terbaru — pola
                    // sama PLAN W di atas, jangan nyimpen snapshot dari generasi pertama.
                    sistem_hakim: sistemHakimEvaluated ? (sistemHakimFired ? 'fired' : (sistemHakimCorrected ? 'corrected' : 'clear')) : null,
                    // Sama seperti buildNewSetupEntry di atas (bug conflict_source jatuh ke
                    // null saat guard aktif pada conflict:'waktu' yang dipertahankan) — fix
                    // sama diterapkan di jalur refine-in-place ini.
                    conflict_source: (conflictForcedBySistemHakim || contradictionGuardFired)
                      ? (conflictForcedBySistemHakim ? 'sistem_hakim' : 'contradiction_guard')
                      : (structured.conflict === 'arah' ? 'ai' : null),
                    model,
                    // (2026-08-18) `commentary` ikut di-stage bareng field lain — dengan ini
                    // otomatis SELALU dari generasi yang benar-benar diterapkan, tidak bisa
                    // basi lagi seperti bug lama.
                    // AATAS v2: jalur auto tidak lagi memproduksi narasi 5 paragraf, jadi
                    // `commentary` di sana selalu null. Fallback `|| stalePending.commentary`
                    // SENGAJA dilewati untuk auto — kalau tidak, narasi generasi LAMA (era v1)
                    // akan menempel permanen di sebelah level baru, persis jejak audit bohong
                    // yang fix 2026-08-18 ini dibuat untuk mencegah. Naratifnya sekarang ada
                    // di `reasoning_note` yang memang ikut diperbarui di bawah.
                    commentary: isAutoCall ? (commentary || null) : (commentary || stalePending.commentary),
                    // BUG DITEMUKAN & DIFIX (2026-07-25, diskusi user soal filled_t < closed_t):
                    // `ts` SENGAJA TIDAK di-reset di sini (lihat catatan lengkap di
                    // `_evaluateSetups`) — `horizon_days` di atas tetap dihitung dari `ts` ASLI
                    // (waktu ide trade ini lahir), bukan waktu refine terakhir.
                    refined_count: (stalePending.refined_count || 0) + 1,
                    // BUG DITEMUKAN & DIFIX (2026-08-28, kasus XAU/USD false-fill): guard v33
                    // (entrySideOk) cuma mengecek level baru ini di sisi harga yang benar
                    // TERHADAP HARGA SAAT REFINE — tapi `_evaluateSetups` tetap scan mundur dari
                    // `ts` ASLI (bisa berhari-hari sebelum level baru ini bahkan ada) untuk
                    // deteksi fill pertama kali. Kalau harga sempat liar menyentuh level itu
                    // SEBELUM refine ini terjadi (kebetulan, bukan hasil pergerakan nyata
                    // setelah level dipasang), setup langsung dianggap 'open' dengan `filled_t`
                    // yang jauh lebih tua dari kapan level itu sendiri lahir — phantom fill
                    // varian baru, guard v33 tidak menutup jalur ini. `level_set_at` dipisah dari
                    // `ts` (yang tetap dipertahankan apa adanya untuk horizon_days) supaya
                    // _evaluateSetups bisa scan HANYA dari saat level YANG BERLAKU SEKARANG
                    // dipasang, bukan dari lahirnya ide pertama.
                    level_set_at: Date.now(),
                    // (2026-08-18) stempel versi kebijakan ikut diperbarui — pola sama
                    // `regime`/`model` di blok ini: level yang benar-benar dipasang lahir
                    // dari aturan main SAAT refine ini, bukan saat generasi pertama.
                    policy_v: POLICY_VERSION,
                    // AATAS: field checklist ikut diperbarui ke generasi TERBARU — pola sama
                    // regime/model/commentary di blok ini. Level yang benar-benar dipasang
                    // lahir dari penilaian checklist SAAT refine, bukan generasi pertama;
                    // menyimpan skor lama di sebelah level baru itu jejak audit yang bohong.
                    regime_check: structured.regime_check ?? null,
                    gate_validitas_driver: structured.gate_validitas_driver ?? null,
                    gate_risk_management: structured.gate_risk_management ?? null,
                    fundamental_bias: structured.fundamental_bias ?? null,
                    technical: structured.technical ?? null,
                    final_validation: structured.final_validation ?? null,
                    checklist_pct: structured.checklist_pct ?? null,
                    verdict: structured.verdict ?? null,
                    reasoning_note: structured.reasoning_note ?? null,
                    aatas_v: AATAS_PROMPT_VERSION,
                  },
                };
              } else {
                // Skenario Pembalikan Bias (berlawanan): Flip Guard — jika whipsaw (conflict === 'arah'), tahan pending lama
                const isWhipsaw = structured.conflict === 'arah';
                if (isWhipsaw) {
                  blockedByOpenPosition = true;
                } else {
                  stalePending.status = 'canceled';
                  stalePending.label_reason = `digantikan analisa auto-entry bias ${structured.bias} sebelum kena harga`;
                  stalePending.label_by = 'auto';
                  // PLAN U-3 lanjutan (2026-07-24, diskusi user soal "setup bagus keburu
                  // ditarik karena noise"): begitu status jadi 'canceled', _evaluateSetups
                  // BERHENTI mengevaluasi setup ini selamanya (cuma jalan utk pending/open)
                  // — jadi tidak pernah ketahuan apakah flip ini tepat (harga lanjut ke SL
                  // asli) atau salah (harga lanjut ke TP asli, berarti setup yang dibatalkan
                  // sebenarnya benar). Tandai eksplisit + catat waktu pembatalan supaya
                  // _evaluateCanceledGhost bisa lanjut memantau counterfactual-nya di field
                  // TERPISAH (ghost_status/ghost_*) — data mentah/status TIDAK disentuh,
                  // prinsip sama _evaluateManaged (U-5a).
                  stalePending.canceled_reason = 'bias_flip';
                  stalePending.canceled_t = Date.now();
                  // BUG DITEMUKAN & DIFIX (2026-07-29): dulu `shouldSaveLog` TIDAK diset
                  // true di sini — kalau Gate D/B/A di bawah lalu menahan kandidat BARU,
                  // pembatalan stale pending ini (satu-satunya jejak bahwa AI sudah
                  // membalik bias) ikut hilang tanpa pernah tersimpan (silent, tidak ada
                  // warning). Sekarang disimpan segera, terlepas dari nasib kandidat baru.
                  shouldSaveLog = true;
                }
              }
            }
          }
        }
        // Gate B/D (audit celah "kesalahan trader", 2026-07-28, daun_merah_progress.md)
        // — HANYA auto-entry, HANYA kalau lolos guard existing di atas (bukan dup/
        // blockedByOpenPosition). Dicek SEBELUM Gate A (AI Kritikus, 1 AI call) supaya
        // kandidat yang memang bakal ditahan gate murah tidak buang budget AI sia-sia.
        // Semua ambang di sini ADAPTIF per risk_regime (autoGuardRegime) — bukan cutoff
        // statis — sesuai temuan riset (daun_merah_referensi_riset.md §10): filter yang
        // kaku mengurangi frekuensi trade & bisa merusak performa, filter adaptif tidak.
        // (Gate C/regime confidence bar SEMPAT ada, DIHAPUS sesi yang sama — buta arah,
        // lihat api/_auto_entry_guard.js.)
        // Pencatatan ringan (2026-07-28, diminta user pasca-eksekusi gate): counter
        // Redis INCR polos per alasan — cuma FREKUENSI tiap gate nyala, BUKAN apakah
        // gate itu "benar" (kandidat yang ditahan memang bakal SL) atau "noise" (kandidat
        // yang ditahan sebenarnya bakal TP). Untuk itu butuh pola counterfactual seperti
        // `_evaluateCanceledGhost` (bias_flip) — sengaja belum dibuat di sini, itu kerja
        // lebih besar dari "pencatatan ringan". Baca via `redis-keys?key=auto_guard_stats:*`
        // (sudah didaftarkan di KEY_REGISTRY di bawah). Fire-and-forget, gagal tidak pernah
        // menggagalkan alur auto-entry.
        const autoGuardConsidered = isAutoCall && !dup && !blockedByOpenPosition;
        if (autoGuardConsidered) redisCmd('INCR', 'auto_guard_stats:considered').catch(() => {});
        let autoGuardReason = null;
        if (autoGuardConsidered) {
          // Gate E DILONGGARKAN (diskusi user, 2026-08-04, sesi sama dengan audit S277
          // yang membuatnya hard block) — lihat api/_auto_entry_guard.js untuk alasan
          // lengkap (bukti awal cuma 4-5 sampel + sudah ada tighten_sl reaktif berita
          // untuk posisi open). conflict:'waktu' sekarang cuma counter observasi
          // non-blocking; kandidatnya tetap lanjut ke Gate A (AI Kritikus) di bawah,
          // yang sudah lihat kalender event high-impact sama (calAnalyzeBlock) dan bisa
          // veto sendiri lewat critic_veto kalau memang dianggap terlalu berisiko.
          if (isTimingConflictBlocked(structured.conflict)) {
            redisCmd('INCR', 'auto_guard_stats:conflict_waktu_flagged').catch(() => {});
          }
          // (2026-08-10, dicoba lalu DIREVERT sesi sama — diskusi user) Gate keras
          // "makro_conflict" (auto-reject begitu makro_alignment final = "konflik",
          // sebelum Gate A dipanggil sama sekali) sempat ditambahkan di sini, tapi
          // dibatalkan setelah disadari CRITIC_SYSTEM_PROMPT (Gate A/AI Kritikus, di
          // bawah) SUDAH secara eksplisit diminta "fokus konflik makro" sebagai salah
          // satu dari 4 hal yang WAJIB dia timbang, dan setiap makro_alignment/reason
          // SUDAH dikirim ke Gate A sebagai fakta (lihat criticSetupBlock, Fase 2).
          // Gate keras di sini akan MENIMPA keputusan Gate A yang sudah menimbang
          // info yang sama (bukan mengisi kekosongan) — user khawatir ini memperlambat
          // laju entry (preseden Gate E: hard block pernah bikin nol entry hari pertama,
          // dilonggarkan). Kalau nanti mau data frekuensi nyata dulu sebelum
          // keputusan hard-block, tambahkan counter OBSERVASI non-blocking di sini
          // (pola sama conflict_waktu_flagged di atas) — JANGAN langsung set
          // autoGuardReason tanpa data.
          if (isCorrelatedExposureBlocked({ symbol, bias: structured.bias, positions: log, liveSign: liveCorrSign })) {
            autoGuardReason = 'correlation_cap';
          }
          // Gate B (drawdown circuit breaker) DIAKTIFKAN ULANG 2026-08-22 (POLICY_EPOCHS
          // v30) — nonaktif sejak 2026-08-20 (v29) karena 2 alasan: (1) ambang masih
          // heuristik awal belum dikalibrasi [MASIH BERLAKU, belum dikalibrasi], (2) gate
          // GLOBAL lintas-pair tanpa katup darurat waktu -> risiko macet total kalau
          // rolling-R jatuh di bawah ambang PERSIS saat nol posisi pending/open tersisa
          // (satu-satunya jalan keluar rolling-R membaik adalah entry baru closed profit,
          // tapi entry baru itu sendiri yang diblokir). Alasan (2) DIPERBAIKI di sesi ini:
          // isDrawdownEmergencyValveOpen (_auto_entry_guard.js) — kalau macet (nol
          // pending/open DAN >=3 hari sejak entri real terakhir), izinkan 1 kandidat lolos
          // supaya siklus bisa jalan lagi. Alasan (1) TETAP diterima sadar (sama seperti
          // sebelum dinonaktifkan) — ambang dikalibrasi ulang setelah n>=100.
          if (!autoGuardReason) {
            // AATAS (2026-08-22): jendela drawdown dibatasi ke POPULASI AATAS saja.
            // Kalau kerugian arsitektur LAMA (teknikal-dulu, 12 SL Agustus) ikut dihitung,
            // Gate B praktis menyala sejak menit pertama arsitektur baru hidup — sistem
            // yang justru dibuat untuk memperbaiki kerugian itu tidak akan pernah dapat
            // kesempatan mengeluarkan satu pun trade untuk membuktikan dirinya, dan satu-
            // satunya jalan keluarnya cuma katup darurat 3 hari. Ini konsekuensi langsung
            // dari keputusan user "statistik direset ke populasi AATAS": rem otomatis pun
            // harus mengukur mobil yang sekarang, bukan mobil sebelumnya. Konsekuensi yang
            // diterima sadar: Gate B tidur sampai DRAWDOWN_MIN_SAMPLE setup AATAS closed
            // (persis kondisi awal Plan U dulu), jadi perlindungan drawdown belum aktif di
            // hari-hari pertama.
            const closedForDrawdown = log
              .filter(s => s && (s.status === 'tp' || s.status === 'sl') && _isAatasEpochSetup(s))
              .sort((a, b) => new Date(a.ts) - new Date(b.ts));
            const drawdownCheck = isDrawdownHalted({ closedSetups: closedForDrawdown, regime: autoGuardRegime });
            if (drawdownCheck.halted && !isDrawdownEmergencyValveOpen({ log, nowMs: Date.now() })) {
              autoGuardReason = `drawdown_circuit_breaker(R=${drawdownCheck.rollingR})`;
            }
          }
        }
        // Gate A (AI Kritikus) butuh Gate D/B lolos dulu. KALAU perlu, JANGAN panggil di
        // sini (masih di bawah lock) — serahkan ke Fase 2 di luar lock (lihat komentar
        // BUG DITEMUKAN & DIFIX dekat deklarasi lockKey di atas). Simpan dulu mutasi yang
        // SUDAH pasti (refine/flip-cancel) sebelum lock dilepas, supaya tidak hilang kalau
        // Fase 2 gagal total (mis. proses berhenti di tengah call AI).
        needsGateA = autoGuardConsidered && !autoGuardReason;
        if (needsGateA) {
          if (shouldSaveLog) await redisCmd('SET', setupLogKey, JSON.stringify(log.slice(0, 200)));
        } else {
          if (autoGuardReason) {
            blockedByOpenPosition = true; // reuse flag skip existing — setup baru TIDAK disimpan sebagai live
            console.log(`auto-entry ${symbol} ditahan oleh audit-guard: ${autoGuardReason}`);
            // gateKey = token pertama sebelum '(' atau ':' — 'drawdown_circuit_breaker(R=-3)' -> 'drawdown_circuit_breaker'
            const gateKey = autoGuardReason.split(/[(:]/)[0];
            redisCmd('INCR', `auto_guard_stats:${gateKey}`).catch(() => {});
            // Ghost-tracking (2026-08-08, diskusi user): dulu kandidat yang ditahan gate
            // di sini cuma jadi angka counter, levelnya (entry/sl/tp) sudah dihitung penuh
            // tapi langsung dibuang — tidak pernah ketahuan apakah gate-nya benar menahan
            // atau kebetulan buang kandidat yang sebenarnya menang. Direkam sebagai
            // 'canceled' (BUKAN 'pending'/'open' — tidak pernah live, tidak masuk win-rate
            // manapun) dengan canceled_reason:'gate_<gateKey>' supaya _evaluateCanceledGhost
            // (sekarang digeneralisasi, lihat GHOST_TRACKED_CANCEL_REASONS) bisa memantau
            // counterfactual-nya lewat field ghost_* terpisah, pola sama persis bias_flip.
            log.unshift({ ...buildNewSetupEntry(), status: 'canceled', canceled_reason: `gate_${gateKey}`, canceled_t: Date.now() });
            shouldSaveLog = true;
          }
          // Jalur ini yang dieksekusi manual (isAutoCall false -> autoGuardConsidered
          // selalu false -> needsGateA selalu false) — Gate A tidak pernah menyentuh
          // manual, TIDAK ada perubahan perilaku/latensi untuk manual sama sekali.
          if (!dup && !blockedByOpenPosition) {
            log.unshift(buildNewSetupEntry());
            shouldSaveLog = true;
          }
          if (shouldSaveLog) await redisCmd('SET', setupLogKey, JSON.stringify(log.slice(0, 200)));
        }
      } catch (e) { console.warn('setup_log write failed (fase 1):', e.message); }
      finally { redisCmd('DEL', lockKey).catch(() => {}); } }

      // Fase 2: Gate A (AI Kritikus) TANPA lock — hanya kalau Fase 1 bilang perlu (selalu
      // false untuk manual). Fact sheet numpang blok yang SUDAH dibangun sebelumnya
      // (fundBlock/rrBlock/trackBlock/calAnalyzeBlock) — TIDAK fetch Redis baru. verdict
      // "batalkan" -> setup tidak disimpan; "tunda"/"lanjut" -> disimpan (AI Kritikus
      // dirancang skeptis-tapi-tidak-memblokir kecuali keberatan fundamental).
      if (needsGateA) {
        let autoGuardReason = null;
        try {
          const criticSetupBlock = [
            `[SETUP YANG DIUSULKAN]`,
            `Pair: ${data.label} | Bias: ${structured.bias || '—'} | Entry: ${structured.entry_zone} | SL: ${structured.sl} | TP: ${structured.tp}${structured.risk_reward ? ` | RR: ${structured.risk_reward}` : ''}`,
            structured.invalidation_condition ? `Invalidation: ${structured.invalidation_condition}` : null,
            // AATAS (2026-08-22): jalur auto tidak lagi memproduksi makro_alignment —
            // Kritikus sekarang menerima ringkasan checklist per-step (dasar keputusan
            // yang sebenarnya) supaya keberatannya bisa menunjuk step mana yang lemah,
            // bukan label yang sudah tidak ada. Baris lama dipertahankan sebagai fallback
            // (mis. kalau suatu saat jalur non-auto memakai blok ini juga).
            isAutoCall ? _formatAatasCriticLine(structured) : null,
            (!isAutoCall && structured.makro_alignment) ? `Makro alignment: ${structured.makro_alignment}${structured.makro_alignment_reason ? ` (${structured.makro_alignment_reason})` : ''}` : null,
            structured.conflict === 'waktu'
              ? `Catatan timing dari analisa awal: ${structured.conflict_note || 'ada event high-impact dekat, dalam rentang horizon skenario ini'} — nilai apakah risikonya cukup serius untuk verdict "batalkan", atau setup ini cukup kuat untuk tetap lanjut (posisi open tetap dilindungi tighten-SL reaktif berita kalau eventnya benar-benar bergerak melawan).`
              : null,
          ].filter(Boolean).join('\n');
          const criticFactParts = [criticSetupBlock, fundBlock, rrBlock, trackBlock, calAnalyzeBlock].filter(Boolean);
          // Pool eksperimental (BUKAN 'ai:deepseek'/'deepseek' milik tombol manual
          // publik) — isolasi U-7, sama pola dengan AI_BUDGET_DEEPSEEK_KEY di ohlcv_analyze.
          const critic = await _runCriticVerdict(criticFactParts.join('\n\n') + CRITIC_JSON_INSTRUCTION, {
            cbKey: 'ai:deepseek:experimental', budgetKey: 'deepseek_experimental',
          });
          if (critic.verdict === 'batalkan') {
            autoGuardReason = `critic_veto${critic.objections?.[0]?.reason ? ':' + critic.objections[0].reason.slice(0, 80) : ''}`;
          }
        } catch (e) { console.warn('auto-entry Gate A (AI Kritikus) gagal, fail-open (tetap simpan setup):', e.message); }

        // Re-acquire lock BARU + baca ULANG state segar — state bisa berubah selama Gate A
        // mikir (puluhan detik): symbol yang sama bisa sudah dapat posisi open/dup baru
        // dari proses lain. Kalau begitu, buang keputusan ini daripada menimpa buta (pola
        // sama persis positionReviewHandler, lihat komentar `race_detected`).
        const gotLock2 = await _acquireLockWithRetry(lockKey);
        if (!gotLock2) {
          console.warn(`setup_log write (pasca Gate A) GAGAL PERMANEN: lock ${lockKey} sedang dipegang — sinyal AI hilang, tidak tersimpan`);
        } else { try {
          const rawLog2 = await redisCmd('GET', setupLogKey);
          let log2 = rawLog2 ? JSON.parse(rawLog2) : [];
          if (!Array.isArray(log2)) log2 = [];
          const dup2 = log2.find(x => x && x.symbol === symbol
            && (x.status === 'pending' || x.status === 'open')
            && x.entry_zone === structured.entry_zone && x.sl === structured.sl && x.tp === structured.tp);
          const openNow = log2.find(x => x && x.symbol === symbol && x.status === 'open');
          // Refine-in-place (2026-08-18) — cabang TERPISAH dari alur buildNewSetupEntry() di
          // bawah, karena target-nya entry LAMA (dicari via id), bukan entry baru. Race guard
          // sama semangatnya dengan dup2/openNow: kalau di antara Gate A mikir posisi ini sudah
          // berubah status (terisi/di-cancel proses lain), buang staged fields daripada menimpa
          // buta. Verdict "batalkan" -> level lama dipertahankan APA ADANYA, refine dianggap
          // tidak pernah terjadi (BUKAN membatalkan posisi pending-nya sendiri).
          if (refineCandidate) {
            const target = log2.find(x => x && x.id === refineCandidate.id && x.status === 'pending');
            if (!target) {
              console.log(`auto-entry ${symbol}: state berubah selama Gate A berjalan (race_detected, refine) — staged fields dibuang`);
            } else if (autoGuardReason) {
              console.log(`auto-entry ${symbol} refine ditahan oleh Gate A (Kritikus): ${autoGuardReason} — level lama dipertahankan`);
              const gateKey = autoGuardReason.split(/[(:]/)[0];
              redisCmd('INCR', `auto_guard_stats:${gateKey}_refine`).catch(() => {});
            } else {
              Object.assign(target, refineCandidate.fields);
              redisCmd('INCR', 'auto_guard_stats:saved_refine').catch(() => {});
              await redisCmd('SET', setupLogKey, JSON.stringify(log2.slice(0, 200)));
            }
          } else if (dup2 || openNow) {
            console.log(`auto-entry ${symbol}: state berubah selama Gate A berjalan (race_detected) — dibuang, tidak ditulis dobel`);
          } else if (autoGuardReason) {
            console.log(`auto-entry ${symbol} ditahan oleh audit-guard: ${autoGuardReason}`);
            const gateKey = autoGuardReason.split(/[(:]/)[0];
            redisCmd('INCR', `auto_guard_stats:${gateKey}`).catch(() => {});
            // Ghost-tracking critic_veto (2026-08-08) — pola sama Gate D/B di Fase 1 di
            // atas, lihat komentar lengkap di sana. log2 di sini sudah dibaca ULANG segar
            // pasca Gate A (bukan `log` Fase 1 yang mungkin sudah basi).
            log2.unshift({ ...buildNewSetupEntry(), status: 'canceled', canceled_reason: `gate_${gateKey}`, canceled_t: Date.now() });
            await redisCmd('SET', setupLogKey, JSON.stringify(log2.slice(0, 200)));
          } else {
            redisCmd('INCR', 'auto_guard_stats:saved').catch(() => {});
            log2.unshift(buildNewSetupEntry());
            await redisCmd('SET', setupLogKey, JSON.stringify(log2.slice(0, 200)));
          }
        } catch (e) { console.warn('setup_log write failed (fase 2):', e.message); }
        finally { redisCmd('DEL', lockKey).catch(() => {}); } }
      }
    }
    return res.status(200).json({
      ...resultPayload,
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
// TIDAK ada fetch eksternal baru, cuma 1 AI call (DeepSeek v4-flash — SambaNova akun 1,
// primary lama di sini, diputus kontrak 2026-08-12; Groq diputus lebih dulu 2026-07-25).
//
// [2026-07-28] Diekstrak jadi _runCriticVerdict (audit celah "kesalahan trader"
// Plan U — daun_merah_progress.md): sebelumnya AI Kritikus HANYA dipanggil manual
// via tombol ini, TIDAK PERNAH menyentuh jalur auto-entry (`isAutoCall`) — padahal
// ini satu-satunya alat anti-confirmation-bias yang sudah ada. Fungsi ini sekarang
// dipakai DUA jalur: handler manual di bawah (fact sheet dari Redis) DAN Gate A
// auto-entry di ohlcvAnalyzeHandler (fact sheet dari data yang SUDAH ada di memori
// saat itu, tanpa fetch Redis tambahan — lihat pemanggilnya).
const CRITIC_SYSTEM_PROMPT = 'Kamu auditor risiko trading yang skeptis. Setup yang diusulkan Senior Trader + fakta pasar terlampir adalah FAKTA, bukan tebakan. Tugasmu SATU-SATUNYA: cari alasan kenapa trade ini TIDAK layak diambil SEKARANG — fokus konflik makro, ancaman rilis kalender terdekat, crowded positioning (retail/COT), dan win-rate historis kalau tersedia. Maksimal 3 keberatan, masing-masing WAJIB mengutip angka/fakta KONKRET dari data terlampir — keberatan generik tanpa angka DILARANG. Kalau memang tidak ada keberatan berarti (data mendukung, tidak ada event dekat, positioning tidak ekstrem), verdict WAJIB "lanjut" dengan objections kosong — JANGAN mengarang risiko yang tidak ada di data. verdict: "lanjut" (tidak ada keberatan berarti) / "tunda" (ada keberatan tapi bisa dilewati dengan menunggu) / "batalkan" (keberatan fundamental terhadap tesis itu sendiri). Bahasa Indonesia.';
const CRITIC_JSON_INSTRUCTION = '\n\nBalas HANYA satu objek JSON valid (tanpa markdown fence, tanpa teks lain) persis format ini: {"objections":[{"severity":"tinggi","reason":"..."}],"verdict":"lanjut"}. Maksimal 3 objections. Kalau tidak ada keberatan berarti, objections HARUS array kosong [] dan verdict "lanjut".';

// cbKey/budgetKey berbeda untuk pemanggil auto-entry (Gate A, isExperimental) vs
// manual (tombol "UJI KELEMAHAN") — BUG POLA SAMA yang sudah pernah ditemukan &
// difix untuk deepseek_experimental (S218 audit, lihat komentar DEFAULT_LIMITS
// _ai_guard.js): kalau dua pool dibiarkan sama, auto-entry & manual rebutan kuota
// harian yang sama, dan outage/limit salah satu bisa mentrip circuit yang satunya.
// SambaNova akun 1 (primary lama di sini) diputus kontrak 2026-08-12 — DeepSeek
// v4-flash sekarang satu-satunya provider (lihat daun_merah_vendor.md).
async function _runCriticVerdict(userMsg, {
  cbKey = 'ai:deepseek', budgetKey = 'deepseek',
} = {}) {
  const messages = [
    { role: 'system', content: CRITIC_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];
  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
  let rawText = null, model = null;

  if (DEEPSEEK_KEY && await cb.canCall(cbKey)) {
    try {
      if (!await allowAiCall(budgetKey)) throw new Error('AI daily budget exceeded');
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages, max_tokens: 600, temperature: 0, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) {
        const j = await r.json(); rawText = j.choices?.[0]?.message?.content?.trim() || null; model = 'deepseek-v4-flash';
        if (rawText) await cb.onSuccess(cbKey);
        else throw new Error('Empty response');
      } else {
        const errJ = await r.json().catch(() => ({}));
        throw new Error(r.status === 402 ? 'HTTP402_insufficient_balance' : (errJ?.error?.message || `HTTP ${r.status}`));
      }
    } catch(e) { console.warn('_runCriticVerdict DeepSeek failed:', e.message); await cb.onFailure(cbKey); }
  } else if (!rawText && DEEPSEEK_KEY) { console.log('_runCriticVerdict: DeepSeek circuit OPEN/budget habis'); }

  if (!rawText) {
    return { verdict: null, objections: null, model: null, raw: null, error: 'AI Kritikus tidak tersedia (DeepSeek gagal/limit habis) — coba lagi nanti.' };
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
    console.warn('_runCriticVerdict: JSON parse gagal, fallback raw text:', e.message);
  }

  return { verdict, objections, model, raw: objections === null ? rawText : undefined, error: null };
}

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
  const [rawBias, rawCot, rawRisk, rawRetail, rawRR, rawCal, rawLog, rawSnap, rawRY] = await Promise.all([
    redisCmd('GET', 'cb_bias').catch(() => null),
    redisCmd('GET', 'cot_cache_v2').catch(() => null),
    redisCmd('GET', 'risk_regime').catch(() => null),
    redisCmd('GET', 'retail_sentiment_cache').catch(() => null),
    redisCmd('GET', 'rr_cache_v2').catch(() => null),
    redisCmd('GET', 'calendar_v1').catch(() => null),
    redisCmd('GET', 'setup_log:v1').catch(() => null),
    redisCmd('GET', 'daily_snapshot').catch(() => null),
    redisCmd('GET', 'real_yields').catch(() => null),
  ]);
  // (2026-08-08) rawRR sudah di-fetch paralel di atas — parse sekali di sini. Handler
  // ini ("UJI KELEMAHAN") 100% manual/publik, TIDAK PERNAH dipanggil dari pipeline
  // auto-entry (Gate A auto-entry pakai _runCriticVerdict langsung di dalam
  // ohlcvAnalyzeHandler, bukan lewat endpoint ini) — jadi framing CME-diprioritaskan
  // SENGAJA tidak diaktifkan di sini (hasCmeData/prioritized tidak di-set, default
  // false), konsisten dengan karantina isolasi Plan U/U-7 di ohlcvAnalyzeHandler.
  let rrPairForCritic = null;
  try { rrPairForCritic = rawRR ? JSON.parse(rawRR)?.pairs?.[label] || null : null; } catch (e) { /* opsional */ }
  try {
    fundBlock = _formatFundamentalBlock({
      label, isXau,
      cbBias: rawBias ? JSON.parse(rawBias) : null,
      cot:    rawCot  ? JSON.parse(rawCot)  : null,
      risk:   rawRisk ? JSON.parse(rawRisk) : null,
      retail: rawRetail ? JSON.parse(rawRetail) : null,
      drivers: _extractMacroDrivers(rawSnap, rawRY),
      nowMs:  Date.now(),
    });
  } catch (e) { /* opsional */ }
  try {
    if (rrPairForCritic) rrBlock = _formatOptionsSentimentBlock(rrPairForCritic);
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
  const userMsg = factParts.join('\n\n') + CRITIC_JSON_INSTRUCTION;

  const { verdict, objections, model, raw, error } = await _runCriticVerdict(userMsg);
  if (error) return res.status(200).json({ error });

  return res.status(200).json({
    objections, verdict, model,
    raw, // fallback tampilan mentah kalau parse gagal
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
// DeepSeek v4-flash primary/satu-satunya (Plan O sudah promosi jadi primary produksi;
// SambaNova akun 1, fallback lama di sini, diputus kontrak 2026-08-12). GARIS KERAS
// (Plan R): verdict = konteks keputusan, BUKAN auto-entry — user
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
  let rawText = null, model = null;

  // Primary/satu-satunya: DeepSeek v4-flash — 1 call/klik masuk pool 'deepseek' di _ai_guard.js
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
  } else if (DEEPSEEK_KEY) { console.log('pre_entry_check: DeepSeek circuit OPEN'); }

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
  if (!secret || !safeEqual(secret || '', process.env.CRON_SECRET || '')) return res.status(401).json({ error: 'Unauthorized' });

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
module.exports._fundSeedAgeDays = _fundSeedAgeDays;
module.exports._formatFundDataLine = _formatFundDataLine;
module.exports._stripMarkdown = _stripMarkdown;
module.exports._parseFundRankingOrder = _parseFundRankingOrder;
module.exports._formatFundRankingDelta = _formatFundRankingDelta;
module.exports._pickExpiryLevels = _pickExpiryLevels;
module.exports._confluenceZones = _confluenceZones;
module.exports._formatConfluenceBlock = _formatConfluenceBlock;
module.exports._formatLevelCandidatesBlock = _formatLevelCandidatesBlock;
module.exports._evaluateSetups = _evaluateSetups;
module.exports._evaluateTechInvalidation = _evaluateTechInvalidation;
module.exports._evaluateCanceledGhost = _evaluateCanceledGhost;
module.exports._aggCancelFlipGhostStats = _aggCancelFlipGhostStats;
module.exports._aggGateRejectGhostStats = _aggGateRejectGhostStats;
module.exports.GHOST_TRACKED_CANCEL_REASONS = GHOST_TRACKED_CANCEL_REASONS;
module.exports._aggSetupStats = _aggSetupStats;
module.exports._statsPayloadFromLog = _statsPayloadFromLog;
module.exports._costAdjustedR = _costAdjustedR;
module.exports._aggCostExpectancy = _aggCostExpectancy;
module.exports._confidenceCalibration = _confidenceCalibration;
module.exports._sistemHakimCalibration = _sistemHakimCalibration;
module.exports._computeCbDirServerSide = _computeCbDirServerSide;
module.exports._detectAlignmentReasonContradiction = _detectAlignmentReasonContradiction;
module.exports._summarizeLatency = _summarizeLatency;
module.exports.SPREAD_PRICE_ESTIMATE = SPREAD_PRICE_ESTIMATE;
module.exports.probeCalendarCache = probeCalendarCache;
module.exports._detectLossLabel = _detectLossLabel;
module.exports.LOSS_LABEL_CRITERIA_V = LOSS_LABEL_CRITERIA_V;
module.exports._detectTpLabel = _detectTpLabel;
module.exports._newsMatchesLegs = _newsMatchesLegs;
module.exports.LOSS_LABEL_CURRENCY_KEYWORDS = LOSS_LABEL_CURRENCY_KEYWORDS;
module.exports._corroborateLevel = _corroborateLevel;
module.exports._breachDirection = _breachDirection;
module.exports._corroborateGoldTransitions = _corroborateGoldTransitions;
module.exports._finalizeSetupTransitions = _finalizeSetupTransitions;
module.exports.GOLD_BASIS_TOLERANCE_USD = GOLD_BASIS_TOLERANCE_USD;
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
module.exports._extractMacroDrivers = _extractMacroDrivers;
module.exports._buildMacroSnapshot = _buildMacroSnapshot;
module.exports._formatOptionsSentimentBlock = _formatOptionsSentimentBlock;
module.exports.COT_CME_PROMPT_VERSION = COT_CME_PROMPT_VERSION;
module.exports._formatTrackRecordBlock = _formatTrackRecordBlock;
module.exports._calEventMsWib = _calEventMsWib;
module.exports._buildAnalyzeCalBlock = _buildAnalyzeCalBlock;
module.exports._buildLiveCorrSign = _buildLiveCorrSign;
module.exports._goldYieldCorrAnomaly = _goldYieldCorrAnomaly;
module.exports._isAatasEpochSetup = _isAatasEpochSetup;
module.exports._formatRatePathBlock = _formatRatePathBlock;
module.exports._consistencySummary = _consistencySummary;
module.exports._buildAatasMacroChecklistBlock = _buildAatasMacroChecklistBlock;
module.exports._buildAatasTechnicalChecklistBlock = _buildAatasTechnicalChecklistBlock;
module.exports._stripIndicatorLines = _stripIndicatorLines;
module.exports._evaluateAatasGate1 = _evaluateAatasGate1;
module.exports._splitJsonCommentary = _splitJsonCommentary;
module.exports._normalizeAatasFields = _normalizeAatasFields;
module.exports._aatasRejectReason = _aatasRejectReason;
module.exports._formatAatasCriticLine = _formatAatasCriticLine;
module.exports.AATAS_PROMPT_VERSION = AATAS_PROMPT_VERSION;
module.exports.parseRSSHeadlines = parseRSSHeadlines;
module.exports.parsePushRSS = parsePushRSS;
module.exports.BLOCKED_HEADLINE_RE = BLOCKED_HEADLINE_RE;
