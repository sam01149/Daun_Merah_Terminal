const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.UPSTASH_REDIS_REST_URL = 'https://primary.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'primary';
process.env.UPSTASH2_REDIS_REST_URL = 'https://secondary.invalid';
process.env.UPSTASH2_REDIS_REST_TOKEN = 'secondary';
const handler = require('../../api/feeds');
function response() {return {headers:{}, setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},send(x){this.body=x;return this;},json(x){this.body=x;return this;}};}
const req = {query:{type:'rss'}, headers:{}, socket:{remoteAddress:'127.0.0.1'}};
const json = (result, ok=true) => ({ok, json:async()=>({result})});
test('NEWS memakai cache kedua, menghormati 429, dan tidak membanjiri sumber', async () => {
 const original=global.fetch, db=new Map(); let upstream=0;
 global.fetch=async (url,opts={})=>{
  if(url==='https://secondary.invalid') {const [cmd,key,value,...rest]=JSON.parse(opts.body); if(cmd==='GET') return json(db.get(key)??null); if(cmd==='DEL'){db.delete(key);return json(1);} if(cmd==='SET'){if(rest.includes('NX') && db.has(key))return json(null);db.set(key,value);return json('OK');} throw Error(cmd);}
  if(url==='https://primary.invalid') return {ok:false,json:async()=>({error:'blocked'})};
  if(String(url).includes('financialjuice.com/feed.ashx')){upstream++;return {ok:false,status:429};}
  throw Error('unexpected '+url);
 };
 try {let a=response();await handler(req,a);assert.equal(a.code,502);assert.equal(a.body.detail,'HTTP_429');assert.equal(db.get('rss_fetch_cooldown_v1'),'1');let b=response();await handler(req,b);assert.equal(b.code,503);assert.equal(upstream,1);}
 finally {global.fetch=original;}
});
test('NEWS cache tidak tersedia: tidak memanggil sumber tanpa lock', async () => {
 const original=global.fetch;let upstream=0;
 global.fetch=async url=>{if(String(url).includes('financialjuice.com'))upstream++;throw Error('offline');};
 try{const a=response();await handler(req,a);assert.equal(a.code,503);assert.equal(upstream,0);}finally{global.fetch=original;}
});
test('cache NEWS segar melayani ulang tanpa sumber atau Redis utama', async () => {
 const original=global.fetch;let calls=[];
 global.fetch=async (url,opts={})=>{calls.push(url);if(url==='https://secondary.invalid')return json(JSON.stringify({xml:'<rss>fresh</rss>',fetchedAt:Date.now(),source:'financialjuice'}));throw Error('unexpected');};
 try{const a=response();await handler(req,a);assert.equal(a.code,200);assert.equal(a.body,'<rss>fresh</rss>');assert.deepEqual(calls,['https://secondary.invalid']);}finally{global.fetch=original;}
});
test('NEWS menyimpan RSS baru di akun kedua saat utama disuspend', async () => {
 const original=global.fetch, db=new Map();let upstream=0;
 global.fetch=async (url,opts={})=>{
  if(url==='https://secondary.invalid'){const [cmd,key,value,...rest]=JSON.parse(opts.body);if(cmd==='GET')return json(db.get(key)??null);if(cmd==='DEL'){db.delete(key);return json(1);}if(cmd==='SET'){if(rest.includes('NX')&&db.has(key))return json(null);db.set(key,value);return json('OK');}}
  if(url==='https://primary.invalid')return {ok:false,json:async()=>({error:'blocked'})};
  if(String(url).includes('financialjuice.com/feed.ashx')){upstream++;return {ok:true,text:async()=>'<rss><channel><item><title>Test headline</title></item></channel></rss>'};}
  throw Error('unexpected '+url);
 };
 try{let a=response();await handler(req,a);assert.equal(a.code,200);assert.equal(upstream,1);assert.match(a.body,/Test headline/);const stored=JSON.parse(db.get('rss_cache'));assert.equal(stored.source,'financialjuice');assert.equal(stored.xml,undefined);assert.equal(typeof stored.br,'string');let b=response();await handler(req,b);assert.equal(b.code,200);assert.equal(upstream,1);}finally{global.fetch=original;}
});
test('cache NEWS terkompresi dibaca identik dan karakter Unicode tidak berubah', async () => {
 const zlib=require('zlib'),original=global.fetch;
 const xml='<rss><channel><item><title>Solomon: Think \'very highly\u2019 of CEO $GS \u00e9\u00fc \u4e2d\u6587</title></item></channel></rss>';
 const stored=JSON.stringify({v:2,br:zlib.brotliCompressSync(Buffer.from(xml,'utf8')).toString('base64'),fetchedAt:Date.now(),source:'financialjuice'});
 global.fetch=async (url)=>{if(url==='https://secondary.invalid')return json(stored);throw Error('unexpected');};
 try{const a=response();await handler(req,a);assert.equal(a.code,200);assert.equal(a.body,xml);}finally{global.fetch=original;}
});
test('cache NEWS rusak diisi ulang dari sumber, bukan menahan NEWS', async () => {
 const original=global.fetch,db=new Map([['rss_cache',JSON.stringify({v:2,br:'bukan-brotli',fetchedAt:Date.now(),source:'financialjuice'})]]);let upstream=0;
 global.fetch=async (url,opts={})=>{
  if(url==='https://secondary.invalid'){const [cmd,key,value,...rest]=JSON.parse(opts.body);if(cmd==='GET')return json(db.get(key)??null);if(cmd==='DEL'){db.delete(key);return json(1);}if(cmd==='SET'){if(rest.includes('NX')&&db.has(key))return json(null);db.set(key,value);return json('OK');}}
  if(url==='https://primary.invalid')return {ok:false,json:async()=>({error:'blocked'})};
  if(String(url).includes('financialjuice.com/feed.ashx')){upstream++;return {ok:true,text:async()=>'<rss><channel><item><title>Pulih</title></item></channel></rss>'};}
  throw Error('unexpected '+url);
 };
 try{const a=response();await handler(req,a);assert.equal(a.code,200);assert.equal(upstream,1);assert.match(a.body,/Pulih/);}finally{global.fetch=original;}
});
