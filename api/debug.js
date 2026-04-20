// api/debug.js — TEMPORARY, hapus setelah masalah resolved
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // Test 1: env vars
  results.env = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET (len=' + process.env.GEMINI_API_KEY.length + ')' : 'NOT SET',
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? 'SET' : 'NOT SET',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET',
  };

  // Test 2: RSS fetch
  const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html)', 'Referer': 'https://www.financialjuice.com/' },
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    results.rss = {
      status: r.status,
      ok: r.ok,
      is_rss: text.includes('<rss'),
      length: text.length,
      preview: text.substring(0, 200),
    };
  } catch(e) {
    results.rss = { error: e.message };
  }

  // Test 3: Gemini ping
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (GEMINI_KEY) {
    try {
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Balas hanya dengan kata: OK' }] }], generationConfig: { maxOutputTokens: 10 } }),
          signal: AbortSignal.timeout(15000),
        }
      );
      const gd = await gemRes.json();
      results.gemini = {
        status: gemRes.status,
        ok: gemRes.ok,
        response: gd?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(gd).substring(0, 200),
      };
    } catch(e) {
      results.gemini = { error: e.message };
    }
  } else {
    results.gemini = { error: 'GEMINI_API_KEY not set' };
  }

  return res.status(200).json(results);
};
