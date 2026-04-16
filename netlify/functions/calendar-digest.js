// netlify/functions/calendar-digest.js
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const GEMINI_MODEL = 'gemini-2.0-flash';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

exports.handler = async function(event, context) {
  const params = event.queryStringParameters || {};
  const currencies = (params.currencies || 'USD,EUR,GBP,JPY,CAD,AUD,NZD,CHF')
    .split(',').map(s => s.trim().toUpperCase()).filter(c => MAJOR_CURRENCIES.has(c));

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'GEMINI_API_KEY not set' }),
    };
  }

  // 1. Fetch calendar directly from FF feed
  let calEvents = [];
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(FF_NEXT_WEEK, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }

    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 4; i++) {
      dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    }

    calEvents = allEvents.filter(e =>
      dateRange.has(e.date) &&
      e.impact === 'High' &&
      currencies.includes(e.currency)
    );
  } catch(e) {
    console.warn('FF fetch failed in calendar-digest:', e.message);
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
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      relevantHeadlines = allItems
        .filter(i => new Date(i.pubDate).getTime() > cutoff)
        .filter(i => isRelevantToCurrencies(i.title, currencies))
        .slice(0, 25)
        .map(i => i.title);
    }
  } catch(e) {
    console.warn('RSS fetch failed in calendar-digest:', e.message);
  }

  // 3. Build prompt
  const wibNow = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

  const calSection = calEvents.length > 0
    ? calEvents.map(e => `- ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n')
    : '(Tidak ada event high-impact terdeteksi dalam 4 hari ke depan)';

  const newsSection = relevantHeadlines.length > 0
    ? relevantHeadlines.map((h, i) => `${i+1}. ${h}`).join('\n')
    : '(Tidak ada headline relevan dalam 12 jam terakhir)';

  const prompt = `Kamu adalah analis pasar keuangan senior yang membantu trader forex Indonesia dengan gaya trading macro discretionary.

TANGGAL DAN WAKTU SAAT INI: ${dateStr}, ${timeStr}
CURRENCY YANG DIPANTAU: ${currencies.join(', ')}

=== EVENT KALENDER EKONOMI HIGH-IMPACT ===
${calSection}

=== HEADLINE BERITA TERKINI (relevan untuk currency di atas) ===
${newsSection}

TUGAS:
Tulis analisis dalam DUA bagian:

KONTEKS PASAR: (satu paragraf) Jelaskan kondisi pasar terkini untuk currency yang dipantau berdasarkan berita yang ada. Sentimen dominan dan narrative macro yang sedang terbentuk.

REKOMENDASI EVENT: Untuk setiap event kalender, tulis satu baris dengan format:
[WAKTU WIB] [CURRENCY] [NAMA EVENT] → [REKOMENDASI] + alasan singkat 1 kalimat

REKOMENDASI hanya boleh salah satu dari:
- "Hindari entry 30 menit sebelum dan sesudah rilis" (untuk event dengan potensi whipsaw tinggi)
- "Aware — potensi volatilitas tinggi" (untuk event yang searah dengan bias macro)
- "Tidak material untuk bias macro saat ini" (untuk event yang unlikely mengubah arah)

FORMAT: Tidak ada bullet berlebihan, tidak ada heading lain, tidak ada emoji. Kalimat aktif. Seluruh output Bahasa Indonesia.

Balas hanya dengan kedua bagian tersebut.`;

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

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function parseFFXML(xml) {
  const events = [];
  const eventRe = /<event>([\s\S]*?)<\/event>/g;
  let m;
  while ((m = eventRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      if (!r) return '';
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    const title   = get('title');
    const country = get('country').toUpperCase();
    const date    = get('date');
    const time    = get('time');
    const impact  = get('impact');
    if (!title || !country) continue;
    const dp = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dp) continue;
    events.push({
      date: `${dp[3]}-${dp[1]}-${dp[2]}`,
      time_wib: convertToWIB(time),
      currency: country,
      event: title,
      impact,
    });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') return 'Tentative';
  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return timeStr;
  let hour = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const nowMonth = new Date().getUTCMonth() + 1;
  const isDST = nowMonth >= 3 && nowMonth <= 10;
  const wibHour = (hour + (isDST ? 11 : 12)) % 24;
  return `${String(wibHour).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
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
    const title   = get('title').replace(/^FinancialJuice:\s*/i, '').trim();
    const guid    = get('guid');
    const pubDate = get('pubDate');
    if (guid && title) items.push({ title, guid, pubDate });
  }
  return items;
}

function isRelevantToCurrencies(title, currencies) {
  const t = title.toLowerCase();
  const CUR_KEYWORDS = {
    USD: ['dollar','usd','fed ','fomc','powell','federal reserve','nfp','cpi','us ','united states','treasury','dxy'],
    EUR: ['euro','eur','ecb','lagarde','eurozone','euro zone','germany','german','france','french'],
    GBP: ['pound','gbp','sterling','cable','boe','bank of england','bailey','uk ','britain','british'],
    JPY: ['yen','jpy','boj','bank of japan','ueda','japan','japanese'],
    CAD: ['canadian','cad','loonie','boc','bank of canada','canada'],
    AUD: ['aussie','aud','rba','reserve bank of australia','australia','australian'],
    NZD: ['kiwi','nzd','rbnz','new zealand'],
    CHF: ['franc','chf','snb','swiss','switzerland'],
  };
  return currencies.some(cur => {
    const kws = CUR_KEYWORDS[cur] || [cur.toLowerCase()];
    return kws.some(kw => t.includes(kw));
  });
}
