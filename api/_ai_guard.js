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
  groq:            500,   // free tier: 1k–14.4k req/day per model
  // SambaNova pakai 2 akun terpisah (kunci API beda, kuota real masing-masing
  // sendiri) — counter kuota HARUS dipisah juga, senada dengan circuit breaker
  // yang sudah dipisah sejak session 125 (ai:sambanova:main vs ai:sambanova:c1).
  // Sebelum ini keduanya berbagi satu counter 'sambanova', jadi Call 1 (akun 2)
  // yang sering di-klik ulang bisa menghabiskan kuota gabungan lebih dulu dan
  // membuat ohlcv_analyze (akun 1) ikut ditolak "budget exceeded" padahal
  // akun 1-nya sendiri belum tentu penuh.
  sambanova_main:  200,   // akun 1 — Call 2/3/4 (market-digest) + ohlcv_analyze (admin.js)
  // akun 2 — Call 1 prose (market-digest) + fallback1 journal_analysis + fallback1
  // fundamental_analysis (session 145, re-arsitektur Nemotron). 3 fitur berbagi counter
  // ini SENGAJA (lihat daun_merah.md Session 145) — semuanya cuma fallback jarang
  // terpanggil, bukan primary aktif, jadi risiko starvation (lihat Session 144 lanjutan 4)
  // jauh lebih kecil daripada saat sambanova_main/sambanova_c1 dulu digabung.
  sambanova_c1:    200,
  // Free tier OpenRouter itu ACCOUNT-WIDE (bukan per-model): 50/hari kalau akun belum
  // pernah top-up kredit $10+, atau 1000/hari kalau sudah (persisten walau saldo habis
  // lagi) — dikonfirmasi dari openrouter.ai/docs, session 145. Nemotron 3 Ultra
  // (market-digest Call1/2/3) SEKARANG jadi satu-satunya fitur yang pakai pool ini —
  // gpt-oss:120b (journal/fundamental) dipindah ke Cerebras (pool token/hari terpisah)
  // supaya tidak berebut kuota dengan Nemotron. 45 = buffer aman di bawah 50 asli untuk
  // asumsi konservatif belum top-up; kalau sudah top-up $10+, override via env
  // AI_DAILY_LIMIT_OPENROUTER (mis. 900) — jangan naikkan default ini tanpa konfirmasi status akun.
  openrouter:      45,
  // Cerebras Cloud — free tier genuinely persistent (bukan trial sekali pakai), cap asli
  // 1 JUTA token/hari + 5 RPM/30K TPM (bukan request-count seperti provider lain). Dipakai
  // mulai session 145 sebagai primary gpt-oss:120b untuk journal_analysis +
  // fundamental_analysis (model id `gpt-oss-120b`, endpoint api.cerebras.ai/v1/chat/completions,
  // OpenAI-compatible). 200 di sini konservatif dari sisi REQUEST count kita (bukan token,
  // yang capnya jauh lebih longgar) — cukup untuk 2 fitur on-demand + cache 6h/1h.
  cerebras:        200,
  ollama:          150,   // Ollama Cloud free tier: GPU-time based (bukan RPM/token), belum ada data pasti — konservatif
  // Plan N (session 182) — diagnostik ?test_gemini=1/?test_mistral=1/?test_nvidia=1,
  // BUKAN chain produksi. Limit konservatif di bawah kuota resmi riset (daun_merah_riset.md):
  // Gemini Flash free tier 250-1.500 RPD per PROJECT (bukan per key) — 200 aman untuk
  // dites manual tanpa mepet limit asli Google. Mistral ±1M token/bulan (jauh lebih
  // longgar per-request) tetap dikonservatifkan sama dengan provider lain. NVIDIA 40 RPM
  // baseline — 200/hari jauh di bawah itu (dites manual, bukan burst).
  gemini:          200,
  mistral:         200,
  nvidia:          200,
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
