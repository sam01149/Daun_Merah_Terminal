'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.UPSTASH_REDIS_REST_URL='https://institution-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='fake';
process.env.CRON_SECRET='secret';
process.env.APP_KEY='app';
process.env.DEEPSEEK_API_KEY='fake';
delete process.env.RELINK_AI;
const handler=require('../../api/admin');
const {KEY}=require('../../api/_institution_views');
function response(){return {code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;},end(){return this;}};}
function req(mode,admin=false){return {method:'GET',query:{action:'institution_views',mode},headers:admin?{'x-cron-secret':'secret'}:{'x-app-key':'app'}};}

test('Institution handler: cache-only reads and authenticated idempotent synchronization',async()=>{
  const original=global.fetch,db=new Map(),calls=[];
  const published=new Date(Math.floor((Date.now()-3600000)/1000)*1000).toISOString();
  const text='We expect sterling to strengthen next week on resilient monetary policy expectations. ';
  const source=`<meta content="ING Bank N.V."><h1 data-date-raw="${Date.parse(published)/1000}"></h1><div class="content_builder">${text.repeat(8)}</div>Content Disclaimer`;
  global.fetch=async(url,opts={})=>{
    calls.push(String(url));
    if(String(url)==='https://institution-redis.test'){
      const [cmd,key,value,...rest]=JSON.parse(opts.body);let result=null;
      if(cmd==='GET')result=db.get(key)||null;
      else if(cmd==='SET') {if(rest.includes('NX')&&db.has(key))result=null;else{db.set(key,value);result='OK';}}
      else if(cmd==='DEL'){db.delete(key);result=1;}
      else if(cmd==='INCR'){result=Number(db.get(key)||0)+1;db.set(key,result);}
      else if(cmd==='EXPIRE')result=1;
      return {ok:true,json:async()=>({result})};
    }
    if(String(url)==='https://think.ing.com/rss/')return {ok:true,text:async()=>`<item><title>FX Daily: Outlook</title><link>https://think.ing.com/articles/outlook/</link><dc:date>${published}</dc:date></item>`};
    if(String(url)==='https://think.ing.com/articles/outlook/')return {ok:true,text:async()=>source};
    if(String(url)==='https://api.deepseek.com/chat/completions')return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({claims:[]})}}]})};
    throw Error('Unexpected network '+url);
  };
  try {
    let res=response();await handler(req('read'),res);assert.equal(res.code,200);assert.equal(res.body.processed_reports,0);
    assert.ok(calls.every(url=>url==='https://institution-redis.test'));
    res=response();await handler(req('sync'),res);assert.equal(res.code,401);
    assert.equal(calls.filter(url=>url.includes('think.ing.com')).length,0);
    res=response();await handler(req('sync',true),res);assert.equal(res.code,200);assert.equal(res.body.synced,true);
    assert.equal(JSON.parse(db.get(KEY))[0].claims.length,0,'empty extraction is stored, not retried on every read');
    res=response();await handler(req('sync',true),res);assert.equal(res.body.skipped,'unchanged');
    assert.equal(calls.filter(url=>url.includes('chat/completions')).length,1);
  } finally {global.fetch=original;}
});
