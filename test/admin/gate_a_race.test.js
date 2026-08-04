// test/admin/gate_a_race.test.js — [BUG DITEMUKAN & DIFIX 2026-07-29, audit lanjutan
// celah kesalahan trader] Lock `lock:setuplog_write:setup_log_auto:v1` punya TTL 10
// detik, tapi Gate A (AI Kritikus, _runCriticVerdict) timeout 25 detik — sebelumnya
// SELURUH Gate D/B/A + tulis akhir terjadi di bawah SATU lock yang sama, jadi tiap kali
// Gate A benar-benar terpanggil, lock itu sudah kedaluwarsa jauh sebelum selesai (window
// nyata untuk proses lain menulis array yang sama -> lost update). Fix: dipecah 2 fase —
// Fase 1 (dup/openSame/stalePending refine-atau-flip, Gate D/B) di bawah lock singkat;
// Fase 2 (Gate A) TANPA lock, lalu re-acquire + baca ulang state SEGAR sebelum tulis
// akhir (pola sama positionReviewHandler). Test ini memverifikasi:
// (a) Gate A verdict 'lanjut' -> entri tetap tersimpan seperti sebelumnya.
// (b) Gate A verdict 'batalkan' -> entri TIDAK tersimpan (perilaku lama dipertahankan).
// (c) State berubah SELAMA Gate A berjalan (posisi 'open' baru muncul untuk symbol yang
//     sama) -> entri BARU dibuang (race_detected), tidak menimpa buta.
// (d) Flip-cancel (stalePending dibatalkan bias_flip) yang KEMUDIAN kandidat barunya
//     divero Gate A -> pembatalan stalePending TETAP tersimpan (bug sekunder yang ikut
//     ditemukan: dulu shouldSaveLog tidak diset true di cabang ini, jadi pembatalan bisa
//     hilang tanpa jejak kalau kandidat baru akhirnya ditahan gate).
const { test } = require('node:test');
const assert = require('node:assert/strict');
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

function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

function makeStore(seed = {}) { return { strings: { ...seed }, lists: {} }; }
function redisFetchStub(store) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const [cmd, key, ...rest] = args;
    switch (cmd) {
      case 'GET':
        return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
      case 'SET': {
        const flags = rest.slice(1).map(v => String(v).toUpperCase());
        if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(store.strings, key)) {
          return { ok: true, json: async () => ({ result: null }) };
        }
        store.strings[key] = rest[0];
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'DEL': delete store.strings[key]; return { ok: true, json: async () => ({ result: 1 }) };
      case 'INCR': {
        const n = (parseInt(store.strings[key] || '0', 10)) + 1;
        store.strings[key] = String(n);
        return { ok: true, json: async () => ({ result: n }) };
      }
      default: return { ok: true, json: async () => ({ result: 'OK' }) };
    }
  };
}

const AI_JSON_BEARISH = {
  bias: 'bearish',
  entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
  sl: '1.2850', tp: '1.2700',
  trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
  time_horizon_days: 3, makro_alignment: null, makro_alignment_reason: null,
  conflict: 'none', conflict_note: null,
};
const AI_RAW_TEXT = `${JSON.stringify(AI_JSON_BEARISH)}\n===COMMENTARY===\nKomentar singkat untuk tes Gate A/race.`;

function criticResponse(verdict) {
  return JSON.stringify({ objections: verdict === 'batalkan' ? [{ severity: 'tinggi', reason: 'contoh keberatan tes' }] : [], verdict });
}

// onCriticCall: hook opsional dipanggil TEPAT SEBELUM stub membalas request SambaNova
// (Gate A) — dipakai test (c) untuk menyuntik "perubahan state pihak lain" di titik
// yang persis meniru race window nyata (state berubah SELAMA AI mikir).
function makeAnalyzeFetchStub(store, { criticVerdict = 'lanjut', onCriticCall = null } = {}) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    if (u.includes('api.sambanova.ai')) {
      if (onCriticCall) onCriticCall();
      return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse(criticVerdict) } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY; delete process.env.SAMBANOVA_API_KEY;
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY; delete process.env.SAMBANOVA_API_KEY;
    for (const k of Object.keys(prev)) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

function baseStore() {
  return makeStore({
    'ohlcv_fresh:GBPUSD=X': '1',
    'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
    'setup_log_auto:v1': JSON.stringify([]),
  });
}

test('Gate A lanjut: entri tetap tersimpan (lock dilepas sebelum AI, re-acquire sukses)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, { criticVerdict: 'lanjut' });
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1);
      assert.equal(log[0].status, 'pending');
      assert.equal(store.strings['auto_guard_stats:saved'], '1');
      assert.equal(store.strings['auto_guard_stats:considered'], '1');
    } finally { global.fetch = origFetch; }
  });
});

test('Gate A batalkan: entri TIDAK tersimpan, auto_guard_stats:critic_veto naik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, { criticVerdict: 'batalkan' });
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 0, 'critic_veto -> tidak ada entri baru tersimpan');
      assert.equal(store.strings['auto_guard_stats:critic_veto'], '1');
      assert.equal(store.strings['auto_guard_stats:saved'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('Race terdeteksi selama Gate A berjalan: posisi open baru muncul untuk symbol sama -> entri BARU dibuang, tidak menimpa', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    // Selama Gate A "berpikir" (dipanggil ke SambaNova), proses LAIN (simulasi) menulis
    // posisi 'open' untuk symbol yang sama — meniru window race nyata yang jadi alasan
    // fix ini. Kalau lock masih dipegang dari Fase 1 (perilaku LAMA), mutasi luar ini
    // mustahil terjadi tepat di titik ini; dengan fix (lock sudah dilepas), ini valid.
    global.fetch = makeAnalyzeFetchStub(store, {
      criticVerdict: 'lanjut',
      onCriticCall: () => {
        const openElsewhere = [{ id: 'GBPUSD=X:999', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bullish', entry_zone: '1.29', sl: '1.28', tp: '1.31', status: 'open', ts: Date.now(), source: 'auto' }];
        store.strings['setup_log_auto:v1'] = JSON.stringify(openElsewhere);
      },
    });
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1, 'HANYA posisi open yang muncul selama race, kandidat baru TIDAK ditambahkan di atasnya');
      assert.equal(log[0].id, 'GBPUSD=X:999');
      assert.equal(log[0].status, 'open');
    } finally { global.fetch = origFetch; }
  });
});

test('Flip-cancel lalu Gate A batalkan kandidat baru: pembatalan stalePending TETAP tersimpan (bug sekunder difix)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const stalePending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bullish',
      entry_zone: '1.2700-1.2710', sl: '1.2650', tp: '1.2800',
      rr: 2, horizon_days: 5, model: 'deepseek-v4', ts: Date.now() - 3600000, status: 'pending',
      source: 'auto', alignment: null, confidence: null,
      conflict: 'none', conflict_note: null, makro_alignment: null, makro_alignment_reason: null,
      loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([stalePending]),
    });
    const origFetch = global.fetch;
    // AI_JSON_BEARISH (bias='bearish') berlawanan dgn stalePending.bias='bullish', conflict
    // 'none' (bukan whipsaw) -> stalePending harus di-cancel (bias_flip) di Fase 1. Gate A
    // lalu membatalkan KANDIDAT BARU (verdict batalkan) — stalePending yg sudah di-cancel
    // sebelumnya harus tetap tersimpan, bukan ikut hilang.
    global.fetch = makeAnalyzeFetchStub(store, { criticVerdict: 'batalkan' });
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const old = log.find(x => x.id === 'GBPUSD=X:111');
      assert.ok(old, 'stalePending harus tetap ada di log');
      assert.equal(old.status, 'canceled', 'pembatalan bias_flip HARUS tersimpan walau kandidat baru akhirnya divero Gate A');
      assert.equal(old.canceled_reason, 'bias_flip');
      const newEntry = log.find(x => x.symbol === 'GBPUSD=X' && x.status === 'pending');
      assert.equal(newEntry, undefined, 'kandidat baru yang divero Gate A tidak boleh tersimpan');
    } finally { global.fetch = origFetch; }
  });
});

// Audit S277 (2026-08-04): Gate E — AI menandai sendiri conflict:'waktu' (skema PLAN
// U-2, none/arah/waktu). Sempat jadi hard block (auto-reject sebelum Gate A dipanggil),
// DILONGGARKAN sesi yang sama (diskusi user): dasarnya cuma 4-5 sampel + sudah ada
// tighten_sl reaktif berita untuk posisi open (api/_position_review.js) — lihat
// api/_auto_entry_guard.js. Sekarang conflict:'waktu' cuma flag observasi non-blocking,
// kandidatnya TETAP diteruskan ke Gate A (AI Kritikus) yang independen menilai.
test('Gate E conflict:"waktu" — flag observasi naik TAPI Gate A tetap dipanggil, verdict "lanjut" -> entri tersimpan', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const aiJsonConflictWaktu = { ...AI_JSON_BEARISH, conflict: 'waktu', conflict_note: 'FOMC dalam 18 jam, horizon 3 hari' };
    const aiRawText = `${JSON.stringify(aiJsonConflictWaktu)}\n===COMMENTARY===\nKomentar singkat untuk tes Gate E.`;
    const store = baseStore();
    const origFetch = global.fetch;
    const redisStub = redisFetchStub(store);
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisStub(url, opts);
      if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: aiRawText } }] }) };
      if (u.includes('api.sambanova.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse('lanjut') } }] }) };
      throw new Error('unexpected network call di test: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1, 'conflict:"waktu" tidak lagi auto-reject -> entri tersimpan kalau Gate A lanjut');
      assert.equal(log[0].conflict, 'waktu');
      assert.equal(store.strings['auto_guard_stats:considered'], '1');
      assert.equal(store.strings['auto_guard_stats:conflict_waktu_flagged'], '1', 'flag observasi tetap naik walau tidak menahan');
      assert.equal(store.strings['auto_guard_stats:saved'], '1');
    } finally { global.fetch = origFetch; }
  });
});

test('Gate E conflict:"waktu" — Gate A tetap bisa veto (critic_veto), bukan lagi auto-reject buta oleh Gate E sendiri', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k', SAMBANOVA_API_KEY: 'sk' }, async () => {
    const aiJsonConflictWaktu = { ...AI_JSON_BEARISH, conflict: 'waktu', conflict_note: 'FOMC dalam 18 jam, horizon 3 hari' };
    const aiRawText = `${JSON.stringify(aiJsonConflictWaktu)}\n===COMMENTARY===\nKomentar singkat untuk tes Gate E.`;
    const store = baseStore();
    const origFetch = global.fetch;
    const redisStub = redisFetchStub(store);
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisStub(url, opts);
      if (u.includes('api.deepseek.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: aiRawText } }] }) };
      if (u.includes('api.sambanova.ai')) return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse('batalkan') } }] }) };
      throw new Error('unexpected network call di test: ' + u);
    };
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 0, 'Gate A veto -> tidak tersimpan (tapi lewat critic_veto, bukan conflict_waktu)');
      assert.equal(store.strings['auto_guard_stats:conflict_waktu_flagged'], '1');
      assert.equal(store.strings['auto_guard_stats:critic_veto'], '1');
      assert.equal(store.strings['auto_guard_stats:saved'], undefined);
    } finally { global.fetch = origFetch; }
  });
});
