// api/_ai_guard.js
// Runtime guard kuota harian per provider AI (Groq/SambaNova/OpenRouter/Cerebras).
// Underscore prefix = Vercel does NOT expose this as a public route.
//
// Masalah yang dicegah: loop bug, abuse endpoint publik, atau cron ganda bisa
// menghabiskan kuota free-tier semua provider serentak → semua fitur AI mati
// sampai reset harian provider. Guard ini memutus di sisi kita lebih dulu.
//
// Redis key: ai_budget:{provider}:{YYYY-MM-DD} (INCR, TTL 48h)
// Fail-open: jika Redis tidak tersedia, panggilan tetap diizinkan.
//
// Usage:
//   const { allowAiCall } = require('./_ai_guard');
//   if (!await allowAiCall('groq')) throw new Error('AI_BUDGET_EXCEEDED');

// Limit harian per provider — di bawah kuota resmi free-tier supaya ada headroom
// untuk retry/fallback. Override per provider via env AI_DAILY_LIMIT_{PROVIDER}.
const DEFAULT_LIMITS = {
  groq:       500,   // free tier: 1k–14.4k req/day per model
  sambanova:  200,   // free tier: rate limit per menit, ~ratusan/hari wajar
  openrouter: 150,   // free tier: 50/day (model :free) — akun berbayar lebih tinggi
  cerebras:   200,
};

function dailyLimit(provider) {
  const env = process.env[`AI_DAILY_LIMIT_${provider.toUpperCase()}`];
  const n = env ? parseInt(env, 10) : NaN;
  if (!isNaN(n) && n > 0) return n;
  return DEFAULT_LIMITS[provider] || 200;
}

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(2500),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

// Provider dari URL endpoint — dipakai call site yang menerima URL dinamis.
function providerFromUrl(url) {
  if (!url) return null;
  if (url.includes('groq.com'))       return 'groq';
  if (url.includes('sambanova.ai'))   return 'sambanova';
  if (url.includes('openrouter.ai'))  return 'openrouter';
  if (url.includes('cerebras.ai'))    return 'cerebras';
  return null;
}

/**
 * Increment counter harian provider dan cek limit.
 * @returns {boolean} true = boleh panggil, false = kuota harian kita habis
 */
async function allowAiCall(provider) {
  if (!provider) return true; // provider tak dikenal → jangan blokir
  const day = new Date().toISOString().slice(0, 10);
  const key = `ai_budget:${provider}:${day}`;
  const count = await redisCmd('INCR', key);
  if (count === null) return true; // Redis down → fail open
  if (count === 1) redisCmd('EXPIRE', key, 172800); // fire-and-forget; redisCmd tidak pernah reject
  const limit = dailyLimit(provider);
  if (count > limit) {
    console.warn(`ai_guard: ${provider} daily budget exceeded (${count}/${limit}) — call blocked`);
    return false;
  }
  return true;
}

/** Baca pemakaian hari ini tanpa increment (untuk health/diagnostics). */
async function getUsage(provider) {
  const day = new Date().toISOString().slice(0, 10);
  const raw = await redisCmd('GET', `ai_budget:${provider}:${day}`);
  return { provider, used: raw ? parseInt(raw, 10) : 0, limit: dailyLimit(provider) };
}

module.exports = { allowAiCall, providerFromUrl, getUsage, DEFAULT_LIMITS };
