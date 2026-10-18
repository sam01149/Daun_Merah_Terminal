#!/usr/bin/env node
// Read-only AATAS replay/shadow runner (PLAN AD + PLAN AE-2).
// Tidak mengakses Redis, menulis log produksi, exposure gate, notifikasi, atau broker.
const { validateStoredExecutionContract } = require('../api/_aatas_execution_contract');
const { stableHash } = require('../api/_aatas_evidence');

function hash(value) {
  return stableHash(value, 16);
}

function inputFromSnapshot(raw) {
  if (Array.isArray(raw)) return { records: raw, candlesBySymbol: {}, calendarEvents: [] };
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(source.records) || Array.isArray(source.setups)) {
    return {
      records: source.records || source.setups,
      candlesBySymbol: source.candlesBySymbol || {},
      calendarEvents: source.calendarEvents || [],
    };
  }
  // Current menang bila ID sama, sama dengan kontrak merge arsip produksi. Ini bukan
  // rekonstruksi revision as-of; laporan menyatakan batas tersebut secara eksplisit.
  const merged = new Map();
  for (const record of Array.isArray(source['setup_log_auto_archive:v1']) ? source['setup_log_auto_archive:v1'] : []) {
    if (record?.id) merged.set(record.id, record);
  }
  for (const record of Array.isArray(source['setup_log_auto:v1']) ? source['setup_log_auto:v1'] : []) {
    if (record?.id) merged.set(record.id, record);
  }
  const candlesBySymbol = source.candlesBySymbol && typeof source.candlesBySymbol === 'object'
    ? { ...source.candlesBySymbol } : {};
  for (const [key, candles] of Object.entries(source)) {
    const match = key.match(/^ohlcv:(.+):1h$/);
    if (match && Array.isArray(candles) && !candlesBySymbol[match[1]]) candlesBySymbol[match[1]] = candles;
  }
  const calendarEvents = source.calendarEvents || source.calendar_v1?.events || source.calendar_v1 || [];
  return {
    records: [...merged.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)),
    candlesBySymbol,
    calendarEvents: Array.isArray(calendarEvents) ? calendarEvents : [],
  };
}

function numbers(value) {
  return (String(value || '').match(/[\d.]+/g) || []).map(Number).filter(Number.isFinite);
}

function levels(record) {
  const entry = numbers(record.entry_zone);
  const sl = numbers(record.sl)[0], tp = numbers(record.tp)[0];
  if (!entry.length || !Number.isFinite(sl) || !Number.isFinite(tp) || !['bullish', 'bearish'].includes(record.bias)) return null;
  const entryLow = Math.min(...entry), entryHigh = Math.max(...entry);
  return { entryLow, entryHigh, entryMid: (entryLow + entryHigh) / 2, sl, tp };
}

function cleanCandlesDetailed(candles) {
  const seen = new Map(), conflicts = [];
  for (const c of Array.isArray(candles) ? candles : []) {
    if (![c?.t, c?.o, c?.h, c?.l, c?.c].every(Number.isFinite)) continue;
    const normalized = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c };
    const previous = seen.get(c.t);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) conflicts.push(c.t);
    else if (!previous) seen.set(c.t, normalized);
  }
  return { candles: [...seen.values()].sort((a, b) => a.t - b.t), conflicts: [...new Set(conflicts)].sort() };
}

function hitEntry(c, l, bias) { return bias === 'bullish' ? c.l <= l.entryHigh : c.h >= l.entryLow; }

function exits(c, { bias, sl, tp }) {
  const slHit = bias === 'bullish' ? c.l <= sl : c.h >= sl;
  const tpHit = bias === 'bullish' ? c.h >= tp : c.l <= tp;
  return slHit && tpHit ? 'ambiguous' : slHit ? 'sl' : tpHit ? 'tp' : null;
}

function calEventMsWib(event) {
  if (!event?.date || !event?.time_wib || event.time_wib === 'Tentative') return null;
  const match = /^(\d{2}):(\d{2})/.exec(event.time_wib);
  if (!match) return null;
  const ms = Date.parse(`${event.date}T${match[1]}:${match[2]}:00+07:00`);
  return Number.isFinite(ms) ? ms : null;
}

function eventWaitAt(events, label, nowMs) {
  const legs = String(label || '').toUpperCase().split('/');
  const upcoming = (Array.isArray(events) ? events : [])
    .filter(event => event?.impact === 'High' && legs.includes(event.currency))
    .map(event => ({ event, at: calEventMsWib(event) }))
    .filter(item => Number.isFinite(item.at) && item.at >= nowMs && item.at - nowMs < 6 * 3600000);
  return upcoming.length ? Math.max(...upcoming.map(item => item.at)) : null;
}

function costAdjustedR({ status, entry, sl, tp, record = {}, config = {} }) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || !['tp', 'sl'].includes(status)) return { gross_r: null, net_r: null, cost_r: null, cost_quality: 'unavailable' };
  const gross = status === 'tp' ? Math.abs(tp - entry) / risk : -1;
  if (Number.isFinite(record.actual_cost_r)) {
    return { gross_r: gross, net_r: gross - Math.abs(record.actual_cost_r), cost_r: Math.abs(record.actual_cost_r), cost_quality: 'actual' };
  }
  const spreadPrice = Number.isFinite(record.spread_price_estimate) ? Math.abs(record.spread_price_estimate) : null;
  const spreadR = spreadPrice == null ? 0 : spreadPrice * (config.spreadMultiplier ?? 1) / risk;
  const otherR = ['commissionR', 'swapR', 'slippageR'].reduce((sum, key) => sum + (Number.isFinite(config[key]) ? Math.abs(config[key]) : 0), 0);
  const hasEstimate = spreadPrice != null || otherR > 0;
  return {
    gross_r: gross,
    // Biaya tidak tersedia bukan berarti biaya nol. Jangan mengubah gross R
    // menjadi "net" yang terlihat pasti bila spread/komisi/slippage tidak ada.
    net_r: hasEstimate ? gross - spreadR - otherR : null,
    cost_r: hasEstimate ? spreadR + otherR : null,
    cost_quality: hasEstimate ? 'estimated' : 'unavailable',
  };
}

function computeExcursion({ record, levels: l, entry, filled_t, closed_t, candles }) {
  if (!Number.isFinite(entry) || !Number.isFinite(filled_t)) return null;
  const end = Number.isFinite(closed_t) ? closed_t : Infinity;
  const path = candles.filter(c => c.t >= filled_t && c.t <= end);
  const risk = Math.abs(entry - l.sl);
  if (!path.length || !(risk > 0)) return null;
  let favorable = 0, adverse = 0;
  for (const c of path) {
    favorable = Math.max(favorable, record.bias === 'bullish' ? c.h - entry : entry - c.l);
    adverse = Math.max(adverse, record.bias === 'bullish' ? entry - c.l : c.h - entry);
  }
  return {
    mfe_r: favorable / risk,
    mae_r: adverse / risk,
    candles: path.length,
    quality: 'ohlcv_bound_intrabar_order_unknown',
  };
}

function directionAtHorizon({ record, entry, filled_t, candles, horizonSeconds }) {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds <= 0 || !Number.isFinite(filled_t) || !Number.isFinite(entry)) return null;
  const target = filled_t + horizonSeconds;
  const candle = candles.find(c => c.t >= target);
  if (!candle) return { status: 'unavailable', reason: 'horizon_not_covered', target_t: target };
  const move = record.bias === 'bullish' ? candle.c - entry : entry - candle.c;
  return { status: move > 0 ? 'correct' : move < 0 ? 'wrong' : 'flat', target_t: target, observed_t: candle.t, move };
}

function terminalSourceResult(record, sourceStatus) {
  return {
    id: record?.id || null,
    status: 'skipped',
    reason: `record_${sourceStatus}`,
    source_status: sourceStatus,
    accounting: 'terminal_source_not_counterfactual',
  };
}

function replayRecord(record, rawCandles, config = {}, calendarEvents = []) {
  const sourceStatus = String(record?.status || 'pending').toLowerCase();
  const terminal = new Set(['canceled', 'cancelled', 'expired', 'rejected', 'invalid']);
  if (terminal.has(sourceStatus) && config.replayTerminal !== true) return terminalSourceResult(record, sourceStatus);

  const l = levels(record);
  if (!l) return { id: record?.id || null, status: 'unavailable', reason: 'level_invalid' };
  const contract = validateStoredExecutionContract(record);
  if (!contract.ok) return { id: record?.id || null, status: 'unavailable', reason: `execution_contract_${contract.reason}` };

  const cleaned = cleanCandlesDetailed(rawCandles);
  if (cleaned.conflicts.length) {
    return { id: record.id, status: 'unavailable', reason: 'conflicting_duplicate_candles', conflict_t: cleaned.conflicts };
  }
  const maxGapSeconds = Number.isFinite(config.maxGapSeconds) ? config.maxGapSeconds : 7200;
  const decisionMs = Number(record.level_set_at || record.ts || 0);
  const scanFromMs = sourceStatus === 'open' && Number.isFinite(Number(record.filled_t))
    ? Number(record.filled_t) * 1000 : decisionMs;
  const all = cleaned.candles.filter(c => c.t * 1000 > scanFromMs);
  if (!all.length) return { id: record.id, status: 'unavailable', reason: 'missing_candle_coverage' };
  if (sourceStatus !== 'open' && decisionMs > 0 && all[0].t * 1000 > decisionMs + 86400000) {
    return { id: record.id, status: 'unavailable', reason: 'initial_gap_candle_coverage' };
  }
  if (config.requireRecordedBars !== false) {
    if (Number.isFinite(Number(record.filled_t)) && !cleaned.candles.some(c => c.t === Number(record.filled_t))) {
      return { id: record.id, status: 'unavailable', reason: 'missing_recorded_fill_bar' };
    }
    if (Number.isFinite(Number(record.closed_t)) && !cleaned.candles.some(c => c.t === Number(record.closed_t))) {
      return { id: record.id, status: 'unavailable', reason: 'missing_recorded_close_bar' };
    }
  }
  // Posisi yang SUDAH `open` mulai diputar ulang dari `filled_t`, bukan dari waktu
  // keputusan awal. Membandingkan candle pertama pasca-fill dengan `decisionMs`
  // membuat setup yang menunggu zona > maxGapSeconds salah dilabel unavailable,
  // walau candle fill tercatat dan coverage setelah fill rapat. Untuk pending,
  // `scanFromMs` tetap sama dengan waktu keputusan/level terakhir.
  if (scanFromMs > 0 && all[0].t * 1000 - scanFromMs > maxGapSeconds * 1000) {
    return { id: record.id, status: 'unavailable', reason: 'initial_gap_candle_coverage_strict' };
  }

  const strategy = config.strategy || 'baseline_touch';
  let phase = sourceStatus === 'open' ? 'open' : 'waiting';
  let touch = null;
  let entry = phase === 'open' ? l.entryMid : null;
  let filled_t = phase === 'open' ? Number(record.filled_t) : null;
  let previous = null;
  let result = null;

  for (const c of all) {
    if (previous && c.t - previous.t > maxGapSeconds) {
      result = { id: record.id, status: 'unavailable', reason: 'gap_candle_coverage', filled_t, touch_t: touch?.t || null };
      break;
    }
    previous = c;
    if (phase === 'waiting' && hitEntry(c, l, record.bias)) {
      if (record.entry_execution === 'zone_touch_after_calendar') {
        const waitUntil = Math.max(Number(record.entry_wait_until) || 0, eventWaitAt(calendarEvents, record.label, c.t * 1000) || 0);
        if (c.t * 1000 <= waitUntil) continue;
        const invalidated = record.bias === 'bearish' ? c.o >= l.sl : c.o <= l.sl;
        if (invalidated) {
          result = { id: record.id, status: 'canceled', reason: 'entry_invalidated_before_fill', canceled_t: c.t * 1000 };
          break;
        }
        const freshTouch = record.bias === 'bearish'
          ? c.o < l.entryLow && c.h >= l.entryLow
          : c.o > l.entryHigh && c.l <= l.entryHigh;
        if (!freshTouch) continue;
      }
      if (strategy === 'h1_confirmation') { phase = 'confirming'; touch = c; continue; }
      phase = 'open';
      entry = record.entry_execution === 'zone_touch_after_calendar'
        ? (record.bias === 'bullish' ? l.entryHigh : l.entryLow)
        : l.entryMid;
      filled_t = c.t;
    } else if (phase === 'confirming') {
      const confirmed = record.bias === 'bullish' ? c.c > touch.h : c.c < touch.l;
      if (confirmed) { phase = 'next_open'; continue; }
    } else if (phase === 'next_open') {
      entry = c.o; filled_t = c.t; phase = 'open';
      const correctSide = record.bias === 'bullish' ? l.sl < entry && l.tp > entry : l.sl > entry && l.tp < entry;
      const rr = correctSide ? Math.abs(l.tp - entry) / Math.abs(entry - l.sl) : 0;
      if (!correctSide || rr < (config.minRr ?? 2)) {
        result = { id: record.id, status: 'skipped', reason: 'confirmed_entry_invalid_or_rr', touch_t: touch?.t || null, filled_t, entry, rr };
        break;
      }
    }
    if (phase === 'open') {
      const status = exits(c, { bias: record.bias, sl: l.sl, tp: l.tp });
      if (status) {
        const costs = costAdjustedR({ status, entry, sl: l.sl, tp: l.tp, record, config });
        result = { id: record.id, status, filled_t, closed_t: c.t, touch_t: touch?.t || null, entry, sl: l.sl, tp: l.tp, ...costs };
        break;
      }
    }
  }

  if (!result) {
    const evaluationAsOfMs = Number.isFinite(config.evaluationAsOfMs)
      ? config.evaluationAsOfMs
      : (cleaned.candles.at(-1)?.t || 0) * 1000;
    const horizonMs = Math.max(2, Number(record.horizon_days) || 5) * 1.5 * 86400000;
    const expired = phase === 'waiting' && Number(record.ts) > 0 && evaluationAsOfMs - Number(record.ts) > horizonMs;
    result = {
      id: record.id,
      status: expired ? 'expired' : (phase === 'open' || phase === 'next_open' ? 'open' : 'pending'),
      filled_t, touch_t: touch?.t || null, entry,
    };
  }

  if (Number.isFinite(result.filled_t)) {
    result.excursion = computeExcursion({ record, levels: l, entry: result.entry, filled_t: result.filled_t, closed_t: result.closed_t, candles: cleaned.candles });
    result.direction_at_horizon = directionAtHorizon({ record, entry: result.entry, filled_t: result.filled_t, candles: cleaned.candles, horizonSeconds: config.directionHorizonSeconds });
  }
  return result;
}

function summarize(results) {
  const closed = results.filter(r => r.status === 'tp' || r.status === 'sl').sort((a, b) => Number(a.closed_t || 0) - Number(b.closed_t || 0));
  const wins = closed.filter(r => r.status === 'tp'), losses = closed.filter(r => r.status === 'sl');
  const netKnown = closed.filter(r => Number.isFinite(r.net_r));
  const net = netKnown.reduce((sum, r) => sum + r.net_r, 0);
  let peak = 0, running = 0, maxDrawdown = 0;
  for (const r of netKnown) { running += r.net_r; peak = Math.max(peak, running); maxDrawdown = Math.min(maxDrawdown, running - peak); }
  const grossWin = wins.reduce((sum, r) => sum + Math.max(0, Number(r.net_r) || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + Math.min(0, Number(r.net_r) || 0), 0));
  const byStatus = {};
  for (const result of results) byStatus[result.status] = (byStatus[result.status] || 0) + 1;
  return {
    candidates: results.length,
    by_status: byStatus,
    closed: closed.length,
    closed_cost_known: netKnown.length,
    closed_cost_unknown: closed.length - netKnown.length,
    tp: wins.length,
    sl: losses.length,
    total_net_r: netKnown.length ? net : null,
    mean_net_r_per_closed: netKnown.length ? net / netKnown.length : null,
    mean_net_r_per_opportunity: null,
    mean_net_r_per_opportunity_reason: 'Pending/unavailable/skipped bukan return nol; denominator opportunity harus direkonsiliasi sebelum dihitung.',
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
    realized_cashflow_max_drawdown_r: netKnown.length ? maxDrawdown : null,
    drawdown_scope: 'Urutan closed_t; bukan equity/mark-to-market account drawdown.',
  };
}

function runReplay({ records, candlesBySymbol, calendarEvents = [], config = {}, experiment_id = 'aatas-shadow' }) {
  const input = Array.isArray(records) ? records : [];
  const results = input.map(record => replayRecord(record, candlesBySymbol?.[record?.symbol], config, calendarEvents));
  const replayable = results.filter(r => !['unavailable', 'skipped'].includes(r.status));
  return {
    experiment_id,
    config,
    config_hash: hash(config),
    data_hash: hash({ records: input, candlesBySymbol, calendarEvents }),
    limitations: [
      'Current/archive merge bukan revision-as-of bila histori revisi tidak tersedia.',
      'OHLCV tidak membuktikan urutan tick intrabar; same-bar TP+SL tetap ambiguous.',
      'Record terminal tidak menjadi counterfactual kecuali replayTerminal diaktifkan eksplisit.',
      'Raw dan managed outcome tidak dijumlah sebagai dua trade.',
    ],
    coverage: {
      candidates: input.length,
      replayable: replayable.length,
      skipped: results.filter(r => r.status === 'skipped').length,
      unavailable: results.filter(r => r.status === 'unavailable').length,
      unresolved: results.filter(r => ['pending', 'open', 'expired'].includes(r.status)).length,
    },
    results,
    summary: summarize(results),
  };
}

module.exports = {
  inputFromSnapshot, levels, cleanCandlesDetailed, calEventMsWib, eventWaitAt,
  costAdjustedR, computeExcursion, directionAtHorizon, replayRecord, runReplay, summarize,
};

if (require.main === module) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: node scripts/aatas_replay.cjs <snapshot.json> [config.json]');
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const config = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : {};
  const input = inputFromSnapshot(raw);
  process.stdout.write(JSON.stringify(runReplay({ ...input, config }), null, 2) + '\n');
}
