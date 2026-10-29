// api/_redis.js — Resolusi akun Redis Upstash terpadu (Akun 1 vs Akun 2)

let originalUrl1 = null;
let originalToken1 = null;

function resolveRedisCredentials() {
  const url1 = originalUrl1 || process.env.UPSTASH_REDIS_REST_URL;
  const token1 = originalToken1 || process.env.UPSTASH_REDIS_REST_TOKEN;
  const url2 = process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH2_REDIS_REST_URL;
  const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH2_REDIS_REST_TOKEN;

  const active = (process.env.REDIS_ACTIVE_ACCOUNT || '').trim();
  if (active === '1') {
    if (url1 && token1) return { url: url1, token: token1, account: 1 };
    if (url2 && token2) return { url: url2, token: token2, account: 2 };
  }
  if (active === '2') {
    if (url2 && token2) return { url: url2, token: token2, account: 2 };
    if (url1 && token1) return { url: url1, token: token1, account: 1 };
  }

  // Jika akun 2 diset lewat UPSTASH_REDIS_REST_URL_2, aktifkan akun 2
  if (process.env.UPSTASH_REDIS_REST_URL_2 && url2 && token2) {
    return { url: url2, token: token2, account: 2 };
  }

  if (url1 && token1) return { url: url1, token: token1, account: 1 };
  if (url2 && token2) return { url: url2, token: token2, account: 2 };
  return { url: url1 || null, token: token1 || null, account: 1 };
}

function syncActiveRedisEnv() {
  if (!originalUrl1 && process.env.UPSTASH_REDIS_REST_URL) {
    originalUrl1 = process.env.UPSTASH_REDIS_REST_URL;
    originalToken1 = process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  const active = resolveRedisCredentials();
  if (active && active.url && active.token) {
    process.env.UPSTASH_REDIS_REST_URL = active.url;
    process.env.UPSTASH_REDIS_REST_TOKEN = active.token;
  }
  return active;
}

syncActiveRedisEnv();

module.exports = {
  resolveRedisCredentials,
  syncActiveRedisEnv,
  _resetOriginals: () => { originalUrl1 = null; originalToken1 = null; }
};
