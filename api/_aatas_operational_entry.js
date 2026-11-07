'use strict';
// Kontrak produksi virtual PLAN AI. Tidak ada evaluator atau writer shadow.
const { ema, atr, resampleCandles } = require('./_prime_execution');
const { normalizeCandles, hasConflictingDuplicates } = require('./_aatas_entry_optimization');
const { buildEventScenarios } = require('./_aatas_academy');
const { stableHash } = require('./_aatas_evidence');
const SPREAD = { 'EUR/USD': .00012, 'GBP/USD': .00016, 'EUR/GBP': .00020, 'AUD/NZD': .00030, 'CHF/JPY': .030, 'XAU/USD': .30 };
const CONTRACT = 'aatas_rejection_h1_v1';
const number = v => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const zone = v => { const a = (String(v ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number); return a.length ? { low: Math.min(...a), high: Math.max(...a) } : null; };
function rows(input, seconds, now) {
  return normalizeCandles((input || []).filter(c => c && ['t','o','h','l','c'].every(k => number(c[k]) != null)))
    .filter(c => (c.t + seconds) * 1000 <= now);
}
function sixHour(h1, now) {
  const full = new Map();
  for (const c of h1) { const t = Math.floor(c.t / 21600) * 21600; (full.get(t) || (full.set(t, []), full.get(t))).push(c); }
  return resampleCandles(h1, 6).filter(c => {
    const a = full.get(c.t) || [];
    return a.length === 6 && a.every((r,i) => r.t === c.t + i*3600) && (c.t+21600)*1000 <= now;
  });
}
function structure(rows,bias) {
  const highs=[],lows=[];
  for(let i=2;i<rows.length-2;i++) {
    const w=rows.slice(i-2,i+3);
    if(w.every((b,j)=>j===2||rows[i].h>b.h)) highs.push(rows[i]);
    if(w.every((b,j)=>j===2||rows[i].l<b.l)) lows.push(rows[i]);
  }
  if(highs.length<2||lows.length<2) return 'unknown';
  const down=highs.at(-1).h<highs.at(-2).h&&lows.at(-1).l<lows.at(-2).l;
  const up=highs.at(-1).h>highs.at(-2).h&&lows.at(-1).l>lows.at(-2).l;
  const bosDown=rows.at(-1).c<lows.at(-1).l,bosUp=rows.at(-1).c>highs.at(-1).h;
  return (bias==='bullish'&&down&&bosDown)||(bias==='bearish'&&up&&bosUp)?'opposing':'not_proven_opposing';
}
function classify(input = {}, bias, now) {
  const h1 = rows(input.candles1h, 3600, now), h4 = rows(input.candles4h, 14400, now), d1 = rows(input.candles1d, 86400, now);
  const coverage = { h1: h1.length, h4: h4.length, d1: d1.length };
  const unknown = reason => ({ environment: 'unknown', reason, coverage });
  if ([input.candles1h,input.candles4h,input.candles1d].some(hasConflictingDuplicates)) return unknown('duplicate_conflict');
  if (!h1.length || now-h1.at(-1).t*1000 > 3*3600000) return unknown('h1_stale');
  if(h1.slice(-250).some((c,i,a)=>i>0 && c.t-a[i-1].t>3600 && c.t-a[i-1].t<48*3600)) return unknown('intraday_candle_gap');
  const h6 = sixHour(h1, now), a = atr(h6,14);
  if (!(a>0)) return unknown('atr6h_missing');
  const swingStructure=structure(h4,bias);
  if(swingStructure==='opposing') return {environment:'opposing',reason:'h4_swings_and_bos_oppose_bias',coverage,atr6h:a};
  const fast = ema(h4.map(c=>c.c),21), slow = ema(h4.map(c=>c.c),100), daily = ema(d1.map(c=>c.c),200);
  const direction = d1.at(-1)?.c > daily && fast>slow ? 'bullish' : d1.at(-1)?.c < daily && fast<slow ? 'bearish' : null;
  if (h4.length>=100 && d1.length>=200 && now-h4.at(-1).t*1000<=24*3600000 && now-d1.at(-1).t*1000<=4*86400000 && Math.abs(fast-slow)>a && direction) {
    return { environment: direction===bias?'trend':'opposing', reason: 'daily_h4_momentum', atr6h:a, direction, coverage };
  }
  if (h1.length<250) return unknown('range_history_missing');
  const recent = h1.slice(-250), crosses=[];
  // Cross harus bertahan tiga closed H1; konvensi deterministik proyek untuk
  // menggantikan "meaningful period" visual Prime, bukan parameter kursus.
  let prior=null, run=0, accepted=null;
  for(let i=99;i<recent.length;i++) {
    const values=recent.slice(0,i+1).map(c=>c.c), delta=ema(values,21)-ema(values,100);
    const sign=Math.sign(delta); if(!sign) {run=0;continue;}
    run=sign===prior?run+1:1; prior=sign;
    if(run>=3 && accepted!==sign) { if(accepted!=null) crosses.push(recent[i-2].t); accepted=sign; }
  }
  const high=Math.max(...recent.map(c=>c.h)),low=Math.min(...recent.map(c=>c.l));
  // Kedua ujung window harus tetap dalam range; slope bersih dibatasi satu ATR6H.
  if(crosses.length>=2 && Math.abs(recent.at(-1).c-recent[0].c)<=a && high-low>=3*a) {
    return { environment:'range', reason:'bounded_range_two_sustained_crosses', low,high,atr6h:a,crosses,coverage };
  }
  return { environment:'transition',reason:high-low<3*a?'range_too_narrow':'no_clear_regime',atr6h:a,coverage };
}
function sessionAllowed(t) {
  const date=new Date(t*1000);
  if([0,6].includes(date.getUTCDay())) return false;
  const hour=tz=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(date));
  // Kalender DST IANA. Berlaku untuk semua pair, termasuk AUD/NZD: Prime London/NY.
  return (hour('Europe/London')>=8 && hour('Europe/London')<17) || (hour('America/New_York')>=8 && hour('America/New_York')<17);
}
function eventTime(e) {
  const m=/^(\d{2}):(\d{2})/.exec(String(e?.time_wib||''));
  return m && e.date ? Date.parse(`${e.date}T${m[1]}:${m[2]}:00+07:00`) : NaN;
}
function relevantEvents(events,label) {
  const legs=String(label).split('/');
  return (events||[]).filter(e=>e?.impact==='High' && legs.includes(e.currency));
}
function factualCheck(setup, facts=[]) {
  const text=[setup.reasoning_note,setup.fundamental_bias?.driver,...(setup.fundamental_bias?.konfirmasi||[])].filter(Boolean).join('. ');
  const issues=[];
  // Periksa klaim perbandingan numerik eksplisit saja; bukan parser semantik umum.
  const re=/(?:dari|from)\s*(-?\d+(?:[.,]\d+)?)\s*%?\s*(?:ke|to|menjadi)\s*(-?\d+(?:[.,]\d+)?)\s*%?[^.!?]{0,60}/gi;
  for(const m of text.matchAll(re)) {
    const before=Number(m[1].replace(',','.')),after=Number(m[2].replace(',','.'));
    const context=text.slice(Math.max(0,m.index-45),m.index+m[0].length).toLowerCase();
    if(after>before && /melandai|menurun|turun|menyusut|fell|falling|declin/.test(context)) issues.push('numeric_increase_described_as_fall');
    if(after<before && /meningkat|naik|menguat|rose|rising|increas/.test(context)) issues.push('numeric_decrease_described_as_rise');
  }
  for(const claim of Array.isArray(setup.evidence_claims)?setup.evidence_claims:[]) {
    const f=facts.find(f=>f.id===claim.source_id);
    if(!f || !f.usable) {issues.push('claim_source_missing_or_stale');continue;}
    for(const key of ['actual','previous','forecast']) if(claim[key]!=null && String(claim[key])!==String(f[key])) issues.push(`claim_${key}_mismatch`);
  }
  return { checked_at:Date.now(), scope:'explicit_numeric_comparisons_and_referenced_facts', issues:[...new Set(issues)], source_count:facts.length };
}
function sourceFacts(legs, hashes, now) {
  const out=[];
  for(let i=0;i<legs.length;i++) for(const [indicator, raw] of Object.entries(hashes[i]||{})) {
    if(!raw || typeof raw!=='object') continue;
    const at=/^\d{4}-\d{2}-\d{2}$/.test(raw.date||'')?Date.parse(raw.date+'T00:00:00Z'):NaN;
    const maxAge=/\bGDP\b|quarter|QoQ/i.test(indicator)?150: /annual|yearly/i.test(indicator)?400:75;
    const usable=Number.isFinite(at)&&at<=now&&now-at<=maxAge*86400000 && raw.source!=='seed' && raw.actual!=null;
    out.push({id:stableHash({currency:legs[i],indicator,date:raw.date}),currency:legs[i],indicator,
      actual:raw.actual,previous:raw.previous??null,forecast:raw.forecast??null,period:raw.period??null,
      source:raw.source??null,released_at:raw.date??null,age_days:Number.isFinite(at)?Math.floor((now-at)/86400000):null,usable});
  }
  return legs.flatMap(cur=>out.filter(f=>f.currency===cur).sort((a,b)=>(a.age_days??Infinity)-(b.age_days??Infinity)).slice(0,10));
}
function buildContract(setup, input, events, now, facts=[]) {
  const env=classify(input,setup.bias,now), bounds=zone(setup.entry_zone), check=factualCheck(setup,facts);
  let reason=check.issues[0] || (env.environment==='opposing'?'deterministic_structure_opposes_bias':null);
  let strategy=env.environment==='range'?'choppy':env.environment==='trend'?'momentum':'no_trade';
  if(!reason && strategy==='no_trade') reason=env.reason;
  const entry=bounds?(bounds.low+bounds.high)/2:null;
  let sl=number(setup.sl),tp=number(setup.tp);
  if(!bounds || sl==null || tp==null) reason ||= 'invalid_levels';
  if(strategy==='choppy' && bounds) {
    const width=env.high-env.low;
    if(setup.bias==='bullish'?bounds.high>env.low+.3*width:bounds.low<env.low+.7*width) reason ||= 'range_entry_not_at_edge';
    const sign=setup.bias==='bullish'?1:-1;
    sl=entry-sign*env.atr6h;tp=entry+sign*2*env.atr6h;
    const spread=SPREAD[setup.label];
    if(spread==null || env.atr6h<=spread || tp>env.high || tp<env.low) reason ||= 'range_insufficient_target_room_after_cost';
  }
  const scenarios=buildEventScenarios(events,setup.label,now,{limit:3}).map(({experiment_id,...s})=>({...s,contract:'operational_event_review_v1'}));
  return { version:1,kind:CONTRACT,strategy,environment:env,decided_at:now,decision_hash:stableHash({env,bounds,sl,tp,bias:setup.bias,now}),
    eligible:!reason,reason,zone:bounds,planned_sl:sl,planned_tp:tp,decision_sl:sl,decision_tp:tp,planned_entry:entry,
    sessions:'london_or_new_york_iana_dst',factual_check:check,source_facts:facts,scenarios,
    event_policy:'new_analysis_after_high_impact_release',min_rr:2 };
}
function cancel(st,reason,t) { st.status='canceled'; st.canceled_reason=reason;st.canceled_t=t*1000;st.canceled_detail=reason; }
function evaluate(st,input,now,events=[]) {
  const c=st.operational_contract;
  if(st.entry_execution!==CONTRACT) return false;
  if(!c) {st.status='invalid';st.execution_contract_error='operational_contract_missing';return true;}
  if(!['pending','open'].includes(st.status)) return true;
  if(!c.eligible) {cancel(st,c.reason||'operation_not_eligible',Math.floor(now/1000));return true;}
  if(!['bullish','bearish'].includes(st.bias) || !c.zone || number(st.sl)!==c.planned_sl || number(st.tp)!==c.planned_tp) {st.status='invalid';st.execution_contract_error='operational_levels_changed';return true;}
  if(st.status==='pending') {
    const currentZone=zone(st.entry_zone);
    if(!currentZone || currentZone.low!==c.zone.low || currentZone.high!==c.zone.high) {st.status='invalid';st.execution_contract_error='operational_zone_changed';return true;}
  }
  const all=rows(input,3600,now), sign=st.bias==='bullish'?1:-1;
  if(hasConflictingDuplicates(input)) {st.operation_wait_reason='duplicate_conflict';return true;}
  const start=Math.max(st.level_set_at||st.ts,c.decided_at,st.entry_wait_until||0);
  if(st.status==='pending' && all[0]?.t*1000>start+86400000) {st.status='stale';return true;}
  const related=relevantEvents(events,st.label);
  // Kalender kosong bukan bukti bahwa risiko event tidak ada.
  if(st.status==='pending' && (!Array.isArray(events)||!events.length)) {
    st.operation_wait_reason='calendar_unavailable';
    if(now-st.ts>Math.max(2,st.horizon_days||5)*1.5*86400000) st.status='expired';
    return true;
  }
  if(st.status==='pending' && related.some(e=>!Number.isFinite(eventTime(e)) && (!e.date || (Date.parse(e.date+'T00:00:00+07:00')<=now+Math.max(2,st.horizon_days||5)*86400000 && Date.parse(e.date+'T23:59:59+07:00')>=c.decided_at)))) {
    st.operation_wait_reason='relevant_event_time_unknown';
    if(now-st.ts>Math.max(2,st.horizon_days||5)*1.5*86400000) st.status='expired';
    return true;
  }
  if(st.status==='pending') {
    for(let i=0;i<all.length;i++) {
      const bar=all[i]; if(bar.t*1000<start) continue;
      if(i && bar.t-all[i-1].t>3600 && bar.t-all[i-1].t<48*3600) {
        st.operation_wait_reason='intraday_candle_gap'; return true;
      }
      const end=(bar.t+3600)*1000;
      const intervening=related.find(e=>{const t=eventTime(e);return t>c.decided_at && t<=end;});
      if(intervening) {cancel(st,'event_requires_new_analysis',bar.t);st.event_revalidation={event:intervening.event,event_at:eventTime(intervening),actual:intervening.actual_raw??intervening.actual??null};break;}
      if(related.some(e=>{const t=eventTime(e);return Number.isFinite(t)&&t>end && t<=end+6*3600000;})) continue;
      if(sign===1?bar.l<=c.planned_sl:bar.h>=c.planned_sl) {cancel(st,'entry_invalidated_before_fill',bar.t);break;}
      const touch=bar.l<=c.zone.high&&bar.h>=c.zone.low;
      if(!touch||!sessionAllowed(bar.t)||!sessionAllowed(bar.t+3600)) continue;
      const a=atr(sixHour(all.filter(r=>r.t<=bar.t),end),14),body=Math.abs(bar.c-bar.o);
      const rejected=sign===1?bar.o>c.zone.high&&bar.c>c.zone.high&&bar.c>bar.o:bar.o<c.zone.low&&bar.c<c.zone.low&&bar.c<bar.o;
      if(!rejected || !(a>0) || (c.strategy==='momentum'&&(body<a*.5||body>a))) continue;
      // Open candle berjalan sudah tersedia setelah trigger close. H/L/C parsial
      // tidak dipakai untuk trigger, ATR atau outcome sebelum candle selesai.
      const next=normalizeCandles((input||[]).filter(r=>r && ['t','o','h','l','c'].every(k=>number(r[k])!=null)))
        .find(r=>r.t===bar.t+3600 && r.t*1000<=now);
      if(!next) {st.operation_wait_reason='next_h1_open_unavailable';continue;}
      const fill=next.o;
      let sl=c.planned_sl,tp=c.planned_tp;
      if(c.strategy==='choppy') {sl=fill-sign*a;tp=fill+sign*2*a;if(tp>c.environment.high||tp<c.environment.low)continue;}
      if(sign===1?sl>=bar.l:sl<=bar.h) continue;
      const risk=sign*(fill-sl),reward=sign*(tp-fill);
      if(!(risk>0&&reward>0&&reward/risk>=2-1e-9)) continue;
      st.status='open';st.filled_t=next.t;st.filled_price=fill;st.rr=reward/risk;
      st.original_entry_zone=st.entry_zone;st.entry_zone=String(fill);st.sl=String(sl);st.tp=String(tp);
      st.initial_sl=sl;st.initial_tp=tp;st.initial_risk=risk;st.trigger_candle={...bar};
      st.operational_status='open';st.excursion_basis='closed_H1_extremes_intrabar_order_unknown';
      st.operational_contract={...c,planned_sl:sl,planned_tp:tp,filled_at:next.t};
      delete st.operation_wait_reason;break;
    }
    if(st.status==='pending' && now-st.ts>Math.max(2,st.horizon_days||5)*1.5*86400000) st.status='expired';
  }
  if(st.status==='open') {
    const fill=number(st.filled_price),sl=number(st.initial_sl),tp=number(st.initial_tp),risk=number(st.initial_risk);
    if(!(risk>0)||fill==null||sl==null||tp==null) {st.status='invalid';return true;}
    if(all[0]?.t>st.filled_t) {st.operation_wait_reason='fill_history_missing';return true;}
    let managedSl=sl,managedDone=false;
    for(const bar of all.filter(b=>b.t>=st.filled_t)) {
      if(st.intervention?.type==='close_early' && st.intervention.t<=bar.t*1000) managedDone=true;
      if(st.intervention?.new_sl!=null && st.intervention.t<=bar.t*1000) {
        const tighter=number(st.intervention.new_sl);
        if(tighter!=null) managedSl=sign===1?Math.max(managedSl,tighter):Math.min(managedSl,tighter);
      }
      const hitSl=sign===1?bar.l<=sl:bar.h>=sl,hitTp=sign===1?bar.h>=tp:bar.l<=tp;
      // Outcome mentah tetap memakai kontrak awal; milestone dikelola terpisah.
      const hitManaged=sign===1?bar.l<=managedSl:bar.h>=managedSl;
      if(c.strategy==='choppy'&&!managedDone) {
        if(hitManaged||hitTp) {
          const exit=hitManaged&&hitTp?null:hitTp?tp:managedSl;
          const spread=SPREAD[st.label];
          st.choppy_management={status:hitManaged&&hitTp?'ambiguous':hitTp?'tp':'sl',closed_t:bar.t,exit_price:exit,stop:managedSl,
            gross_r:exit==null?null:sign*(exit-fill)/risk,net_r_estimate:exit==null||spread==null?null:sign*(exit-fill)/risk-spread/risk};
          managedDone=true;
        } else {
          const favorable=sign===1?bar.h-fill:fill-bar.l;
      const lock=favorable>=1.5*risk ? .5 : favorable>=risk ? 0 : null;
          if(lock!=null) managedSl=sign===1?Math.max(managedSl,fill+lock*risk):Math.min(managedSl,fill-lock*risk);
        }
      }
      const favorable=Math.max(0,sign===1?bar.h-fill:fill-bar.l)/risk,adverse=Math.max(0,sign===1?fill-bar.l:bar.h-fill)/risk;
      st.mfe_r=Math.max(st.mfe_r||0,favorable);st.mae_r=Math.max(st.mae_r||0,adverse);
      if(hitSl||hitTp) {st.status=hitSl&&hitTp?'ambiguous':hitTp?'tp':'sl';st.closed_t=bar.t;break;}
    }
    if(st.status==='tp'||st.status==='sl') {
      const spread=SPREAD[st.label];st.net_r_estimate=spread==null?null:(st.status==='tp'?st.rr:-1)-spread/risk;
      st.cost_basis='estimated_spread_only_excludes_swap_commission_slippage';
    }
  }
  return true;
}
module.exports={CONTRACT,SPREAD,rows,sixHour,structure,classify,sessionAllowed,factualCheck,sourceFacts,buildContract,evaluate};
