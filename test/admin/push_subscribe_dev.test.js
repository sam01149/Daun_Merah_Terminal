// test/admin/push_subscribe_dev.test.js
// Q-7 (2026-07-28, diskusi user — TP/SL setup_log_auto:v1 telat diketahui):
// (1) pushSubscribeDevHandler — subscription push KHUSUS alert TP/SL dev,
//     TERPISAH TOTAL dari push_subs publik (api/subscribe.js, dipakai berita).
// (2) _buildAutoScopeStats (via action=setup_stats&scope=auto) mengirim push
//     ke subscriber push_subs_dev SAAT setup transisi ke tp/sl/ambiguous —
//     TIDAK mengirim kalau tidak ada transisi (status sudah tp/sl sebelumnya).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function subKeyOf(endpoint) { return crypto.createHash('sha256').update(endpoint).digest('hex'); }

// web-push memvalidasi format kunci VAPID (base64url EC key) di setVapidDetails —
// string sembarang bikin configureVapid() throw diam-diam (ketangkap Promise.allSettled,
// jadi tidak crash, TAPI sendNotification tidak pernah terpanggil). Pakai kunci asli.
const FAKE_VAPID = require('web-push').generateVAPIDKeys();

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

function fakeReqRes({ action, method = 'POST', headers = {}, body = '', query = {} } = {}) {
  const req = {
    method,
    query: { action, ...query },
    headers,
    url: `/api/admin?action=${action}`,
    on(event, cb) {
      if (event === 'data' && body) cb(body);
      if (event === 'end') cb();
    },
  };
  return { req, res: fakeRes() };
}

async function withEnv(vars, fn) {
  const keys = ['CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DEEPSEEK_API_KEY'];
  const prev = {};
  for (const k of keys) { prev[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally {
    for (const k of keys) { delete process.env[k]; if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

// Redis stub dengan dukungan hash (HSET/HGETALL/HDEL) — isolation_auto.test.js punya
// stub serupa tapi tanpa command hash (tidak dibutuhkan test lain di sana).
function makeStore(seed = {}, hashSeed = {}) {
  return { strings: { ...seed }, hashes: JSON.parse(JSON.stringify(hashSeed)), lists: {} };
}
function redisFetchStub(store) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const [cmd, key, ...rest] = args;
    switch (cmd) {
      case 'GET':
        return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
      case 'SET': {
        const value = rest[0];
        const flags = rest.slice(1).map(v => String(v).toUpperCase());
        if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(store.strings, key)) {
          return { ok: true, json: async () => ({ result: null }) };
        }
        store.strings[key] = value;
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'DEL':
        delete store.strings[key];
        return { ok: true, json: async () => ({ result: 1 }) };
      case 'HSET': {
        store.hashes[key] = store.hashes[key] || {};
        store.hashes[key][rest[0]] = rest[1];
        return { ok: true, json: async () => ({ result: 1 }) };
      }
      case 'HGETALL': {
        const h = store.hashes[key] || {};
        const flat = [];
        for (const [f, v] of Object.entries(h)) { flat.push(f, v); }
        return { ok: true, json: async () => ({ result: flat }) };
      }
      case 'HDEL': {
        const h = store.hashes[key] || {};
        for (const f of rest) delete h[f];
        return { ok: true, json: async () => ({ result: 1 }) };
      }
      default:
        return { ok: true, json: async () => ({ result: 'OK' }) };
    }
  };
}

// ── pushSubscribeDevHandler ──────────────────────────────────────────────────

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
};

test('push_subscribe_dev: tanpa secret -> 401, tidak menulis apa pun', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const store = makeStore();
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(store);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({ action: 'push_subscribe_dev', headers: {}, body: JSON.stringify({ subscription: VALID_SUB }) });
      await handler(req, res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(store.hashes.push_subs_dev, undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('push_subscribe_dev: subscription valid + secret benar -> 201, tersimpan di push_subs_dev (BUKAN push_subs)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const store = makeStore();
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(store);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({
        action: 'push_subscribe_dev', headers: { 'x-admin-secret': 'topsecret' },
        body: JSON.stringify({ subscription: VALID_SUB }),
      });
      await handler(req, res);
      assert.equal(res.statusCode, 201);
      const key = subKeyOf(VALID_SUB.endpoint);
      assert.ok(store.hashes.push_subs_dev?.[key], 'harus tersimpan di push_subs_dev');
      const saved = JSON.parse(store.hashes.push_subs_dev[key]);
      assert.equal(saved.endpoint, VALID_SUB.endpoint);
      assert.equal(store.hashes.push_subs, undefined, 'TIDAK BOLEH numpang hash push_subs publik');
    } finally { global.fetch = origFetch; }
  });
});

test('push_subscribe_dev: subscription tidak valid (keys hilang) -> 400', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const store = makeStore();
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(store);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({
        action: 'push_subscribe_dev', headers: { 'x-cron-secret': 'topsecret' },
        body: JSON.stringify({ subscription: { endpoint: 'https://x.test/y' } }),
      });
      await handler(req, res);
      assert.equal(res.statusCode, 400);
    } finally { global.fetch = origFetch; }
  });
});

test('push_subscribe_dev: DELETE dengan secret benar -> hapus dari push_subs_dev', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const key = subKeyOf(VALID_SUB.endpoint);
    const store = makeStore({}, { push_subs_dev: { [key]: JSON.stringify(VALID_SUB) } });
    const origFetch = global.fetch;
    global.fetch = redisFetchStub(store);
    try {
      const handler = loadHandler();
      const { req, res } = fakeReqRes({
        action: 'push_subscribe_dev', method: 'DELETE', headers: { 'x-admin-secret': 'topsecret' },
        body: JSON.stringify({ endpoint: VALID_SUB.endpoint }),
      });
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(store.hashes.push_subs_dev[key], undefined);
    } finally { global.fetch = origFetch; }
  });
});

// ── Notifikasi push saat transisi status tp/sl/ambiguous (setup_stats&scope=auto) ──

function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

function openSetup(overrides) {
  return {
    id: 'EURUSD=X:1', symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish',
    entry_zone: '1.1400', sl: '1.1450', tp: '1.1300', rr: 2, horizon_days: 3,
    model: 'deepseek-v4-flash', ts: 1000, status: 'open', filled_t: 1000,
    source: 'auto', alignment: null, loss_label: null, label_reason: null, label_by: null,
    intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    ...overrides,
  };
}

async function callSetupStatsAuto(store) {
  const handler = loadHandler();
  const { req, res } = fakeReqRes({ action: 'setup_stats', method: 'GET', headers: { 'x-cron-secret': 'topsecret' }, query: { scope: 'auto' } });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try { await handler(req, res); return res; } finally { global.fetch = origFetch; }
}

test('Q-7: setup open -> tp (harga live tembus tp di candle) -> push dikirim ke subscriber push_subs_dev', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', VAPID_PUBLIC_KEY: FAKE_VAPID.publicKey, VAPID_PRIVATE_KEY: FAKE_VAPID.privateKey }, async () => {
    const webpush = require('web-push');
    const sent = [];
    const origSend = webpush.sendNotification;
    webpush.sendNotification = async (sub, body) => { sent.push({ sub, body }); return {}; };
    try {
      const subKey1 = subKeyOf(VALID_SUB.endpoint);
      // Candle H1 turun dari 1.1400 ke 1.1290 -> low pasti <= tp (1.1300, bearish).
      const store = makeStore(
        { 'setup_log_auto:v1': JSON.stringify([openSetup()]), 'ohlcv:EURUSD=X:1h': JSON.stringify(mkTrendCandles(1.1400, 1.1290)) },
        { push_subs_dev: { [subKey1]: JSON.stringify(VALID_SUB) } },
      );
      const res = await callSetupStatsAuto(store);
      assert.equal(res.statusCode, 200);

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].status, 'tp', 'status harus ter-update jadi tp');

      assert.equal(sent.length, 1, 'harus tepat 1 push terkirim untuk 1 subscriber dev');
      const payload = JSON.parse(sent[0].body);
      assert.match(payload.title, /EUR\/USD/);
      assert.match(payload.title, /TP/);
    } finally { webpush.sendNotification = origSend; }
  });
});

test('Q-7: setup SUDAH tp sebelumnya (tidak ada transisi baru) -> TIDAK ada push terkirim', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', VAPID_PUBLIC_KEY: FAKE_VAPID.publicKey, VAPID_PRIVATE_KEY: FAKE_VAPID.privateKey }, async () => {
    const webpush = require('web-push');
    const sent = [];
    const origSend = webpush.sendNotification;
    webpush.sendNotification = async (sub, body) => { sent.push({ sub, body }); return {}; };
    try {
      const subKey1 = subKeyOf(VALID_SUB.endpoint);
      const alreadyTp = openSetup({ status: 'tp', closed_t: 500 });
      const store = makeStore(
        { 'setup_log_auto:v1': JSON.stringify([alreadyTp]) },
        { push_subs_dev: { [subKey1]: JSON.stringify(VALID_SUB) } },
      );
      const res = await callSetupStatsAuto(store);
      assert.equal(res.statusCode, 200);
      assert.equal(sent.length, 0, 'setup yang statusnya SUDAH tp (bukan transisi baru) tidak boleh memicu push ulang');
    } finally { webpush.sendNotification = origSend; }
  });
});

test('Q-7: tidak ada subscriber push_subs_dev -> transisi tetap tersimpan, tidak crash walau tanpa subscriber', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', VAPID_PUBLIC_KEY: FAKE_VAPID.publicKey, VAPID_PRIVATE_KEY: FAKE_VAPID.privateKey }, async () => {
    const webpush = require('web-push');
    const sent = [];
    const origSend = webpush.sendNotification;
    webpush.sendNotification = async (sub, body) => { sent.push({ sub, body }); return {}; };
    try {
      const store = makeStore(
        { 'setup_log_auto:v1': JSON.stringify([openSetup()]), 'ohlcv:EURUSD=X:1h': JSON.stringify(mkTrendCandles(1.1400, 1.1290)) },
        {},
      );
      const res = await callSetupStatsAuto(store);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log[0].status, 'tp');
      assert.equal(sent.length, 0);
    } finally { webpush.sendNotification = origSend; }
  });
});
