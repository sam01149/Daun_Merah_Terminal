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
// (b) Gate A verdict 'batalkan' -> TIDAK PERNAH jadi entri live (pending/open), tapi
//     (2026-08-08, ghost-tracking) tersimpan sebagai 'canceled'/canceled_reason:
//     'gate_critic_veto' supaya bisa diaudit nanti apakah Gate A benar menahan.
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

const { AATAS_OK_FIELDS } = require('./_aatas_fixture');

// AATAS v2 (2026-08-25): jalur auto sekarang menegakkan Gate 1 di KODE, jadi jawaban
// AI di test ini WAJIB patuh skema fundamental (lihat _aatas_fixture.js) — tanpa itu
// kandidat dibatalkan sebelum sempat sampai ke Gate A yang justru sedang diuji di sini.
const AI_JSON_BEARISH = {
  ...AATAS_OK_FIELDS,
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

// onCriticCall: hook opsional dipanggil TEPAT SEBELUM stub membalas request Gate A
// Sistem Hakim (AI Kritikus, DeepSeek — sama provider dengan analisa setup utama,
// dibedakan dari isi body request bukan URL karena keduanya sama-sama ke
// api.deepseek.com) — dipakai test (c) untuk menyuntik "perubahan state pihak lain"
// di titik yang persis meniru race window nyata (state berubah SELAMA AI mikir).
function makeAnalyzeFetchStub(store, { criticVerdict = 'lanjut', onCriticCall = null } = {}) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      const isCritic = String(opts.body).includes('objections');
      if (isCritic) {
        if (onCriticCall) onCriticCall();
        return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse(criticVerdict) } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_RAW_TEXT } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
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
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
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

test('Gate A batalkan: TIDAK ada entri live (pending/open), tapi tersimpan sebagai ghost canceled + auto_guard_stats:critic_veto naik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
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
      // (2026-08-08) Ghost-tracking: critic_veto sekarang DISIMPAN sebagai 'canceled'
      // (supaya bisa diaudit apakah Gate A benar menahan atau kebetulan buang kandidat
      // yang sebenarnya menang) — tapi TIDAK PERNAH sebagai live pending/open, jadi
      // tidak ikut win-rate/exposure manapun. Itu invarian yang sebenarnya dijaga test
      // ini, bukan "log.length === 0".
      assert.equal(log.length, 1);
      assert.equal(log[0].status, 'canceled');
      assert.equal(log[0].canceled_reason, 'gate_critic_veto');
      assert.ok(log.every(x => x.status !== 'pending' && x.status !== 'open'), 'critic_veto tidak pernah jadi entri live');
      assert.equal(store.strings['auto_guard_stats:critic_veto'], '1');
      assert.equal(store.strings['auto_guard_stats:saved'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('Race terdeteksi selama Gate A berjalan: posisi open baru muncul untuk symbol sama -> entri BARU dibuang, tidak menimpa', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
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
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
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
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const aiJsonConflictWaktu = { ...AI_JSON_BEARISH, conflict: 'waktu', conflict_note: 'FOMC dalam 18 jam, horizon 3 hari' };
    const aiRawText = `${JSON.stringify(aiJsonConflictWaktu)}\n===COMMENTARY===\nKomentar singkat untuk tes Gate E.`;
    const store = baseStore();
    const origFetch = global.fetch;
    const redisStub = redisFetchStub(store);
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisStub(url, opts);
      if (u.includes('api.deepseek.com')) {
        if (String(opts.body).includes('objections')) return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse('lanjut') } }] }) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: aiRawText } }] }) };
      }
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
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const aiJsonConflictWaktu = { ...AI_JSON_BEARISH, conflict: 'waktu', conflict_note: 'FOMC dalam 18 jam, horizon 3 hari' };
    const aiRawText = `${JSON.stringify(aiJsonConflictWaktu)}\n===COMMENTARY===\nKomentar singkat untuk tes Gate E.`;
    const store = baseStore();
    const origFetch = global.fetch;
    const redisStub = redisFetchStub(store);
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('fake-upstash.test')) return redisStub(url, opts);
      if (u.includes('api.deepseek.com')) {
        if (String(opts.body).includes('objections')) return { ok: true, json: async () => ({ choices: [{ message: { content: criticResponse('batalkan') } }] }) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: aiRawText } }] }) };
      }
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
      // (2026-08-08) sama seperti test critic_veto di atas — tersimpan sebagai ghost
      // 'canceled', bukan 0 entri sama sekali; yang penting tidak pernah live.
      assert.equal(log.length, 1, 'Gate A veto -> disimpan sbg ghost canceled (tapi lewat critic_veto, bukan conflict_waktu)');
      assert.equal(log[0].status, 'canceled');
      assert.equal(log[0].canceled_reason, 'gate_critic_veto');
      assert.equal(store.strings['auto_guard_stats:conflict_waktu_flagged'], '1');
      assert.equal(store.strings['auto_guard_stats:critic_veto'], '1');
      assert.equal(store.strings['auto_guard_stats:saved'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

// Track 1b (Road to Professional LLM Trader, 2026-08-04, diskusi user): rekam
// risk_regime SAAT setup dibuat — cache `risk_regime` (api/risk-regime.js) TTL 5
// menit & selalu ditimpa, TIDAK ada arsip historis, jadi kalau tidak direkam
// per-setup, regime yang berlaku di tanggal itu sulit direkonstruksi lagi nanti.
// Dipakai untuk Plan U item #10 (gating berbasis rezim, KONDISIONAL pada bukti
// regime-dependency) + audit apakah bias yang dipilih AI konsisten dengan regime.
test('Track 1b: field "regime" pada setup baru = risk_regime yang berlaku saat itu (nol fetch tambahan, sudah dipakai Gate B)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    store.strings['risk_regime'] = JSON.stringify({ regime: 'risk_off', computed_at: new Date().toISOString() });
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
      assert.equal(log[0].regime, 'risk_off');
    } finally { global.fetch = origFetch; }
  });
});

test('Track 1b: risk_regime cache kosong/gagal parse -> field "regime" null, TIDAK menggagalkan penyimpanan setup', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore(); // tanpa key 'risk_regime' -> GET null
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
      assert.equal(log[0].regime, null);
    } finally { global.fetch = origFetch; }
  });
});

// BUG DITEMUKAN & DIFIX (2026-08-18, audit lanjutan investigasi SL AUD/NZD): refine-
// in-place (PENDING lama, bias searah) dulu SELALU set blockedByOpenPosition=true, yang
// sebagai efek samping membuat Gate A (Kritikus) TIDAK PERNAH dipanggil untuk refine —
// level entry/SL/TP FINAL yang benar-benar live tidak pernah diaudit, cuma generasi
// pertama (kalau itu pun lolos). Sekarang refine di-stage ke `refineCandidate`, lewat
// Gate A yang sama seperti kandidat baru, baru diterapkan di Fase 2 kalau lolos.
test('Refine-in-place SEKARANG lewat Gate A juga: verdict lanjut -> level baru diterapkan + refined_count naik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: Date.now() - 3600000, status: 'pending',
      source: 'auto', alignment: null, confidence: null,
      conflict: 'none', conflict_note: null, makro_alignment: null, makro_alignment_reason: null,
      loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
      commentary: 'Komentar generasi PERTAMA.',
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
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
      assert.equal(log.length, 1, 'refine tidak menambah entry baru');
      assert.equal(log[0].status, 'pending');
      assert.equal(log[0].entry_zone, '1.2795-1.2805', 'level diperbarui ke generasi terbaru (Gate A lanjut)');
      // AATAS v2: jalur auto tidak lagi memproduksi narasi 5 paragraf — commentary lama
      // dibuang (null) alih-alih dipertahankan, supaya narasi generasi lama tidak nempel
      // di sebelah level baru. Naratifnya sekarang di `reasoning_note`.
      assert.equal(log[0].commentary, null, 'commentary generasi lama tidak boleh bertahan di jalur auto');
      assert.match(log[0].reasoning_note || '', /./, 'reasoning_note tetap terisi sebagai jejak naratif');
      assert.equal(log[0].refined_count, 1);
      assert.equal(store.strings['auto_guard_stats:saved_refine'], '1');
    } finally { global.fetch = origFetch; }
  });
});

test('Refine-in-place: Gate A verdict batalkan -> level LAMA dipertahankan, refined_count TIDAK naik, critic_veto_refine naik', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: Date.now() - 3600000, status: 'pending',
      source: 'auto', alignment: null, confidence: null,
      conflict: 'none', conflict_note: null, makro_alignment: null, makro_alignment_reason: null,
      loss_label: null, label_reason: null, label_by: null,
      intervention: null, managed_status: null, managed_closed_t: null, review_count: 0,
      commentary: 'Komentar generasi PERTAMA — harus TETAP setelah veto.',
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
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
      assert.equal(log.length, 1, 'veto pada refine TIDAK membuat ghost entry baru — posisi pending lama tetap satu-satunya baris');
      assert.equal(log[0].id, 'GBPUSD=X:111');
      assert.equal(log[0].status, 'pending', 'posisi lama TETAP pending, veto refine bukan cancel posisi');
      assert.equal(log[0].entry_zone, '1.2900-1.2910', 'level LAMA dipertahankan, refine ditolak Gate A');
      assert.equal(log[0].sl, '1.2960');
      assert.equal(log[0].commentary, 'Komentar generasi PERTAMA — harus TETAP setelah veto.');
      assert.equal(log[0].refined_count, undefined, 'refined_count TIDAK naik karena refine ditolak');
      assert.equal(store.strings['auto_guard_stats:critic_veto_refine'], '1');
      assert.equal(store.strings['auto_guard_stats:saved_refine'], undefined);
    } finally { global.fetch = origFetch; }
  });
});
