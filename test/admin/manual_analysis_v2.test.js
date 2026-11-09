'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const manual=require('../../api/_manual_analysis');
const NOW=Date.parse('2026-11-06T17:00:00Z');
function rows(n,seconds,fn) {
  const end=Math.floor(NOW/1000/seconds)*seconds;
  return Array.from({length:n},(_,i)=>{const c=fn(i);return {t:end-(n-i)*seconds,o:c,h:c+.0001,l:c-.0001,c};});
}
function trendInput() {return {
  candles1h:rows(420,3600,i=>1.322-i*.0001),
  candles4h:rows(110,14400,i=>1.346-i*.0006),
  candles1d:rows(220,86400,i=>1.8-i*.002),
};}
const base={strategy_id:'momentum',macro_direction:'bearish',macro_reason:'ECB dovish vs Fed hawkish',bias:'bearish',entry_zone:'1.285',entry_basis:'resistance 1.285',sl:'1.290',tp:'1.270'};

test('manual prices reject text, nonfinite, scientific notation, units, negative and malformed ranges',()=>{
  for(const v of ['abc','1.2abc','Infinity',Infinity,NaN,'1e309','-1','0','1,234','1..2','1-2-3',{},true]) assert.equal(manual.prices(v),null,String(v));
  assert.deepEqual(manual.prices('1.20–1.21'),[1.2,1.21]);
  assert.equal(manual.prices('1-2',1),null);
});
test('manual evidence computes EMA and complete H6 from closed server candles',()=>{
  const e=manual.technicalEvidence(trendInput(),NOW,true);
  assert.equal(e.stale,false);assert.equal(e.momentum.direction,'bearish');
  assert(e.atr14_h6>0);assert.equal(e.coverage.d1,220);
  assert(e.momentum.ema21_h4<e.momentum.ema100_h4);
});
test('current candle and incomplete H6 never count as evidence',()=>{
  const input=trendInput();
  input.candles1h.push({t:NOW/1000,o:1,h:999,l:1,c:999});
  const e=manual.technicalEvidence(input,NOW,true);
  assert.equal(e.last_closed_h1_t,NOW/1000-3600);
  const partial=manual.completeBuckets(input.candles1h.slice(-3),6,NOW);
  assert.equal(partial.length,0);
});
test('duplicate conflicts and stale H1 fail closed',()=>{
  const input=trendInput();input.candles1h.push({...input.candles1h[0],c:1.5,h:1.6});
  assert.equal(manual.technicalEvidence(input,NOW,true).coverage.h1,0);
  const old=trendInput();old.candles1h=old.candles1h.slice(0,-4);
  assert.equal(manual.technicalEvidence(old,NOW,true).stale,true);
});
test('manual warm-up uses independent cache and calendar-sized Deriv history',async()=>{
  const writes=[],requests=[];
  const input=await manual.loadInputs({}, {symbol:'NZDUSD=X',now:NOW,read:async()=>null,
    write:async(...a)=>writes.push(a),fetchCandles:async(s,tf,n)=>{requests.push([s,tf,n]);return trendInput()[tf==='1d'?'candles1d':tf==='4h'?'candles4h':'candles1h'];}});
  assert.equal(input.candles1d.length,220);
  assert.deepEqual(requests.map(a=>a.slice(1)),[['1h',600],['4h',160],['1d',380]]);
  assert.equal(writes[0][0],'manual_prime_inputs:v2:NZDUSD=X');
  assert(!writes.some(([k])=>k.startsWith('ohlcv:')));
  const cached=await manual.loadInputs({}, {symbol:'NZDUSD=X',now:NOW,read:async()=>writes[0][1],write:async()=>{throw Error('unexpected write')},fetchCandles:async()=>{throw Error('unexpected fetch')}});
  assert.equal(cached.candles1d.length,220);
});
test('full market proof passes while missing macro or opposing EMA fails',()=>{
  const input=trendInput(),evidence=manual.technicalEvidence(input,NOW,true);
  assert(manual.assess(base,{input,evidence,macroAvailable:true}).rr>=2);
  assert.match(manual.assess(base,{input,evidence,macroAvailable:false}).reason,/makro/);
  assert.match(manual.assess({...base,bias:'bullish',sl:'1.280',tp:'1.300'},{input,evidence}).reason,/momentum searah/);
});
test('conservative RR reports the edge even when the midpoint is above two',()=>{
  const { rr } = manual.assess({...base,entry_zone:'1.2795-1.2805',sl:'1.285',tp:'1.270'});
  assert(Math.abs(rr - 0.0095 / 0.0055) < 1e-9);
});
test('macro reason cannot launder COT or chart evidence into direction',()=>{
  assert.match(manual.assess({...base,macro_reason:'COT USD long mendukung bearish EURUSD'}).reason,/positioning/);
  assert.match(manual.PROMPT_RULES,/Tidak ada batas maksimum gap EMA/);
  assert.match(manual.PROMPT_RULES,/conflict:waktu HANYA bila ada event kalender/);
});
test('range inside a directional macro uses proved crosses and exact H6 risk',()=>{
  const input={candles1h:rows(420,3600,i=>100+2*Math.sin(i*Math.PI/30)),candles4h:[],candles1d:[]};
  const evidence=manual.technicalEvidence(input,NOW,true),range=evidence.range;
  assert(range.sustained_crosses.length>=2);
  const entry=range.low,a=evidence.atr14_h6;
  const setup={...base,strategy_id:'range',macro_direction:'bullish',bias:'bullish',range_start_t:range.window_start_t,entry_zone:String(entry),sl:String(entry-a),tp:String(entry+2*a)};
  assert.equal(manual.assess(setup,{input,evidence}).reason,undefined);
  assert.match(manual.assess({...setup,range_start_t:range.window_end_t},{input,evidence}).reason,/dua cross/);
  assert.match(manual.assess({...setup,entry_zone:'100',sl:String(100-a),tp:String(100+2*a)},{input,evidence}).reason,/tepi/);
  assert.match(manual.assess({...setup,sl:String(entry-a*.9)},{input,evidence}).reason,/ATR14 H6/);
});
test('fade requires a real quote and movement timestamps; horizon is qualitative',()=>{
  const input=trendInput();input.candles1h=rows(420,3600,i=>100+i*.01);
  const evidence=manual.technicalEvidence(input,NOW,true),story='Unconfirmed trade deal reports drove the recent rally, but negotiations remain stalled.';
  const setup={...base,strategy_id:'tactical_fade',entry_zone:'104',sl:'105',tp:'102',trade_horizon:'short_term_correction',fade_evidence:{source_quote:story,fragility_reason:'Rumor belum terkonfirmasi',move_start_t:input.candles1h[350].t,move_end_t:input.candles1h[419].t,macro_view_unchanged:true}};
  assert.equal(manual.assess(setup,{input,evidence,story}).reason,undefined);
  assert.match(manual.assess(setup,{input,evidence,story:''}).reason,/kutipan/);
  assert.match(manual.assess({...setup,trade_horizon:'30_days'},{input,evidence,story}).reason,/horizon/);
});

// Handler integration: no market-proof stub. Synthetic Redis/model only, all
// unrecognized network is rejected. These tests exercise production assembly.
test('manual v2 handler: valid plan, invalid prices, unavailable proof, and read-only context',async()=>{
  process.env.UPSTASH_REDIS_REST_URL='https://manual-fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN='fake';process.env.DEEPSEEK_API_KEY='fake';
  delete process.env.APP_KEY;delete process.env.CRON_SECRET;
  const market=require('../../api/_market_hours'),open=market.isFxMarketOpen,fetch=global.fetch;
  market.isFxMarketOpen=()=>true;
  const input=trendInput(),keys={
    'ohlcv_fresh:EURUSD=X':'1','ohlcv:EURUSD=X:1h':JSON.stringify(input.candles1h),'ohlcv:EURUSD=X:4h':JSON.stringify(input.candles4h),'ohlcv:EURUSD=X:1d':JSON.stringify(input.candles1d),
    cb_bias:JSON.stringify({EUR:{bias:'Dovish',confidence:'High'},USD:{bias:'Hawkish',confidence:'High'}}),
  };
  // Fixtures use present timestamps so runtime freshness is checked, not bypassed.
  for(const key of Object.keys(keys).filter(k=>k.startsWith('ohlcv:'))) {
    const seconds=key.endsWith(':1d')?86400:key.endsWith(':4h')?14400:3600;
    const shift=Math.floor(Date.now()/1000/seconds)*seconds-Math.floor(NOW/1000/seconds)*seconds;
    keys[key]=JSON.stringify(JSON.parse(keys[key]).map(c=>({...c,t:c.t+shift})));
  }
  let answer={...base,trigger:'buy breakout Asia',confidence:'tinggi'},calls=0,captured;
  const reads=[];
  global.fetch=async(url,opts)=>{
    if(String(url).includes('manual-fixture.test')) {
      const args=JSON.parse(opts.body);
      if(Array.isArray(args[0])) return {ok:true,json:async()=>args.map(()=>({result:'OK'}))};
      const [cmd,key]=args;reads.push([cmd,key]);
      let result=cmd==='GET'?keys[key]??null:cmd==='INCR'?1:'OK';
      if(cmd==='HGETALL') result=['CPI YoY',JSON.stringify({actual:'2.5%',forecast:'2.4%',previous:'2.3%',date:'2026-11-01',source:'calendar'})];
      if(cmd==='SET') keys[key]=args[2];
      return {ok:true,json:async()=>({result})};
    }
    if(String(url).includes('api.deepseek.com')) {calls++;captured=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(answer)+'\n===COMMENTARY===\nAnalisis model.\nKESIMPULAN: BUY breakout sekarang.'}}]})};}
    throw Error('Unexpected network '+url);
  };
  try {
    delete require.cache[require.resolve('../../api/admin')];const handler=require('../../api/admin');
    const run=async(mode)=>{const res={setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return this},end(){return this}};await handler({method:'GET',headers:{},query:{action:'ohlcv_analyze',symbol:'EURUSD=X',label:'EUR/USD',...(mode?{mode}:{})}},res);assert.equal(res.code,200);return res.body;};
    const good=await run();assert.equal(good.structured.academy_contract_status,'conditional',JSON.stringify(good.structured));
    assert.equal(good.structured.trigger_state,'awaiting_closed_h1_rejection');
    assert.match(good.structured.trigger,/Rejection|menolak/);assert.doesNotMatch(good.commentary,/BUY breakout sekarang/);
    assert.match(good.commentary,/^RINGKASAN SKENARIO: Skenario bearish/);
    assert(reads.some(([cmd,k])=>cmd==='HGETALL'&&k==='fundamental:EUR'));assert(reads.some(([cmd,k])=>cmd==='HGETALL'&&k==='fundamental:USD'));
    const prompt=captured.messages[1].content;assert.match(prompt,/DATA RILIS EKONOMI/);assert.match(prompt,/ema200_d1/);assert.doesNotMatch(prompt,/4 paragraf pertama wajib|pengecualian hanya breakout/);
    answer = {...base, entry_zone:'1.2000-1.2020', sl:'1.2050', tp:'1.1930'};
    const lowRr = await run();
    assert.equal(lowRr.structured.risk_reward, 1.4);
    assert.equal(lowRr.structured.entry_zone, '1.2000-1.2020');
    assert.equal(lowRr.structured.sl, '1.2050');
    assert.equal(lowRr.structured.tp, '1.1930');
    assert.match(lowRr.commentary, /RR 1:1\.4/);
    assert.match(lowRr.commentary, /Analisis model/);
    assert.doesNotMatch(lowRr.commentary, /NO TRADE/);
    const followUp = require('../../api/_analysis_follow_up');
    const originalStore = followUp.createStore;
    process.env.APP_KEY = 'follow-up-fixture';
    followUp.createStore = () => {
      let activeRun;
      return {
        claim: async (_, run) => { activeRun = run; return true; },
        read: async () => ({ run: activeRun }),
        finish: async (_, run, outcome) => {
          assert.equal(run, activeRun);
          return { activation:'fixture', ...outcome };
        },
      };
    };
    try {
      reads.length = 0;
      const response = { setHeader(){}, status(n){this.code=n;return this}, json(body){this.body=body} };
      await handler({
        method:'POST', headers:{'x-app-key':'follow-up-fixture'}, body:{activation:'fixture'},
        query:{action:'analysis_follow_up',mode:'initial',symbol:'EURUSD=X'},
      }, response);
      assert.equal(response.code, 200);
      assert.equal(response.body.status, 'done');
      assert.equal(response.body.result.structured.academy_contract_status, 'conditional');
      assert.equal(response.body.result.structured.risk_reward, 1.4);
      assert(reads.some(([cmd, key]) => cmd === 'INCR' && key.startsWith('ai_budget:deepseek_follow_up:')));
      assert(!reads.some(([cmd, key]) => cmd === 'SET' && (key.startsWith('ohlcv_analysis:') || key === 'setup_log:v1')));
    } finally {
      followUp.createStore = originalStore;
      delete process.env.APP_KEY;
    }
    answer={...base,bias:'short'};const alias=await run();assert.equal(alias.structured.bias,'bearish');assert.equal(alias.structured.bias_reported,'short');assert.equal(alias.structured.academy_contract_status,'conditional');
    answer={...base,entry_zone:'abc',sl:'def',tp:'ghi'};const bad=await run();assert.equal(bad.structured.academy_contract_status,'informational');assert.equal(bad.structured.entry_zone,null);assert.match(bad.commentary,/Analisis model/);
    keys['ohlcv:EURUSD=X:1d']=JSON.stringify(input.candles1d.slice(-10));
    keys['manual_prime_inputs:v2:EURUSD=X']=JSON.stringify({captured_at:Date.now(),input:{candles1h:JSON.parse(keys['ohlcv:EURUSD=X:1h']),candles4h:JSON.parse(keys['ohlcv:EURUSD=X:4h']),candles1d:JSON.parse(keys['ohlcv:EURUSD=X:1d'])}});
    answer={...base};const missing=await run();assert.equal(missing.structured.strategy_id,'momentum');assert.match(missing.structured.analysis_observations.join(' '),/EMA200/);assert.equal(missing.structured.entry_zone,base.entry_zone);
    const previous=calls;market.isFxMarketOpen=()=>false;const context=await run('context');assert.equal(calls,previous);assert.equal(context.analysis_policy_v,'prime-v3');assert.equal(context.market_closed,true);
  } finally {global.fetch=fetch;market.isFxMarketOpen=open;}
});
