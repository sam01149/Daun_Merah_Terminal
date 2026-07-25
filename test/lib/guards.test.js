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

test('providerFromUrl mengenali provider yang masih aktif', () => {
  assert.strictEqual(providerFromUrl('https://api.sambanova.ai/v1/chat/completions'), 'sambanova');
  assert.strictEqual(providerFromUrl('https://api.deepseek.com/chat/completions'), 'deepseek');
  assert.strictEqual(providerFromUrl('https://example.com/v1'), null);
  assert.strictEqual(providerFromUrl(null), null);
});

test('allowAiCall fail-open tanpa Redis env', async () => {
  assert.strictEqual(await allowAiCall('sambanova_main'), true);
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

// OpenRouter/Cerebras/Groq/Ollama diputus kontraknya 2026-07-25 — counter budget-nya
// dihapus dari DEFAULT_LIMITS bersamaan dengan kode yang memanggilnya.
test('DEFAULT_LIMITS: openrouter/cerebras/groq/ollama sudah tidak ada (vendor diputus)', () => {
  assert.strictEqual(DEFAULT_LIMITS.openrouter, undefined);
  assert.strictEqual(DEFAULT_LIMITS.cerebras, undefined);
  assert.strictEqual(DEFAULT_LIMITS.groq, undefined);
  assert.strictEqual(DEFAULT_LIMITS.ollama, undefined);
});

// Regression (audit S218, 2026-07-22/23): circuit breaker call isAutoCall/test_deepseek=1
// sudah dipisah dari produksi sejak Plan V-3 ('ai:deepseek:experimental' dkk), TAPI
// counter KUOTA HARIAN sempat lupa ikut dipisah — auto-entry & manual publik rebutan
// pool deepseek 50/hari BERBAYAR yang sama. Golden Trio (S217) menaikkan volume
// eksperimen sampai 9 call/hari, cukup untuk menggerus pagar biaya publik diam-diam.
// Fix: counter khusus 'deepseek_experimental'/'sambanova_main_experimental'/
// 'sambanova_c1_experimental', senada pola isolasi ':experimental' circuit breaker.
test('DEFAULT_LIMITS: counter kuota harian eksperimen (auto-entry) terpisah dari produksi', () => {
  assert.strictEqual(typeof DEFAULT_LIMITS.deepseek_experimental, 'number');
  assert.ok(DEFAULT_LIMITS.deepseek_experimental > 0);
  assert.ok(DEFAULT_LIMITS.deepseek_experimental < DEFAULT_LIMITS.deepseek,
    'pagar eksperimen harus tetap lebih ketat dari produksi, bukan menggandakan anggaran');
  assert.strictEqual(typeof DEFAULT_LIMITS.sambanova_main_experimental, 'number');
  assert.strictEqual(typeof DEFAULT_LIMITS.sambanova_c1_experimental, 'number');
});

test('allowAiCall: counter experimental fail-open tanpa Redis (independen dari counter produksi)', async () => {
  assert.strictEqual(await allowAiCall('deepseek_experimental'), true);
  assert.strictEqual(await allowAiCall('sambanova_main_experimental'), true);
  assert.strictEqual(await allowAiCall('sambanova_c1_experimental'), true);
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
