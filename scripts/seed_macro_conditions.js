'use strict';

// Dry run by default. --refresh fetches this month's latest actuals;
// --write seeds isolated conditions keys and activates only after verification.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const store=require('../api/_macro_conditions_store');
const {buildMacroConditions}=require('../api/_macro_candidate');
const {fetchRange}=require('./rebuild_macro_foundation');
const digest=rows=>crypto.createHash('sha256').update(JSON.stringify(rows.map(row=>[row.id,row.content_hash,row.time_ms,row.observed_at]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');

async function seed(events,redis,{asOfMs=Date.now()}={}) {
  const rows=store.conditionRows(events,{asOfMs,vintageKind:'historical_snapshot'});
  if(!rows.length) throw Error('Empty conditions seed');
  const existing=await store.loadMacroConditions(redis,{asOfMs,requireManifest:false});
  const expected=new Map(rows.map(row=>[row.id,row]));
  for(const row of existing) {
    const original=expected.get(row.id);
    if(!original || row.content_hash!==original.content_hash || row.observed_at!==original.observed_at) {
      throw Error('Conditions store contains different/newer data; refusing historical reseed');
    }
  }
  await store.persistMacroConditions(events,redis,{asOfMs,vintageKind:'historical_snapshot'});
  const readback=await store.loadMacroConditions(redis,{asOfMs,requireManifest:false});
  if(readback.length!==rows.length || digest(readback)!==digest(rows)
    || Number(await redis('HLEN',store.DATA_KEY))!==rows.length || Number(await redis('ZCARD',store.INDEX_KEY))!==rows.length) {
    throw Error('Conditions seed verification failed; manifest not activated');
  }
  const coverage=buildMacroConditions(readback,{asOfMs});
  if(Object.values(coverage.currencies).some(row=>row.growth.coverage!=='complete')) throw Error('Missing GDP/labour coverage; manifest not activated');
  const manifest={schema_version:1,status:'ready',verified_at:new Date().toISOString(),source:'tradingview',
    seed_observations:rows.length,content_digest:digest(rows),lookback_days:store.LOOKBACK_DAYS,
    limitation:'Historical vendor snapshots used as currently known conditions; not original release vintages.'};
  await redis('SET',store.MANIFEST_KEY,JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const arg=(name,fallback)=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
  const now=new Date(),asOfMs=now.getTime();
  const input=arg('raw-dir','.cache/macro-foundation-v2/raw');
  const out=arg('out','.cache/macro-conditions-seed');fs.mkdirSync(out,{recursive:true});
  const snapshots=fs.readdirSync(input).filter(file=>/^\d{4}-\d{2}\.json$/.test(file)).sort()
    .map(file=>JSON.parse(fs.readFileSync(path.join(input,file),'utf8')));
  if(process.argv.includes('--refresh')) {
    const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const snapshot={source:'tradingview',from:from.toISOString(),to:now.toISOString(),
      rows:await fetchRange(from,now),fetched_at:new Date().toISOString()};
    snapshots.push(snapshot);
    fs.writeFileSync(path.join(out,'refreshed-source.json'),JSON.stringify(snapshot));
  }
  const observedNow=Date.now();
  const events=snapshots.flatMap(snapshot=>{
    if(snapshot.source!=='tradingview'||!Array.isArray(snapshot.rows)||!Number.isFinite(Date.parse(snapshot.fetched_at))) throw Error('Invalid source snapshot');
    return snapshot.rows.map(event=>({...event,source_fetched_at:snapshot.fetched_at}));
  });
  const rows=store.conditionRows(events,{asOfMs:observedNow,vintageKind:'historical_snapshot'});
  const conditions=buildMacroConditions(rows,{asOfMs:observedNow});
  const report={as_of:new Date(observedNow).toISOString(),observations:rows.length,digest:digest(rows),
    currencies:Object.fromEntries(Object.entries(conditions.currencies).map(([currency,row])=>[currency,{
      growth:row.growth.state,growth_coverage:row.growth.coverage,inflation:row.inflation.state,inflation_coverage:row.inflation.coverage,
    }]))};
  fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'observations.json'),JSON.stringify(rows));
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--write')) {
    if(fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
    const {url,token}=require('../api/_redis').resolveRedisCredentials();
    if(!url||!token)throw Error('Missing Redis credentials');
    const redis=async(...args)=>{
      const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw Error('Redis HTTP '+response.status);
      const payload=await response.json();if(payload.error)throw Error(payload.error);return payload.result;
    };
    const manifest=await seed(events,redis,{asOfMs:observedNow});
    fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
    console.log('Conditions seed verified and activated; surprise history untouched.');
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={seed,digest};
