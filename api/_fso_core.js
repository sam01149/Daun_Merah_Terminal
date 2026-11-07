'use strict';
const crypto=require('node:crypto');
const {WRITE_SCRIPT}=require('./_statsnz_core');
const INDEX_URL='https://statistik.admin.ch/fr/prix-consommation';
const CACHE_KEY='fso_core_chf:v1',VINTAGES_KEY='fso_core_chf:vintages:v1';
const SERIES='cpi_ex_fresh_seasonal_energy_fuels:yoy:monthly';
const DEFINITION='Core inflation 1: CPI excluding fresh and seasonal products, energy and fuels';
const SOURCE_ROW='1170_103',SHEET=3,DAY=86400000;
const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
const digest=s=>crypto.createHash('sha256').update(JSON.stringify([SERIES,s.period,s.actual,s.previous,s.released_at])).digest('hex');
function safeUrl(value,asset=false){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash
    ||(asset?u.hostname!=='dam-api.bfs.admin.ch'||!/^\/hub\/api\/dam\/assets\/\d+\/master$/.test(u.pathname)
      :u.hostname!=='statistik.admin.ch'||!/^\/en\/news\/\d{4}-\d+$/.test(u.pathname)))throw Error('fso_source_url_invalid');
  return u.href;
}
function discoverRelease(html,nowMs=Date.now()){
  // Restrict to published news, not the forward release calendar.
  const news=String(html).match(/id="tab-news"[\s\S]*?(?=id="tab-agenda"|$)/)?.[0]||'';
  const entries=[...news.matchAll(/<a\b[^>]*href="\/fr\/news\/(\d{4}-\d+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m=>({url:`https://statistik.admin.ch/en/news/${m[1]}`,date:Date.parse(m[2].match(/datetime="([^"]+)"/)?.[1])}))
    .filter(e=>Number.isFinite(e.date)&&e.date<=nowMs).sort((a,b)=>b.date-a.date);
  if(!entries.length)throw Error('fso_latest_release_not_found');
  return safeUrl(entries[0].url);
}
function releaseMetadata(html,url,nowMs=Date.now()){
  safeUrl(url);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const title=clean(String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]);
  const m=title.match(/^Swiss Consumer Price Index in (\w+) (20\d{2})$/);
  if(!m||!months.includes(m[1]))throw Error('fso_release_identity_changed');
  const period=`${m[2]}-${String(months.indexOf(m[1])+1).padStart(2,'0')}`;
  const released=Date.parse(String(html).match(/<time\b[^>]*datetime="([^"]+)"/)?.[1]);
  const end=Date.UTC(+m[2],months.indexOf(m[1])+1,1);
  if(!Number.isFinite(released)||released<end||released>nowMs)throw Error('fso_release_date_invalid');
  const files=[...String(html).matchAll(/<li class="bfs-dam-package-view__asset">([\s\S]*?)<\/li>/g)]
    .filter(m=>m[1].includes('[LIK25B25]')).map(m=>m[1].match(/href="(https:\/\/dam-api\.bfs\.admin\.ch\/hub\/api\/dam\/assets\/\d+\/master)"/)?.[1]);
  if(files.length!==1||!files[0])throw Error('fso_history_workbook_not_unique');
  return {period,url,released_at:new Date(released).toISOString(),workbook_url:safeUrl(files[0],true)};
}
function previousPeriod(p){const [y,m]=p.split('-').map(Number);return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;}
function parseWorkbookRows(rows,meta,observedMs=Date.now()){
  if(!Array.isArray(rows)||!rows.some(r=>r.some(c=>clean(c)==='Veränderungsrate gegenüber Vorjahresmonat (%)')))throw Error('fso_annual_table_changed');
  const headers=rows.filter(r=>r[0]==='Code'&&r.includes('Item_E'));
  const cores=rows.map((r,i)=>({r,i})).filter(({r})=>r[0]===SOURCE_ROW);
  if(headers.length!==1||cores.length!==1||cores[0].r[11]!=='Core inflation 1'||cores[0].r[5]!=='Kerninflation 1')throw Error('fso_core_definition_changed');
  const periods=headers[0].map(c=>c instanceof Date?c.toISOString().slice(0,7):/^20\d{2}-\d{2}-01T00:00:00\.000Z$/.test(String(c))?c.slice(0,7):null);
  const last=periods.filter(Boolean).sort().at(-1);
  if(last!==meta.period)throw Error('fso_workbook_period_mismatch');
  const prev=previousPeriod(meta.period),a=periods.indexOf(meta.period),b=periods.indexOf(prev);
  if(a<0||b<0||periods.lastIndexOf(meta.period)!==a||periods.lastIndexOf(prev)!==b)throw Error('fso_comparable_period_missing');
  const actual=cores[0].r[a],previous=cores[0].r[b];
  if(!Number.isFinite(actual)||!Number.isFinite(previous)||Math.abs(actual)>=100||Math.abs(previous)>=100)throw Error('fso_core_values_invalid');
  if(Date.parse(meta.released_at)>observedMs)throw Error('fso_observed_before_release');
  const s={schema_version:1,source:'fso',series:SERIES,definition:DEFINITION,...meta,actual,previous,previous_period:prev,
    cadence:'monthly',unit:'percent',measure:'yoy',source_series:SOURCE_ROW,source_sheet:SHEET,
    source_columns:{actual:a+1,previous:b+1},source_row:cores[0].i+1,observed_at:new Date(observedMs).toISOString()};
  return {...s,content_hash:digest(s)};
}
function observation(s,nowMs=Date.now()){
  if(s?.schema_version!==1||s.source!=='fso'||s.series!==SERIES||s.definition!==DEFINITION||s.cadence!=='monthly'||s.measure!=='yoy'||s.unit!=='percent'
    ||s.source_series!==SOURCE_ROW||s.source_sheet!==SHEET||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(s.period||'')
    ||s.previous_period!==previousPeriod(s.period)||!Number.isFinite(s.actual)||!Number.isFinite(s.previous)||Math.abs(s.actual)>=100||Math.abs(s.previous)>=100)return null;
  const release=Date.parse(s.released_at),seen=Date.parse(s.observed_at),[y,m]=s.period.split('-').map(Number);
  if(!Number.isFinite(release)||!Number.isFinite(seen)||release<Date.UTC(y,m,1)||release>seen||seen>nowMs||nowMs-release>75*DAY||s.content_hash!==digest(s))return null;
  try{safeUrl(s.url);safeUrl(s.workbook_url,true);}catch(_){return null;}
  return {schema_version:2,id:`CHF|${SERIES}|${s.period}`,currency:'CHF',title:DEFINITION+' YoY',date:s.released_at.slice(0,10),time_ms:release,
    period:s.period,actual:s.actual,previous:s.previous,forecast:null,pillar:'inflation',family:'core_consumer_prices',series:SERIES,cadence:'monthly',unit:'percent',inverse:false,
    source:'fso',source_event_id:`${SOURCE_ROW}|${s.period}`,source_country:'CH',source_unit:'%',source_url:s.url,workbook_url:s.workbook_url,
    observed_at:s.observed_at,vintage_kind:'historical_snapshot',content_hash:s.content_hash};
}
async function getSnapshot(redis){try{const r=await redis('GET',CACHE_KEY);return typeof r==='string'?JSON.parse(r):r;}catch(_){return null;}}
async function fetchSnapshot({fetchImpl=fetch,nowMs=Date.now()}={}){
  async function get(url,binary=false){const r=await fetchImpl(url,{redirect:'error',headers:{'User-Agent':'DaunMerah/1.0 (public economic statistics)',Accept:binary?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/html'},signal:AbortSignal.timeout(binary?18000:8000)});
    if(!r.ok)throw Error('fso_http_'+r.status);if(Number(r.headers?.get('content-length'))>8000000)throw Error('fso_response_too_large');
    const b=Buffer.from(await r.arrayBuffer());if(b.length>8000000)throw Error('fso_response_too_large');return binary?b:b.toString('utf8');}
  const url=discoverRelease(await get(INDEX_URL),nowMs),meta=releaseMetadata(await get(url),url,nowMs);
  const rows=await require('read-excel-file/node').readSheet(await get(meta.workbook_url,true),SHEET);
  return parseWorkbookRows(rows,meta,Math.max(nowMs,Date.now()));
}
async function sync(redis,{fetchImpl=fetch,nowMs=Date.now(),fetchSnapshotImpl=fetchSnapshot}={}){
  const token=crypto.randomUUID(),lock='lock:fso_core';
  if(await redis('SET',lock,token,'NX','EX',55)!=='OK')return {skipped:'sync_locked'};
  try{
    const s=await fetchSnapshotImpl({fetchImpl,nowMs});if(!observation(s,Math.max(nowMs,Date.now())))throw Error('fso_snapshot_invalid');
    const date=new Date(Date.parse(s.released_at)+7*3600000).toISOString().slice(0,10);
    const fund={actual:s.actual+'%',previous:s.previous+'%',forecast:null,period:s.period,date,source:'fso',source_url:s.url,definition:DEFINITION,series:SERIES,
      cadence:'monthly',previous_period:s.previous_period,released_at:s.released_at,observed_at:s.observed_at,workbook_url:s.workbook_url,source_sheet:SHEET,source_row:s.source_row,source_columns:s.source_columns};
    const updated=await redis('EVAL',WRITE_SCRIPT,3,CACHE_KEY,'fundamental:CHF',VINTAGES_KEY,JSON.stringify(s),JSON.stringify(fund),s.period,s.observed_at,'Core CPI YoY',date,s.content_hash);
    if(Number(updated)!==1)throw Error(Number(updated)===-1?'fso_newer_fundamental_exists':'fso_older_snapshot_rejected');
    if((await getSnapshot(redis))?.content_hash!==s.content_hash)throw Error('fso_write_verification_failed');
    return {updated:true,period:s.period,actual:s.actual,previous:s.previous};
  }finally{await redis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lock,token).catch(()=>null);}
}
module.exports={INDEX_URL,CACHE_KEY,VINTAGES_KEY,SERIES,DEFINITION,SOURCE_ROW,SHEET,discoverRelease,releaseMetadata,parseWorkbookRows,observation,getSnapshot,fetchSnapshot,sync};
