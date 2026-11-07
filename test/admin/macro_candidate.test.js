'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeMacroObservation,normalizeMacroRelease}=require('../../api/_macro_surprise');
const {buildMacroCandidate,buildAcademyPreview,evidenceDirection}=require('../../api/_macro_candidate');
const NOW=Date.parse('2026-11-06T17:00:00Z');
const OBS='2026-11-06T16:00:00Z';
function raw(title,actual,previous,extra={}) {
  return {title,currency:'USD',country:'US',id:title,actualRaw:actual,previousRaw:previous,
    date:'2026-11-04T13:30:00Z',referenceDate:'2026-10-31T00:00:00Z',unit:'%',...extra};
}
function rows(events) {
  return events.map(event=>normalizeMacroObservation(event,{observedAt:OBS,allowRevisions:true})).filter(Boolean);
}
function core(extra=[]) {
  return rows([
    raw('GDP Growth Rate QoQ Adv',2,1,{referenceDate:'2026-09-30T00:00:00Z',referencePeriod:'Q3 2026'}),
    raw('S&P Global Composite PMI Final',52,51,{unit:null}),
    raw('Unemployment Rate',4,4.2),
    raw('Inflation Rate YoY',2.1,2.3),
    raw('Core Inflation Rate YoY',2.2,2.4),...extra,
  ]);
}

test('conditions accept actual without consensus and later estimates; surprise production contract unchanged',()=>{
  const input=raw('GDP Growth Rate QoQ Final',2,1);
  assert.ok(normalizeMacroObservation(input,{observedAt:OBS,allowRevisions:true}));
  assert.equal(normalizeMacroRelease(input,{observedAt:OBS,allowRevisions:true}),null);
  assert.equal(normalizeMacroRelease(raw('Inflation Rate YoY',2,1),{observedAt:OBS}),null);
  assert.equal(normalizeMacroObservation(raw('Inflation Rate YoY',null,1),{observedAt:OBS}),null);
});

test('economic improvement is separate from expansion and from a negative surprise',()=>{
  const input=core();
  input.find(r=>r.series.startsWith('gdp:')).forecast=3;
  const result=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD;
  assert.equal(result.growth.state,'up');
  const output=result.growth.components.find(r=>r.concept==='output');
  assert.equal(output.actual,2);assert.equal(output.previous,1);
  assert.equal(output.direction,1);assert.equal(output.level_direction,1);
  assert.equal(output.forecast,3,'missed consensus remains context, not the condition direction');
  input.find(r=>r.series.startsWith('gdp:')).actual=0.5;
  const slower=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(slower.components[0].level_direction,1,'still expanding');
  assert.equal(slower.components[0].direction,-1,'growth rate nevertheless slowed');
  assert.equal(slower.state,'mixed');
});

test('producer prices and duplicate variants cannot flip the consumer-inflation assessment',()=>{
  const baseline=buildMacroCandidate(core(),{asOfMs:NOW}).currencies.USD.inflation;
  const added=buildMacroCandidate(core([raw('PPI YoY',99,1),raw('Core PPI YoY',55,1),
    raw('Inflation Rate MoM',5,1),raw('Core Inflation Rate MoM',4,1)]),{asOfMs:NOW}).currencies.USD.inflation;
  assert.equal(baseline.state,'down');assert.equal(added.state,'down');
  assert.deepEqual(baseline.components,added.components);
  assert.equal(added.producer_context.actual,99);
  assert.equal(added.components.length,2);
});

test('actual contraction despite improving PMI is visible rather than silently renamed expansion',()=>{
  const input=core();const survey=input.find(r=>r.series.startsWith('composite_pmi:'));
  survey.actual=49;survey.previous=48;
  const result=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(result.survey_context.direction,1);
  assert.equal(result.survey_context.level_direction,-1);
});

test('no false precision from small/cancelling signals, flat labour or missing data',()=>{
  assert.equal(evidenceDirection([{concept:'a',direction:1},{concept:'b',direction:-1}],['a','b']).state,'mixed');
  const input=core();input.find(r=>r.series.startsWith('unemployment_rate:')).previous=4;
  const result=buildMacroCandidate(input,{asOfMs:NOW});
  assert.equal(result.currencies.USD.growth.state,'unclear');
  assert.equal(result.currencies.EUR.growth.state,'insufficient');
  assert.equal('probability' in result.currencies.USD.evidence_quality,false);
  assert.equal(result.constraints.optimized_weights,0);
});

test('stale, future releases, observations unavailable as-of and contradictory rows fail closed',()=>{
  const input=core();const old={...input[2],time_ms:NOW-76*86400000};
  assert.equal(buildMacroCandidate([input[0],input[1],old],{asOfMs:NOW}).currencies.USD.growth.state,'insufficient');
  assert.equal(buildMacroCandidate(core().map(row=>({...row,observed_at:'2026-12-01T00:00:00Z'})),{asOfMs:NOW}).currencies.USD.growth.state,'insufficient');
  assert.equal(buildMacroCandidate(core().map(row=>({...row,time_ms:NOW+86400000})),{asOfMs:NOW}).currencies.USD.growth.state,'insufficient');
  const conflict={...input[2],actual:10};
  for(const values of [[...input,conflict],[conflict,...input]]) assert.equal(buildMacroCandidate(values,{asOfMs:NOW}).currencies.USD.growth.state,'insufficient');
});

test('conditions use the latest estimate actually known then; one economic concept still counts once',()=>{
  const input=core();const revised={...input[0],title:'GDP Growth Rate QoQ Final',time_ms:input[0].time_ms+86400000,actual:3};
  const result=buildMacroCandidate([...input,revised],{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(result.components[0].actual,3);assert.equal(result.components.length,2);
  assert.equal(buildMacroCandidate([...input,{...revised,observed_at:'2026-12-01'}],{asOfMs:NOW}).currencies.USD.growth.components[0].actual,2);
});

test('currency contexts remain separate; national GDP conventions and different cadences are not averaged',()=>{
  const input=core();
  const gbp=core().map(row=>({...row,currency:'GBP',id:'GBP|'+row.id,source_country:'GB',source_event_id:'GB-'+row.source_event_id}));
  const result=buildMacroCandidate([...input,...gbp],{asOfMs:NOW});
  assert.equal('relative_to_usd' in result.currencies.USD.growth,false);
  assert.equal(result.currencies.GBP.growth.state,'up');
  gbp[0].series='gdp:yoy:quarterly';gbp[0].actual=20;
  gbp[2].cadence='quarterly';
  const mismatch=buildMacroCandidate([...input,...gbp],{asOfMs:NOW});
  assert.deepEqual(mismatch.currencies.USD,result.currencies.USD);
  assert.equal(mismatch.currencies.GBP.growth.components[0].actual,20);
  assert.equal(mismatch.currencies.GBP.growth.components[1].cadence,'quarterly');
});

test('Academy tier two never flips the core and surprise context never votes',()=>{
  const input=core();
  input.filter(row=>row.pillar==='inflation').forEach(row=>{row.previous=1;});
  const candidate=buildMacroCandidate(input,{asOfMs:NOW});
  const context=[{currency:'USD',central_bank:{state:'bullish',as_of:OBS,evidence:[{title:'Fed holds rates and signals restrictive policy'}]},banks:{state:'bearish'},positioning:{state:'bearish'}}];
  const row=buildAcademyPreview(candidate,context)[0];
  assert.equal(row.growth.state,'bullish');
  assert.equal(row.inflation.inflation_impulse,'bullish');
  assert.equal(row.inflation.state,'bullish');
  assert.equal(row.overall.state,'bullish');
  assert.deepEqual(row.overall.conflicts,['banks','positioning']);
  assert.equal(row.overall.confidence,null);
  assert.equal('probability' in row.overall.evidence_quality,false);
  const changed=input.map(r=>({...r,forecast:10000}));
  assert.equal(buildAcademyPreview(buildMacroCandidate(changed,{asOfMs:NOW}),context)[0].overall.state,row.overall.state);
});

test('a contradictory core is not erased by two agreeing columns',()=>{
  const candidate=buildMacroCandidate(core(),{asOfMs:NOW});
  const context=[{currency:'USD',central_bank:{state:'bullish',as_of:OBS,evidence:[{title:'Fed holds rates'}]}}];
  const row=buildAcademyPreview(candidate,context)[0];
  assert.equal(row.growth.state,'bullish');
  assert.equal(row.central_bank.state,'bullish');
  assert.equal(row.inflation.state,'mixed');
  assert.equal(row.overall.state,'mixed');
  assert.ok(row.overall.rationale_codes.includes('core_disagreement_kept_explicit'));
});

test('GDP/jobs core survives contrary retail/PMI context; optional missing PMI is explicit',()=>{
  const input=core([raw('Retail Sales YoY',-10,3)]);
  const survey=input.find(row=>row.series.startsWith('composite_pmi:'));
  survey.actual=40;survey.previous=50;
  const full=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(full.state,'up');assert.equal(full.survey_context.direction,-1);
  assert.equal(full.consumption_context.direction,-1);
  const absent=buildMacroCandidate(input.filter(row=>!row.series.startsWith('composite_pmi:')),{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(absent.state,'up');assert.equal(absent.survey_context.direction,null);
});

test('policy-probability placeholders or future/stale source timestamps cannot support a core bias',()=>{
  const candidate=buildMacroCandidate(core(),{asOfMs:NOW});
  for(const central_bank of [
    {state:'bullish',as_of:OBS,evidence:[{title:'Fed Interest Rate Probabilities'}]},
    {state:'bullish',as_of:'2026-12-01',evidence:[{title:'Fed holds rates'}]},
    {state:'bullish',as_of:'2026-08-01',evidence:[{title:'Fed holds rates'}]},
  ]) assert.equal(buildAcademyPreview(candidate,[{currency:'USD',central_bank}])[0].central_bank.state,'insufficient');
});

test('Dashboard uses the same stored central-bank panel tone without requiring headlines',()=>{
  const {buildPanelTone}=require('../../api/_smart_bias');
  const candidate=buildMacroCandidate(core(),{asOfMs:NOW});
  for(const [bias,state] of [['Cautious Dovish','bearish'],['Hawkish','bullish'],['Neutral','neutral'],['Split','mixed']]) {
    const tone=buildPanelTone({bias,bias_updated:OBS,source_headlines:[{title:'Interest Rate Probabilities'}]},NOW);
    const row=buildAcademyPreview(candidate,[{currency:'USD',central_bank:tone}])[0];
    assert.equal(row.central_bank.state,state);
    assert.equal(row.central_bank.bias,bias);
    assert.equal(row.central_bank.tone_source,'cb_bias');
    assert.equal(row.central_bank.evidence.length,0);
  }
  for(const bank of [{bias:'Hawkish'}, {bias:'Hawkish',bias_updated:'2026-12-01'},
    {bias:'Hawkish',bias_updated:'2026-08-01'}, {bias:'unknown',bias_updated:OBS}]) {
    const tone=buildPanelTone(bank,NOW);
    assert.equal(buildAcademyPreview(candidate,[{currency:'USD',central_bank:tone}])[0].central_bank.state,'insufficient');
  }
});

test('GDP annualized data stays in the declared national series without invented conversions',()=>{
  const input=core();const gdp=input.find(row=>row.series.startsWith('gdp:'));
  gdp.series='gdp:annualized:quarterly';gdp.actual=4;gdp.previous=2;
  const output=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.growth.components[0];
  assert.equal(output.actual,4);assert.equal(output.previous,2);
  assert.equal(output.comparison_basis,'USD|gdp:annualized:quarterly');
});

test('offline review preserves semantic checks and never claims price probabilities',()=>{
  const {buildReview,reviewMarkdown}=require('../../scripts/review_macro_candidate');
  const report=buildReview([{source:'tradingview',fetched_at:OBS,rows:[raw('Inflation Rate YoY',3,2)]}],[],[],NOW);
  assert.equal(report.preview.length,8);assert.equal(report.readiness.integrated,false);
  assert.equal(report.verification.ppi_cannot_flip_consumer_prices,true);
  assert.match(reviewMarkdown(report),/bukan probabilitas\/target harga/);
  assert.match(reviewMarkdown(report),/Data kurang/);
});

test('consumer prices from different reference periods are not presented as one aligned assessment',()=>{
  const input=core();input.find(row=>row.series.startsWith('core_consumer_prices:')).period='2026-09';
  const result=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.inflation;
  assert.equal(result.state,'insufficient');
  assert.equal(result.reason,'consumer_reference_periods_not_aligned');
});

test('impossible unemployment or PMI index values are unavailable, not strong signals',()=>{
  const input=core();input.find(row=>row.series.startsWith('unemployment_rate:')).actual=400;
  input.find(row=>row.series.startsWith('composite_pmi:')).actual=-30;
  const result=buildMacroCandidate(input,{asOfMs:NOW}).currencies.USD.growth;
  assert.equal(result.state,'insufficient');
  assert.equal(result.components[1].reason,'outside_indicator_range');
  assert.equal(result.survey_context.reason,'outside_indicator_range');
});
