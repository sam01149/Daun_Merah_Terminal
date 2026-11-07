'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const op=require('../../api/_aatas_operational_entry');
const { _evaluateSetups }=require('../../api/admin');
const {isManagedResolved}=require('../../api/_auto_entry_guard');
const H=3600000,T=Date.parse('2026-11-05T10:00:00Z');
const cal=[{date:'2026-11-09',time_wib:'22:00 WIB',impact:'High',currency:'USD',event:'GDP'}];
const bar=(t,o,h,l,c)=>({t:t/1000,o,h,l,c});
function fixture(strategy='momentum',bias='bullish') {
  const sign=bias==='bullish'?1:-1;
  const history=Array.from({length:120},(_,i)=>bar(T-(120-i)*H,102,103,99,102));
  const trigger=bar(T,102,105,100.75,104.5),next=bar(T+H,104.5,105,103,104);
  const st={id:'new',symbol:'EURUSD=X',label:'EUR/USD',bias,status:'pending',ts:T,level_set_at:T,
    entry_execution:op.CONTRACT,entry_zone:'100-101',sl:'98',tp:'120',horizon_days:3,
    operational_contract:{kind:op.CONTRACT,eligible:true,decided_at:T,zone:{low:100,high:101},planned_sl:98,planned_tp:120,strategy,environment:{low:80,high:130}}};
  if(sign<0) {
    for(const c of [...history,trigger,next]) {const [o,h,l,close]=[c.o,c.h,c.l,c.c];Object.assign(c,{o:200-o,h:200-l,l:200-h,c:200-close});}
    Object.assign(st,{entry_zone:'99-100',sl:'102',tp:'80'});
    Object.assign(st.operational_contract,{zone:{low:99,high:100},planned_sl:102,planned_tp:80});
  }
  return {st,candles:[...history,trigger,next]};
}
test('rejection H1 produksi bullish/bearish memakai open berikutnya dan RR efektif',()=>{
  for(const bias of ['bullish','bearish']) {
    const {st,candles}=fixture('momentum',bias);
    _evaluateSetups([st],{[st.symbol]:candles},T+2*H,cal,[]);
    assert.equal(st.status,'open');assert.equal(st.filled_t,(T+H)/1000);
    assert.equal(st.filled_price,bias==='bullish'?104.5:95.5);assert.ok(st.rr>=2);
    assert.equal(st.entry_zone,String(st.filled_price));
  }
});
test('candle belum close dan sentuhan tanpa rejection tidak menjadi fill',()=>{
  let {st,candles}=fixture();op.evaluate(st,candles,T+H-1,cal);assert.equal(st.status,'pending');
  ({st,candles}=fixture());candles.at(-2).c=101;op.evaluate(st,candles,T+2*H,cal);assert.equal(st.status,'pending');
});
test('berita setelah keputusan membatalkan pending untuk analisa baru; kalender kosong unknown',()=>{
  let {st,candles}=fixture();op.evaluate(st,candles,T+2*H,[]);assert.equal(st.status,'pending');assert.equal(st.operation_wait_reason,'calendar_unavailable');
  ({st,candles}=fixture());op.evaluate(st,candles,T+2*H,[{date:'2026-11-05',time_wib:'17:30 WIB',impact:'High',currency:'USD',event:'CPI',actual:'4%'}]);
  assert.equal(st.status,'canceled');assert.equal(st.canceled_reason,'event_requires_new_analysis');
});
test('gap, duplicate dan SL invalid sebelum fill tidak membuat phantom fill',()=>{
  let {st,candles}=fixture();candles.push({...candles.at(-1),c:104.2});op.evaluate(st,candles,T+2*H,cal);assert.equal(st.status,'pending');
  ({st,candles}=fixture());candles.at(-2).o=97;candles.at(-2).l=96;op.evaluate(st,candles,T+2*H,cal);assert.equal(st.canceled_reason,'entry_invalidated_before_fill');
});
test('outcome raw dan net estimasi, terminal immutable dan idempotent',()=>{
  const {st,candles}=fixture();candles.push(bar(T+2*H,104,121,103,120));
  op.evaluate(st,candles,T+3*H,cal);assert.equal(st.status,'tp');assert.ok(st.net_r_estimate<st.rr);
  const saved=JSON.stringify(st);op.evaluate(st,[],T+8*H,cal);assert.equal(JSON.stringify(st),saved);
});
test('choppy memilih exit ATR dan milestone yang berlaku mulai candle selanjutnya',()=>{
  const {st,candles}=fixture('choppy');op.evaluate(st,candles,T+2*H,cal);assert.equal(st.status,'open');
  const r=st.initial_risk,f=st.filled_price;
  candles.push(bar(T+2*H,f,f+1.1*r,f-.1*r,f+r));
  candles.push(bar(T+3*H,f+r,f+1.2*r,f-.1*r,f));
  op.evaluate(st,candles,T+4*H,cal);
  assert.equal(st.choppy_management.exit_price,f);assert.equal(st.choppy_management.gross_r,0);
  assert.equal(st.status,'open');assert.equal(isManagedResolved(st),true);
});
test('validator fakta mendeteksi angka naik disebut turun dan menolak source stale',()=>{
  assert.ok(op.factualCheck({reasoning_note:'Inflasi dari 3,4% ke 3,7% melandai.'}).issues.length);
  assert.equal(op.factualCheck({reasoning_note:'Inflasi dari 3.7% ke 3.4% melandai.'}).issues.length,0);
  const f=op.sourceFacts(['EUR'],[{'CPI YoY':{actual:'3.7%',date:'2026-11-01',source:'calendar'},'GDP QoQ':{actual:'0.5%',date:'2026-08-01',source:'calendar'},seed:{actual:1,source:'seed'}}],T);
  assert.equal(f[0].usable,true);assert.equal(f[1].usable,true);assert.equal(f[2].usable,false);
  assert.ok(op.factualCheck({evidence_claims:[{source_id:'missing',actual:'3%'}]},f).issues.length);
});
test('sesi menggunakan DST London/NY dan tidak mengizinkan Asia atau weekend',()=>{
  assert.equal(op.sessionAllowed(Date.parse('2026-07-06T07:00:00Z')/1000),true);
  assert.equal(op.sessionAllowed(Date.parse('2026-11-05T07:00:00Z')/1000),false);
  assert.equal(op.sessionAllowed(Date.parse('2026-11-07T10:00:00Z')/1000),false);
});
test('data minim unknown dan legacy tetap diproses evaluator lama',()=>{
  assert.equal(op.classify({},'bullish',T).environment,'unknown');
  const legacy={status:'pending',bias:'bullish',entry_zone:'100',sl:'95',tp:'110',ts:T-2*H,symbol:'EURUSD=X'};
  const copy=structuredClone(legacy);assert.equal(op.evaluate(legacy,[],T,cal),false);assert.deepEqual(legacy,copy);
});

test('classifier produksi membedakan trend kuat, range lebar dan transisi tanpa mengikuti label AI',()=>{
 const h1=Array.from({length:300},(_,i)=>bar(T-(300-i)*H,100,101,99,100));
 const h4=Array.from({length:110},(_,i)=>bar(T-(110-i)*4*H,90+i*.3,91+i*.3,89+i*.3,90+i*.3));
 const d1=Array.from({length:210},(_,i)=>bar(T-(210-i)*24*H,80+i*.2,81+i*.2,79+i*.2,80+i*.2));
 const inputs={candles1h:h1,candles4h:h4,candles1d:d1};
 assert.equal(op.classify(inputs,'bullish',T).environment,'trend');
 assert.equal(op.classify(inputs,'bearish',T).environment,'opposing');
 const range=Array.from({length:300},(_,i)=>{const c=100+10*Math.sin(i*2*Math.PI/50);return bar(T-(300-i)*H,c,c+.2,c-.2,c);});
 const env=op.classify({candles1h:range},'bullish',T);
 assert.equal(env.environment,'range');assert.ok(env.crosses.length>=2);
 const small=range.map(c=>({...c,h:c.h+10,l:c.l-10}));
 assert.equal(op.classify({candles1h:small},'bullish',T).environment,'transition');
 const build=entry=>op.buildContract({bias:'bullish',label:'EUR/USD',entry_zone:entry,sl:80,tp:125},{candles1h:range},cal,T);
 assert.equal(build('90-91').strategy,'choppy');assert.equal(build('90-91').eligible,true);
 assert.equal(build('99-100').eligible,false);
});
test('kontrak tidak tersedia ditolak; candle parsial tidak mencemari ATR6H',()=>{
 const {st}=fixture();delete st.operational_contract;op.evaluate(st,[],T,cal);assert.equal(st.status,'invalid');
 const a=Array.from({length:5},(_,i)=>bar(T+i*H,100,102,99,101));assert.equal(op.sixHour(a,T+6*H).length,0);
});

test('replay memakai kontrak rejection produksi yang sama dan tidak memakai touch legacy',()=>{
 const {replayRecord}=require('../../scripts/aatas_replay.cjs');
 const {st,candles}=fixture();candles.push(bar(T+2*H,104,121,103,120));
 const replay=replayRecord(st,candles,{nowMs:T+3*H},cal);
 assert.equal(replay.status,'tp');assert.equal(replay.entry,104.5);
 assert.equal(replay.accounting,'operational_contract_replay');
 assert.equal(st.status,'pending');
});
test('range tetap tidak masuk ketika kalender tentative dan ketika zona diubah tanpa kontrak',()=>{
 let {st,candles}=fixture();op.evaluate(st,candles,T+2*H,[{date:'2026-11-05',time_wib:'Tentative',impact:'High',currency:'USD',event:'GDP'}]);
 assert.equal(st.status,'pending');assert.equal(st.operation_wait_reason,'relevant_event_time_unknown');
 ({st,candles}=fixture());st.entry_zone='90-91';op.evaluate(st,candles,T+2*H,cal);assert.equal(st.status,'invalid');
});

test('open H1 tersedia langsung setelah trigger close; high-low candle berjalan tidak menjadi outcome',()=>{
 const {st,candles}=fixture();candles.at(-1).h=125;
 op.evaluate(st,candles,T+H+5*60000,cal);
 assert.equal(st.status,'open');assert.equal(st.filled_t,(T+H)/1000);assert.equal(st.closed_t,undefined);
 op.evaluate(st,candles,T+2*H,cal);assert.equal(st.status,'tp');
});
