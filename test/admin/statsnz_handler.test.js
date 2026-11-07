'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.UPSTASH_REDIS_REST_URL='https://statsnz-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='fake';
process.env.APP_KEY='app';process.env.CRON_SECRET='secret';
const handler=require('../../api/admin');
function res(){return {code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;},end(){return this;}};}
test('Stats NZ endpoint reads cache without network to source; sync requires secret and respects lock',async()=>{
  const original=global.fetch,calls=[];
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://statsnz-redis.test','reads and unauthorized/locked sync must not fetch source');
    const a=JSON.parse(options.body);calls.push(a);
    return {ok:true,json:async()=>({result:a[0]==='GET'?JSON.stringify({source:'statsnz'}):null})};
  };
  try{
    let out=res();await handler({method:'GET',query:{action:'statsnz_core'},headers:{'x-app-key':'app'}},out);
    assert.equal(out.code,200);assert.equal(out.body.snapshot.source,'statsnz');
    out=res();await handler({method:'GET',query:{action:'statsnz_core',mode:'sync'},headers:{'x-app-key':'app'}},out);
    assert.equal(out.code,401);
    out=res();await handler({method:'GET',query:{action:'statsnz_core',mode:'sync'},headers:{'x-cron-secret':'secret'}},out);
    assert.equal(out.body.skipped,'sync_locked');
    assert.equal(calls.filter(a=>a[0]==='DEL').length,0,'cannot release another sync owner lock');
  }finally{global.fetch=original;}
});
