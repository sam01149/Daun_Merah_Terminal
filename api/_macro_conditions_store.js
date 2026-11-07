'use strict';

const {normalizeMacroObservation}=require('./_macro_surprise');
const crypto=require('node:crypto');
const INDEX_KEY='macro_conditions_index:v1';
const DATA_KEY='macro_conditions_events:v1';
const VINTAGES_KEY='macro_conditions_vintages:v1';
const MANIFEST_KEY='macro_conditions_manifest:v1';
const LOOKBACK_DAYS=180;

function conditionRows(events,options={}) {
  const asOfMs=options.asOfMs ?? Date.now();
  const groups=new Map();
  for(const event of Array.isArray(events)?events:[]) {
    if (!(event?.source_event_id || event?.id) || !(event.source_country || event.country)) continue;
    const row=normalizeMacroObservation(event,{...options,observedAt:event.source_fetched_at || options.observedAt,allowRevisions:true});
    if (!row || row.time_ms>asOfMs || row.time_ms<asOfMs-LOOKBACK_DAYS*86400000 || Date.parse(row.observed_at)>asOfMs) continue;
    if(!groups.has(row.id)) groups.set(row.id,[]);
    groups.get(row.id).push(row);
  }
  const rows=[];
  for(const versions of groups.values()) {
    versions.sort((a,b)=>b.time_ms-a.time_ms || Date.parse(b.observed_at)-Date.parse(a.observed_at));
    const latest=versions[0];
    if(versions.some(row=>row.time_ms===latest.time_ms && row.observed_at===latest.observed_at
      && (row.actual!==latest.actual || row.previous!==latest.previous))) continue;
    rows.push(latest);
  }
  return rows.sort((a,b)=>a.id.localeCompare(b.id));
}

const WRITE_SCRIPT=`
local updated = 0
for i=1,#ARGV,3 do
  local row=cjson.decode(ARGV[i+1])
  local prior=redis.call('HGET',KEYS[2],ARGV[i])
  local replace=true
  if prior then
    local ok, old=pcall(cjson.decode,prior)
    if ok and type(old.time_ms)=='number' and type(old.observed_at)=='string' then
      replace=row.time_ms>old.time_ms or (row.time_ms==old.time_ms and row.observed_at>old.observed_at)
    end
  end
  redis.call('HSETNX',KEYS[3],ARGV[i+2],ARGV[i+1])
  if replace then
    redis.call('HSET',KEYS[2],ARGV[i],ARGV[i+1])
    redis.call('ZADD',KEYS[1],row.time_ms,ARGV[i])
    updated=updated+1
  end
end
return updated
`;

async function persistMacroConditions(events,redis,options={}) {
  if(typeof redis!=='function') return {accepted:0,updated:0};
  const rows=conditionRows(events,options);
  if(!rows.length) return {accepted:0,updated:0};
  const batchKey=options.batchKey ? 'macro_conditions_batch:'+options.batchKey+':v1' : null;
  const fingerprint=batchKey ? crypto.createHash('sha256').update(JSON.stringify(rows.map(row=>[row.id,row.source_event_id,row.content_hash,row.source_url]))).digest('hex') : null;
  if(batchKey && await redis('GET',batchKey)===fingerprint) return {accepted:rows.length,updated:0,unchanged:true};
  let updated=0;
  for(let i=0;i<rows.length;i+=80) {
    const args=rows.slice(i,i+80).flatMap(row=>[row.id,JSON.stringify(row),row.id+':'+row.source_event_id+':'+row.content_hash]);
    updated+=Number(await redis('EVAL',WRITE_SCRIPT,3,INDEX_KEY,DATA_KEY,VINTAGES_KEY,...args))||0;
  }
  if(batchKey) await redis('SET',batchKey,fingerprint,'EX',21600);
  return {accepted:rows.length,updated};
}

async function loadMacroConditions(redis,{asOfMs=Date.now(),requireManifest=true}={}) {
  if(requireManifest) {
    let manifest;
    try {const raw=await redis('GET',MANIFEST_KEY);manifest=typeof raw==='string'?JSON.parse(raw):raw;} catch(_){return [];}
    if(manifest?.schema_version!==1 || manifest.status!=='ready' || manifest.source!=='tradingview' || !manifest.content_digest) return [];
  }
  const ids=await redis('ZRANGEBYSCORE',INDEX_KEY,String(asOfMs-LOOKBACK_DAYS*86400000),String(asOfMs));
  if(!Array.isArray(ids)||!ids.length)return [];
  const rows=[];
  for(let i=0;i<ids.length;i+=200) {
    const chunk=ids.slice(i,i+200);
    const values=await redis('HMGET',DATA_KEY,...chunk);
    for(const [j,value] of (Array.isArray(values)?values:[]).entries()) {
      try {
        const row=typeof value==='string'?JSON.parse(value):value;
        if(row?.schema_version===2 && row.id===chunk[j] && typeof row.series==='string' && Number.isFinite(row.actual) && Number.isFinite(row.time_ms)
          && row.time_ms<=asOfMs && row.time_ms>=asOfMs-LOOKBACK_DAYS*86400000 && Date.parse(row.observed_at)<=asOfMs) rows.push(row);
      } catch(_){/* corrupted rows stay unavailable */}
    }
  }
  return rows;
}

module.exports={INDEX_KEY,DATA_KEY,VINTAGES_KEY,MANIFEST_KEY,LOOKBACK_DAYS,conditionRows,persistMacroConditions,loadMacroConditions};
