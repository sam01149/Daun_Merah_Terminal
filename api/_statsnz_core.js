'use strict';

const crypto=require('node:crypto');
const BASE='https://www.stats.govt.nz';
const INDEX_URL=BASE+'/indicators/consumers-price-index-cpi/';
const CACHE_KEY='statsnz_core_nzd:v1';
const VINTAGES_KEY='statsnz_core_nzd:vintages:v1';
const FIELD='Core CPI YoY';
const SERIES='cpi_ex_food_household_energy_vehicle_fuels:yoy:quarterly';
const DEFINITION='CPI excluding food group, household energy subgroup, and vehicle fuels';
const SOURCE_ROW='SE9NS1450';
const SHEET='3.03';
const DAY=86400000;
const MONTHS={march:3,june:6,september:9,december:12};
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
function decode(s){return s.replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
function pageData(html) {
  const raw=String(html).match(/\bid="pageViewData"\s+data-value="([^"]+)"/)?.[1];
  if(!raw)throw Error('statsnz_page_structure_changed');
  return JSON.parse(decode(raw));
}
function releasePeriod(value) {
  const m=String(value).toLowerCase().match(/consumers[- ]price[- ]index[: -]+(march|june|september|december)[- ](20\d{2})[- ]quarter/);
  return m?`${m[2]}-Q${MONTHS[m[1]]/3}`:null;
}
function periodEnd(period){const m=String(period).match(/^(20\d{2})-Q([1-4])$/);return m?Date.UTC(+m[1],+m[2]*3,1)-1:NaN;}
function previousPeriod(period){const [year,q]=period.split('-Q').map(Number);return q===1?`${year-1}-Q4`:`${year}-Q${q-1}`;}
function sourceUrl(path) {
  if(typeof path!=='string'||!path.trim())throw Error('statsnz_source_url_missing');
  const u=new URL(path,BASE);
  if(u.origin!==BASE || u.username || u.password)throw Error('statsnz_external_url_rejected');
  return u.href;
}
function discoverRelease(html,nowMs=Date.now()) {
  const data=pageData(html),links=[];
  function visit(value){
    if(typeof value==='string')for(const m of value.matchAll(/\/information-releases\/consumers-price-index-(?:march|june|september|december)-20\d{2}-quarter\//g))links.push(m[0]);
    else if(value&&typeof value==='object')Object.values(value).forEach(visit);
  }
  visit(data);
  const valid=[...new Set(links)].filter(link=>periodEnd(releasePeriod(link))<nowMs).sort((a,b)=>periodEnd(releasePeriod(b))-periodEnd(releasePeriod(a)));
  if(!valid.length)throw Error('statsnz_latest_release_not_found');
  return sourceUrl(valid[0]);
}
function newZealandTime(value) {
  const m=String(value).match(/^(20\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if(!m)throw Error('statsnz_release_date_invalid');
  const target=Date.UTC(...[+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]]);
  const d=new Date(target);
  if(d.getUTCFullYear()!==+m[1]||d.getUTCMonth()!==+m[2]-1||d.getUTCDate()!==+m[3]
    ||d.getUTCHours()!==+m[4]||d.getUTCMinutes()!==+m[5]||d.getUTCSeconds()!==+m[6])throw Error('statsnz_release_date_invalid');
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let utc=target;
  for(let i=0;i<3;i++){
    const p=Object.fromEntries(format.formatToParts(utc).map(p=>[p.type,p.value]));
    const wall=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const delta=target-wall;if(!delta)return utc;utc+=delta;
  }
  throw Error('statsnz_release_timezone_invalid');
}
function releaseMetadata(html,url,nowMs=Date.now()) {
  const page=pageData(html),period=releasePeriod(page.Title);
  if(!period || releasePeriod(url)!==period || page.PageLink!==new URL(url).pathname)throw Error('statsnz_release_identity_mismatch');
  const releasedMs=newZealandTime(page.DateTaxonomyTerm?.PublicationDate);
  if(releasedMs>nowMs || releasedMs<=periodEnd(period))throw Error('statsnz_release_not_published');
  const expected=`consumers-price-index-${Object.keys(MONTHS).find(k=>MONTHS[k]===Number(period.slice(-1))*3)}-${period.slice(0,4)}-quarter.xlsx`;
  const files=(page.PageBlocks||[]).flatMap(b=>b.BlockDocuments||[]).filter(d=>d.Name===expected && d.DocumentLink?.endsWith('/'+expected));
  if(files.length!==1)throw Error('statsnz_workbook_not_unique');
  return {period,released_at:new Date(releasedMs).toISOString(),url:sourceUrl(url),workbook_url:sourceUrl(files[0].DocumentLink)};
}
function parseWorkbookRows(rows,meta,observedMs=Date.now()) {
  if(!Array.isArray(rows) || !rows.some(r=>r?.some(c=>clean(c)==='Table '+SHEET))
    || !rows.some(r=>r?.some(c=>clean(c)==='Percentage change from same quarter of previous year')))throw Error('statsnz_annual_table_changed');
  const matches=rows.map((r,i)=>({r,i})).filter(({r})=>r?.[1]===SOURCE_ROW);
  if(matches.length!==1 || clean(matches[0].r[0]).replace(/\(2\)$/,'')!=='All groups less food group, household energy subgroup, and vehicle fuels')throw Error('statsnz_core_definition_changed');
  const headers=rows.filter(r=>r?.filter(c=>/^(Mar|Jun|Sep|Dec)-\d{2}$/.test(clean(c))).length>=2);
  if(headers.length!==1)throw Error('statsnz_quarter_headers_changed');
  const periods=headers[0].map(c=>{const m=clean(c).match(/^(Mar|Jun|Sep|Dec)-(\d{2})$/);return m?`20${m[2]}-Q${['Mar','Jun','Sep','Dec'].indexOf(m[1])+1}`:null;});
  const current=periods.indexOf(meta.period),previous=periods.indexOf(previousPeriod(meta.period));
  if(current<0 || previous<0 || periods.lastIndexOf(meta.period)!==current || periods.lastIndexOf(previousPeriod(meta.period))!==previous)throw Error('statsnz_comparable_period_missing');
  const actual=matches[0].r[current],prior=matches[0].r[previous];
  if(!Number.isFinite(actual)||!Number.isFinite(prior)||actual<=-100||prior<=-100||actual>=100||prior>=100)throw Error('statsnz_core_values_invalid');
  if(Date.parse(meta.released_at)>observedMs)throw Error('statsnz_observed_before_release');
  const content_hash=crypto.createHash('sha256').update(JSON.stringify([SERIES,meta.period,actual,prior,meta.released_at])).digest('hex');
  return {schema_version:1,source:'statsnz',series:SERIES,definition:DEFINITION,...meta,actual,previous:prior,previous_period:previousPeriod(meta.period),
    cadence:'quarterly',unit:'percent',measure:'yoy',source_series:SOURCE_ROW,source_sheet:SHEET,
    source_cells:{actual:`${String.fromCharCode(65+current)}${matches[0].i+1}`,previous:`${String.fromCharCode(65+previous)}${matches[0].i+1}`},
    observed_at:new Date(observedMs).toISOString(),content_hash};
}
function observation(snapshot,nowMs=Date.now()) {
  if(snapshot?.schema_version!==1 || snapshot.source!=='statsnz' || snapshot.series!==SERIES || snapshot.definition!==DEFINITION
    || snapshot.unit!=='percent' || snapshot.measure!=='yoy' || snapshot.cadence!=='quarterly' || snapshot.source_series!==SOURCE_ROW || snapshot.source_sheet!==SHEET
    || !Number.isFinite(snapshot.actual)||!Number.isFinite(snapshot.previous)||snapshot.previous_period!==previousPeriod(String(snapshot.period))
    || !Number.isFinite(periodEnd(snapshot.period)) || !/^[a-f0-9]{64}$/.test(snapshot.content_hash||''))return null;
  const released=Date.parse(snapshot.released_at),seen=Date.parse(snapshot.observed_at);
  if(!Number.isFinite(released)||!Number.isFinite(seen)||released>seen||seen>nowMs||released<=periodEnd(snapshot.period)||nowMs-released>150*DAY)return null;
  try{sourceUrl(snapshot.url);sourceUrl(snapshot.workbook_url);}catch(_){return null;}
  if(releasePeriod(snapshot.url)!==snapshot.period || !snapshot.workbook_url.endsWith('.xlsx'))return null;
  const expectedHash=crypto.createHash('sha256').update(JSON.stringify([SERIES,snapshot.period,snapshot.actual,snapshot.previous,snapshot.released_at])).digest('hex');
  if(expectedHash!==snapshot.content_hash)return null;
  return {schema_version:2,id:`NZD|${SERIES}|${snapshot.period}`,currency:'NZD',title:DEFINITION+' YoY',
    date:snapshot.released_at.slice(0,10),time_ms:released,period:snapshot.period,actual:snapshot.actual,previous:snapshot.previous,forecast:null,
    pillar:'inflation',family:'core_consumer_prices',series:SERIES,cadence:'quarterly',unit:'percent',inverse:false,source:'statsnz',
    source_event_id:`${SOURCE_ROW}|${snapshot.period}`,source_country:'NZ',source_unit:'%',source_url:snapshot.url,workbook_url:snapshot.workbook_url,
    source_sheet:SHEET,source_cells:snapshot.source_cells,observed_at:snapshot.observed_at,vintage_kind:'historical_snapshot',content_hash:snapshot.content_hash};
}
async function getSnapshot(redis) {
  try{const raw=await redis('GET',CACHE_KEY);return typeof raw==='string'?JSON.parse(raw):raw;}catch(_){return null;}
}
async function fetchSnapshot({fetchImpl=fetch,nowMs=Date.now()}={}) {
  async function get(url,binary=false){
    const r=await fetchImpl(url,{headers:{'User-Agent':'DaunMerah/1.0 (public economic statistics)',Accept:binary?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/html'},redirect:'error',signal:AbortSignal.timeout(binary?18000:8000)});
    if(!r.ok)throw Error('statsnz_http_'+r.status);
    if(Number(r.headers?.get('content-length'))>3000000)throw Error('statsnz_response_too_large');
    const body=Buffer.from(await r.arrayBuffer());if(body.length>3000000)throw Error('statsnz_response_too_large');
    return binary?body:body.toString('utf8');
  }
  const url=discoverRelease(await get(INDEX_URL),nowMs);
  const meta=releaseMetadata(await get(url),url,nowMs);
  const bytes=await get(meta.workbook_url,true);
  const {readSheet}=require('read-excel-file/node');
  const rows=await readSheet(bytes,SHEET);
  return parseWorkbookRows(rows,meta,Math.max(nowMs,Date.now()));
}
const WRITE_SCRIPT=`
for i=1,3 do
  local kind=redis.call('TYPE',KEYS[i]).ok
  local expected=i==1 and 'string' or 'hash'
  if kind~='none' and kind~=expected then return -2 end
end
local prior=redis.call('GET',KEYS[1])
if prior then
  local ok,old=pcall(cjson.decode,prior)
  if ok and type(old.period)=='string' and (old.period>ARGV[3] or (old.period==ARGV[3] and type(old.observed_at)=='string' and old.observed_at>ARGV[4])) then return 0 end
end
local fund=redis.call('HGET',KEYS[2],ARGV[5])
if fund then
  local ok,old=pcall(cjson.decode,fund)
  if ok and type(old.date)=='string' and string.match(old.date,'^%d%d%d%d%-%d%d%-%d%d$') and old.date>ARGV[6] then return -1 end
end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('HSET',KEYS[2],ARGV[5],ARGV[2])
redis.call('HSETNX',KEYS[3],ARGV[7],ARGV[1])
return 1
`;
async function sync(redis,{fetchImpl=fetch,nowMs=Date.now(),fetchSnapshotImpl=fetchSnapshot}={}) {
  if(await redis('SET','lock:statsnz_core',String(nowMs),'NX','EX',50)!=='OK')return {skipped:'sync_locked'};
  try{
    const snapshot=await fetchSnapshotImpl({fetchImpl,nowMs});
    const row=observation(snapshot,Math.max(nowMs,Date.now()));if(!row)throw Error('statsnz_snapshot_invalid');
    const date=new Date(Date.parse(snapshot.released_at)+7*3600000).toISOString().slice(0,10);
    const fundamental={actual:snapshot.actual+'%',previous:snapshot.previous+'%',forecast:null,period:snapshot.period,date,
      source:'statsnz',source_url:snapshot.url,definition:DEFINITION,series:SERIES,cadence:'quarterly',previous_period:snapshot.previous_period,
      released_at:snapshot.released_at,observed_at:snapshot.observed_at,workbook_url:snapshot.workbook_url,source_sheet:SHEET,source_cells:snapshot.source_cells};
    const updated=await redis('EVAL',WRITE_SCRIPT,3,CACHE_KEY,'fundamental:NZD',VINTAGES_KEY,JSON.stringify(snapshot),JSON.stringify(fundamental),snapshot.period,snapshot.observed_at,FIELD,date,snapshot.content_hash);
    if(Number(updated)!==1)throw Error(Number(updated)===-1?'statsnz_newer_fundamental_exists':'statsnz_older_snapshot_rejected');
    const saved=await getSnapshot(redis);if(saved?.content_hash!==snapshot.content_hash)throw Error('statsnz_write_verification_failed');
    return {updated:true,period:snapshot.period,actual:snapshot.actual,previous:snapshot.previous};
  }finally{await redis('DEL','lock:statsnz_core').catch(()=>null);}
}
module.exports={CACHE_KEY,VINTAGES_KEY,FIELD,SERIES,DEFINITION,SOURCE_ROW,SHEET,INDEX_URL,pageData,discoverRelease,newZealandTime,releaseMetadata,parseWorkbookRows,observation,getSnapshot,fetchSnapshot,sync};
