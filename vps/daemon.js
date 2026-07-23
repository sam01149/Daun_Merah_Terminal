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

// ══════════════════════════════════════════════════════════════════════════
// SELF-HEALING LAPIS 0: safety net level proses.
// unhandledRejection: ditelan + log (satu promise lupa di-catch tidak boleh
// mematikan streaming/alert yang sehat). uncaughtException: state proses sudah
// tidak bisa dipercaya — alert best-effort lalu exit(1); Railway restart
// otomatis (vps/railway.json restartPolicyType ALWAYS) = penyembuhan level
// platform. Hanya didaftarkan saat jalan sebagai proses, bukan saat di-require
// test.
// ══════════════════════════════════════════════════════════════════════════
function registerProcessSafetyNet() {
  process.on('unhandledRejection', (e) => {
    console.warn('daemon: unhandledRejection (ditelan, proses lanjut):', (e && e.message) || e);
  });
  process.on('uncaughtException', (e) => {
    console.error('daemon: uncaughtException — exit(1) supaya Railway restart proses:', (e && e.stack) || e);
    const alert = sendTelegram(`*Daemon crash* — uncaughtException: ${(e && e.message) || e}. Proses exit, Railway restart otomatis.`);
    Promise.race([alert, new Promise(r => setTimeout(r, 5000))]).finally(() => process.exit(1));
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SELF-HEALING LAPIS 1: guard degradasi Redis (edge case "Redis budget
// terlampaui" di daun_merah_plan.md §Plan Q — backoff tulis, bukan retry-storm).
//
// Semua kegagalan redisCmd beruntun (network/429 quota Upstash/5xx) dihitung;
// setelah `threshold` gagal berturut, daemon masuk mode DEGRADED: semua operasi
// non-esensial (tulis candle, poll berita, GET zona, supervisor) di-skip selama
// cooldown yang menggandakan diri (60s → maks 30 menit). Heartbeat TIDAK
// di-gate — dialah probe 60 detik yang me-reset guard begitu Redis pulih.
// ══════════════════════════════════════════════════════════════════════════
function createRedisGuard({ threshold = 5, baseCooldownMs = 60 * 1000, maxCooldownMs = 30 * 60 * 1000 } = {}) {
  let failures = 0;
  let degradedUntil = 0;
  let cooldownMs = baseCooldownMs;
  let degraded = false;
  return {
    // return true kalau BARU pulih dari degraded (buat log/alert recovery sekali)
    onSuccess() {
      failures = 0; degradedUntil = 0; cooldownMs = baseCooldownMs;
      const recovered = degraded;
      degraded = false;
      return recovered;
    },
    // return true kalau BARU masuk degraded (buat alert sekali, bukan tiap gagal)
    onFailure(now = Date.now()) {
      failures++;
      if (failures < threshold) return false;
      degradedUntil = now + cooldownMs;
      cooldownMs = Math.min(cooldownMs * 2, maxCooldownMs);
      const entered = !degraded;
      degraded = true;
      return entered;
    },
    isDegraded(now = Date.now()) { return degraded && now < degradedUntil; },
    state() { return { degraded, failures, degradedUntil }; },
  };
}

const redisGuard = createRedisGuard();
let lastRedisAlertAt = 0; // dedup alert in-memory — Redis lagi down, tidak bisa dedup di sana

async function redisCmd(...args) {
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
    const json = await r.json();
    // Upstash balas { error } (mis. quota 429) dengan status non-2xx — itu
    // kegagalan juga, jangan diam-diam return undefined seperti sebelumnya.
    if (!r.ok || json.error) throw new Error(`Redis HTTP ${r.status}: ${json.error || 'unknown'}`);
    if (redisGuard.onSuccess()) {
      console.log('daemon: Redis pulih — mode degraded dicabut, semua modul jalan normal lagi');
      sendTelegram('*Redis pulih* — daemon keluar dari mode degraded, tulis candle/alert berjalan normal lagi.').catch(() => {});
    }
    return json.result;
  } catch (e) {
    if (redisGuard.onFailure()) {
      console.warn(`daemon: Redis DEGRADED — ${redisGuard.state().failures} gagal beruntun (${e.message}); operasi non-esensial di-backoff, heartbeat tetap jadi probe`);
      const now = Date.now();
      if (now - lastRedisAlertAt > 6 * 60 * 60 * 1000) {
        lastRedisAlertAt = now;
        sendTelegram(`*Redis degraded* — daemon backoff tulis (gagal beruntun: ${e.message}). Heartbeat tetap probe tiap 60 detik; jalur Plan P/cron tidak terpengaruh.`).catch(() => {});
      }
    }
    throw e;
  }
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
  if (redisGuard.isDegraded()) {
    // Backoff tulis (self-heal lapis 1) — candle yang terlewat akan diisi
    // ulang jalur Plan P/cron ohlcv_sync begitu Redis pulih, bukan hilang.
    console.warn(`daemon: skip tulis candle ${yahooSymbol} — Redis degraded`);
    return;
  }
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
  // Harga live berubah -> reaksi Q-5 di sini juga (event-driven), BUKAN nunggu
  // timer terpisah — dibatasi ZONE_MIN_CHECK_INTERVAL_MS per symbol supaya
  // tick yang deras (banyak per menit) tidak memaksa GET Redis per-tick juga
  // (budget Q-2, sama semangatnya dengan larangan tulis candle per-tick).
  maybeCheckPriceZone(yahooSymbol).catch(e => console.warn(`daemon: cek zona ${yahooSymbol} gagal:`, e.message));

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

// ── SELF-HEALING LAPIS 2: watchdog WS zombie ──────────────────────────────
// Reconnect existing hanya terpicu event 'close' — koneksi yang mati diam-diam
// (TCP putus tanpa FIN, umum di container yang NAT-nya di-recycle) statusnya
// tetap OPEN selamanya dan candle berhenti mengalir tanpa error apa pun.
// Solusi: ping aplikasi Deriv ({"ping":1}) tiap 60 detik — server balas pong,
// jadi lastWsActivityAt selalu segar walau market tutup (weekend) — lalu kalau
// TIDAK ada pesan apa pun >3 menit padahal status OPEN, paksa reconnect.
const WS_PING_INTERVAL_MS = 60 * 1000;
const WS_STALL_MS = 3 * 60 * 1000;
let lastWsActivityAt = 0;

function shouldForceReconnect(lastActivityAt, now, stallMs = WS_STALL_MS) {
  return lastActivityAt > 0 && (now - lastActivityAt) > stallMs;
}

function wsWatchdogTick() {
  if (!derivWs || derivWs.readyState !== 1) return; // belum open / reconnect lain sedang jalan
  try { derivWs.send(JSON.stringify({ ping: 1 })); } catch (e) { /* close event akan menyusul */ }
  if (shouldForceReconnect(lastWsActivityAt, Date.now())) {
    console.warn(`daemon: Deriv WS zombie — tidak ada pesan ${Math.round((Date.now() - lastWsActivityAt) / 1000)}s padahal status OPEN, paksa reconnect`);
    const dead = derivWs;
    derivWs = null;
    if (typeof dead.forceReconnect === 'function') dead.forceReconnect();
  }
}

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

  // Guard per-socket: reconnect hanya boleh dijadwalkan SEKALI per socket —
  // watchdog zombie bisa membunuh socket yang event 'close'-nya baru datang
  // belakangan; tanpa guard ini keduanya menjadwalkan reconnect = 2 koneksi
  // paralel = tulis Redis dobel.
  let reconnectScheduled = false;
  let killed = false;
  const scheduleOnce = () => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    scheduleReconnect();
  };
  ws.forceReconnect = () => {
    killed = true;
    try { ws.close(); } catch (e) {}
    scheduleOnce(); // jangan andalkan event 'close' dari socket zombie
  };

  ws.addEventListener('open', () => {
    console.log('daemon: Deriv WS connected');
    reconnectDelayMs = 1000;
    firstDegradedAt = null;
    lastWsActivityAt = Date.now();
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
    if (killed) return; // socket sudah divonis zombie — penggantinya yang berhak menulis
    lastWsActivityAt = Date.now();
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

  ws.addEventListener('close', () => { console.warn('daemon: Deriv WS closed'); scheduleOnce(); });
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

// Cursor di-persist ke Redis TIDAK setiap poll (feed berita nyaris selalu ada
// item baru tiap 30 detik, jadi kalau ikut poll = ~2.880 SET/hari) — cukup
// tiap CURSOR_PERSIST_MIN_INTERVAL_MS, sisanya cukup di memori. Ini AMAN
// karena dedup alert pakai key per-guid (news_alert_sent:<guid>), bukan
// cursor — restart proses paling apes replay backlog beberapa menit, tidak
// pernah kirim alert dobel.
const CURSOR_PERSIST_MIN_INTERVAL_MS = 2 * 60 * 1000;
let lastCursorPersistAt = 0;

async function pollNews() {
  try {
    if (redisGuard.isDegraded()) return; // backoff — dedup per-guid mencegah alert dobel saat pulih
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
      const guid = item.guid || item.link;

      // PLAN U-5b (2026-07-20): kandidat review posisi — market-moving ATAU
      // geopolitical, DI LUAR gate isHighImpactCategory di bawah (yang cuma
      // market-moving, khusus alert Q-4). Best-effort: kegagalan di sini TIDAK
      // BOLEH mengganggu/mengubah alur alert existing setelahnya.
      if (guid) {
        try { await handlePosReviewCandidate({ guid, title: item.title, pubDate: item.pubDate, cat }); }
        catch (e) { console.warn('daemon: U-5b handlePosReviewCandidate gagal:', e.message); }
      }

      if (!isHighImpactCategory(cat)) continue;
      if (!guid) continue;
      const dedupOk = await redisCmd('SET', `news_alert_sent:${guid}`, '1', 'EX', '172800', 'NX');
      if (dedupOk !== 'OK') continue; // sudah pernah dialert
      await sendNewsAlert(item, cat);
    }
    if (maxTs > newsCursorMs) {
      newsCursorMs = maxTs;
      const now = Date.now();
      if (now - lastCursorPersistAt >= CURSOR_PERSIST_MIN_INTERVAL_MS) {
        lastCursorPersistAt = now;
        await redisCmd('SET', 'daemon_news_cursor', String(newsCursorMs), 'EX', '172800');
      }
    }
    // PLAN U-5b: antrian recheck geopolitical UNCONFIRMED — dicoba tiap tick,
    // bukan cuma saat item baru datang (korroborasi bisa muncul di poll berikutnya).
    await processPosReviewRecheckQueue().catch(e => console.warn('daemon: U-5b processPosReviewRecheckQueue gagal:', e.message));
  } catch (e) { console.warn('daemon: pollNews gagal:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// PLAN U-5b (2026-07-20): trigger review posisi VIRTUAL event-driven + heuristik
// UNCONFIRMED. Kunci AI HANYA di Vercel (api/admin.js?action=position_review) —
// daemon di sini TIDAK PERNAH memanggil provider AI langsung, hanya memicu
// endpoint dengan CRON_SECRET (pola sama U-3). DILARANG provider AI baru.
// ══════════════════════════════════════════════════════════════════════════

// Map keyword kecil per currency — LOKAL di daemon SENGAJA (bukan newscat.js,
// yang SOT-nya kategori berita, bukan currency; ATURAN.md §4.9 tidak dilanggar
// karena ini bukan keyword kategori). Currency yang tidak match satu pun -> skip
// (fail-closed, hemat budget AI — langkah 2 plan U-5b).
const POSREVIEW_CURRENCY_KEYWORDS = {
  USD: ['fed', 'fomc', 'dollar', 'usd', 'powell', 'nonfarm', 'nfp', 'treasury'],
  EUR: ['ecb', 'euro', 'eur', 'lagarde', 'eurozone'],
  GBP: ['boe', 'pound', 'gbp', 'sterling', 'bailey'],
  JPY: ['boj', 'yen', 'jpy', 'ueda'],
  AUD: ['rba', 'aussie', 'aud', 'australia'],
  CAD: ['boc', 'loonie', 'cad', 'canada'],
  CHF: ['snb', 'franc', 'chf', 'swiss'],
  NZD: ['rbnz', 'kiwi', 'nzd', 'zealand'],
  XAU: ['gold', 'xau', 'bullion'],
};

function detectCurrencyLegs(title) {
  const t = String(title || '').toLowerCase();
  const legs = [];
  for (const [ccy, kws] of Object.entries(POSREVIEW_CURRENCY_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) legs.push(ccy);
  }
  return legs;
}

// Duplikasi SADAR dari api/_position_review.js isCorroborated (Docker vps/
// terisolasi dari build context app utama, lihat catatan kepala file — pola
// sama newscat.js/YAHOO_TO_DERIV_SYMBOL). Behavioral test (bukan byte-diff,
// karena function ini menyatu di file besar) menjaga dua sisi tetap sinkron —
// lihat test/vps/position_review.test.js.
// - kategori 'geopolitical': butuh >=1 item LAIN (guid beda) dalam +-30 menit
//   dengan overlap >=2 token signifikan (lowercase, buang stopword, token >3 huruf).
// - 'market-moving' (data/bank sentral terjadwal) = corroborated by default.
const POSREVIEW_STOPWORDS = new Set(['dengan', 'yang', 'untuk', 'dari', 'akan', 'pada', 'dalam', 'oleh',
  'atau', 'juga', 'masih', 'sudah', 'telah', 'saat', 'para', 'ini', 'itu', 'the', 'and', 'for',
  'with', 'from', 'that', 'this', 'have', 'has', 'been', 'after', 'before', 'over', 'into']);

function posReviewSignificantTokens(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !POSREVIEW_STOPWORDS.has(t));
}

function isCorroborated(item, recentItems) {
  if (!item) return false;
  if (item.cat === 'market-moving') return true;
  if (item.cat !== 'geopolitical') return false;
  const itemMs = Date.parse(item.pubDate);
  if (!Number.isFinite(itemMs)) return false;
  const itemTokens = new Set(posReviewSignificantTokens(item.title));
  if (itemTokens.size === 0) return false;
  const WINDOW_MS = 30 * 60 * 1000;
  for (const other of recentItems || []) {
    if (!other || other === item) continue;
    const otherGuid = other.guid || other.link;
    const itemGuid = item.guid || item.link;
    if (otherGuid && itemGuid && otherGuid === itemGuid) continue; // item sama, bukan korroborasi
    const otherMs = Date.parse(other.pubDate);
    if (!Number.isFinite(otherMs) || Math.abs(otherMs - itemMs) > WINDOW_MS) continue;
    const otherTokens = posReviewSignificantTokens(other.title);
    let overlap = 0;
    for (const t of otherTokens) { if (itemTokens.has(t)) overlap++; }
    if (overlap >= 2) return true;
  }
  return false;
}

// Buffer berita ringan di memori (bukan Redis — hemat budget) supaya isCorroborated
// bisa membandingkan item baru dengan item lain yang baru lewat, TERMASUK yang
// sudah lewat gate isHighImpactCategory (geopolitical). Window sedikit lebih
// lebar dari window korroborasi 30 menit supaya tidak memotong tepi.
const POSREVIEW_NEWS_BUFFER_MS = 35 * 60 * 1000;
let posReviewNewsBuffer = [];

function prunePosReviewNewsBuffer(nowMs) {
  posReviewNewsBuffer = posReviewNewsBuffer.filter(it => {
    const ms = Date.parse(it.pubDate);
    return Number.isFinite(ms) && nowMs - ms <= POSREVIEW_NEWS_BUFFER_MS;
  });
}

// Antrian recheck geopolitical UNCONFIRMED (memori, restart daemon = hilang —
// DITERIMA per Edge Case U-5: "paling apes satu review hilang, tidak pernah
// dobel", cooldown tetap di Redis). >30 menit sejak pubDate item asal -> hangus
// permanen (langkah 4 plan U-5b).
const POSREVIEW_RECHECK_WINDOW_MS = 30 * 60 * 1000;
let posReviewRecheckQueue = [];

async function processPosReviewRecheckQueue() {
  if (!posReviewRecheckQueue.length) return;
  const now = Date.now();
  const stillQueued = [];
  for (const q of posReviewRecheckQueue) {
    const ageMs = now - Date.parse(q.pubDate);
    if (!Number.isFinite(ageMs) || ageMs > POSREVIEW_RECHECK_WINDOW_MS) continue; // hangus, diskon permanen
    if (isCorroborated(q, posReviewNewsBuffer)) {
      await tryTriggerPosReview(q, q.legs, true);
    } else {
      stillQueued.push(q);
    }
  }
  posReviewRecheckQueue = stillQueued;
}

// Guard budget + eksekusi trigger — dipanggil setelah kandidat lolos filter
// currency + (corroborated ATAU market-moving). GET setup_log_auto:v1 HANYA di sini
// (bukan tiap poll), pola hemat sama dengan checkHardNewsSkip (langkah 3).
// PLAN U-7 (REVISI VISIBILITAS 2026-07-20): manajemen posisi HANYA untuk setup
// eksperimen auto-entry — dulu baca setup_log:v1 (ditulis U-5b sebelum revisi
// visibilitas landing), sekarang setup_log_auto:v1 (setup manual pengguna TIDAK
// PERNAH direview/diintervensi mesin).
async function tryTriggerPosReview(newsItem, legs, corroborated) {
  if (redisGuard.isDegraded()) return;
  if (!isFxMarketOpen()) return;
  if (!CRON_SECRET) return;

  let raw;
  try { raw = await redisCmd('GET', 'setup_log_auto:v1'); } catch (e) { return; }
  let log = [];
  try { log = raw ? JSON.parse(raw) : []; } catch (e) { return; }
  if (!Array.isArray(log)) return;

  const candidates = log.filter(s => s && s.status === 'open' && legsFromLabel(s.label).some(l => legs.includes(l)));
  if (!candidates.length) return;

  const cooldownSecs = parseInt(process.env.POSREVIEW_COOLDOWN_SECS || '21600', 10);
  const dailyCap = parseInt(process.env.POSREVIEW_DAILY_CAP || '3', 10);
  const dayKey = `posreview_daily:${new Date().toISOString().slice(0, 10)}`;

  for (const st of candidates) {
    // Cooldown per posisi (Lapis 5.1) — satu review per posisi per window, mencegah
    // burst headline nyaris bersamaan memicu review dobel (Edge Case U-5).
    const got = await redisCmd('SET', `posreview_cd:${st.id}`, '1', 'NX', 'EX', String(cooldownSecs));
    if (got !== 'OK') continue;

    // Cap harian global (Lapis 5.2) — dicek PER call (bukan per trigger), supaya
    // satu headline yang match banyak posisi tidak melompati cap.
    const count = await redisCmd('INCR', dayKey);
    if (count === 1) redisCmd('EXPIRE', dayKey, '90000').catch(() => {});
    if (count != null && count > dailyCap) {
      console.log(`daemon: U-5b posreview daily cap tercapai (${count}/${dailyCap}) — skip ${st.id}`);
      continue;
    }

    await triggerPositionReview({ id: st.id, trigger: { guid: newsItem.guid, title: newsItem.title, cat: newsItem.cat, corroborated } });
  }
}

// Client timeout WAJIB > maxDuration server (api/admin.js: 60s, vercel.json) —
// pelajaran S161. TANPA retry agresif (langkah 6): review telat lebih baik
// daripada dobel (beda filosofi dari triggerWithRetry Q-6/U-3).
const POSREVIEW_CLIENT_TIMEOUT_MS = 65000;

async function triggerPositionReview(body) {
  if (!CRON_SECRET) return;
  try {
    const r = await fetch(`${APP_BASE_URL}/api/admin?action=position_review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POSREVIEW_CLIENT_TIMEOUT_MS),
    });
    console.log(`daemon: U-5b position_review ${body.id} -> HTTP ${r.status}`);
  } catch (e) {
    console.warn(`daemon: U-5b position_review ${body.id} gagal:`, e.message);
  }
}

// Entry point dipanggil per item news_history (market-moving/geopolitical saja,
// lihat pollNews). Deteksi currency -> guard market/degraded -> korroborasi ->
// trigger langsung (market-moving/corroborated) atau antre recheck (geopolitical
// unconfirmed, langkah 4).
async function handlePosReviewCandidate(newsItem) {
  const now = Date.now();
  posReviewNewsBuffer.push(newsItem);
  prunePosReviewNewsBuffer(now);

  const legs = detectCurrencyLegs(newsItem.title);
  if (!legs.length) return; // fail-closed, tidak match currency apa pun

  if (redisGuard.isDegraded()) return;
  if (!isFxMarketOpen()) return;

  const corroborated = isCorroborated(newsItem, posReviewNewsBuffer);
  if (newsItem.cat === 'geopolitical' && !corroborated) {
    try {
      await redisCmd('LPUSH', 'posreview_skip_log', JSON.stringify({ ts: now, guid: newsItem.guid, title: newsItem.title, reason: 'unconfirmed' }));
      await redisCmd('LTRIM', 'posreview_skip_log', '0', '49');
    } catch (e) { /* opsional, gagal log tidak boleh menggagalkan antrian recheck */ }
    if (!posReviewRecheckQueue.some(q => q.guid === newsItem.guid)) {
      posReviewRecheckQueue.push({ ...newsItem, legs });
    }
    return;
  }

  await tryTriggerPosReview(newsItem, legs, corroborated);
}

// ══════════════════════════════════════════════════════════════════════════
// Q-5: alert level harga — event-driven, dipicu langsung dari tiap update
// harga live Q-3 (handleOhlcvUpdate), BUKAN timer polling terpisah.
//
// AUDIT BUDGET (2026-07-18, setelah versi awal ternyata bisa sampai ~80.000
// GET/hari kalau tick deras di 14 pair — jauh di atas target <3.000/hari Q-2):
// zona konfluensi (ohlcv_analysis:<symbol>) itu HANYA berubah kalau
// ohlcv_analyze dijalankan ulang (cron/klik user), bukan tiap detik — jadi
// data zona di-cache in-memory ZONE_DATA_CACHE_TTL_MS (5 menit) per symbol,
// TERPISAH dari seberapa sering perbandingan harga-vs-zona jalan (itu murni
// komputasi lokal, boleh sesering apa pun karena tidak menyentuh Redis).
// Hasil: GET Redis dibatasi ke maks 14 pair x (1440 menit/5) = ~4.032/hari,
// bukan puluhan ribu.
//
// Sumber zona: ohlcv_analysis:<symbol> (HTTP... eh, dibaca LANGSUNG dari Redis
// di sini, bukan lewat HTTP — key SAMA yang diisi admin.js ohlcv_analyze),
// BUKAN rr_cache_v2 (itu cache skew CME, beda data). Opsional-terpisah: kalau
// cache belum ada untuk suatu pair (baru fresh kalau pair itu pernah
// dibuka/dianalisa), pair itu di-skip diam-diam.
// ══════════════════════════════════════════════════════════════════════════
const ZONE_DATA_CACHE_TTL_MS = 5 * 60 * 1000;
const ZONE_CHECK_DEBOUNCE_MS = 3 * 1000; // sanity debounce CPU, BUKAN pembatas budget Redis (itu tugas cache TTL di atas)
const zoneDataCache = {};      // symbol -> { conf, fetchedAt }
const zoneFetchInFlight = {};  // symbol -> Promise sedang refresh (cegah thundering-herd saat cache basi)
const lastZoneCheckAt = {};

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

async function getZoneData(yahooSymbol) {
  const cached = zoneDataCache[yahooSymbol];
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < ZONE_DATA_CACHE_TTL_MS) return cached.conf;
  if (redisGuard.isDegraded()) return cached ? cached.conf : null; // pakai basi/skip, jangan tambah beban Redis
  if (zoneFetchInFlight[yahooSymbol]) return zoneFetchInFlight[yahooSymbol];
  const p = (async () => {
    let conf = null;
    try {
      const raw = await redisCmd('GET', `ohlcv_analysis:${yahooSymbol}`);
      if (raw) {
        const data = JSON.parse(raw);
        if (data?.confluence && Number.isFinite(data.confluence.tolerance)) conf = data.confluence;
      }
    } catch (e) { /* conf tetap null, dicoba lagi setelah TTL cache lewat */ }
    zoneDataCache[yahooSymbol] = { conf, fetchedAt: Date.now() };
    zoneFetchInFlight[yahooSymbol] = null;
    return conf;
  })();
  zoneFetchInFlight[yahooSymbol] = p;
  return p;
}

async function checkPriceZonesFor(yahooSymbol) {
  const price = lastLivePrice[yahooSymbol];
  if (price == null) return; // belum ada data live dari Q-3 untuk pair ini
  const conf = await getZoneData(yahooSymbol);
  if (!conf) return;
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

async function maybeCheckPriceZone(yahooSymbol) {
  const now = Date.now();
  if (now - (lastZoneCheckAt[yahooSymbol] || 0) < ZONE_CHECK_DEBOUNCE_MS) return;
  lastZoneCheckAt[yahooSymbol] = now;
  await checkPriceZonesFor(yahooSymbol);
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
  if (!CRON_SECRET) { console.warn(`daemon: CRON_SECRET kosong, skip trigger ${path}`); return false; }
  try {
    const r = await fetch(`${APP_BASE_URL}${path}`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal: AbortSignal.timeout(55000),
    });
    console.log(`daemon: trigger ${path} -> HTTP ${r.status}`);
    return r.ok;
  } catch (e) { console.warn(`daemon: trigger ${path} gagal:`, e.message); return false; }
}

// SELF-HEALING LAPIS 3a: scheduler tidak boleh "sekali gagal, ya sudah" —
// gagal (timeout/5xx/network) dicoba ulang SEKALI setelah 5 menit. Masih gagal
// juga → alert Telegram (dedup in-memory 6 jam, karena hourly ohlcv_sync bisa
// memicu tiap jam kalau Vercel down lama — GH Actions paralel tetap jadi
// penyelamat selama masa itu).
const TRIGGER_RETRY_DELAY_MS = 5 * 60 * 1000;
let lastSchedFailAlertAt = 0;

async function triggerWithRetry(path) {
  if (await triggerEndpoint(path)) return true;
  console.warn(`daemon: trigger ${path} gagal — retry sekali dalam ${TRIGGER_RETRY_DELAY_MS / 60000} menit (self-heal)`);
  await new Promise(r => setTimeout(r, TRIGGER_RETRY_DELAY_MS));
  if (await triggerEndpoint(path)) return true;
  const now = Date.now();
  if (now - lastSchedFailAlertAt > 6 * 60 * 60 * 1000) {
    lastSchedFailAlertAt = now;
    await sendTelegram(`*Scheduler gagal* — ${path} gagal 2x berturut (asli + retry 5 menit). GH Actions paralel masih jalan; cek log Vercel/Railway.`);
  }
  return false;
}

async function runDigestCycle() {
  await triggerWithRetry('/api/market-digest');
  await triggerWithRetry('/api/admin?action=ohlcv_analyze&symbol=GC%3DF&label=XAU%2FUSD');
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
  cron.schedule('5 * * * *', () => triggerWithRetry('/api/admin?action=ohlcv_sync').catch(() => {}));
  console.log('daemon: Q-6 scheduler aktif (digest 3x/hari + ohlcv_sync tiap jam, paralel GH Actions)');

  // U-3 (2026-07-20, Plan U): auto-entry virtual — menit ke-15 supaya tidak
  // tabrakan waktu dengan slot digest (00:00/07:00/12:30) yang bisa menelan
  // slot auto-entry via dedup 30 menit ohlcv_analyze (api/admin.js).
  for (const hour of AUTO_ENTRY_HOURS_UTC) {
    cron.schedule(`15 ${hour} * * *`, () => runAutoEntryCycle().catch(e => console.warn('daemon: runAutoEntryCycle gagal:', e.message)));
  }
  if (AUTO_ENTRY_HOURS_UTC.length) {
    console.log(`daemon: U-3 auto-entry aktif — pair ${AUTO_ENTRY_PAIRS.join(',')} @ jam ${AUTO_ENTRY_HOURS_UTC.join(',')} UTC`);
  }
  if (Number.isFinite(AUTO_CONSISTENCY_HOUR_UTC)) {
    cron.schedule(`45 ${AUTO_CONSISTENCY_HOUR_UTC} * * *`, () => runConsistencyCheck().catch(e => console.warn('daemon: runConsistencyCheck gagal:', e.message)));
    console.log(`daemon: U-3 uji konsistensi aktif — pair ${AUTO_ENTRY_PAIRS[0] || '(kosong)'} @ jam ${AUTO_CONSISTENCY_HOUR_UTC}:45 UTC`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PLAN U-3 (2026-07-20): scheduler auto-entry virtual (paper trading di
// setup_log:v1 — TANPA API broker, TANPA uang/demo riil) + filter berita
// keras + sub-riset latensi calendar_v1 + uji konsistensi LLM.
//
// Prasyarat U-2 (flag `auto=1` di ohlcv_analyze yang menandai source:'auto'
// di setup_log) BELUM SELESAI saat modul ini ditulis — lihat komentar
// api/admin.js sekitar penulisan setup_log ("flag auto=1 ... belum ada di
// paket ini"). Desain di sini SENGAJA fail-forward: daemon tetap kirim
// `auto=1` di tiap panggilan; backend yang belum paham param itu cukup
// mengabaikannya (setup tetap tercatat source:'manual' sampai U-2 menyusul).
// Begitu U-2 landing, marking source:'auto' otomatis aktif TANPA ubah baris
// di bawah — tidak perlu menunggu U-2 untuk menulis paket ini.
//
// LAPIS 2 (auto-cancel virtual) DI-DESCOPE untuk rilis ini: sub-riset wajib
// (ukur median latensi field `actual` calendar_v1 dari >=3 event high-impact
// nyata, lihat plan §U-3 langkah 3a) TIDAK BISA dituntaskan sinkron dalam
// satu sesi kerja — dicek langsung ke calendar_v1 produksi (read-only) saat
// modul ini ditulis (2026-07-20 01:xx WIB): event high-impact berikutnya
// (CAD Inflation Rate YoY) baru jatuh 2026-07-20 19:30 WIB, >18 jam dari
// waktu penulisan. Sesuai klausul plan sendiri ("kalau median >30 menit,
// descope Lapis 2, jangan dipaksakan") — data yang TIDAK BISA diverifikasi
// diperlakukan sama dengan "belum terbukti aman", jadi Lapis 2 tidak
// diaktifkan di paket ini. `pollCalendarLatency` di bawah tetap dibangun &
// jalan begitu daemon live, supaya sesi berikutnya bisa memutuskan dari data
// asli (>=3 sampel `calendar_actual_latency_log:v1`), bukan tebakan.
// ══════════════════════════════════════════════════════════════════════════

// symbol/label Yahoo yang dipahami ohlcv_analyze (api/admin.js), di-key pakai
// penamaan Deriv (konsisten dengan YAHOO_TO_DERIV_SYMBOL Q-3 di atas) supaya
// env var AUTO_ENTRY_PAIRS satu bahasa dengan daemon ini. XAU sengaja TIDAK
// ada di YAHOO_TO_DERIV_SYMBOL (Q-3 streaming tidak cover XAU/USD), jadi peta
// ini terpisah, bukan reuse.
const AUTO_ENTRY_SYMBOL_MAP = {
  frxXAUUSD: { symbol: 'GC=F',     label: 'XAU/USD' },
  frxEURUSD: { symbol: 'EURUSD=X', label: 'EUR/USD' },
  frxGBPUSD: { symbol: 'GBPUSD=X', label: 'GBP/USD' },
  frxUSDJPY: { symbol: 'USDJPY=X', label: 'USD/JPY' },
  frxAUDUSD: { symbol: 'AUDUSD=X', label: 'AUD/USD' },
  frxUSDCAD: { symbol: 'USDCAD=X', label: 'USD/CAD' },
  frxUSDCHF: { symbol: 'USDCHF=X', label: 'USD/CHF' },
  frxNZDUSD: { symbol: 'NZDUSD=X', label: 'NZD/USD' },
};

// Golden Trio (2026-07-22, diskusi user — percepat akumulasi sampel Plan U dari
// ~50 hari ke ~16 hari, n≈33/pair tetap lolos ambang CLT n≥30, lihat
// daun_merah_riset.md): default 2 pair -> 3 pair (tambah GBP/USD).
const AUTO_ENTRY_PAIRS = (process.env.AUTO_ENTRY_PAIRS || 'frxXAUUSD,frxEURUSD,frxGBPUSD')
  .split(',').map(s => s.trim()).filter(Boolean);
const AUTO_ENTRY_HOURS_UTC = (process.env.AUTO_ENTRY_HOURS_UTC || '8,13')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
const AUTO_CONSISTENCY_HOUR_UTC = parseInt(process.env.AUTO_CONSISTENCY_HOUR_UTC || '10', 10);
const HARD_NEWS_WINDOW_MS = 4 * 3600 * 1000;
const AUTO_SKIP_LOG_CAP = 200;
const CONSISTENCY_LOG_CAP = 60;
const CALENDAR_LATENCY_LOG_CAP = 100;
const CALENDAR_LATENCY_POLL_MS = 10 * 60 * 1000;
const CALENDAR_LATENCY_CUTOFF_MS = 4 * 3600 * 1000; // actual masih kosong setelah ini = berhenti dicek, bukan sampel valid

function legsFromLabel(label) {
  return String(label || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
}

// Duplikasi SADAR dari _calEventMsWib (api/admin.js) — pure function, aman
// diduplikasi tanpa require lintas folder (vps/ Docker build terisolasi,
// lihat catatan kepala file). Event kalender selalu WIB (+07:00).
function calEventMsWib(dateStr, timeWib) {
  if (!dateStr || !timeWib || timeWib === 'Tentative') return null;
  const m = /^(\d{2}):(\d{2})/.exec(timeWib);
  if (!m) return null;
  const t = new Date(`${dateStr}T${m[1]}:${m[2]}:00+07:00`).getTime();
  return isNaN(t) ? null : t;
}

// Event High-impact pertama untuk currency di `legs` yang jatuh dalam
// (nowMs, nowMs+windowMs] — dipakai Lapis 1 (filter berita keras).
function findHardNewsEvent(events, legs, nowMs, windowMs = HARD_NEWS_WINDOW_MS) {
  if (!Array.isArray(events) || !Array.isArray(legs) || legs.length === 0) return null;
  for (const e of events) {
    if (!e || e.impact !== 'High' || !legs.includes(e.currency)) continue;
    const ms = calEventMsWib(e.date, e.time_wib);
    if (ms == null) continue;
    if (ms > nowMs && ms <= nowMs + windowMs) return e;
  }
  return null;
}

function firstNumber(str) {
  const m = String(str == null ? '' : str).match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// Toleransi 0.5% relatif antar 3x panggilan — cukup ketat mendeteksi level
// yang benar-benar melompat, cukup longgar untuk pembulatan wajar.
const CONSISTENCY_TOLERANCE_PCT = 0.005;

// values: array angka/NaN dari 3x panggilan (mis. firstNumber(entry_zone) tiap call).
// null = tidak cukup data buat dibandingkan (seharusnya tidak terjadi, selalu 3 call).
function levelsWithinTolerance(values, tolerancePct = CONSISTENCY_TOLERANCE_PCT) {
  const nums = values.filter(n => Number.isFinite(n));
  if (nums.length === 0) return true; // semua call sepakat TIDAK ada level (no-trade konsisten)
  if (nums.length !== values.length) return false; // sebagian ada level, sebagian tidak = tidak konsisten
  if (nums.length < 2) return null;
  const min = Math.min(...nums), max = Math.max(...nums);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return min === max;
  return (max - min) / Math.abs(mean) <= tolerancePct;
}

// calls: array hasil 3x panggilan { bias, entry_zone, sl, tp } ATAU null (call gagal).
function computeConsistency(calls) {
  const biases = calls.map(c => (c && c.bias) || null);
  const biasIdentical = biases.every(b => b != null) && biases.every(b => b === biases[0]);
  const entryTol = levelsWithinTolerance(calls.map(c => firstNumber(c && c.entry_zone)));
  const slTol    = levelsWithinTolerance(calls.map(c => firstNumber(c && c.sl)));
  const tpTol    = levelsWithinTolerance(calls.map(c => firstNumber(c && c.tp)));
  const known = [entryTol, slTol, tpTol].filter(t => t !== null);
  const levelsWithin = known.length ? known.every(Boolean) : null;
  return { bias_identical: biasIdentical, levels_within_tolerance: levelsWithin };
}

async function fetchMergedCalendarEvents() {
  const [rawThis, rawNext] = await Promise.all([
    redisCmd('GET', 'calendar_v1'),
    redisCmd('GET', 'calendar_next_v1'),
  ]);
  let calThis = null, calNext = null;
  try { calThis = rawThis ? JSON.parse(rawThis) : null; } catch (e) { /* biarkan null, jangan gagalkan pemanggil */ }
  try { calNext = rawNext ? JSON.parse(rawNext) : null; } catch (e) { /* sama */ }
  return [...((calThis && calThis.events) || []), ...((calNext && calNext.events) || [])];
}

// Lapis 1 — filter berita keras: null = aman lanjut generate, object = SKIP
// (alasan sudah ditulis ke auto_skip_log). Kalau CEK-nya sendiri gagal (Redis
// error dll), fail-open ke arah GENERATE (bukan blokir) — filter berita
// adalah lapisan tambahan di atas fungsi inti, sama semangatnya dengan
// getZoneData/checkPriceZonesFor di atas yang skip diam-diam saat data
// pendukung tidak tersedia.
async function checkHardNewsSkip(pair, label) {
  try {
    const events = await fetchMergedCalendarEvents();
    const legs = legsFromLabel(label);
    const hit = findHardNewsEvent(events, legs, Date.now());
    if (!hit) return null;
    const entry = {
      ts: Date.now(), pair, label, reason: 'hard_news',
      event: hit.event, currency: hit.currency, event_time_wib: `${hit.date} ${hit.time_wib}`,
    };
    await redisCmd('LPUSH', 'auto_skip_log', JSON.stringify(entry));
    await redisCmd('LTRIM', 'auto_skip_log', '0', String(AUTO_SKIP_LOG_CAP - 1));
    return entry;
  } catch (e) {
    console.warn(`daemon: checkHardNewsSkip ${pair} gagal (fail-open, tetap generate):`, e.message);
    return null;
  }
}

async function runAutoEntryCycle() {
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, U-3 auto-entry di-skip'); return; }
  if (!isFxMarketOpen()) return;
  for (const pair of AUTO_ENTRY_PAIRS) {
    const map = AUTO_ENTRY_SYMBOL_MAP[pair];
    if (!map) { console.warn(`daemon: AUTO_ENTRY_PAIRS berisi pair tak dikenal "${pair}", di-skip`); continue; }
    const skip = await checkHardNewsSkip(pair, map.label);
    if (skip) { console.log(`daemon: U-3 auto-entry ${pair} di-skip — hard news "${skip.event}" (${skip.event_time_wib})`); continue; }
    const path = `/api/admin?action=ohlcv_analyze&symbol=${encodeURIComponent(map.symbol)}&label=${encodeURIComponent(map.label)}&auto=1`;
    await triggerWithRetry(path);
  }
}

// Sub-riset 3a — instrumentasi latensi field `actual` calendar_v1. Poll
// ringan (budget: 2 GET/10 menit = ~288 command/hari), murni observasi, TIDAK
// memicu aksi apa pun (Lapis 2 sengaja di-descope, lihat komentar besar di
// atas). SET NX per event jadi penanda "sudah tercatat" supaya event yang
// sama tidak dobel-log di poll berikutnya.
async function pollCalendarLatency() {
  try {
    const events = await fetchMergedCalendarEvents();
    const now = Date.now();
    for (const e of events) {
      if (!e || e.impact !== 'High') continue;
      const ms = calEventMsWib(e.date, e.time_wib);
      if (ms == null) continue;
      const age = now - ms;
      if (age < 0 || age > CALENDAR_LATENCY_CUTOFF_MS) continue; // belum rilis, atau lewat jendela observasi
      const isFilled = e.actual !== null && e.actual !== undefined && e.actual !== '';
      if (!isFilled) continue; // dicek lagi di poll berikutnya s/d cutoff
      const seenKey = `calendar_latency_seen:${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
      const marked = await redisCmd('SET', seenKey, '1', 'NX', 'EX', String(Math.ceil(CALENDAR_LATENCY_CUTOFF_MS / 1000) + 3600));
      if (marked !== 'OK') continue; // sudah pernah dicatat
      const sample = { ts: now, event: e.event, currency: e.currency, scheduled_ms: ms, latency_ms: age };
      await redisCmd('LPUSH', 'calendar_actual_latency_log:v1', JSON.stringify(sample));
      await redisCmd('LTRIM', 'calendar_actual_latency_log:v1', '0', String(CALENDAR_LATENCY_LOG_CAP - 1));
      console.log(`daemon: sub-riset U-3 — actual "${e.event}" (${e.currency}) terisi ${Math.round(age / 60000)} menit setelah rilis`);
    }
  } catch (e) { console.warn('daemon: pollCalendarLatency gagal:', e.message); }
}

async function fetchJsonWithTimeout(path, timeoutMs = 55000) {
  if (!CRON_SECRET) return null;
  try {
    const r = await fetch(`${APP_BASE_URL}${path}`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) { console.warn(`daemon: fetchJsonWithTimeout ${path} -> HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) { console.warn(`daemon: fetchJsonWithTimeout ${path} gagal:`, e.message); return null; }
}

const CONSISTENCY_CALL_GAP_MS = 5000; // jeda antar 3x panggilan berturut

// Uji konsistensi LLM — 3x panggil ohlcv_analyze pair yang sama via
// `test_deepseek=1` (SAMA model dengan primary produksi 'deepseek-v4-flash',
// lihat api/admin.js sekitar testDeepseekOnly) dalam mode isDiagnosticOnly
// (TIDAK menulis cache produksi/setup_log — jalur existing, bukan modifikasi
// baru). 1x/hari, pair pertama dari AUTO_ENTRY_PAIRS.
async function runConsistencyCheck() {
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, U-3 uji konsistensi di-skip'); return; }
  if (!isFxMarketOpen()) return;
  const pair = AUTO_ENTRY_PAIRS[0];
  const map = pair && AUTO_ENTRY_SYMBOL_MAP[pair];
  if (!map) { console.warn('daemon: U-3 uji konsistensi — AUTO_ENTRY_PAIRS kosong/tak dikenal, di-skip'); return; }
  const path = `/api/admin?action=ohlcv_analyze&symbol=${encodeURIComponent(map.symbol)}&label=${encodeURIComponent(map.label)}&test_deepseek=1`;
  const calls = [];
  for (let i = 0; i < 3; i++) {
    const json = await fetchJsonWithTimeout(path);
    const s = json && json.structured;
    calls.push(s ? { bias: s.bias ?? null, entry_zone: s.entry_zone ?? null, sl: s.sl ?? null, tp: s.tp ?? null } : null);
    if (i < 2) await new Promise(r => setTimeout(r, CONSISTENCY_CALL_GAP_MS));
  }
  const { bias_identical, levels_within_tolerance } = computeConsistency(calls);
  const entry = { ts: Date.now(), pair, label: map.label, calls, bias_identical, levels_within_tolerance };
  try {
    await redisCmd('LPUSH', 'consistency_log:v1', JSON.stringify(entry));
    await redisCmd('LTRIM', 'consistency_log:v1', '0', String(CONSISTENCY_LOG_CAP - 1));
    console.log(`daemon: U-3 uji konsistensi ${pair} — bias_identical=${bias_identical} levels_within_tolerance=${levels_within_tolerance}`);
  } catch (e) { console.warn('daemon: gagal tulis consistency_log:v1:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// SELF-HEALING LAPIS 3b: supervisor freshness data. Tiap 10 menit cek umur
// candle sentinel (EURUSD, pair paling likuid) di Redis: kalau candle terakhir
// >3 jam padahal market FX buka, berarti SEMUA jalur pengisi (stream Q-3, cron
// daemon, GH Actions) sedang gagal → daemon MENYEMBUHKAN sendiri dengan
// trigger ohlcv_sync (jalur Plan P penuh: Yahoo→Deriv→Twelve Data), bukan cuma
// mengeluh. Kunci NX 1 jam mencegah trigger bertubi-tubi; kalau SETELAH heal
// dicoba data masih basi juga (NX gagal + tetap stale) baru eskalasi ke
// Telegram (dedup 6 jam). Budget: 1 GET/10 menit = ~144 command/hari.
//
// isFxMarketOpen DIDUPLIKASI SADAR di api/_market_hours.js (Vercel tidak bisa
// require lintas build ke vps/, lihat catatan kepala file) — dijaga sinkron
// oleh test/vps/self_healing.test.js (sweep 336 jam dibandingkan).
// ══════════════════════════════════════════════════════════════════════════
const SUPERVISOR_INTERVAL_MS = 10 * 60 * 1000;
const CANDLE_STALE_MS = 3 * 60 * 60 * 1000;
const SUPERVISOR_SENTINEL = 'EURUSD=X';

function isFxMarketOpen(date = new Date()) {
  const day = date.getUTCDay(), hour = date.getUTCHours();
  if (day === 6) return false;              // Sabtu tutup penuh
  if (day === 0) return hour >= 22;         // Minggu buka ~21:00 UTC; 22 = margin aman
  if (day === 5) return hour < 21;          // Jumat tutup 21:00 UTC
  return true;
}

function newestCandleEpoch(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let max = null;
  for (const c of arr) {
    const t = Number(c && c.t);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

function isCandleStale(arr, nowMs, staleMs = CANDLE_STALE_MS) {
  const t = newestCandleEpoch(arr);
  if (t == null) return true; // tidak ada data sama sekali = basi
  return nowMs - t * 1000 > staleMs;
}

let lastSupervisorHealAt = null; // observability untuk endpoint /status

async function supervisorTick() {
  try {
    if (!CRON_SECRET) return;                 // tidak bisa menyembuhkan tanpa secret — lapisan Vercel yang ambil alih
    if (redisGuard.isDegraded()) return;      // jangan menambah beban saat Redis sendiri bermasalah
    if (!isFxMarketOpen(new Date())) return;  // weekend: candle tua itu normal
    const raw = await redisCmd('GET', `ohlcv:${SUPERVISOR_SENTINEL}:1h`);
    let arr = null;
    try { arr = raw ? JSON.parse(raw) : null; } catch (e) { arr = null; }
    if (!isCandleStale(arr, Date.now())) return;
    const got = await redisCmd('SET', 'selfheal:ohlcv_sync', '1', 'NX', 'EX', '3600');
    if (got === 'OK') {
      console.warn('daemon: supervisor — candle basi >3 jam saat market buka, trigger ohlcv_sync (self-heal)');
      lastSupervisorHealAt = Date.now();
      await triggerEndpoint('/api/admin?action=ohlcv_sync');
    } else {
      // Heal sudah dicoba <1 jam lalu dan data MASIH basi — eskalasi.
      const lastTs = await redisCmd('GET', 'selfheal:ohlcv_alert_ts');
      if (!lastTs || Date.now() - Number(lastTs) > 6 * 60 * 60 * 1000) {
        await sendTelegram('*Self-heal gagal* — candle FX masih basi >3 jam setelah trigger ohlcv_sync otomatis. Kemungkinan Yahoo+Deriv+Twelve Data down bersamaan atau bug — cek log Vercel.');
        await redisCmd('SET', 'selfheal:ohlcv_alert_ts', String(Date.now()), 'EX', '86400');
      }
    }
  } catch (e) { console.warn('daemon: supervisorTick gagal:', e.message); }
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
      // Observability self-healing (lapis 1-3) — dibaca manual saat debug.
      ws_last_activity_age_s: lastWsActivityAt ? Math.round((Date.now() - lastWsActivityAt) / 1000) : null,
      redis_guard: redisGuard.state(),
      last_supervisor_heal_at: lastSupervisorHealAt,
      // U-3 observability — Lapis 2 (auto-cancel) SENGAJA tidak ada di sini,
      // di-descope (lihat komentar besar U-3 di atas).
      auto_entry: { pairs: AUTO_ENTRY_PAIRS, hours_utc: AUTO_ENTRY_HOURS_UTC, consistency_hour_utc: AUTO_CONSISTENCY_HOUR_UTC },
    }));
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`daemon: HTTP server listening on 0.0.0.0:${PORT}`);
  });
}

function main() {
  registerProcessSafetyNet();
  beat();
  setInterval(beat, BEAT_INTERVAL_MS);
  startHttpServer();
  startDerivStream();
  setInterval(wsWatchdogTick, WS_PING_INTERVAL_MS);
  setInterval(() => pollNews().catch(() => {}), NEWS_POLL_INTERVAL_MS);
  setInterval(() => supervisorTick().catch(() => {}), SUPERVISOR_INTERVAL_MS);
  // Q-5 TIDAK pakai timer sendiri lagi — dipicu langsung dari handleOhlcvUpdate
  // (event-driven, lihat komentar di atas maybeCheckPriceZone).
  // U-3 sub-riset 3a: poll murni observasi, tidak butuh CRON_SECRET (baca
  // Redis langsung, bukan HTTP) — jalan walau scheduler Q-6 di atas di-skip.
  setInterval(() => pollCalendarLatency().catch(() => {}), CALENDAR_LATENCY_POLL_MS);
  startScheduler();
}

if (require.main === module) main();

module.exports = {
  mergeClosedCandle, normalizeDerivCandle, isHighImpactCategory, priceInZone,
  YAHOO_TO_DERIV_SYMBOL, DERIV_TO_YAHOO_SYMBOL,
  // Self-healing (pure/testable):
  createRedisGuard, shouldForceReconnect, isFxMarketOpen, newestCandleEpoch, isCandleStale,
  // U-3 (pure/testable):
  legsFromLabel, calEventMsWib, findHardNewsEvent, firstNumber, levelsWithinTolerance,
  computeConsistency, AUTO_ENTRY_SYMBOL_MAP, AUTO_ENTRY_PAIRS, AUTO_ENTRY_HOURS_UTC,
  // U-3 (async, di-export untuk simulasi lokal manual — bukan dipakai node:test):
  checkHardNewsSkip, runAutoEntryCycle, runConsistencyCheck, pollCalendarLatency,
  // U-5b (pure/testable):
  detectCurrencyLegs, isCorroborated, posReviewSignificantTokens, POSREVIEW_CURRENCY_KEYWORDS,
  // U-5b (async, di-export untuk simulasi lokal manual — bukan dipakai node:test):
  handlePosReviewCandidate, tryTriggerPosReview, triggerPositionReview, processPosReviewRecheckQueue,
};
