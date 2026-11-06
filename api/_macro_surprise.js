'use strict';

// Fondasi Growth/Inflation Smart Bias. Modul ini: (1) memilih rilis makro yang
// definisinya jelas, (2) menyimpan histori actual-vs-consensus, dan (3) menghitung
// standardized surprise kontinu. UI hanya menerima arah yang lolos syarat
// coverage serta sensitivity check; label presentasi tetap menjadi urusan klien.

const MACRO_HISTORY_INDEX_KEY = 'macro_surprise_history:v2';
const MACRO_HISTORY_DATA_KEY = 'macro_surprise_events:v2';
const MACRO_HISTORY_YEARS = 5;
const MIN_PRIOR_ERRORS = 12;
const SCORE_LOOKBACK_DAYS = 180;
const DECAY_HALF_LIFE_DAYS = 45;
const MAX_ABS_SURPRISE = 3;
const MAJOR_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

const { classifyMacroRelease, CURRENCY_COUNTRY } = require('./_macro_series');
const crypto = require('node:crypto');
const MACRO_HISTORY_VINTAGES_KEY = 'macro_surprise_vintages:v2';
const MACRO_HISTORY_MANIFEST_KEY = 'macro_surprise_manifest:v2';
const MAX_AGE_DAYS = { weekly:21, monthly:75, quarterly:150 };

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function releaseTimeMs(event) {
  if (event?.released_at && Number.isFinite(Date.parse(event.released_at))) return Date.parse(event.released_at);
  const rawDate = String(event?.date || '');
  if (/^\d{4}-\d{2}-\d{2}T/.test(rawDate)) {
    const ms = Date.parse(rawDate);
    return Number.isFinite(ms) ? ms : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return null;
  const hhmm = String(event?.time_wib || '').match(/(\d{2}):(\d{2})/);
  const time = hhmm ? `${hhmm[1]}:${hhmm[2]}:00+07:00` : '12:00:00+07:00';
  const ms = Date.parse(`${rawDate}T${time}`);
  return Number.isFinite(ms) ? ms : null;
}

function referencePeriod(event, spec, releasedMs) {
  const ref = event.reference_date || event.referenceDate;
  const refMs = ref ? Date.parse(ref) : NaN;
  if (Number.isFinite(refMs) && refMs <= releasedMs) {
    const date = new Date(refMs);
    if (spec.cadence === 'weekly') return date.toISOString().slice(0, 10);
    if (spec.cadence === 'quarterly') return date.getUTCFullYear() + '-Q' + (Math.floor(date.getUTCMonth()/3)+1);
    return date.toISOString().slice(0, 7);
  }
  const text = String(event.reference_period || event.referencePeriod || event.period || '').trim();
  const release = new Date(releasedMs);
  const yearInText = text.match(/\b(20\d{2})\b/);
  let year = yearInText ? Number(yearInText[1]) : release.getUTCFullYear();
  const quarter = text.match(/\bQ([1-4])\b/i);
  if (quarter) {
    if (!yearInText && Number(quarter[1]) > Math.floor(release.getUTCMonth()/3)+1) year--;
    return year + '-Q' + quarter[1];
  }
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const monthMatch = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (monthMatch) {
    const month = monthNames.indexOf(monthMatch[1].toLowerCase());
    if (!yearInText && month > release.getUTCMonth()) year--;
    const ym = year + '-' + String(month+1).padStart(2,'0');
    if (spec.cadence !== 'weekly') return ym;
    const dayMatch = text.slice(monthMatch.index + monthMatch[0].length).match(/^[.\s/,-]*(\d{1,2})(?!\d)/);
    if (dayMatch) return ym + '-' + dayMatch[1].padStart(2,'0');
  }
  // A known release date is a safe fallback identity when reference metadata is
  // absent. Never manufacture an economic reference month from the release month.
  return 'released-' + release.toISOString().slice(0,10);
}

function normalizeMacroRelease(event, { observedAt = new Date().toISOString(), vintageKind = 'observed' } = {}) {
  const currency = String(event?.currency || '').toUpperCase();
  const title = String(event?.event || event?.title || '').trim();
  const spec = classifyMacroRelease(title, currency, event);
  if (!spec) return null;
  const country = String(event.country || event.source_country || '').toUpperCase();
  if (country && country !== CURRENCY_COUNTRY[currency]) return null;
  const actual = finiteNumber(event.actual_raw ?? event.actualRaw);
  const forecast = finiteNumber(event.forecast_raw ?? event.forecastRaw);
  if (actual == null || forecast == null) return null;
  const time_ms = releaseTimeMs(event);
  const observedMs = Date.parse(observedAt);
  if (time_ms == null || !Number.isFinite(observedMs) || time_ms > observedMs) return null;
  const sourceUnit = String(event.unit || event.source_unit || '').trim();
  if (sourceUnit && ((sourceUnit === '%' && spec.unit !== 'percent') || (sourceUnit !== '%' && spec.unit === 'percent'))) return null;
  const date = new Date(time_ms).toISOString().slice(0,10);
  const period = referencePeriod(event, spec, time_ms);
  const id = currency + '|' + spec.series + '|' + period;
  const row = {
    schema_version:2, id, currency, title, date, time_ms, period, actual, forecast,
    previous:finiteNumber(event.previous_raw ?? event.previousRaw), impact:event.impact || null,
    ...spec, source:'tradingview', source_event_id:String(event.source_event_id || event.id || '') || null,
    source_country:country || CURRENCY_COUNTRY[currency], source_unit:sourceUnit || null,
    source_url:event.url || event.source_url || null,
    observed_at:new Date(observedMs).toISOString(),
    vintage_kind:vintageKind === 'historical_snapshot' ? 'historical_snapshot' : 'observed',
    release_stage:/\bflash\b/i.test(title) ? 'flash' : /\b(?:prel|preliminary|prelim)\b/i.test(title) ? 'preliminary' : /\b(?:adv|advance)\b/i.test(title) ? 'advance' : 'unspecified',
  };
  row.content_hash = crypto.createHash('sha256').update(JSON.stringify([
    currency, spec.series, period, time_ms, actual, forecast, row.previous,
  ])).digest('hex').slice(0,24);
  return row;
}

function normalizeMacroReleases(events, options) {
  const rows = (Array.isArray(events) ? events : []).map(event => normalizeMacroRelease(event, options))
    .filter(Boolean).sort((a,b) => a.time_ms-b.time_ms || a.title.localeCompare(b.title));
  const byId = new Map(), conflicts = new Set();
  for (const row of rows) {
    const prior = byId.get(row.id);
    if (!prior) byId.set(row.id,row);
    else if (prior.time_ms === row.time_ms && (prior.actual !== row.actual || prior.forecast !== row.forecast)) conflicts.add(row.id);
  }
  // Same-time contradictory representations are quarantined, not last-writer wins.
  return [...byId.values()].filter(row => !conflicts.has(row.id));
}

function sampleStd(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) && sd > 0 ? sd : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function standardizeMacroHistory(releases, { minPriorErrors = MIN_PRIOR_ERRORS } = {}) {
  const rows = [...(Array.isArray(releases) ? releases : [])]
    .filter(row => row && Number.isFinite(row.actual) && Number.isFinite(row.forecast) && Number.isFinite(row.time_ms))
    .sort((a, b) => a.time_ms - b.time_ms);
  const priorBySeries = new Map();
  const out = [];
  for (const row of rows) {
    const key = `${row.currency}|${row.series}`;
    const prior = priorBySeries.get(key) || [];
    const signedError = (row.actual - row.forecast) * (row.inverse ? -1 : 1);
    const sd = prior.length >= minPriorErrors ? sampleStd(prior) : null;
    out.push({
      ...row,
      forecast_error: signedError,
      prior_n: prior.length,
      error_sd: sd,
      standardized_surprise: sd == null ? null : clamp(signedError / sd, -MAX_ABS_SURPRISE, MAX_ABS_SURPRISE),
    });
    prior.push(signedError);
    priorBySeries.set(key, prior);
  }
  return out;
}

function weightedMean(items) {
  const valid = items.filter(item => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0);
  if (!valid.length) return null;
  const weight = valid.reduce((sum, item) => sum + item.weight, 0);
  return valid.reduce((sum, item) => sum + item.value * item.weight, 0) / weight;
}

function scoreDirection(score) {
  if (!Number.isFinite(score) || score === 0) return null;
  return score > 0 ? 'up' : 'down';
}

function summarizeFamilyBucket(families) {
  const score = families.length
    ? families.reduce((sum, family) => sum + family.score, 0) / families.length
    : null;
  return {
    score,
    direction: scoreDirection(score),
    family_count: families.length,
    families: families.map(family => family.family),
  };
}

function buildMacroPillarScores(releases, {
  asOfMs = Date.now(),
  lookbackDays = SCORE_LOOKBACK_DAYS,
  halfLifeDays = DECAY_HALF_LIFE_DAYS,
  minPriorErrors = MIN_PRIOR_ERRORS,
} = {}) {
  const standardized = standardizeMacroHistory(releases, { minPriorErrors });
  const cutoff = asOfMs - lookbackDays * 86400000;
  const usable = standardized.filter(row => row.time_ms <= asOfMs && row.time_ms >= cutoff);
  const byCurrency = {};

  for (const currency of MAJOR_CURRENCIES) {
    const curRows = usable.filter(row => row.currency === currency);
    const pillars = {};
    for (const pillarName of ['growth', 'inflation']) {
      const pillarRows = curRows.filter(row => row.pillar === pillarName);
      const seriesMap = new Map();
      for (const row of pillarRows) {
        if (!seriesMap.has(row.series)) seriesMap.set(row.series, []);
        seriesMap.get(row.series).push(row);
      }
      const seriesScores = [];
      let staleSeries = 0;
      for (const [series, rows] of seriesMap) {
        const latest = rows.reduce((best, row) => !best || row.time_ms > best.time_ms ? row : best, null);
        const maxAge = MAX_AGE_DAYS[latest.cadence] || MAX_AGE_DAYS.monthly;
        if (asOfMs - latest.time_ms > maxAge * 86400000) { staleSeries++; continue; }
        if (!Number.isFinite(latest.standardized_surprise)) continue;
        const values = rows.map(row => ({
          value: row.standardized_surprise,
          weight: 2 ** (-Math.max(0, asOfMs - row.time_ms) / (halfLifeDays * 86400000)),
        }));
        const score = weightedMean(values);
        if (score != null) {
          seriesScores.push({
            series,
            family: rows[0].family,
            score,
            observations: rows.filter(row => Number.isFinite(row.standardized_surprise)).length,
            latest_at: latest.time_ms,
            latest: {
              indicator: latest.title,
              date: latest.date,
              actual: latest.actual,
              forecast: latest.forecast,
              standardized_surprise: latest.standardized_surprise,
              prior_n: latest.prior_n,
              age_days: Math.max(0, (asOfMs-latest.time_ms)/86400000),
              cadence: latest.cadence || null,
              observed_at: latest.observed_at || null,
              vintage_kind: latest.vintage_kind || null,
              source_event_id: latest.source_event_id || null,
              source_url: latest.source_url || null,
            },
          });
        }
      }
      const families = [];
      for (const family of [...new Set(seriesScores.map(item => item.family))]) {
        const members = seriesScores.filter(item => item.family === family);
        const score = members.reduce((sum, item) => sum + item.score, 0) / members.length;
        families.push({
          family,
          score,
          latest_at: Math.max(...members.map(item => item.latest_at)),
          series: members,
        });
      }
      const score = families.length ? families.reduce((sum, family) => sum + family.score, 0) / families.length : null;
      let ready = families.length >= 1;
      let directionCandidate = scoreDirection(score);
      let status = !ready ? 'insufficient' : directionCandidate || 'neutral';
      let buckets = null;
      if (pillarName === 'growth') {
        const activity = summarizeFamilyBucket(families.filter(family => family.family !== 'labour'));
        const labour = summarizeFamilyBucket(families.filter(family => family.family === 'labour'));
        buckets = { activity, labour };
        ready = activity.family_count >= 1 && labour.family_count >= 1;
        const aligned = ready && activity.direction && activity.direction === labour.direction;
        directionCandidate = aligned ? activity.direction : null;
        status = !ready ? 'insufficient'
          : aligned ? directionCandidate
            : activity.direction && labour.direction && activity.direction !== labour.direction ? 'mixed' : 'neutral';
      }
      pillars[pillarName] = {
        score,
        direction_candidate: directionCandidate,
        status,
        ready,
        family_count: families.length,
        series_count: seriesScores.length,
        families,
        buckets,
        stale_series_count: staleSeries,
        freshness: families.length ? 'fresh' : staleSeries ? 'stale' : 'insufficient',
      };
    }
    byCurrency[currency] = pillars;
  }
  return {
    methodology: 'standardized_forecast_error_equal_family_weight',
    parameters: { min_prior_errors: minPriorErrors, lookback_days: lookbackDays, half_life_days: halfLifeDays, winsor_abs: MAX_ABS_SURPRISE },
    currencies: byCurrency,
  };
}

function assessMacroScoreStability(releases, { asOfMs = Date.now(), halfLives = [30, 45, 60, 90] } = {}) {
  const runs = halfLives.map(halfLifeDays => ({
    half_life_days: halfLifeDays,
    result: buildMacroPillarScores(releases, { asOfMs, halfLifeDays }),
  }));
  const currencies = {};
  for (const currency of MAJOR_CURRENCIES) {
    currencies[currency] = {};
    for (const pillar of ['growth', 'inflation']) {
      const variants = runs.map(run => {
        const item = run.result.currencies[currency][pillar];
        return {
          half_life_days: run.half_life_days,
          ready: item.ready,
          score: item.score,
          direction: item.direction_candidate,
          status: item.status,
          buckets: item.buckets,
        };
      });
      const directions = variants.filter(item => item.ready && item.direction).map(item => item.direction);
      const stableDirection = directions.length === variants.length && new Set(directions).size === 1 ? directions[0] : null;
      const status = stableDirection || (variants.some(item => !item.ready) ? 'insufficient'
        : variants.every(item => item.status === 'neutral') ? 'neutral' : 'mixed');
      currencies[currency][pillar] = {
        direction: stableDirection,
        stable: stableDirection != null,
        status,
        variants,
      };
    }
  }
  return { half_lives_days: halfLives, currencies };
}

function parseReportDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function buildCftcFoundation(currency, cotPayload, nowMs = Date.now()) {
  const position = cotPayload?.positions?.[currency];
  const reportMs = parseReportDateMs(cotPayload?.report_date);
  const ageDays = reportMs == null ? null : Math.max(0, Math.floor((nowMs - reportMs) / 86400000));
  if (!position || !Number.isFinite(position.lev_net) || position.lev_net === 0 || ageDays == null || ageDays > 14) {
    return { direction: null, quality: 'unavailable', report_date: cotPayload?.report_date || null, age_days: ageDays };
  }
  const direction = position.lev_net > 0 ? 'up' : 'down';
  const amDirection = !Number.isFinite(position.am_net) || position.am_net === 0 ? null : position.am_net > 0 ? 'up' : 'down';
  const flowDirection = !Number.isFinite(position.lev_change_net) || position.lev_change_net === 0 ? null : position.lev_change_net > 0 ? 'up' : 'down';
  const amConfirms = amDirection == null ? null : amDirection === direction;
  const flowConfirms = flowDirection == null ? null : flowDirection === direction;
  const levPctile = cotPayload?.percentiles?.[currency]?.lev_pctile;
  const extreme = Number.isFinite(levPctile) && (levPctile <= 10 || levPctile >= 90);
  const quality = amConfirms === false || flowConfirms === false || extreme ? 'reduced' : (amConfirms === true || flowConfirms === true ? 'supported' : 'base');
  return {
    direction,
    quality,
    report_date: cotPayload.report_date,
    release_date: cotPayload.release_date || null,
    age_days: ageDays,
    leveraged_funds: {
      net: position.lev_net,
      change_net: position.lev_change_net ?? null,
      net_pct_oi: position.lev_net_pct_oi ?? null,
      percentile_3y: Number.isFinite(levPctile) ? levPctile : null,
      flow_confirms: flowConfirms,
      extreme,
    },
    asset_manager: {
      direction: amDirection,
      net: position.am_net ?? null,
      change_net: position.am_change_net ?? null,
      net_pct_oi: position.am_net_pct_oi ?? null,
      confirms: amConfirms,
    },
  };
}

// Atomic first-seen payload + index; revisions are append-only by content hash.
// Historical imports are explicitly labelled, never claimed to be true release vintages.
const PERSIST_SCRIPT = `
local inserted = 0
for i = 1, #ARGV, 4 do
  if redis.call('HSETNX', KEYS[2], ARGV[i], ARGV[i+1]) == 1 then
    redis.call('ZADD', KEYS[1], ARGV[i+2], ARGV[i])
    inserted = inserted + 1
  end
  redis.call('HSETNX', KEYS[3], ARGV[i+3], ARGV[i+1])
end
return inserted
`;

async function persistMacroReleases(events, redisCmd, options = {}) {
  if (typeof redisCmd !== 'function') return { stored:0, inserted:0 };
  // Old display caches lack source metadata and may misidentify cadence/SA.
  // Wait for a fresh calendar payload rather than importing ambiguous v1 rows.
  const sourcedEvents = (Array.isArray(events) ? events : []).filter(event =>
    (event.source_event_id || event.id) && (event.source_country || event.country));
  const rows = normalizeMacroReleases(sourcedEvents, options);
  let inserted = 0;
  for (let start=0; start<rows.length; start+=80) {
    const args = [];
    for (const row of rows.slice(start,start+80)) args.push(row.id, JSON.stringify(row), String(row.time_ms), row.id + ':' + row.content_hash);
    inserted += Number(await redisCmd('EVAL',PERSIST_SCRIPT,3,MACRO_HISTORY_INDEX_KEY,MACRO_HISTORY_DATA_KEY,MACRO_HISTORY_VINTAGES_KEY,...args)) || 0;
  }
  return { stored:rows.length, inserted, first_at:rows[0]?.time_ms || null, last_at:rows.at(-1)?.time_ms || null };
}

async function loadMacroReleases(redisCmd, { fromMs = Date.now() - MACRO_HISTORY_YEARS*365*86400000, toMs = Date.now(), requireManifest = true } = {}) {
  if (requireManifest) {
    const raw = await redisCmd('GET',MACRO_HISTORY_MANIFEST_KEY);
    let manifest;
    try { manifest = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return []; }
    if (manifest?.schema_version !== 2 || manifest?.status !== 'ready' || !manifest.content_digest || manifest.source !== 'tradingview') return [];
  }
  const ids = await redisCmd('ZRANGEBYSCORE',MACRO_HISTORY_INDEX_KEY,String(fromMs),String(toMs));
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = [];
  for (let start=0; start<ids.length; start+=200) {
    const chunk = ids.slice(start,start+200);
    const raw = await redisCmd('HMGET',MACRO_HISTORY_DATA_KEY,...chunk);
    for (const item of Array.isArray(raw) ? raw : []) {
      try {
        const row = typeof item === 'string' ? JSON.parse(item) : item;
        if (row?.schema_version === 2 && Number.isFinite(row.time_ms) && row.time_ms>=fromMs && row.time_ms<=toMs) rows.push(row);
      } catch (_) { /* corrupt row stays unavailable */ }
    }
  }
  return rows.sort((a,b) => a.time_ms-b.time_ms);
}

module.exports = {
  MACRO_HISTORY_INDEX_KEY,
  MACRO_HISTORY_VINTAGES_KEY,
  MACRO_HISTORY_MANIFEST_KEY,
  MAX_AGE_DAYS,
  MACRO_HISTORY_DATA_KEY,
  MACRO_HISTORY_YEARS,
  MIN_PRIOR_ERRORS,
  classifyMacroRelease,
  normalizeMacroRelease,
  normalizeMacroReleases,
  standardizeMacroHistory,
  buildMacroPillarScores,
  assessMacroScoreStability,
  buildCftcFoundation,
  persistMacroReleases,
  loadMacroReleases,
};
