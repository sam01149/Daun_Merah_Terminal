// api/cb-status.js — Live CB rates + bias (6h Redis cache, scraped from official sources)
// GET /api/cb-status                → banks + bias (existing)
// GET /api/cb-status?section=shock  → FOMC/CB shock detector (plan G6): klasifikasi
//                                     rule-based reaksi harga per-jam atas keputusan
//                                     bank sentral terbaru — TANPA panggilan AI.
// Rate scraping/caching logic lives in ./_cb_rates.js (shared with admin.js
// fundamental_get, so the Fundamental tab's "{Bank} Rate" row stays in sync
// with this endpoint instead of drifting from a static seed).
//
// Sources:
//   USD → FRED API (DFEDTARU – upper target)
//   EUR → ECB Data Portal API (Main Refinancing Rate)
//   GBP → Bank of England website
//   JPY → Bank of Japan website
//   CAD → Bank of Canada Valet API
//   AUD → Reserve Bank of Australia website
//   NZD → Reserve Bank of New Zealand website
//   CHF → Swiss National Bank website

const { getLiveCbRates } = require('./_cb_rates');
const rateLimit = require('./_ratelimit');
const {
  CB_SHOCK_PROXY, SHOCK_DISCLAIMER, REACTION_HOURS,
  computeHourlyReaction, classifyCbShock, buildShockNarrative, announceTsFromMeetingDate,
} = require('./_cb_shock');
const { fetchYahooOhlcv1h } = require('./_ohlcv_fetch');

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

// ── Shock detector (plan G6) ──────────────────────────────────────────────────

const SHOCK_CACHE_KEY = 'cb_shock_cache';
const SHOCK_CACHE_TTL = 3600;    // 1h — candle 1h toh tidak lebih cepat dari itu
const SHOCK_WINDOW_DAYS = 8;     // rapat lebih tua dari ini di luar jangkauan data 1h (range=10d)

// Candle 1h per simbol: Redis dulu (sudah disync ohlcv_sync tiap jam via GitHub
// Actions), fallback fetch Yahoo langsung via modul shared _ohlcv_fetch.
async function loadCandles1h(symbol) {
  try {
    const raw = await redisCmd('GET', `ohlcv:${symbol}:1h`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) {}
  try {
    return await fetchYahooOhlcv1h(symbol);
  } catch(e) {
    console.warn(`shock: candles ${symbol} unavailable:`, e.message);
    return null;
  }
}

// Ekspektasi pre-meeting dari rate-path (USD saja): hanya valid kalau cache
// rate_path masih memuat meeting tsb sebagai meeting MENDATANG (snapshot pre-rapat).
// Pasca-rapat, meeting hilang dari daftar → null (jujur: ekspektasi historis
// tidak pernah disimpan, jangan direka ulang).
async function usdExpectedChangeBps(meetingDate) {
  try {
    const { getRatePathData } = require('./rate-path');
    // cacheOnly: cache miss tidak boleh memicu compute penuh (rantai CME bisa
    // puluhan detik) di tengah request user — ekspektasi jadi null saja.
    const { data } = await getRatePathData({ cacheOnly: true });
    if (!data) return null;
    const mtg = data?.USD?.next_meetings?.find(m => m.date === meetingDate);
    if (!mtg) return null;
    const bps = Math.round((mtg.prob_hike25 || 0) * 25 - (mtg.prob_cut25 || 0) * 25);
    return isFinite(bps) ? bps : null;
  } catch(e) { return null; }
}

async function shockHandler(req, res) {
  const force = req.query.force === '1';
  if (!force) {
    try {
      const cached = await redisCmd('GET', SHOCK_CACHE_KEY);
      if (cached) {
        const obj = JSON.parse(cached);
        if (Date.now() - new Date(obj.fetched_at).getTime() < SHOCK_CACHE_TTL * 1000) {
          return res.status(200).json(obj);
        }
      }
    } catch(e) {}
  }

  const banks = await getLiveCbRates();
  const cutoff = Date.now() - SHOCK_WINDOW_DAYS * 86400000;
  const recent = banks.filter(b => {
    if (!b.last_meeting) return false;
    const t = new Date(b.last_meeting).getTime();
    return isFinite(t) && t >= cutoff && t <= Date.now() + 86400000;
  });

  // Dedupe fetch candle per simbol (USD & EUR sama-sama pakai EURUSD=X)
  const symbols = [...new Set(recent.map(b => CB_SHOCK_PROXY[b.currency]?.symbol).filter(Boolean))];
  const candlesBySymbol = {};
  await Promise.all(symbols.map(async s => { candlesBySymbol[s] = await loadCandles1h(s); }));

  const events = [];
  for (const b of recent) {
    const proxy = CB_SHOCK_PROXY[b.currency];
    if (!proxy) continue;
    const announceTs = announceTsFromMeetingDate(b.last_meeting, b.currency);
    const pairMovePct = announceTs != null
      ? computeHourlyReaction(candlesBySymbol[proxy.symbol], announceTs)
      : null;
    const rateChangeBps = b.last_bps || 0;
    const changed = b.last_decision === 'hike' || b.last_decision === 'cut';
    const expectedChangeBps = b.currency === 'USD' ? await usdExpectedChangeBps(b.last_meeting) : null;
    const { classification, currencyMovePct } = classifyCbShock({
      changed, rateChangeBps, expectedChangeBps, pairMovePct, invert: proxy.invert,
    });
    events.push({
      currency: b.currency,
      bank: b.bank,
      meeting_date: b.last_meeting,
      decision: b.last_decision,
      rate_change_bps: rateChangeBps,
      expected_change_bps: expectedChangeBps,
      proxy_pair: proxy.pair,
      reaction_window_hours: REACTION_HOURS,
      currency_move_pct: currencyMovePct,
      classification,
      narrative: buildShockNarrative({
        classification, bank: b.bank, currency: b.currency, rateChangeBps, currencyMovePct,
      }),
    });
  }

  const payload = {
    section: 'shock',
    events,
    window_days: SHOCK_WINDOW_DAYS,
    disclaimer: SHOCK_DISCLAIMER,
    fetched_at: new Date().toISOString(),
  };
  redisCmd('SET', SHOCK_CACHE_KEY, JSON.stringify(payload), 'EX', SHOCK_CACHE_TTL).catch(() => {});
  return res.status(200).json(payload);
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  if (await rateLimit(req, res, { limit: 20, windowSecs: 60, endpoint: 'cb-status' })) return;

  if (req.query.section === 'shock') return shockHandler(req, res);

  let biasData = {};
  try {
    const biasRaw = await redisCmd('GET', 'cb_bias');
    if (biasRaw) biasData = JSON.parse(biasRaw);
  } catch(e) { console.warn('cb_bias load failed:', e.message); }

  const rates = await getLiveCbRates();
  const result = rates.map(r => ({
    ...r,
    bias:               biasData[r.currency]?.bias               || null,
    confidence:         biasData[r.currency]?.confidence         || null,
    bias_updated:       biasData[r.currency]?.updated_at         || null,
    source_headlines:   biasData[r.currency]?.source_headlines   || [],
    divergence_warning: biasData[r.currency]?.divergence_warning || null,
  }));

  const rateSource = result.find(r => r.rate_source !== 'fallback')?.rate_source || 'fallback';

  return res.status(200).json({
    banks: result,
    fetched_at: new Date().toISOString(),
    rate_source: rateSource,
  });
};
