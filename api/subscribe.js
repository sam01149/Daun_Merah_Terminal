// api/subscribe.js
const crypto      = require('crypto');
const rateLimit   = require('./_ratelimit');
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Harus cocok dengan output detectPushCat() di admin.js
const VALID_CATEGORIES = new Set(['market-moving', 'forex', 'energy', 'macro', 'geopolitical', 'econ-data', 'news']);

// Sama seperti DEVICE_ID_RE di api/journal.js — device_id dipakai untuk link
// subscription ke thesis_alerts:{device_id} (lihat market-digest.js).
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Push subscription payload dari browser: endpoint https + kunci enkripsi wajib ada.
// Batasi ukuran agar hash push_subs di Redis tidak bisa dibanjiri data sampah.
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || sub.endpoint.length > 1024) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  if (sub.keys.p256dh.length > 256 || sub.keys.auth.length > 64) return false;
  return true;
}

// Full SHA-256 hex of endpoint URL — no truncation, no collision risk
function subKey(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  return (await res.json()).result;
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis not configured' });

  if (await rateLimit(req, res, { limit: 10, windowSecs: 60, endpoint: 'subscribe' })) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (req.method === 'DELETE') {
      const { endpoint } = body;
      if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1024) {
        return res.status(400).json({ error: 'Missing endpoint' });
      }
      await redisCmd('HDEL', 'push_subs', subKey(endpoint));
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST') {
      const { subscription, categories, device_id } = body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: 'Invalid subscription' });
      // A2.3 Fase 2: store per-user category preferences alongside the subscription
      // Default: market-moving + econ-data (same as Fase 1 global PUSH_CATS)
      const cleanCats = Array.isArray(categories)
        ? categories.filter(c => VALID_CATEGORIES.has(c)).slice(0, VALID_CATEGORIES.size)
        : [];
      // device_id (optional) links this subscription to a journal device so the
      // market-digest cron can push a targeted "Thesis Alert" notification —
      // see market-digest.js thesis-monitor-per-device block.
      const deviceId = typeof device_id === 'string' && DEVICE_ID_RE.test(device_id) ? device_id : null;
      const subData = {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        categories: cleanCats.length > 0 ? cleanCats : ['market-moving', 'econ-data'],
        device_id: deviceId,
      };
      await redisCmd('HSET', 'push_subs', subKey(subscription.endpoint), JSON.stringify(subData));
      return res.status(201).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
