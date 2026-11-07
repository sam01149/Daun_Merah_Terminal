'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../../api/_fso_core');
// FSO LIK25B25 workbook, annual-change sheet, exact Core inflation 1 row.
// https://dam-api.bfs.admin.ch/hub/api/dam/assets/36970583/master
const rows=require('../fixtures/fso/annual-core-table.json');
const NOW=Date.parse('2026-11-07T03:00:00Z'),url='https://statistik.admin.ch/en/news/2026-0059';
const meta={period:'2026-10',url,released_at:'2026-11-03T07:30:00.000Z',workbook_url:'https://dam-api.bfs.admin.ch/hub/api/dam/assets/36970583/master'};
const snap=()=>m.parseWorkbookRows(structuredClone(rows),meta,NOW);
const release=`<h1>Swiss Consumer Price Index in October 2026</h1><time datetime="${meta.released_at}"></time><li class="bfs-dam-package-view__asset">[LIK25B25]<a href="${meta.workbook_url}">xlsx</a></li>`;
test('FSO discovery excludes future calendar and picks the newest published release',()=>{
  const link=(id,date)=>`<a href="/fr/news/${id}"><time datetime="${date}"></time>IPC</a>`;
  const h='<div id="tab-news">'+link('2026-0058','2026-10-01')+link('2026-0059',meta.released_at)+link('2026-0060','2026-12-02')+'</div><div id="tab-agenda">'+link('2027-0001','2026-11-06')+'</div>';
  assert.equal(m.discoverRelease(h,NOW),url);assert.throws(()=>m.discoverRelease('maintenance',NOW));
});
test('FSO release metadata requires CPI identity, a past post-period date and one official history workbook',()=>{
  assert.deepEqual(m.releaseMetadata(release,url,NOW),meta);
  for(const h of [release.replace('October','December'),release.replace('[LIK25B25]','[HICP]'),release+release,
    release.replace('dam-api.bfs.admin.ch','evil.test'),release.replace(meta.released_at,'2026-10-01')])assert.throws(()=>m.releaseMetadata(h,url,NOW));
  assert.throws(()=>m.releaseMetadata(release,'https://evil.test/en/news/2026-0059',NOW));
});
test('FSO selects published annual Core inflation 1, not the index, MoM or Core inflation 2',()=>{
  const s=snap();assert.equal(s.actual,0.5);assert.equal(s.previous,0.5);assert.equal(s.previous_period,'2026-09');
  assert.equal(m.observation(s,NOW).source,'fso');
  for(const change of [r=>r[0][5]='Veränderungsrate gegenüber Vormonat in %',r=>r[2][11]='Core inflation 2',
    r=>r[2][0]='1170_302',r=>r[2][16]=null,r=>r.push(r[2]),r=>r[1][15]='2025-09-01T00:00:00.000Z']){
    const r=structuredClone(rows);change(r);assert.throws(()=>m.parseWorkbookRows(r,meta,NOW));
  }
  assert.throws(()=>m.parseWorkbookRows(rows,{...meta,period:'2026-09'},NOW));
});
test('FSO rejects corrupted, future, stale and wrong-definition snapshots',()=>{
  const s=snap();for(const bad of [{...s,actual:7},{...s,observed_at:'2027-01-01'},{...s,source:'headline'},
    {...s,previous_period:'2026-08'},{...s,url:'https://evil.test'},{...s,period:'2026-13'},{...s,workbook_url:'https://evil.test/file'}])assert.equal(m.observation(bad,NOW),null);
  assert.equal(m.observation(s,Date.parse('2027-03-01')),null);
});
test('CHF inflation becomes complete from matching monthly headline/core; mismatched periods stay insufficient',()=>{
  const {buildMacroConditions}=require('../../api/_macro_candidate');const core=m.observation(snap(),NOW);
  const headline={...core,id:'CHF|consumer_prices:yoy:monthly|2026-10',series:'consumer_prices:yoy:monthly',source:'tradingview',actual:1.5,previous:1};
  const i=buildMacroConditions([headline,core],{asOfMs:NOW}).currencies.CHF.inflation;
  assert.equal(i.coverage,'complete');assert.equal(i.components[1].direction,0);assert.notEqual(i.state,'insufficient');
  assert.equal(buildMacroConditions([{...headline,period:'2026-09'},core],{asOfMs:NOW}).currencies.CHF.inflation.state,'insufficient');
});
test('FSO sync stores cache and Fundamental atomically, retains data on failure and uses an owner-checked lock',async()=>{
  const db=new Map(),commands=[];const redis=async(...a)=>{commands.push(a);
    if(a[0]==='SET'){db.set(a[1],a[2]);return 'OK';}if(a[0]==='GET')return db.get(a[1])||null;
    if(a[0]==='EVAL'&&a[2]===3){db.set(a[3],a[6]);return 1;}
    if(a[0]==='EVAL'&&a[2]===1){assert.match(a[1],/ARGV\[1\]/);return 1;}};
  const out=await m.sync(redis,{nowMs:NOW,fetchSnapshotImpl:async()=>snap()});assert.equal(out.actual,0.5);
  const write=commands.find(a=>a[0]==='EVAL'&&a[2]===3);assert.equal(write[4],'fundamental:CHF');
  assert.equal(JSON.parse(write[7]).source,'fso');assert.equal(JSON.parse(write[7]).period,'2026-10');
  const old=db.get(m.CACHE_KEY);await assert.rejects(()=>m.sync(redis,{fetchSnapshotImpl:async()=>{throw Error('down');}}));assert.equal(db.get(m.CACHE_KEY),old);
});
