// netlify/functions/unified-digest.js
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const GEMINI_MODEL = 'gemini-2.0-flash';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

exports.handler = async function(event, context) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  // ── 1. Fetch RSS ──────────────────────────────────────────────────────────
  let rssItems = [];
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const xml = await res.text();
      if (xml.includes('<rss')) rssItems = parseRSS(xml);
    }
  } catch(e) {
    console.warn('RSS fetch failed:', e.message);
  }

  // Filter to last 6 hours, max 80 items
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const recentItems = rssItems
    .filter(i => new Date(i.pubDate).getTime() > cutoff)
    .slice(0, 80);

  // ── 2. Fetch Calendar ─────────────────────────────────────────────────────
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

    // Today + next 3 days in WIB
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 3; i++) {
      dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    }

    // Deduplicate
    const seen = new Set();
    calEvents = allEvents
      .filter(e => dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => {
        const key = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.date + a.time_wib).localeCompare(b.date + b.time_wib));

  } catch(e) {
    console.warn('Calendar fetch failed:', e.message);
  }

  // ── 3. Build context strings ──────────────────────────────────────────────
  const headlinesBlock = recentItems.length > 0
    ? recentItems.map((i, idx) => `${idx + 1}. ${i.title}`).join('\n')
    : '(Tidak ada headline dalam 6 jam terakhir)';

  const calBlock = calEvents.length > 0
    ? calEvents.map(e => `- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n')
    : '(Tidak ada event high-impact dalam 3 hari ke depan)';

  const wibNow  = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

  // ── 4. Generate with Gemini ───────────────────────────────────────────────
  let article   = null;
  let method    = 'gemini';

  if (GEMINI_KEY && recentItems.length > 0) {
    const prompt = `Kamu adalah analis pasar keuangan senior yang menulis untuk trader forex Indonesia dengan gaya trading macro discretionary.

WAKTU SAAT INI: ${dateStr}, ${timeStr}

=== HEADLINE BERITA TERKINI (${recentItems.length} berita, 6 jam terakhir) ===
${headlinesBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

TUGAS:
Tulis analisis pasar dalam TIGA PARAGRAF terpisah dengan baris kosong di antara paragraf.

Paragraf 1 — KONDISI PASAR: Tema dominan dan berita paling signifikan dari headlines di atas. Apa yang sedang terjadi di pasar saat ini. Kalimat faktual, langsung.

Paragraf 2 — DAMPAK CURRENCY: Dampak terhadap pair utama yang terdampak (sebutkan pair spesifik seperti EUR/USD, USD/JPY, dll jika relevan). Jelaskan arah tekanan dan potensi pergerakan berdasarkan berita yang ada.

Paragraf 3 — KONTEKS KALENDER: Berdasarkan event high-impact yang akan datang, mana yang paling berpotensi menggerakkan pasar? Berikan konteks singkat apakah event tersebut mengkonfirmasi atau mengontradiksi kondisi pasar saat ini. Sertakan waktu WIB-nya.

FORMAT WAJIB:
- Tiga paragraf terpisah dengan baris kosong di antara
- Tidak ada bullet list, tidak ada heading, tidak ada emoji, tidak ada bold
- Kalimat aktif, langsung ke poin
- Maksimal 3 paragraf, tidak lebih
- Seluruh output hanya dalam Bahasa Indonesia

Balas hanya dengan tiga paragraf tersebut, tidak ada teks lain.`;

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

      if (gemRes.ok) {
        const gemData = await gemRes.json();
        const raw = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (raw.trim()) article = raw.trim();
      }
    } catch(e) {
      console.warn('Gemini failed:', e.message);
      method = 'fallback';
    }
  } else if (!GEMINI_KEY) {
    method = 'fallback';
  }

  // ── 5. Fallback ───────────────────────────────────────────────────────────
  if (!article) {
    method = 'fallback';

    if (recentItems.length === 0) {
      article = 'Tidak ada berita baru dalam 6 jam terakhir.';
    } else {
      // Group by category, build a simple narrative
      const catGroups = {};
      recentItems.forEach(i => {
        const cat = detectCat(i.title);
        if (!catGroups[cat]) catGroups[cat] = [];
        catGroups[cat].push(i.title);
      });

      const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
      const parts = [];
      const CAT_ID = {
        'market-moving': 'Penggerak utama pasar',
        'macro':         'Dari sisi kebijakan moneter',
        'energy':        'Di sektor energi',
        'geopolitical':  'Dari sisi geopolitik',
        'forex':         'Pada pasar valuta asing',
        'econ-data':     'Data ekonomi menunjukkan',
        'equities':      'Pasar saham mencatat',
        'commodities':   'Di pasar komoditas',
        'bonds':         'Pasar obligasi',
      };

      for (const cat of priority) {
        if (catGroups[cat]?.length > 0 && parts.length < 3) {
          parts.push(`${CAT_ID[cat] || cat}: ${catGroups[cat][0].toLowerCase()}.`);
        }
      }

      const calPart = calEvents.length > 0
        ? `Event high-impact terdekat adalah ${calEvents[0].event} (${calEvents[0].currency}) pada ${calEvents[0].time_wib}, ${calEvents[0].date}.`
        : 'Tidak ada event high-impact terjadwal dalam waktu dekat.';

      article = parts.join(' ') + '\n\n' + calPart;
    }
  }

  // ── 6. Response ───────────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({
      article,
      method,
      news_count:    recentItems.length,
      cal_count:     calEvents.length,
      generated_at:  new Date().toISOString(),
    }),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
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
    const link    = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
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
      date:     `${dp[3]}-${dp[1]}-${dp[2]}`,
      time_wib: convertToWIB(time),
      currency: country,
      event:    title,
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
  const min  = parseInt(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const nowMonth = new Date().getUTCMonth() + 1;
  const isDST    = nowMonth >= 3 && nowMonth <= 10;
  const wibHour  = (hour + (isDST ? 11 : 12)) % 24;
  return `${String(wibHour).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':         ['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/eur','/gbp','/jpy','/cad','/chf','/aud','/nzd','fx options','options expir','dollar index','dxy','cable','loonie','aussie','kiwi','swissy','fiber'],
    'equities':      ['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx','nvda','apple','tesla'],
    'commodities':   ['gold','silver','copper','wheat','corn','xau','xag','commodity','zinc','nickel','alumin'],
    'energy':        ['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','petroleum','hormuz','iea','tanker','lng'],
    'bonds':         ['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':        ['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':       ['pmi','purchasing manager','composite index','manufacturing index','services index'],
    'macro':         ['fed ','fomc','powell','goolsbee','waller','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':     ['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','consumer confidence','payroll','westpac','sentiment'],
    'geopolitical':  ['iran','iranian','tehran','nuclear','ceasefire','hezbollah','israel','russia','ukraine','china','chinese','xi jinping','taiwan','north korea','sanction','tariff','trump','nato','military'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'macro';
}
