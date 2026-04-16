// netlify/functions/calendar-digest.js
// Synthesizes economic calendar events + relevant FJ headlines
// into actionable avoidance/awareness recommendations for forex trader

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const GEMINI_MODEL = 'gemini-2.0-flash';

exports.handler = async function(event, context) {
  const params = event.queryStringParameters || {};
  const currencies = (params.currencies || 'USD,EUR,GBP,JPY,CAD,AUD,NZD,CHF').split(',').map(s => s.trim().toUpperCase());

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'GEMINI_API_KEY not set' }),
    };
  }

  // 1. Fetch calendar events (reuse same Investing.com endpoint)
  let calEvents = [];
  try {
    const calRes = await fetch(
      `${getBaseUrl(event)}/.netlify/functions/calendar`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (calRes.ok) {
      const calData = await calRes.json();
      calEvents = (calData.events || []).filter(e => currencies.includes(e.currency));
    }
  } catch(e) {
    console.warn('Calendar fetch for digest failed:', e.message);
  }

  // 2. Fetch FJ RSS, filter relevant headlines
  let relevantHeadlines = [];
  try {
    const rssRes = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (rssRes.ok) {
      const xml = await rssRes.text();
      const allItems = parseRSS(xml);
      const cutoff = Date.now() - 12 * 60 * 60 * 1000; // last 12 hours
      const recent = allItems.filter(i => new Date(i.pubDate).getTime() > cutoff).slice(0, 100);

      // Filter headlines relevant to the currencies in question
      relevantHeadlines = recent
        .filter(i => isRelevantToCurrencies(i.title, currencies))
        .slice(0, 25)
        .map(i => i.title);
    }
  } catch(e) {
    console.warn('RSS fetch for digest failed:', e.message);
  }

  // 3. Build prompt
  const today = new Date();
  const wibNow = new Date(today.getTime() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

  const calSection = calEvents.length > 0
    ? calEvents.map(e => `- ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n')
    : '(Tidak ada event high-impact terdeteksi hari ini)';

  const newsSection = relevantHeadlines.length > 0
    ? relevantHeadlines.map((h, i) => `${i+1}. ${h}`).join('\n')
    : '(Tidak ada headline relevan dalam 12 jam terakhir)';

  const prompt = `Kamu adalah analis pasar keuangan senior yang membantu trader forex Indonesia dengan gaya trading macro discretionary.

TANGGAL DAN WAKTU SAAT INI: ${dateStr}, ${timeStr}

CURRENCY YANG DIPANTAU: ${currencies.join(', ')}

=== EVENT KALENDER EKONOMI HIGH-IMPACT HARI INI ===
${calSection}

=== HEADLINE BERITA TERKINI (relevan untuk currency di atas) ===
${newsSection}

TUGAS:
Berdasarkan kedua sumber informasi di atas, tulis analisis dalam DUA bagian:

Bagian 1 — KONTEKS PASAR SAAT INI:
Satu paragraf. Jelaskan kondisi pasar terkini untuk currency yang dipantau berdasarkan berita yang ada. Apa sentimen dominan? Apakah ada narrative macro yang sedang terbentuk?

Bagian 2 — REKOMENDASI TINDAKAN PER EVENT:
Untuk setiap event kalender yang ada, tulis satu baris rekomendasi dengan format:
[WAKTU WIB] [CURRENCY] [NAMA EVENT] → [REKOMENDASI: "Hindari entry 30 menit sebelum-sesudah rilis" ATAU "Aware — potensi volatilitas [tinggi/sedang]" ATAU "Tidak material untuk bias macro saat ini"] + [alasan singkat 1 kalimat]

FORMAT WAJIB:
- Bagian 1 diberi label "KONTEKS PASAR:" di awal paragraf
- Bagian 2 diberi label "REKOMENDASI EVENT:" diikuti daftar per event
- Tidak ada bullet list berlebihan, tidak ada heading lain, tidak ada emoji
- Kalimat aktif, langsung ke poin
- Seluruh output dalam Bahasa Indonesia

Balas hanya dengan kedua bagian tersebut, tidak ada teks lain.`;

  try {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
        }),
        signal: AbortSignal.timeout(25000),
      }
    );

    if (!gemRes.ok) throw new Error('Gemini HTTP ' + gemRes.status);

    const gemData = await gemRes.json();
    const analysis = gemData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        analysis,
        cal_events: calEvents.length,
        headlines_used: relevantHeadlines.length,
        generated_at: new Date().toISOString(),
      }),
    };

  } catch(e) {
    console.error('Gemini calendar digest failed:', e.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function getBaseUrl(event) {
  // Reconstruct base URL from Netlify event headers
  const host = event.headers?.host || 'localhost:8888';
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = (tag) => {
      const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
      const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
      return (r1 || r2)?.[1]?.trim() || '';
    };
    const title = get('title').replace(/^FinancialJuice:\s*/i, '').trim();
    const guid  = get('guid');
    const pubDate = get('pubDate');
    if (guid && title) items.push({ title, guid, pubDate });
  }
  return items;
}

function isRelevantToCurrencies(title, currencies) {
  const t = title.toLowerCase();

  const CUR_KEYWORDS = {
    USD: ['dollar','usd','fed ','fomc','powell','federal reserve','nfp','cpi','us ','united states','wall street','treasury','dxy'],
    EUR: ['euro','eur','ecb','lagarde','eurozone','euro zone','euro area','germany','german','france','french','italy','italian','spain','spanish'],
    GBP: ['pound','gbp','sterling','cable','boe','bank of england','bailey','uk ','united kingdom','britain','british'],
    JPY: ['yen','jpy','boj','bank of japan','ueda','japan','japanese'],
    CAD: ['canadian','cad','loonie','boc','bank of canada','canada','canadian dollar'],
    AUD: ['aussie','aud','rba','reserve bank of australia','australia','australian'],
    NZD: ['kiwi','nzd','rbnz','new zealand','nz '],
    CHF: ['franc','chf','snb','swiss','switzerland','swissy'],
  };

  return currencies.some(cur => {
    const kws = CUR_KEYWORDS[cur] || [cur.toLowerCase()];
    return kws.some(kw => t.includes(kw));
  });
}
