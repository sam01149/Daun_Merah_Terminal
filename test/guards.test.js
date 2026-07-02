// test/guards.test.js
// Unit test guard modules: _ai_guard, _ratelimit, _circuit_breaker.
// Semua harus FAIL-OPEN saat Redis tidak dikonfigurasi (tidak ada env) —
// test ini juga memastikan tidak ada network call yang menggantung.
const { test } = require('node:test');
const assert = require('node:assert');

// Pastikan Redis dianggap tidak terkonfigurasi di seluruh suite ini
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { allowAiCall, providerFromUrl } = require('../api/_ai_guard');
const rateLimit = require('../api/_ratelimit');
const cb = require('../api/_circuit_breaker');

// ── _ai_guard ───────────────────────────────────────────────────────────────

test('providerFromUrl mengenali 4 provider', () => {
  assert.strictEqual(providerFromUrl('https://api.groq.com/openai/v1/chat/completions'), 'groq');
  assert.strictEqual(providerFromUrl('https://api.sambanova.ai/v1/chat/completions'), 'sambanova');
  assert.strictEqual(providerFromUrl('https://openrouter.ai/api/v1/chat/completions'), 'openrouter');
  assert.strictEqual(providerFromUrl('https://api.cerebras.ai/v1/chat/completions'), 'cerebras');
  assert.strictEqual(providerFromUrl('https://example.com/v1'), null);
  assert.strictEqual(providerFromUrl(null), null);
});

test('allowAiCall fail-open tanpa Redis env', async () => {
  assert.strictEqual(await allowAiCall('groq'), true);
});

test('allowAiCall provider tak dikenal → diizinkan (jangan blokir)', async () => {
  assert.strictEqual(await allowAiCall(null), true);
});

// ── _ratelimit ──────────────────────────────────────────────────────────────

function fakeReqRes(ip) {
  const headers = {};
  const req = { headers: { 'x-forwarded-for': ip }, url: '/api/test', socket: {} };
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return { req, res, headers };
}

test('rateLimit fail-open tanpa Redis env', async () => {
  const { req, res } = fakeReqRes('203.0.113.7');
  assert.strictEqual(await rateLimit(req, res, { limit: 1, windowSecs: 60 }), false);
});

test('rateLimit whitelist IP internal/lokal', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10']) {
    const { req, res } = fakeReqRes(ip);
    assert.strictEqual(await rateLimit(req, res, { limit: 0, windowSecs: 60 }), false, `harus whitelist: ${ip}`);
  }
});

// ── _circuit_breaker ────────────────────────────────────────────────────────

test('circuit breaker canCall fail-open tanpa Redis env', async () => {
  assert.strictEqual(await cb.canCall('test-source'), true);
});

test('circuit breaker onSuccess/onFailure tidak melempar tanpa Redis env', async () => {
  await assert.doesNotReject(cb.onSuccess('test-source'));
  await assert.doesNotReject(cb.onFailure('test-source'));
});
