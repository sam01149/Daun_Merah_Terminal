// api/sizing-history.js
// Saves/retrieves last 10 position sizing calculations per device.
// Redis: sorted set 'sizing_history:{device_id}', score = timestamp, member = JSON string.

const rateLimit = require('./_ratelimit');

// device_id dipakai langsung sebagai bagian key Redis — batasi charset & panjang
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ENTRY_BYTES = 2048;

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()).result;
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const deviceId = req.query.device_id;
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return res.status(400).json({ error: 'device_id required' });

  if (await rateLimit(req, res, { limit: 30, windowSecs: 60, endpoint: 'sizing-history' })) return;

  const key = `sizing_history:${deviceId}`;

  if (req.method === 'POST') {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    if (Buffer.byteLength(body, 'utf8') > MAX_ENTRY_BYTES) {
      return res.status(413).json({ error: 'Entry too large' });
    }
    let entry;
    try { entry = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return res.status(400).json({ error: 'Invalid entry' });
    }
    entry.timestamp = Date.now();
    try {
      await redisCmd('ZADD', key, entry.timestamp, JSON.stringify(entry));
      await redisCmd('ZREMRANGEBYRANK', key, 0, -11); // keep last 10
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('sizing-history POST failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const items = await redisCmd('ZRANGE', key, 0, -1, 'WITHSCORES') || [];
      const entries = [];
      for (let i = 0; i < items.length; i += 2) {
        try { entries.push(JSON.parse(items[i])); } catch(e) {}
      }
      return res.status(200).json({ entries: entries.reverse() }); // newest first
    } catch(e) {
      console.error('sizing-history GET failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // DELETE ?timestamp=... removes one entry (matched by score, set at POST time).
  // DELETE ?all=1 clears the whole history for this device.
  if (req.method === 'DELETE') {
    try {
      if (req.query.all === '1') {
        await redisCmd('DEL', key);
        return res.status(200).json({ ok: true, cleared: true });
      }
      const ts = req.query.timestamp;
      if (!ts) return res.status(400).json({ error: 'timestamp or all=1 required' });
      await redisCmd('ZREMRANGEBYSCORE', key, ts, ts);
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('sizing-history DELETE failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
