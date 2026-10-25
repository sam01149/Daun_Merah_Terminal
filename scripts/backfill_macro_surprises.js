'use strict';

// One-off/re-runnable backfill for the Smart Bias macro foundation.
// Usage:
//   node scripts/backfill_macro_surprises.js --months=60          (dry run)
//   node scripts/backfill_macro_surprises.js --months=60 --write  (persist Redis)

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeMacroReleases,
  persistMacroReleases,
  buildMacroPillarScores,
  assessMacroScoreStability,
  loadMacroReleases,
} = require('../api/_macro_surprise');

function loadLocalEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const WRITE = process.argv.includes('--write');
const DETAIL = process.argv.includes('--detail');
const MONTHS = Math.max(1, Math.min(120, Number.parseInt(argValue('months', '60'), 10) || 60));
const AS_OF = new Date(argValue('as-of', new Date().toISOString()));
if (!Number.isFinite(AS_OF.getTime())) throw new Error('Invalid --as-of date');

loadLocalEnv();

async function redisCmd(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL/TOKEN missing from .env.local');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Redis: ${payload.error}`);
  return payload.result;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/economic-calendar/',
};
const COUNTRIES = 'US,EU,GB,JP,CA,AU,NZ,CH';

async function fetchRange(from, to, depth = 0) {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), countries: COUNTRIES });
  const response = await fetch(`https://economic-calendar.tradingview.com/events?${params}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Calendar HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.result)) throw new Error('Calendar malformed response');
  // Endpoint caps large ranges around 2,000 rows. Split instead of accepting a
  // silently truncated history, because that would bias the standard deviation.
  if (payload.result.length >= 1900 && depth < 5) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    return [...await fetchRange(from, mid, depth + 1), ...await fetchRange(mid, to, depth + 1)];
  }
  return payload.result;
}

async function main() {
  const all = new Map();
  let stored = 0;
  for (let offset = MONTHS - 1; offset >= 0; offset--) {
    const to = new Date(Date.UTC(AS_OF.getUTCFullYear(), AS_OF.getUTCMonth() - offset + 1, 1));
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
    const cappedTo = to > AS_OF ? AS_OF : to;
    if (from >= cappedTo) continue;
    const raw = await fetchRange(from, cappedTo);
    const normalized = normalizeMacroReleases(raw);
    for (const row of normalized) all.set(row.id, row);
    if (WRITE && normalized.length) stored += (await persistMacroReleases(raw, redisCmd)).stored;
    process.stdout.write(`month ${from.toISOString().slice(0, 7)} raw=${raw.length} usable=${normalized.length}\n`);
  }
  const rows = [...all.values()];
  const coverage = {};
  const seriesCoverage = {};
  for (const row of rows) {
    const key = `${row.currency}:${row.pillar}`;
    coverage[key] = (coverage[key] || 0) + 1;
    const seriesKey = `${row.currency}:${row.pillar}:${row.series}`;
    seriesCoverage[seriesKey] = (seriesCoverage[seriesKey] || 0) + 1;
  }
  const scored = buildMacroPillarScores(rows, { asOfMs: AS_OF.getTime() });
  const scoreCoverage = Object.fromEntries(Object.entries(scored.currencies).map(([currency, pillars]) => [currency, {
    growth: { ready: pillars.growth.ready, families: pillars.growth.family_count, series: pillars.growth.series_count, score: pillars.growth.score },
    inflation: { ready: pillars.inflation.ready, families: pillars.inflation.family_count, series: pillars.inflation.series_count, score: pillars.inflation.score },
  }]));
  const stability = assessMacroScoreStability(rows, { asOfMs: AS_OF.getTime() });
  const stableDirections = Object.fromEntries(Object.entries(stability.currencies).map(([currency, pillars]) => [currency, {
    growth: pillars.growth.direction,
    inflation: pillars.inflation.direction,
  }]));
  let persistedUnique = null;
  if (WRITE) {
    const firstMs = rows.length ? Math.min(...rows.map(row => row.time_ms)) - 86400000 : AS_OF.getTime();
    persistedUnique = (await loadMacroReleases(redisCmd, { fromMs: firstMs, toMs: AS_OF.getTime() })).length;
  }
  process.stdout.write(`${JSON.stringify({ mode: WRITE ? 'write' : 'dry_run', months: MONTHS, unique_releases: rows.length, stored, persisted_unique: persistedUnique, coverage, score_coverage: scoreCoverage, stable_directions: stableDirections, ...(DETAIL ? { series_coverage: seriesCoverage, sensitivity: stability } : {}) }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
