'use strict';

// Fondasi Growth/Inflation Smart Bias. Modul ini: (1) memilih rilis makro yang
// definisinya jelas, (2) menyimpan histori actual-vs-consensus, dan (3) menghitung
// standardized surprise kontinu. UI hanya menerima arah yang lolos syarat
// coverage serta sensitivity check; label presentasi tetap menjadi urusan klien.

const MACRO_HISTORY_INDEX_KEY = 'macro_surprise_history:v1';
const MACRO_HISTORY_DATA_KEY = 'macro_surprise_events:v1';
const MACRO_HISTORY_YEARS = 5;
const MIN_PRIOR_ERRORS = 12;
const SCORE_LOOKBACK_DAYS = 180;
const DECAY_HALF_LIFE_DAYS = 45;
const MAX_ABS_SURPRISE = 3;
const MAJOR_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

// Kalender EUR juga memuat rilis negara anggota. Tabel ini menilai EUR sebagai
// satu currency area, jadi indikator nasional tidak boleh menyamar sebagai data
// Euro Area. Proxy nasional dapat diteliti terpisah; ia tidak masuk fondasi awal.
const EUR_NATIONAL_RX = /\b(german(?:y)?|france|french|italy|italian|spain|spanish|belgium|belgian|netherlands|dutch|austria|austrian|ireland|irish|portugal|portuguese|greece|greek)\b/i;
const REVISION_STAGE_RX = /\b(final|revised|revision|2nd|second estimate|3rd|third estimate)\b/i;

const RULES = [
  // Inflation: order from specific to broad so core never falls into headline.
  { re: /\bcore\b.*\b(pce|personal consumption expenditure)/i, pillar: 'inflation', family: 'core_consumer_prices', series: 'core_pce' },
  { re: /\b(pce|personal consumption expenditure).*(price|inflation)/i, pillar: 'inflation', family: 'headline_consumer_prices', series: 'pce_prices' },
  { re: /(?:\bcore\b.*\b(?:cpi|hicp|consumer price)|\b(?:cpi|hicp|consumer price).*\bcore\b)/i, pillar: 'inflation', family: 'core_consumer_prices', series: 'core_consumer_prices' },
  { re: /\b(cpi|hicp|consumer price(?: index)?|inflation rate)\b/i, pillar: 'inflation', family: 'headline_consumer_prices', series: 'consumer_prices' },
  { re: /(?:\bcore\b.*\b(?:ppi|producer price)|\b(?:ppi|producer price).*\bcore\b)/i, pillar: 'inflation', family: 'producer_prices', series: 'core_producer_prices' },
  { re: /\b(ppi|producer price(?: index)?)\b/i, pillar: 'inflation', family: 'producer_prices', series: 'producer_prices' },

  // Growth/activity. Related releases share a family so they cannot become
  // independent votes merely because a calendar publishes several variants.
  { re: /\bcomposite pmi\b/i, pillar: 'growth', family: 'activity_survey', series: 'composite_pmi' },
  { re: /\b(?:services|service|non.manufacturing) pmi\b/i, pillar: 'growth', family: 'activity_survey', series: 'services_pmi' },
  { re: /\bmanufacturing pmi\b/i, pillar: 'growth', family: 'activity_survey', series: 'manufacturing_pmi' },
  { re: /\b(?:gross domestic product|gdp)\b/i, pillar: 'growth', family: 'output', series: 'gdp' },
  { re: /\b(?:industrial production|industrial output)\b/i, pillar: 'growth', family: 'output', series: 'industrial_production' },
  { re: /\bretail sales\b/i, pillar: 'growth', family: 'consumption', series: 'retail_sales' },
  { re: /\bhousehold spending\b/i, pillar: 'growth', family: 'consumption', series: 'household_spending' },
  { re: /\b(?:non.?farm payrolls?|nfp)\b/i, pillar: 'growth', family: 'labour', series: 'payrolls' },
  { re: /\bemployment change\b/i, pillar: 'growth', family: 'labour', series: 'employment_change' },
  { re: /\b(wage growth|average hourly earnings|average weekly earnings|earnings growth)\b/i, pillar: 'growth', family: 'labour', series: 'wages' },
  { re: /\bunemployment rate\b/i, pillar: 'growth', family: 'labour', series: 'unemployment_rate', inverse: true },
  { re: /\b(?:initial )?jobless claims?\b/i, pillar: 'growth', family: 'labour', series: 'jobless_claims', inverse: true, cadence: 'weekly' },
  { re: /\bclaimant count(?: change)?\b/i, pillar: 'growth', family: 'labour', series: 'claimant_count', inverse: true },
  { re: /\bmichigan.*\bconsumer sentiment\b/i, pillar: 'growth', family: 'demand_survey', series: 'michigan_consumer_sentiment' },
  { re: /\bconsumer (?:confidence|sentiment)\b/i, pillar: 'growth', family: 'demand_survey', series: 'consumer_confidence' },
  { re: /\bifo business/i, pillar: 'growth', family: 'business_survey', series: 'ifo_business' },
  { re: /\bzew economic sentiment/i, pillar: 'growth', family: 'business_survey', series: 'zew_sentiment' },
  { re: /\bkof economic barometer/i, pillar: 'growth', family: 'business_survey', series: 'kof_barometer' },
  { re: /\btankan\b/i, pillar: 'growth', family: 'business_survey', series: 'tankan' },
  { re: /\bbusiness (?:confidence|climate)\b/i, pillar: 'growth', family: 'business_survey', series: 'business_confidence' },
];

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function periodKind(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(qoq|q\/q|quarter(?:ly)?)\b/.test(t)) return 'qoq';
  if (/\b(yoy|y\/y|year.on.year|annual)\b/.test(t)) return 'yoy';
  if (/\b(mom|m\/m|month.on.month|monthly)\b/.test(t)) return 'mom';
  return 'level';
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

function classifyMacroRelease(title, currency) {
  const cur = String(currency || '').toUpperCase();
  const text = String(title || '').trim();
  if (!MAJOR_CURRENCIES.has(cur) || !text) return null;
  if (cur === 'EUR' && EUR_NATIONAL_RX.test(text)) return null;
  // First-print surprises carry the new information. Later estimates/revisions
  // of the same reference period are not independent evidence and would both
  // duplicate the family and contaminate its forecast-error distribution.
  if (REVISION_STAGE_RX.test(text)) return null;
  const rule = RULES.find(item => item.re.test(text));
  if (!rule) return null;
  const period = periodKind(text);
  const cadence = rule.cadence || (period === 'qoq' ? 'quarterly' : 'monthly');
  return {
    pillar: rule.pillar,
    family: rule.family,
    series: `${rule.series}:${period}`,
    inverse: !!rule.inverse,
    cadence,
  };
}

function normalizeMacroRelease(event) {
  const currency = String(event?.currency || '').toUpperCase();
  const title = String(event?.event || event?.title || '').trim();
  const spec = classifyMacroRelease(title, currency);
  if (!spec) return null;
  const actual = finiteNumber(event.actual_raw ?? event.actualRaw);
  const forecast = finiteNumber(event.forecast_raw ?? event.forecastRaw);
  if (actual == null || forecast == null) return null;
  const time_ms = releaseTimeMs(event);
  if (time_ms == null) return null;
  const date = new Date(time_ms).toISOString().slice(0, 10);
  const period = typeof event.period === 'string' && event.period.trim() ? event.period.trim() : null;
  // Calendar `period` often contains only "Sep" or "Q3" without a year. Prefix
  // release year so five different September releases do not overwrite each
  // other in Redis. Direct/raw and cached representations still converge.
  const periodId = period ? `${date.slice(0, 4)}-${period.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : date;
  const id = `${currency}|${spec.series}|${periodId}`;
  return {
    id,
    currency,
    title,
    date,
    time_ms,
    period,
    actual,
    forecast,
    previous: finiteNumber(event.previous_raw ?? event.previousRaw),
    impact: event.impact || null,
    ...spec,
  };
}

function normalizeMacroReleases(events) {
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const row = normalizeMacroRelease(event);
    if (row) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.time_ms - b.time_ms);
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
  const usable = standardized.filter(row => row.time_ms <= asOfMs && row.time_ms >= cutoff && Number.isFinite(row.standardized_surprise));
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
      for (const [series, rows] of seriesMap) {
        const values = rows.map(row => ({
          value: row.standardized_surprise,
          weight: 2 ** (-Math.max(0, asOfMs - row.time_ms) / (halfLifeDays * 86400000)),
        }));
        const score = weightedMean(values);
        if (score != null) {
          const latest = rows.reduce((best, row) => !best || row.time_ms > best.time_ms ? row : best, null);
          seriesScores.push({
            series,
            family: rows[0].family,
            score,
            observations: rows.length,
            latest_at: latest.time_ms,
            latest: {
              indicator: latest.title,
              date: latest.date,
              actual: latest.actual,
              forecast: latest.forecast,
              standardized_surprise: latest.standardized_surprise,
              prior_n: latest.prior_n,
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

async function persistMacroReleases(events, redisCmd) {
  if (typeof redisCmd !== 'function') return { stored: 0 };
  const rows = normalizeMacroReleases(events);
  if (!rows.length) return { stored: 0 };
  const chunkSize = 80;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const hset = ['HSET', MACRO_HISTORY_DATA_KEY];
    const zadd = ['ZADD', MACRO_HISTORY_INDEX_KEY];
    for (const row of chunk) {
      hset.push(row.id, JSON.stringify(row));
      zadd.push(String(row.time_ms), row.id);
    }
    await redisCmd(...hset);
    await redisCmd(...zadd);
  }
  return { stored: rows.length, first_at: rows[0].time_ms, last_at: rows[rows.length - 1].time_ms };
}

async function loadMacroReleases(redisCmd, { fromMs = Date.now() - MACRO_HISTORY_YEARS * 365 * 86400000, toMs = Date.now() } = {}) {
  const ids = await redisCmd('ZRANGEBYSCORE', MACRO_HISTORY_INDEX_KEY, String(fromMs), String(toMs));
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = [];
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const raw = await redisCmd('HMGET', MACRO_HISTORY_DATA_KEY, ...chunk);
    for (const item of Array.isArray(raw) ? raw : []) {
      try { if (item) rows.push(JSON.parse(item)); } catch (_) { /* skip corrupt row */ }
    }
  }
  return rows.sort((a, b) => a.time_ms - b.time_ms);
}

module.exports = {
  MACRO_HISTORY_INDEX_KEY,
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
