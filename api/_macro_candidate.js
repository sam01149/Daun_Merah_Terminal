'use strict';

// Qualitative adaptation of the Academy hierarchy, shared by the live dashboard
// and offline review. No price probabilities or optimized numeric weights.
const { MAX_AGE_DAYS } = require('./_macro_surprise');
const {buildOverall} = require('./_smart_bias');
const CURRENCIES = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
const DAY = 86400000;
const VERSION = 'academy_qualitative_v1';
const sign = value => !Number.isFinite(value) ? null : value === 0 ? 0 : value > 0 ? 1 : -1;

function evidenceDirection(components, required) {
  const available = components.filter(item => item?.direction != null);
  const directions = available.map(item => item.direction);
  const complete = required.every(name => components.some(item => item?.concept === name && item.direction != null));
  // Disagreement and ties remain explicit. Small estimates never acquire a
  // "high confidence" label merely because their mathematical sign is nonzero.
  const state = !complete ? 'insufficient' : directions.includes(1) && directions.includes(-1) ? 'mixed'
    : directions.every(value=>value===0) ? 'unchanged' : directions.some(value => value === 0) ? 'unclear' : directions.every(value => value === 1) ? 'up'
      : directions.every(value => value === -1) ? 'down' : 'unclear';
  return { state, coverage:complete ? 'complete' : available.length ? 'partial' : 'missing', available:available.length, required:required.length };
}

function validRows(rows, asOfMs, mode) {
  const groups = new Map();
  for (const row of rows || []) {
    if (row?.schema_version !== 2 || !CURRENCIES.includes(row.currency) || !row.id || !row.source_event_id || typeof row.series!=='string' || !MAX_AGE_DAYS[row.cadence] || !Number.isFinite(row.actual)
      || !Number.isFinite(row.time_ms) || row.time_ms > asOfMs) continue;
    const observedMs = Date.parse(row.observed_at);
    if (!Number.isFinite(observedMs) || row.time_ms > observedMs || (mode !== 'diagnostic' && observedMs > asOfMs)) continue;
    if (asOfMs-row.time_ms > (MAX_AGE_DAYS[row.cadence] || 0)*DAY) continue;
    if (!groups.has(row.id)) groups.set(row.id,[]);
    groups.get(row.id).push(row);
  }
  // Conditions use the most recent estimate actually known as of the cutoff.
  // This differs deliberately from the first-print surprise calculation.
  // Same-time contradictory content is excluded rather than order-dependent.
  const chosen=[];
  for (const versions of groups.values()) {
    versions.sort((a,b)=>b.time_ms-a.time_ms || Date.parse(b.observed_at)-Date.parse(a.observed_at));
    const first=versions[0];
    const simultaneous=versions.filter(row=>row.time_ms===first.time_ms && row.observed_at===first.observed_at);
    if (simultaneous.some(row=>row.actual!==first.actual || row.previous!==first.previous)) continue;
    chosen.push(first);
  }
  return chosen;
}

function latest(rows, prefixes, measure) {
  // Preference is fixed by definition, not by which choice produces a desired
  // direction. Within a definition choose the latest reference release.
  for (const prefix of prefixes) {
    const matching=rows.filter(row=>row.series.startsWith(prefix+':') && (!measure || row.series.split(':')[1]===measure));
    if (matching.length) return matching.sort((a,b)=>b.time_ms-a.time_ms || a.id.localeCompare(b.id))[0];
  }
  return null;
}

function component(row, concept, { neutral=null, inverse=false } = {}) {
  if (!row) return { concept,direction:null,reason:'missing_or_stale' };
  const actual=row.actual;
  const previous=Number.isFinite(row.previous) ? row.previous : null;
  if (['labour','survey'].includes(concept) && [actual,previous].some(value=>value!=null && (value<0 || value>100))) {
    return {concept,direction:null,reason:'outside_indicator_range'};
  }
  const change=Number.isFinite(actual) && Number.isFinite(previous) ? actual-previous : null;
  return {
    concept,indicator:row.title,series:row.series,actual,previous,change,
    direction:sign(change)==null ? null : sign(change)*(inverse ? -1 : 1),
    level_direction:neutral==null ? null : sign(actual-neutral),
    comparison:'previous_reported_in_same_release',
    comparison_basis:row.currency+'|'+row.series,cadence:row.cadence,
    source_event_id:row.source_event_id,source_url:row.source_url,period:row.period,unit:row.unit,
    released_at:new Date(row.time_ms).toISOString(),observed_at:row.observed_at,vintage_kind:row.vintage_kind,
    forecast:row.forecast ?? null,
  };
}

function gdpComponent(rows) {
  const quarterly=rows.filter(row=>row.cadence==='quarterly');
  const row=latest(quarterly,['gdp'],'qoq') || latest(quarterly,['gdp'],'annualized') || latest(quarterly,['gdp'],'yoy');
  // Keep the national series in its published units. For example a US "QoQ"
  // calendar title can report an annualized rate. No cross-country arithmetic.
  return component(row,'output',{neutral:0});
}

function buildMacroCandidate(observations,{asOfMs=Date.now(),mode='observed',integrated=false}={}) {
  if (!Number.isFinite(asOfMs)) throw Error('Invalid as-of timestamp');
  if (!['observed','diagnostic'].includes(mode)) throw Error('Unknown evaluation mode');
  const rows=validRows(observations,asOfMs,mode);
  const currencies={};
  for (const currency of CURRENCIES) {
    const local=rows.filter(row=>row.currency===currency);
    // GDP and labour are the core. A consumption print or survey cannot flip
    // them. Composite PMI values are unavailable in parts of the actual feed;
    // optional context must not be fabricated or silently made compulsory.
    const growth=[gdpComponent(local),
      component(latest(local,['unemployment_rate'],'level'),'labour',{inverse:true})];
    const survey=component(latest(local,['composite_pmi'],'level'),'survey',{neutral:50});
    const consumption=component(latest(local,['retail_sales'],'yoy'),'consumption');
    const consumer=[
      component(latest(local,['consumer_prices'],'yoy'),'headline'),
      component(latest(local,['cpi_ex_food_household_energy_vehicle_fuels','core_consumer_prices','trimmed_mean_cpi','weighted_median_cpi','cpi_trimmed_mean','cpi_median'],'yoy'),'underlying'),
    ];
    let consumerSummary=evidenceDirection(consumer,['headline','underlying']);
    if (consumerSummary.coverage==='complete' && (consumer[0].period!==consumer[1].period
      || consumer[0].cadence!==consumer[1].cadence || String(consumer[0].period).startsWith('released-'))) {
      consumerSummary={...consumerSummary,state:'insufficient',coverage:'partial',reason:'consumer_reference_periods_not_aligned'};
    }
    // Producer price pressure remains visible; it does not define consumer
    // inflation by averaging together different economic concepts.
    const producer=component(latest(local,['producer_prices','ppi_output','ppi_input'],'yoy'),'producer');
    currencies[currency]={
      growth:{...evidenceDirection(growth,['output','labour']),components:growth,survey_context:survey,consumption_context:consumption,
        meaning:'momentum_of_reported_GDP_and_unemployment; GDP/PMI levels shown separately'},
      inflation:{...consumerSummary,components:consumer,producer_context:producer,meaning:'change_in_consumer_inflation_yoy; not a currency forecast'},
      evidence_quality:{kind:'coverage_and_agreement_only'},
    };
  }
  return {
    version:VERSION,as_of:new Date(asOfMs).toISOString(),mode,currencies,
    integration:{enabled:integrated,reason:integrated?'active_qualitative_dashboard':'preintegration_review',data_point_in_time:mode==='observed'},
    academy:{core:['growth','inflation','labour','central_bank'],secondary:['bank_research','positioning'],one_off_surprises:'context_only',numeric_formula:'local_adaptation_not_published_by_academy'},
    constraints:{growth_core_concepts:2,growth_context_concepts:2,consumer_price_concepts:2,optimized_weights:0,probability_claims:false},
  };
}

function buildAcademyPreview(candidate, contextRows=[]) {
  const mapState=state=>({up:'bullish',down:'bearish',unchanged:'neutral',mixed:'mixed',unclear:'mixed'})[state] || 'insufficient';
  const missing=()=>({state:'insufficient',confidence:null,freshness:'insufficient',evidence:[]});
  return CURRENCIES.map(currency=>{
    const item=candidate.currencies[currency];
    const context=contextRows.find(row=>row.currency===currency) || {};
    const provided=context.central_bank;
    const substantive=(provided?.evidence || []).filter(row=>String(row.title || '').trim()
      && !/\b(probabilit(?:y|ies)|placeholder|no data|unavailable)\b/i.test(row.title));
    const informationTime=Date.parse(provided?.as_of);
    const referenceTime=Date.parse(candidate.as_of);
    const central_bank=provided && (substantive.length || provided.tone_source==='cb_bias') && Number.isFinite(informationTime)
      && informationTime<=referenceTime && referenceTime-informationTime<=21*DAY
      ? {...provided,evidence:substantive,confidence:null}
      : {...missing(),reason:'dated_substantive_policy_evidence_missing'};
    const growth={state:mapState(item.growth.state),confidence:null,conditions:item.growth,
      evidence:item.growth.components.filter(row=>row.source_event_id),methodology:'reported_conditions',
      freshness:item.growth.coverage==='missing' ? 'insufficient' : 'fresh'};
    const impulse=mapState(item.inflation.state);
    const aligned=!['bullish','bearish'].includes(impulse) || central_bank.state===impulse;
    const inflation={state:aligned ? impulse : 'mixed',confidence:null,inflation_impulse:impulse,
      policy_context:central_bank.state,conditions:item.inflation,
      evidence:item.inflation.components.filter(row=>row.source_event_id),methodology:'consumer_price_conditions',
      freshness:item.inflation.coverage==='missing' ? 'insufficient' : 'fresh'};
    const banks=context.banks ? {...context.banks,confidence:null} : missing();
    const positioning=context.positioning ? {...context.positioning,confidence:null} : missing();
    const {confidence:_legacyConfidence,...overall}=buildOverall({growth,inflation,central_bank,banks,positioning});
    if ([growth,inflation,central_bank].some(layer=>layer.state==='mixed')) {
      overall.state='mixed';
      overall.confirmations=[];
      overall.conflicts=[];
      overall.rationale_codes=overall.rationale_codes.filter(code=>!code.endsWith('_confirms') && !code.endsWith('_conflicts'))
        .map(code=>code==='core_consistent' ? 'core_conflict' : code);
      overall.rationale_codes.push('core_disagreement_kept_explicit');
    }
    return {currency,as_of:candidate.as_of,growth,inflation,central_bank,banks,positioning,
      overall:{...overall,confidence:null,interpretation:'qualitative_fundamental_bias_not_trade_signal',
        evidence_quality:{coverage:[growth,inflation,central_bank].filter(layer=>layer.state!=='insufficient').length,
          total_core_columns:3,confirmations:overall.confirmations,conflicts:overall.conflicts}},
      context_limitations:['central_bank_updated_at_is_processing_time_not_verified_original_article_time'],
    };
  });
}

module.exports={ VERSION,CURRENCIES,buildMacroCandidate,buildAcademyPreview,evidenceDirection,
  buildMacroConditions:buildMacroCandidate,buildQualitativeBiasRows:buildAcademyPreview };
