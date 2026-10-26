'use strict';

// Pipeline murni untuk snapshot dan evaluasi "Week Ahead" Marc to Market.
// I/O (fetch, Redis, dan panggilan model) tetap di admin.js supaya helper ini
// mudah diuji dan tidak menjadi function Vercel baru.

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const EXTRACTOR_VERSION = 'marc-weekly-v3';
const NOISE_PCT = 0.15;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const LAYERS = new Set(['policy', 'growth', 'inflation', 'technical', 'risk', 'mixed']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);
// Audit 1.951 post (2020-2026) menemukan dua nama editorial yang benar-benar
// dipakai untuk outlook mingguan: "Week Ahead" dan "Next Week". Jangan pakai
// kata "weekly" generik karena catatan harian sering menyebut jadwal weekly.
const WEEKLY_TITLE_RE = /\b(?:week ahead|next week)\b/i;
const SUPPORTED_PAIRS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
  'NZD/USD': 'NZDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X', 'AUD/JPY': 'AUDJPY=X', 'EUR/AUD': 'EURAUD=X',
  'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X',
};

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const hex = ent[1]?.toLowerCase() === 'x';
      const cp = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[ent.toLowerCase()] ?? m;
  });
}

function cleanHtml(value) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|div|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n')
    .trim();
}

function parseMarcFeed(xml) {
  const entries = [];
  const re = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    const block = match[1];
    const tag = name => {
      const cdata = new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`, 'i').exec(block);
      const plain = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
      return cleanHtml((cdata || plain)?.[1] || '');
    };
    const title = tag('title');
    if (!WEEKLY_TITLE_RE.test(title)) continue;
    const links = [...block.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)];
    const alternate = links.find(x => /rel=["']alternate["']/i.test(x[0]));
    const link = decodeEntities(alternate?.[1] || links[0]?.[1] || block.match(/<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i)?.[1] || '');
    const pubDate = tag('published') || tag('pubDate') || tag('updated');
    const content = tag('content');
    const publishedMs = Date.parse(pubDate);
    if (title && link && Number.isFinite(publishedMs)) entries.push({ title, link, pubDate: new Date(publishedMs).toISOString(), content });
  }
  return entries.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

function extractArticleText(html) {
  const raw = String(html || '');
  const start = raw.search(/<div\b[^>]*class=["'][^"']*\bpost-body\b[^"']*["'][^>]*>/i);
  if (start < 0) return cleanHtml(raw).slice(0, 60000);
  const tail = raw.slice(start);
  const end = tail.search(/<div\b[^>]*class=["'][^"']*\bpost-footer\b/i);
  return cleanHtml(end > 0 ? tail.slice(0, end) : tail).slice(0, 60000);
}

function weekWindow(pubDate) {
  const published = new Date(pubDate);
  if (!Number.isFinite(published.getTime())) return null;
  const start = new Date(Date.UTC(published.getUTCFullYear(), published.getUTCMonth(), published.getUTCDate()));
  const daysToMonday = (8 - start.getUTCDay()) % 7 || 7;
  start.setUTCDate(start.getUTCDate() + daysToMonday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 5);
  end.setUTCHours(0, 0, 0, 0); // Jumat 24:00 UTC, cukup dekat dengan FX close.
  return { start: start.toISOString(), end: end.toISOString() };
}

function snapshotId(link, content) {
  return crypto.createHash('sha256').update(`${link}\n${content}`).digest('hex').slice(0, 20);
}

function normalizePair(value) {
  const m = String(value || '').toUpperCase().replace('-', '/').match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (!m) return null;
  const pair = `${m[1]}/${m[2]}`;
  return SUPPORTED_PAIRS[pair] ? pair : null;
}

function validateClaims(input, meta = {}) {
  const raw = Array.isArray(input) ? input : input?.claims;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    const currency = String(row?.currency || '').toUpperCase();
    let direction = String(row?.direction || '').toLowerCase();
    const pair = normalizePair(row?.pair);
    if (!CURRENCIES.includes(currency)) continue;
    if (pair && !pair.split('/').includes(currency)) continue;
    if (pair) {
      const pairDirection = String(row?.pair_direction || '').toLowerCase();
      if (!['bullish', 'bearish'].includes(pairDirection)) continue;
      const [base] = pair.split('/');
      direction = currency === base
        ? pairDirection
        : pairDirection === 'bullish' ? 'bearish' : 'bullish';
    }
    if (!['bullish', 'bearish'].includes(direction)) continue;
    const quote = String(row?.quote || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const reason = String(row?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (quote.length < 12 || reason.length < 5) continue;
    const key = currency;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${meta.snapshot_id || 'snapshot'}:${out.length + 1}`,
      institution: 'Marc to Market', analyst: 'Marc Chandler', currency, pair,
      direction, pair_direction: pair ? String(row.pair_direction).toLowerCase() : null, horizon: 'week_ahead',
      layer: LAYERS.has(String(row.layer || '').toLowerCase()) ? String(row.layer).toLowerCase() : 'mixed',
      confidence: CONFIDENCES.has(String(row.confidence || '').toLowerCase()) ? String(row.confidence).toLowerCase() : 'low',
      conditional: row.conditional === true,
      reason, quote,
      article_id: meta.snapshot_id || null,
      article_url: meta.article_url || null,
      published_at: meta.published_at || null,
    });
  }
  return out;
}

function symbolsForClaim(claim) {
  if (claim.pair && SUPPORTED_PAIRS[claim.pair]) return [SUPPORTED_PAIRS[claim.pair]];
  return Object.entries(SUPPORTED_PAIRS)
    .filter(([pair]) => pair.split('/').includes(claim.currency))
    .map(([, symbol]) => symbol);
}

function pairForSymbol(symbol) {
  return Object.entries(SUPPORTED_PAIRS).find(([, s]) => s === symbol)?.[0] || null;
}

function rangeReturn(candles, startMs, endMs, currency, pair) {
  const rows = (candles || []).filter(c => Number(c.t) * 1000 >= startMs && Number(c.t) * 1000 < endMs);
  if (rows.length < 2) return null;
  const first = Number(rows[0].o);
  const closes = rows.map(c => Number(c.c)).filter(Number.isFinite);
  if (!Number.isFinite(first) || first <= 0 || !closes.length) return null;
  const [base, quote] = pair.split('/');
  const orient = currency === base ? 1 : currency === quote ? -1 : 0;
  if (!orient) return null;
  const returns = closes.map(v => orient * ((v / first) - 1) * 100);
  const path = [first, ...closes];
  const hourly = [];
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1] > 0) hourly.push(((path[i] / path[i - 1]) - 1) * 100);
  }
  const mean = hourly.length ? hourly.reduce((s, x) => s + x, 0) / hourly.length : 0;
  const variance = hourly.length > 1 ? hourly.reduce((s, x) => s + (x - mean) ** 2, 0) / (hourly.length - 1) : 0;
  return {
    return_pct: returns[returns.length - 1],
    mfe_pct: Math.max(...returns),
    mae_pct: Math.min(...returns),
    vol_pct: Math.sqrt(variance) * Math.sqrt(hourly.length),
  };
}

function currencyOutcome(claim, candlesBySymbol, startMs, endMs) {
  const parts = symbolsForClaim(claim).map(symbol => {
    const pair = pairForSymbol(symbol);
    const result = rangeReturn(candlesBySymbol[symbol], startMs, endMs, claim.currency, pair);
    return result ? { symbol, pair, ...result } : null;
  }).filter(Boolean);
  if (!parts.length) return null;
  const avg = key => parts.reduce((sum, x) => sum + x[key], 0) / parts.length;
  return { return_pct: avg('return_pct'), mfe_pct: avg('mfe_pct'), mae_pct: avg('mae_pct'), vol_pct: avg('vol_pct'), components: parts.map(x => x.pair) };
}

function evaluateClaim(claim, candlesBySymbol, window, noisePct = NOISE_PCT) {
  const startMs = Date.parse(window.start), endMs = Date.parse(window.end);
  const outcome = currencyOutcome(claim, candlesBySymbol, startMs, endMs);
  if (!outcome) return { ...claim, outcome: { status: 'unavailable', reason: 'price_window_unavailable' } };
  const sign = claim.direction === 'bullish' ? 1 : -1;
  const signed = sign * outcome.return_pct;
  const previous = currencyOutcome(claim, candlesBySymbol, startMs - 7 * 86400000, endMs - 7 * 86400000);
  const baselineDirection = previous && Math.abs(previous.return_pct) >= noisePct
    ? (previous.return_pct > 0 ? 'bullish' : 'bearish') : 'neutral';
  const actualDirection = Math.abs(outcome.return_pct) < noisePct
    ? 'neutral' : outcome.return_pct > 0 ? 'bullish' : 'bearish';
  return {
    ...claim,
    outcome: {
      status: Math.abs(outcome.return_pct) < noisePct ? 'neutral' : signed > 0 ? 'hit' : 'miss',
      actual_direction: actualDirection,
      return_pct: +outcome.return_pct.toFixed(4),
      signed_return_pct: +signed.toFixed(4),
      vol_adjusted_return: previous?.vol_pct > 0 ? +(signed / previous.vol_pct).toFixed(4) : null,
      mfe_pct: +(sign > 0 ? outcome.mfe_pct : -outcome.mae_pct).toFixed(4),
      mae_pct: +(sign > 0 ? outcome.mae_pct : -outcome.mfe_pct).toFixed(4),
      noise_pct: noisePct,
      baseline_direction: baselineDirection,
      baseline_hit: baselineDirection === 'neutral' || actualDirection === 'neutral' ? null : baselineDirection === actualDirection,
      components: outcome.components,
    },
  };
}

function evaluateSnapshot(snapshot, candlesBySymbol, nowMs = Date.now()) {
  if (!snapshot?.window || Date.parse(snapshot.window.end) > nowMs) return snapshot;
  if (!snapshot.eligible_for_scoring) return { ...snapshot, status: 'excluded_late_snapshot' };
  const claims = (snapshot.claims || []).map(c => evaluateClaim(c, candlesBySymbol, snapshot.window));
  const complete = claims.length > 0 && claims.every(c => c.outcome?.status !== 'unavailable');
  return { ...snapshot, claims, status: complete ? 'evaluated' : 'awaiting_prices', evaluated_at: complete ? new Date(nowMs).toISOString() : null };
}

function wilson(hits, n, z = 1.96) {
  if (!n) return { low: null, high: null };
  const p = hits / n;
  const den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / den;
  return { low: +(center - margin).toFixed(4), high: +(center + margin).toFixed(4) };
}

function aggregateClaims(claims) {
  const decided = claims.filter(c => ['hit', 'miss'].includes(c.outcome?.status));
  const hits = decided.filter(c => c.outcome.status === 'hit').length;
  const baseline = decided.filter(c => c.outcome.baseline_hit != null);
  const baselineHits = baseline.filter(c => c.outcome.baseline_hit).length;
  const ci = wilson(hits, decided.length);
  const avgSigned = decided.length ? decided.reduce((s, c) => s + c.outcome.signed_return_pct, 0) / decided.length : null;
  const volAdjusted = decided.filter(c => Number.isFinite(c.outcome.vol_adjusted_return));
  const avgVolAdjusted = volAdjusted.length ? volAdjusted.reduce((s, c) => s + c.outcome.vol_adjusted_return, 0) / volAdjusted.length : null;
  const baselineRate = baseline.length ? baselineHits / baseline.length : 0.5;
  let quality = 'belum_cukup';
  if (decided.length >= 30) {
    if (ci.low > baselineRate && avgSigned > 0) quality = 'terbukti_baik';
    else if (ci.high < baselineRate && avgSigned < 0) quality = 'buruk';
    else quality = 'lemah_tidak_terbukti';
  }
  return {
    n: decided.length, hits, misses: decided.length - hits,
    neutral: claims.filter(c => c.outcome?.status === 'neutral').length,
    hit_rate: decided.length ? +(hits / decided.length).toFixed(4) : null,
    wilson_95: ci,
    avg_signed_return_pct: avgSigned == null ? null : +avgSigned.toFixed(4),
    avg_vol_adjusted_return: avgVolAdjusted == null ? null : +avgVolAdjusted.toFixed(4),
    baseline_n: baseline.length,
    baseline_hit_rate: baseline.length ? +baselineRate.toFixed(4) : null,
    quality,
  };
}

function summarizeTracker(tracker, nowMs = Date.now()) {
  const all = (tracker || []).flatMap(s => s.claims || []);
  const byCurrency = Object.fromEntries(CURRENCIES.map(cur => [cur, aggregateClaims(all.filter(c => c.currency === cur))]));
  const byLayer = Object.fromEntries([...LAYERS].map(layer => [layer, aggregateClaims(all.filter(c => c.layer === layer))]));
  const byConfidence = Object.fromEntries([...CONFIDENCES].map(confidence => [confidence, aggregateClaims(all.filter(c => c.confidence === confidence))]));
  const byClaimType = {
    explicit: aggregateClaims(all.filter(c => c.conditional !== true)),
    conditional: aggregateClaims(all.filter(c => c.conditional === true)),
  };
  const current = (tracker || [])
    .filter(s => ['open', 'awaiting_prices', 'excluded_late_snapshot'].includes(s.status) && (s.claims || []).length > 0 && Date.parse(s.window?.end) > nowMs)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] || null;
  return { schema_version: SCHEMA_VERSION, source: 'Marc to Market', analyst: 'Marc Chandler', current, overall: aggregateClaims(all), by_currency: byCurrency, by_layer: byLayer, by_confidence: byConfidence, by_claim_type: byClaimType, generated_at: new Date(nowMs).toISOString() };
}

function currentStances(report) {
  const snapshot = report?.current;
  if (!snapshot) return [];
  return (snapshot.claims || []).filter(c => c.conditional !== true).map(c => ({
    ...c,
    evidence: c.quote,
    track_record: report.by_currency?.[c.currency] || null,
    track_record_eligible: (report.by_currency?.[c.currency]?.n || 0) >= 30 && report.by_currency[c.currency].quality === 'terbukti_baik',
  }));
}

module.exports = {
  SCHEMA_VERSION, EXTRACTOR_VERSION, NOISE_PCT, CURRENCIES, SUPPORTED_PAIRS,
  WEEKLY_TITLE_RE,
  cleanHtml, parseMarcFeed, extractArticleText, weekWindow, snapshotId,
  normalizePair, validateClaims, symbolsForClaim, evaluateClaim, evaluateSnapshot,
  wilson, aggregateClaims, summarizeTracker, currentStances,
};
