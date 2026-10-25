'use strict';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_STATES = new Set(['bullish', 'bearish', 'mixed', 'neutral', 'insufficient']);

const ACTIVITY_RX = /(gdp|pmi|industrial production|factory orders|durable goods|retail sales|household spending|business confidence|consumer confidence|ifo|zew|kof|tankan|trade balance|current account|new home sales|building approvals|housing starts)/i;
const LABOUR_RX = /(nfp|non.?farm|employment change|unemployment|jobless claims|claimant count|labor force|labour force|payroll|wage|earnings)/i;
const INFLATION_RX = /(cpi|pce|ppi|inflation|consumer price|producer price|wage|earnings)/i;
const INVERSE_RX = /(unemployment|jobless claims|claimant count)/i;
const QUARTERLY_RX = /(qoq|quarter|tankan)/i;
const WEEKLY_RX = /(jobless claims)/i;

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseEconomicValue(value) {
  if (value == null || value === '' || value === '—') return null;
  const s = String(value).trim().replace(/,/g, '');
  const match = s.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  let n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  const suffix = s.slice(match.index + match[0].length).trim().charAt(0).toUpperCase();
  if (suffix === 'K') n *= 1e3;
  else if (suffix === 'M') n *= 1e6;
  else if (suffix === 'B') n *= 1e9;
  else if (suffix === 'T') n *= 1e12;
  return n;
}

function parseDateMs(value) {
  if (!value || value === '—') return null;
  const ms = Date.parse(String(value).length === 10 ? `${value}T00:00:00Z` : String(value));
  return Number.isFinite(ms) ? ms : null;
}

function maxAgeDaysForIndicator(name) {
  if (WEEKLY_RX.test(name)) return 21;
  if (QUARTERLY_RX.test(name)) return 150;
  return 75;
}

function releaseSignal(name, entry, nowMs = Date.now()) {
  if (!entry || String(entry.source || '').toLowerCase() === 'seed') return null;
  const dateMs = parseDateMs(entry.date || entry.period);
  if (dateMs == null) return null;
  const ageDays = Math.max(0, Math.floor((nowMs - dateMs) / 86400000));
  const maxAgeDays = maxAgeDaysForIndicator(name);
  if (ageDays > maxAgeDays) return null;

  const actual = parseEconomicValue(entry.actual);
  const forecast = parseEconomicValue(entry.forecast);
  const previous = parseEconomicValue(entry.previous);
  if (actual == null) return null;
  const reference = forecast != null ? forecast : previous;
  if (reference == null) return null;
  const tolerance = Math.max(Math.abs(reference) * 0.005, 1e-9);
  let signal = Math.abs(actual - reference) <= tolerance ? 0 : actual > reference ? 1 : -1;
  if (INVERSE_RX.test(name)) signal *= -1;
  return {
    indicator: name,
    signal,
    actual: entry.actual,
    forecast: entry.forecast ?? null,
    previous: entry.previous ?? null,
    date: entry.date || null,
    age_days: ageDays,
    comparison: forecast != null ? 'forecast' : 'previous',
    family: LABOUR_RX.test(name) ? 'labour' : INFLATION_RX.test(name) ? 'inflation' : 'activity',
  };
}

function summarizeSignals(evidence, minDirectional = 2) {
  const directional = evidence.filter(x => x.signal !== 0);
  if (directional.length < minDirectional) {
    return { state: evidence.length ? 'neutral' : 'insufficient', confidence: 'rendah', evidence };
  }
  const positive = directional.filter(x => x.signal > 0).length;
  const negative = directional.length - positive;
  const ratio = Math.max(positive, negative) / directional.length;
  if (positive && negative && ratio < 0.67) return { state: 'mixed', confidence: 'rendah', evidence };
  const state = positive > negative ? 'bullish' : negative > positive ? 'bearish' : 'mixed';
  const confidence = directional.length >= 4 && ratio >= 0.75 ? 'tinggi' : ratio >= 0.67 ? 'sedang' : 'rendah';
  return { state, confidence, evidence };
}

function buildGrowth(indicators, nowMs = Date.now()) {
  const activity = [];
  const labour = [];
  for (const [name, entry] of Object.entries(indicators || {})) {
    if (!ACTIVITY_RX.test(name) && !LABOUR_RX.test(name)) continue;
    const ev = releaseSignal(name, entry, nowMs);
    if (!ev) continue;
    (LABOUR_RX.test(name) ? labour : activity).push(ev);
  }
  const a = summarizeSignals(activity, 2);
  const l = summarizeSignals(labour, 1);
  let state = 'insufficient';
  if (['bullish', 'bearish'].includes(a.state) && a.state === l.state) state = a.state;
  else if (a.state === 'mixed' || l.state === 'mixed' ||
    (['bullish', 'bearish'].includes(a.state) && ['bullish', 'bearish'].includes(l.state) && a.state !== l.state)) state = 'mixed';
  else if (a.state === 'neutral' && l.state === 'neutral') state = 'neutral';
  const confidence = state === 'bullish' || state === 'bearish'
    ? (a.confidence === 'tinggi' && l.confidence !== 'rendah' ? 'tinggi' : 'sedang')
    : 'rendah';
  return {
    state,
    confidence,
    freshness: [...activity, ...labour].length ? 'fresh' : 'insufficient',
    evidence: [...activity, ...labour].sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 10),
    buckets: { activity: a.state, labour: l.state },
  };
}

function cbState(bank) {
  if (!bank || !bank.bias) return 'insufficient';
  const bias = String(bank.bias).toLowerCase();
  if (bias.includes('hawkish')) return 'bullish';
  if (bias.includes('dovish')) return 'bearish';
  if (bias.includes('split')) return 'mixed';
  if (bias.includes('neutral') || bias.includes('hold') || bias.includes('data dependent')) return 'neutral';
  return 'insufficient';
}

function buildCentralBank(bank, nowMs = Date.now()) {
  const updatedMs = parseDateMs(bank?.bias_updated || bank?.rate_as_of || bank?.last_meeting);
  const ageDays = updatedMs == null ? null : Math.max(0, Math.floor((nowMs - updatedMs) / 86400000));
  const evidence = Array.isArray(bank?.source_headlines)
    ? bank.source_headlines.slice(0, 5).map(h => ({ title: cleanText(h.title), matched_at: h.matched_at || null })).filter(h => h.title)
    : [];
  let state = cbState(bank);
  if (ageDays == null || ageDays > 21 || (state !== 'neutral' && evidence.length === 0)) state = 'insufficient';
  const confidenceRaw = String(bank?.confidence || '').toLowerCase();
  const confidence = confidenceRaw.includes('high') ? 'tinggi' : confidenceRaw.includes('medium') ? 'sedang' : 'rendah';
  return {
    state,
    confidence: state === 'insufficient' ? 'rendah' : confidence,
    freshness: ageDays == null ? 'unknown' : ageDays > 21 ? 'stale' : 'fresh',
    evidence,
    bias: bank?.bias || null,
    rate: bank?.rate ?? null,
    last_decision: bank?.last_decision || null,
    as_of: bank?.bias_updated || bank?.rate_as_of || bank?.last_meeting || null,
  };
}

function buildInflation(indicators, centralBank, nowMs = Date.now()) {
  const evidence = [];
  for (const [name, entry] of Object.entries(indicators || {})) {
    if (!INFLATION_RX.test(name)) continue;
    const ev = releaseSignal(name, entry, nowMs);
    if (ev) evidence.push(ev);
  }
  const impulse = summarizeSignals(evidence, 2);
  let state = impulse.state;
  if (impulse.state === 'bullish') state = centralBank.state === 'bullish' ? 'bullish' : 'mixed';
  else if (impulse.state === 'bearish') state = centralBank.state === 'bearish' ? 'bearish' : 'mixed';
  return {
    state,
    confidence: ['bullish', 'bearish'].includes(state) ? impulse.confidence : 'rendah',
    freshness: evidence.length ? 'fresh' : 'insufficient',
    evidence: evidence.sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 8),
    inflation_impulse: impulse.state,
    policy_context: centralBank.state,
  };
}

const INSTITUTIONS = [
  ['MUFG', /\bMUFG\b/i], ['Crédit Agricole', /\bCr[eé]dit Agricole\b/i],
  ['ING', /\bING\b/i], ['Goldman Sachs', /\bGoldman Sachs\b/i],
  ['JPMorgan', /\bJ\.?P\.?\s*Morgan\b|\bJPMorgan\b/i], ['Citi', /\bCiti(?:bank|group)?\b/i],
  ['Barclays', /\bBarclays\b/i], ['Deutsche Bank', /\bDeutsche Bank\b/i],
  ['Morgan Stanley', /\bMorgan Stanley\b/i], ['UBS', /\bUBS\b/i],
  ['BNP Paribas', /\bBNP Paribas\b/i], ['Societe Generale', /\bSoc(?:iete|i[eé]t[eé]) Generale\b|\bSocGen\b/i],
];
const CUR_RX = {
  USD: /\bUSD\b|\bUS dollar\b|\bdollar\b/i, EUR: /\bEUR\b|\beuro\b/i,
  GBP: /\bGBP\b|\bsterling\b|\bpound\b/i, JPY: /\bJPY\b|\byen\b/i,
  CHF: /\bCHF\b|\bSwiss franc\b/i, CAD: /\bCAD\b|\bCanadian dollar\b|\bloonie\b/i,
  AUD: /\bAUD\b|\bAustralian dollar\b|\baussie\b/i, NZD: /\bNZD\b|\bNew Zealand dollar\b|\bkiwi\b/i,
};
const BANK_EXCLUDE_RX = /(seminar|webinar|conference|podcast|cftc positions|positioning chart|recap|watch live|registration)/i;
const FORWARD_RX = /(expect|forecast|outlook|target|see(?:s|ing)?|likely|should|could|next week|next month|year.end|ahead|project)/i;
const POSITIVE_RX = /(bullish|upside|rise|rally|gain|strengthen|appreciat|higher)/i;
const NEGATIVE_RX = /(bearish|downside|fall|decline|weaken|depreciat|lower)/i;
const PAIR_RX = /\b(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)[\/-](USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)\b/gi;

function extractBankStances(items, nowMs = Date.now()) {
  const out = [];
  for (const item of items || []) {
    const title = cleanText(item.title);
    const description = cleanText(item.description || item.body || '');
    const text = `${title}. ${description}`.trim();
    if (!text || BANK_EXCLUDE_RX.test(text) || !FORWARD_RX.test(text)) continue;
    const institution = INSTITUTIONS.find(([, rx]) => rx.test(text));
    if (!institution) continue;
    const positive = POSITIVE_RX.test(text);
    const negative = NEGATIVE_RX.test(text);
    if (positive === negative) continue;
    const publishedMs = parseDateMs(item.pubDate || item.published_at || item.date);
    if (publishedMs == null || nowMs - publishedMs > 35 * 86400000) continue;
    const pairs = [...text.matchAll(PAIR_RX)].map(m => [m[1].toUpperCase(), m[2].toUpperCase()]);
    const uniquePairs = [...new Map(pairs.map(pair => [pair.join('/'), pair])).values()];
    let directions = [];
    if (uniquePairs.length === 1) {
      const [base, quote] = uniquePairs[0];
      directions = positive
        ? [[base, 'bullish'], [quote, 'bearish']]
        : [[base, 'bearish'], [quote, 'bullish']];
    } else if (uniquePairs.length === 0) {
      const currencies = Object.entries(CUR_RX).filter(([, rx]) => rx.test(text)).map(([cur]) => cur);
      if (currencies.length !== 1) continue;
      directions = [[currencies[0], positive ? 'bullish' : 'bearish']];
    } else continue;
    const articleId = String(item.guid || item.id || item.link || title);
    for (const [currency, direction] of directions) out.push({
      institution: institution[0], currency, direction, horizon: 'week_ahead',
      condition: null, reason: title, evidence: text.slice(0, 500),
      article_id: `${articleId}:${currency}`,
      published_at: new Date(publishedMs).toISOString(),
    });
  }
  return out;
}

function buildBanks(currency, stances) {
  const latestByInstitution = new Map();
  for (const stance of stances || []) {
    if (stance.currency !== currency || !['bullish', 'bearish'].includes(stance.direction)) continue;
    const prev = latestByInstitution.get(stance.institution);
    if (!prev || String(stance.published_at) > String(prev.published_at)) latestByInstitution.set(stance.institution, stance);
  }
  const evidence = [...latestByInstitution.values()];
  if (!evidence.length) return { state: 'insufficient', confidence: 'rendah', freshness: 'insufficient', institutions: [], evidence: [] };
  const bull = evidence.filter(x => x.direction === 'bullish').length;
  const bear = evidence.length - bull;
  const state = bull && bear ? 'mixed' : bull ? 'bullish' : 'bearish';
  return {
    state,
    confidence: evidence.length >= 3 && state !== 'mixed' ? 'tinggi' : evidence.length >= 2 ? 'sedang' : 'rendah',
    freshness: 'fresh', institutions: evidence.map(x => x.institution), evidence,
  };
}

function signedPositionState(netPct) {
  const value = Number(netPct);
  if (!Number.isFinite(value)) return 'insufficient';
  if (Math.abs(value) < 3) return 'neutral';
  return value > 0 ? 'bullish' : 'bearish';
}

function buildPositioning(currency, cotPayload, retailByCurrency, nowMs = Date.now()) {
  const p = cotPayload?.positions?.[currency];
  const reportMs = parseDateMs(cotPayload?.report_date);
  const reportAge = reportMs == null ? null : Math.max(0, Math.floor((nowMs - reportMs) / 86400000));
  const am = signedPositionState(p?.am_net_pct_oi ?? (p?.oi ? p.am_net / p.oi * 100 : null));
  const lev = signedPositionState(p?.lev_net_pct_oi ?? (p?.oi ? p.lev_net / p.oi * 100 : null));
  let institutionalState = 'insufficient';
  if (reportAge != null && reportAge <= 14) {
    if (am === lev) institutionalState = am;
    else if (am === 'neutral') institutionalState = lev;
    else if (lev === 'neutral') institutionalState = am;
    else institutionalState = 'mixed';
  }
  const rawRetail = retailByCurrency?.[currency] || null;
  const longPct = Number(rawRetail?.long_pct);
  const retailState = !Number.isFinite(longPct) ? 'insufficient' : longPct >= 55 ? 'bullish' : longPct <= 45 ? 'bearish' : 'neutral';
  let state = institutionalState;
  if (['bullish', 'bearish'].includes(institutionalState) && ['bullish', 'bearish'].includes(retailState) && institutionalState !== retailState) state = 'mixed';
  return {
    state,
    confidence: state === 'insufficient' ? 'rendah' : state === 'mixed' ? 'rendah' : 'sedang',
    freshness: reportAge == null || reportAge > 14 ? 'stale' : 'fresh',
    institutional: {
      state: institutionalState,
      asset_manager: { state: am, net: p?.am_net ?? null, net_pct_oi: p?.am_net_pct_oi ?? null, change_net: p?.am_change_net ?? null },
      leveraged_funds: { state: lev, net: p?.lev_net ?? null, net_pct_oi: p?.lev_net_pct_oi ?? null, change_net: p?.lev_change_net ?? null },
      report_date: cotPayload?.report_date || null,
      release_date: cotPayload?.release_date || null,
    },
    retail: {
      state: retailState,
      long_pct: Number.isFinite(longPct) ? longPct : null,
      short_pct: Number.isFinite(Number(rawRetail?.short_pct)) ? Number(rawRetail.short_pct) : null,
      as_of: rawRetail?.as_of || rawRetail?.fetched_at || null,
      source_label: 'Dukascopy',
      coverage_note: 'Sampel liquidity consumers SWFX, bukan retail global.',
    },
    evidence: p ? [{ family: 'cftc_tff', report_date: cotPayload?.report_date || null }] : [],
  };
}

function buildOverall({ growth, inflation, central_bank: centralBank, banks, positioning }) {
  const core = [growth, inflation, centralBank];
  const directional = core.map(x => x.state).filter(x => x === 'bullish' || x === 'bearish');
  const bull = directional.filter(x => x === 'bullish').length;
  const bear = directional.length - bull;
  let state = 'insufficient';
  const inflationDependsOnPolicy = ['bullish', 'bearish'].includes(inflation.state)
    && inflation.policy_context === inflation.state;
  const dependentPairOnly = !['bullish', 'bearish'].includes(growth.state)
    && inflationDependsOnPolicy && inflation.state === centralBank.state;
  if (directional.length >= 2 && !dependentPairOnly) {
    if (bull >= 2 && bear === 0) state = 'bullish';
    else if (bear >= 2 && bull === 0) state = 'bearish';
    else state = 'mixed';
  } else if (core.some(x => x.state === 'mixed')) state = 'mixed';

  const confirmations = [];
  const conflicts = [];
  for (const [name, layer] of [['banks', banks], ['positioning', positioning]]) {
    if (!['bullish', 'bearish'].includes(state)) continue;
    if (layer.state === state) confirmations.push(name);
    else if (['bullish', 'bearish', 'mixed'].includes(layer.state)) conflicts.push(name);
  }
  const missing = [
    ['growth', growth], ['inflation', inflation], ['central_bank', centralBank], ['banks', banks], ['positioning', positioning],
  ].filter(([, x]) => x.state === 'insufficient').map(([name]) => name);
  let confidence = 'rendah';
  if (['bullish', 'bearish'].includes(state)) {
    confidence = directional.length === 3 && conflicts.length === 0 && confirmations.length >= 1 ? 'tinggi'
      : conflicts.length === 0 ? 'sedang' : 'rendah';
  }
  return {
    state, confidence, confirmations, conflicts, missing,
    rationale_codes: [
      directional.length < 2 ? 'core_coverage_low' : 'core_coverage_ok',
      inflationDependsOnPolicy ? 'inflation_policy_context_overlap' : 'inflation_policy_independent',
      dependentPairOnly ? 'core_independence_low' : 'core_independence_ok',
      bull && bear ? 'core_conflict' : 'core_consistent',
      ...confirmations.map(x => `${x}_confirms`), ...conflicts.map(x => `${x}_conflicts`),
    ],
  };
}

function buildSmartBiasRows({ fundamentals = {}, cbBanks = [], cot = {}, bankItems = [], bankStances = null, retailByCurrency = {}, nowMs = Date.now() } = {}) {
  const extracted = Array.isArray(bankStances) ? bankStances : extractBankStances(bankItems, nowMs);
  return CURRENCIES.map(currency => {
    const central_bank = buildCentralBank(cbBanks.find(x => x.currency === currency), nowMs);
    const growth = buildGrowth(fundamentals[currency], nowMs);
    const inflation = buildInflation(fundamentals[currency], central_bank, nowMs);
    const banks = buildBanks(currency, extracted);
    const positioning = buildPositioning(currency, cot, retailByCurrency, nowMs);
    const overall = buildOverall({ growth, inflation, central_bank, banks, positioning });
    return { currency, as_of: new Date(nowMs).toISOString(), growth, inflation, central_bank, banks, positioning, overall };
  });
}

module.exports = {
  CURRENCIES, VALID_STATES, cleanText, parseEconomicValue, releaseSignal,
  summarizeSignals, buildGrowth, buildInflation, buildCentralBank,
  extractBankStances, buildBanks, buildPositioning, buildOverall, buildSmartBiasRows,
};
