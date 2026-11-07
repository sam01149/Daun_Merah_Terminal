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
  const original=global.fetch,db=new Map(),calls=[],expires=new Map();let failAI=false;
  const published=new Date(Math.floor((Date.now()-3600000)/1000)*1000).toISOString();
  const text='We expect sterling to strengthen next week on resilient monetary policy expectations. ';
  let source=`<meta content="ING Bank N.V."><h1 data-date-raw="${Date.parse(published)/1000}"></h1><div class="content_builder">${text.repeat(8)}</div>Content Disclaimer`;
  global.fetch=async(url,opts={})=>{
    calls.push(String(url));
    if(String(url)==='https://institution-redis.test'){
      const [cmd,key,value,...rest]=JSON.parse(opts.body);let result=null;
      if(cmd==='GET')result=db.get(key)||null;
      else if(cmd==='SET') {if(rest.includes('NX')&&db.has(key))result=null;else{db.set(key,value);result='OK';}}
      else if(cmd==='DEL'){db.delete(key);result=1;}
      else if(cmd==='INCR'){result=Number(db.get(key)||0)+1;db.set(key,result);}
      else if(cmd==='EXPIRE'){expires.set(key,value);result=1;}
      else if(cmd==='EVAL'){const lockKey=rest[0],token=rest[1];if(db.get(lockKey)===token){db.delete(lockKey);result=1;}else result=0;}
      return {ok:true,json:async()=>({result})};
    }
    if(String(url)==='https://think.ing.com/rss/')return {ok:true,text:async()=>`<item><title>FX Daily: Outlook</title><link>https://think.ing.com/articles/outlook/</link><dc:date>${published}</dc:date></item>`};
    if(String(url)==='https://think.ing.com/articles/outlook/')return {ok:true,text:async()=>source};
    if(String(url)==='https://api.deepseek.com/chat/completions')return failAI?{ok:false,status:500,json:async()=>({error:{message:'Internal Server Error'}})}:
      {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({claims:[]})}}]})};
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
    const previous=db.get(KEY);source=source.replaceAll('policy expectations','growth expectations');failAI=true;
    res=response();await handler(req('sync',true),res);assert.equal(res.code,502);
    assert.equal(db.get(KEY),previous,'provider failure must preserve all stored reports');
    assert.ok([...expires].some(([key,seconds])=>key.startsWith('institution_views:attempt:')&&seconds===60));
    assert.equal(db.has('lock:institution_views'),false);
  } finally {global.fetch=original;}
});

test('Weekly sync collects multiple articles in one AI call and preserves each article identity',async()=>{
  const original=global.fetch,db=new Map();let aiCalls=0;
  const entries=['older','newer'].map((name,i)=>({url:'https://think.ing.com/articles/fx-daily-'+name+'/',
    published_at:new Date(Math.floor((Date.now()-(2-i)*3600000)/1000)*1000).toISOString(),title:'FX Daily: '+name}));
  const quote='We expect the dollar to strengthen this week on resilient growth.';
  global.fetch=async(url,opts={})=>{
    if(String(url)==='https://institution-redis.test'){
      const [cmd,key,value,...rest]=JSON.parse(opts.body);let result=null;
      if(cmd==='GET')result=db.get(key)||null;
      else if(cmd==='SET'){if(rest.includes('NX')&&db.has(key))result=null;else{db.set(key,value);result='OK';}}
      else if(cmd==='DEL'){db.delete(key);result=1;}
      else if(cmd==='INCR'){result=Number(db.get(key)||0)+1;db.set(key,result);}
      else if(cmd==='EXPIRE')result=1;
      else if(cmd==='EVAL'){if(db.get(rest[0])===rest[1]){db.delete(rest[0]);result=1;}else result=0;}
      return {ok:true,json:async()=>({result})};
    }
    if(String(url)==='https://think.ing.com/rss/')return {ok:true,text:async()=>entries.map(e=>`<item><title>${e.title}</title><link>${e.url}</link><dc:date>${e.published_at}</dc:date></item>`).join('')};
    if(String(url)==='https://think.ing.com/market/fx/')return {ok:true,text:async()=>entries.map(e=>`<a href="${e.url}">${e.title}</a>`).join('')};
    const entry=entries.find(e=>e.url===String(url));
    if(entry)return {ok:true,text:async()=>`ING Bank N.V.<h1 data-date-raw="${Date.parse(entry.published_at)/1000}">${entry.title}</h1><div class="content_builder"><h2>USD: Outlook</h2><p>${quote.repeat(10)}</p></div>Content Disclaimer`};
    if(String(url)==='https://api.deepseek.com/chat/completions'){
      aiCalls++;const input=JSON.parse(JSON.parse(opts.body).messages.at(-1).content);
      return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reports:input.articles.map(a=>({article_id:a.article_id,claims:[{
        currency:'USD',pair:null,direction:'bullish',layer:'fundamental',conditional:false,horizon:'this_week',section_id:'s0',horizon_quote:'this week',quote,reason:'Dukungan pertumbuhan.'}]}))})}}]})};
    }
    throw Error('Unexpected URL '+url);
  };
  try{
    const res=response();await handler(req('sync',true),res);assert.equal(res.code,200);assert.equal(res.body.updated_reports,2);assert.equal(res.body.accepted_claims,2);assert.equal(aiCalls,1);
    const saved=JSON.parse(db.get(KEY));assert.equal(saved.length,2);
    assert.ok(saved.every(s=>s.claims.every(c=>c.url===s.url&&c.published_at===s.published_at)));
    const again=response();await handler(req('sync',true),again);assert.equal(again.body.skipped,'unchanged');assert.equal(aiCalls,1);
  }finally{global.fetch=original;}
});
