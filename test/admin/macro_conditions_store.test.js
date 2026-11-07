'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../../api/_macro_conditions_store');
const {seed}=require('../../scripts/seed_macro_conditions');
const {buildMacroConditions}=require('../../api/_macro_candidate');
const NOW=Date.parse('2026-11-07T00:00:00Z');
const OBS='2026-11-06T16:00:00Z';
const raw=(extra={})=>({id:'gdp',currency:'USD',country:'US',title:'GDP Growth Rate QoQ Final',unit:'%',actualRaw:2,previousRaw:1,
  date:'2026-11-04T13:30:00Z',referenceDate:'2026-09-30T00:00:00Z',source_fetched_at:OBS,...extra});

function memoryRedis() {
  const hashes=new Map(),index=new Map(),strings=new Map();
  const redis=async(command,...args)=>{
    if(command==='EVAL') {
      assert.match(args[0],/row\.time_ms>old\.time_ms/);
      const data=hashes.get(args[3])||new Map(),versions=hashes.get(args[4])||new Map();let updated=0;
      for(let i=5;i<args.length;i+=3) {
        const row=JSON.parse(args[i+1]),old=data.has(args[i])?JSON.parse(data.get(args[i])):null;
        if(!versions.has(args[i+2]))versions.set(args[i+2],args[i+1]);
        if(!old||row.time_ms>old.time_ms||(row.time_ms===old.time_ms&&row.observed_at>old.observed_at)) {
          data.set(args[i],args[i+1]);index.set(args[i],row.time_ms);updated++;
        }
      }
      hashes.set(args[3],data);hashes.set(args[4],versions);return updated;
    }
    if(command==='GET')return strings.get(args[0])||null;
    if(command==='SET'){strings.set(args[0],args[1]);return 'OK';}
    if(command==='ZRANGEBYSCORE')return [...index].filter(([,time])=>time>=Number(args[1])&&time<=Number(args[2])).map(([id])=>id);
    if(command==='HMGET')return args.slice(1).map(id=>hashes.get(args[0])?.get(id)||null);
    if(command==='HLEN')return hashes.get(args[0])?.size||0;
    if(command==='ZCARD')return index.size;
    throw Error('Unexpected command '+command);
  };
  return {redis,hashes,index,strings};
}

test('conditions store accepts later estimates without consensus and rejects legacy/expired/future inputs',()=>{
  assert.equal(store.conditionRows([raw()],{asOfMs:NOW})[0].forecast,null);
  assert.equal(store.conditionRows([raw({id:null})],{asOfMs:NOW}).length,0);
  assert.equal(store.conditionRows([raw({date:'2025-01-01'})],{asOfMs:NOW}).length,0);
  assert.equal(store.conditionRows([raw({source_fetched_at:'2026-12-01'})],{asOfMs:NOW}).length,0);
});

test('revision wins only if available later; replaying an older calendar cache cannot undo it',async()=>{
  const {redis,hashes}=memoryRedis();
  await store.persistMacroConditions([raw()],redis,{asOfMs:NOW});
  const revised=raw({actualRaw:3,source_fetched_at:'2026-11-06T17:00:00Z'});
  await store.persistMacroConditions([revised],redis,{asOfMs:NOW});
  await store.persistMacroConditions([raw()],redis,{asOfMs:NOW,observedAt:'2026-11-06T18:00:00Z'});
  const [row]=await store.loadMacroConditions(redis,{asOfMs:NOW,requireManifest:false});
  assert.equal(row.actual,3);assert.equal(row.observed_at,revised.source_fetched_at.replace('Z','.000Z'));
  assert.equal(hashes.get(store.VINTAGES_KEY).size,2);
});

test('latest release stage wins regardless of ordering and simultaneous contradictions are quarantined',()=>{
  const adv=raw({title:'GDP Growth Rate QoQ Adv',date:'2026-11-03T13:30:00Z'});
  const final=raw({actualRaw:3});
  assert.deepEqual(store.conditionRows([adv,final],{asOfMs:NOW}),store.conditionRows([final,adv],{asOfMs:NOW}));
  assert.equal(store.conditionRows([adv,final],{asOfMs:NOW})[0].actual,3);
  assert.deepEqual(store.conditionRows([raw(),raw({actualRaw:9})],{asOfMs:NOW}),[]);
});

test('unverified or malformed stored history never becomes conditions',async()=>{
  const {redis,hashes,index,strings}=memoryRedis();
  await store.persistMacroConditions([raw()],redis,{asOfMs:NOW});
  assert.deepEqual(await store.loadMacroConditions(redis,{asOfMs:NOW}),[]);
  strings.set(store.MANIFEST_KEY,'not JSON');assert.deepEqual(await store.loadMacroConditions(redis,{asOfMs:NOW}),[]);
  strings.set(store.MANIFEST_KEY,JSON.stringify({schema_version:1,status:'ready',source:'tradingview',content_digest:'verified'}));
  assert.equal((await store.loadMacroConditions(redis,{asOfMs:NOW})).length,1);
  const id=[...index.keys()][0];hashes.get(store.DATA_KEY).set(id,JSON.stringify({...store.conditionRows([raw()],{asOfMs:NOW})[0],id:'wrong-id'}));
  assert.deepEqual(await store.loadMacroConditions(redis,{asOfMs:NOW}),[]);
});

test('seeding verifies roundtrip before publishing ready and leaves surprise keys untouched',async()=>{
  const {redis,strings}=memoryRedis();
  const currencies={USD:'US',EUR:'EU',GBP:'GB',JPY:'JP',CHF:'CH',CAD:'CA',AUD:'AU',NZD:'NZ'};
  const events=Object.entries(currencies).flatMap(([currency,country])=>[
    raw({id:currency+'-gdp',currency,country}),
    raw({id:currency+'-jobs',currency,country,title:'Unemployment Rate',actualRaw:4,previousRaw:5}),
  ]);
  const manifest=await seed(events,redis,{asOfMs:NOW});
  assert.equal(manifest.status,'ready');assert.equal(manifest.seed_observations,16);
  assert.equal(strings.size,1);assert.ok(strings.has(store.MANIFEST_KEY));
  const conditions=buildMacroConditions(await store.loadMacroConditions(redis,{asOfMs:NOW}),{asOfMs:NOW,integrated:true});
  assert.equal(conditions.integration.enabled,true);
  for(const row of Object.values(conditions.currencies))assert.equal(row.growth.state,'up');
});

test('seed with missing core coverage cannot publish a ready manifest',async()=>{
  const {redis,strings}=memoryRedis();
  await assert.rejects(()=>seed([raw()],redis,{asOfMs:NOW}),/Missing GDP\/labour/);
  assert.equal(strings.has(store.MANIFEST_KEY),false);
});

test('unchanged polling skips data writes; a new actual invalidates the fingerprint',async()=>{
  const {redis}=memoryRedis();let evals=0;
  const counted=async(command,...args)=>{if(command==='EVAL')evals++;return redis(command,...args);};
  await store.persistMacroConditions([raw()],counted,{asOfMs:NOW,batchKey:'calendar'});
  const unchanged=await store.persistMacroConditions([raw({source_fetched_at:'2026-11-06T17:00:00Z'})],counted,{asOfMs:NOW,batchKey:'calendar'});
  assert.equal(unchanged.unchanged,true);assert.equal(evals,1);
  await store.persistMacroConditions([raw({actualRaw:3,source_fetched_at:'2026-11-06T18:00:00Z'})],counted,{asOfMs:NOW,batchKey:'calendar'});
  assert.equal(evals,2);
  assert.equal((await store.loadMacroConditions(redis,{asOfMs:NOW,requireManifest:false}))[0].actual,3);
});
