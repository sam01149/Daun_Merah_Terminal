'use strict';

// Read-only, offline audit. Input is a local snapshot of the four Redis values;
// this script never loads credentials, calls an AI, or writes production data.
// node scripts/audit_smart_bias_components.js --input=path.json --as-of=ISO_DATE
const fs = require('node:fs');
const macro = require('../api/_macro_surprise');
const smart = require('../api/_smart_bias');

function argument(name) {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function parsed(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function audit(input, asOfMs) {
  const raw = input[macro.MACRO_HISTORY_DATA_KEY];
  const releases = (Array.isArray(raw) ? raw.filter((_, i) => i % 2 === 1) : Object.values(raw || {})).map(parsed);
  const inWindow = releases.filter(row => row.time_ms >= asOfMs - 5 * 365 * 86400000 && row.time_ms <= asOfMs);
  const scores = macro.buildMacroPillarScores(inWindow, { asOfMs });
  const stability = macro.assessMacroScoreStability(inWindow, { asOfMs });
  const bySeries = new Map();
  for (const row of releases) {
    const key = `${row.currency}|${row.series}`;
    if (!bySeries.has(key)) bySeries.set(key, new Set());
    bySeries.get(key).add(row.title);
  }
  // Multiple titles are candidates for inspection, not automatically bugs:
  // renamed ISM titles, for example, can legitimately denote the same series.
  const multipleTitles = [...bySeries].filter(([, titles]) => titles.size > 1)
    .map(([series, titles]) => ({ series, titles:[...titles] }));
  const probes = [
    ['USD', 'Core Inflation Rate YoY'], ['USD', 'Inflation Rate YoY'],
    ['USD', 'GDP Price Index QoQ Adv'], ['USD', 'GDP Growth Rate QoQ Adv'],
    ['USD', 'GDP Sales QoQ Adv'], ['USD', 'Initial Jobless Claims'],
    ['USD', 'Continuing Jobless Claims'], ['AUD', 'Quarterly Inflation Rate YoY'],
  ].map(([currency, title]) => ({ currency, title, classification:macro.classifyMacroRelease(title, currency) }));
  const sourceEvents = ['GDP Price Index QoQ Adv', 'GDP Growth Rate QoQ Adv', 'GDP Sales QoQ Adv']
    .map((title, i) => ({ currency:'USD', title, period:'Q3 2026', date:'2026-10-29T12:30:00Z', actualRaw:i+1, forecastRaw:2 }));
  const collision = macro.normalizeMacroReleases(sourceEvents);
  const sparse = [-1, 1, 0.000001].map((actual, i) => ({
    id:String(i), currency:'USD', series:'probe', pillar:'inflation', family:'probe',
    actual, forecast:0, time_ms:asOfMs - (3-i)*86400000,
  }));
  const decayProbe = [0, 90].map(days => {
    const pillar = macro.buildMacroPillarScores(sparse, { asOfMs:asOfMs+days*86400000, minPriorErrors:2 }).currencies.USD.inflation;
    return { elapsed_days:days, score:pillar.score, status:pillar.status };
  });
  const cot = parsed(input.cot_cache_v2) || {};
  const cb = parsed(input.cb_bias) || {};
  return {
    as_of:new Date(asOfMs).toISOString(), stored_rows:releases.length, in_five_year_window:inWindow.length,
    classification_probes:probes,
    normalization_collision:{ inputs:sourceEvents.length, outputs:collision.length, retained_titles:collision.map(row => row.title) },
    multiple_title_series:multipleTitles,
    decay_and_tiny_score_probe:decayProbe,
    missing_position_probe:smart.buildPositioning('USD', { report_date:new Date(asOfMs).toISOString().slice(0,10), positions:{} }, {}, asOfMs),
    currencies:Object.keys(scores.currencies).map(currency => {
      const pillars = scores.currencies[currency];
      const st = stability.currencies[currency];
      const position = smart.buildPositioning(currency, cot, {}, asOfMs);
      return {
        currency,
        growth:{ score:pillars.growth.score, state:st.growth.status, activity:pillars.growth.buckets.activity.score, labour:pillars.growth.buckets.labour.score,
          variants:st.growth.variants.map(v => ({ half_life_days:v.half_life_days, status:v.status })) },
        inflation:{ score:pillars.inflation.score, state:st.inflation.status, families:pillars.inflation.families.map(f => ({family:f.family,score:f.score,latest:new Date(f.latest_at).toISOString()})) },
        central_bank:{ bias:cb[currency]?.bias, updated_at:cb[currency]?.updated_at, evidence:cb[currency]?.source_headlines || [] },
        positioning:position,
      };
    }),
  };
}

if (require.main === module) {
  try {
    const file = argument('input');
    const asOfMs = Date.parse(argument('as-of'));
    if (!file || !Number.isFinite(asOfMs)) throw new Error('Usage: node scripts/audit_smart_bias_components.js --input=snapshot.json --as-of=ISO_DATE');
    const input = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    process.stdout.write(JSON.stringify(audit(input, asOfMs), null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { audit };
