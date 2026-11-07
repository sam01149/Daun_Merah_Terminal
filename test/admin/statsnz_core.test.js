'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../../api/_statsnz_core');
// Stats NZ, CPI September 2026, sheet 3.03, rows 1-30, CC BY 4.0.
// https://www.stats.govt.nz/information-releases/consumers-price-index-september-2026-quarter/
const rows=require('../fixtures/statsnz/annual-core-table.json');
const NOW=Date.parse('2026-11-07T03:00:00Z');
const URL='https://www.stats.govt.nz/information-releases/consumers-price-index-september-2026-quarter/';
const workbook='/assets/Uploads/Consumers-price-index/Consumers-price-index-September-2026-quarter/Download-data/consumers-price-index-september-2026-quarter.xlsx';
const meta={period:'2026-Q3',released_at:'2026-10-21T21:45:00.000Z',url:URL,workbook_url:'https://www.stats.govt.nz'+workbook};
const fixture=()=>structuredClone(rows);
const html=data=>'<div id="pageViewData" data-value="'+JSON.stringify(data).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'"></div>';
const page=()=>({Title:'Consumers price index: September 2026 quarter',PageLink:new globalThis.URL(URL).pathname,
  DateTaxonomyTerm:{PublicationDate:'2026-10-22 10:45:00'},PageBlocks:[{BlockDocuments:[{Name:workbook.split('/').pop(),DocumentLink:workbook}]}]});
const snapshot=()=>m.parseWorkbookRows(fixture(),meta,NOW);

test('Stats NZ discovers latest completed quarter from the official indicator, excluding future releases',()=>{
  const link=month=>`/information-releases/consumers-price-index-${month}-2026-quarter/`;
  assert.equal(m.discoverRelease(html({links:[link('march'),link('september'),link('december')]}),NOW),URL);
  assert.throws(()=>m.discoverRelease('<html>maintenance</html>',NOW));
  assert.throws(()=>m.discoverRelease(html({links:[]}),NOW));
});
test('Stats NZ dates use Auckland DST, not server timezone or a fixed offset',()=>{
  assert.equal(new Date(m.newZealandTime('2026-10-22 10:45:00')).toISOString(),'2026-10-21T21:45:00.000Z');
  assert.equal(new Date(m.newZealandTime('2026-07-21 10:45:00')).toISOString(),'2026-07-20T22:45:00.000Z');
  assert.throws(()=>m.newZealandTime('2026-02-31 10:45:00'));
});
test('Stats NZ release rejects future, wrong-identity, ambiguous workbook and foreign host',()=>{
  assert.deepEqual(m.releaseMetadata(html(page()),URL,NOW),meta);
  const future=page();future.DateTaxonomyTerm.PublicationDate='2026-12-01 10:45:00';
  const foreign=page();foreign.PageBlocks[0].BlockDocuments[0].DocumentLink='https://evil.test/'+workbook.split('/').pop();
  const duplicate=page();duplicate.PageBlocks[0].BlockDocuments.push(duplicate.PageBlocks[0].BlockDocuments[0]);
  for(const p of [future,foreign,duplicate,{...page(),Title:'Consumers price index: June 2026 quarter'}])assert.throws(()=>m.releaseMetadata(html(p),URL,NOW));
});
test('Stats NZ selects exact exclusion series and annual current/previous from one release',()=>{
  const s=snapshot();assert.equal(s.actual,2.9);assert.equal(s.previous,2.5);assert.equal(s.previous_period,'2026-Q2');
  assert.equal(s.source_series,'SE9NS1450');assert.deepEqual(s.source_cells,{actual:'K30',previous:'I30'});
  assert.equal(m.observation(s,NOW).source,'statsnz');assert.equal(m.observation(s,NOW).series,m.SERIES);
});
test('Stats NZ columns are found by quarter labels, not by fixed column positions',()=>{
  const moved=fixture().map(r=>[null,...r]);
  // Preserve the grouping/ref fields; move the time-series columns only.
  for(let i=0;i<moved.length;i++)moved[i]=[rows[i][0],rows[i][1],null,...rows[i].slice(2)];
  const s=m.parseWorkbookRows(moved,meta,NOW);assert.equal(s.actual,2.9);assert.equal(s.previous,2.5);
});
test('Stats NZ rejects renamed definitions, QoQ sheet, missing prior quarter, nulls and duplicate rows',()=>{
  const altered=[];
  let r=fixture();r[29][0]='All groups less vehicle fuels';altered.push(r);
  r=fixture();r[3][0]='Percentage change from previous quarter';altered.push(r);
  r=fixture();r[6][8]='Jun-24';altered.push(r);
  r=fixture();r[29][8]=null;altered.push(r);
  r=fixture();r.push(r[29]);altered.push(r);
  r=fixture();r[29][10]=1343;altered.push(r);
  for(const input of altered)assert.throws(()=>m.parseWorkbookRows(input,meta,NOW));
});
test('Stats NZ cached observation fails closed on tampering, wrong period, stale and future data',()=>{
  const s=snapshot();
  for(const bad of [{...s,actual:3.7},{...s,source:'tradingview'},{...s,url:null},{...s,period:'2026-Q2'},
    {...s,previous_period:'2026-Q1'},{...s,observed_at:'2027-01-01T00:00:00Z'},{...s,workbook_url:'https://evil.test/a.xlsx'}])assert.equal(m.observation(bad,NOW),null);
  assert.equal(m.observation(s,Date.parse('2027-06-01')),null);
});
test('Stats NZ completes the NZD inflation pillar without duplicating or replacing headline CPI',()=>{
  const {buildMacroConditions}=require('../../api/_macro_candidate');
  const core=m.observation(snapshot(),NOW);
  const headline={...core,id:'NZD|consumer_prices:yoy:quarterly|2026-Q3',series:'consumer_prices:yoy:quarterly',family:'headline_consumer_prices',source:'tradingview',actual:3.7,previous:4.1};
  const input=[headline,core];const before=JSON.stringify(input);
  const inf=buildMacroConditions(input,{asOfMs:NOW}).currencies.NZD.inflation;
  assert.equal(inf.coverage,'complete');assert.equal(inf.state,'mixed');
  assert.equal(inf.components[0].actual,3.7);assert.equal(inf.components[1].actual,2.9);
  assert.equal(JSON.stringify(input),before);
  const mismatch={...headline,period:'2026-Q2'};
  assert.equal(buildMacroConditions([mismatch,core],{asOfMs:NOW}).currencies.NZD.inflation.state,'insufficient');
});
test('Stats NZ sync stores matching cache/Fundamental atomically and preserves data when source fails',async()=>{
  const commands=[],db=new Map();let reject=false;
  const redis=async(...a)=>{commands.push(a);
    if(a[0]==='SET'){db.set(a[1],a[2]);return 'OK';}
    if(a[0]==='GET')return db.get(a[1])||null;
    if(a[0]==='DEL'){db.delete(a[1]);return 1;}
    if(a[0]==='EVAL'){if(reject)return 0;db.set(a[3],a[6]);return 1;}
  };
  await m.sync(redis,{nowMs:NOW,fetchSnapshotImpl:async()=>snapshot()});
  const write=commands.find(a=>a[0]==='EVAL');
  assert.equal(write[4],'fundamental:NZD');assert.equal(write[10],m.FIELD);
  assert.equal(JSON.parse(write[7]).actual,'2.9%');assert.equal(JSON.parse(write[7]).previous,'2.5%');
  const stored=db.get(m.CACHE_KEY);const count=commands.filter(a=>a[0]==='EVAL').length;
  await assert.rejects(()=>m.sync(redis,{nowMs:NOW,fetchSnapshotImpl:async()=>{throw Error('source down');}}));
  assert.equal(db.get(m.CACHE_KEY),stored);assert.equal(commands.filter(a=>a[0]==='EVAL').length,count);
  reject=true;await assert.rejects(()=>m.sync(redis,{nowMs:NOW,fetchSnapshotImpl:async()=>snapshot()}),/older_snapshot/);
});
