// api/_redis.js — Resolusi akun Redis Upstash terpadu (Akun 1 vs Akun 2)
// Mendukung:
//   Akun 1: UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN
//   Akun 2: UPSTASH_REDIS_REST_URL_2 & UPSTASH_REDIS_REST_TOKEN_2 (alias legacy UPSTASH2_*)
// Kontrol selektor:
//   REDIS_ACTIVE_ACCOUNT = '1' | '2'
// Jika user menambahkan UPSTASH_REDIS_REST_URL_2 (atau REDIS_ACTIVE_ACCOUNT='2'),
// akun 2 otomatis menjadi database aktif secara transparan.

function resolveRedisCredentials() {
  const url1 = process.env.UPSTASH_REDIS_REST_URL;
  const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
  const url2 = process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH2_REDIS_REST_URL;
  const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH2_REDIS_REST_TOKEN;

  const active = (process.env.REDIS_ACTIVE_ACCOUNT || '').trim();
  if (active === '2') {
    if (url2 && token2) return { url: url2, token: token2, account: 2 };
    if (url1 && token1) return { url: url1, token: token1, account: 1 };
  }
  if (active === '1') {
    if (url1 && token1) return { url: url1, token: token1, account: 1 };
    if (url2 && token2) return { url: url2, token: token2, account: 2 };
  }

  // Jika UPSTASH_REDIS_REST_URL_2 sengaja diset oleh user (sinyal switchover), gunakan akun 2
  if (process.env.UPSTASH_REDIS_REST_URL_2 && url2 && token2) {
    return { url: url2, token: token2, account: 2 };
  }

  if (url1 && token1) return { url: url1, token: token1, account: 1 };
  if (url2 && token2) return { url: url2, token: token2, account: 2 };
  return { url: url1 || null, token: token1 || null, account: 1 };
}

function syncActiveRedisEnv() {
  const active = resolveRedisCredentials();
  if (active && active.url && active.token) {
    process.env.UPSTASH_REDIS_REST_URL = active.url;
    process.env.UPSTASH_REDIS_REST_TOKEN = active.token;
  }
  return active;
}

// Sinkronkan saat file dimuat
syncActiveRedisEnv();

module.exports = {
  resolveRedisCredentials,
  syncActiveRedisEnv,
};
