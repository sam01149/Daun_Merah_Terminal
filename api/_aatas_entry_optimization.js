'use strict';

// Shadow-only evaluator untuk PLAN AH. Modul ini murni: tidak menulis Redis,
// tidak mengubah status setup produksi, dan tidak pernah mengirim order/notifikasi.
const crypto = require('crypto');
const FxSessions = require('../fx-sessions');

const EXPERIMENT_ID = 'aatas_entry_optimization_v1';
const SCHEMA_VERSION = 1;
// `unavailable` bukan terminal: watcher boleh mencoba ulang ketika coverage pulih.
const TERMINAL_STATES = new Set(['tp', 'sl', 'ambiguous', 'expired', 'no_fill', 'rejected', 'not_eligible']);

const ELIGIBLE_SESSIONS = Object.freeze({
  'AUD/NZD': ['tokyo'],
  'EUR/GBP': ['london', 'overlap'],
  'EUR/USD': ['london', 'overlap', 'ny'],
  'GBP/USD': ['london', 'overlap', 'ny'],
  'XAU/USD': ['london', 'overlap', 'ny'],
  'CHF/JPY': ['london', 'overlap', 'ny'],
});

const SPREAD_PRICE_ESTIMATE = Object.freeze({
  'XAU/USD': 0.30,
  'EUR/USD': 0.00012,
  'GBP/USD': 0.00016,
  'EUR/GBP': 0.00020,
  'AUD/NZD': 0.00030,
  'CHF/JPY': 0.030,
});

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epochSeconds(v) {
  const n = finite(v);
  if (n == null) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function normalizeCandles(input) {
  if (!Array.isArray(input)) return [];
  const byTime = new Map();
  for (const raw of input) {
    const t = epochSeconds(raw?.t);
    const o = finite(raw?.o), h = finite(raw?.h), l = finite(raw?.l), c = finite(raw?.c);
    if (t == null || [o, h, l, c].some(v => v == null) || h < l || h < Math.max(o, c) || l > Math.min(o, c)) continue;
    byTime.set(t, { t, o, h, l, c, v: finite(raw?.v) || 0 });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function hasConflictingDuplicates(input) {
  const seen = new Map();
  for (const raw of Array.isArray(input) ? input : []) {
    const t = epochSeconds(raw?.t);
    if (t == null) continue;
    const signature = JSON.stringify([finite(raw?.o), finite(raw?.h), finite(raw?.l), finite(raw?.c)]);
    if (seen.has(t) && seen.get(t) !== signature) return true;
    seen.set(t, signature);
  }
  return false;
}

function hasUnexpectedH1Gap(rows) {
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].t - rows[i - 1].t;
    // Weekend/holiday FX dapat membuat gap 48-72 jam. Gap intraperiode 3-47 jam
    // atau lebih dari 72 jam tidak boleh dianggap lintasan lengkap.
    if ((gap > 7200 && gap < 48 * 3600) || gap > 72 * 3600) return true;
  }
  return false;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2) return null;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const k = 2 / (period + 1);
  let out = seed;
  for (let i = period; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2) return [];
  const out = Array(values.length).fill(null);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = current;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out[i] = current;
  }
  return out;
}

function atr(candles, period = 14) {
  const rows = normalizeCandles(candles);
  if (rows.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < rows.length; i++) {
    tr.push(Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c)));
  }
  let value = tr.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return value;
}

function resample(candles, hours) {
  const rows = normalizeCandles(candles);
  const bucketSize = hours * 3600;
  const buckets = new Map();
  for (const candle of rows) {
    const key = Math.floor(candle.t / bucketSize) * bucketSize;
    const current = buckets.get(key);
    if (!current) buckets.set(key, { ...candle, t: key });
    else {
      current.h = Math.max(current.h, candle.h);
      current.l = Math.min(current.l, candle.l);
      current.c = candle.c;
      current.v += candle.v || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

function parseZone(value) {
  // Harga instrumen yang didukung selalu positif; tanda '-' pada string zona adalah
  // separator rentang, bukan tanda bilangan negatif (contoh "1.08-1.09").
  const nums = (String(value ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

function normalizeBias(value) {
  const s = String(value || '').toLowerCase();
  if (s.includes('bull')) return 'bullish';
  if (s.includes('bear')) return 'bearish';
  return null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function structureAlignment(setup, bias) {
  const raw = String(setup?.technical?.struktur_vs_bias ?? setup?.technical?.struktur_h4 ?? setup?.technical?.structure_h4 ?? setup?.technical?.struktur ?? '').toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes('berlawanan') || raw.includes('oppos')) return 'opposing';
  if (raw.includes('campur') || raw.includes('netral') || raw.includes('transition')) return 'mixed';
  if (raw.includes('selaras') || raw.includes('align')) return 'aligned';
  const bullish = /hh|hl|bull|naik|uptrend/.test(raw);
  const bearish = /lh|ll|bear|turun|downtrend/.test(raw);
  if ((bias === 'bullish' && bullish && !bearish) || (bias === 'bearish' && bearish && !bullish)) return 'aligned';
  if ((bias === 'bullish' && bearish) || (bias === 'bearish' && bullish)) return 'opposing';
  return 'unknown';
}

function countMeaningfulCrosses(candles, periodFast = 21, periodSlow = 100) {
  const rows = normalizeCandles(candles);
  const closes = rows.map(c => c.c);
  const fast = emaSeries(closes, periodFast), slow = emaSeries(closes, periodSlow);
  let crosses = 0, previousSign = null;
  for (let i = periodSlow - 1; i < rows.length; i++) {
    if (fast[i] == null || slow[i] == null) continue;
    const diff = fast[i] - slow[i];
    const sign = diff === 0 ? previousSign : Math.sign(diff);
    if (previousSign != null && sign != null && sign !== previousSign) crosses++;
    if (sign != null) previousSign = sign;
  }
  return crosses;
}

function classifyEnvironment({ setup, candles1h, candles4h, candles1d, decisionMs }) {
  const closed = (rows, seconds) => normalizeCandles(rows).filter(c => !Number.isFinite(decisionMs) || (c.t + seconds) * 1000 <= decisionMs);
  const h1 = closed(candles1h, 3600), h4 = closed(candles4h, 14400), d1 = closed(candles1d, 86400);
  const bias = normalizeBias(setup?.bias);
  const coverage = { h1_bars: h1.length, h4_bars: h4.length, d1_bars: d1.length, required: { h1: 250, h4: 100, d1: 200 } };
  const reasonCodes = [];
  if (hasConflictingDuplicates(candles1h) || hasConflictingDuplicates(candles4h) || hasConflictingDuplicates(candles1d)) {
    return { environment: 'unknown', direction: normalizeBias(setup?.bias), strength: null, reason_codes: ['conflicting_duplicate_candles'], input_coverage: coverage };
  }
  if (hasUnexpectedH1Gap(h1)) {
    return { environment: 'unknown', direction: normalizeBias(setup?.bias), strength: null, reason_codes: ['gap_candle_coverage'], input_coverage: coverage };
  }
  if (!bias) reasonCodes.push('invalid_bias');

  const rangeReady = h1.length >= 250;
  const trendReady = h4.length >= 100 && d1.length >= 200 && h1.length >= 90;
  if (!trendReady) reasonCodes.push('insufficient_trend_history');
  if (!rangeReady) reasonCodes.push('insufficient_range_history');
  if (!bias || (!trendReady && !rangeReady)) {
    return { environment: 'unknown', direction: bias, strength: null, reason_codes: reasonCodes, input_coverage: coverage };
  }

  const h4Fast = trendReady ? ema(h4.map(c => c.c), 21) : null;
  const h4Slow = trendReady ? ema(h4.map(c => c.c), 100) : null;
  const d1Slow = trendReady ? ema(d1.map(c => c.c), 200) : null;
  const atr6h = trendReady ? atr(resample(h1, 6), 14) : null;
  const lastDaily = d1.at(-1)?.c ?? null;
  const trendDirectionOk = bias === 'bullish'
    ? lastDaily > d1Slow && h4Fast > h4Slow
    : lastDaily < d1Slow && h4Fast < h4Slow;
  const gap = h4Fast != null && h4Slow != null ? Math.abs(h4Fast - h4Slow) : null;
  const strong = gap != null && atr6h != null && gap > atr6h;
  const struct = structureAlignment(setup, bias);

  if (trendReady && trendDirectionOk && strong && struct === 'aligned') {
    reasonCodes.push('daily_ema200_aligned', 'h4_ema21_100_aligned', 'ema_gap_gt_atr6h');
    reasonCodes.push('structure_aligned');
    return {
      environment: 'trend_aligned', direction: bias, strength: 'strong', reason_codes: reasonCodes,
      input_coverage: coverage,
      metrics: { d1_close: round(lastDaily), d1_ema200: round(d1Slow), h4_ema21: round(h4Fast), h4_ema100: round(h4Slow), ema_gap: round(gap), atr14_6h: round(atr6h), structure_alignment: struct },
    };
  }

  if (rangeReady) {
    const crosses = countMeaningfulCrosses(h1.slice(-250));
    const rangeRows = h1.slice(-250);
    const high = Math.max(...rangeRows.map(c => c.h)), low = Math.min(...rangeRows.map(c => c.l));
    const position = high > low ? (rangeRows.at(-1).c - low) / (high - low) : 0.5;
    if (crosses >= 2 && (!trendReady || !strong || !trendDirectionOk)) {
      reasonCodes.push('h1_ema_crosses_gte_2', 'range_observe_only');
      return {
        environment: 'range', direction: bias, strength: 'weak', reason_codes: reasonCodes,
        input_coverage: coverage,
        metrics: { h1_ema_crosses_250: crosses, range_low: round(low), range_high: round(high), range_position: round(position, 4), value_area_available: false },
      };
    }
  }

  reasonCodes.push(struct === 'opposing' ? 'structure_opposes_bias' : struct === 'mixed' ? 'structure_mixed' : 'trend_conditions_incomplete');
  return {
    environment: 'transition', direction: bias, strength: strong ? 'strong' : 'weak', reason_codes: reasonCodes,
    input_coverage: coverage,
    metrics: { d1_close: round(lastDaily), d1_ema200: round(d1Slow), h4_ema21: round(h4Fast), h4_ema100: round(h4Slow), ema_gap: round(gap), atr14_6h: round(atr6h), structure_alignment: struct },
  };
}

function buildEntryOptimizationShadow({ setup, marketData, decisionMs = Date.now() }) {
  const env = classifyEnvironment({
    setup,
    candles1h: marketData?.candles1h,
    candles4h: marketData?.candles4h,
    candles1d: marketData?.candles1d,
    decisionMs,
  });
  const label = setup?.label || null;
  const sessions = ELIGIBLE_SESSIONS[label] || [];
  const zone = parseZone(setup?.entry_zone), sl = finite(setup?.sl), tp = finite(setup?.tp);
  const eligible = env.environment === 'trend_aligned' && sessions.length > 0 && zone && sl != null && tp != null;
  let state = eligible ? 'waiting_zone' : 'not_eligible';
  let rejectionReason = null;
  if (env.environment === 'range') { state = 'observe_only'; rejectionReason = 'range_observe_only'; }
  else if (env.environment !== 'trend_aligned') rejectionReason = `environment_${env.environment}`;
  else if (!sessions.length) rejectionReason = 'unsupported_pair_session';
  else if (!zone || sl == null || tp == null) rejectionReason = 'invalid_levels';

  const decisionIso = new Date(decisionMs).toISOString();
  const input = {
    experiment_id: EXPERIMENT_ID, version: SCHEMA_VERSION, setup_id: setup?.id || null,
    label, bias: env.direction, entry_zone: zone, sl, tp, decision_as_of: decisionIso,
    level_set_at: setup?.level_set_at ?? setup?.ts ?? decisionMs,
    entry_wait_until: setup?.entry_wait_until ?? null,
    environment: env.environment, metrics: env.metrics || null,
  };
  return {
    experiment_id: EXPERIMENT_ID,
    version: SCHEMA_VERSION,
    mode: 'shadow_no_entry_effect',
    decision_as_of: decisionIso,
    input_hash: stableHash(input),
    environment: env.environment,
    direction: env.direction,
    strength: env.strength,
    reason_codes: env.reason_codes,
    input_coverage: env.input_coverage,
    environment_metrics: env.metrics || null,
    eligible_sessions: sessions,
    value_area_available: env.environment === 'range' ? false : null,
    state,
    rejection_reason: rejectionReason,
    touch_candle: null,
    trigger_candle: null,
    trigger_metrics: null,
    proposed_fill: null,
    effective_rr: null,
    cost_estimate: { spread_price: SPREAD_PRICE_ESTIMATE[label] ?? null, spread_r: null, stress_2x_r: null },
    raw_outcome: null,
    net_r: null,
    net_r_stress_2x: null,
    mfe_r: null,
    mae_r: null,
    no_fill_reason: null,
    evaluated_at: null,
  };
}

function sessionForCandle(candle) {
  return FxSessions.sessionAtIso(new Date(candle.t * 1000).toISOString())?.key || null;
}

function candleTouchesZone(candle, zone) {
  return candle.l <= zone.high && candle.h >= zone.low;
}

function evaluateEntryOptimizationShadow(record, candlesInput, nowMs = Date.now()) {
  const previous = record?.entry_optimization_shadow;
  if (!previous || previous.experiment_id !== EXPERIMENT_ID) return previous || null;
  if (previous.state === 'observe_only') return previous;
  // Outcome keputusan yang sudah terminal harus immutable. Tanpa guard ini,
  // pemangkasan retensi candle dapat mengubah TP/SL lama menjadi unavailable.
  // `unavailable` sengaja tidak dibekukan agar watcher dapat retry saat data pulih.
  if (TERMINAL_STATES.has(previous.state)) return previous;

  const candles = normalizeCandles(candlesInput).filter(c => nowMs >= (c.t + 3600) * 1000);
  if (!candles.length) return previous;
  if (hasConflictingDuplicates(candlesInput)) return { ...previous, state: 'unavailable', rejection_reason: 'conflicting_duplicate_candles', evaluated_at: new Date(nowMs).toISOString() };
  const zone = parseZone(record.entry_zone), sl = finite(record.sl), tp = finite(record.tp);
  const bias = normalizeBias(record.bias);
  if (!zone || sl == null || tp == null || !bias) return { ...previous, state: 'unavailable', rejection_reason: 'invalid_levels', evaluated_at: new Date(nowMs).toISOString() };

  const startMs = Math.max(finite(record.level_set_at) || finite(record.ts) || 0, finite(record.entry_wait_until) || 0);
  const rows = candles.filter(c => c.t * 1000 >= startMs);
  if (!rows.length) return { ...previous, state: 'waiting_zone', evaluated_at: new Date(nowMs).toISOString() };
  if (startMs > 0 && rows[0].t * 1000 > startMs + 86400000) return { ...previous, state: 'unavailable', rejection_reason: 'initial_gap_candle_coverage', evaluated_at: new Date(nowMs).toISOString() };
  if (hasUnexpectedH1Gap(rows)) return { ...previous, state: 'unavailable', rejection_reason: 'gap_candle_coverage', evaluated_at: new Date(nowMs).toISOString() };
  const touchIndex = rows.findIndex(c => candleTouchesZone(c, zone));
  if (touchIndex < 0) {
    const horizonMs = Math.max(1, finite(record.horizon_days) || 7) * 1.5 * 86400000;
    if (nowMs > startMs + horizonMs) return { ...previous, state: 'expired', rejection_reason: 'zone_not_touched_before_expiry', evaluated_at: new Date(nowMs).toISOString() };
    return { ...previous, state: 'waiting_zone', evaluated_at: new Date(nowMs).toISOString() };
  }

  const trigger = rows[touchIndex];
  const session = sessionForCandle(trigger);
  const touch = { t: trigger.t, o: trigger.o, h: trigger.h, l: trigger.l, c: trigger.c, session };
  if (!previous.eligible_sessions.includes(session)) {
    return { ...previous, state: 'rejected', touch_candle: touch, trigger_candle: touch, rejection_reason: 'trigger_outside_eligible_session', evaluated_at: new Date(nowMs).toISOString() };
  }

  const history = candles.filter(c => c.t <= trigger.t);
  const atr6h = atr(resample(history, 6), 14);
  if (atr6h == null || atr6h <= 0) {
    return { ...previous, state: 'rejected', touch_candle: touch, trigger_candle: touch, rejection_reason: 'atr6h_unavailable', evaluated_at: new Date(nowMs).toISOString() };
  }
  const body = Math.abs(trigger.c - trigger.o), bodyAtr = body / atr6h;
  const directionOk = bias === 'bullish'
    ? trigger.o > zone.high && trigger.c > trigger.o && trigger.c > zone.high
    : trigger.o < zone.low && trigger.c < trigger.o && trigger.c < zone.low;
  const wickOk = bias === 'bullish' ? sl < trigger.l : sl > trigger.h;
  const bodyOk = bodyAtr >= 0.5 && bodyAtr <= 1.0;
  const metrics = { body: round(body), atr14_6h: round(atr6h), body_atr: round(bodyAtr, 4), direction_ok: directionOk, wick_ok: wickOk, body_ok: bodyOk };
  if (!directionOk || !bodyOk || !wickOk) {
    const reason = !directionOk ? 'first_touch_no_rejection' : !bodyOk ? 'body_outside_0_5_1_0_atr6h' : 'sl_not_beyond_trigger_wick';
    return { ...previous, state: 'rejected', touch_candle: touch, trigger_candle: touch, trigger_metrics: metrics, rejection_reason: reason, evaluated_at: new Date(nowMs).toISOString() };
  }

  const fillCandle = rows[touchIndex + 1];
  if (!fillCandle) return { ...previous, state: 'confirmed', touch_candle: touch, trigger_candle: touch, trigger_metrics: metrics, rejection_reason: null, evaluated_at: new Date(nowMs).toISOString() };
  const fillSession = sessionForCandle(fillCandle);
  if (!previous.eligible_sessions.includes(fillSession)) {
    return { ...previous, state: 'no_fill', touch_candle: touch, trigger_candle: touch, trigger_metrics: metrics, no_fill_reason: 'fill_outside_eligible_session', rejection_reason: null, evaluated_at: new Date(nowMs).toISOString() };
  }
  const fill = fillCandle.o;
  const risk = Math.abs(fill - sl), reward = Math.abs(tp - fill);
  const geometryOk = risk > 0 && reward > 0 && (bias === 'bullish' ? sl < fill && tp > fill : sl > fill && tp < fill);
  const effectiveRr = geometryOk ? reward / risk : null;
  if (!geometryOk || effectiveRr < 2) {
    return { ...previous, state: 'no_fill', touch_candle: touch, trigger_candle: touch, trigger_metrics: metrics, proposed_fill: { t: fillCandle.t, price: fill, session: fillSession }, effective_rr: round(effectiveRr, 3), no_fill_reason: geometryOk ? 'effective_rr_below_2' : 'fill_invalid_geometry', rejection_reason: null, evaluated_at: new Date(nowMs).toISOString() };
  }

  const spread = SPREAD_PRICE_ESTIMATE[record.label] ?? null;
  const spreadR = spread == null ? null : spread / risk;
  const afterFill = rows.slice(touchIndex + 1);
  let state = 'filled', outcome = null, closedT = null, maxFavorable = 0, maxAdverse = 0;
  for (const candle of afterFill) {
    const hitTp = bias === 'bullish' ? candle.h >= tp : candle.l <= tp;
    const hitSl = bias === 'bullish' ? candle.l <= sl : candle.h >= sl;
    const favorable = bias === 'bullish' ? candle.h - fill : fill - candle.l;
    const adverse = bias === 'bullish' ? fill - candle.l : candle.h - fill;
    maxFavorable = Math.max(maxFavorable, favorable);
    maxAdverse = Math.max(maxAdverse, adverse);
    if (hitTp || hitSl) {
      state = hitTp && hitSl ? 'ambiguous' : hitTp ? 'tp' : 'sl';
      outcome = state;
      closedT = candle.t;
      break;
    }
  }
  const grossR = outcome === 'tp' ? effectiveRr : outcome === 'sl' ? -1 : null;
  const netR = grossR == null || spreadR == null ? null : grossR - spreadR;
  const netRStress = grossR == null || spreadR == null ? null : grossR - spreadR * 2;
  return {
    ...previous,
    state,
    touch_candle: touch,
    trigger_candle: touch,
    trigger_metrics: metrics,
    proposed_fill: { t: fillCandle.t, price: fill, session: fillSession },
    effective_rr: round(effectiveRr, 3),
    cost_estimate: { spread_price: spread, spread_r: round(spreadR, 4), stress_2x_r: round(spreadR == null ? null : spreadR * 2, 4) },
    raw_outcome: outcome,
    closed_t: closedT,
    net_r: round(netR, 3),
    net_r_stress_2x: round(netRStress, 3),
    mfe_r: round(maxFavorable / risk, 3),
    mae_r: round(maxAdverse / risk, 3),
    no_fill_reason: null,
    rejection_reason: null,
    evaluated_at: new Date(nowMs).toISOString(),
  };
}

function applyEntryOptimizationShadow(records, candlesBySymbol, nowMs = Date.now()) {
  let changed = false;
  const output = (Array.isArray(records) ? records : []).map(record => {
    if (!record?.entry_optimization_shadow) return record;
    const evaluated = evaluateEntryOptimizationShadow(record, candlesBySymbol?.[record.symbol], nowMs);
    const missed = ['rejected', 'no_fill', 'expired'].includes(evaluated?.state);
    const next = evaluated ? {
      ...evaluated,
      baseline_status: record.status || null,
      missed_winner: missed && record.status === 'tp',
      saved_loss: missed && record.status === 'sl',
    } : evaluated;
    if (JSON.stringify(next) === JSON.stringify(record.entry_optimization_shadow)) return record;
    changed = true;
    return { ...record, entry_optimization_shadow: next };
  });
  return { records: output, changed };
}

function mergeEntryOptimizationShadow(previous, next) {
  if (!previous || previous.experiment_id !== EXPERIMENT_ID) return next;
  if (!next || next.experiment_id !== EXPERIMENT_ID) return previous;
  const revision = {
    decision_as_of: previous.decision_as_of,
    input_hash: previous.input_hash,
    environment: previous.environment,
    state: previous.state,
    rejection_reason: previous.rejection_reason,
  };
  return { ...next, revisions: [...(Array.isArray(previous.revisions) ? previous.revisions : []), revision].slice(-10) };
}

module.exports = {
  EXPERIMENT_ID,
  SCHEMA_VERSION,
  TERMINAL_STATES,
  ELIGIBLE_SESSIONS,
  SPREAD_PRICE_ESTIMATE,
  normalizeCandles,
  hasConflictingDuplicates,
  hasUnexpectedH1Gap,
  resample,
  atr,
  ema,
  parseZone,
  classifyEnvironment,
  buildEntryOptimizationShadow,
  evaluateEntryOptimizationShadow,
  applyEntryOptimizationShadow,
  mergeEntryOptimizationShadow,
};
