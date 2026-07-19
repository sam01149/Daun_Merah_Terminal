// test/app_key.test.js
// Unit test gate APP_KEY: api/_app_key.js (server) + _wrapFetchWithAppKey (client,
// diekstrak dari index.html). Kontrak penting: fail-open tanpa env (deploy dulu aman),
// cron/admin secret tetap lolos, OPTIONS tidak pernah diblok.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { requireAppKey } = require('../../api/_app_key');

function fakeReqRes(headers = {}, method = 'GET') {
  const req = { headers, method };
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return { req, res };
}

test('requireAppKey: APP_KEY tidak diset → gate nonaktif (fail-open)', () => {
  delete process.env.APP_KEY;
  const { req, res } = fakeReqRes({});
  assert.strictEqual(requireAppKey(req, res), false);
  assert.strictEqual(res.statusCode, undefined);
});

test('requireAppKey: kunci benar lolos, salah/kosong → 401 app_key_required', () => {
  process.env.APP_KEY = 'rahasia-123';
  const ok = fakeReqRes({ 'x-app-key': 'rahasia-123' });
  assert.strictEqual(requireAppKey(ok.req, ok.res), false);

  const wrong = fakeReqRes({ 'x-app-key': 'salah' });
  assert.strictEqual(requireAppKey(wrong.req, wrong.res), true);
  assert.strictEqual(wrong.res.statusCode, 401);
  assert.strictEqual(wrong.res.body.error, 'app_key_required');

  const missing = fakeReqRes({});
  assert.strictEqual(requireAppKey(missing.req, missing.res), true);
  assert.strictEqual(missing.res.statusCode, 401);
  delete process.env.APP_KEY;
});

test('requireAppKey: panjang beda tidak melempar (timingSafeEqual butuh length sama)', () => {
  process.env.APP_KEY = 'rahasia-123';
  const { req, res } = fakeReqRes({ 'x-app-key': 'x' });
  assert.doesNotThrow(() => requireAppKey(req, res));
  assert.strictEqual(res.statusCode, 401);
  delete process.env.APP_KEY;
});

test('requireAppKey: OPTIONS selalu lolos (preflight tanpa custom header)', () => {
  process.env.APP_KEY = 'rahasia-123';
  const { req, res } = fakeReqRes({}, 'OPTIONS');
  assert.strictEqual(requireAppKey(req, res), false);
  delete process.env.APP_KEY;
});

test('requireAppKey: cron/admin bypass — x-vercel-cron, x-cron-secret, x-admin-secret', () => {
  process.env.APP_KEY = 'rahasia-123';
  process.env.CRON_SECRET = 'cron-abc';
  for (const headers of [
    { 'x-vercel-cron': '1' },
    { 'x-cron-secret': 'cron-abc' },
    { 'x-admin-secret': 'cron-abc' },
  ]) {
    const { req, res } = fakeReqRes(headers);
    assert.strictEqual(requireAppKey(req, res), false, `harus lolos: ${JSON.stringify(headers)}`);
  }
  // Secret salah tetap diblok
  const bad = fakeReqRes({ 'x-cron-secret': 'salah' });
  assert.strictEqual(requireAppKey(bad.req, bad.res), true);
  delete process.env.APP_KEY;
  delete process.env.CRON_SECRET;
});

// ── Integrasi: handler endpoint asli, in-process ─────────────────────────────

function fakeEndpointRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    send(x) { this.sent = x; return this; },
    end() { return this; },
  };
}

test('integrasi: calendar & market-digest menolak tanpa kunci SEBELUM kerja apapun', async () => {
  process.env.APP_KEY = 'rahasia-123';
  for (const mod of ['../../api/calendar.js', '../../api/market-digest.js']) {
    const handler = require(mod);
    const res = fakeEndpointRes();
    await handler({ headers: {}, method: 'GET', query: {} }, res);
    assert.strictEqual(res.statusCode, 401, `${mod} harus 401`);
    assert.strictEqual(res.body.error, 'app_key_required', `${mod} body gate`);
  }
  delete process.env.APP_KEY;
});

test('integrasi: feeds type=rss lolos gate (service worker), type=cot diblok', async () => {
  process.env.APP_KEY = 'rahasia-123';
  const handler = require('../../api/feeds.js');

  const cot = fakeEndpointRes();
  await handler({ headers: {}, method: 'GET', query: { type: 'cot' } }, cot);
  assert.strictEqual(cot.statusCode, 401);
  assert.strictEqual(cot.body.error, 'app_key_required');

  // rss: stub fetch upstream supaya tidak ada network call — yang diuji cuma
  // bahwa GATE tidak memblokir (respons apapun selain 401 app_key_required).
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('stub: no network in test'); };
  const rss = fakeEndpointRes();
  try { await handler({ headers: {}, method: 'GET', query: { type: 'rss' } }, rss); } catch(e) {}
  global.fetch = origFetch;
  assert.notStrictEqual(rss.body?.error, 'app_key_required', 'rss tidak boleh diblok gate');
  delete process.env.APP_KEY;
});

// ── Client wrapper (diekstrak dari index.html) ───────────────────────────────

function extractWrapper() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const start = html.indexOf('function _wrapFetchWithAppKey(');
  assert.ok(start !== -1, '_wrapFetchWithAppKey harus ada di index.html');
  let depth = 0, i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return eval(`(${html.slice(start, i + 1)})`);
}

function fakeResponse(status, body) {
  const r = {
    status,
    json: async () => { if (body === undefined) throw new Error('not json'); return body; },
  };
  r.clone = () => r;
  return r;
}

test('wrapper: request /api/* diberi header x-app-key, non-api tidak disentuh', async () => {
  const wrap = extractWrapper();
  const calls = [];
  const fetchMock = async (input, init) => { calls.push({ input, init }); return fakeResponse(200, {}); };
  const wrapped = wrap(fetchMock, () => 'kunci-x', () => {});

  await wrapped('/api/feeds?type=rss');
  assert.strictEqual(calls[0].init.headers.get('x-app-key'), 'kunci-x');

  await wrapped('http://127.0.0.1:5001/health', { method: 'GET' });
  assert.strictEqual(calls[1].init.headers, undefined, 'fetch non-api tidak boleh dimodifikasi');

  // Header bawaan call site tidak hilang
  await wrapped('/api/admin?action=ohlcv_analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(calls[2].init.headers.get('Content-Type'), 'application/json');
  assert.strictEqual(calls[2].init.headers.get('x-app-key'), 'kunci-x');
  assert.strictEqual(calls[2].init.method, 'POST');
});

test('wrapper: tanpa kunci tersimpan → tidak set header (server yang memutuskan 401)', async () => {
  const wrap = extractWrapper();
  const calls = [];
  const wrapped = wrap(async (i, init) => { calls.push(init); return fakeResponse(200, {}); }, () => '', () => {});
  await wrapped('/api/calendar');
  assert.strictEqual(calls[0].headers.get('x-app-key'), null);
});

test('wrapper: 401 app_key_required memicu onUnauthorized; 401 lain tidak', async () => {
  const wrap = extractWrapper();
  let gateShown = 0;
  const mk = body => wrap(async () => fakeResponse(401, body), () => 'k', () => { gateShown++; });

  await mk({ error: 'app_key_required' })('/api/journal');
  assert.strictEqual(gateShown, 1);

  await mk({ error: 'Unauthorized' })('/api/admin?action=push');
  assert.strictEqual(gateShown, 1, '401 dari gate lain tidak boleh memicu overlay');

  await assert.doesNotReject(mk(undefined)('/api/feeds')); // body bukan JSON → tidak melempar
  assert.strictEqual(gateShown, 1);
});
