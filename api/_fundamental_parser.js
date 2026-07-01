// api/_fundamental_parser.js
// Shared fundamental + CB decision parsing logic.
// Used by market-digest.js (via digest pipeline) and admin.js (via fundamental_refresh).
// All functions are pure except autoUpdateFundamentals which requires a redisCmd function.

const FUND_PREFIX_MAP = [
  { kw: [
      'non-farm payroll','nonfarm payroll','non farm payroll',' nfp ','nfp:',
      'jobless claim','initial claim','unemployment claim','continuing claim',
      'ism manufacturing','ism non-manuf','ism pmi','ism services',
      'core pce','personal consumption expend',
      'jolts','job openings','adp employment','adp nonfarm','adp jobs','adp report',
      'chicago pmi','existing home sales','new home sales','capacity utilization',
      'personal income','personal spending','consumer spending','michigan sentiment','michigan consumer',
      'us cpi','us gdp','us ppi','us retail','us trade','us employ','us unemploy',
      'us job','us inflation','us consumer','us producer','us housing','us wage','us durable',
      'u.s. cpi','u.s. gdp','u.s. employ','u.s. unemploy',
      'united states cpi','united states gdp','united states unemploy',
    ], cur: 'USD' },
  { kw: [
      'german cpi','german gdp','german ifo','german retail','german inflation','german unemploy','german pmi','german trade','german wage',
      'germany cpi','germany gdp','germany unemploy','germany retail','germany pmi','germany trade',
      'eurozone cpi','eurozone gdp','eurozone unemploy','eurozone pmi','eurozone retail','eurozone inflation','eurozone trade','eurozone current account',
      'euro zone cpi','euro zone gdp','euro zone unemploy',
      'euro area cpi','euro area gdp','euro area unemploy','euro area pmi','euro area current account',
      'ez cpi','ez gdp','ez pmi',
      'zew','ifo business','ifo climate','gfk',
      'french cpi','french gdp','french unemploy','france cpi','france gdp',
      'italian cpi','italian gdp','italy cpi','italy gdp',
    ], cur: 'EUR' },
  { kw: [
      'uk cpi','uk gdp','uk retail','uk employ','uk unemploy','uk inflation','uk pmi','uk trade','uk wage','uk earnings','uk average earnings','uk industrial',
      'u.k. cpi','u.k. gdp','u.k. unemploy',
      'british cpi','british gdp','british unemploy','british retail',
      'united kingdom cpi','united kingdom gdp','united kingdom unemploy',
      'claimant count',
    ], cur: 'GBP' },
  { kw: [
      'japan cpi','japan gdp','japan retail','japan trade','japan industrial','japan unemploy','japan pmi','japan wage','japan inflation','japan current account',
      'japanese cpi','japanese gdp','japanese retail','japanese trade','japanese industrial','japanese unemploy','japanese pmi','japanese wage','japanese current account',
      'tankan',
    ], cur: 'JPY' },
  { kw: [
      'canada cpi','canada gdp','canada employ','canada unemploy','canada retail','canada trade','canada inflation','canada pmi','canada housing',
      'canadian cpi','canadian gdp','canadian employ','canadian unemploy','canadian retail','canadian trade','canadian inflation','canadian pmi',
      'ivey pmi','ivey purchasing',
    ], cur: 'CAD' },
  { kw: [
      'australia cpi','australia gdp','australia employ','australia unemploy','australia retail','australia trade','australia inflation','australia pmi','australia building','australia consumer','australia business','australia wage',
      'australian cpi','australian gdp','australian employ','australian unemploy','australian retail','australian trade','australian inflation','australian pmi','australian building','australian consumer','australian business','australian wage',
      'nab business','nab confidence','nab survey',
    ], cur: 'AUD' },
  { kw: [
      'new zealand cpi','new zealand gdp','new zealand employ','new zealand unemploy','new zealand trade','new zealand retail','new zealand inflation','new zealand pmi','new zealand business',
      'nz cpi','nz gdp','nz employ','nz unemploy','nz trade','nz retail','nz pmi','nz inflation',
    ], cur: 'NZD' },
  { kw: [
      'swiss cpi','swiss gdp','swiss trade','swiss unemploy','swiss employ','swiss inflation','swiss pmi','swiss retail','swiss industrial','swiss consumer','swiss business','swiss wage',
      'switzerland cpi','switzerland gdp','switzerland unemploy','switzerland employ','switzerland trade','switzerland retail','switzerland inflation','switzerland pmi','switzerland industrial',
      'kof economic','kof barometer',
    ], cur: 'CHF' },
];

const COUNTRY_STRIP = {
  USD: ['united states ','u.s. ','us '],
  EUR: ['euro area ','eurozone ','euro zone ','german ','germany ','french ','france ','italian ','italy ','ez '],
  GBP: ['united kingdom ','british ','england ','uk ','u.k. '],
  JPY: ['japanese ','japan '],
  CAD: ['canadian ','canada '],
  AUD: ['australian ','australia '],
  NZD: ['new zealand ','nz '],
  CHF: ['switzerland ','swiss '],
};

// Fallback currency detection — dipakai HANYA kalau FUND_PREFIX_MAP (di atas) gagal
// match DAN judul berformat rilis kalender (lihat isCalendarFormat di
// parseFundamentalFromHeadline). FUND_PREFIX_MAP butuh frasa nama-negara+indikator
// nempel langsung ("eurozone cpi"), jadi gagal kalau ada kata sisipan seperti "Core"
// atau "Flash" di antaranya ("Eurozone Core CPI YoY", "Eurozone Flash CPI y/y").
// Nama negara di-cek sendiri (word-boundary, bukan .includes menyeluruh) — aman
// dipakai lebih longgar karena sudah dijaga gate isCalendarFormat di pemanggil.
const FUND_COUNTRY_ONLY = [
  { re: /\b(united states|u\.s\.|us)\b/,                                  cur: 'USD' },
  { re: /\b(eurozone|euro area|euro zone|germany|german|france|french|italy|italian)\b/, cur: 'EUR' },
  { re: /\b(united kingdom|u\.k\.|uk|britain|british)\b/,                 cur: 'GBP' },
  { re: /\b(japan|japanese)\b/,                                           cur: 'JPY' },
  { re: /\b(canada|canadian)\b/,                                          cur: 'CAD' },
  { re: /\b(australia|australian)\b/,                                     cur: 'AUD' },
  { re: /\b(new zealand|nz)\b/,                                           cur: 'NZD' },
  { re: /\b(switzerland|swiss)\b/,                                        cur: 'CHF' },
];

const FUND_INDICATOR_MAP = [
  { kw: ['non-farm payroll','nonfarm payroll','non farm payroll',' nfp ','nfp:'], key: 'NFP' },
  { kw: ['continuing claim'],                                                     key: 'Continuing Claims' },
  { kw: ['jobless claim','initial claim','unemployment claim'],                   key: 'Jobless Claims' },
  { kw: ['ism manufacturing','ism pmi manufactur'],                               key: 'ISM Manufacturing' },
  { kw: ['ism services','ism non-manuf','ism non manuf'],                         key: 'ISM Services' },
  { kw: ['core pce','personal consumption expend'],                               key: 'Core PCE' },
  { kw: ['core cpi','core consumer price','core inflation'],                      key: 'Core CPI MoM' },
  { kw: ['tankan'],                                                               key: 'Tankan Mfg Index' },
  { kw: ['ivey pmi','ivey purchasing'],                                           key: 'Ivey PMI' },
  { kw: ['nab business','nab confidence','nab survey'],                           key: 'NAB Business Conf' },
  { kw: ['zew'],                                                                  key: 'ZEW Sentiment' },
  { kw: ['ifo business','ifo climate'],                                           key: 'IFO Business' },
  { kw: ['gfk'],                                                                  key: 'GfK Consumer Climate' },
  { kw: ['claimant count'],                                                       key: 'Claimant Count' },
  { kw: ['kof economic','kof barometer'],                                         key: 'KOF Barometer' },
  { kw: ['jolts','job openings'],                                                 key: 'JOLTS Job Openings' },
  { kw: ['adp employment','adp nonfarm','adp jobs','adp report'],                 key: 'ADP Employment' },
  { kw: ['chicago pmi'],                                                          key: 'Chicago PMI' },
  { kw: ['existing home sales'],                                                  key: 'Existing Home Sales' },
  { kw: ['new home sales'],                                                       key: 'New Home Sales' },
  { kw: ['personal income'],                                                      key: 'Personal Income' },
  { kw: ['personal spending','consumer spending'],                                key: 'Personal Spending' },
  { kw: ['capacity utilization'],                                                 key: 'Capacity Utilization' },
  { kw: ['factory orders'],                                                       key: 'Factory Orders' },
  { kw: ['manufacturing pmi'],                                                    key: 'Manufacturing PMI' },
  { kw: ['services pmi','service pmi','non-manufacturing pmi'],                   key: 'Services PMI' },
  { kw: ['composite pmi'],                                                        key: 'Composite PMI' },
  { kw: ['industrial production'],                                                key: 'Industrial Production' },
  { kw: ['trade balance'],                                                        key: 'Trade Balance' },
  { kw: ['current account'],                                                      key: 'Current Account' },
  { kw: ['employment change','employment count','jobs change'],                   key: 'Employment Change' },
  { kw: ['unemployment rate'],                                                    key: 'Unemployment Rate' },
  { kw: ['participation rate'],                                                   key: 'Participation Rate' },
  { kw: ['average earnings','average hourly earnings','wage growth'],             key: 'Wage Growth' },
  { kw: ['retail sales'],                                                         key: 'Retail Sales MoM' },
  { kw: ['producer price',' ppi ','ppi m/m'],                                    key: 'PPI MoM' },
  { kw: ['flash cpi','cpi flash'],                                                key: 'CPI Flash YoY' },
  { kw: ['german cpi','germany cpi'],                                             key: 'German CPI YoY' },
  { kw: ['cpi y/y','cpi yoy','cpi annual','consumer price index y'],             key: 'CPI YoY' },
  { kw: ['cpi q/q','cpi qq','cpi quarter'],                                      key: 'CPI QoQ' },
  { kw: ['cpi m/m','cpi mom','consumer price index m'],                          key: 'CPI MoM' },
  { kw: ['consumer price index','consumer prices'],                               key: 'CPI YoY' },
  { kw: ['gdp q/q','gdp qq','gdp quarter','gdp prelim','gdp flash','gdp growth'],key: 'GDP QoQ' },
  { kw: ['gdp m/m','gdp mom','gdp monthly'],                                     key: 'GDP MoM' },
  { kw: ['gdp'],                                                                  key: 'GDP QoQ' },
  { kw: ['retail sales yoy','retail sales y/y','retail sales annual'],           key: 'Retail Sales YoY' },
  { kw: ['building approval','construction approval'],                            key: 'Building Approvals' },
  { kw: ['building permit'],                                                      key: 'Building Permits' },
  { kw: ['consumer confidence','consumer sentiment','consumer morale','michigan sentiment'], key: 'Consumer Confidence' },
  { kw: ['business confidence','business sentiment','business climate'],          key: 'Business Confidence' },
  { kw: ['housing start','home start'],                                           key: 'Housing Starts' },
  { kw: ['durable goods'],                                                        key: 'Durable Goods Orders' },
  { kw: ['flash gdp','gdp advance'],                                              key: 'GDP QoQ Flash' },
  { kw: ['inflation rate','inflation data'],                                      key: 'CPI YoY' },
];

const CB_RATE_MAP = [
  { kw: ['federal reserve','fed ','fomc rate','fed rate','fed funds'],       cur: 'USD' },
  { kw: ['european central bank','ecb rate','ecb deposit','ecb interest'],   cur: 'EUR' },
  { kw: ['bank of england','boe rate','boe bank rate','mpc rate'],           cur: 'GBP' },
  { kw: ['bank of japan','boj rate','boj policy','boj interest'],            cur: 'JPY' },
  { kw: ['reserve bank of australia','rba rate','rba cash rate'],            cur: 'AUD' },
  { kw: ['reserve bank of new zealand','rbnz rate','rbnz ocr'],              cur: 'NZD' },
  { kw: ['bank of canada','boc rate','boc overnight','boc interest'],        cur: 'CAD' },
  { kw: ['swiss national bank','snb rate','snb policy'],                     cur: 'CHF' },
];

// Indicators whose values must be counts (K/M suffix), never percentages.
// A headline yielding e.g. NFP=0.0% is a parse error — reject it.
// NOTE: 'Employment Change' intentionally excluded — NZD reports this as QoQ %
// (e.g. "0.2%"), so rejecting % would silently discard all NZD updates.
// NOTE: 'Building Approvals' (AU) intentionally excluded — reported as MoM %
// (matches its FUND_SCORE_RULES dir/threshold), unlike 'Building Permits' (US),
// which is an absolute count (e.g. "1.45M").
const QUANTITY_INDICATORS = new Set([
  'NFP', 'Jobless Claims', 'Claimant Count', 'Continuing Claims',
  'Building Permits', 'Housing Starts', 'Durable Goods Orders',
  'JOLTS Job Openings', 'ADP Employment', 'Existing Home Sales', 'New Home Sales',
]);

function parseFundamentalFromHeadline(title) {
  const t = title.toLowerCase();

  let currency = null;
  for (const { kw, cur } of FUND_PREFIX_MAP) {
    if (kw.some(k => t.includes(k))) { currency = cur; break; }
  }
  // Rilis kalender ("... Actual X Forecast Y Previous Z") adalah sinyal kuat —
  // kalau format ini match tapi FUND_PREFIX_MAP tidak (karena kata sisipan seperti
  // "Core"/"Flash" antara nama negara & indikator), coba fallback nama-negara saja.
  const isCalendarFormat = !currency && /\bactual\b/i.test(t) && (/\bforecast\b/i.test(t) || /\bprevious\b/i.test(t));
  if (isCalendarFormat) {
    for (const { re, cur } of FUND_COUNTRY_ONLY) {
      if (re.test(t)) { currency = cur; break; }
    }
  }
  if (!currency) return null;

  let indicatorKey = null;
  for (const { kw, key } of FUND_INDICATOR_MAP) {
    if (kw.some(k => t.includes(k))) { indicatorKey = key; break; }
  }

  // Disambiguate Core PCE: YoY vs MoM — store separately so YoY headlines don't overwrite MoM seed.
  if (indicatorKey === 'Core PCE') {
    if (/y\/y|yoy|annual|year.on.year/i.test(t)) indicatorKey = 'Core PCE YoY';
    // MoM or ambiguous → keep 'Core PCE' (matches the seed key)
  }
  // Same for Core CPI
  if (indicatorKey === 'Core CPI MoM') {
    if (/y\/y|yoy|annual|year.on.year/i.test(t)) indicatorKey = 'Core CPI YoY';
  }
  // Flash/preliminary qualifier — kata "flash" bisa muncul di posisi mana pun di judul
  // ("Flash CPI", "CPI Flash", "CPI YoY Flash" — feed FinancialJuice paling sering
  // pakai bentuk terakhir, indikator dulu baru "Flash" di akhir). Kata sisipan ini
  // membuat keyword adjacency 'flash cpi'/'cpi flash' di FUND_INDICATOR_MAP di atas
  // gagal match, jadi redirect di sini berdasarkan base key yang sudah ketemu —
  // supaya nempel ke key seed yang sama ('CPI Flash YoY'/'GDP QoQ Flash'), bukan
  // bikin row terpisah yang isinya sama tapi nama key beda.
  if (/\bflash\b/i.test(t)) {
    if (indicatorKey === 'CPI YoY') indicatorKey = 'CPI Flash YoY';
    else if (indicatorKey === 'GDP QoQ') indicatorKey = 'GDP QoQ Flash';
  }

  if (!indicatorKey) {
    let stripped = title.trim();
    const strips = (COUNTRY_STRIP[currency] || []).sort((a, b) => b.length - a.length);
    for (const term of strips) {
      const re = new RegExp(`^${term}`, 'i');
      if (re.test(stripped)) { stripped = stripped.replace(re, '').trim(); break; }
    }
    stripped = stripped
      .replace(/\s*[:\-]?\s*(?:actual|act\.?)\s+[+-]?\d+.*$/i, '')
      .replace(/\s+[+-]?\d+\.?\d*\s*(?:%|[KMBbps]|pts?).*$/i, '')
      .replace(/\s*\(.*$/i, '')
      .trim();
    if (stripped && stripped.length >= 3 && stripped.length <= 60) {
      indicatorKey = stripped.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  }

  if (!indicatorKey) return null;

  let value = null;
  const fjActual = title.match(/[Aa]ctual\s+([+-]?\d+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?/);
  if (fjActual) {
    value = fjActual[1] + (fjActual[2] || '');
  } else {
    const m = title.match(/([+-]?\d+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?(?:\s|$|,|\(|vs)/);
    if (m) value = m[1] + (m[2] || '');
  }
  if (!value) return null;

  // Reject % values for count-based indicators (e.g. NFP=0.0% is a parse error).
  if (QUANTITY_INDICATORS.has(indicatorKey) && value.endsWith('%')) return null;

  let previous = null;
  const fjPrev = title.match(/[Pp]revious\s+([+-]?\d+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?/);
  if (fjPrev) previous = fjPrev[1] + (fjPrev[2] || '');

  return { currency, key: indicatorKey, value, previous };
}

function parseCBDecision(title) {
  const t = title.toLowerCase();
  if (!/rate|interest|bps|basis point|hold|hike|cut|raise|lower|unchanged/i.test(t)) return null;

  let currency = null;
  for (const { kw, cur } of CB_RATE_MAP) {
    if (kw.some(k => t.includes(k))) { currency = cur; break; }
  }
  if (!currency) return null;

  const isCut  = /\bcut\b|\blower\b|\breduced?\b/i.test(t);
  const isHike = /\bhike\b|\braise[sd]?\b|\bincreas\b|\btighten/i.test(t);
  const isHold = /\bhold\b|\bunchanged\b|\bleave[sd]?\b|\bkeep[s]?\b|\bmaintain/i.test(t);
  if (!isCut && !isHike && !isHold) return null;
  const decision = isCut ? 'cut' : isHike ? 'hike' : 'hold';

  const absM = title.match(/(?:at|to)\s+([+-]?\d+\.?\d*)\s*%/i);
  const bpsM = title.match(/(\d+\.?\d*)\s*bps/i);
  const rate = absM ? parseFloat(absM[1]) : null;
  let   bps  = bpsM ? parseFloat(bpsM[1]) : null;
  if (bps !== null && isCut && bps > 0) bps = -bps;
  if (rate === null && bps === null) return null;

  return { currency, rate, bps, decision };
}

// redisCmd is passed as parameter so this module stays free of env dependencies
async function autoUpdateFundamentals(headlines, redisCmd) {
  const byCurrency = {};
  const now = new Date().toISOString().slice(0, 10);

  for (const item of headlines) {
    const fund = parseFundamentalFromHeadline(item.title);
    if (fund) {
      if (!byCurrency[fund.currency]) byCurrency[fund.currency] = [];
      byCurrency[fund.currency].push({ key: fund.key, value: fund.value, headlinePrev: fund.previous });
    }

    const cb = parseCBDecision(item.title);
    if (cb) {
      try {
        const existing = await redisCmd('HGET', 'cb_decisions', cb.currency);
        const prev = existing ? JSON.parse(existing) : {};
        const entry = {
          rate:            cb.rate ?? prev.rate ?? null,
          last_bps:        cb.bps  ?? prev.last_bps ?? 0,
          last_decision:   cb.decision,
          last_meeting:    now,
          updated_at:      new Date().toISOString(),
          source_headline: item.title.slice(0, 120),
        };
        await redisCmd('HSET', 'cb_decisions', cb.currency, JSON.stringify(entry));
      } catch(e) { console.warn('cb_decisions write failed:', e.message); }
    }
  }

  const updated = {};
  for (const [currency, items] of Object.entries(byCurrency)) {
    try {
      const existingRaw = await redisCmd('HMGET', `fundamental:${currency}`, ...items.map(i => i.key));
      const args = ['HSET', `fundamental:${currency}`];
      for (let i = 0; i < items.length; i++) {
        const { key, value, headlinePrev } = items[i];
        const entry = { actual: value, period: '—', date: now, source: 'headline' };
        // Headline "Previous X" takes priority; fall back to existing Redis value
        if (headlinePrev && headlinePrev !== value) {
          entry.previous = headlinePrev;
        } else if (existingRaw && existingRaw[i]) {
          try {
            const prev = JSON.parse(existingRaw[i]);
            if (prev.actual && prev.actual !== value) entry.previous = prev.actual;
          } catch(_) {}
        }
        args.push(key, JSON.stringify(entry));
      }
      await redisCmd(...args);
      updated[currency] = items.map(i => i.key);
      console.log(`Fundamental updated: ${currency} — ${items.map(i => i.key).join(', ')}`);
    } catch(e) { console.warn(`fundamental HSET failed for ${currency}:`, e.message); }
  }
  return updated;
}

module.exports = { parseFundamentalFromHeadline, parseCBDecision, autoUpdateFundamentals };
