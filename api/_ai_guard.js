// api/_ai_guard.js
// Runtime guard kuota harian per provider AI (SambaNova/Gemini/DeepSeek dkk).
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
//   if (!await allowAiCall('sambanova_main')) throw new Error('AI_BUDGET_EXCEEDED');

// Limit harian per provider — di bawah kuota resmi free-tier supaya ada headroom
// untuk retry/fallback. Override per provider via env AI_DAILY_LIMIT_{PROVIDER}.
const DEFAULT_LIMITS = {
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
  // Plan N (session 182) — diagnostik ?test_gemini=1/?test_mistral=1/?test_nvidia=1,
  // BUKAN chain produksi. Limit konservatif di bawah kuota resmi riset (daun_merah_riset.md):
  // Gemini Flash free tier 250-1.500 RPD per PROJECT (bukan per key) — 200 aman untuk
  // dites manual tanpa mepet limit asli Google. Mistral ±1M token/bulan (jauh lebih
  // longgar per-request) tetap dikonservatifkan sama dengan provider lain. NVIDIA 40 RPM
  // baseline — 200/hari jauh di bawah itu (dites manual, bukan burst).
  gemini:          200,
  mistral:         200,
  nvidia:          200,
  // DeepSeek API resmi (platform.deepseek.com) — BERBAYAR dari saldo top-up user
  // (bukan free tier seperti provider lain di file ini). Limit harian di sini justru
  // pagar biaya: 50 request/hari ≈ maksimal ~US$0.25/hari pada profil prompt Call 1
  // (±13K token input, US$0.14/M cache-miss + output US$0.28/M) — saldo $2 tidak
  // mungkin terkuras diam-diam oleh loop/abuse dalam sehari. Naikkan via env
  // AI_DAILY_LIMIT_DEEPSEEK kalau nanti dipromosikan primary.
  deepseek:        50,

  // Counter ':experimental' (audit S218, 2026-07-22/23) — Plan V-3 sudah memisahkan
  // CIRCUIT BREAKER call isAutoCall/test_deepseek=1 (`ai:deepseek:experimental` dkk)
  // supaya kegagalan eksperimen developer-only tidak mentrip breaker fitur publik,
  // TAPI counter KUOTA HARIAN-nya sempat lupa dipisah — auto-entry & manual masih
  // rebutan pool yang sama. Ditemukan setelah Golden Trio (S217) menaikkan volume
  // auto-entry+uji konsistensi jadi sampai 9 call/hari, ~18% dari pagar deepseek 50/hari
  // BERBAYAR yang sama dipakai Ringkasan/Analisa/Pre-Entry Check publik. Limit di bawah
  // sengaja MASIH KETAT (bukan disamakan produksi) — prinsipnya tetap "pagar biaya kecil
  // per jalur", bukan menggandakan total anggaran; sesuaikan naik kalau AUTO_ENTRY_PAIRS
  // diperluas lagi dan sering kena limit (cek via getUsage('deepseek_experimental')).
  deepseek_experimental:        15,
  sambanova_main_experimental:  30,
  sambanova_c1_experimental:    30,

  // Translate headline NEWS ke Bahasa Indonesia (S272, 2026-08-02; diganti dari Gemini
  // ke SambaNova akun 2 sesi sama hari itu, permintaan user — lebih cepat) — pool
  // TERPISAH dari 'sambanova_c1' (200/hari) di atas SENGAJA, supaya volume translate
  // (bisa ratusan/hari) tidak rebutan kuota sama fallback1 journal_analysis/
  // fundamental_analysis/primary Call 1 digest yang berbagi akun SambaNova yang sama.
  // Limit resmi provider "free persisten" tanpa RPD tertulis (~10-20 RPM, lihat
  // daun_merah_ai.md §4) — 1000/hari tetap konservatif di bawah itu (1000/1440 menit
  // ≈ <1 req/menit rata-rata), headroom besar untuk burst breaking news.
  sambanova_c1_newstranslate: 1000,
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
  if (url.includes('sambanova.ai'))   return 'sambanova';
  if (url.includes('deepseek.com'))   return 'deepseek';
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
