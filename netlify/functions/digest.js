// netlify/functions/digest.js
// Called by frontend at session times: 06:55, 13:55, 20:25 WIB
// Fetches RSS, generates AI summary via Gemini, falls back to auto-digest

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const GEMINI_MODEL = 'gemini-2.0-flash';

const SESSION_LABELS = {
  morning:   { id: 'Sesi Asia',   en: 'Asia Session'   },
  afternoon: { id: 'Sesi London', en: 'London Session'  },
  evening:   { id: 'Sesi New York', en: 'New York Session' },
};

exports.handler = async function(event, context) {
  const params = event.queryStringParameters || {};
  const session = params.session || 'morning'; // morning | afternoon | evening
  const label = SESSION_LABELS[session] || SESSION_LABELS.morning;

  // 1. Fetch RSS
  let xml = null;
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) xml = await res.text();
  } catch(e) {}

  if (!xml) {
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'RSS fetch failed' }),
    };
  }

  // 2. Parse items
  const items = parseRSS(xml);

  // Filter to last ~6 hours worth of items (max 80 headlines)
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const recent = items
    .filter(i => new Date(i.pubDate).getTime() > cutoff)
    .slice(0, 80);

  if (recent.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        session, label,
        method: 'empty',
        summary_id: 'Tidak ada berita baru dalam 6 jam terakhir.',
        summary_en: 'No new headlines in the past 6 hours.',
        items: [],
        generated_at: new Date().toISOString(),
      }),
    };
  }

  const headlines = recent.map((i, idx) => `${idx + 1}. [${i.pubDate}] ${i.title}`).join('\n');

  // 3. Try Gemini
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  let summary_id = null;
  let summary_en = null;
  let method = 'gemini';

  if (GEMINI_KEY) {
    try {
      const prompt = `Kamu adalah analis pasar keuangan profesional yang fasih berbahasa Indonesia. Berikut adalah ${recent.length} headline berita keuangan dari FinancialJuice dalam ~6 jam terakhir menjelang ${label.en}:

${headlines}

Tugas:
1. Buat ringkasan naratif singkat SEPENUHNYA DALAM BAHASA INDONESIA (3-5 kalimat). WAJIB ditulis dalam Bahasa Indonesia, BUKAN bahasa Inggris. Mencakup: tema dominan, berita paling market-moving, dan implikasi untuk trader forex/komoditas. Mulai dengan "🇮🇩 Ringkasan ${label.id}:"
2. Buat ringkasan naratif singkat SEPENUHNYA DALAM BAHASA INGGRIS / ENGLISH (3-5 sentences) covering: dominant themes, most market-moving news, implications for forex/commodity traders. Start with "🇬🇧 ${label.en} Digest:"

PENTING: Field "id" HARUS dalam Bahasa Indonesia. Field "en" HARUS dalam English.

Format output (JSON saja, tidak ada teks lain):
{"id": "ringkasan dalam Bahasa Indonesia di sini...", "en": "English summary here..."}`;

      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      if (gemRes.ok) {
        const gemData = await gemRes.json();
        const raw = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Strip possible markdown fences
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        summary_id = parsed.id;
        summary_en = parsed.en;
      }
    } catch(e) {
      console.warn('Gemini failed:', e.message);
      method = 'fallback';
    }
  } else {
    method = 'fallback';
  }

  // 4. Fallback: auto-digest (group by category, pick top per cat)
  if (!summary_id || !summary_en) {
    method = 'fallback';
    const catGroups = {};
    recent.forEach(i => {
      const cat = detectCat(i.title);
      if (!catGroups[cat]) catGroups[cat] = [];
      catGroups[cat].push(i.title);
    });

    const lines_id = [];
    const lines_en = [];
    const CAT_LABEL_ID = {
      'market-moving':'🔴 Penggerak Pasar','forex':'💱 Forex','equities':'📈 Saham',
      'commodities':'🪙 Komoditas','energy':'⚡ Energi','bonds':'📊 Obligasi',
      'crypto':'🔷 Kripto','indexes':'📉 Indeks','macro':'🏦 Makro',
      'econ-data':'📋 Data Ekonomi','geopolitical':'🌐 Geopolitik',
    };
    const CAT_LABEL_EN = {
      'market-moving':'🔴 Market Moving','forex':'💱 Forex','equities':'📈 Equities',
      'commodities':'🪙 Commodities','energy':'⚡ Energy','bonds':'📊 Bonds',
      'crypto':'🔷 Crypto','indexes':'📉 Indexes','macro':'🏦 Macro',
      'econ-data':'📋 Econ Data','geopolitical':'🌐 Geopolitical',
    };

    // Indonesian headline translations for common terms
    const translateHeadlineID = (title) => {
      return title
        .replace(/\bsays?\b/gi, 'mengatakan')
        .replace(/\brises?\b/gi, 'naik')
        .replace(/\bfalls?\b/gi, 'turun')
        .replace(/\bdrops?\b/gi, 'turun')
        .replace(/\bjumps?\b/gi, 'melonjak')
        .replace(/\bsurges?\b/gi, 'melonjak')
        .replace(/\bslides?\b/gi, 'merosot')
        .replace(/\bslumps?\b/gi, 'anjlok')
        .replace(/\bhits?\b/gi, 'mencapai')
        .replace(/\breaches?\b/gi, 'mencapai')
        .replace(/\bexpects?\b/gi, 'memperkirakan')
        .replace(/\breports?\b/gi, 'melaporkan')
        .replace(/\bhigher\b/gi, 'lebih tinggi')
        .replace(/\blower\b/gi, 'lebih rendah')
        .replace(/\bup\b/gi, 'naik')
        .replace(/\bdown\b/gi, 'turun')
        .replace(/\bgold\b/gi, 'emas')
        .replace(/\boil\b/gi, 'minyak')
        .replace(/\bcrude oil\b/gi, 'minyak mentah')
        .replace(/\brate cut/gi, 'pemangkasan suku bunga')
        .replace(/\brate hike/gi, 'kenaikan suku bunga')
        .replace(/\binterest rate/gi, 'suku bunga')
        .replace(/\binflation\b/gi, 'inflasi')
        .replace(/\bunemployment\b/gi, 'pengangguran')
        .replace(/\btrade war\b/gi, 'perang dagang')
        .replace(/\btariff/gi, 'tarif');
    };

    const priority = ['market-moving','macro','energy','forex','geopolitical','econ-data','equities','commodities','bonds','crypto','indexes'];
    for (const cat of priority) {
      if (catGroups[cat]?.length > 0) {
        const top = catGroups[cat].slice(0, 2);
        lines_id.push(`${CAT_LABEL_ID[cat] || cat}: ${top.map(t => translateHeadlineID(t)).join(' | ')}`);
        lines_en.push(`${CAT_LABEL_EN[cat] || cat}: ${top.join(' | ')}`);
      }
    }

    summary_id = `🇮🇩 Ringkasan ${label.id} (${recent.length} berita):\n` + lines_id.join('\n');
    summary_en = `🇬🇧 ${label.en} Digest (${recent.length} headlines):\n` + lines_en.join('\n');
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({
      session,
      label,
      method,
      summary_id,
      summary_en,
      count: recent.length,
      items: recent.slice(0, 10), // send top 10 for display
      generated_at: new Date().toISOString(),
    }),
  };
};

// ── Helpers ──────────────────────────────────────────────

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
    const link  = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':    ['eur/usd','gbp/usd','usd/jpy','aud/usd','usd/cad','nzd/usd','usd/chf','fx options','options expir','dollar index','dxy'],
    'equities': ['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx','nvda','apple','tesla'],
    'commodities':['gold','silver','copper','wheat','corn','soybean','coffee','xau','xag','commodity','zinc','nickel','alumin'],
    'energy':   ['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','petroleum','hormuz','iea','tanker','lng'],
    'bonds':    ['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':   ['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':  ['pmi','purchasing manager','composite index','manufacturing index','services index'],
    'macro':    ['fed ','fomc','powell','goolsbee','waller','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','consumer confidence','payroll','westpac','sentiment'],
    'geopolitical':['iran','iranian','tehran','nuclear','ceasefire','hezbollah','israel','russia','ukraine','china','chinese','xi jinping','taiwan','north korea','sanction','tariff','trump','nato','military'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'macro';
}
