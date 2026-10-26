'use strict';

function finiteCandles(candles) {
  return Array.isArray(candles)
    ? candles.filter(c => c && Number.isFinite(Number(c.t)) && ['o', 'h', 'l', 'c'].every(k => Number.isFinite(Number(c[k])))).sort((a, b) => a.t - b.t)
    : [];
}

function ema(values, period) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!Number.isInteger(period) || period < 2 || nums.length < period) return null;
  let current = nums.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < nums.length; i++) current = nums[i] * alpha + current * (1 - alpha);
  return current;
}

function atr(candles, period = 14) {
  const rows = finiteCandles(candles);
  if (rows.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const prevClose = Number(rows[i - 1].c);
    const high = Number(rows[i].h), low = Number(rows[i].l);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return null;
  let current = trs.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (let i = period; i < trs.length; i++) current = ((current * (period - 1)) + trs[i]) / period;
  return current;
}

function resampleCandles(candles, hours, anchorUtcHour = 0) {
  const rows = finiteCandles(candles);
  const bucketSeconds = hours * 3600;
  const anchorSeconds = anchorUtcHour * 3600;
  const grouped = new Map();
  for (const c of rows) {
    const bucket = Math.floor((Number(c.t) - anchorSeconds) / bucketSeconds) * bucketSeconds + anchorSeconds;
    const prev = grouped.get(bucket);
    if (!prev) grouped.set(bucket, { t: bucket, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0) });
    else {
      prev.h = Math.max(prev.h, Number(c.h));
      prev.l = Math.min(prev.l, Number(c.l));
      prev.c = Number(c.c);
      prev.v += Number(c.v || 0);
    }
  }
  return [...grouped.values()].sort((a, b) => a.t - b.t);
}

function decimalsForSymbol(symbol) {
  if (symbol === 'GC=F') return 2;
  return String(symbol).includes('JPY') ? 3 : 5;
}

function displayDistance(symbol, value) {
  if (!Number.isFinite(value)) return { value: null, unit: symbol === 'GC=F' ? 'point' : 'pip' };
  if (symbol === 'GC=F') return { value: +value.toFixed(2), unit: 'point' };
  const pip = String(symbol).includes('JPY') ? 0.01 : 0.0001;
  return { value: +(value / pip).toFixed(1), unit: 'pip' };
}

function computePrimeExecution({ symbol, label, d1, h4, h6, source = null, alignment = 'provider_native', stale = false, computedAt = Date.now() } = {}) {
  const daily = finiteCandles(d1);
  const four = finiteCandles(h4);
  const six = finiteCandles(h6);
  const requirements = { d1: 240, h4: 140, h6: 30 };
  const sample_count = { d1: daily.length, h4: four.length, h6: six.length };
  const warmup_valid = daily.length >= requirements.d1 && four.length >= requirements.h4 && six.length >= requirements.h6;
  const closeD1 = daily.length ? Number(daily[daily.length - 1].c) : null;
  const ema200 = ema(daily.map(c => c.c), 200);
  const ema21 = ema(four.map(c => c.c), 21);
  const ema100 = ema(four.map(c => c.c), 100);
  const atr14 = atr(six, 14);
  const gap = Number.isFinite(ema21) && Number.isFinite(ema100) ? Math.abs(ema21 - ema100) : null;
  const relation = !Number.isFinite(closeD1) || !Number.isFinite(ema200) ? 'unavailable'
    : closeD1 > ema200 ? 'above' : closeD1 < ema200 ? 'below' : 'equal';
  const direction = !Number.isFinite(ema21) || !Number.isFinite(ema100) ? 'unavailable'
    : ema21 > ema100 ? 'bullish' : ema21 < ema100 ? 'bearish' : 'neutral';
  const strength = Number.isFinite(gap) && Number.isFinite(atr14) ? gap > atr14 : false;
  const available = warmup_valid && [closeD1, ema200, ema21, ema100, atr14, gap].every(Number.isFinite);
  const dec = decimalsForSymbol(symbol);
  const lastD1 = daily.at(-1)?.t || null;
  const snapshotKey = available ? `${lastD1}:${ema200.toFixed(dec)}` : null;
  const result = {
    schema_version: 1,
    symbol, label: label || symbol, computed_at: new Date(computedAt).toISOString(), source,
    available, stale: Boolean(stale), unavailable_reason: available ? null : 'warmup_or_data_insufficient',
    sample_count, requirements, warmup_valid,
    window: {
      d1_start: daily[0]?.t || null, d1_end: daily.at(-1)?.t || null,
      h4_start: four[0]?.t || null, h4_end: four.at(-1)?.t || null,
      h6_start: six[0]?.t || null, h6_end: six.at(-1)?.t || null,
    },
    trend: { relation, close: closeD1, ema200, distance: Number.isFinite(closeD1) && Number.isFinite(ema200) ? Math.abs(closeD1 - ema200) : null, snapshot_key: snapshotKey, last_candle_t: lastD1 },
    momentum: { direction, ema21, ema100, gap, gap_display: displayDistance(symbol, gap) },
    strength: { passed: available && strength, atr14_h6: atr14, atr_display: displayDistance(symbol, atr14), rule: 'ema_gap_gt_atr' },
    alignment,
  };
  result.verdict = finalPrimeVerdict(result);
  return result;
}

function finalPrimeVerdict(metrics) {
  if (!metrics?.available || metrics.stale) return 'WAIT';
  if (metrics.trend?.relation === 'above' && metrics.momentum?.direction === 'bullish' && metrics.strength?.passed) return 'BUY ONLY';
  if (metrics.trend?.relation === 'below' && metrics.momentum?.direction === 'bearish' && metrics.strength?.passed) return 'SELL ONLY';
  return 'WAIT';
}

module.exports = { finiteCandles, ema, atr, resampleCandles, displayDistance, computePrimeExecution, finalPrimeVerdict };
