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
  // Q-7: deteksi dini TP/SL setup_log_auto:v1 dari harga live yang sama (lihat
  // maybeTriggerSetupWatch di bawah) — event-driven juga, bukan timer terpisah.
  maybeTriggerSetupWatch(yahooSymbol, candle.c).catch(e => console.warn(`daemon: cek setup watch ${yahooSymbol} gagal:`, e.message));

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
// 60 detik, klasifikasi via newscat.js lokal (SAMA, lihat catatan atas file).
// ══════════════════════════════════════════════════════════════════════════
// Efisiensi command Redis (2026-08-15, audit dashboard Upstash — 326K/500K
// command/bulan): tiap tick pollNews() SELALU 1x ZRANGEBYSCORE news_history
// walau tidak ada berita baru (baseline biaya sebelumnya: 24 jam / 30 detik =
// 2.880 command/hari HANYA untuk cek "ada yang baru?"). 30s -> 60s membelah
// baseline ini jadi ~1.440/hari — alert Telegram (posisi manual/kalender/
// market-moving) TETAP jalan, cuma latensi terburuk naik dari <=30s ke <=60s,
// bukan fitur yang butuh presisi sub-menit.
const NewsCat = require('./newscat.js');
const NEWS_POLL_INTERVAL_MS = 60 * 1000;
let newsCursorMs = 0;

function isHighImpactCategory(cat) {
  return cat === 'market-moving';
}

async function sendNewsAlert(item, cat) {
  // Rapat user 2026-08-11: Telegram tanpa link FinancialJuice (biar tidak
  // kepanjangan) — web push tetap pakai url in-app '/#ringkasan', bukan link FJ.
  const text = `*Berita High-Impact* (${cat})\n${item.title}`;
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

      // Rapat user 2026-08-11: notifikasi Telegram posisi manual open — lihat
      // blok komentar besar di bawah pollNews(). Semua kategori (tidak digate
      // seperti U-5b di atas), tanpa syarat korroborasi (keputusan user).
      // Fix 2026-08-11: kirim `cat` supaya kalau berita ini JUGA market-moving,
      // pesannya digabung jadi satu (bukan dobel dengan alert Q-4 di bawah) —
      // lihat catatan dalam checkOpenPositionNewsMatch.
      try { await checkOpenPositionNewsMatch(item, cat); }
      catch (e) { console.warn('daemon: checkOpenPositionNewsMatch gagal:', e.message); }

      // Rapat user 2026-08-11: notifikasi kalender ekonomi impact High — hanya
      // headline rilis kalender (cat 'econ-data') yang dicek terhadap calendar_v1.
      if (cat === 'econ-data') {
        try {
          const calEvents = await getMergedCalendarEventsCached();
          await checkEconDataHighImpact(item, calEvents);
        } catch (e) { console.warn('daemon: checkEconDataHighImpact gagal:', e.message); }
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
// Notifikasi Telegram posisi manual open (rapat user, 2026-08-11): user sering
// kena masalah tidak sempat tutup posisi karena telat tahu berita yang relevan
// ke pair yang sedang dia buka SENDIRI di broker (bukan eksperimen auto-entry
// setup_log_auto:v1 — itu domain U-5b/positionReviewHandler di atas). Satu-
// satunya sumber "posisi mana yang open" yang app ini punya adalah jurnal
// manual (setup_log:v1 via journal.js) — keputusan rapat: pakai itu apa
// adanya, user sendiri yang bertanggung jawab menjaga status open/closed
// akurat, TIDAK ada integrasi broker.
//
// SENGAJA beda desain dari U-5b/Lapis 1b: TIDAK ada gate kategori
// (geopolitical/energy/macro saja) dan TIDAK ada syarat korroborasi (>=2
// sumber) — user eksplisit menolak syarat itu di rapat ("aku sendiri yang
// cek dan tentukan itu masalah atau enggak"). Satu-satunya anti-spam yang
// DIA setujui: dedup wire re-hash (statement yang sama diberitakan ulang
// dengan kata berbeda dalam window pendek) via overlap token signifikan,
// pola sama posReviewSignificantTokens/isCorroborated tapi tujuannya beda
// (itu "cukup sumber untuk dipercaya", ini "jangan kirim ulang cerita sama").
// ══════════════════════════════════════════════════════════════════════════

function pairToLegs(pairLabel) {
  return String(pairLabel || '').toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
}

// Pure: pair open mana saja yang currency-nya disebut headline ini — dipakai
// gabung jadi SATU notifikasi kalau >1 posisi share currency yang sama
// (keputusan rapat: gabung, bukan kirim terpisah per pair, biar tidak numpuk).
function matchOpenPairsToHeadline(openPairs, headlineLegs) {
  if (!Array.isArray(openPairs) || !Array.isArray(headlineLegs) || headlineLegs.length === 0) return [];
  return openPairs.filter(pair => pairToLegs(pair).some(leg => headlineLegs.includes(leg)));
}

const POSNOTIFY_DEDUP_WINDOW_MS = 20 * 60 * 1000; // 20 menit — jendela anti-rehash disepakati rapat
const POSNOTIFY_OVERLAP_THRESHOLD = 3; // lebih ketat dari isCorroborated (>=2) — hindari salah anggap 2 cerita beda jadi "sama"

// Pure: `recentSent` = [{ tokens:Set, sentAt:ms }]. True kalau newTokens
// overlap signifikan dengan salah satu entry yang masih dalam window waktu.
function isDuplicateHeadline(newTokens, recentSent, nowMs, windowMs = POSNOTIFY_DEDUP_WINDOW_MS, threshold = POSNOTIFY_OVERLAP_THRESHOLD) {
  if (!Array.isArray(recentSent)) return false;
  return recentSent.some(e => {
    if (!e || nowMs - e.sentAt > windowMs) return false;
    let overlap = 0;
    for (const t of newTokens) if (e.tokens.has(t)) overlap++;
    return overlap >= threshold;
  });
}

let posNotifyRecentSent = []; // in-memory, sengaja tidak di-persist Redis (restart = anti-rehash reset, dampak minor)

// Baca semua pair berstatus 'open' dari jurnal manual, lintas semua device
// yang pernah menulis journal (`journal_devices`, pola sama runCronThesisSweep
// di api/market-digest.js). Cap devices/entries — single-user, cukup generos.
async function fetchOpenJournalPairs() {
  try {
    const deviceIds = (await redisCmd('SMEMBERS', 'journal_devices') || []).slice(0, 10);
    const pairs = new Set();
    for (const devId of deviceIds) {
      const ids = (await redisCmd('ZRANGE', `journal_index:${devId}`, '0', '14', 'REV')) || [];
      for (const id of ids) {
        try {
          const raw = await redisCmd('GET', `journal:${devId}:${id}`);
          if (!raw) continue;
          const entry = JSON.parse(raw);
          if (entry.status === 'open' && entry.pair) pairs.add(String(entry.pair).toUpperCase().trim());
        } catch (e) { /* satu entry korup tidak boleh menggagalkan yang lain */ }
      }
    }
    return Array.from(pairs);
  } catch (e) { console.warn('daemon: fetchOpenJournalPairs gagal:', e.message); return []; }
}

// Cache 60 detik — posisi open jarang berubah (user buka/tutup manual,
// bukan tiap 30 detik), tidak perlu baca jurnal tiap tick pollNews.
let openPairsCache = null, openPairsCacheAt = 0;
const OPEN_PAIRS_CACHE_MS = 60 * 1000;
async function getOpenJournalPairsCached() {
  const now = Date.now();
  if (openPairsCache && now - openPairsCacheAt < OPEN_PAIRS_CACHE_MS) return openPairsCache;
  openPairsCache = await fetchOpenJournalPairs();
  openPairsCacheAt = now;
  return openPairsCache;
}

// `cat` opsional — kalau diisi dan hasilnya market-moving (lihat
// isHighImpactCategory), pesan ini DIGABUNG dengan alert Q-4 (sendNewsAlert)
// biar tidak dobel: audit 2026-08-11 menemukan headline market-moving yang
// match currency posisi open bisa memicu DUA pesan Telegram terpisah untuk
// berita yang sama (jalur ini + jalur Q-4 sendNewsAlert, dedup key beda-beda
// per jalur jadi tidak saling cegah). Fix: kalau kondisi ini terjadi, jalur
// ini yang kirim (lebih spesifik, sebut pair-nya) SEKALIGUS menandai dedup
// key milik Q-4 (`news_alert_sent:<guid>`) supaya gate isHighImpactCategory
// di pollNews() skip kirim ulang versi generiknya.
async function checkOpenPositionNewsMatch(item, cat) {
  const headlineLegs = detectCurrencyLegs(item.title);
  if (headlineLegs.length === 0) return;
  const openPairs = await getOpenJournalPairsCached();
  const matched = matchOpenPairsToHeadline(openPairs, headlineLegs);
  if (matched.length === 0) return;

  const guid = item.guid || item.link;
  if (guid) {
    const dedupOk = await redisCmd('SET', `posnotify_sent:${guid}`, '1', 'EX', '21600', 'NX');
    if (dedupOk !== 'OK') return; // guid ini sudah pernah dinotif (mis. replay backlog restart)
  }

  const nowMs = Date.now();
  posNotifyRecentSent = posNotifyRecentSent.filter(e => nowMs - e.sentAt <= POSNOTIFY_DEDUP_WINDOW_MS);
  const tokens = new Set(posReviewSignificantTokens(item.title));
  if (isDuplicateHeadline(tokens, posNotifyRecentSent, nowMs)) return; // wire re-hash, sudah dikirim beberapa menit lalu
  posNotifyRecentSent.push({ tokens, sentAt: nowMs });

  const isMarketMoving = isHighImpactCategory(cat);
  if (isMarketMoving && guid) {
    await redisCmd('SET', `news_alert_sent:${guid}`, '1', 'EX', '172800', 'NX');
  }
  const label = isMarketMoving ? `*[HIGH IMPACT] ${matched.join(', ')}*` : `*${matched.join(', ')}*`;
  await sendTelegram(`${label}: "${item.title}"`);
}

// Deteksi currency dari headline rilis kalender FinancialJuice ("<Negara>
// <Indikator> Actual X (Forecast Y, Previous Z)") — prefix nama negara di
// AWAL judul (bukan cari di mana pun dalam teks, supaya tidak salah tangkap
// mis. kata "us" sebagai pronoun di headline lain — headline econ-data selalu
// mulai dengan nama negara/wilayah per template FinancialJuice).
const ECON_COUNTRY_PREFIX_CURRENCY = [
  { re: /^u\.?s\.?\b/i, ccy: 'USD' }, { re: /^united states\b/i, ccy: 'USD' },
  { re: /^u\.?k\.?\b/i, ccy: 'GBP' }, { re: /^united kingdom\b/i, ccy: 'GBP' }, { re: /^britain\b/i, ccy: 'GBP' },
  { re: /^eurozone\b/i, ccy: 'EUR' }, { re: /^euro area\b/i, ccy: 'EUR' }, { re: /^germany\b/i, ccy: 'EUR' },
  { re: /^france\b/i, ccy: 'EUR' }, { re: /^italy\b/i, ccy: 'EUR' }, { re: /^spain\b/i, ccy: 'EUR' },
  { re: /^japan\b/i, ccy: 'JPY' }, { re: /^australia\b/i, ccy: 'AUD' }, { re: /^canada\b/i, ccy: 'CAD' },
  { re: /^switzerland\b/i, ccy: 'CHF' }, { re: /^new zealand\b/i, ccy: 'NZD' },
];

function detectEconCountryCurrency(title) {
  const t = String(title || '').trim();
  const hit = ECON_COUNTRY_PREFIX_CURRENCY.find(e => e.re.test(t));
  return hit ? hit.ccy : null;
}

// Jendela pencocokan longgar (90 menit) ke calendar_v1 — bukan menunggu field
// `actual` calendar_v1 sendiri terisi (sub-riset pollCalendarLatency di bawah
// belum membuktikan itu cukup cepat untuk notifikasi real-time), cukup
// pastikan ADA event impact High terjadwal untuk currency ini di sekitar
// waktu headline rilis muncul — kecepatan datang dari poll berita 30 detik.
const ECON_RELEASE_WINDOW_MS = 90 * 60 * 1000;

async function checkEconDataHighImpact(item, calEvents) {
  const ccy = detectEconCountryCurrency(item.title);
  if (!ccy) return;
  const hit = findRecentHardNewsEvent(calEvents, [ccy], Date.now(), ECON_RELEASE_WINDOW_MS);
  if (!hit) return; // tidak match event impact High terjadwal manapun -> bukan noise yang diinginkan user

  const guid = item.guid || item.link;
  if (guid) {
    const dedupOk = await redisCmd('SET', `posnotify_econ_sent:${guid}`, '1', 'EX', '21600', 'NX');
    if (dedupOk !== 'OK') return;
  }
  await sendTelegram(`*[HIGH] ${ccy}*: "${item.title}"`);
}

// calendar_v1/calendar_next_v1 jarang berubah dalam skala menit (beda dari
// berita) — cache 5 menit cukup aman, hindari 2 GET Redis tiap tick 30 detik
// padahal econ-data cuma muncul sesekali.
let calEventsCache = null, calEventsCacheAt = 0;
const CAL_EVENTS_CACHE_MS = 5 * 60 * 1000;
async function getMergedCalendarEventsCached() {
  const now = Date.now();
  if (calEventsCache && now - calEventsCacheAt < CAL_EVENTS_CACHE_MS) return calEventsCache;
  calEventsCache = await fetchMergedCalendarEvents();
  calEventsCacheAt = now;
  return calEventsCache;
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
  // Audit S218 (2026-07-23): headline guncangan pasokan energi Teluk (mis. ancaman
  // Iran menutup arus minyak Hormuz) relevan ke XAU lewat rantai safe-haven/inflasi
  // yang sudah mapan, TAPI sebelum ini cuma cocok kalau literally menyebut
  // "gold"/"xau"/"bullion" — headline "Iran will stop all Gulf oil flow..." lolos
  // tanpa terdeteksi sama sekali. Ditambah kata kunci guncangan pasokan spesifik
  // (BUKAN nama negara/tokoh geopolitik generik — supaya tidak kebablasan ke
  // headline Iran/Timur Tengah yang tidak relevan minyak/pasokan sama sekali).
  XAU: ['gold', 'xau', 'bullion', 'hormuz', 'opec', 'gulf oil', 'oil supply'],
};

// Audit S277 (2026-08-04): matching sebelumnya `t.includes(kw)` polos (substring)
// — "Saudi official..." salah match ke leg AUD gara-gara "Saudi" mengandung "aud",
// pola bug yang sama persis dengan "shipping"->"ppi" yang sudah difix di newscat.js.
// Precompiled word-boundary regex (bukan lowercase+includes) — dibangun sekali saat
// modul dimuat, bukan tiap panggilan.
const POSREVIEW_CURRENCY_KEYWORD_RE = Object.fromEntries(
  Object.entries(POSREVIEW_CURRENCY_KEYWORDS).map(([ccy, kws]) => [
    ccy,
    kws.map(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')),
  ])
);

function detectCurrencyLegs(title) {
  const t = String(title || '');
  const legs = [];
  for (const [ccy, res] of Object.entries(POSREVIEW_CURRENCY_KEYWORD_RE)) {
    if (res.some(re => re.test(t))) legs.push(ccy);
  }
  return legs;
}

// Duplikasi SADAR dari api/_position_review.js isCorroborated (Docker vps/
// terisolasi dari build context app utama, lihat catatan kepala file — pola
// sama newscat.js/YAHOO_TO_DERIV_SYMBOL). Behavioral test (bukan byte-diff,
// karena function ini menyatu di file besar) menjaga dua sisi tetap sinkron —
// lihat test/vps/position_review.test.js.
// - kategori 'geopolitical'/'energy'/'macro': butuh >=1 item LAIN (guid beda)
//   dalam +-30 menit dengan overlap >=2 token signifikan (lowercase, buang
//   stopword, token >3 huruf). 'energy' ikut disyaratkan korroborasi sejak
//   audit S218 (2026-07-23); 'macro' ditambah audit S274 (2026-08-03) — BUG
//   DITEMUKAN: pidato bank sentral (Powell/Lagarde/dst, kategori 'macro' di
//   newscat.js) sebelumnya lolos ke tryTriggerPosReview TANPA korroborasi SAMA
//   SEKALI (beda dari geopolitical/energy) — lihat catatan gate di
//   handlePosReviewCandidate di bawah, itu yang jadi akar bug-nya.
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

const POSREVIEW_CORROBORATION_ELIGIBLE_CATS = new Set(['geopolitical', 'energy', 'macro']);

// Bug nyata (2026-08-05): wire FinancialJuice rutin menerbitkan snapshot "<Bank>
// Interest Rate Probabilities" (chart probabilitas gaya CME FedWatch, BUKAN berita
// rilis/keputusan) untuk beberapa bank sentral berturut-turut dalam hitungan menit.
// Token signifikan (>3 huruf) headline-nya ("interest","rate","probabilities")
// SAMA persis lintas bank karena boilerplate template — nama bank sendiri (fed/ecb/
// rba/boe, semua <=3 huruf) kebuang filter panjang token, jadi overlap>=2 lolos
// walau keduanya soal bank yang BEDA TOTAL. Akibatnya 4 pair auto-entry sekaligus
// di-skip (vps/daemon.js checkBreakingNewsSkip) padahal tidak ada rilis/kejutan
// apa pun — sudah diakui di api/market-digest.js sebagai boilerplate "zero
// directional signal on its own". Snapshot ini TIDAK PERNAH dianggap terkorroborasi
// (baik sebagai subjek maupun sebagai "bukti" korroborasi item lain).
const WIRE_SNAPSHOT_RE = /\binterest rate probabilit(y|ies)\b/i;

function isCorroborated(item, recentItems) {
  if (!item) return false;
  if (WIRE_SNAPSHOT_RE.test(item.title)) return false;
  if (item.cat === 'market-moving') return true;
  if (!POSREVIEW_CORROBORATION_ELIGIBLE_CATS.has(item.cat)) return false;
  const itemMs = Date.parse(item.pubDate);
  if (!Number.isFinite(itemMs)) return false;
  const itemTokens = new Set(posReviewSignificantTokens(item.title));
  if (itemTokens.size === 0) return false;
  const WINDOW_MS = 30 * 60 * 1000;
  for (const other of recentItems || []) {
    if (!other || other === item) continue;
    if (WIRE_SNAPSHOT_RE.test(other.title)) continue; // snapshot boilerplate tidak sah jadi bukti korroborasi
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

// Audit S277 (2026-08-04): window "seberapa lama pasca-shock masih dianggap
// berisiko buat entry baru" — dipakai checkBreakingNewsSkip (breaking news) DAN
// checkHardNewsSkip (kalender, cek ke belakang) supaya satu makna konsisten di
// dua jalur. Keputusan user: 1 jam.
const BREAKING_NEWS_SKIP_WINDOW_MS = 60 * 60 * 1000;

// Pending retry infra (persisten) untuk auto-entry: ZSET index + per-pair data
// key: auto_pending_retries_z (ZSET score = safeAtMs, member = pair)
// per-pair data key: auto_pending_retry_data:{pair} -> JSON (meta, scheduledAt)
const AUTO_PENDING_RETRY_ZKEY = 'auto_pending_retries_z';
const AUTO_PENDING_RETRY_DATA_PREFIX = 'auto_pending_retry_data:';
const AUTO_PENDING_RETRY_TTL = 7 * 24 * 3600; // simpan maksimal 7 hari

// Schedule one pending retry for `pair` at `safeAtMs` (ms epoch). Dedup: keep
// the latest safeAt (max). Best-effort: failure to persist tidak mengubah alur
// utama (fail-open). Returns true if a schedule was created/updated.
async function scheduleAutoPendingRetry(pair, safeAtMs, reason, meta = {}) {
  try {
    const now = Date.now();
    if (!Number.isFinite(safeAtMs) || safeAtMs <= now) safeAtMs = now + 1000; // immediate-ish
    const existing = await redisCmd('ZSCORE', AUTO_PENDING_RETRY_ZKEY, pair);
    if (existing != null && Number(existing) >= safeAtMs) {
      // existing schedule is earlier-or-equal to this safeAt — keep it
      return false;
    }
    // update ZSET score + store payload
    await redisCmd('ZADD', AUTO_PENDING_RETRY_ZKEY, String(safeAtMs), pair);
    const payload = { pair, safeAtMs, reason, meta, scheduledAt: Date.now() };
    await redisCmd('SET', AUTO_PENDING_RETRY_DATA_PREFIX + pair, JSON.stringify(payload), 'EX', String(AUTO_PENDING_RETRY_TTL));
    console.log(`daemon: pending retry dijadwalkan untuk ${pair} @ ${new Date(safeAtMs).toISOString()} (reason=${reason})`);
    return true;
  } catch (e) {
    console.warn(`daemon: gagal scheduleAutoPendingRetry ${pair}:`, e.message);
    return false;
  }
}

// Process due pending retries: pop all members with score <= now and trigger
// runAutoEntryCycle for each pair (single-pair run). ZREM dilakukan before
// executing to avoid dupes; we also DEL per-pair payload for hygiene.
async function processPendingRetriesOnce() {
  if (!CRON_SECRET) return; // scheduler disabled in this env
  try {
    const now = Date.now();
    const pairs = await redisCmd('ZRANGEBYSCORE', AUTO_PENDING_RETRY_ZKEY, '-inf', String(now));
    if (!Array.isArray(pairs) || pairs.length === 0) return;
    for (const pair of pairs) {
      try {
        const removed = await redisCmd('ZREM', AUTO_PENDING_RETRY_ZKEY, pair);
        await redisCmd('DEL', AUTO_PENDING_RETRY_DATA_PREFIX + pair).catch(() => {});
        if (removed) {
          console.log(`daemon: mengeksekusi pending retry untuk ${pair}`);
          // runAutoEntryCycle akan memeriksa gate yang sama sebelum memicu
          await runAutoEntryCycle([pair]);
        }
      } catch (e) { console.warn(`daemon: eksekusi pending retry ${pair} gagal:`, e.message); }
    }
  } catch (e) { console.warn('daemon: processPendingRetriesOnce gagal:', e.message); }
}

// Buffer berita ringan di memori (bukan Redis — hemat budget) supaya isCorroborated
// bisa membandingkan item baru dengan item lain yang baru lewat, TERMASUK yang
// sudah lewat gate isHighImpactCategory (geopolitical). Retensi = BREAKING_NEWS_
// SKIP_WINDOW_MS (1 jam) + margin window korroborasi (30 menit) + sedikit slack —
// dulu cuma 35 menit (window korroborasi + slack tipis), TIDAK cukup untuk
// checkBreakingNewsSkip melihat berita yang pecah sampai 1 jam lalu (item sudah
// keburu di-prune sebelum window skip-nya habis).
const POSREVIEW_NEWS_BUFFER_MS = BREAKING_NEWS_SKIP_WINDOW_MS + 35 * 60 * 1000;
let posReviewNewsBuffer = [];

// Persist ke Redis (S218/S219 lanjutan, 2026-07-23) — buffer di atas MURNI memori,
// hilang tiap daemon restart/redeploy ("amnesia" korroborasi: krisis yang sedang
// berlangsung dianggap laporan pertama lagi setelah restart, butuh 2 laporan BARU
// sebelum dipercaya lagi). Selama fase development ini restart terjadi beberapa kali
// SEHARI (tiap push) — gap-nya nyata, bukan teoretis. Cuma kategori yang benar-benar
// dipakai isCorroborated/gate (geopolitical/energy/market-moving) yang di-persist —
// mayoritas volume berita (forex/equities/econ-data dst) TIDAK relevan buat
// korroborasi krisis, persist semuanya buang-buang budget Redis tanpa manfaat nyata.
// 'macro' ikut di-persist sejak audit S274 (2026-08-03) — kategori ini sekarang ikut
// disyaratkan korroborasi (lihat isCorroborated di atas), jadi butuh survive restart
// sama seperti geopolitical/energy.
// List + cap (pola sama auto_skip_log/posreview_skip_log), BUKAN ZSET presisi waktu —
// isCorroborated tetap menyaring by pubDate sendiri, cap 150 jauh lebih dari cukup
// menutup 35 menit untuk kategori sesempit ini.
const POSREVIEW_NEWS_BUFFER_REDIS_KEY = 'posreview_news_buffer';
const POSREVIEW_NEWS_BUFFER_REDIS_CAP = 150;
const POSREVIEW_NEWS_BUFFER_REDIS_CATS = new Set(['geopolitical', 'energy', 'macro', 'market-moving']);

// Pure (testable) — dipisah dari I/O supaya keputusan "layak di-persist atau
// tidak" bisa dites tanpa mock Redis, pola sama findHardNewsEvent/findBreakingNewsMatch.
function shouldPersistNewsBufferItem(item) {
  return !!(item && POSREVIEW_NEWS_BUFFER_REDIS_CATS.has(item.cat));
}

// Fire-and-forget, best-effort — kegagalan persist TIDAK BOLEH mengganggu alur
// utama (buffer in-memory tetap jadi sumber kebenaran selama proses hidup).
function persistNewsBufferItem(item) {
  if (!shouldPersistNewsBufferItem(item)) return;
  redisCmd('LPUSH', POSREVIEW_NEWS_BUFFER_REDIS_KEY, JSON.stringify(item))
    .then(() => redisCmd('LTRIM', POSREVIEW_NEWS_BUFFER_REDIS_KEY, '0', String(POSREVIEW_NEWS_BUFFER_REDIS_CAP - 1)))
    .catch(() => {});
}

// Pure (testable) — filter umur + parse-safety, dipakai loadNewsBufferFromRedis.
// String gagal parse dilewati diam-diam (data korup di Redis tidak boleh mandekkan
// boot); item lebih tua dari jendela buffer dibuang (sudah tidak relevan korroborasi).
// BUG DITEMUKAN & DIFIX (audit S277, 2026-08-04): dulu umur dihitung dari `pubDate`
// (waktu publikasi ASLI berita) vs jam dinding sekarang — kalau daemon sempat lag/
// restart dan berita telat diproses (terbukti live: gap ~89 menit), item yang BARU
// SAJA tiba di sistem langsung dianggap basi dan di-prune SEBELUM sempat dibandingkan
// dengan sibling-nya yang datang beberapa detik kemudian dalam batch backlog yang
// sama — akibatnya isCorroborated gagal total walau overlap token-nya jelas tinggi
// (kasus nyata: 3 headline "Australia household spending" gagal saling mengonfirmasi,
// review posisi AUD/NZD yang seharusnya trigger jadi tidak pernah jalan). Sekarang
// umur dihitung dari `_seenAt` (kapan daemon PERTAMA KALI melihat/memproses item ini),
// bukan `pubDate` — retensi buffer jadi soal "berapa lama sejak kita proses", bukan
// "berapa lama sejak dipublikasikan", sehingga backlog tidak lagi menghancurkan
// korroborasi antar-item yang sama-sama telat. Fallback ke pubDate kalau `_seenAt`
// tidak ada (data lama yang persisted SEBELUM fix ini) — tidak ada regresi untuk
// item yang sudah kadung tersimpan di Redis.
function filterFreshBufferItems(rawList, nowMs) {
  const restored = [];
  for (const s of rawList || []) {
    let item;
    try { item = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { continue; }
    const seenAt = Number.isFinite(item?._seenAt) ? item._seenAt : Date.parse(item?.pubDate);
    if (Number.isFinite(seenAt) && nowMs - seenAt <= POSREVIEW_NEWS_BUFFER_MS) restored.push(item);
  }
  return restored;
}

// Dipanggil SEKALI saat boot (main(), sebelum pollNews mulai jalan) — pulihkan
// buffer in-memory dari Redis supaya korroborasi krisis yang sedang berlangsung
// tidak "lupa" gara-gara restart. Fail-open: Redis kosong/gagal -> buffer mulai
// kosong seperti perilaku lama (tidak ada regresi, cuma tidak dapat manfaat baru).
async function loadNewsBufferFromRedis() {
  try {
    const raw = await redisCmd('LRANGE', POSREVIEW_NEWS_BUFFER_REDIS_KEY, '0', '-1');
    if (!Array.isArray(raw) || !raw.length) return;
    const restored = filterFreshBufferItems(raw, Date.now());
    posReviewNewsBuffer = restored.concat(posReviewNewsBuffer);
    if (restored.length) console.log(`daemon: posReviewNewsBuffer dipulihkan dari Redis — ${restored.length} item`);
  } catch (e) { console.warn('daemon: loadNewsBufferFromRedis gagal (fail-open, buffer mulai kosong):', e.message); }
}

// BUG DITEMUKAN & DIFIX (audit S277, 2026-08-04) — lihat catatan panjang di
// filterFreshBufferItems: basis umur diganti dari `pubDate` ke `_seenAt`.
function prunePosReviewNewsBuffer(nowMs) {
  posReviewNewsBuffer = posReviewNewsBuffer.filter(it => {
    const seenAt = Number.isFinite(it._seenAt) ? it._seenAt : Date.parse(it.pubDate);
    return Number.isFinite(seenAt) && nowMs - seenAt <= POSREVIEW_NEWS_BUFFER_MS;
  });
}

// Antrian recheck geopolitical UNCONFIRMED (memori, restart daemon = hilang —
// DITERIMA per Edge Case U-5: "paling apes satu review hilang, tidak pernah
// dobel", cooldown tetap di Redis). >30 menit sejak `_seenAt` item asal -> hangus
// permanen (langkah 4 plan U-5b). BUG DITEMUKAN & DIFIX (audit S277, 2026-08-04):
// dulu dihitung dari `pubDate` — item yang masuk antrian ini SUDAH pasti berumur
// >POSREVIEW_NEWS_BUFFER_MS by pubDate (itu justru KENAPA dia masuk sini, gagal
// korroborasi pertama kali), jadi begitu diukur ulang dari pubDate di tick
// berikutnya, langsung hangus permanen SEBELUM sempat dicoba korroborasi lagi —
// antrian recheck jadi tidak pernah benar-benar memberi kesempatan kedua. Sekarang
// diukur dari `_seenAt` (kapan PERTAMA KALI masuk antrian recheck ini), konsisten
// dengan filosofi retensi buffer di atas.
const POSREVIEW_RECHECK_WINDOW_MS = 30 * 60 * 1000;
let posReviewRecheckQueue = [];

async function processPosReviewRecheckQueue() {
  if (!posReviewRecheckQueue.length) return;
  const now = Date.now();
  const stillQueued = [];
  for (const q of posReviewRecheckQueue) {
    const seenAt = Number.isFinite(q._seenAt) ? q._seenAt : Date.parse(q.pubDate);
    const ageMs = now - seenAt;
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

// Entry point dipanggil per item news_history TIAP KATEGORI (lihat pollNews —
// dipanggil sebelum filter isHighImpactCategory). Deteksi currency -> guard
// market/degraded -> korroborasi -> trigger langsung (market-moving/corroborated)
// atau antre recheck (kategori lain yang belum terkonfirmasi, langkah 4).
async function handlePosReviewCandidate(newsItem) {
  const now = Date.now();
  // `_seenAt` = kapan daemon PERTAMA KALI melihat item ini (bukan pubDate asli) —
  // dasar retensi buffer/recheck-queue sekarang, lihat catatan panjang di
  // filterFreshBufferItems (audit S277, 2026-08-04). Set sekali, tidak pernah
  // ditimpa ulang (item yang sama tidak lewat sini dua kali — guid dedup ada di
  // level lain, pollNews).
  if (!Number.isFinite(newsItem._seenAt)) newsItem._seenAt = now;
  posReviewNewsBuffer.push(newsItem);
  prunePosReviewNewsBuffer(now);
  persistNewsBufferItem(newsItem);

  const legs = detectCurrencyLegs(newsItem.title);
  if (!legs.length) return; // fail-closed, tidak match currency apa pun

  if (redisGuard.isDegraded()) return;
  if (!isFxMarketOpen()) return;

  const corroborated = isCorroborated(newsItem, posReviewNewsBuffer);
  // Audit S218 (2026-07-23): 'energy' ditambah ke syarat korroborasi, konsisten
  // dengan 'geopolitical'. Audit S274 (2026-08-03) — BUG DITEMUKAN: gate ini masih
  // hardcode 2 kategori, jadi 'macro' (pidato bank sentral, Powell/Lagarde/dst) DAN
  // kategori lain mana pun (forex/equities/econ-data dst — kalau kebetulan cocok
  // currency leg) tetap lolos TANPA korroborasi sama sekali, persis pola bug yang
  // sama yang audit S218 klaim sudah diperbaiki. Diganti jadi deny-by-default:
  // HANYA 'market-moving' yang lolos otomatis (isCorroborated sudah return true
  // untuknya) — SEMUA kategori lain wajib >=2 sumber dulu, bukan daftar allowlist
  // yang harus diingat ditambah manual tiap ada kategori baru.
  if (newsItem.cat !== 'market-moving' && !corroborated) {
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
// Q-7 (2026-07-28, diskusi user — setup_log_auto:v1 telat diketahui kena TP/SL:
// sebelum ini SATU-SATUNYA trigger re-evaluasi _evaluateSetups di api/admin.js
// adalah buka dev-auto-entry.html manual atau slot auto-entry 2x/hari — kalau
// tidak ada yang buka, status bisa basi berjam-jam walau harga riil sudah
// tembus TP/SL). Watcher ini event-driven mirip pola Q-5 di atas, TAPI daemon
// SENGAJA TIDAK menduplikasi logika _evaluateSetups (loss_label
// fundamental_shock/fakeout_sl butuh candle penuh + kalender) — daemon cuma
// jadi TRIGGER cepat ke endpoint yang sudah benar & teruji
// (`setup_stats&scope=auto`), bukan penulis Redis langsung. Notifikasi push
// (_notifySetupOutcome, subscriber push_subs_dev) dikirim dari SISI admin.js
// begitu transisi status terdeteksi, bukan dari sini.
//
// MULTI-PROVIDER EMAS — DIBUANG (2026-07-29, diskusi user, insiden GC=F:
// 1785244513683, lihat daun_merah.md Session 262): sempat ada tick polos
// frxXAUUSD (Deriv spot) TERPISAH dari candle Yahoo, dipakai SEMATA untuk
// deteksi dini TP/SL supaya lebih cepat dari baseline re-evaluasi 5 menit di
// bawah. Dibuang setelah audit: manfaatnya cuma memangkas jeda deteksi dari
// maks ~5 menit (baseline Q-7 di bawah, tetap jalan) jadi nyaris instan — tapi
// efek sampingnya variabel `lastLivePrice['GC=F']` (juga dipakai teks alert
// zona harga) jadi bersumber Deriv spot, BUKAN Yahoo futures yang jadi acuan
// dashboard utama & evaluasi TP/SL — inkonsistensi sumber harga yang sama
// persis dengan insiden basis-blowout kemarin. User pilih konsistensi Yahoo
// penuh untuk XAU di atas kecepatan beberapa menit. `lastLivePrice['GC=F']`
// sekarang tidak pernah terisi (fail-open, consumer-nya sudah cek `== null`).
// ══════════════════════════════════════════════════════════════════════════
const SETUP_WATCH_CACHE_TTL_MS = 2 * 60 * 1000; // sama semangat ZONE_DATA_CACHE_TTL_MS — GET setup_log_auto:v1 murah, tak perlu tiap tick
const SETUP_TRIGGER_DEBOUNCE_MS = 20 * 1000; // sanity debounce trigger HTTP per symbol, BUKAN pembatas budget (endpoint tujuan murni baca/tulis Redis, tanpa call AI)
let openSetupsCache = { data: [], fetchedAt: 0 };
let openSetupsFetchInFlight = null;
const lastSetupTriggerAt = {}; // yahooSymbol -> epoch ms trigger terakhir

async function getOpenSetupsWatchlist() {
  const now = Date.now();
  if (now - openSetupsCache.fetchedAt < SETUP_WATCH_CACHE_TTL_MS) return openSetupsCache.data;
  if (redisGuard.isDegraded()) return openSetupsCache.data; // pakai basi/kosong, jangan tambah beban Redis saat degraded
  if (openSetupsFetchInFlight) return openSetupsFetchInFlight;
  const p = (async () => {
    let data = [];
    try {
      const raw = await redisCmd('GET', 'setup_log_auto:v1');
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        data = arr.filter(s => s && s.status === 'open').map(s => ({
          symbol: s.symbol, bias: s.bias, sl: parseFloat(s.sl), tp: parseFloat(s.tp),
        })).filter(s => Number.isFinite(s.sl) && Number.isFinite(s.tp));
      }
    } catch (e) { /* watchlist tetap basi, dicoba lagi setelah TTL cache lewat */ }
    openSetupsCache = { data, fetchedAt: Date.now() };
    openSetupsFetchInFlight = null;
    return data;
  })();
  openSetupsFetchInFlight = p;
  return p;
}

// Pure/testable — bandingkan 1 harga live terhadap sl/tp 1 setup (arah sesuai bias).
function priceCrossesLevel(bias, price, sl, tp) {
  if (!Number.isFinite(price) || !Number.isFinite(sl) || !Number.isFinite(tp)) return false;
  return bias === 'bearish' ? (price >= sl || price <= tp) : (price <= sl || price >= tp);
}

async function maybeTriggerSetupWatch(yahooSymbol, price) {
  if (price == null) return;
  const watchlist = await getOpenSetupsWatchlist();
  const relevant = watchlist.filter(s => s.symbol === yahooSymbol);
  if (!relevant.length) return; // tidak ada posisi open pair ini — skip, tidak perlu trigger apa pun
  if (!relevant.some(s => priceCrossesLevel(s.bias, price, s.sl, s.tp))) return;
  const now = Date.now();
  if (now - (lastSetupTriggerAt[yahooSymbol] || 0) < SETUP_TRIGGER_DEBOUNCE_MS) return;
  lastSetupTriggerAt[yahooSymbol] = now;
  triggerEndpoint('/api/admin?action=setup_stats&scope=auto').catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════
// Q-6: scheduler node-cron — memicu endpoint yang sama lewat HTTP.
// - market-digest: jadwal `schedule:` di GitHub Actions DIMATIKAN (Session 323,
//   2026-08-20) — GH Actions free tier terpantau telat sampai 93 menit,
//   generate ULANG + buang AI call tiap kali telat lewat window dedup. VPS
//   sekarang SATU-SATUNYA sumber terjadwal; workflow GH Actions masih ada
//   untuk workflow_dispatch manual saja (failsafe kalau VPS/Railway down).
// - ohlcv_sync: TETAP jalan PARALEL dengan ohlcv-sync.yml (GH Actions belum
//   dimatikan di sini — beda karakteristik risiko, gap antar run cuma 1 jam).
//   ohlcv_sync sudah men-warm cache TA sendiri di akhir handler-nya
//   (admin.js ohlcvSyncHandler) — TIDAK perlu trigger ta-warm terpisah dari sini.
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
}

function startScheduler() {
  if (!cron) { console.warn('daemon: paket node-cron tidak terpasang, Q-6 scheduler di-skip'); return; }
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, Q-6 scheduler di-skip'); return; }
  // 3 jadwal identik .github/workflows/market-digest.yml (UTC). Digeser +2
  // menit dari jam buka sesi persis (S305 lanjutan) — kasih buffer supaya
  // data kalender ekonomi yang rilis tepat di jam buka sesi (mis. NY 12:30
  // UTC = 08:30 ET jam rilis NFP/CPI/dll) sempat kepropagasi ke sumber
  // sebelum digest fetch.
  cron.schedule('2 0 * * *',   () => runDigestCycle().catch(() => {}));
  cron.schedule('2 7 * * *',   () => runDigestCycle().catch(() => {}));
  cron.schedule('32 12 * * *', () => runDigestCycle().catch(() => {}));
  // ohlcv_sync tiap jam, offset menit ke-5 supaya tidak tabrakan detik dengan
  // ohlcv-sync.yml (keduanya sengaja jalan paralel selama masa observasi Q-6).
  cron.schedule('5 * * * *', () => triggerWithRetry('/api/admin?action=ohlcv_sync').catch(() => {}));
  console.log('daemon: Q-6 scheduler aktif (digest 3x/hari + ohlcv_sync tiap jam, paralel GH Actions)');

  // Q-7: baseline re-evaluasi setup_log_auto:v1 tiap 5 menit — jaring pengaman
  // watcher event-driven di atas (mis. AUDNZD=X/EURGBP=X yang tak selalu punya
  // live tick Deriv di jam tertentu) + memastikan notifikasi push dev tetap
  // terkirim walau tidak ada yang buka dev-auto-entry.html manual. Murni baca/
  // tulis Redis (tanpa call AI), jadi aman dipanggil sesering ini.
  // `source=cron5` (S315 lanjutan-6, efisiensi command Redis): jadwal ini
  // identik dengan .github/workflows/setup-tp-sl-watch.yml (sama-sama
  // `*/5 * * * *`, tidak saling tahu) — tag ini dipakai admin.js untuk
  // dedup KHUSUS antara dua sumber cron 5-menit ini. Trigger event-driven
  // di atas (maybeTriggerSetupWatch) SENGAJA TIDAK dikasih tag ini — itu
  // jalur cepat Q-7, tidak boleh ikut ke-skip oleh dedup.
  cron.schedule('*/5 * * * *', () => triggerEndpoint('/api/admin?action=setup_stats&scope=auto&source=cron5').catch(() => {}));
  console.log('daemon: Q-7 watcher TP/SL aktif (event-driven per tick + baseline tiap 5 menit)');

  // U-3 (2026-07-20, Plan U): auto-entry virtual — menit ke-15 supaya tidak
  // tabrakan waktu dengan slot digest (00:00/07:00/12:30) yang bisa menelan
  // slot auto-entry via dedup 30 menit ohlcv_analyze (api/admin.js).
  for (const hour of AUTO_ENTRY_HOURS_UTC) {
    cron.schedule(`15 ${hour} * * *`, () => runAutoEntryCycle().catch(e => console.warn('daemon: runAutoEntryCycle gagal:', e.message)));
  }
  if (AUTO_ENTRY_HOURS_UTC.length) {
    console.log(`daemon: U-3 auto-entry aktif — pair ${AUTO_ENTRY_PAIRS.join(',')} @ jam ${AUTO_ENTRY_HOURS_UTC.join(',')} UTC`);
  }
  // Track 1b lanjutan (2026-08-05, root cause audit field regime null): cache
  // 'risk_regime' (api/risk-regime.js, TTL 5 menit) HANYA terisi lewat kunjungan
  // browser (index.html fetchRegime/pollRegime) — tidak ada pemanasan server-side.
  // runAutoEntryCycle jam :15 membaca cache itu secara PASIF (redisCmd GET biasa,
  // api/admin.js:4537, bukan lewat handler risk-regime.js yang punya fallback
  // fetch-on-miss), jadi kalau tidak ada user browsing dalam 5 menit terakhir,
  // regime null diam-diam — persis kasus trade AUDNZD:1785849311337 (n=1 sampel
  // sejak Track 1b live). Panaskan cache menit :10 (5 menit sebelum slot :15) di
  // union jam AUTO_ENTRY_HOURS_UTC + AUTO_ENTRY_HOURS_UTC_AUDNZD.
  const regimeWarmHours = [...new Set([...AUTO_ENTRY_HOURS_UTC, ...AUTO_ENTRY_HOURS_UTC_AUDNZD])];
  for (const hour of regimeWarmHours) {
    cron.schedule(`10 ${hour} * * *`, () => triggerEndpoint('/api/risk-regime').catch(() => {}));
  }
  if (regimeWarmHours.length) {
    console.log(`daemon: pemanasan risk_regime aktif @ menit :10 jam ${regimeWarmHours.sort((a, b) => a - b).join(',')} UTC (5 menit sebelum slot auto-entry)`);
  }
  // Track 2a (2026-08-04, keputusan user): jam ke-3 KHUSUS AUD/NZD, sesi
  // Sydney-Tokyo — hanya dijadwalkan kalau AUD/NZD memang ada di AUTO_ENTRY_PAIRS
  // (tidak masuk akal menjadwalkan pair yang tidak aktif). Menit :15 sama seperti
  // slot utama (hindari tabrakan dedup 30 menit ohlcv_analyze dgn slot digest).
  if (AUTO_ENTRY_PAIRS.includes(AUTO_ENTRY_AUDNZD_PAIR)) {
    for (const hour of AUTO_ENTRY_HOURS_UTC_AUDNZD) {
      cron.schedule(`15 ${hour} * * *`, () => runAutoEntryCycle([AUTO_ENTRY_AUDNZD_PAIR]).catch(e => console.warn('daemon: runAutoEntryCycle (jam khusus AUD/NZD) gagal:', e.message)));
    }
    if (AUTO_ENTRY_HOURS_UTC_AUDNZD.length) {
      console.log(`daemon: jam khusus AUD/NZD aktif (sesi Sydney-Tokyo) @ jam ${AUTO_ENTRY_HOURS_UTC_AUDNZD.join(',')} UTC`);
    }
  }
  if (Number.isFinite(AUTO_CONSISTENCY_HOUR_UTC)) {
    cron.schedule(`45 ${AUTO_CONSISTENCY_HOUR_UTC} * * *`, () => runConsistencyCheck().catch(e => console.warn('daemon: runConsistencyCheck gagal:', e.message)));
    console.log(`daemon: U-3 uji konsistensi aktif — pair ${AUTO_ENTRY_PAIRS[0] || '(kosong)'} @ jam ${AUTO_CONSISTENCY_HOUR_UTC}:45 UTC`);
  }
  // U-3 lanjutan (2026-07-24): tighten preventif weekend gap — hari-of-week 5 = Jumat.
  if (Number.isFinite(FRIDAY_TIGHTEN_HOUR_UTC)) {
    cron.schedule(`0 ${FRIDAY_TIGHTEN_HOUR_UTC} * * 5`, () => runFridayTightenCycle().catch(e => console.warn('daemon: runFridayTightenCycle gagal:', e.message)));
    console.log(`daemon: tighten preventif Jumat aktif @ jam ${FRIDAY_TIGHTEN_HOUR_UTC}:00 UTC (4 jam sebelum tutup)`);
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
  // Redesain independensi Golden Trio (2026-07-26, lihat daun_merah_riset.md):
  // AUD/NZD & EUR/GBP diukur (korelasi + proxy peluang setup) sebagai pengganti
  // GBP/USD yang paling redundan (r=0.827 ke EUR/USD). frxAUDNZD bukan simbol
  // Deriv asli di YAHOO_TO_DERIV_SYMBOL (AUD/NZD Yahoo-only, sama pola GC=F) —
  // key ini murni penamaan konsisten dgn AUTO_ENTRY_PAIRS, bukan reuse map Q-3.
  frxAUDNZD: { symbol: 'AUDNZD=X', label: 'AUD/NZD' },
  frxEURGBP: { symbol: 'EURGBP=X', label: 'EUR/GBP' },
  // Pair ke-5 (2026-08-08, pair_workflow.md Tahap 1-2 lolos: korelasi rata-rata
  // r=0,18 ke 4 pair aktif, terkuat 0,373 ke EUR/USD — masih di bawah XAU/USD-
  // EUR/USD 0,585 yang sudah diterima; opportunity rate 66%, setara rata-rata set
  // aktif). CHF/JPY juga Yahoo-only sama pola AUD/NZD, bukan simbol Deriv asli.
  frxCHFJPY: { symbol: 'CHFJPY=X', label: 'CHF/JPY' },
};

// Mau menambah pair baru? Ikuti SOP di
// Dokumentasi/professional_llm_trader/pair_workflow.md (indikator kelayakan +
// checklist titik kode) — jangan tempel simbol baru di sini tanpa lewat itu dulu.
//
// Redesain independensi Golden Trio (2026-07-26, diskusi user — audit korelasi
// membuktikan XAU/EUR/GBP saling korelatif r=0.53-0.83 krn share kaki USD, n>=100
// gabungan BUKAN sampel independen; lihat daun_merah_riset.md untuk data lengkap):
// GBP/USD dibuang (paling redundan ke EUR/USD), AUD/NZD + EUR/GBP masuk (korelasi
// rata-rata r=0.10 & r=0.19 ke pair lain, PALING RENDAH dari semua kandidat dites).
// 4 pair @ 2 slot/hari = 8 call/hari (naik dari 6) — MASIH jauh di bawah pagar
// deepseek_experimental 15/hari. PENTING: kriteria "cukup data" Plan U harus baca
// n>=30 di STIAP pair (bukan cuma total gabungan >=100) — dengan 4 pair butuh
// 4x30=120 total (~15 hari di 8 call/hari), hampir sama dgn skema 3-pair lama
// (~16-17 hari) kalau kriteria per-pair ini diikutkan, TIDAK lebih lambat.
//
// Pair ke-5, CHF/JPY (2026-08-08, pair_workflow.md folder professional_llm_trader
// Tahap 1-2 lolos — detail pengukuran di riset.md folder yang sama): ikut jadwal
// utama (bukan jam khusus, tidak ada bukti kuat sesi likuiditasnya di luar London/
// NY) — 5 pair @ 2 slot/hari = 10 call/hari (+1 jam khusus AUD/NZD di bawah = 11
// call/hari), MASIH jauh di bawah pagar deepseek_experimental 15/hari. Gate n>=30
// per pair sekarang butuh 5x30=150 total (~15 hari di 10 call/hari utama).
const AUTO_ENTRY_PAIRS = (process.env.AUTO_ENTRY_PAIRS || 'frxXAUUSD,frxEURUSD,frxAUDNZD,frxEURGBP,frxCHFJPY')
  .split(',').map(s => s.trim()).filter(Boolean);
const AUTO_ENTRY_HOURS_UTC = (process.env.AUTO_ENTRY_HOURS_UTC || '8,13')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
// Track 2a (Road to Professional LLM Trader, 2026-08-04, keputusan user): jam
// TAMBAHAN khusus AUD/NZD — AUTO_ENTRY_HOURS_UTC (8,13 UTC = 15:00/20:00 WIB) pas
// untuk sesi London/NY (XAU/EUR/GBP), tapi AUD/NZD justru paling likuid di sesi
// Sydney-Tokyo (~22:00-08:00 UTC / 05:00-15:00 WIB). Default 1 slot 00:00 UTC
// (07:00 WIB). Loop TERPISAH di startScheduler (di bawah) memanggil
// runAutoEntryCycle dengan SATU pair saja — pair lain TIDAK bertambah call/hari.
const AUTO_ENTRY_HOURS_UTC_AUDNZD = (process.env.AUTO_ENTRY_HOURS_UTC_AUDNZD || '0')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
const AUTO_ENTRY_AUDNZD_PAIR = 'frxAUDNZD';
const AUTO_CONSISTENCY_HOUR_UTC = parseInt(process.env.AUTO_CONSISTENCY_HOUR_UTC || '10', 10);
// Tighten preventif weekend gap (diskusi user 2026-07-24) — default 17:00 UTC, 4 jam
// sebelum tutup Jumat 21:00 UTC (isFxMarketOpen). SENGAJA tidak lebih mepet: 1 jam
// terakhir sebelum close cenderung choppy/likuiditas tipis (desk mulai square posisi
// weekend) — tighten pas di jam itu justru rawan kena whipsaw, bukan lebih aman dari
// noise. 4 jam sebelum (masih sesi NY normal) supaya SL sudah "settle" duluan.
const FRIDAY_TIGHTEN_HOUR_UTC = parseInt(process.env.FRIDAY_TIGHTEN_HOUR_UTC || '17', 10);
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

// Companion ke findHardNewsEvent — cek ke BELAKANG, bukan ke depan: event
// High-impact yang BARU SAJA rilis dalam windowMs terakhir. Audit S277
// (2026-08-04, kasus AUD/NZD kena SL): rilis besar yang baru terjadi masih
// menyisakan volatilitas settling, risikonya sama seperti menjelang rilis —
// sebelum ini checkHardNewsSkip cuma waspada ke DEPAN, buta terhadap "baru saja
// terjadi". `calendar_v1`/`calendar_next_v1` (api/calendar.js) menyimpan event
// per HARI (bukan cuma jam ke depan), jadi event beberapa jam lalu di hari yang
// sama tetap ada di cache — window ini valid dicek. Default window SAMA dengan
// BREAKING_NEWS_SKIP_WINDOW_MS (1 jam, keputusan user) — satu makna konsisten
// "seberapa lama pasca-shock masih dianggap berisiko" di kalender & breaking news.
function findRecentHardNewsEvent(events, legs, nowMs, windowMs = BREAKING_NEWS_SKIP_WINDOW_MS) {
  if (!Array.isArray(events) || !Array.isArray(legs) || legs.length === 0) return null;
  for (const e of events) {
    if (!e || e.impact !== 'High' || !legs.includes(e.currency)) continue;
    const ms = calEventMsWib(e.date, e.time_wib);
    if (ms == null) continue;
    if (ms <= nowMs && ms >= nowMs - windowMs) return e;
  }
  return null;
}

// Plan X (2026-08-04) — 5 currency dari union AUTO_ENTRY_PAIRS AKTIF (bukan
// SELURUH AUTO_ENTRY_SYMBOL_MAP — map itu juga berisi entri lama tak terpakai
// spt GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD dari sebelum redesain
// Golden Trio, lihat komentar AUTO_ENTRY_PAIRS di atas). DITURUNKAN otomatis
// (bukan hardcode) supaya kalau AUTO_ENTRY_PAIRS berubah di masa depan, currency
// set ikut menyesuaikan tanpa perlu ubah 2 tempat. XAU dibuang (bukan currency
// kalender, legsFromLabel('XAU/USD') -> ['XAU','USD']).
const SURPRISE_CURRENCIES = new Set(
  AUTO_ENTRY_PAIRS
    .map(p => AUTO_ENTRY_SYMBOL_MAP[p])
    .filter(Boolean)
    .flatMap(m => legsFromLabel(m.label))
    .filter(c => c !== 'XAU')
);

// Rasio sederhana |actual-forecast| / |basis| (Opsi A, keputusan user 2026-08-04) —
// basis forecast_raw, fallback ke previous_raw kalau forecast 0/tidak ada. null =
// tidak bisa dihitung (actual belum terisi, ATAU forecast+previous sama-sama
// 0/tidak ada) — BUKAN "surprise=0", findSurpriseEvent harus skip null, bukan
// meloloskannya sebagai "tidak surprise".
const SURPRISE_RATIO_THRESHOLD = 1.0; // HEURISTIK AWAL, belum dikalibrasi dari data
// live — direvisi setelah cukup sampel real (lihat surprise_log:v1, fondasi Opsi B
// z-score per jenis event begitu sampel >=8-10/event terkumpul, pola sama
// DRAWDOWN_HALT_THRESHOLD_R di api/_auto_entry_guard.js).
function computeSurpriseRatio({ actualRaw, forecastRaw, previousRaw }) {
  if (!Number.isFinite(actualRaw) || !Number.isFinite(forecastRaw)) return null;
  const baseline = forecastRaw !== 0 ? Math.abs(forecastRaw)
    : (Number.isFinite(previousRaw) && previousRaw !== 0 ? Math.abs(previousRaw) : null);
  if (baseline == null) return null;
  return Math.abs(actualRaw - forecastRaw) / baseline;
}

const SURPRISE_LOG_CAP = 300;

async function fetchMergedSurpriseEvents() {
  const [rawThis, rawNext] = await Promise.all([
    redisCmd('GET', 'calendar_surprise_v1'),
    redisCmd('GET', 'calendar_surprise_next_v1'),
  ]);
  let surThis = null, surNext = null;
  try { surThis = rawThis ? JSON.parse(rawThis) : null; } catch (e) { /* biarkan null, jangan gagalkan pemanggil */ }
  try { surNext = rawNext ? JSON.parse(rawNext) : null; } catch (e) { /* sama */ }
  return [...((surThis && surThis.events) || []), ...((surNext && surNext.events) || [])];
}

// Companion findRecentHardNewsEvent, tapi surprise HANYA bisa dihitung SETELAH
// actual terisi — tidak ada versi forward-looking (beda dari findHardNewsEvent).
// Return event (+ ratio) pertama dalam window [nowMs-windowMs, nowMs] yang
// currency-nya cocok legs DAN ratio-nya >= SURPRISE_RATIO_THRESHOLD.
function findSurpriseEvent(events, legs, nowMs, windowMs = BREAKING_NEWS_SKIP_WINDOW_MS) {
  if (!Array.isArray(events) || !Array.isArray(legs) || legs.length === 0) return null;
  for (const e of events) {
    if (!e || !legs.includes(e.currency)) continue;
    const ms = calEventMsWib(e.date, e.time_wib);
    if (ms == null) continue;
    if (ms > nowMs || ms < nowMs - windowMs) continue;
    const ratio = computeSurpriseRatio({ actualRaw: e.actual_raw, forecastRaw: e.forecast_raw, previousRaw: e.previous_raw });
    if (ratio == null || ratio < SURPRISE_RATIO_THRESHOLD) continue;
    return { ...e, ratio };
  }
  return null;
}

// Lapis 1c — kejutan ekonomi (actual vs forecast) yang divonis Low/Medium impact
// oleh vendor TradingView tapi jauh meleset dari forecast (audit S277, kasus
// AUD/NZD "Household Spending" beat 4x, importance:-1, tidak pernah masuk gate
// manapun). Independen dari label impact vendor — findSurpriseEvent tidak
// memfilter e.impact sama sekali, murni rasio numerik. Selain keputusan skip,
// SETIAP event yang actual-nya sudah terisi dalam window dicatat ke
// surprise_log:v1 (bukan cuma yang lolos ambang) — fondasi Opsi B (z-score per
// jenis event) begitu sampel cukup, TIDAK diaktifkan sebagai gate di sini.
async function checkSurpriseSkip(pair, label) {
  try {
    const events = await fetchMergedSurpriseEvents();
    const legs = legsFromLabel(label);
    const nowMs = Date.now();
    for (const e of events) {
      if (!e || !legs.includes(e.currency)) continue;
      const ms = calEventMsWib(e.date, e.time_wib);
      if (ms == null || ms > nowMs || ms < nowMs - BREAKING_NEWS_SKIP_WINDOW_MS) continue;
      const ratio = computeSurpriseRatio({ actualRaw: e.actual_raw, forecastRaw: e.forecast_raw, previousRaw: e.previous_raw });
      if (ratio == null) continue; // actual belum terisi — tidak ada yang bisa dicatat
      const logEntry = {
        ts: nowMs, event: String(e.event || '').toLowerCase().trim(), currency: e.currency,
        date: e.date, ratio, actual_raw: e.actual_raw, forecast_raw: e.forecast_raw,
      };
      await redisCmd('LPUSH', 'surprise_log:v1', JSON.stringify(logEntry));
      await redisCmd('LTRIM', 'surprise_log:v1', '0', String(SURPRISE_LOG_CAP - 1));
    }
    const hit = findSurpriseEvent(events, legs, nowMs);
    if (!hit) return null;
    const entry = {
      ts: nowMs, pair, label, reason: 'surprise',
      event: hit.event, currency: hit.currency, event_time_wib: `${hit.date} ${hit.time_wib}`,
      ratio: hit.ratio, actual_raw: hit.actual_raw, forecast_raw: hit.forecast_raw,
    };
    await redisCmd('LPUSH', 'auto_skip_log', JSON.stringify(entry));
    await redisCmd('LTRIM', 'auto_skip_log', '0', String(AUTO_SKIP_LOG_CAP - 1));
    return entry;
  } catch (e) {
    console.warn(`daemon: checkSurpriseSkip ${pair} gagal (fail-open, tetap generate):`, e.message);
    return null;
  }
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
//
// Audit S277 (2026-08-04) sempat menambah cek MAJU (findHardNewsEvent, event
// akan rilis dalam beberapa jam) di sini, DILONGGARKAN sesi yang sama (diskusi
// user): cek maju ini REDUNDAN dengan Gate E — AI yang bikin analisa toh sudah
// dikasih daftar event high-impact 7 hari ke depan yang SAMA persis di dalam
// prompt (lihat `[EVENT HIGH-IMPACT 7 HARI KE DEPAN]`, api/admin.js), dan kalau
// dia menilai konflik waktu, itu sudah diteruskan ke Gate A (AI Kritikus) yang
// juga independen menilai kalender yang sama (calAnalyzeBlock) — bukan lagi
// auto-reject buta. Skip di SINI (sebelum AI bahkan dipanggil) cuma dobel-jaga
// tanpa nambah kualitas keputusan, malah menghilangkan kesempatan AI menimbang
// per-setup (mis. RR sangat besar bisa tetap layak walau ada event mendatang).
// Cek MUNDUR (findRecentHardNewsEvent, event yang BARU SAJA rilis) TETAP
// dipertahankan sebagai hard skip — beda karakter: itu soal data pasar yang
// mungkin belum settle/tercermin penuh di candle yang dianalisa AI, berbasis
// kasus SL nyata (AUD/NZD), bukan tebakan/self-report yang bisa diserahkan ke
// judgment AI seperti conflict:'waktu'.
async function checkHardNewsSkip(pair, label) {
  try {
    const events = await fetchMergedCalendarEvents();
    const legs = legsFromLabel(label);
    const nowMs = Date.now();
    const hit = findRecentHardNewsEvent(events, legs, nowMs);
    if (!hit) return null;
    const eventMs = calEventMsWib(hit.date, hit.time_wib);
    const entry = {
      ts: nowMs, pair, label, reason: 'hard_news',
      event: hit.event, currency: hit.currency, event_time_wib: `${hit.date} ${hit.time_wib}`, event_ms: eventMs,
    };
    await redisCmd('LPUSH', 'auto_skip_log', JSON.stringify(entry));
    await redisCmd('LTRIM', 'auto_skip_log', '0', String(AUTO_SKIP_LOG_CAP - 1));
    return entry;
  } catch (e) {
    console.warn(`daemon: checkHardNewsSkip ${pair} gagal (fail-open, tetap generate):`, e.message);
    return null;
  }
}

// Lapis 1b — filter berita keras dari BERITA REAL-TIME (bukan kalender terjadwal),
// pelengkap checkHardNewsSkip di atas. Audit S218 (2026-07-23): checkHardNewsSkip
// cuma baca calendar_v1 (rilis ekonomi terjadwal) — buta terhadap breaking news
// geopolitik/guncangan energi mendadak (mis. eskalasi Iran-AS di Selat Hormuz,
// bukan event kalender). Reuse infra U-5b (posReviewNewsBuffer, detectCurrencyLegs,
// isCorroborated) — SENGAJA tetap mensyaratkan korroborasi (>=2 sumber, pola sama
// U-5b) supaya tidak terlalu waspada ke rumor tunggal/berita tidak relevan (lihat
// diskusi user soal false-positive) — sudah 3 lapis saring: relevansi mata uang
// (detectCurrencyLegs) -> kategori (geopolitical/energy/macro/market-moving) ->
// korroborasi. 'macro' ditambah audit S274 (2026-08-03) — celah yang sama persis
// dengan bug tryTriggerPosReview (lihat catatan isCorroborated/
// handlePosReviewCandidate): pidato bank sentral mendadak sebelumnya tidak pernah
// bikin skip entry baru sama sekali, walau sudah ada infra korroborasi yang matang.
//
// Pure inti (testable) dipisah dari I/O logging, pola sama findHardNewsEvent/
// checkHardNewsSkip di atas.
// Audit S277 (2026-08-04): window recency eksplisit ditambahkan (`nowMs`/`windowMs`,
// default BREAKING_NEWS_SKIP_WINDOW_MS = 1 jam) — sebelum ini fungsi cuma menyisir
// SELURUH buffer tanpa batas umur eksplisit, jadi jendela efektifnya diam-diam
// terikat ke retensi buffer (dulu 35 menit, kebetulan/tidak jelas maknanya). Sekarang
// eksplisit & independen dari retensi buffer (yang sekarang lebih lebar demi alasan
// LAIN — toleransi backlog korroborasi, lihat POSREVIEW_NEWS_BUFFER_MS) — item yang
// masih ada di buffer tapi sudah lebih tua dari windowMs TIDAK dianggap "baru saja
// terjadi" lagi, walau masih tersimpan untuk keperluan korroborasi item lain.
function findBreakingNewsMatch(pairLegs, buffer, nowMs = Date.now(), windowMs = BREAKING_NEWS_SKIP_WINDOW_MS) {
  if (!Array.isArray(pairLegs) || !pairLegs.length || !Array.isArray(buffer)) return null;
  for (const item of buffer) {
    if (!item) continue;
    if (item.cat !== 'geopolitical' && item.cat !== 'energy' && item.cat !== 'macro' && item.cat !== 'market-moving') continue;
    const pubMs = Date.parse(item.pubDate);
    if (!Number.isFinite(pubMs) || nowMs - pubMs > windowMs) continue;
    const newsLegs = detectCurrencyLegs(item.title);
    if (!newsLegs.some(l => pairLegs.includes(l))) continue;
    if (!isCorroborated(item, buffer)) continue;
    return item;
  }
  return null;
}

async function checkBreakingNewsSkip(pair, label) {
  try {
    const pairLegs = legsFromLabel(label);
    const now = Date.now();
    prunePosReviewNewsBuffer(now);
    const match = findBreakingNewsMatch(pairLegs, posReviewNewsBuffer, now);
    if (!match) return null;
    const entry = {
      ts: now, pair, label, reason: 'breaking_news',
      event: match.title, cat: match.cat, pubDate: match.pubDate,
    };
    await redisCmd('LPUSH', 'auto_skip_log', JSON.stringify(entry));
    await redisCmd('LTRIM', 'auto_skip_log', '0', String(AUTO_SKIP_LOG_CAP - 1));
    return entry;
  } catch (e) {
    console.warn(`daemon: checkBreakingNewsSkip ${pair} gagal (fail-open, tetap generate):`, e.message);
    return null;
  }
}

// `pairs` opsional (default AUTO_ENTRY_PAIRS, semua pair jadwal utama) — Track 2a
// (2026-08-04) memanggil ini dengan array 1 pair ([AUTO_ENTRY_AUDNZD_PAIR]) di jam
// tambahan khusus AUD/NZD, supaya pair lain TIDAK ikut bertambah call di jam itu.
async function runAutoEntryCycle(pairs = AUTO_ENTRY_PAIRS) {
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, U-3 auto-entry di-skip'); return; }
  if (!isFxMarketOpen()) return;
  for (const pair of pairs) {
    const map = AUTO_ENTRY_SYMBOL_MAP[pair];
    if (!map) { console.warn(`daemon: AUTO_ENTRY_PAIRS berisi pair tak dikenal "${pair}", di-skip`); continue; }
    const skip = await checkHardNewsSkip(pair, map.label);
    if (skip) { console.log(`daemon: U-3 auto-entry ${pair} di-skip — hard news "${skip.event}" (${skip.event_time_wib})`); continue; }
    const breakingSkip = await checkBreakingNewsSkip(pair, map.label);
    if (breakingSkip) { console.log(`daemon: U-3 auto-entry ${pair} di-skip — breaking news "${breakingSkip.event}" (${breakingSkip.cat})`); continue; }
    const surpriseSkip = await checkSurpriseSkip(pair, map.label);
    if (surpriseSkip) { console.log(`daemon: U-3 auto-entry ${pair} di-skip — kejutan ekonomi "${surpriseSkip.event}" (rasio ${surpriseSkip.ratio.toFixed(2)})`); continue; }
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

// Tighten SL preventif sekali/minggu sebelum weekend close (diskusi user 2026-07-24) —
// GET sederhana (semua posisi eksperimen OPEN diproses server-side di
// api/admin.js?action=friday_tighten, tidak butuh body/trigger seperti position_review),
// pola sama runConsistencyCheck (fetchJsonWithTimeout, 1x percobaan, warn-only kalau
// gagal — kegagalan minggu ini bukan hal darurat, dicoba lagi Jumat berikutnya).
// Dijadwalkan jam FRIDAY_TIGHTEN_HOUR_UTC hari Jumat di startScheduler — TIDAK perlu
// isFxMarketOpen guard eksplisit di sini (jam defaultnya 17:00 UTC, jauh sebelum tutup
// 21:00 UTC, market pasti masih buka; guard tetap ada di server-side friday_tighten
// kalau suatu saat jamnya digeser mepet).
async function runFridayTightenCycle() {
  if (!CRON_SECRET) { console.warn('daemon: CRON_SECRET kosong, tighten preventif Jumat di-skip'); return; }
  const json = await fetchJsonWithTimeout('/api/admin?action=friday_tighten');
  if (json) console.log(`daemon: tighten preventif Jumat — checked=${json.checked} tightened=${json.tightened}`);
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
      auto_entry: { pairs: AUTO_ENTRY_PAIRS, hours_utc: AUTO_ENTRY_HOURS_UTC, hours_utc_audnzd: AUTO_ENTRY_HOURS_UTC_AUDNZD, consistency_hour_utc: AUTO_CONSISTENCY_HOUR_UTC, friday_tighten_hour_utc: FRIDAY_TIGHTEN_HOUR_UTC },
    }));
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`daemon: HTTP server listening on 0.0.0.0:${PORT}`);
  });
}

async function main() {
  registerProcessSafetyNet();
  beat();
  setInterval(beat, BEAT_INTERVAL_MS);
  startHttpServer();
  startDerivStream();
  setInterval(wsWatchdogTick, WS_PING_INTERVAL_MS);
  // Pulihkan buffer korroborasi SEBELUM pollNews mulai jalan (S218/S219 lanjutan)
  // — supaya krisis yang sedang berlangsung saat restart tidak "amnesia".
  await loadNewsBufferFromRedis();
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
  // Q-7 (pure/testable):
  priceCrossesLevel,
  // Self-healing (pure/testable):
  createRedisGuard, shouldForceReconnect, isFxMarketOpen, newestCandleEpoch, isCandleStale,
  // U-3 (pure/testable):
  legsFromLabel, calEventMsWib, findHardNewsEvent, findRecentHardNewsEvent, firstNumber, levelsWithinTolerance,
  computeConsistency, AUTO_ENTRY_SYMBOL_MAP, AUTO_ENTRY_PAIRS, AUTO_ENTRY_HOURS_UTC,
  AUTO_ENTRY_HOURS_UTC_AUDNZD, AUTO_ENTRY_AUDNZD_PAIR,
  findBreakingNewsMatch, BREAKING_NEWS_SKIP_WINDOW_MS,
  // Plan X (pure/testable):
  computeSurpriseRatio, findSurpriseEvent, SURPRISE_RATIO_THRESHOLD, SURPRISE_CURRENCIES,
  // U-3 (async, di-export untuk simulasi lokal manual — bukan dipakai node:test):
  checkHardNewsSkip, runAutoEntryCycle, runConsistencyCheck, runFridayTightenCycle, pollCalendarLatency, checkBreakingNewsSkip,
  // Plan X (async, di-export untuk simulasi lokal manual — bukan dipakai node:test):
  checkSurpriseSkip, fetchMergedSurpriseEvents,
  // U-5b (pure/testable):
  detectCurrencyLegs, isCorroborated, posReviewSignificantTokens, POSREVIEW_CURRENCY_KEYWORDS,
  shouldPersistNewsBufferItem, filterFreshBufferItems, POSREVIEW_NEWS_BUFFER_MS,
  // U-5b (async, di-export untuk simulasi lokal manual — bukan dipakai node:test):
  handlePosReviewCandidate, tryTriggerPosReview, triggerPositionReview, processPosReviewRecheckQueue,
  persistNewsBufferItem, loadNewsBufferFromRedis,
  // Notifikasi Telegram posisi manual open (rapat user 2026-08-11, pure/testable):
  pairToLegs, matchOpenPairsToHeadline, isDuplicateHeadline, detectEconCountryCurrency,
  POSNOTIFY_DEDUP_WINDOW_MS, POSNOTIFY_OVERLAP_THRESHOLD, ECON_RELEASE_WINDOW_MS,
  // Notifikasi Telegram posisi manual open (async, di-export untuk simulasi lokal manual):
  fetchOpenJournalPairs, checkOpenPositionNewsMatch, checkEconDataHighImpact,
};
