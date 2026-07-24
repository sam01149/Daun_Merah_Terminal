// test/admin/isolation_auto.test.js — PLAN U-7 (2026-07-20, REVISI VISIBILITAS)
// Eksperimen auto-entry & manajemen posisi = developer-only. Publik TIDAK PERNAH
// boleh melihat jejaknya. Test ini memverifikasi 5 kriteria selesai U-7:
// (a) call auto=1 TIDAK menulis cache ohlcv_analysis:<symbol>, setup masuk
//     setup_log_auto:v1 BUKAN setup_log:v1.
// (b) payload setup_stats PUBLIK identik sebelum vs sesudah ada entri auto.
// (c) scope=auto tanpa secret = response publik; dengan secret = data eksperimen.
// (d) position_review menolak id setup manual TANPA call AI.
// (e) tidak ada string 'setup_log_auto' di index.html (grep test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const marketHours = require('../../api/_market_hours');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

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
  const prev = { CRON_SECRET: process.env.CRON_SECRET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY; delete process.env.SAMBANOVA_API_KEY; delete process.env.GROQ_API_KEY;
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY; delete process.env.SAMBANOVA_API_KEY; delete process.env.GROQ_API_KEY;
    for (const k of Object.keys(prev)) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

// Store Redis generik (string GET/SET + list LPUSH/LTRIM/LRANGE) dipakai semua test
// di file ini — cukup satu implementasi dipakai bolak-balik untuk setup_stats,
// ohlcv_analyze, dan position_review (semua lewat Upstash REST command pipeline yang
// sama: redisCmd(...args) POST array command ke satu endpoint).
function makeStore(seed = {}) {
  return { strings: { ...seed }, lists: {} };
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
          return { ok: true, json: async () => ({ result: null }) }; // NX gagal, key sudah ada
        }
        store.strings[key] = value;
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'DEL':
        delete store.strings[key];
        return { ok: true, json: async () => ({ result: 1 }) };
      case 'LPUSH':
        store.lists[key] = [rest[0], ...(store.lists[key] || [])];
        return { ok: true, json: async () => ({ result: store.lists[key].length }) };
      case 'LTRIM': {
        const stop = Number(rest[1]);
        store.lists[key] = (store.lists[key] || []).slice(Number(rest[0]), stop === -1 ? undefined : stop + 1);
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'LRANGE': {
        const stop = Number(rest[1]);
        const arr = store.lists[key] || [];
        return { ok: true, json: async () => ({ result: arr.slice(Number(rest[0]), stop === -1 ? undefined : stop + 1) }) };
      }
      case 'INCR': {
        const n = (parseInt(store.strings[key] || '0', 10)) + 1;
        store.strings[key] = String(n);
        return { ok: true, json: async () => ({ result: n }) };
      }
      default:
        return { ok: true, json: async () => ({ result: 'OK' }) }; // EXPIRE/SET NX EX dll
    }
  };
}

// ── (a) call auto=1 -> cache senyap + log terpisah ───────────────────────────

// candle H1 secukupnya (>=40 jam) supaya loadOhlcvData menandai h1/d1/d1_ext
// available (pola sama dengan test/admin/pair_context_prompt.test.js).
function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

// nowPrice mengikuti close terakhir mkTrendCandles(1.30, 1.28) = 1.28 — entry/sl/tp
// harus konsisten arah & RR>=1 terhadap harga itu, kalau tidak sanity-check kode
// (admin.js "entry/sl/tp inconsistent or RR<1") men-drop level jadi null.
const AI_JSON = {
  bias: 'bearish',
  entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
  sl: '1.2850', tp: '1.2700',
  trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
  time_horizon_days: 3, makro_alignment: null, makro_alignment_reason: null,
  conflict: 'none', conflict_note: null,
};
const AI_RAW_TEXT = `${JSON.stringify(AI_JSON)}\n===COMMENTARY===\nParagraf komentar singkat untuk kebutuhan test isolasi auto-entry.`;

function makeAnalyzeFetchStub(store) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

test('PLAN U-7(a): auto=1 + CRON_SECRET valid -> ohlcv_analysis:<symbol> TIDAK ditulis, setup masuk setup_log_auto:v1 bukan setup_log:v1', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1', // skip fetch Yahoo/Deriv nyata
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.structured, 'response ke daemon tetap payload penuh: ' + JSON.stringify(res.body));

      assert.equal(store.strings['ohlcv_analysis:GBPUSD=X'], undefined,
        'cache ohlcv_analysis TIDAK BOLEH tertulis untuk call auto — pengguna tidak boleh melihat "Analisa sudah jadi"');

      assert.equal(store.strings['setup_log:v1'], undefined, 'setup_log:v1 (manual) TIDAK BOLEH tersentuh oleh call auto');
      assert.ok(store.strings['setup_log_auto:v1'], 'setup_log_auto:v1 harus tertulis');
      const autoLog = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(autoLog.length, 1);
      assert.equal(autoLog[0].source, 'auto');
      assert.equal(autoLog[0].symbol, 'GBPUSD=X');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-7(a): call manual (bukan auto) tetap menulis cache & setup_log:v1 seperti biasa (kontrol negatif)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);

      assert.equal(res.statusCode, 200);
      assert.ok(store.strings['ohlcv_analysis:GBPUSD=X'], 'call manual harus tetap menulis cache seperti sebelum U-7');
      assert.ok(store.strings['setup_log:v1'], 'call manual harus masuk setup_log:v1');
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

// ── (f) auto-entry: ganti PENDING lama (bukan numpuk), skip kalau sudah OPEN ─
// (Plan U-3 lanjutan, 2026-07-20, diskusi user — lihat komentar di api/admin.js
// dekat `blockedByOpenPosition`/`stalePending`.)

test('PLAN U-3 lanjutan: auto=1 dengan PENDING lama bias SEARAH di symbol sama -> di-refine in-place (bukan canceled), level ter-update', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 111, status: 'pending',
      source: 'auto', alignment: null, loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1, 'refinement in-place tidak menambah entry baru');
      const item = log[0];
      assert.equal(item.status, 'pending', 'status tetap pending, tidak di-cancel');
      assert.equal(item.entry_zone, '1.2795-1.2805', 'entry_zone di-update ke level analisa terbaru');
      assert.equal(item.refined_count, 1, 'refined_count bertambah 1');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-3 lanjutan: auto=1 dengan PENDING lama bias BERLAWANAN (tanpa whipsaw) -> lama dibatalkan, baru dicatat', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bullish',
      entry_zone: '1.2700-1.2710', sl: '1.2650', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 111, status: 'pending',
      source: 'auto', alignment: null, loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 2, 'setup lama dibatalkan + setup baru ditambahkan');
      const old = log.find(x => x.id === 'GBPUSD=X:111');
      assert.equal(old.status, 'canceled', 'setup pending lama bias berlawanan di-cancel');
      assert.equal(old.label_by, 'auto');
      assert.ok(old.label_reason.includes('bearish'), 'alasan pembatalan mencantumkan bias baru');
      const fresh = log.find(x => x.id !== 'GBPUSD=X:111');
      assert.equal(fresh.status, 'pending');
      assert.equal(fresh.bias, 'bearish');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-3 lanjutan: auto=1 dengan posisi OPEN di symbol sama -> skip total, tidak numpuk risk', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const openSetup = {
      id: 'GBPUSD=X:222', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 222, status: 'open', filled_t: 300,
      source: 'auto', alignment: null, loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([openSetup]),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.structured, 'response ke daemon tetap payload penuh walau setup di-skip');
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1, 'tidak ada entri baru ditambahkan selagi posisi masih open');
      assert.equal(log[0].status, 'open', 'posisi open lama tidak disentuh sama sekali');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-3 lanjutan: call MANUAL dengan pending lama di symbol sama -> TIDAK dibatalkan (kebijakan hanya untuk auto)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:333', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 333, status: 'pending',
      source: 'manual', alignment: null, loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log:v1': JSON.stringify([oldPending]),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);

      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log:v1']);
      assert.equal(log.length, 2, 'manual: kedua entri pending hidup berdampingan (perilaku lama tidak berubah)');
      const old = log.find(x => x.id === 'GBPUSD=X:333');
      assert.equal(old.status, 'pending', 'manual tidak pernah auto-dibatalkan');
    } finally { global.fetch = origFetch; }
  });
});

// ── PLAN W (2026-07-24): field mentah conflict/makro_alignment tersimpan &
// diperbarui saat refine — sebelumnya cuma label gabungan `alignment` (lossy)
// yang disimpan, detail asli (termasuk alasan tertulis AI) dibuang permanen.

function mkAiRawText(overrides = {}) {
  const json = { ...AI_JSON, ...overrides };
  return `${JSON.stringify(json)}\n===COMMENTARY===\nParagraf komentar singkat untuk kebutuhan test PLAN W.`;
}

function makeCustomAnalyzeFetchStub(store, aiRawText) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: aiRawText } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

test('PLAN W: entri baru (auto) menyimpan conflict/conflict_note/makro_alignment/makro_alignment_reason mentah, alignment identik formula lama', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const rawText = mkAiRawText({ conflict: 'arah', conflict_note: 'catatan uji PLAN W' });
    const origFetch = global.fetch;
    global.fetch = makeCustomAnalyzeFetchStub(store, rawText);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const item = log[0];
      assert.equal(item.conflict, 'arah');
      assert.equal(item.conflict_note, 'catatan uji PLAN W');
      assert.equal(item.makro_alignment, null);
      assert.equal(item.makro_alignment_reason, null);
      assert.equal(item.alignment, 'konflik', 'alignment harus tetap dihitung sama seperti sebelum PLAN W (conflict!=none -> konflik)');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN W: entri baru (manual) juga menyimpan 4 field mentah yang sama (satu titik penulisan dipakai bersama)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const rawText = mkAiRawText({ conflict: 'waktu', conflict_note: 'catatan manual' });
    const origFetch = global.fetch;
    global.fetch = makeCustomAnalyzeFetchStub(store, rawText);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log:v1']);
      const item = log[0];
      assert.equal(item.conflict, 'waktu');
      assert.equal(item.conflict_note, 'catatan manual');
      assert.equal(item.alignment, 'konflik', 'conflict waktu != none -> tetap konflik, formula lama tidak berubah');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN W: refinement in-place (bias sama) memperbarui 4 field mentah ke generasi TERBARU, bukan snapshot generasi pertama', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 111, status: 'pending',
      source: 'auto', alignment: 'konflik',
      conflict: 'arah', conflict_note: 'catatan generasi pertama',
      makro_alignment: 'searah', makro_alignment_reason: 'alasan generasi pertama',
      loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
    const rawText = mkAiRawText({ conflict: 'waktu', conflict_note: 'catatan generasi kedua' });
    const origFetch = global.fetch;
    global.fetch = makeCustomAnalyzeFetchStub(store, rawText);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1, 'refinement in-place tidak menambah entry baru');
      const item = log[0];
      assert.equal(item.refined_count, 1);
      assert.equal(item.conflict, 'waktu', 'harus ter-update ke generasi terbaru, bukan tetap "arah" dari generasi pertama');
      assert.equal(item.conflict_note, 'catatan generasi kedua');
      assert.equal(item.makro_alignment, null, 'harus ter-update (tidak ada konteks makro di call ini), bukan tetap "searah" dari generasi pertama');
      assert.equal(item.makro_alignment_reason, null, 'harus ter-update, bukan tetap alasan generasi pertama');
    } finally { global.fetch = origFetch; }
  });
});

// ── (i) track record gabungan (manual+auto) HANYA untuk isAutoCall ──────────
// (Plan U-3 lanjutan, 2026-07-20, diskusi user.)

function makeCapturingFetchStub(store, capturedBodies) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      capturedBodies.push(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

function resolvedSetup(id, status) {
  return {
    id, symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
    entry_zone: '1.30', sl: '1.31', tp: '1.28', rr: 2, horizon_days: 3,
    model: 'deepseek-v4-flash', ts: 1, status,
    source: status ? 'manual' : 'manual', alignment: null, loss_label: null, label_reason: null, label_by: null,
    intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
  };
}

test('PLAN U-3 lanjutan: call auto -> track record GABUNGAN manual+auto disuap ke prompt', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // 3 manual (2 tp/1 sl) + 3 auto (1 tp/2 sl) = 6 selesai total, cukup lolos gate >=5.
    const manualLog = [resolvedSetup('m1', 'tp'), resolvedSetup('m2', 'tp'), resolvedSetup('m3', 'sl')];
    const autoLog = [
      { ...resolvedSetup('a1', 'tp'), source: 'auto' },
      { ...resolvedSetup('a2', 'sl'), source: 'auto' },
      { ...resolvedSetup('a3', 'sl'), source: 'auto' },
    ];
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log:v1': JSON.stringify(manualLog),
      'setup_log_auto:v1': JSON.stringify(autoLog),
    });
    const captured = [];
    const origFetch = global.fetch;
    global.fetch = makeCapturingFetchStub(store, captured);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(captured.length, 1, 'harus ada tepat 1 call ke AI provider');
      const promptBody = JSON.stringify(captured[0]);
      assert.ok(promptBody.includes('gabungan seluruh sumber'), 'label prompt harus menandai gabungan');
      assert.ok(promptBody.includes('6 setup selesai'), 'total harus 3 manual + 3 auto = 6, bukan cuma salah satu');
      assert.ok(promptBody.includes('3 TP / 3 SL'), 'TP/SL harus tergabung (2+1 TP, 1+2 SL)');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-3 lanjutan: call MANUAL -> track record TETAP murni setup_log:v1, TIDAK ikut data auto', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    // 5 manual (3 tp/2 sl, cukup lolos gate) + auto punya data BEDA — kalau bocor ke
    // prompt manual, angkanya akan salah (harus tetap 5, bukan gabungan).
    const manualLog = [
      resolvedSetup('m1', 'tp'), resolvedSetup('m2', 'tp'), resolvedSetup('m3', 'tp'),
      resolvedSetup('m4', 'sl'), resolvedSetup('m5', 'sl'),
    ];
    const autoLog = [
      { ...resolvedSetup('a1', 'sl'), source: 'auto' },
      { ...resolvedSetup('a2', 'sl'), source: 'auto' },
      { ...resolvedSetup('a3', 'sl'), source: 'auto' },
      { ...resolvedSetup('a4', 'sl'), source: 'auto' },
      { ...resolvedSetup('a5', 'sl'), source: 'auto' },
    ];
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log:v1': JSON.stringify(manualLog),
      'setup_log_auto:v1': JSON.stringify(autoLog),
    });
    const captured = [];
    const origFetch = global.fetch;
    global.fetch = makeCapturingFetchStub(store, captured);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(captured.length, 1);
      const promptBody = JSON.stringify(captured[0]);
      assert.ok(!promptBody.includes('gabungan seluruh sumber'), 'call manual TIDAK BOLEH pakai label gabungan');
      assert.ok(promptBody.includes('5 setup selesai'), 'harus 5 (murni manual), bukan 10 (kalau auto ikut bocor)');
      assert.ok(promptBody.includes('3 TP / 2 SL'), 'harus murni angka manual, data auto TIDAK BOLEH ikut memengaruhi commentary publik');
    } finally { global.fetch = origFetch; }
  });
});

// ── (g) lock write setup_log — cegah lost update kalau ada write bersamaan ──
// (Plan U-3 lanjutan, 2026-07-20, item #1 dari diskusi user.)

test('PLAN U-3 lanjutan: lock setup_log_auto:v1 sedang dipegang -> write di-skip, response tetap 200', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'lock:setuplog_write:setup_log_auto:v1': '1', // simulasikan write lain sedang berlangsung
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200, 'lock busy TIDAK BOLEH menggagalkan response analisa (best-effort)');
      assert.ok(res.body.structured, 'analisa tetap dikembalikan walau logging di-skip');
      assert.equal(store.strings['setup_log_auto:v1'], undefined, 'tidak ada write ke setup_log_auto:v1 selagi lock dipegang pihak lain');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-3 lanjutan: tanpa lock lain -> write tetap jalan normal & lock dilepas setelahnya', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.ok(store.strings['setup_log_auto:v1'], 'write tetap jalan seperti biasa kalau lock bebas');
      assert.equal(store.strings['lock:setuplog_write:setup_log_auto:v1'], undefined, 'lock harus dilepas (DEL) setelah write selesai');
    } finally { global.fetch = origFetch; }
  });
});

// ── (h) probeCalendarCache — cek kesehatan calendar_v1 langsung ─────────────
// (Plan U-3 lanjutan, item #5 — probe 'forexfactory' lama cuma cek sumber XML yang
// sudah tidak dipakai lagi sejak calendar.js pindah ke TradingView, tidak pernah
// membuktikan calendar_v1 sendiri sehat.)

test('probeCalendarCache: calendar_v1 segar -> OK dengan age_mins & event_count', async () => {
  const { probeCalendarCache } = loadHandler();
  const store = makeStore({
    'calendar_v1': JSON.stringify({
      events: [{ date: '2026-07-20', currency: 'USD', impact: 'High', event: 'X' }],
      count: 1, source: 'tradingview', fetched_at: new Date(Date.now() - 5 * 60000).toISOString(),
    }),
  });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    const detail = await probeCalendarCache();
    assert.equal(detail.event_count, 1);
    assert.ok(detail.age_mins < 180);
    assert.equal(detail.source, 'tradingview');
  } finally { global.fetch = origFetch; }
});

test('probeCalendarCache: calendar_v1 basi (>180 menit) -> throw', async () => {
  const { probeCalendarCache } = loadHandler();
  const store = makeStore({
    'calendar_v1': JSON.stringify({
      events: [], count: 0, source: 'tradingview',
      fetched_at: new Date(Date.now() - 200 * 60000).toISOString(),
    }),
  });
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    await assert.rejects(() => probeCalendarCache(), /basi/);
  } finally { global.fetch = origFetch; }
});

test('probeCalendarCache: calendar_v1 kosong/belum pernah fetch -> throw', async () => {
  const { probeCalendarCache } = loadHandler();
  const store = makeStore({});
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    await assert.rejects(() => probeCalendarCache(), /kosong/);
  } finally { global.fetch = origFetch; }
});

// ── (b) payload publik setup_stats identik sebelum vs sesudah entri auto ────

function baseSetup(overrides) {
  return {
    symbol: 'GC=F', label: 'XAU/USD', bias: 'bullish', entry_zone: '4030-4040', sl: '4000', tp: '4090',
    rr: 3, horizon_days: 3, model: 'deepseek-v4-flash', ts: 1000, closed_t: 2000,
    alignment: null, loss_label: null, label_reason: null, label_by: null,
    intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    ...overrides,
  };
}

const MANUAL_LOG = [
  baseSetup({ id: 'GC=F:1', status: 'tp', source: 'manual' }),
  baseSetup({ id: 'GC=F:2', status: 'sl', bias: 'bearish', source: 'manual' }),
];
const AUTO_LOG = [
  baseSetup({
    id: 'GC=F:9', status: 'tp', source: 'auto',
    intervention: { type: 'tighten_sl', t: 1200, new_sl: 4020, reason: 'x', trigger_guid: 'g' },
    managed_status: 'tp', managed_closed_t: 1500, review_count: 1,
  }),
];

async function callSetupStats(store, extraQuery = {}, headers = {}) {
  const handler = loadHandler();
  const res = fakeRes();
  const origFetch = global.fetch;
  global.fetch = redisFetchStub(store);
  try {
    await handler({ headers, method: 'GET', query: { action: 'setup_stats', ...extraQuery } }, res);
    return res.body;
  } finally { global.fetch = origFetch; }
}

test('PLAN U-7(b): payload publik setup_stats identik sebelum vs sesudah ada entri di setup_log_auto:v1 (snapshot)', async () => {
  await withEnv({}, async () => {
    const before = await callSetupStats(makeStore({ 'setup_log:v1': JSON.stringify(MANUAL_LOG) }));
    const after  = await callSetupStats(makeStore({ 'setup_log:v1': JSON.stringify(MANUAL_LOG), 'setup_log_auto:v1': JSON.stringify(AUTO_LOG) }));
    assert.deepEqual(after, before, 'entri baru di setup_log_auto:v1 TIDAK BOLEH mengubah payload publik setup_stats');

    // Sanity: blok management (U-5a) memang sudah tidak ada di payload publik.
    assert.equal(before.global.management, undefined);
    assert.equal(before.symbols['GC=F'].management, undefined);
    // Sama untuk cancel_flip_ghost (U-3 lanjutan, 2026-07-24) — diagnostik keputusan
    // AI eksperimen, ikut aturan visibilitas sama dengan management.
    assert.equal(before.global.cancel_flip_ghost, undefined);
    assert.equal(before.symbols['GC=F'].cancel_flip_ghost, undefined);
    // Field informasi U-1 tetap publik.
    assert.ok(Object.prototype.hasOwnProperty.call(before.global, 'win_rate_raw'));
    assert.ok(Object.prototype.hasOwnProperty.call(before.global, 'loss_causes'));
  });
});

// ── (c) scope=auto tanpa secret = publik; dengan secret = data eksperimen ───

test('PLAN U-7(c): scope=auto TANPA CRON_SECRET valid -> response publik biasa (tidak membocorkan keberadaan scope)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const seed = { 'setup_log:v1': JSON.stringify(MANUAL_LOG), 'setup_log_auto:v1': JSON.stringify(AUTO_LOG) };
    const publicPayload = await callSetupStats(makeStore(seed));
    const noSecretScopeAuto = await callSetupStats(makeStore(seed), { scope: 'auto' }); // tanpa header secret
    assert.deepEqual(noSecretScopeAuto, publicPayload);
    assert.equal(noSecretScopeAuto.scope, undefined);
  });
});

test('PLAN U-7(c): scope=auto DENGAN CRON_SECRET valid -> data eksperimen (management + consistency), beda dari payload publik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret' }, async () => {
    const store = makeStore({ 'setup_log:v1': JSON.stringify(MANUAL_LOG), 'setup_log_auto:v1': JSON.stringify(AUTO_LOG) });
    store.lists['consistency_log:v1'] = [
      JSON.stringify({ ts: 1, pair: 'XAU/USD', bias_identical: true }),
      JSON.stringify({ ts: 2, pair: 'XAU/USD', bias_identical: false }),
    ];
    const autoPayload = await callSetupStats(store, { scope: 'auto' }, { 'x-cron-secret': 'topsecret' });

    assert.equal(autoPayload.scope, 'auto');
    assert.ok(autoPayload.symbols['GC=F'], 'agregat setup_log_auto:v1 harus ada');
    assert.ok(autoPayload.global.management, 'blok management harus ada di scope=auto');
    assert.equal(autoPayload.global.management.tighten_sl, 1);
    assert.equal(autoPayload.global.management.tighten_cost, 1); // ghost=tp -> intervensi tighten_sl merugi
    assert.ok(autoPayload.global.cancel_flip_ghost, 'blok cancel_flip_ghost harus ada di scope=auto');
    assert.equal(autoPayload.consistency.total, 2);
    assert.equal(autoPayload.consistency.bias_identical, 1);
    assert.equal(autoPayload.consistency.bias_identical_pct, 50);

    // Data eksperimen ini sama sekali beda struktur dari payload publik biasa.
    const publicPayload = await callSetupStats(makeStore({ 'setup_log:v1': JSON.stringify(MANUAL_LOG) }));
    assert.notDeepEqual(autoPayload, publicPayload);
  });
});

// ── (d) position_review menolak id setup manual TANPA call AI ──────────────

test('PLAN U-7(d): position_review menolak id yang ada di setup_log:v1 (manual) -> skipped not_experiment, TANPA call AI', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const manualLog = [baseSetup({ id: 'GC=F:manual1', status: 'open', source: 'manual' })];
    const store = makeStore({ 'setup_log:v1': JSON.stringify(manualLog), 'setup_log_auto:v1': JSON.stringify([]) });
    const { req, res } = fakeReqRes({
      action: 'position_review', headers: { 'x-cron-secret': 'rahasia' },
      body: JSON.stringify({ id: 'GC=F:manual1', trigger: { guid: 'g', title: 't' } }),
    });
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('sambanova.ai') || String(url).includes('groq.com')) {
        throw new Error('AI TIDAK BOLEH dipanggil untuk setup manual');
      }
      return redisFetchStub(store)(url, opts);
    };
    try {
      const handler = loadHandler();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.skipped, 'not_experiment');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN U-7(d): position_review tetap memproses id yang ADA di setup_log_auto:v1 (kontrol positif)', async () => {
  await withEnv({ CRON_SECRET: 'rahasia', SAMBANOVA_API_KEY: 'k' }, async () => {
    const autoSetup = baseSetup({ id: 'GC=F:auto1', status: 'open', source: 'auto', filled_t: 500 });
    const store = makeStore({ 'setup_log:v1': JSON.stringify([]), 'setup_log_auto:v1': JSON.stringify([autoSetup]) });
    const { req, res } = fakeReqRes({
      action: 'position_review', headers: { 'x-cron-secret': 'rahasia' },
      body: JSON.stringify({ id: 'GC=F:auto1', trigger: { guid: 'g', title: 't', cat: 'market-moving' } }),
    });
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('sambanova.ai')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision: 'HOLD', new_sl: null, reason: 'aman', confidence: 'sedang' }) } }] }) };
      }
      return redisFetchStub(store)(url, opts);
    };
    try {
      const handler = loadHandler();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.decision, 'HOLD');
      assert.equal(res.body.setup.review_count, 1);
      const autoLog = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(autoLog[0].review_count, 1);
    } finally { global.fetch = origFetch; }
  });
});

// ── (e) tidak ada string 'setup_log_auto' di index.html (publik) ───────────

test('PLAN U-7(e): index.html tidak memuat string setup_log_auto (isolasi frontend)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.ok(!html.includes('setup_log_auto'), 'index.html TIDAK BOLEH menyebut key eksperimen developer-only');
});

// ── (j) PLAN V-3: circuit breaker terpisah untuk call isAutoCall/test_deepseek=1 ──
// Call developer-only (auto-entry, uji konsistensi) berbagi provider AI dengan traffic
// publik (Ringkasan/Analisa manual/Pre-Entry Check). Tanpa isolasi, 3x gagal beruntun
// dari eksperimen bisa mentrip breaker yang dipakai publik, menjatuhkan fitur publik ke
// fallback tier padahal provider publik sebenarnya sehat.

function failingDeepseekFetchStub(store) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    throw new Error('unexpected network call di test: ' + u);
  };
}

test('PLAN V-3: 3x call auto=1 gagal beruntun -> circuit:ai:deepseek:experimental OPEN, circuit:ai:deepseek (produksi) TIDAK TERSENTUH', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = failingDeepseekFetchStub(store);
    try {
      const handler = loadHandler();
      for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        await handler({
          headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
          query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
        }, res);
        assert.equal(res.statusCode, 200);
      }
      const expCircuit = JSON.parse(store.strings['circuit:ai:deepseek:experimental']);
      assert.equal(expCircuit.state, 'open', 'breaker experimental harus OPEN setelah 3x gagal beruntun call auto');
      assert.equal(store.strings['circuit:ai:deepseek'], undefined, 'breaker produksi ai:deepseek TIDAK BOLEH tersentuh oleh kegagalan call auto');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN V-3: 3x test_deepseek=1 gagal beruntun -> circuit:ai:deepseek:experimental OPEN, circuit:ai:deepseek (produksi) TIDAK TERSENTUH', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = failingDeepseekFetchStub(store);
    try {
      const handler = loadHandler();
      for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        await handler({
          headers: {}, method: 'GET',
          query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', test_deepseek: '1' },
        }, res);
        assert.equal(res.statusCode, 200);
      }
      const expCircuit = JSON.parse(store.strings['circuit:ai:deepseek:experimental']);
      assert.equal(expCircuit.state, 'open', 'breaker experimental harus OPEN setelah 3x test_deepseek=1 gagal beruntun');
      assert.equal(store.strings['circuit:ai:deepseek'], undefined, 'breaker produksi ai:deepseek TIDAK BOLEH tersentuh oleh diagnostik test_deepseek=1');
    } finally { global.fetch = origFetch; }
  });
});

test('PLAN V-3 (kontrol negatif): 3x call PUBLIK (manual) gagal beruntun -> circuit:ai:deepseek (produksi) OPEN, circuit:ai:deepseek:experimental TIDAK TERSENTUH', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = failingDeepseekFetchStub(store);
    try {
      const handler = loadHandler();
      for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);
        assert.equal(res.statusCode, 200);
      }
      const prodCircuit = JSON.parse(store.strings['circuit:ai:deepseek']);
      assert.equal(prodCircuit.state, 'open', 'breaker produksi harus OPEN setelah 3x gagal beruntun call publik');
      assert.equal(store.strings['circuit:ai:deepseek:experimental'], undefined, 'breaker experimental TIDAK BOLEH tersentuh oleh kegagalan call publik');
    } finally { global.fetch = origFetch; }
  });
});

// Audit S218 (2026-07-22/23): circuit breaker call auto sudah terisolasi (tes PLAN V-3 di
// atas), TAPI counter KUOTA HARIAN sempat lupa ikut dipisah — ditemukan lewat audit manual,
// bukan lewat test lama (semua test PLAN V-3 di atas cuma cek circuit breaker, tidak pernah
// cek key `ai_budget:*`). Fix: counter 'deepseek_experimental' terpisah dari 'deepseek'.
test('Audit S218: call auto=1 sukses -> ai_budget:deepseek_experimental naik, ai_budget:deepseek (produksi) TIDAK TERSENTUH', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(store.strings[`ai_budget:deepseek_experimental:${day}`], '1');
      assert.equal(store.strings[`ai_budget:deepseek:${day}`], undefined, 'counter produksi TIDAK BOLEH tersentuh oleh call auto');
    } finally { global.fetch = origFetch; }
  });
});

test('Audit S218 (kontrol negatif): call PUBLIK (manual) sukses -> ai_budget:deepseek naik, ai_budget:deepseek_experimental TIDAK TERSENTUH', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({ headers: {}, method: 'GET', query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' } }, res);
      assert.equal(res.statusCode, 200);
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(store.strings[`ai_budget:deepseek:${day}`], '1');
      assert.equal(store.strings[`ai_budget:deepseek_experimental:${day}`], undefined, 'counter experimental TIDAK BOLEH tersentuh oleh call publik');
    } finally { global.fetch = origFetch; }
  });
});

function failingSambaMainFetchStub(store) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('sambanova.ai')) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    throw new Error('unexpected network call di test: ' + u);
  };
}

test('PLAN V-3: 3x call auto=1 (fallback SambaNova akun-1, tanpa DEEPSEEK_API_KEY) gagal beruntun -> circuit:ai:sambanova:main:experimental OPEN, circuit:ai:sambanova:main (produksi) TIDAK TERSENTUH', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', SAMBANOVA_API_KEY: 'k' }, async () => {
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    });
    const origFetch = global.fetch;
    global.fetch = failingSambaMainFetchStub(store);
    try {
      const handler = loadHandler();
      for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        await handler({
          headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
          query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
        }, res);
        assert.equal(res.statusCode, 200);
      }
      const expCircuit = JSON.parse(store.strings['circuit:ai:sambanova:main:experimental']);
      assert.equal(expCircuit.state, 'open', 'breaker experimental SambaNova akun-1 harus OPEN setelah 3x gagal beruntun call auto');
      assert.equal(store.strings['circuit:ai:sambanova:main'], undefined, 'breaker produksi ai:sambanova:main TIDAK BOLEH tersentuh oleh kegagalan call auto');
    } finally { global.fetch = origFetch; }
  });
});
