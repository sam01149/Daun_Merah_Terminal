// test/admin/setup_override.test.js
// Unit test setupOverrideHandler (api/admin.js, PLAN U-1 Lapis 4, 2026-07-20):
// override admin untuk set/hapus loss_label + label_reason per id setup, TANPA
// pernah menyentuh status/harga (data mentah). Auth sama seperti fundamentalSeedHandler
// (x-admin-secret / x-cron-secret === CRON_SECRET).
const { test } = require('node:test');
const assert = require('node:assert');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const handler = require('../../api/admin.js');

function fakeReqRes({ method = 'POST', headers = {}, body = '' } = {}) {
  const resHeaders = {};
  const req = {
    method,
    query: { action: 'setup_override' },
    headers,
    url: '/api/admin?action=setup_override',
    on(event, cb) {
      if (event === 'data' && body) cb(body);
      if (event === 'end') cb();
    },
  };
  const res = {
    setHeader: (k, v) => { resHeaders[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
  return { req, res };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, APP_KEY: process.env.APP_KEY };
  delete process.env.CRON_SECRET;
  delete process.env.APP_KEY;
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally {
    delete process.env.CRON_SECRET; delete process.env.APP_KEY;
    if (prev.CRON_SECRET !== undefined) process.env.CRON_SECRET = prev.CRON_SECRET;
    if (prev.APP_KEY !== undefined) process.env.APP_KEY = prev.APP_KEY;
  }
}

async function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = orig; }
}

// PLAN (2026-07-25): setupOverrideHandler sekarang membungkus read-modify-write
// dengan lock (`lock:setuplog_write:*`, key TERPISAH dari log itu sendiri) — stub ini
// harus membedakan SET/GET/DEL untuk key lock (selalu sukses, test ini tidak menguji
// kontensi) dari SET/GET untuk log setup yang sebenarnya.
function upstashStub(log) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const isLockKey = typeof args[1] === 'string' && args[1].startsWith('lock:');
    if (args[0] === 'GET') {
      if (isLockKey) return { ok: true, json: async () => ({ result: null }) };
      return { ok: true, json: async () => ({ result: JSON.stringify(log) }) };
    }
    if (args[0] === 'SET') {
      if (isLockKey) return { ok: true, json: async () => ({ result: 'OK' }) };
      log.length = 0; log.push(...JSON.parse(args[2])); return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (args[0] === 'DEL') return { ok: true, json: async () => ({ result: 1 }) };
    throw new Error('unexpected redis command ' + args[0]);
  };
}

const baseSetup = { id: 'GC=F:123', symbol: 'GC=F', bias: 'bearish', entry_zone: '4030-4040', sl: '4065', tp: '3960', status: 'sl', ts: 1000, closed_t: 2000, loss_label: null, label_reason: null, label_by: null };

test('setup_override: tanpa CRON_SECRET -> 401 Unauthorized', async () => {
  await withEnv({}, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'apapun' }, body: JSON.stringify({ id: 'x' }) });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 401);
  });
});

test('setup_override: secret salah -> 401 Unauthorized', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'salah' }, body: JSON.stringify({ id: 'x' }) });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 401);
  });
});

test('setup_override: method GET (bukan POST) -> 405', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ method: 'GET', headers: { 'x-admin-secret': 'rahasia' } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 405);
  });
});

test('setup_override: tanpa id -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'rahasia' }, body: JSON.stringify({ loss_label: 'fakeout_sl', label_reason: 'x' }) });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: loss_label bukan salah satu whitelist -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'rahasia' }, body: JSON.stringify({ id: 'x', loss_label: 'ngasal', label_reason: 'x' }) });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: set loss_label tanpa label_reason -> 400 (wajib)', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'rahasia' }, body: JSON.stringify({ id: 'x', loss_label: 'fakeout_sl' }) });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: id tidak ditemukan -> 404', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...baseSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'rahasia' }, body: JSON.stringify({ id: 'tidak-ada', loss_label: 'fakeout_sl', label_reason: 'x' }) });
    await withFetch(upstashStub(log), async () => { await handler(req, res); });
    assert.strictEqual(res.statusCode, 404);
  });
});

test('setup_override: sukses set label -> loss_label/label_reason/label_by berubah, status & harga TIDAK disentuh', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...baseSetup }];
    const { req, res } = fakeReqRes({ headers: { 'x-admin-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:123', loss_label: 'fakeout_sl', label_reason: 'review manual admin' }) });
    await withFetch(upstashStub(log), async () => { await handler(req, res); });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.setup.loss_label, 'fakeout_sl');
    assert.strictEqual(res.body.setup.label_reason, 'review manual admin');
    assert.strictEqual(res.body.setup.label_by, 'admin');
    // Data mentah tidak berubah
    assert.strictEqual(res.body.setup.status, 'sl');
    assert.strictEqual(res.body.setup.entry_zone, '4030-4040');
    assert.strictEqual(res.body.setup.sl, '4065');
    assert.strictEqual(res.body.setup.tp, '3960');
  });
});

test('setup_override: loss_label null menghapus label_reason & label_by tanpa perlu label_reason', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...baseSetup, loss_label: 'fundamental_shock', label_reason: 'NFP', label_by: 'auto' }];
    const { req, res } = fakeReqRes({ headers: { 'x-cron-secret': 'rahasia' }, body: JSON.stringify({ id: 'GC=F:123', loss_label: null }) });
    await withFetch(upstashStub(log), async () => { await handler(req, res); });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.setup.loss_label, null);
    assert.strictEqual(res.body.setup.label_reason, null);
    assert.strictEqual(res.body.setup.label_by, null);
    assert.strictEqual(res.body.setup.status, 'sl'); // status tetap
  });
});

// ── data_fix: koreksi status/filled_t/closed_t untuk rekaman TERBUKTI korup ───
// (2026-07-25, diskusi user — status 'tp' palsu di GC=F akibat race condition)

test('setup_override: data_fix tanpa reason -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({
      headers: { 'x-admin-secret': 'rahasia' },
      body: JSON.stringify({ id: 'GC=F:123', data_fix: { status: 'open' } }),
    });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: data_fix.status bukan whitelist -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({
      headers: { 'x-admin-secret': 'rahasia' },
      body: JSON.stringify({ id: 'GC=F:123', data_fix: { status: 'menang', reason: 'x' } }),
    });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: data_fix.filled_t bukan angka positif -> 400', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const { req, res } = fakeReqRes({
      headers: { 'x-admin-secret': 'rahasia' },
      body: JSON.stringify({ id: 'GC=F:123', data_fix: { filled_t: -5, reason: 'x' } }),
    });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

test('setup_override: data_fix sukses -> status/filled_t diubah, closed_t:null dihapus, jejak audit tersimpan', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...baseSetup, status: 'tp', filled_t: 5000, closed_t: 2000 }];
    const { req, res } = fakeReqRes({
      headers: { 'x-admin-secret': 'rahasia' },
      body: JSON.stringify({
        id: 'GC=F:123',
        data_fix: { status: 'open', filled_t: 4000, closed_t: null, reason: 'race condition, harga belum kena TP' },
      }),
    });
    await withFetch(upstashStub(log), async () => { await handler(req, res); });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.setup.status, 'open');
    assert.strictEqual(res.body.setup.filled_t, 4000);
    assert.strictEqual(res.body.setup.closed_t, undefined, 'closed_t:null harus menghapus field, bukan menyimpan null');
    assert.strictEqual(res.body.setup.data_fix_reason, 'race condition, harga belum kena TP');
    assert.strictEqual(res.body.setup.data_fix_by, 'admin');
    assert.strictEqual(typeof res.body.setup.data_fix_at, 'number');
    // loss_label tidak ikut disentuh karena tidak dikirim
    assert.strictEqual(res.body.setup.loss_label, null);
  });
});

test('setup_override: data_fix bisa dipakai bersamaan loss_label dalam satu request', async () => {
  await withEnv({ CRON_SECRET: 'rahasia' }, async () => {
    const log = [{ ...baseSetup, status: 'sl' }];
    const { req, res } = fakeReqRes({
      headers: { 'x-admin-secret': 'rahasia' },
      body: JSON.stringify({
        id: 'GC=F:123', loss_label: 'fakeout_sl', label_reason: 'wick tipis',
        data_fix: { status: 'ambiguous', reason: 'evaluator salah baca candle' },
      }),
    });
    await withFetch(upstashStub(log), async () => { await handler(req, res); });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.setup.status, 'ambiguous');
    assert.strictEqual(res.body.setup.loss_label, 'fakeout_sl');
  });
});
