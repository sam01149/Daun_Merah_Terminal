const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRedisCredentials, syncActiveRedisEnv } = require('../../api/_redis.js');

test('api/_redis: resolveRedisCredentials dan syncActiveRedisEnv', () => {
  const origUrl = process.env.UPSTASH_REDIS_REST_URL;
  const origTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const origUrl2 = process.env.UPSTASH_REDIS_REST_URL_2;
  const origTok2 = process.env.UPSTASH_REDIS_REST_TOKEN_2;
  const origAct = process.env.REDIS_ACTIVE_ACCOUNT;

  try {
    delete process.env.UPSTASH_REDIS_REST_URL_2;
    delete process.env.UPSTASH_REDIS_REST_TOKEN_2;
    delete process.env.UPSTASH2_REDIS_REST_URL;
    delete process.env.UPSTASH2_REDIS_REST_TOKEN;
    delete process.env.REDIS_ACTIVE_ACCOUNT;

    process.env.UPSTASH_REDIS_REST_URL = 'https://r1.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 't1';

    let creds = resolveRedisCredentials();
    assert.equal(creds.account, 1);
    assert.equal(creds.url, 'https://r1.test');

    // Switch saat UPSTASH_REDIS_REST_URL_2 di-set
    process.env.UPSTASH_REDIS_REST_URL_2 = 'https://r2.test';
    process.env.UPSTASH_REDIS_REST_TOKEN_2 = 't2';
    creds = resolveRedisCredentials();
    assert.equal(creds.account, 2);
    assert.equal(creds.url, 'https://r2.test');

    // Sinkronkan ke env
    syncActiveRedisEnv();
    assert.equal(process.env.UPSTASH_REDIS_REST_URL, 'https://r2.test');
    assert.equal(process.env.UPSTASH_REDIS_REST_TOKEN, 't2');

    // Explicit switch back ke akun 1
    process.env.REDIS_ACTIVE_ACCOUNT = '1';
    creds = resolveRedisCredentials();
    assert.equal(creds.account, 1);

    // Explicit switch ke akun 2
    process.env.REDIS_ACTIVE_ACCOUNT = '2';
    creds = resolveRedisCredentials();
    assert.equal(creds.account, 2);
  } finally {
    if (origUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = origUrl; else delete process.env.UPSTASH_REDIS_REST_URL;
    if (origTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = origTok; else delete process.env.UPSTASH_REDIS_REST_TOKEN;
    if (origUrl2 !== undefined) process.env.UPSTASH_REDIS_REST_URL_2 = origUrl2; else delete process.env.UPSTASH_REDIS_REST_URL_2;
    if (origTok2 !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN_2 = origTok2; else delete process.env.UPSTASH_REDIS_REST_TOKEN_2;
    if (origAct !== undefined) process.env.REDIS_ACTIVE_ACCOUNT = origAct; else delete process.env.REDIS_ACTIVE_ACCOUNT;
  }
});
