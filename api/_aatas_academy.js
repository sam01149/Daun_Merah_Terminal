// Academy shadow AATAS: instrumentasi deterministik untuk belajar, bukan gate.
// Modul ini murni (tanpa fetch/Redis/AI) agar kegagalannya tidak dapat mengubah
// keputusan entry produksi. Semua keluaran harus diperlakukan sebagai observasi.
const { stableHash } = require('./_aatas_evidence');

const ACADEMY_SCHEMA_VERSION = 1;
const EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REACTION_WINDOW_MS = 3 * 60 * 60 * 1000;

function _text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function _eventMsWib(date, timeWib) {
  if (!date || !timeWib || timeWib === 'Tentative') return null;
  const match = /^(\d{2}):(\d{2})/.exec(String(timeWib));
  if (!match) return null;
  const ms = new Date(`${date}T${match[1]}:${match[2]}:00+07:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _numeric(value) {
  if (value == null || value === '') return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const raw = String(value).trim();
  // Vendor umumnya memberi angka mentah, tetapi fallback display dapat memakai koma.
  // Satu koma dengan 1-2 digit desimal dibaca sebagai decimal comma; bentuk 1,000
  // tetap ribuan. Ini hanya parser provenance, bukan konversi unit lintas-sumber.
  const decimalComma = /^-?\d+,\d{1,2}(?:\s*[%kmb])?$/i.test(raw);
  const normalized = decimalComma ? raw.replace(',', '.') : raw.replace(/,/g, '');
  const match = /-?\d+(?:\.\d+)?/.exec(normalized);
  if (!match) return null;
  let number = Number(match[0]);
  if (!Number.isFinite(number)) return null;
  if (/k\b/i.test(normalized)) number *= 1e3;
  else if (/m\b/i.test(normalized)) number *= 1e6;
  else if (/b\b/i.test(normalized)) number *= 1e9;
  return number;
}

// Hanya event dengan interpretasi arah yang relatif stabil yang diberi mapping.
// Event ambigu (pidato, keputusan suku bunga + guidance, inventori, dll.) tetap
// unknown; Academy tidak boleh mengarang arah hanya supaya sampelnya lengkap.
function eventCurrencyRule(eventName) {
  const name = String(eventName || '').toLowerCase();
  if (/unemployment rate|jobless claims|unemployment claims|claimant count/.test(name)) {
    return { higher: 'negative', lower: 'positive', family: 'labor_slack' };
  }
  if (/non[- ]?farm payroll|employment change|payrolls|gross domestic product|\bgdp\b|retail sales|industrial production|manufacturing production|\bpmi\b/.test(name)) {
    return { higher: 'positive', lower: 'negative', family: 'growth_or_labor' };
  }
  return { higher: 'unknown', lower: 'unknown', family: 'direction_ambiguous' };
}

function pairDirectionForCurrency(label, currency, currencyDirection) {
  if (currencyDirection !== 'positive' && currencyDirection !== 'negative') return 'unknown';
  const [base, quote] = String(label || '').toUpperCase().split('/').map(x => x.trim());
  if (!base || !quote || (currency !== base && currency !== quote)) return 'unknown';
  const currencyUp = currencyDirection === 'positive';
  return (currency === base ? currencyUp : !currencyUp) ? 'bullish' : 'bearish';
}

function _branch(label, currency, currencyDirection) {
  return {
    currency_direction: currencyDirection,
    expected_pair_direction: pairDirectionForCurrency(label, currency, currencyDirection),
  };
}

function buildEventScenarios(events, label, decisionMs, options = {}) {
  const asOf = Number(decisionMs);
  if (!Number.isFinite(asOf)) return [];
  const legs = String(label || '').toUpperCase().split('/').map(x => x.trim()).filter(Boolean);
  const limit = Math.max(0, Math.min(10, Number(options.limit ?? 3) || 0));
  const seen = new Set();
  return (Array.isArray(events) ? events : [])
    .filter(event => event && event.impact === 'High' && legs.includes(String(event.currency || '').toUpperCase()))
    .map(event => ({ event, eventMs: _eventMsWib(event.date, event.time_wib) }))
    .filter(({ eventMs }) => Number.isFinite(eventMs) && eventMs > asOf && eventMs <= asOf + EVENT_WINDOW_MS)
    .sort((a, b) => a.eventMs - b.eventMs)
    .filter(({ event, eventMs }) => {
      const key = `${eventMs}|${event.currency}|${event.event}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ event, eventMs }) => {
      const rule = eventCurrencyRule(event.event);
      const forecast = _numeric(event.forecast_raw ?? event.forecast);
      const previous = _numeric(event.previous_raw ?? event.previous);
      const identity = { label, event_at: eventMs, currency: event.currency, event: event.event };
      return {
        schema_version: ACADEMY_SCHEMA_VERSION,
        experiment_id: 'academy_event_v1',
        scenario_id: `academy_event_${stableHash(identity)}`,
        registered_at: new Date(asOf).toISOString(),
        decision_as_of: new Date(asOf).toISOString(),
        event_at: new Date(eventMs).toISOString(),
        event_id: `${event.date}|${event.time_wib}|${event.currency}|${event.event}`,
        label,
        currency: String(event.currency).toUpperCase(),
        event: _text(event.event),
        impact: 'High',
        period: _text(event.period),
        forecast,
        previous,
        forecast_raw: event.forecast_raw ?? event.forecast ?? null,
        previous_raw: event.previous_raw ?? event.previous ?? null,
        actual_as_of_decision: null,
        direction_rule: rule.family,
        branches: forecast == null ? {
          above_forecast: _branch(label, String(event.currency).toUpperCase(), 'unknown'),
          inline_forecast: _branch(label, String(event.currency).toUpperCase(), 'unknown'),
          below_forecast: _branch(label, String(event.currency).toUpperCase(), 'unknown'),
        } : {
          above_forecast: _branch(label, String(event.currency).toUpperCase(), rule.higher),
          inline_forecast: _branch(label, String(event.currency).toUpperCase(), 'unknown'),
          below_forecast: _branch(label, String(event.currency).toUpperCase(), rule.lower),
        },
        quality: forecast == null ? 'forecast_missing' : (rule.family === 'direction_ambiguous' ? 'direction_ambiguous' : 'registered'),
        input_hash: stableHash({ identity, forecast, previous, rule }),
      };
    });
}

function buildAcademyShadow({ setup = {}, events = [], decisionMs = Date.now(), slotId = null } = {}) {
  const label = _text(setup.label);
  const scenarios = buildEventScenarios(events, label, decisionMs);
  const checks = {
    regime_check: setup.regime_check != null,
    'gate_validitas_driver.pass': typeof setup.gate_validitas_driver?.pass === 'boolean',
    'gate_risk_management.pass': typeof setup.gate_risk_management?.pass === 'boolean',
    'fundamental_bias.arah': ['bullish', 'bearish', 'netral'].includes(setup.fundamental_bias?.arah),
    'fundamental_bias.driver': Boolean(_text(setup.fundamental_bias?.driver)),
    'fundamental_bias.strong_vs_weak': typeof setup.fundamental_bias?.strong_vs_weak === 'boolean',
    technical: setup.technical != null,
    final_validation: setup.final_validation != null,
  };
  const required = Object.keys(checks);
  const present = required.filter(key => checks[key]);
  return {
    schema_version: ACADEMY_SCHEMA_VERSION,
    mode: 'shadow_no_entry_effect',
    academy_slot_id: _text(slotId),
    decision_as_of: new Date(Number(decisionMs)).toISOString(),
    decision_quality: {
      fields_expected: required.length,
      fields_present: present.length,
      missing_fields: required.filter(key => !checks[key]),
      comparable: present.length === required.length,
    },
    event_scenarios: scenarios,
    h1_confirmation: {
      experiment_id: 'academy_confirmation_v1',
      strategy: 'h1_confirmation',
      touch: 'fresh_touch_after_level_set_at_and_calendar_wait',
      confirmation: setup.bias === 'bearish'
        ? 'h1_close_below_touch_candle_low'
        : (setup.bias === 'bullish' ? 'h1_close_above_touch_candle_high' : 'unknown_until_direction_exists'),
      fill: 'next_h1_open',
      min_rr: 2,
      costs_required_for_net_result: true,
      status: 'offline_replay_candidate',
      config_hash: stableHash({
        strategy: 'h1_confirmation', confirmation: 'touch_candle_extreme_close',
        fill: 'next_h1_open', min_rr: 2, calendar_wait: true, fresh_touch: true,
      }),
    },
    input_hash: stableHash({
      slot_id: _text(slotId), label, symbol: setup.symbol, bias: setup.bias,
      entry_zone: setup.entry_zone, sl: setup.sl, tp: setup.tp,
      scenarios: scenarios.map(item => item.input_hash),
    }),
  };
}

function _driverFamilies(record) {
  const text = String(record?.fundamental_bias?.driver || '').toLowerCase();
  const families = [];
  const rules = [
    ['monetary_policy', /central bank|bank sentral|suku bunga|rate path|hawkish|dovish|\bfed\b|\becb\b|\bboj\b|\bboe\b|\brba\b|\brbnz\b|\bsnb\b/],
    ['inflation', /inflasi|inflation|\bcpi\b|\bpce\b|harga konsumen/],
    ['labor', /tenaga kerja|labor|employment|payroll|pengangguran|unemployment|jobless/],
    ['growth', /pertumbuhan|growth|\bgdp\b|\bpmi\b|retail sales|industrial production/],
    ['trade', /perdagangan|trade balance|ekspor|impor|export|import/],
    ['commodity', /komoditas|commodity|minyak|\boil\b|\bwti\b|emas|\bgold\b|logam/],
    ['risk_sentiment', /risk[- ]?on|risk[- ]?off|safe haven|sentimen risiko|volatilitas|\bvix\b/],
    ['geopolitics', /geopolit|perang|konflik|sanksi|war|sanction/],
    ['fiscal', /fiskal|fiscal|anggaran|budget|utang pemerintah|government debt/],
  ];
  for (const [family, pattern] of rules) if (pattern.test(text)) families.push(family);
  return families;
}

function mergeAcademyShadow(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const scenarios = new Map();
  // Versi paling awal menang untuk event yang sama: itulah skenario yang benar-benar
  // terdaftar lebih dulu, bukan forecast/vintage yang mungkin sudah berubah saat refine.
  for (const item of [...(previous.event_scenarios || []), ...(next.event_scenarios || [])]) {
    if (item?.scenario_id && !scenarios.has(item.scenario_id)) scenarios.set(item.scenario_id, item);
  }
  const priorRevision = {
    academy_slot_id: previous.academy_slot_id || null,
    decision_as_of: previous.decision_as_of || null,
    input_hash: previous.input_hash || null,
    decision_quality: previous.decision_quality || null,
    h1_confirmation: previous.h1_confirmation || null,
  };
  const revisions = [...(previous.revisions || []), priorRevision]
    .filter(item => item.decision_as_of || item.input_hash)
    .slice(-10);
  return {
    ...next,
    event_scenarios: [...scenarios.values()].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at)),
    event_reactions: { ...(previous.event_reactions || {}), ...(next.event_reactions || {}) },
    revisions,
  };
}

function _median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _retryOrUnavailable(eventMs, nowMs, reason) {
  return nowMs <= eventMs + 24 * 3600000
    ? { status: 'pending', reason, retry_until: new Date(eventMs + 24 * 3600000).toISOString() }
    : { status: 'unavailable', reason };
}

function evaluateEventReaction(scenario, candles, calendarEvents = [], nowMs = Date.now()) {
  const eventMs = Date.parse(scenario?.event_at || '');
  if (!Number.isFinite(eventMs)) return { status: 'unavailable', reason: 'event_time_missing' };
  if (nowMs < eventMs + REACTION_WINDOW_MS) return { status: 'pending', ready_at: new Date(eventMs + REACTION_WINDOW_MS).toISOString() };
  const rawRows = (Array.isArray(candles) ? candles : [])
    .filter(c => c && Number.isFinite(Number(c.t)) && Number.isFinite(Number(c.c)) && Number.isFinite(Number(c.h)) && Number.isFinite(Number(c.l)))
    .map(c => ({ ...c, t: Number(c.t), c: Number(c.c), h: Number(c.h), l: Number(c.l) }))
    .sort((a, b) => a.t - b.t);
  const byTime = new Map();
  for (const row of rawRows) {
    const prior = byTime.get(row.t);
    if (prior && (prior.c !== row.c || prior.h !== row.h || prior.l !== row.l)) {
      return { status: 'unavailable', reason: 'conflicting_duplicate_candles' };
    }
    if (!prior) byTime.set(row.t, row);
  }
  const rows = [...byTime.values()];
  const eventSec = eventMs / 1000;
  const endSec = (eventMs + REACTION_WINDOW_MS) / 1000;
  const pre = rows.filter(c => c.t + 3600 <= eventSec);
  const baseline = pre[pre.length - 1];
  if (!baseline || eventSec - (baseline.t + 3600) > 3600) return _retryOrUnavailable(eventMs, nowMs, 'pre_event_candle_missing');
  const preRanges = pre.slice(-20).map(c => c.c ? Math.abs(c.h - c.l) / Math.abs(c.c) * 100 : null).filter(Number.isFinite);
  if (preRanges.length < 10) return _retryOrUnavailable(eventMs, nowMs, 'pre_event_volatility_coverage_lt_10');
  const windowRows = rows.filter(c => c.t >= baseline.t + 3600 && c.t + 3600 <= endSec);
  const endpoint = windowRows[windowRows.length - 1];
  if (!endpoint || endpoint.t + 3600 < eventSec + 2 * 3600) return _retryOrUnavailable(eventMs, nowMs, 'post_event_window_incomplete');
  const pathRows = [baseline, ...windowRows];
  if (pathRows.some((row, index) => index > 0 && row.t - pathRows[index - 1].t > 3600)) {
    return _retryOrUnavailable(eventMs, nowMs, 'reaction_candle_gap');
  }
  const movePct = baseline.c ? (endpoint.c / baseline.c - 1) * 100 : null;
  const deadbandPct = _median(preRanges);
  if (!Number.isFinite(movePct) || !Number.isFinite(deadbandPct)) return { status: 'unavailable', reason: 'reaction_math_invalid' };
  const observedDirection = movePct > deadbandPct ? 'bullish' : (movePct < -deadbandPct ? 'bearish' : 'flat');
  const maxUpPct = Math.max(...windowRows.map(row => (row.h / baseline.c - 1) * 100));
  const maxDownPct = Math.min(...windowRows.map(row => (row.l / baseline.c - 1) * 100));
  const actualEvent = (Array.isArray(calendarEvents) ? calendarEvents : []).find(event =>
    event && `${event.date}|${event.time_wib}|${event.currency}|${event.event}` === scenario.event_id
  );
  const actual = _numeric(actualEvent?.actual_raw ?? actualEvent?.actual);
  if (actual == null && nowMs <= eventMs + 24 * 3600000) return {
    status: 'pending', reason: 'calendar_actual_missing',
    retry_until: new Date(eventMs + 24 * 3600000).toISOString(),
  };
  let branch = 'unknown';
  if (actual != null && scenario.forecast != null) branch = actual > scenario.forecast ? 'above_forecast' : (actual < scenario.forecast ? 'below_forecast' : 'inline_forecast');
  const expectedDirection = scenario.branches?.[branch]?.expected_pair_direction || 'unknown';
  const relevantLegs = String(scenario.label || '').toUpperCase().split('/').map(x => x.trim()).filter(Boolean);
  const confounders = (Array.isArray(calendarEvents) ? calendarEvents : []).filter(event => {
    if (!event || event.impact !== 'High') return false;
    if (!relevantLegs.includes(String(event.currency || '').toUpperCase())) return false;
    const at = _eventMsWib(event.date, event.time_wib);
    const id = `${event.date}|${event.time_wib}|${event.currency}|${event.event}`;
    return id !== scenario.event_id && Number.isFinite(at) && at >= eventMs && at <= eventMs + REACTION_WINDOW_MS;
  }).map(event => `${event.currency}:${event.event}`);
  const outcome = expectedDirection === 'unknown' || observedDirection === 'flat'
    ? 'unknown'
    : (expectedDirection === observedDirection ? 'confirm' : 'contradict');
  return {
    status: 'complete',
    evaluated_at: new Date(nowMs).toISOString(),
    event_branch: branch,
    actual,
    expected_pair_direction: expectedDirection,
    observed_pair_direction: observedDirection,
    outcome,
    confounded: confounders.length > 0,
    confounders,
    shadow_readout: confounders.length ? 'wait' : (outcome === 'confirm' ? 'keep' : (outcome === 'contradict' ? 'reassess' : 'wait')),
    return_pct: Math.round(movePct * 1e6) / 1e6,
    max_up_excursion_pct: Math.round(maxUpPct * 1e6) / 1e6,
    max_down_excursion_pct: Math.round(maxDownPct * 1e6) / 1e6,
    expected_favorable_excursion_pct: expectedDirection === 'bullish'
      ? Math.round(maxUpPct * 1e6) / 1e6
      : (expectedDirection === 'bearish' ? Math.round(Math.abs(maxDownPct) * 1e6) / 1e6 : null),
    expected_adverse_excursion_pct: expectedDirection === 'bullish'
      ? Math.round(Math.abs(maxDownPct) * 1e6) / 1e6
      : (expectedDirection === 'bearish' ? Math.round(Math.abs(maxUpPct) * 1e6) / 1e6 : null),
    deadband_pct: Math.round(deadbandPct * 1e6) / 1e6,
    deadband_source: `median_pre_event_h1_range_pct_n${preRanges.length}`,
    base_candle_t: baseline.t,
    end_candle_t: endpoint.t,
    reaction_window_hours: REACTION_WINDOW_MS / 3600000,
    causation_claimed: false,
  };
}

function applyCompletedEventReactions(records, candlesBySymbol, calendarEvents, nowMs = Date.now()) {
  let changed = false;
  const out = (Array.isArray(records) ? records : []).map(record => {
    const shadow = record?.academy_shadow;
    if (!shadow || !Array.isArray(shadow.event_scenarios) || !shadow.event_scenarios.length) return record;
    const reactions = { ...(shadow.event_reactions || {}) };
    let recordChanged = false;
    for (const scenario of shadow.event_scenarios) {
      if (!scenario?.scenario_id || reactions[scenario.scenario_id]) continue;
      const reaction = evaluateEventReaction(scenario, candlesBySymbol?.[record.symbol], calendarEvents, nowMs);
      if (reaction.status !== 'pending') {
        reactions[scenario.scenario_id] = reaction;
        recordChanged = true;
        changed = true;
      }
    }
    return recordChanged ? { ...record, academy_shadow: { ...shadow, event_reactions: reactions } } : record;
  });
  return { records: out, changed };
}

function _candidate(record, slotId) {
  if (!record || (record.academy_slot_id !== slotId && record.academy_shadow?.academy_slot_id !== slotId)) return null;
  const quality = record.academy_shadow?.decision_quality;
  const levelReady = Boolean(record.entry_zone && record.sl && record.tp);
  const conflict = record.conflict && record.conflict !== 'none';
  const legs = String(record.label || '').toUpperCase().split('/').filter(Boolean);
  const driverFamilies = _driverFamilies(record);
  return {
    label: record.label || null,
    symbol: record.symbol || record.pair || null,
    source: record.record_kind === 'pre_ai_skip' ? 'pre_ai_skip' : (record.record_kind === 'aatas_reject' ? 'aatas_reject' : 'setup_log'),
    disposition: record.status === 'canceled' ? `canceled:${record.canceled_reason || 'unknown'}` : (record.reason ? `excluded:${record.reason}` : (record.status || 'candidate')),
    comparable: quality?.comparable === true && levelReady,
    coverage: quality ? quality.fields_present / quality.fields_expected : null,
    level_ready: levelReady,
    conflict: Boolean(conflict),
    legs,
    driver_families: driverFamilies,
    input_hash: record.academy_shadow?.input_hash || null,
    missing_reason: quality ? (quality.comparable ? null : `missing:${quality.missing_fields.join(',')}`) : 'academy_decision_envelope_missing',
  };
}

function rankAcademyCohort(records, slotId, expectedLabels = []) {
  const dedup = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const candidate = _candidate(record, slotId);
    if (!candidate?.label) continue;
    if (!dedup.has(candidate.label)) dedup.set(candidate.label, candidate);
  }
  const legCounts = {};
  const driverCounts = {};
  for (const candidate of dedup.values()) for (const leg of candidate.legs) legCounts[leg] = (legCounts[leg] || 0) + 1;
  for (const candidate of dedup.values()) for (const family of candidate.driver_families) driverCounts[family] = (driverCounts[family] || 0) + 1;
  const candidates = [...dedup.values()].map(candidate => ({
    ...candidate,
    currency_overlap_count: candidate.legs.reduce((sum, leg) => sum + Math.max(0, (legCounts[leg] || 0) - 1), 0),
    driver_overlap_count: candidate.driver_families.reduce((sum, family) => sum + Math.max(0, (driverCounts[family] || 0) - 1), 0),
  })).sort((a, b) =>
    Number(b.comparable) - Number(a.comparable)
    || Number(b.level_ready) - Number(a.level_ready)
    || (b.coverage ?? -1) - (a.coverage ?? -1)
    || Number(a.conflict) - Number(b.conflict)
    || a.currency_overlap_count - b.currency_overlap_count
    || a.driver_overlap_count - b.driver_overlap_count
    || String(a.label).localeCompare(String(b.label))
  ).map((candidate, index) => ({ ...candidate, rank: index + 1, selected: false }));
  const expected = [...new Set((expectedLabels || []).map(_text).filter(Boolean))];
  const present = new Set(candidates.map(item => item.label));
  return {
    schema_version: ACADEMY_SCHEMA_VERSION,
    experiment_id: 'academy_ranking_v1',
    mode: 'shadow_rank_only_no_selection',
    academy_slot_id: slotId,
    expected_labels: expected,
    missing_labels: expected.filter(label => !present.has(label)),
    complete_cohort: expected.length > 0 && expected.every(label => present.has(label)),
    candidates,
    rubric: ['comparable', 'level_ready', 'coverage', 'no_conflict', 'lower_currency_overlap', 'lower_driver_overlap', 'stable_label_tiebreak'],
    top_n_forced: false,
    config_hash: stableHash({ v: ACADEMY_SCHEMA_VERSION, expected, rubric: 'lexicographic_v1' }),
  };
}

module.exports = {
  ACADEMY_SCHEMA_VERSION,
  EVENT_WINDOW_MS,
  REACTION_WINDOW_MS,
  eventCurrencyRule,
  pairDirectionForCurrency,
  buildEventScenarios,
  buildAcademyShadow,
  mergeAcademyShadow,
  evaluateEventReaction,
  applyCompletedEventReactions,
  rankAcademyCohort,
};
