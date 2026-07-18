// vps/daemon.js — Plan Q-2..Q-6: daemon VPS event-driven (streaming + alert +
// scheduler), dibangun di atas heartbeat Q-1 (vps/heartbeat.js).
//
// Prinsip arsitektur (S186, daun_merah_plan.md §Plan Q): VPS = PENAMBAH, bukan
// tulang punggung — kalau salah satu modul di bawah gagal konfigurasi (env var
// belum diset) atau exception, modul itu SKIP dengan warning, TIDAK PERNAH
// menjatuhkan heartbeat atau modul lain. Plan P (on-demand Deriv/Yahoo di
// api/_ohlcv_fetch.js) & cron GitHub Actions tetap jalan penuh sebagai fallback
// selama daemon ini hidup atau mati.
//
// vps/ di-deploy sebagai Docker image TERISOLASI dari app utama (Root Directory
// Railway = vps/, build context tidak menjangkau file di luar folder ini) —
// karena itu newscat.js di-duplikasi ke folder ini (lihat catatan di kepala
// vps/newscat.js) dan mapping symbol Deriv di bawah DIDUPLIKASI dari
// api/_ohlcv_fetch.js (dijaga sinkron oleh test/vps_daemon_sync.test.js), bukan
// di-require lintas folder.
//
// DILARANG menulis candle per-tick ke Redis (budget Q-2) — hanya saat CLOSE.

const http = require('node:http');
const crypto = require('node:crypto');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PORT        = process.env.PORT || 3000;
const BEAT_INTERVAL_MS = 60 * 1000;
const BEAT_TTL_SECS    = 300;

const DERIV_APP_ID      = process.env.DERIV_APP_ID || '1089';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;
const VAPID_PUBLIC_KEY   = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY  = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT      = process.env.VAPID_SUBJECT || 'mailto:admin@daun-merah.app';
const APP_BASE_URL       = process.env.APP_BASE_URL || 'https://financial-feed-app.vercel.app';

// Cek fatal ini HANYA saat dijalankan sebagai proses (bukan saat di-require
// oleh test unit fungsi murni di bawah — test tidak butuh kredensial Redis).
if (require.main === module && (!REDIS_URL || !REDIS_TOKEN)) {
  console.error('daemon: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN belum di-set — berhenti.');
  process.exit(1);
}

async function redisCmd(...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  return (await r.json()).result;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn('daemon: sendTelegram gagal:', e.message); }
}

// ── Web-push (pola api/_webpush.js — diduplikasi minimal, lihat catatan atas) ──
let webpush = null;
try { webpush = require('web-push'); } catch (e) { /* belum npm install, ditangani saat pemakaian */ }

function configureVapid() {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

async function sendWebPushToSubscribers(payload) {
  if (!configureVapid()) return;
  let flat;
  try { flat = await redisCmd('HGETALL', 'push_subs'); } catch (e) { return; }
  if (!Array.isArray(flat) || flat.length === 0) return;
  const body = JSON.stringify(payload);
  const staleFields = [];
  const tasks = [];
  for (let i = 0; i < flat.length; i += 2) {
    const field = flat[i];
    let sub;
    try { sub = JSON.parse(flat[i + 1]); } catch (e) { continue; }
    tasks.push(
      webpush.sendNotification(sub, body).catch(e => {
        if (e.statusCode === 410 || e.statusCode === 404) staleFields.push(field);
      })
    );
  }
  await Promise.allSettled(tasks);
  if (staleFields.length) await redisCmd('HDEL', 'push_subs', ...staleFields);
}

// ══════════════════════════════════════════════════════════════════════════
// Q-1: heartbeat (identik vps/heartbeat.js — di-fold ke sini supaya 1 proses,
// 1 service Railway; heartbeat.js tetap ada di repo sebagai referensi/rollback)
// ══════════════════════════════════════════════════════════════════════════
let lastBeatOk = null;
let lastBeatError = null;

async function beat() {
  const epoch = Math.floor(Date.now() / 1000);
  try {
    const result = await redisCmd('SET', 'vps:heartbeat', String(epoch), 'EX', String(BEAT_TTL_SECS));
    if (result !== 'OK') throw new Error(`Unexpected Redis reply: ${JSON.stringify(result)}`);
    if (!lastBeatOk) await redisCmd('SET', 'vps:heartbeat:configured', '1');
    lastBeatOk = epoch;
    lastBeatError = null;
  } catch (e) {
    lastBeatError = e.message;
    console.warn(`daemon: heartbeat FAILED — ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Q-3: daemon streaming candle Deriv (granularity 1H, 14 pair FX — sama scope
// Plan P, XAU/USD TIDAK ikut, lihat catatan _ohlcv_fetch.js kenapa)
// ══════════════════════════════════════════════════════════════════════════
// DUPLIKASI SADAR dari api/_ohlcv_fetch.js YAHOO_TO_DERIV_SYMBOL — dijaga sinkron
// oleh test/vps_daemon_sync.test.js. Kalau menambah/mengubah pair di sana, ubah
// juga di sini.
const YAHOO_TO_DERIV_SYMBOL = {
  'EURUSD=X': 'frxEURUSD', 'GBPUSD=X': 'frxGBPUSD', 'USDJPY=X': 'frxUSDJPY',
  'AUDUSD=X': 'frxAUDUSD', 'USDCAD=X': 'frxUSDCAD', 'USDCHF=X': 'frxUSDCHF',
  'NZDUSD=X': 'frxNZDUSD', 'EURJPY=X': 'frxEURJPY', 'GBPJPY=X': 'frxGBPJPY',
  'EURGBP=X': 'frxEURGBP', 'AUDJPY=X': 'frxAUDJPY', 'EURAUD=X': 'frxEURAUD',
  'GBPAUD=X': 'frxGBPAUD', 'GBPCAD=X': 'frxGBPCAD',
};
const DERIV_TO_YAHOO_SYMBOL = Object.fromEntries(
  Object.entries(YAHOO_TO_DERIV_SYMBOL).map(([y, d]) => [d, y])
);
const DERIV_GRANULARITY_1H = 3600;
const OHLCV_TTL_SECS = 90000; // 25h — sama dengan ohlcv_sync (admin.js)

// Candle terakhir yang MASIH terbentuk per symbol (belum ditulis ke Redis) +
// epoch candle terakhir yang SUDAH ditulis (dipakai deteksi rollover close).
const pendingCandle = {};
const lastWrittenEpoch = {};
const lastLivePrice = {}; // yahooSymbol -> harga close terkini (live, dipakai Q-5)

function normalizeDerivCandle(ohlcv) {
  const t = Number(ohlcv.open_time ?? ohlcv.epoch);
  const o = parseFloat(ohlcv.open), h = parseFloat(ohlcv.high), l = parseFloat(ohlcv.low), c = parseFloat(ohlcv.close);
  if (!Number.isFinite(t) || [o, h, l, c].some(n => !Number.isFinite(n))) return null;
  return { t, o: +o.toFixed(6), h: +h.toFixed(6), l: +l.toFixed(6), c: +c.toFixed(6), v: 0 };
}

// Merge candle yang BARU SAJA close ke array Redis existing — dipakai juga di
// test (pure function, tidak menyentuh Redis).
function mergeClosedCandle(existingArr, candle, maxLen = 120) {
  let arr = Array.isArray(existingArr) ? existingArr.slice() : [];
  arr = arr.filter(c => c.t !== candle.t);
  arr.push(candle);
  arr.sort((a, b) => a.t - b.t);
  return arr.slice(-maxLen);
}

async function writeClosedCandle(yahooSymbol, candle) {
  const key = `ohlcv:${yahooSymbol}:1h`;
  let existing = [];
  try {
    const raw = await redisCmd('GET', key);
    existing = raw ? JSON.parse(raw) : [];
  } catch (e) { existing = []; }
  const merged = mergeClosedCandle(existing, candle);
  await Promise.all([
    redisCmd('SET', key, JSON.stringify(merged), 'EX', String(OHLCV_TTL_SECS)),
    redisCmd('SET', `ohlcv:${yahooSymbol}:source`, JSON.stringify({ '1h': 'deriv_stream' }), 'EX', String(OHLCV_TTL_SECS)),
  ]);
}

async function handleOhlcvUpdate(ohlcv) {
  const yahooSymbol = DERIV_TO_YAHOO_SYMBOL[ohlcv.symbol];
  if (!yahooSymbol) return;
  const candle = normalizeDerivCandle(ohlcv);
  if (!candle) return;
  lastLivePrice[yahooSymbol] = candle.c;

  const prevEpoch = lastWrittenEpoch[yahooSymbol];
  if (prevEpoch != null && candle.t === prevEpoch) {
    // Candle yang sama masih terbentuk — update in-memory saja, JANGAN tulis
    // Redis per-tick (budget Q-2).
    pendingCandle[yahooSymbol] = candle;
    return;
  }
  // Epoch berubah = candle sebelumnya baru saja CLOSE.
  const closed = pendingCandle[yahooSymbol];
  if (closed) {
    try { await writeClosedCandle(yahooSymbol, closed); }
    catch (e) { console.warn(`daemon: tulis candle close ${yahooSymbol} gagal:`, e.message); }
  }
  lastWrittenEpoch[yahooSymbol] = candle.t;
  pendingCandle[yahooSymbol] = candle;
}

let derivWs = null;
let reconnectDelayMs = 1000;
const MAX_RECONNECT_MS = 5 * 60 * 1000;
let firstDegradedAt = null;

async function maybeSendDegradedAlert() {
  const now = Date.now();
  try {
    const lastTs = await redisCmd('GET', 'daemon_degraded_alert_ts');
    if (lastTs && (now - Number(lastTs)) < 6 * 60 * 60 * 1000) return;
    await sendTelegram('*Daemon Q-3 degraded* — reconnect Deriv WS gagal >10 menit. Candle FX kembali ke jalur on-demand (Plan P/cron), fitur tetap jalan.');
    await redisCmd('SET', 'daemon_degraded_alert_ts', String(now));
  } catch (e) { /* jangan sampai gagal kirim alert bikin proses crash */ }
}

function scheduleReconnect() {
  if (!firstDegradedAt) firstDegradedAt = Date.now();
  if (Date.now() - firstDegradedAt > 10 * 60 * 1000) maybeSendDegradedAlert().catch(() => {});
  setTimeout(() => { derivWs = connectDerivStream(); }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_MS);
}

function connectDerivStream() {
  let ws;
  try {
    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);
  } catch (e) {
    console.warn('daemon: gagal buka WebSocket Deriv:', e.message);
    scheduleReconnect();
    return null;
  }

  ws.addEventListener('open', () => {
    console.log('daemon: Deriv WS connected');
    reconnectDelayMs = 1000;
    firstDegradedAt = null;
    let i = 0;
    for (const derivSymbol of Object.values(YAHOO_TO_DERIV_SYMBOL)) {
      // Stagger subscribe supaya tidak burst 14 request dalam 1 tick.
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            ticks_history: derivSymbol, style: 'candles',
            granularity: DERIV_GRANULARITY_1H, count: 2, end: 'latest', subscribe: 1,
          }));
        } catch (e) { /* koneksi mungkin sudah tertutup di antara stagger */ }
      }, i * 300);
      i++;
    }
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (data.error) {
      console.warn('daemon: Deriv API error:', data.error.code, data.error.message);
      return;
    }
    if (data.msg_type === 'ohlcv' && data.ohlcv) {
      handleOhlcvUpdate(data.ohlcv).catch(e => console.warn('daemon: handleOhlcvUpdate gagal:', e.message));
    }
  });

  ws.addEventListener('close', () => { console.warn('daemon: Deriv WS closed'); scheduleReconnect(); });
  ws.addEventListener('error', () => { /* 'close' tetap terpicu setelahnya */ });

  return ws;
}

function startDerivStream() {
  if (!DERIV_APP_ID) { console.warn('daemon: DERIV_APP_ID kosong, Q-3 streaming di-skip'); return; }
  derivWs = connectDerivStream();
}

// ══════════════════════════════════════════════════════════════════════════
// Q-4: alert berita high-impact — poll news_history (ditulis api/feeds.js) tiap
// 30 detik, klasifikasi via newscat.js lokal (SAMA, lihat catatan atas file).
// ══════════════════════════════════════════════════════════════════════════
const NewsCat = require('./newscat.js');
const NEWS_POLL_INTERVAL_MS = 30 * 1000;
let newsCursorMs = 0;

function isHighImpactCategory(cat) {
  return cat === 'market-moving';
}

async function sendNewsAlert(item, cat) {
  const text = `*Berita High-Impact* (${cat})\n${item.title}${item.link ? '\n' + item.link : ''}`;
  await Promise.allSettled([
    sendTelegram(text),
    sendWebPushToSubscribers({ title: 'Berita High-Impact', body: item.title, url: '/#ringkasan', icon: '/icon.svg' }),
  ]);
}

async function pollNews() {
  try {
    if (!newsCursorMs) {
      const savedRaw = await redisCmd('GET', 'daemon_news_cursor');
      newsCursorMs = savedRaw ? Number(savedRaw) : Date.now() - 5 * 60 * 1000;
    }
    const items = await redisCmd('ZRANGEBYSCORE', 'news_history', String(newsCursorMs + 1), '+inf');
    if (!Array.isArray(items) || items.length === 0) return;
    let maxTs = newsCursorMs;
    for (const raw of items) {
      let item;
      try { item = JSON.parse(raw); } catch (e) { continue; }
      const ts = Date.parse(item.pubDate);
      if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
      const cat = NewsCat.detectCat(item.title);
      if (!isHighImpactCategory(cat)) continue;
      const guid = item.guid || item.link;
      if (!guid) continue;
      const dedupOk = await redisCmd('SET', `news_alert_sent:${guid}`, '1', 'EX', '172800', 'NX');
      if (dedupOk !== 'OK') continue; // sudah pernah dialert
      await sendNewsAlert(item, cat);
    }
    if (maxTs > newsCursorMs) {
      newsCursorMs = maxTs;
      await redisCmd('SET', 'daemon_news_cursor', String(newsCursorMs), 'EX', '172800');
    }
  } catch (e) { console.warn('daemon: pollNews gagal:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// Q-5: alert level harga — cross live price (dari stream Q-3) vs zona
// konfluensi cache (ohlcv_analysis:<symbol>, HTTP GET mode=cached, TANPA auth —
// lihat api/admin.js:2556). Fitur opsional-terpisah (plan): kalau cache belum
// ada untuk suatu pair (baru fresh kalau pair itu pernah dibuka/dianalisa),
// pair itu di-skip diam-diam, bukan error.
// ══════════════════════════════════════════════════════════════════════════
const ZONE_CHECK_INTERVAL_MS = 60 * 1000;

function priceInZone(price, center, tolerance) {
  if (!Number.isFinite(price) || !Number.isFinite(center) || !Number.isFinite(tolerance)) return false;
  return Math.abs(price - center) <= tolerance;
}

async function sendPriceZoneAlert(yahooSymbol, zone, price) {
  const label = yahooSymbol.replace('=X', '').replace('=F', '');
  const member = Array.isArray(zone.members) && zone.members[0] ? ` (${zone.members[0]})` : '';
  const text = `*Alert Level Harga*\n${label} menyentuh zona ${zone.center}${member}\nHarga sekarang: ${price}`;
  await Promise.allSettled([
    sendTelegram(text),
    sendWebPushToSubscribers({ title: `${label}: harga di zona`, body: `Zona ${zone.center}${member}`, url: '/#teknikal', icon: '/icon.svg' }),
  ]);
}

async function checkPriceZonesFor(yahooSymbol) {
  const price = lastLivePrice[yahooSymbol];
  if (price == null) return; // belum ada data live dari Q-3 untuk pair ini
  let data;
  try {
    const raw = await redisCmd('GET', `ohlcv_analysis:${yahooSymbol}`);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (e) { return; }
  const conf = data?.confluence;
  if (!conf || !Number.isFinite(conf.tolerance)) return;
  const zones = [...(conf.above || []), ...(conf.below || [])];
  for (const zone of zones) {
    if (!priceInZone(price, zone.center, conf.tolerance)) continue;
    const dedupKey = `price_alert:${yahooSymbol}:${zone.center}`;
    try {
      const ok = await redisCmd('SET', dedupKey, '1', 'EX', '14400', 'NX');
      if (ok !== 'OK') continue; // masih cooldown 4 jam
      await sendPriceZoneAlert(yahooSymbol, zone, price);
    } catch (e) { console.warn(`daemon: alert zona ${yahooSymbol} gagal:`, e.message); }
  }
}

async function checkPriceZones() {
  for (const yahooSymbol of Object.keys(YAHOO_TO_DERIV_SYMBOL)) {
    await checkPriceZonesFor(yahooSymbol);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Q-6: scheduler node-cron — jalan PARALEL dengan GitHub Actions (workflow
// TIDAK dimatikan), memicu endpoint yang SAMA lewat HTTP. ohlcv_sync sudah
// men-warm cache TA sendiri di akhir handler-nya (admin.js ohlcvSyncHandler) —
// TIDAK perlu trigger ta-warm terpisah dari sini.
// ══════════════════════════════════════════════════════════════════════════
let cron = null;
try { cron = require('node-cron'); } catch (e) { /* ditangani di startScheduler */ }

async function triggerEndpoint(path) {
  if (!CRON_SECRET) { console.warn(`daemon: CRON_SECRET kosong, skip trigger ${path}`); return; }
  try {
    const r = await fetch(`${APP_BASE_URL}${path}`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal: AbortSignal.timeout(55000),
    });
    console.log(`daemon: trigger ${path} -> HTTP ${r.status}`);
  } catch (e) { console.warn(`daemon: trigger ${path} gagal:`, e.message); }
}

async function runDigestCycle() {
  await triggerEndpoint('/api/market-digest');
  await triggerEndpoint('/api/admin?action=ohlcv_analyze&symbol=GC%3DF&label=XAU%2FUSD');
}

function startScheduler() {
  if (!cron) { console.warn('daemon: paket node-cron tidak terpasang, Q-6 scheduler di-skip'); return; }
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, Q-6 scheduler di-skip'); return; }
  // 3 jadwal identik .github/workflows/market-digest.yml (UTC).
  cron.schedule('0 0 * * *',   () => runDigestCycle().catch(() => {}));
  cron.schedule('0 7 * * *',   () => runDigestCycle().catch(() => {}));
  cron.schedule('30 12 * * *', () => runDigestCycle().catch(() => {}));
  // ohlcv_sync tiap jam, offset menit ke-5 supaya tidak tabrakan detik dengan
  // ohlcv-sync.yml (keduanya sengaja jalan paralel selama masa observasi Q-6).
  cron.schedule('5 * * * *', () => triggerEndpoint('/api/admin?action=ohlcv_sync').catch(() => {}));
  console.log('daemon: Q-6 scheduler aktif (digest 3x/hari + ohlcv_sync tiap jam, paralel GH Actions)');
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP server minimal — health check platform + pinger + status ringkas.
// ══════════════════════════════════════════════════════════════════════════
function startHttpServer() {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'up',
      last_beat_epoch: lastBeatOk,
      last_beat_error: lastBeatError,
      deriv_stream: DERIV_APP_ID ? (derivWs ? 'connecting_or_up' : 'down') : 'disabled',
    }));
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`daemon: HTTP server listening on 0.0.0.0:${PORT}`);
  });
}

function main() {
  beat();
  setInterval(beat, BEAT_INTERVAL_MS);
  startHttpServer();
  startDerivStream();
  setInterval(() => pollNews().catch(() => {}), NEWS_POLL_INTERVAL_MS);
  setInterval(() => checkPriceZones().catch(() => {}), ZONE_CHECK_INTERVAL_MS);
  startScheduler();
}

if (require.main === module) main();

module.exports = {
  mergeClosedCandle, normalizeDerivCandle, isHighImpactCategory, priceInZone,
  YAHOO_TO_DERIV_SYMBOL, DERIV_TO_YAHOO_SYMBOL,
};
