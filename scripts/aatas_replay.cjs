#!/usr/bin/env node
// Read-only AATAS replay/shadow runner (PLAN AD). Tidak mengakses Redis, tidak
// menulis log produksi, exposure gate, notifikasi, atau broker.
const crypto = require('node:crypto');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
function inputFromSnapshot(raw) {
  if (Array.isArray(raw)) return { records: raw, candlesBySymbol: {} };
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(source.records) || Array.isArray(source.setups)) {
    return { records: source.records || source.setups, candlesBySymbol: source.candlesBySymbol || {} };
  }
  // Snapshot research Redis menyimpan current dan archive pada key asli. Archive
  // memberi cakupan setelah cap current; current menang bila ID sama, seperti
  // kontrak merge arsip produksi.
  const merged = new Map();
  for (const record of Array.isArray(source['setup_log_auto_archive:v1']) ? source['setup_log_auto_archive:v1'] : []) {
    if (record?.id) merged.set(record.id, record);
  }
  for (const record of Array.isArray(source['setup_log_auto:v1']) ? source['setup_log_auto:v1'] : []) {
    if (record?.id) merged.set(record.id, record);
  }
  const candlesBySymbol = source.candlesBySymbol && typeof source.candlesBySymbol === 'object' ? { ...source.candlesBySymbol } : {};
  for (const [key, candles] of Object.entries(source)) {
    const match = key.match(/^ohlcv:(.+):1h$/);
    if (match && Array.isArray(candles) && !candlesBySymbol[match[1]]) candlesBySymbol[match[1]] = candles;
  }
  return { records: [...merged.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)), candlesBySymbol };
}
function numbers(value) {
  return (String(value || '').match(/[\d.]+/g) || []).map(Number).filter(Number.isFinite);
}
function levels(record) {
  const entry = numbers(record.entry_zone);
  const sl = numbers(record.sl)[0], tp = numbers(record.tp)[0];
  if (!entry.length || !Number.isFinite(sl) || !Number.isFinite(tp) || !['bullish', 'bearish'].includes(record.bias)) return null;
  return { entryLow: Math.min(...entry), entryHigh: Math.max(...entry), entryMid: (Math.min(...entry) + Math.max(...entry)) / 2, sl, tp };
}
function cleanCandles(candles) {
  const seen = new Map();
  for (const c of Array.isArray(candles) ? candles : []) {
    if (![c?.t, c?.o, c?.h, c?.l, c?.c].every(Number.isFinite)) continue;
    seen.set(c.t, c);
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}
function hitEntry(c, l, bias) { return bias === 'bullish' ? c.l <= l.entryHigh : c.h >= l.entryLow; }
function exits(c, { bias, sl, tp }) {
  const slHit = bias === 'bullish' ? c.l <= sl : c.h >= sl;
  const tpHit = bias === 'bullish' ? c.h >= tp : c.l <= tp;
  return slHit && tpHit ? 'ambiguous' : slHit ? 'sl' : tpHit ? 'tp' : null;
}
function netR({ status, entry, sl, tp, spreadPrice = 0, spreadMultiplier = 1 }) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const gross = status === 'tp' ? Math.abs(tp - entry) / risk : status === 'sl' ? -1 : null;
  return gross == null ? null : gross - Math.abs(spreadPrice || 0) * spreadMultiplier / risk;
}

function replayRecord(record, candles, config = {}) {
  const sourceStatus = String(record?.status || '').toLowerCase();
  if (['canceled', 'cancelled', 'expired', 'rejected', 'invalid'].includes(sourceStatus)) {
    return { id: record?.id || null, status: 'skipped', reason: `record_${sourceStatus}`, source_status: sourceStatus };
  }
  const l = levels(record);
  if (!l) return { id: record?.id || null, status: 'unavailable', reason: 'level_invalid' };
  const decisionMs = Number(record.ts || 0);
  const maxGapSeconds = Number.isFinite(config.maxGapSeconds) ? config.maxGapSeconds : 7200;
  const all = cleanCandles(candles).filter(c => c.t * 1000 > decisionMs);
  if (!all.length) return { id: record.id, status: 'unavailable', reason: 'missing_candle_coverage' };
  // Saat mengaudit outcome historis, fill/close yang tercatat harus benar-benar
  // ada di input. Tanpa itu replay baru akan mengarang lintasan lain dari window
  // candle saat ini. Kandidat forward belum memiliki kedua field ini.
  if (Number.isFinite(Number(record.filled_t)) && !all.some(c => c.t === Number(record.filled_t))) {
    return { id: record.id, status: 'unavailable', reason: 'missing_recorded_fill_bar' };
  }
  if (Number.isFinite(Number(record.closed_t)) && !all.some(c => c.t === Number(record.closed_t))) {
    return { id: record.id, status: 'unavailable', reason: 'missing_recorded_close_bar' };
  }
  if (decisionMs > 0 && all[0].t * 1000 - decisionMs > maxGapSeconds * 1000) {
    return { id: record.id, status: 'unavailable', reason: 'initial_gap_candle_coverage' };
  }
  const strategy = config.strategy || 'baseline_touch';
  let phase = 'waiting', touch = null, entry = null, filled_t = null;
  let previous = null;
  for (const c of all) {
    if (previous && c.t - previous.t > maxGapSeconds) return { id: record.id, status: 'unavailable', reason: 'gap_candle_coverage', filled_t, touch_t: touch?.t || null };
    previous = c;
    if (phase === 'waiting' && hitEntry(c, l, record.bias)) {
      if (strategy === 'h1_confirmation') { phase = 'confirming'; touch = c; continue; }
      phase = 'open'; entry = l.entryMid; filled_t = c.t;
    } else if (phase === 'confirming') {
      const confirmed = record.bias === 'bullish' ? c.c > touch.h : c.c < touch.l;
      if (confirmed) { phase = 'next_open'; continue; }
    } else if (phase === 'next_open') {
      entry = c.o; filled_t = c.t; phase = 'open';
      const correctSide = record.bias === 'bullish' ? l.sl < entry && l.tp > entry : l.sl > entry && l.tp < entry;
      const rr = correctSide ? Math.abs(l.tp - entry) / Math.abs(entry - l.sl) : 0;
      if (!correctSide || rr < (config.minRr ?? 2)) return { id: record.id, status: 'skipped', reason: 'confirmed_entry_invalid_or_rr', touch_t: touch?.t || null, filled_t, entry, rr };
    }
    if (phase === 'open') {
      const status = exits(c, { bias: record.bias, sl: l.sl, tp: l.tp });
      if (status) return { id: record.id, status, filled_t, closed_t: c.t, touch_t: touch?.t || null, entry, sl: l.sl, tp: l.tp, net_r: netR({ status, entry, sl: l.sl, tp: l.tp, spreadPrice: record.spread_price_estimate, spreadMultiplier: config.spreadMultiplier }) };
    }
  }
  return { id: record.id, status: phase === 'open' || phase === 'next_open' ? 'open' : 'pending', filled_t, touch_t: touch?.t || null, entry };
}

function summarize(results) {
  const closed = results.filter(r => r.status === 'tp' || r.status === 'sl');
  const wins = closed.filter(r => r.status === 'tp');
  const losses = closed.filter(r => r.status === 'sl');
  const net = closed.reduce((sum, r) => sum + (Number(r.net_r) || 0), 0);
  let peak = 0, running = 0, maxDrawdown = 0;
  for (const r of closed) { running += r.net_r || 0; peak = Math.max(peak, running); maxDrawdown = Math.min(maxDrawdown, running - peak); }
  const grossWin = wins.reduce((s, r) => s + Math.max(0, r.net_r || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + Math.min(0, r.net_r || 0), 0));
  return { candidates: results.length, closed: closed.length, tp: wins.length, sl: losses.length, ambiguous: results.filter(r => r.status === 'ambiguous').length, skipped: results.filter(r => r.status === 'skipped').length, unavailable: results.filter(r => r.status === 'unavailable').length, total_net_r: net, mean_net_r: closed.length ? net / closed.length : null, profit_factor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0, max_drawdown_r: maxDrawdown };
}

function runReplay({ records, candlesBySymbol, config = {}, experiment_id = 'aatas-shadow' }) {
  const input = Array.isArray(records) ? records : [];
  const results = input.map(record => replayRecord(record, candlesBySymbol?.[record?.symbol], config));
  const replayable = results.filter(r => r.status !== 'unavailable' && r.status !== 'skipped');
  return {
    experiment_id, config, config_hash: hash(config), data_hash: hash({ records: input, candlesBySymbol }),
    selection_bias: 'Candidate yang ditolak/skipped historis mungkin tidak lengkap; hasil tidak mengukur opportunity cost penuh.',
    coverage: { candidates: input.length, replayable: replayable.length, skipped_source_status: results.filter(r => r.status === 'skipped').length, unavailable: results.filter(r => r.status === 'unavailable').length },
    results, summary: summarize(results),
  };
}

module.exports = { inputFromSnapshot, replayRecord, runReplay, summarize };

if (require.main === module) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: node scripts/aatas_replay.cjs <snapshot.json> [config.json]');
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const config = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : {};
  const input = inputFromSnapshot(raw);
  process.stdout.write(JSON.stringify(runReplay({ ...input, config }), null, 2) + '\n');
}
