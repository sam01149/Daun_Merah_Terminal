// api/_redis.js — Resolusi akun Redis Upstash terpadu (Akun 1 vs Akun 2)

let originalUrl1 = null;
let originalToken1 = null;

function resolveRedisCredentials() {
  const url1 = originalUrl1 || process.env.UPSTASH_REDIS_REST_URL;
  const token1 = originalToken1 || process.env.UPSTASH_REDIS_REST_TOKEN;
  const url2 = process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH2_REDIS_REST_URL;
  const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH2_REDIS_REST_TOKEN;

  // Saat pemulihan, akun 2 adalah sumber aktif. Jangan diam-diam kembali ke
  // akun 1 jika kredensial akun 2 tidak lengkap: itu dapat memecah data.
  const active = (process.env.REDIS_ACTIVE_ACCOUNT || '2').trim();
  if (active === '1') return { url: url1 || null, token: token1 || null, account: 1 };
  return { url: url2 || null, token: token2 || null, account: 2 };

}

function syncActiveRedisEnv() {
  if (!originalUrl1 && process.env.UPSTASH_REDIS_REST_URL) {
    originalUrl1 = process.env.UPSTASH_REDIS_REST_URL;
    originalToken1 = process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  const active = resolveRedisCredentials();
  // Kosongkan pasangan aktif bila tidak lengkap; jangan tinggalkan URL akun 1.
  process.env.UPSTASH_REDIS_REST_URL = active.url && active.token ? active.url : '';
  process.env.UPSTASH_REDIS_REST_TOKEN = active.url && active.token ? active.token : '';
  return active;
}

syncActiveRedisEnv();

module.exports = {
  resolveRedisCredentials,
  syncActiveRedisEnv,
  _resetOriginals: () => { originalUrl1 = null; originalToken1 = null; }
};
