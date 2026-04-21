// api/fundamentals.js
// Returns fundamental snapshot from Redis (populated by push.js cron)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const raw = await redisCmd('GET', 'fundamental_snapshot');
    const snapshot = raw ? JSON.parse(raw) : {};
    return res.status(200).json({ snapshot, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('Fundamentals fetch failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}
