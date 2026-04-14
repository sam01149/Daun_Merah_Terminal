// Upstash Redis REST API — no SDK needed, pure fetch
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  const res = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  return data.result;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      },
      body: '',
    };
  }

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (!REDIS_URL || !REDIS_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    if (event.httpMethod === 'DELETE') {
      const { endpoint } = body;
      if (!endpoint) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing endpoint' }) };
      const key = Buffer.from(endpoint).toString('base64').slice(0, 80);
      await redisCmd('HDEL', 'push_subs', key);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST') {
      const { subscription } = body;
      if (!subscription?.endpoint) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid subscription' }) };
      const key = Buffer.from(subscription.endpoint).toString('base64').slice(0, 80);
      await redisCmd('HSET', 'push_subs', key, JSON.stringify(subscription));
      return { statusCode: 201, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    console.error('Subscribe error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
