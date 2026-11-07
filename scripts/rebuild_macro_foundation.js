'use strict';

// Dry run: node scripts/rebuild_macro_foundation.js
// Fetch missing monthly snapshots: add --fetch (current month is refreshed).
// Populate isolated v2 keys, verify, then publish manifest: add --write.
// v1 is never mutated. Raw snapshots/reports remain private in .cache/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const macro = require('../api/_macro_surprise');
const COUNTRIES = 'US,EU,GB,JP,CA,AU,NZ,CH';
const headers = { Origin:'https://www.tradingview.com', Referer:'https://www.tradingview.com/economic-calendar/', 'User-Agent':'Mozilla/5.0 (compatible; FJFeed/1.0)' };

async function fetchRange(from, to, depth=0) {
  const params = new URLSearchParams({from:from.toISOString(),to:to.toISOString(),countries:COUNTRIES});
  const response = await fetch('https://economic-calendar.tradingview.com/events?'+params,{headers,signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error('Calendar HTTP '+response.status);
  const payload = await response.json();
  if (!Array.isArray(payload.result)) throw Error('Malformed calendar response');
  if (payload.result.length >= 1900) {
    if (depth >= 7) throw Error('Calendar range still truncated');
    const mid = new Date((from.getTime()+to.getTime())/2);
    return [...await fetchRange(from,mid,depth+1),...await fetchRange(mid,to,depth+1)];
  }
  return payload.result;
}

function digest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows.map(row => [row.id,row.content_hash]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}

function prepareSnapshots(snapshots) {
  const candidates = new Map(), conflicts = new Set(), rejected = {};
  let rawCount = 0;
  const batches = [];
  for (const snapshot of snapshots) {
    if (snapshot.source !== 'tradingview' || !Array.isArray(snapshot.rows) || !Number.isFinite(Date.parse(snapshot.fetched_at))) throw Error('Invalid raw snapshot');
    const options = { observedAt:snapshot.fetched_at, vintageKind:'historical_snapshot' };
    const accepted = [];
    for (const event of snapshot.rows) {
      rawCount++;
      const row = macro.normalizeMacroRelease(event,options);
      if (!row) {
        if (Number.isFinite(event.actualRaw) && Number.isFinite(event.forecastRaw)) {
          const key = event.currency+'|'+event.title;
          rejected[key] = (rejected[key] || 0)+1;
        }
        continue;
      }
      accepted.push(event);
      const prior = candidates.get(row.id);
      if (!prior || row.time_ms < prior.time_ms) candidates.set(row.id,row);
      else if (row.time_ms === prior.time_ms && (row.actual !== prior.actual || row.forecast !== prior.forecast)) conflicts.add(row.id);
    }
    batches.push({events:accepted,options});
  }
  const rows = [...candidates.values()].filter(row=>!conflicts.has(row.id)).sort((a,b)=>a.time_ms-b.time_ms);
  return { rows, batches, conflicts:[...conflicts], rejected, rawCount };
}

async function publish(prepared, redis, asOfMs) {
  if (prepared.conflicts.length) throw Error('Conflicting series/periods require review before write');
  if (!prepared.rows.length) throw Error('Empty history cannot be activated');
  // Re-running is safe only for the same immutable payloads. Never erase keys.
  const before = await macro.loadMacroReleases(redis,{fromMs:0,toMs:asOfMs,requireManifest:false});
  const expected = new Map(prepared.rows.map(row=>[row.id,row.content_hash]));
  for (const row of before) if (expected.get(row.id) !== row.content_hash) throw Error('Existing v2 content differs; refusing to overwrite');
  for (const batch of prepared.batches) await macro.persistMacroReleases(batch.events,redis,batch.options);
  const stored = await macro.loadMacroReleases(redis,{fromMs:0,toMs:asOfMs,requireManifest:false});
  const indexCount = Number(await redis('ZCARD',macro.MACRO_HISTORY_INDEX_KEY));
  const hashCount = Number(await redis('HLEN',macro.MACRO_HISTORY_DATA_KEY));
  if (stored.length !== prepared.rows.length || indexCount !== stored.length || hashCount !== stored.length || digest(stored) !== digest(prepared.rows)) throw Error('Roundtrip/count/digest verification failed; manifest not activated');
  const manifest = {
    schema_version:2,status:'ready',verified_at:new Date().toISOString(),
    release_count:stored.length,content_digest:digest(stored),
    source:'tradingview',vintage_kind:'historical_snapshot',
    vintage_limitation:'Historical actual/consensus are vendor snapshots, not verified first-release vintages. New observations are frozen on first ingestion.',
  };
  await redis('SET',macro.MACRO_HISTORY_MANIFEST_KEY,JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const arg = (name,fallback)=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3) || fallback;
  const dir = path.resolve(arg('dir','.cache/macro-foundation-v2'));
  const rawDir = path.join(dir,'raw');
  const asOf = new Date(arg('as-of',new Date().toISOString()));
  if (!Number.isFinite(asOf.getTime())) throw Error('Invalid as-of');
  fs.mkdirSync(rawDir,{recursive:true});
  const snapshots = [];
  for (let offset=60;offset>=0;offset--) {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(),asOf.getUTCMonth()-offset,1));
    const end = new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,1));
    const to = end>asOf?asOf:end;
    const file = path.join(rawDir,from.toISOString().slice(0,7)+'.json');
    if (process.argv.includes('--fetch') && (!fs.existsSync(file) || offset===0)) {
      const rows = await fetchRange(from,to);
      fs.writeFileSync(file,JSON.stringify({source:'tradingview',fetched_at:new Date().toISOString(),from:from.toISOString(),to:to.toISOString(),rows}));
    }
    if (!fs.existsSync(file)) throw Error('Missing monthly snapshot '+path.basename(file)+'; run --fetch');
    const snapshot = JSON.parse(fs.readFileSync(file,'utf8'));
    if (snapshot.from !== from.toISOString() || Date.parse(snapshot.to)<to.getTime()-86400000) throw Error('Incomplete monthly snapshot '+path.basename(file));
    snapshots.push(snapshot);
  }
  const prepared = prepareSnapshots(snapshots);
  const scores = macro.buildMacroPillarScores(prepared.rows,{asOfMs:asOf.getTime()});
  const stability = macro.assessMacroScoreStability(prepared.rows,{asOfMs:asOf.getTime()});
  const coverage = Object.fromEntries(Object.entries(scores.currencies).map(([currency,pillars])=>[currency,Object.fromEntries(Object.entries(pillars).map(([name,pillar])=>[name,{
    releases:prepared.rows.filter(row=>row.currency===currency&&row.pillar===name).length,
    ready:pillar.ready,series:pillar.series_count,families:pillar.family_count,stale_series:pillar.stale_series_count,
    direction:stability.currencies[currency][name].direction,status:stability.currencies[currency][name].status,
  }]))]));
  const report = {as_of:asOf.toISOString(),months:snapshots.length,raw_count:prepared.rawCount,release_count:prepared.rows.length,digest:digest(prepared.rows),conflicts:prepared.conflicts,coverage,rejected:prepared.rejected};
  fs.writeFileSync(path.join(dir,'validation.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(dir,'normalized.json'),JSON.stringify(prepared.rows));
  console.log(JSON.stringify({...report,rejected_title_count:Object.keys(report.rejected).length,rejected:undefined},null,2));
  if (process.argv.includes('--write')) {
    if (Object.values(coverage).some(pillars=>Object.values(pillars).some(pillar=>pillar.releases<13))) throw Error('Missing currency/pillar history');
    if (fs.existsSync(path.join(__dirname,'..','.env.local'))) process.loadEnvFile(path.join(__dirname,'..','.env.local'));
    const {resolveRedisCredentials} = require('../api/_redis');
    const {url,token} = resolveRedisCredentials();
    if (!url || !token) throw Error('Redis credentials unavailable');
    const redis = async (...args)=>{
      const response = await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw Error('Redis HTTP '+response.status);
      const payload = await response.json();
      if (payload.error) throw Error(payload.error);
      return payload.result;
    };
    const backup = {
      captured_at:new Date().toISOString(),
      'macro_surprise_events:v1':await redis('HGETALL','macro_surprise_events:v1'),
      'macro_surprise_history:v1':await redis('ZRANGE','macro_surprise_history:v1',0,-1,'WITHSCORES'),
    };
    fs.writeFileSync(path.join(dir,'legacy-backup-'+Date.now()+'.json'),JSON.stringify(backup));
    const manifest = await publish(prepared,redis,asOf.getTime());
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
    console.log('Verified and activated v2 manifest; v1 untouched.');
  }
}

if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = { prepareSnapshots,publish,digest,fetchRange,main };
