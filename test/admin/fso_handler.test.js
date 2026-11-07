'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.UPSTASH_REDIS_REST_URL='https://fso-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='fake';
process.env.APP_KEY='app';process.env.CRON_SECRET='secret';
const handler=require('../../api/admin');
function res(){return {code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;},end(){return this;}};}
test('FSO endpoint reads cache without network to source; sync requires secret and respects lock',async()=>{
  const original=global.fetch,calls=[];
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://fso-redis.test','reads and unauthorized/locked sync must not fetch source');
    const a=JSON.parse(options.body);calls.push(a);
    return {ok:true,json:async()=>({result:a[0]==='GET'?JSON.stringify({source:'fso'}):null})};
  };
  try{
    let out=res();await handler({method:'GET',query:{action:'fso_core'},headers:{'x-app-key':'app'}},out);
    assert.equal(out.code,200);assert.equal(out.body.snapshot.source,'fso');
    out=res();await handler({method:'GET',query:{action:'fso_core',mode:'sync'},headers:{'x-app-key':'app'}},out);
    assert.equal(out.code,401);
    out=res();await handler({method:'GET',query:{action:'fso_core',mode:'sync'},headers:{'x-cron-secret':'secret'}},out);
    assert.equal(out.body.skipped,'sync_locked');
    assert.equal(calls.filter(a=>a[0]==='DEL'||a[0]==='EVAL').length,0,'cannot release another sync owner lock');
  }finally{global.fetch=original;}
});
