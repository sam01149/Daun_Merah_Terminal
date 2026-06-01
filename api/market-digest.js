// api/unified-digest.js
const rateLimit    = require('./_ratelimit');
const cb           = require('./_circuit_breaker');
const { autoUpdateFundamentals } = require('./_fundamental_parser');

// AI provider failure threshold before circuit opens (fewer than external sources
// because AI errors are faster to detect and providers recover quickly)
const AI_CB_THRESHOLD = 2;
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';

// AI providers
const SAMBANOVA_URL       = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL     = 'DeepSeek-V3.2';              // Call 2 & 3: structured JSON (akun 1) — upgrade dari V3.1, kualitas lebih baik
const SAMBANOVA_URL_CALL1 = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL_CALL1 = 'DeepSeek-V3.2';            // Call 1: prose (akun 2) — preview, tapi kualitas superior untuk Indonesian
const GROQ_URL        = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama-3.3-70b-versatile';        // Call 2, 3, 4: JSON + thesis
const GROQ_MODEL_PROSE = 'qwen3-32b';                     // Call 1 fallback 3: prose (lebih panjang, cocok untuk briefing)
const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL   = 'openai/gpt-oss-120b:free'; // Call 1 fallback 2: proven stabil, output Bahasa Indonesia
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://financial-feed-app.vercel.app', 'X-Title': 'Daun Merah' };

const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
const GOLD_KEYWORDS = [
  // Direct gold references
  'gold','xau','bullion','spot gold','precious metal','gold price','gold demand','gold rally','gold drop',
  // Real yield / USD channel (gold's #1 driver)
  'real yield','tips yield','breakeven','inflation expect','10y yield','10-year yield','treasury yield','us yield','yield curve',
  'dxy','dollar index',
  // Fed / FOMC — USD fundamentals that directly drive XAU via rate/real yield channel
  'powell','fomc','federal reserve','fed rate','fed minutes','fed pivot','rate cut','rate hike',
  'us cpi','us inflation','nonfarm','nfp','us gdp','us jobs','us unemployment',
  // ETF / flow
  'gld','gold etf','etf flow','bullion etf','central bank buy','central bank gold','gold reserve',
  // Safe haven — gold-specific phrasing only
  'safe haven','haven demand','flight to safety','flight to gold',
  // Geopolitical — only phrasing explicitly tied to haven/gold impact
  'middle east tension','iran nuclear','russia ukraine','ukraine war','gold safe',
  // Iran / Hormuz — direct geopolitical risk → safe haven gold channel
  // 'iran' standalone: nearly all Iran headlines in financial news imply geopolitical risk
  'iran','hormuz','strait of hormuz','ofac sanction','iran nuclear deal',
  'iran oil','iran blockade','us-iran',
  // Risk sentiment — equities as risk-off/on proxy for haven demand
  'risk aversion','risk-off','risk off','risk-on','risk on',
  'vix spike','vix surge','equity sell-off','stock market crash','market rout','flight to bonds',
  // Geopolitical — broader triggers with clear haven implication
  'trade war','us china tariff','sanction escalat','nuclear threat','conflict escalat',
  // US-China trade / Trump geopolitical — risk-on/off driver affecting gold via sentiment channel
  // 'beijing' captures Trump China visit; 'trump xi' captures summit headlines
  'trump xi','beijing','china visit','us china trade','china trade deal','rare earth',
  // Dollar moves (non-DXY phrasing)
  'dollar rally','dollar drop','dollar strengthen','dollar weaken','usd rally','usd drop',
  // Precious metals family — comex is gold's primary venue
  'comex','silver price','silver rally','silver drop',
];

// ── XAU/USD spot price fetch (Yahoo GC=F → Binance PAXG fallback) ─────────────
async function fetchXauSpot() {
  try {
    const cached = await redisCmd('GET', 'xau_spot');
    if (cached) {
      const d = JSON.parse(cached);
      if (Date.now() - new Date(d.fetched_at).getTime() < 5 * 60 * 1000) return d;
    }
  } catch(e) {}

  // Primary: Yahoo Finance GC=F (COMEX gold front-month futures)
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=5m', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const json = await r.json();
      const meta  = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev  = meta?.previousClose || meta?.chartPreviousClose;
      if (price && price > 0) {
        const changePct = prev ? +((price - prev) / prev * 100).toFixed(2) : null;
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: changePct, source: 'Yahoo GC=F', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Yahoo failed:', e.message); }

  // Fallback: Binance PAXGUSDT (24/7, no auth, tracks spot 1:1)
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT', {
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const d = await r.json();
      const price     = parseFloat(d.lastPrice);
      const changePct = parseFloat(d.priceChangePercent);
      const prev      = parseFloat(d.openPrice);
      if (price > 0) {
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: +changePct.toFixed(2), source: 'Binance PAXG', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Binance failed:', e.message); }

  return null;
}

// Read XAU/USD daily TA from Redis cache (written by /api/correlations?action=ta)
async function fetchXauTA() {
  try {
    const cached = await redisCmd('GET', 'ta:GC=F:1d');
    if (!cached) return null;
    const d = JSON.parse(cached);
    // Allow up to 2h stale — daily TA doesn't change fast
    if (Date.now() - new Date(d.computed_at).getTime() > 2 * 3600 * 1000) return null;
    return d;
  } catch(e) {
    console.warn('fetchXauTA failed:', e.message);
    return null;
  }
}

// Strip <think>...</think> blocks from Qwen3 thinking models — content after </think> is the actual response
function stripThinking(text) {
  const lastClose = text.lastIndexOf('</think>');
  if (lastClose !== -1) return text.slice(lastClose + 8).trim();
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Shared low-level fetch for any OpenAI-compatible provider
async function aiCall(url, apiKey, model, messages, maxTokens, temperature, timeoutMs, extraHeaders = {}, extraBody = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, ...extraBody }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err?.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return stripThinking(content).trim();
}


module.exports = async function handler(req, res) {
  console.log('market-digest v3 START', new Date().toISOString());
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cached mode — serve last saved digest from Redis, no AI calls
  if (req.query?.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', 'latest_article');
      const cachedDeviceId = req.query?.device_id;
      let cachedAlerts = null;
      if (cachedDeviceId) {
        try {
          const alertsRaw = await redisCmd('GET', `thesis_alerts:${cachedDeviceId}`);
          if (alertsRaw) cachedAlerts = JSON.parse(alertsRaw);
        } catch(e) { /* skip — non-critical */ }
      }
      if (raw) return res.status(200).json({ ...JSON.parse(raw), from_cache: true, thesis_alerts: cachedAlerts });
    } catch(e) { console.warn('cached mode Redis read failed:', e.message); }
    return res.status(200).json({ from_cache: true, article: null });
  }

  // Multi-provider AI calls — rate limit to 4 req/min per IP
  if (await rateLimit(req, res, { limit: 4, windowSecs: 60, endpoint: 'market-digest' })) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('x-vercel-cache', 'BYPASS');

  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const SAMBANOVA_KEY  = process.env.SAMBANOVA_API_KEY;
  const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
  const GROQ_KEY       = process.env.GROQ_API_KEY;

  // 1. RSS — current feed + 36h Redis history in parallel
  let rssItems = [];
  try {
    const host = req.headers.host || 'financial-feed-app.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const cutoff36h = Date.now() - 36 * 60 * 60 * 1000;
    const histTimeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    const [rssRes, histRaw] = await Promise.allSettled([
      fetch(`${proto}://${host}/api/feeds?type=rss`, { signal: AbortSignal.timeout(12000) }),
      Promise.race([redisCmd('ZRANGEBYSCORE', 'news_history', cutoff36h, '+inf'), histTimeout]),
    ]);

    let currentItems = [];
    if (rssRes.status === 'fulfilled' && rssRes.value.ok) {
      const xml = await rssRes.value.text();
      if (xml.includes('<rss')) currentItems = parseRSS(xml);
    }

    let historyItems = [];
    if (histRaw.status === 'fulfilled' && Array.isArray(histRaw.value)) {
      historyItems = histRaw.value.map(s => { try { return JSON.parse(s); } catch(_) { return null; } }).filter(Boolean);
    }

    // Merge: current RSS takes priority, dedup by guid
    const seen = new Set(currentItems.map(i => i.guid));
    const merged = [...currentItems, ...historyItems.filter(i => i.guid && !seen.has(i.guid))];
    rssItems = merged
      .filter(i => new Date(i.pubDate).getTime() > cutoff36h)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    console.log(`RSS items: ${currentItems.length} current + ${historyItems.length} history → ${rssItems.length} merged`);
  } catch(e) {
    console.warn('RSS/history fetch failed:', e.message);
  }

  const recentItems = rssItems.slice(0, 150);

  // 2. Calendar
  let calEvents = [];
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
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
    for (let i = 0; i <= 3; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    const seen = new Set();
    calEvents = allEvents
      .filter(e => dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => { const k=`${e.date}|${e.time_wib}|${e.currency}|${e.event}`; if(seen.has(k))return false; seen.add(k); return true; })
      .sort((a,b) => (a.date+a.time_wib).localeCompare(b.date+b.time_wib));
  } catch(e) { console.warn('Cal:', e.message); }

  // 3. Context
  const wibNow  = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;
  const DAYS_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const dayStr  = DAYS_ID[wibNow.getUTCDay()];
  const isMonEarly = wibNow.getUTCDay() === 1 && wibNow.getUTCHours() < 15;
  const weekendNote = isMonEarly ? '\nCATATAN KONTEKS: Ini Senin pagi — bagian "12-36 jam lalu" mencakup weekend, volume berita tipis, tidak market-moving.' : '';
  const headlinesForBriefing = recentItems.slice(0, 80);
  const headlinesBlock = headlinesForBriefing.length > 0 ? headlinesForBriefing.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n') : '(Tidak ada headline)';
  const calBlock = calEvents.length > 0 ? calEvents.map(e=>`- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n') : '(Tidak ada event high-impact)';

  // Gold-specific headline filter — split recent vs historical so AI weights correctly
  const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
  const isGold = i => GOLD_KEYWORDS.some(kw => i.title.toLowerCase().includes(kw));
  const goldRecent = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() > cutoff12h).slice(0, 20);
  const goldOlder  = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() <= cutoff12h).slice(0, 15);
  const goldItems  = [...goldRecent, ...goldOlder];
  const goldBlock  = [
    goldRecent.length > 0
      ? `[12 JAM TERAKHIR — ${goldRecent.length} berita]\n${goldRecent.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '[12 JAM TERAKHIR] (tidak ada)',
    goldOlder.length > 0
      ? `\n[KONTEKS HISTORIS 12-36 JAM LALU — ${goldOlder.length} berita]\n${goldOlder.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '\n[KONTEKS HISTORIS 12-36 JAM LALU] (tidak ada)',
  ].join('');

  // 3b. Load digest history + xau history + real yields + XAU spot + XAU TA in parallel
  let digestHistory = [], xauHistory = [], realYieldsData = null, xauSpot = null, xauTa = null;
  try {
    const [rawHist, rawXauHist, rawRY, spotResult, taResult] = await Promise.all([
      redisCmd('LRANGE', 'digest_history', 0, 6),
      redisCmd('LRANGE', 'xau_history', 0, 3),
      redisCmd('GET', 'real_yields'),
      fetchXauSpot(),
      fetchXauTA(),
    ]);
    if (Array.isArray(rawHist)) digestHistory = rawHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (Array.isArray(rawXauHist)) xauHistory = rawXauHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (rawRY) realYieldsData = JSON.parse(rawRY);
    xauSpot = spotResult;
    xauTa   = taResult;
    console.log('XAU spot:', xauSpot ? `$${xauSpot.price} (${xauSpot.source})` : 'unavailable');
    console.log('XAU TA:', xauTa ? `RSI=${xauTa.rsi_14} SMA50=${xauTa.price_vs_sma50}` : 'unavailable (cache cold)');
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';
  const xauHistoryBlock = xauHistory.length > 0
    ? xauHistory.map(h => `[${h.wib}] ${h.xau_summary}`).join('\n')
    : '(Belum ada riwayat XAU — ini sesi pertama)';

  // Build real yield block for Call 1 context
  let realYieldBlock = '(Data real yield tidak tersedia — inferensi dari headline saja)';
  if (realYieldsData?.currencies?.USD) {
    const ry = realYieldsData.currencies.USD;
    const trendNote = ry.real > 2.0 ? 'ELEVATED — tekanan struktural bearish pada XAU' : ry.real > 1.0 ? 'moderat' : 'rendah/negatif — relatif supportif XAU';
    realYieldBlock = `USD 10Y Nominal: ${ry.nominal}% | TIPS Breakeven: ${ry.inflation_exp}% | Real Yield: ${ry.real}% (${trendNote}) | per ${ry.as_of}`;
  }

  // Build XAU spot block
  let xauSpotBlock = '(Data harga XAU tidak tersedia sesi ini — gunakan tekanan fundamental saja)';
  if (xauSpot) {
    const sign  = xauSpot.change_pct > 0 ? '+' : '';
    const pctStr = xauSpot.change_pct !== null ? ` (${sign}${xauSpot.change_pct}% dari sesi sebelumnya)` : '';
    xauSpotBlock = `${xauSpot.source}: $${xauSpot.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${pctStr} | per ${xauSpot.as_of}`;
  }

  // Build XAU daily TA block
  let xauTaBlock = '(Cache TA belum tersedia — kunjungi tab TEK untuk mengisi cache, atau abaikan bagian ini)';
  if (xauTa) {
    const parts = [];
    if (xauTa.rsi_14 != null) {
      const rsiLabel = xauTa.rsi_14 > 70 ? 'Overbought' : xauTa.rsi_14 < 30 ? 'Oversold' : 'Netral';
      parts.push(`RSI 14: ${xauTa.rsi_14.toFixed(1)} (${rsiLabel})`);
    }
    if (xauTa.sma_50 != null && xauTa.price_vs_sma50)
      parts.push(`SMA 50: ${xauTa.sma_50.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma50 === 'above' ? 'di atas' : 'di bawah'}`);
    if (xauTa.sma_200 != null && xauTa.price_vs_sma200)
      parts.push(`SMA 200: ${xauTa.sma_200.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma200 === 'above' ? 'di atas' : 'di bawah'}`);
    xauTaBlock = parts.length > 0 ? parts.join(' | ') : '(Data TA terbatas)';
  }

  // 3c. Load externalized prompts from Redis — fall back to hardcoded if missing
  let promptDigestInstr = null;
  try {
    promptDigestInstr = await redisCmd('GET', 'prompt_digest');
  } catch(e) {
    console.warn('prompt_digest Redis load failed:', e.message);
  }

  // ── 4. Call 1: Market Briefing — Cerebras → Groq fallback ────────────────────
  let article = null, method = 'fallback';
  if (recentItems.length > 0) {
    const DIGEST_SYSTEM_DEFAULT = `Kamu analis macro FX senior. Tulis briefing pre-session Bahasa Indonesia untuk trader Indonesia yang sudah fasih: DXY, real yield, carry, risk-on/off, basis point — jangan jelaskan istilah ini.

FORMAT OUTPUT:
- Prosa mengalir. Tanpa bullet, heading, bold, emoji.
- Dua bagian: (1) bagian FX, (2) bagian XAUUSD diawali tepat "XAUUSD:" (baris baru, tanpa spasi sebelum tanda titik dua).
- Mulai LANGSUNG dengan fakta paling spesifik yang market-moving dari headline. DILARANG KERAS membuka dengan: "Pagi ini", "Hari ini", "Sesi ini", "Flow berita", "Pasar hari ini", "Dalam konteks ini", "Minggu ini", atau kalimat konteks/ringkasan apapun. Kalimat pertama harus menyebut nama pejabat, angka spesifik, atau pair konkret.

FRASA TERLARANG — periksa output sebelum kirim, tidak ada pengecualian:
dapat mempengaruhi · dapat memberikan · dapat berdampak · perlu dicermati · patut diwaspadai · tergantung data · masih akan volatile · menjadi fokus · trader harus berhati-hati · sentimen mixed · berpotensi menggerakkan · berpotensi mempengaruhi · dapat menekan · memberikan tekanan · memberikan dorongan · perlu diperhatikan · akan terus dipantau · seiring dengan · sejalan dengan · di tengah · memberikan gambaran · masih dalam ketidakpastian · mencermati · cukup padat · perkembangan ini · hal ini · dalam beberapa jam ke depan (tanpa spesifik) · berdampak pada pasar

TES WAJIB TIAP KALIMAT: Bisakah kalimat ini ditulis tanpa membaca headlines hari ini? Kalau ya → hapus.

ATURAN FX:
Klaim: Sebut nama pejabat, angka, atau pair spesifik dari headline. Tidak ada? Skip tema itu sepenuhnya.
Mekanisme: Jalur transmisi konkret (rate differential, real yield gap, risk channel, flow). Bukan "berdampak ke pair X" — sebutkan via mekanisme apa.
Magnitude: Kuat atau marginal. Marginal harus disebut marginal.
Konflik: Dua signal berlawanan dalam satu tema? Sebut keduanya, putuskan mana lebih berat, jelaskan kenapa.
Kalender: Hanya event dengan asymmetri beat/miss jelas. Untuk setiap event yang dianalisis, gunakan format prosa ini persis: "[EVENT] ([CURRENCY]) [TIME WIB] — jika beat: [pair] [naik/turun] karena [mekanisme konkret]; jika miss: [pair] [naik/turun] karena [mekanisme konkret]." Event tanpa edge antisipatif → skip sepenuhnya, jangan disebutkan.
Pejabat CB: Hanya analisa jika menyentuh rate path, balance sheet, atau inflation framework. Non-policy → sebut sekali "tidak ada sinyal kebijakan dari [nama]" lalu lanjut.
Continuity: Apa yang BERUBAH vs TETAP dari sesi sebelumnya. Tidak ada perubahan material? Nyatakan — itu informasi valid.
Penutup FX: Satu kalimat menyebut currency paling terkonfirmasi kuat dan paling terkonfirmasi lemah (HANYA pilih dari 8 majors: USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF) — dengan alasan spesifik dari headline, bukan "pasar volatile".

ATURAN XAUUSD (paragraf baru, mulai tepat "XAUUSD:"):
Trader gold baca ini standalone — harus self-contained.
Gunakan HANYA headline dari blok HEADLINE RELEVAN XAUUSD di bawah.
< 3 headline substantif → buka "Sinyal gold tipis" dan persingkat ke 2-3 kalimat saja.
ANTI-HALLUCINATION: Jangan gabungkan dua headline berbeda menjadi satu klaim baru yang tidak ada di headline aslinya. Jika headline A menyebut X dan headline B menyebut Y, jangan tulis "X berkoordinasi dengan Y" kecuali kalimat itu memang ada di salah satu headline.

PENDEKATAN BENANG MERAH — ikuti urutan ini:
1. JANGKAR HARGA: Jika blok HARGA XAU/USD LIVE tersedia, buka dengan harga dan pergerakan hari ini (naik/turun berapa persen). Ini titik awal narasi — semua fakta berikutnya menjelaskan MENGAPA harga ada di sini.
2. RAJUT FAKTA: Hubungkan harga → headline → real yield → geopolitik secara natural, seperti analis yang bercerita. Tidak perlu rantai kausal formal. Cukup: "kenaikan ini didukung oleh X, meski dibatasi oleh Y." Fakta yang saling memperkuat → gabungkan. Fakta yang berlawanan → sebut keduanya, putuskan mana lebih berat dalam satu kalimat. Jika blok TEKNIKAL XAU tersedia, sisipkan RSI dan posisi vs SMA dalam satu kalimat natural sebagai konteks teknikal pendukung (misal: "secara teknikal harga masih di atas SMA 50 dengan RSI 45 di zona netral") — bukan paragraf terpisah.
3. REAL YIELD sebagai pembatas: Jika real yield > 2%, emas mahal secara struktural — wajib disebut sebagai rem, bukan diabaikan. Tapi jika harga tetap naik meski yield tinggi, artinya tekanan bullish cukup kuat untuk offset — nyatakan ini secara eksplisit.
4. TIDAK ADA RANTAI KAUSAL WAJIB: Untuk geopolitik minyak (Iran, Hormuz, OPEC) — tidak perlu trace oil→inflasi→Fed→yield secara kaku. Cukup: apakah ada bukti di headline bahwa ini mempengaruhi XAU? Jika ya, sebut. Jika tidak, skip.
5. Driver sama dengan sesi sebelumnya → nyatakan eksplisit, itu informasi valid.

TRIGGER TERDEKAT 24 JAM: Pilih event dari kalender dengan PRIORITAS TERTINGGI: (1) FOMC/Fed — Minutes, pidato Powell, rate decision; (2) US data — CPI, NFP, GDP; (3) event major currency lain. Format wajib: "[EVENT] [TIME WIB] — jika [outcome]: tekanan [bullish/bearish] XAU karena [mekanisme]; jika [outcome berlawanan]: tekanan [bullish/bearish] XAU karena [mekanisme]." Harus ada DUA skenario. Jika tidak ada event kalender relevan untuk XAU dalam 24 jam, tulis "Tidak ada trigger kalender untuk XAU dalam 24 jam ke depan."

REMINDER FINAL: SEBELUM MERESPONS, pastikan tidak ada kata "dapat mempengaruhi", "berpotensi", "mungkin", atau "dalam beberapa jam ke depan". Jika ada, ubah menjadi kalimat pernyataan tegas.`;

    const digestSystemMsg = promptDigestInstr || DIGEST_SYSTEM_DEFAULT;
    const digestUserMsg = `/no_think
PENTING: TULIS SELURUH OUTPUT DALAM BAHASA INDONESIA. JANGAN GUNAKAN BAHASA INGGRIS SAMA SEKALI.
WAKTU: ${dayStr}, ${dateStr}, ${timeStr}${weekendNote}

=== HARGA XAU/USD LIVE (jangkar harga — gunakan sebagai titik awal narasi) ===
${xauSpotBlock}

=== TEKNIKAL XAU/USD DAILY (dari Yahoo GC=F — sebutkan singkat dalam 1 kalimat sebagai konteks, bukan analisa teknikal terpisah) ===
${xauTaBlock}

=== DATA REAL YIELD USD (LIVE — gunakan ini, jangan inferensi dari headline) ===
${realYieldBlock}

=== HEADLINE BERITA TERKINI (${headlinesForBriefing.length} dari ${recentItems.length} berita, 36 jam terakhir) ===
${headlinesBlock}

=== HEADLINE RELEVAN XAUUSD (${goldItems.length} dari ${recentItems.length} berita, 36 jam, difilter) ===
${goldBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

=== RINGKASAN SESI SEBELUMNYA (FX) ===
${historyBlock}

=== RIWAYAT XAUUSD SESI SEBELUMNYA (4 sesi terakhir) ===
${xauHistoryBlock}`;

    const call1Messages = [
      { role: 'system', content: digestSystemMsg },
      { role: 'user', content: digestUserMsg },
    ];

    // Primary: SambaNova DeepSeek-V3.2 (akun 2, Call 1 prose only) — circuit breaker
    if (SAMBANOVA_KEY_CALL1 && await cb.canCall('ai:sambanova')) {
      try {
        console.log('Call 1: trying SambaNova DeepSeek-V3.2 (akun 2 prose)');
        const raw = await aiCall(SAMBANOVA_URL_CALL1, SAMBANOVA_KEY_CALL1, SAMBANOVA_MODEL_CALL1, call1Messages, 800, 0.25, 28000);
        if (raw.trim()) { article = raw.trim(); method = 'deepseek-v3.2'; }
        console.log('Call 1: SambaNova V3.2 OK, length', article?.length);
        await cb.onSuccess('ai:sambanova');
      } catch(e) {
        console.warn('Call 1 SambaNova V3.2 failed:', e.status || e.message);
        await cb.onFailure('ai:sambanova', AI_CB_THRESHOLD);
      }
    } else if (SAMBANOVA_KEY_CALL1) {
      console.log('Call 1: SambaNova circuit OPEN — skipping to OpenRouter');
    }

    // Fallback 2: OpenRouter gpt-oss-120b (if SambaNova failed/empty)
    if (!article && OPENROUTER_KEY) {
      try {
        console.log('Call 1: fallback 2 to OpenRouter gpt-oss-120b:free');
        const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, OPENROUTER_MODEL, call1Messages, 800, 0.25, 28000, OPENROUTER_HEADERS);
        if (raw.trim()) { article = raw.trim(); method = 'gpt-oss-120b'; }
        console.log('Call 1: OpenRouter OK, length', article?.length);
      } catch(e) {
        console.warn('Call 1 OpenRouter fallback failed:', e.status || e.message);
      }
    }

    // Fallback 3: Groq qwen3-32b (if OpenRouter failed/empty)
    if (!article && GROQ_KEY) {
      try {
        console.log('Call 1: fallback 3 to Groq qwen3-32b');
        const raw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL_PROSE, call1Messages, 1800, 0.25, 20000);
        if (raw.trim()) { article = raw.trim(); method = 'qwen3-32b'; }
        console.log('Call 1: Groq qwen3 OK, length', article?.length);
      } catch(e) {
        console.warn('Call 1 Groq qwen3 fallback failed:', e.status || e.message);
      }
    }

    if (!article) method = 'fallback';
  } else {
    method = 'fallback';
  }

  // ── 5. Manual fallback (no AI) ────────────────────────────────────────────────
  if (!article) {
    method = 'fallback';
    if (recentItems.length === 0) {
      article = 'Tidak ada berita baru dalam 36 jam terakhir.';
    } else {
      const catGroups = {};
      recentItems.forEach(i => { const c=detectCat(i.title); if(!catGroups[c])catGroups[c]=[]; catGroups[c].push(i.title); });
      const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
      const CAT_ID = { 'market-moving':'Penggerak utama pasar','macro':'Dari sisi kebijakan moneter','energy':'Di sektor energi','geopolitical':'Dari sisi geopolitik','forex':'Pada pasar valuta asing','econ-data':'Data ekonomi menunjukkan','equities':'Pasar saham mencatat','commodities':'Di pasar komoditas','bonds':'Pasar obligasi' };
      const parts = [];
      for (const cat of priority) { if (catGroups[cat]?.length > 0 && parts.length < 3) parts.push(`${CAT_ID[cat]||cat}: ${catGroups[cat][0].toLowerCase()}.`); }
      const calPart = calEvents.length > 0 ? `Event high-impact terdekat adalah ${calEvents[0].event} (${calEvents[0].currency}) pada ${calEvents[0].time_wib}, ${calEvents[0].date}.` : 'Tidak ada event high-impact terjadwal.';
      article = parts.join(' ') + '\n\n' + calPart;
    }
  }

  // ── 5b. Save digest + xau history (parallel) ──
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    try {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wibStr = `${String(wibNow.getUTCDate()).padStart(2,'0')} ${MONTHS[wibNow.getUTCMonth()]} ${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

      // FX digest history — first 700 chars (FX section)
      const xauIdx = article.indexOf('XAUUSD:');
      const fxSummary = (xauIdx > 0 ? article.slice(0, xauIdx) : article).replace(/\n/g, ' ').slice(0, 700);
      const fxEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, summary: fxSummary });

      // XAU-specific history — extract XAUUSD paragraph only
      const xauParagraph = xauIdx !== -1 ? article.slice(xauIdx, xauIdx + 600).replace(/\n/g, ' ') : null;
      const saves = [
        redisCmd('LPUSH', 'digest_history', fxEntry).then(() => redisCmd('LTRIM', 'digest_history', 0, 6)),
      ];
      // Only save XAU history when gold headlines are substantive — prevents hallucinated
      // thin-day analysis from polluting future sessions via xauHistoryBlock continuity prompt
      if (xauParagraph && goldItems.length >= 3) {
        const xauEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, xau_summary: xauParagraph });
        saves.push(redisCmd('LPUSH', 'xau_history', xauEntry).then(() => redisCmd('LTRIM', 'xau_history', 0, 3)));
      } else if (xauParagraph) {
        console.log(`XAU history skipped — goldItems ${goldItems.length} < 3, output unreliable`);
      }
      await Promise.all(saves);
      console.log('Digest + XAU history saved');
    } catch(e) { console.warn('Digest history save failed:', e.message); }
  }

  // ── 6. Call 2: CB Bias — SambaNova → Groq fallback ───────────────────────────
  let biasUpdated = [];
  if (recentItems.length > 0) {
    const CB_KEYWORDS = {
      USD: ['fed ','fomc','powell','goolsbee','waller','kashkari','warsh','federal reserve','us inflation','us gdp','us jobs','nfp','us cpi'],
      EUR: ['ecb','lagarde','lane','schnabel','euro zone','eurozone','euro area','eu inflation','eu gdp'],
      GBP: ['boe','bank of england','bailey','pill','gbp','sterling','uk inflation','uk gdp','uk jobs','claimant'],
      JPY: ['boj','bank of japan','ueda','japan inflation','japan gdp','yen','japanese'],
      CAD: ['boc','bank of canada','macklem','canada inflation','canada gdp','canadian'],
      AUD: ['rba','reserve bank of australia','bullock','australia inflation','australia gdp','aussie'],
      NZD: ['rbnz','reserve bank of new zealand','orr','new zealand inflation','new zealand gdp','kiwi'],
      CHF: ['snb','swiss national bank','schlegel','switzerland','swiss franc','franc'],
    };

    const relevantCurrencies = [];
    const headlinesLower = recentItems.map(i => i.title.toLowerCase());
    for (const [cur, kws] of Object.entries(CB_KEYWORDS)) {
      if (kws.some(kw => headlinesLower.some(h => h.includes(kw)))) {
        relevantCurrencies.push(cur);
      }
    }

    console.log('relevantCurrencies:', JSON.stringify(relevantCurrencies));
    if (relevantCurrencies.length > 0) {
      const relevantHeadlines = recentItems.filter(i => {
        const lower = i.title.toLowerCase();
        return relevantCurrencies.some(cur => CB_KEYWORDS[cur].some(kw => lower.includes(kw)));
      });
      const biasHeadlines = relevantHeadlines.slice(0, 50).map((i,idx) => (idx+1) + '. ' + i.title).join('\n');
      const biasCurrencies = relevantCurrencies.join(', ');
      const biasPrompt = [
        'You are a central bank policy analyst. Based ONLY on the following recent financial news headlines, assess the current monetary policy stance for each central bank mentioned.',
        '',
        'Headlines:',
        biasHeadlines,
        '',
        'For each of these currencies that have relevant headlines: ' + biasCurrencies,
        '',
        'Return ONLY a valid JSON object. No explanation, no markdown, no code block. Just the raw JSON.',
        'Use ONLY these exact bias values: "Hawkish", "Cautious Hawkish", "Neutral", "Data Dependent", "On Hold", "Cautious Dovish", "Dovish", "Split"',
        'For confidence, use ONLY: "High", "Medium", "Low"',
        '  High = multiple clear, direct signals from officials or data',
        '  Medium = some signals but mixed or indirect',
        '  Low = minimal or ambiguous evidence',
        '',
        'Example format:',
        '{"USD":{"bias":"Cautious Hawkish","confidence":"High"},"EUR":{"bias":"Dovish","confidence":"Medium"}}',
        '',
        'Only include currencies where you have enough evidence from the headlines. If insufficient evidence for a currency, omit it.',
      ].join('\n');

      const call2Messages = [{ role: 'user', content: biasPrompt }];
      let biasRaw = null;

      // Primary: SambaNova (circuit breaker)
      if (SAMBANOVA_KEY && await cb.canCall('ai:sambanova')) {
        try {
          console.log('Call 2: trying SambaNova');
          biasRaw = await aiCall(SAMBANOVA_URL, SAMBANOVA_KEY, SAMBANOVA_MODEL, call2Messages, 400, 0.1, 8000);
          console.log('Call 2: SambaNova OK');
          await cb.onSuccess('ai:sambanova');
        } catch(e) {
          console.warn('Call 2 SambaNova failed:', e.status || e.message);
          await cb.onFailure('ai:sambanova', AI_CB_THRESHOLD);
        }
      } else if (SAMBANOVA_KEY) {
        console.log('Call 2: SambaNova circuit OPEN — skipping to Groq');
      }

      // Fallback: Groq (no circuit breaker — always attempt)
      if (!biasRaw && GROQ_KEY) {
        try {
          console.log('Call 2: falling back to Groq');
          biasRaw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, call2Messages, 400, 0.1, 12000);
          console.log('Call 2: Groq fallback OK');
        } catch(e) {
          console.warn('Call 2 Groq fallback failed:', e.status || e.message);
        }
      }

      if (biasRaw) {
        try {
          const clean = biasRaw.replace(/```json|```/g, '').trim();
          console.log('Call 2 bias raw:', biasRaw.substring(0, 300));
          const parsed = JSON.parse(clean);
          console.log('Call 2 bias parsed:', JSON.stringify(parsed));

          const VALID_BIASES = ['Hawkish','Cautious Hawkish','Neutral','Data Dependent','On Hold','Cautious Dovish','Dovish','Split'];
          const VALID_CONFIDENCES = ['High','Medium','Low'];
          const VALID_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          const now = new Date().toISOString();

          // Distributed lock to prevent race condition across concurrent functions
          const lockAcquired = await redisCmd('SET', 'cb_bias_lock', '1', 'NX', 'EX', '10');
          if (lockAcquired) {
            
          let existing = {};
          try {
            const raw = await redisCmd('GET', 'cb_bias');
            if (raw) existing = JSON.parse(raw);
          } catch(e) {}

          for (const [cur, entry] of Object.entries(parsed)) {
            const curOk = VALID_CURRENCIES.has(cur);
            const bias = (typeof entry === 'object' && entry !== null) ? entry.bias : entry;
            const confidence = (typeof entry === 'object' && entry !== null) ? entry.confidence : null;
            const biasOk = VALID_BIASES.includes(bias);
            const confidenceOk = VALID_CONFIDENCES.includes(confidence);
            if (curOk && biasOk) {
              const kws = CB_KEYWORDS[cur] || [];
              const sourceHeadlines = recentItems
                .filter(i => kws.some(kw => i.title.toLowerCase().includes(kw)))
                .slice(0, 5)
                .map(i => i.title);
              existing[cur] = {
                bias,
                confidence: confidenceOk ? confidence : 'Low',
                updated_at: now,
                source_headlines: sourceHeadlines,
              };
              biasUpdated.push(cur);
            }
          }

          if (biasUpdated.length > 0) {
            const saveResult = await redisCmd('SET', 'cb_bias', JSON.stringify(existing));
            console.log('CB bias Redis SET result:', saveResult);
          }
            await redisCmd('DEL', 'cb_bias_lock').catch(()=>{});
          }
        } catch(e) {
          console.warn('Call 2 bias parse/save failed:', e.message);
        }
      }
    }
  }

  // ── 7. Call 3: Structured Trade Thesis — SambaNova → Groq fallback ───────────
  let thesis = null;
  if (recentItems.length > 0 && article) {
    const cbSummary = biasUpdated.length > 0
      ? `CB biases just updated for: ${biasUpdated.join(', ')}`
      : 'CB biases unchanged this cycle';
    const xauSectionMatch = article.indexOf('XAUUSD:');
    const xauSection = xauSectionMatch !== -1 ? article.slice(xauSectionMatch, xauSectionMatch + 700) : '';
    const briefingForThesis = article.slice(0, 900) + (xauSection && xauSectionMatch > 900 ? '\n\n' + xauSection : '');
    const goldHeadlinesForThesis = goldItems.slice(0, 15).map((i, idx) => `${idx + 1}. ${i.title}`).join('\n') || '(none)';

    const thesisPrompt = [
      'You are a macro FX and gold strategist. Based on the market context below, output a structured JSON with both an FX trade thesis and an XAU/USD fundamental thesis.',
      '',
      `Market briefing (current session): ${briefingForThesis}`,
      '',
      cbSummary,
      '',
      `Upcoming high-impact calendar events (next 3 days, WIB): ${calBlock}`,
      '',
      `Gold-relevant headlines: ${goldHeadlinesForThesis}`,
      '',
      'Return ONLY valid JSON with this exact schema (no markdown, no explanation):',
      '{',
      '  "dominant_regime": "risk_on" | "risk_off" | "neutral",',
      '  "strongest_currency": "USD",',
      '  "weakest_currency": "JPY",',
      '  "pair_recommendation": "USD/JPY",',
      '  "direction": "long" | "short" | "no_trade",',
      '  "confidence_1_to_5": 3,',
      '  "invalidation_condition": "string",',
      '  "time_horizon_days": 5,',
      '  "catalyst_dependency": "string",',
      '  "xau_bias": "bullish" | "bearish" | "neutral" | "conflicting",',
      '  "xau_dominant_driver": "real_yield" | "safe_haven" | "risk_sentiment" | "usd_strength" | "insufficient_data",',
      '  "xau_driver_evidence": "string — specific data point or event from headlines",',
      '  "xau_key_trigger": "string — event name + WIB time + specific spike scenario, or \'No clear trigger in 24h\' if none",',
      '  "xau_confidence": 3',
      '}',
      '',
      'FX rules:',
      'Use only 8 major currencies: USD EUR GBP JPY CAD AUD NZD CHF.',
      'Set direction to "no_trade" and confidence to 1-2 if conviction is low.',
      'Only recommend a pair if CB bias divergence between the two currencies is at least 2 levels apart (e.g. Hawkish vs Dovish).',
      'Use the calendar events to inform invalidation_condition — if a high-impact event for one of the pair currencies is scheduled within time_horizon_days, name it as the primary invalidation trigger.',
      '',
      'XAU rules:',
      'xau_bias must be based on fundamental pressure from headlines, NOT price prediction.',
      'xau_driver_evidence must cite a specific number, official name, or event from the gold headlines — not a generic statement.',
      'If gold headlines are sparse (fewer than 3 substantive), set xau_dominant_driver to "insufficient_data" and xau_confidence to 1.',
      'xau_key_trigger must include WIB time if available from calendar, otherwise note "time TBD".',
      'xau_confidence: 1-5 where 5 = multiple converging headlines with clear direction.',
    ].join('\n');

    const call3Messages = [{ role: 'user', content: thesisPrompt }];
    const VALID_DIR = ['long', 'short', 'no_trade'];
    const VALID_REG = ['risk_on', 'risk_off', 'neutral'];
    const VALID_CURR = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
    const VALID_XAU_BIAS = ['bullish', 'bearish', 'neutral', 'conflicting'];
    const VALID_XAU_DRIVER = ['real_yield', 'safe_haven', 'risk_sentiment', 'usd_strength', 'insufficient_data'];

    function validateThesis(parsed) {
      return (
        VALID_REG.includes(parsed.dominant_regime) &&
        VALID_CURR.has(parsed.strongest_currency) &&
        VALID_CURR.has(parsed.weakest_currency) &&
        VALID_DIR.includes(parsed.direction) &&
        typeof parsed.confidence_1_to_5 === 'number' &&
        parsed.confidence_1_to_5 >= 1 && parsed.confidence_1_to_5 <= 5 &&
        VALID_XAU_BIAS.includes(parsed.xau_bias) &&
        VALID_XAU_DRIVER.includes(parsed.xau_dominant_driver)
      );
    }

    // Try SambaNova, then Groq fallback
    const call3Providers = [];
    if (SAMBANOVA_KEY) call3Providers.push({ url: SAMBANOVA_URL, key: SAMBANOVA_KEY, model: SAMBANOVA_MODEL, label: 'SambaNova', timeout: 8000 });
    if (GROQ_KEY)      call3Providers.push({ url: GROQ_URL,      key: GROQ_KEY,      model: GROQ_MODEL,      label: 'Groq fallback', timeout: 12000 });

    for (const provider of call3Providers) {
      if (thesis) break;
      // Check circuit breaker for SambaNova; Groq fallback is always allowed
      const circuitSource = provider.label.startsWith('SambaNova') ? 'ai:sambanova' : null;
      if (circuitSource && !await cb.canCall(circuitSource)) {
        console.log('Call 3:', provider.label, 'circuit OPEN — skipping');
        continue;
      }
      try {
        console.log('Call 3: trying', provider.label);
        const raw = await aiCall(provider.url, provider.key, provider.model, call3Messages, 500, 0.1, provider.timeout);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (validateThesis(parsed)) {
          thesis = parsed;
          console.log('Call 3: OK via', provider.label);
          if (circuitSource) await cb.onSuccess(circuitSource);
        } else {
          console.warn('Call 3: schema invalid via', provider.label, JSON.stringify(parsed).slice(0, 200));
          // Schema invalid ≠ provider failure — don't penalize circuit
        }
      } catch(e) {
        console.warn('Call 3', provider.label, 'failed:', e.status || e.message);
        if (circuitSource) await cb.onFailure(circuitSource, AI_CB_THRESHOLD);
      }
    }

    if (thesis) {
      try {
        await redisCmd('SET', 'latest_thesis', JSON.stringify(thesis), 'EX', 21600);
        console.log('Thesis saved to Redis');
      } catch(e) {
        console.warn('Thesis Redis save failed:', e.message);
      }
    } else {
      console.warn('Call 3: all attempts failed — thesis null');
    }
  }

  // ── 8. Call 4: Thesis Invalidation Monitor — Groq only ───────────────────────
  let thesisAlerts = null;
  const deviceId = req.query?.device_id;
  if (GROQ_KEY && deviceId && method !== 'fallback' && method !== 'fallback_quota') {
    try {
      // Load open journal entries for this device (newest first, cap at 10 to read)
      const ids = await redisCmd('ZRANGE', `journal_index:${deviceId}`, 0, -1, 'REV') || [];
      const openEntries = [];
      for (const id of ids.slice(0, 10)) {
        try {
          const raw = await redisCmd('GET', `journal:${deviceId}:${id}`);
          if (!raw) continue;
          const entry = JSON.parse(raw);
          if (entry.status === 'open' && entry.thesis_text?.trim()) {
            openEntries.push(entry);
          }
          if (openEntries.length >= 5) break;
        } catch(e) { /* skip bad entry */ }
      }

      if (openEntries.length > 0) {
        console.log('Call 4: checking', openEntries.length, 'open entries against headlines');
        const thesesBlock = openEntries
          .map((e, i) => `${i+1}. [ID:${e.id}] ${e.pair} ${(e.direction||'').toUpperCase()}: ${e.thesis_text}`)
          .join('\n');
        const headlines30 = recentItems.slice(0, 30).map((h, i) => `${i+1}. ${h.title}`).join('\n');

        const monitorPrompt = [
          'You are a forex trade thesis monitor.',
          '',
          'Open trade theses:',
          thesesBlock,
          '',
          'Recent headlines (newest first):',
          headlines30,
          '',
          'Check if ANY headline directly contradicts or significantly undermines the stated reason for ANY open thesis.',
          'Only flag genuine contradictions — news that directly opposes the trade direction rationale, not tangentially related news.',
          'Ignore price-level headlines; focus on fundamental basis changes (macro data, CB policy shifts, geopolitical reversals).',
          '',
          'Return ONLY valid JSON, no markdown, no explanation:',
          '{"alerts":[{"entry_id":"...","pair":"...","direction":"...","headline":"exact headline text","reason":"one sentence why this contradicts the thesis"}]}',
          'If no genuine contradictions found: {"alerts":[]}',
        ].join('\n');

        const raw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, [{ role: 'user', content: monitorPrompt }], 400, 0.1, 8000);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed.alerts)) {
          thesisAlerts = parsed.alerts;
          console.log('Call 4: found', thesisAlerts.length, 'alert(s)');
          if (thesisAlerts.length > 0) {
            redisCmd('SET', `thesis_alerts:${deviceId}`, JSON.stringify(thesisAlerts), 'EX', 1800).catch(() => {});
          } else {
            redisCmd('DEL', `thesis_alerts:${deviceId}`).catch(() => {});
          }
        }
      } else {
        console.log('Call 4: no open entries with thesis_text, skipping');
      }
    } catch(e) {
      console.warn('Call 4 Thesis Monitor failed:', e.message);
    }
  }

  // ── Auto-update fundamental data + CB decisions from headlines ───────────────
  try {
    await autoUpdateFundamentals(recentItems.slice(0, 100), redisCmd);
  } catch(e) {
    console.warn('autoUpdateFundamentals failed:', e.message);
  }

  const payload = {
    article, method, thesis,
    thesis_alerts:  thesisAlerts,
    news_count:     recentItems.length,
    gold_count:     goldItems.length,
    cal_count:      calEvents.length,
    bias_updated:   biasUpdated,
    generated_at:   new Date().toISOString(),
  };

  // Persist full payload to Redis so cached mode works (exclude thesis_alerts — device-specific)
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    const toCache = { ...payload, thesis_alerts: null };
    redisCmd('SET', 'latest_article', JSON.stringify(toCache), 'EX', 21600).catch(() => {});
  }

  return res.status(200).json(payload);
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

function toDateStr(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

function parseRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate'), link=b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid&&title) items.push({title,guid,pubDate,link});
  }
  return items;
}

function parseFFXML(xml) {
  const events = [], re = /<event>([\s\S]*?)<\/event>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r=new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block); if(!r)return''; return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); };
    const title=get('title'), country=get('country').toUpperCase(), date=get('date'), time=get('time'), impact=get('impact');
    if (!title||!country) continue;
    const dp=date.match(/(\d{2})-(\d{2})-(\d{4})/); if(!dp) continue;
    events.push({ date:`${dp[3]}-${dp[1]}-${dp[2]}`, time_wib:convertToWIB(time), currency:country, event:title, impact });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr||timeStr==='All Day'||timeStr==='Tentative') return 'Tentative';
  const m=timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i); if(!m) return timeStr;
  let hour=parseInt(m[1]); const min=parseInt(m[2]), ampm=m[3].toLowerCase();
  if(ampm==='pm'&&hour!==12)hour+=12; if(ampm==='am'&&hour===12)hour=0;
  return `${String((hour+7)%24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}


function detectCat(title) {
  const t=title.toLowerCase();
  const CATS = {
    'market-moving':['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/eur','/gbp','/jpy','/cad','/chf','/aud','/nzd','fx options','dollar index','dxy','cable','loonie','aussie','kiwi','fiber'],
    'equities':['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx'],
    'commodities':['gold','silver','copper','wheat','corn','xau','xag','commodity','zinc','nickel'],
    'energy':['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','hormuz','iea','tanker','lng'],
    'bonds':['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':['pmi','purchasing manager','composite index','manufacturing index'],
    'macro':['fed ','fomc','powell','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','payroll'],
    'geopolitical':['iran','iranian','nuclear','ceasefire','israel','russia','ukraine','china','chinese','taiwan','sanction','tariff','trump','nato','military'],
  };
  for (const [cat,kws] of Object.entries(CATS)) { if(kws.some(k=>t.includes(k)))return cat; }
  return 'macro';
}
