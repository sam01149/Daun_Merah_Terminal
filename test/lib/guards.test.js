// test/guards.test.js
// Unit test guard modules: _ai_guard, _ratelimit, _circuit_breaker.
// Semua harus FAIL-OPEN saat Redis tidak dikonfigurasi (tidak ada env) —
// test ini juga memastikan tidak ada network call yang menggantung.
const { test } = require('node:test');
const assert = require('node:assert');

// Pastikan Redis dianggap tidak terkonfigurasi di seluruh suite ini
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { allowAiCall, providerFromUrl, DEFAULT_LIMITS } = require('../../api/_ai_guard');
const rateLimit = require('../../api/_ratelimit');
const cb = require('../../api/_circuit_breaker');

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

// Regression: 2 akun SambaNova (kunci API beda, kuota real terpisah) sempat berbagi
// satu counter budget 'sambanova' — Call 1 (akun 2, Ringkasan) yang sering di-generate
// ulang bisa menghabiskan kuota gabungan lebih dulu dan bikin ohlcv_analyze (akun 1,
// Analisa) ikut diblokir "budget exceeded" walau akun 1-nya sendiri masih longgar,
// lalu jatuh ke fallback Groq llama-3.3 (dianggap kualitasnya kurang oleh user).
// Fix: pisah jadi 'sambanova_main' (akun 1) dan 'sambanova_c1' (akun 2), senada
// dengan circuit breaker yang sudah dipisah sejak session 125.
test('DEFAULT_LIMITS: 2 akun SambaNova punya counter budget terpisah', () => {
  assert.strictEqual(DEFAULT_LIMITS.sambanova_main, 200);
  assert.strictEqual(DEFAULT_LIMITS.sambanova_c1, 200);
  assert.strictEqual(DEFAULT_LIMITS.sambanova, undefined, 'counter gabungan lama harus sudah tidak dipakai');
});

test('allowAiCall: sambanova_main dan sambanova_c1 masing-masing fail-open tanpa Redis', async () => {
  assert.strictEqual(await allowAiCall('sambanova_main'), true);
  assert.strictEqual(await allowAiCall('sambanova_c1'), true);
});

// Regression session 145 (re-arsitektur Nemotron): OpenRouter limit gratis itu
// ACCOUNT-WIDE (bukan per-model) — 50/hari kalau belum top-up kredit $10+, 1000/hari
// kalau sudah (dikonfirmasi openrouter.ai/docs). Nemotron 3 Ultra (market-digest.js)
// sekarang satu-satunya fitur yang pakai pool ini (gpt-oss:120b journal/fundamental
// dipindah ke Cerebras) — default 45 adalah buffer aman DI BAWAH 50 asli untuk asumsi
// konservatif belum top-up. JANGAN naikkan default ini tanpa konfirmasi status akun
// (lihat daun_merah.md Session 145) — kalau dinaikkan tanpa verifikasi, guard kita
// jadi tidak merepresentasikan limit nyata OpenRouter (persis masalah yang mau dicegah).
test('DEFAULT_LIMITS: openrouter konservatif (<=45) — jangan overestimate cap 50/hari asli', () => {
  assert.ok(DEFAULT_LIMITS.openrouter <= 45, `openrouter limit (${DEFAULT_LIMITS.openrouter}) harus <=45, buffer aman di bawah cap gratis asli 50/hari`);
});

// Cerebras diaktifkan session 145 sebagai primary gpt-oss-120b untuk journal_analysis +
// fundamental_analysis — pool token/hari terpisah total dari OpenRouter (Nemotron).
test('DEFAULT_LIMITS: cerebras tetap ada (dipakai journal_analysis + fundamental_analysis sejak session 145)', () => {
  assert.strictEqual(typeof DEFAULT_LIMITS.cerebras, 'number');
  assert.ok(DEFAULT_LIMITS.cerebras > 0);
});

test('allowAiCall: cerebras fail-open tanpa Redis', async () => {
  assert.strictEqual(await allowAiCall('cerebras'), true);
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

// ── admin.js _pickExpiryLevels (option expiry → ohlcv_analyze, sesi 138) ─────

const { _pickExpiryLevels } = require('../../api/admin.js');

test('_pickExpiryLevels: filter pair, buang non-numeric, urut terdekat ke harga, cap 6', () => {
  const expiries = [
    { pair: 'EUR/USD', level: '1.0850', size: 'EU1.2b' },
    { pair: 'EUR/USD', level: '1.0900', size: '' },
    { pair: 'EUR/USD', level: '1.0700', size: '500m' },
    { pair: 'GBP/USD', level: '1.2700', size: '' },
    { pair: 'EUR/USD', level: 'abc',    size: '' },
  ];
  const r = _pickExpiryLevels(expiries, 'EUR/USD', 1.0855);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].level, '1.0850'); // terdekat ke 1.0855
  assert.strictEqual(r[1].level, '1.0900');
  assert.strictEqual(r[2].level, '1.0700');
});

test('_pickExpiryLevels: label tanpa slash match, null-safe, cap 6', () => {
  assert.deepStrictEqual(_pickExpiryLevels(null, 'EUR/USD', 1), []);
  assert.deepStrictEqual(_pickExpiryLevels([], null, 1), []);
  const many = Array.from({ length: 10 }, (_, i) => ({ pair: 'EUR/USD', level: (1.05 + i * 0.01).toFixed(4), size: '' }));
  assert.strictEqual(_pickExpiryLevels(many, 'EURUSD', 1.05).length, 6);
});
