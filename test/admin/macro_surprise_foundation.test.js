'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MACRO_HISTORY_INDEX_KEY,
  MACRO_HISTORY_DATA_KEY,
  classifyMacroRelease,
  normalizeMacroRelease,
  standardizeMacroHistory,
  buildMacroPillarScores,
  assessMacroScoreStability,
  buildCftcFoundation,
  persistMacroReleases,
  normalizeMacroReleases,
  loadMacroReleases,
  MACRO_HISTORY_MANIFEST_KEY,
  MACRO_HISTORY_VINTAGES_KEY,
} = require('../../api/_macro_surprise');

test('macro classifier keeps currency-area data and rejects EUR national releases', () => {
  assert.deepEqual(classifyMacroRelease('Euro Area Composite PMI', 'EUR'), {
    pillar: 'growth', family: 'activity_survey', series: 'composite_pmi:level:monthly', inverse: false, cadence: 'monthly', unit:'index',
  });
  assert.equal(classifyMacroRelease('German CPI YoY', 'EUR'), null);
  assert.equal(classifyMacroRelease('ECB President Speaks', 'EUR'), null);
  assert.equal(classifyMacroRelease('GDP QoQ Final', 'USD'), null);
  assert.ok(classifyMacroRelease('GDP QoQ Advance', 'USD'));
  assert.deepEqual(classifyMacroRelease('Average Hourly Earnings YoY', 'USD'), {
    pillar:'growth', family:'labour', series:'hourly_earnings:yoy:monthly', inverse:false, cadence:'monthly', unit:'percent',
  });
});

test('normalization requires actual and forecast and preserves inverse semantics', () => {
  const row = normalizeMacroRelease({
    currency: 'USD', title: 'Initial Jobless Claims', date: '2026-10-22T12:30:00Z',
    actualRaw: 194000, forecastRaw: 200000, previousRaw: 205000, period: 'Oct/17',
  });
  assert.equal(row.series, 'initial_jobless_claims:level:weekly');
  assert.equal(row.inverse, true);
  assert.equal(row.actual, 194000);
  assert.equal(normalizeMacroRelease({ currency: 'USD', title: 'GDP QoQ', date: '2026-10-22T12:30:00Z', actualRaw: 2.1 }), null);
});

test('standardization uses only prior forecast errors and needs 12 observations', () => {
  const base = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: String(i), currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: base + i * 86400000,
  }));
  const scored = standardizeMacroHistory(rows);
  assert.equal(scored[11].standardized_surprise, null);
  assert.equal(scored[12].prior_n, 12);
  assert.ok(Number.isFinite(scored[12].standardized_surprise));
  // Adding a huge future error cannot alter an already-computed older score.
  const older = scored[12].standardized_surprise;
  rows.push({ ...rows[0], id: 'future', actual: 1000, time_ms: base + 99 * 86400000 });
  assert.equal(standardizeMacroHistory(rows)[12].standardized_surprise, older);
});

test('pillar score weights economic families equally, not the number of releases', () => {
  const asOf = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  for (const [series, family, latestError] of [
    ['services_pmi:level', 'activity_survey', 1],
    ['manufacturing_pmi:level', 'activity_survey', 1],
    ['gdp:qoq', 'output', -1],
  ]) {
    rows.push(
      { id: `${series}-a`, currency: 'USD', series, pillar: 'growth', family, actual: -1, forecast: 0, inverse: false, time_ms: asOf - 4 * 86400000 },
      { id: `${series}-b`, currency: 'USD', series, pillar: 'growth', family, actual: 1, forecast: 0, inverse: false, time_ms: asOf - 3 * 86400000 },
      { id: `${series}-c`, currency: 'USD', series, pillar: 'growth', family, actual: latestError, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
    );
  }
  const result = buildMacroPillarScores(rows, { asOfMs: asOf, minPriorErrors: 2, halfLifeDays: 1000 });
  const growth = result.currencies.USD.growth;
  assert.equal(growth.family_count, 2);
  assert.equal(growth.series_count, 3);
  assert.ok(Math.abs(growth.score) < 1e-12, `expected equal-family cancellation, got ${growth.score}`);
});

test('Growth foundation requires both activity and labour and exposes their alignment', () => {
  const asOf = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  for (const [series, family, latest] of [
    ['composite_pmi:level', 'activity_survey', 2],
    ['services_pmi:level', 'activity_survey', 2],
    ['employment_change:level', 'labour', 1],
  ]) {
    for (let i = 0; i < 12; i++) rows.push({
      id:`${series}-prior-${i}`, currency:'USD', series, pillar:'growth', family,
      actual:i % 2 ? 1 : -1, forecast:0, inverse:false, time_ms:asOf - (30 - i) * 86400000,
    });
    rows.push({ id:`${series}-latest`, currency:'USD', series, pillar:'growth', family, actual:latest, forecast:0, inverse:false, time_ms:asOf - 86400000, title:series, date:'2026-10-24' });
  }
  const growth = buildMacroPillarScores(rows, { asOfMs:asOf, halfLifeDays:1000 }).currencies.USD.growth;
  assert.equal(growth.family_count, 2, 'dua PMI tetap satu family aktivitas');
  assert.equal(growth.buckets.activity.family_count, 1);
  assert.equal(growth.buckets.labour.family_count, 1);
  assert.equal(growth.ready, true);
  assert.equal(growth.direction_candidate, 'up');
  assert.equal(growth.status, 'up');
});

test('sensitivity returns no direction when reasonable decay choices disagree', () => {
  const asOf = Date.parse('2026-10-25T00:00:00Z');
  const rows = [];
  // Old positive surprise and very recent negative surprise deliberately make
  // short and long decay choices disagree.
  for (let i = 0; i < 12; i++) rows.push({
    id: `prior-${i}`, currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: asOf - (180 - i) * 86400000,
  });
  for (let i = 0; i < 12; i++) rows.push({
    id: `survey-prior-${i}`, currency: 'USD', series: 'composite_pmi:level', pillar: 'growth', family: 'activity_survey',
    actual: i % 2 ? 1 : -1, forecast: 0, inverse: false, time_ms: asOf - (180 - i) * 86400000,
  });
  rows.push(
    { id: 'old-positive', currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output', actual: 3, forecast: 0, inverse: false, time_ms: asOf - 100 * 86400000 },
    { id: 'recent-negative', currency: 'USD', series: 'gdp:qoq', pillar: 'growth', family: 'output', actual: -0.5, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
    { id: 'survey-flat', currency: 'USD', series: 'composite_pmi:level', pillar: 'growth', family: 'activity_survey', actual: 0, forecast: 0, inverse: false, time_ms: asOf - 86400000 },
  );
  const result = assessMacroScoreStability(rows, { asOfMs: asOf, halfLives: [10, 200] });
  assert.equal(result.currencies.USD.growth.direction, null);
  assert.equal(result.currencies.USD.growth.stable, false);
});

test('CFTC direction follows Leveraged Funds while AM conflict lowers quality', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const cot = {
    report_date: '2026-10-20', release_date: '2026-10-23',
    positions: { EUR: { lev_net: 12000, lev_change_net: 1500, lev_net_pct_oi: 4.2, am_net: -30000, am_change_net: -2000 } },
    percentiles: { EUR: { lev_pctile: 72 } },
  };
  const result = buildCftcFoundation('EUR', cot, now);
  assert.equal(result.direction, 'up');
  assert.equal(result.asset_manager.confirms, false);
  assert.equal(result.quality, 'reduced');
});

test('CFTC stale or missing data never becomes a neutral direction', () => {
  const result = buildCftcFoundation('JPY', { report_date: '2026-09-01', positions: { JPY: { lev_net: -20 } } }, Date.parse('2026-10-25T00:00:00Z'));
  assert.equal(result.direction, null);
  assert.equal(result.quality, 'unavailable');
});

test('history persistence uses deterministic hash plus sorted-set index', async () => {
  const calls = [];
  const redis = async (...args) => { calls.push(args); return 1; };
  const result = await persistMacroReleases([
    { currency: 'USD', source_country:'US', source_event_id:'fixture-gdp', event: 'GDP QoQ', date: '2026-10-22', time_wib: '19:30 WIB', actual_raw: 2.2, forecast_raw: 2.0, period: 'Q3' },
    { currency: 'EUR', event: 'German CPI YoY', date: '2026-10-22', time_wib: '15:00 WIB', actual_raw: 2.1, forecast_raw: 2.0, period: 'Sep' },
  ], redis);
  assert.equal(result.stored, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'EVAL');
  assert.equal(calls[0][2], 3);
  assert.deepEqual(calls[0].slice(3,6), [MACRO_HISTORY_INDEX_KEY,MACRO_HISTORY_DATA_KEY,MACRO_HISTORY_VINTAGES_KEY]);
});

test('registry rejects GDP price/components and separates economic definitions', () => {
  for (const title of ['GDP Price Index QoQ Adv','GDP Sales QoQ Adv','GDP Private Consumption QoQ Prel']) assert.equal(classifyMacroRelease(title,'USD'),null);
  for (const [currency,a,b] of [
    ['USD','Initial Jobless Claims','Continuing Jobless Claims'],
    ['USD','Non Farm Payrolls','Nonfarm Payrolls Private'],
    ['GBP','GDP YoY','GDP Growth Rate YoY'],
    ['GBP','PPI Input YoY','PPI Output YoY'],
    ['EUR','Core Inflation Rate YoY Flash','HICP ex Food & Energy YoY Flash'],
    ['AUD','Quarterly Inflation Rate YoY','Inflation Rate YoY'],
  ]) {
    assert.ok(classifyMacroRelease(a,currency),a);
    assert.ok(classifyMacroRelease(b,currency),b);
    assert.notEqual(classifyMacroRelease(a,currency).series,classifyMacroRelease(b,currency).series);
  }
  assert.match(classifyMacroRelease('Core Inflation Rate YoY','USD').family,/^core_/);
  assert.equal(classifyMacroRelease('Quarterly Inflation Rate YoY','AUD').series,'consumer_prices:yoy:quarterly');
  assert.equal(classifyMacroRelease('Unemployment Rate','NZD').cadence,'quarterly');
  assert.equal(classifyMacroRelease('Wage Price Index YoY','AUD').cadence,'quarterly');
  assert.equal(classifyMacroRelease('RBA Weighted Median CPI YoY','AUD').cadence,'quarterly');
  assert.match(classifyMacroRelease('RBA Trimmed Mean CPI YoY','AUD',{indicator:'Trimmed Mean CPI YY SA *'}).series,/:sa$/);
  assert.equal(classifyMacroRelease('Unknown GDP super index','USD'),null);
});

const event = (overrides={}) => ({currency:'USD',country:'US',title:'GDP Growth Rate QoQ Adv',date:'2026-01-29T13:30:00Z',referenceDate:'2025-12-31T00:00:00Z',referencePeriod:'Q4 2025',actualRaw:3.4,forecastRaw:3.0,unit:'%',id:'provider-123',...overrides});
const options = {observedAt:'2026-11-06T00:00:00Z',vintageKind:'historical_snapshot'};

test('normalization preserves raw scale, identity and provenance across calendar adapter', () => {
  const raw = event();
  const row = normalizeMacroRelease(raw,options);
  const cached = normalizeMacroRelease({currency:raw.currency,event:raw.title,date:'2026-01-29',released_at:raw.date,actual_raw:raw.actualRaw,forecast_raw:raw.forecastRaw,source_country:raw.country,source_unit:raw.unit,reference_date:raw.referenceDate,reference_period:raw.referencePeriod,source_event_id:raw.id},options);
  assert.equal(row.id,cached.id);
  assert.equal(row.content_hash,cached.content_hash);
  assert.equal(row.period,'2025-Q4');
  assert.equal(row.source_event_id,'provider-123');
  assert.equal(row.vintage_kind,'historical_snapshot');
  assert.equal(normalizeMacroRelease(event({country:'DE'}),options),null);
  assert.equal(normalizeMacroRelease(event({unit:'USD'}),options),null);
  assert.equal(normalizeMacroRelease(event({date:'2027-01-01T00:00:00Z'}),options),null);
  assert.equal(normalizeMacroRelease(event({actualRaw:null,actual:'3.4%'}),options),null);
  assert.equal(normalizeMacroRelease(event({title:'Initial Jobless Claims',unit:null,actualRaw:194000,forecastRaw:200000,referenceDate:'2026-01-24'}),options).actual,194000);
  assert.equal(normalizeMacroRelease(event({referenceDate:null,referencePeriod:'Q4'}),options).period,'2025-Q4');
});

test('contradictory simultaneous rows are quarantined regardless of input order', () => {
  const a = event(), b = event({actualRaw:99});
  assert.deepEqual(normalizeMacroReleases([a,b],options),[]);
  assert.deepEqual(normalizeMacroReleases([b,a],options),[]);
  assert.equal(normalizeMacroReleases([a,event({title:'GDP Price Index QoQ Adv'})],options).length,1);
});

function memoryRedis() {
  const hashes = new Map(), index = new Map(); let manifest = null;
  const redis = async (command,...args) => {
    if (command==='EVAL') {
      assert.match(args[0],/HSETNX/);
      let inserted=0;
      const data = hashes.get(args[3]) || new Map(), vintages = hashes.get(args[4]) || new Map();
      for(let i=5;i<args.length;i+=4) {
        if(!data.has(args[i])) { data.set(args[i],args[i+1]);index.set(args[i],Number(args[i+2]));inserted++; }
        if(!vintages.has(args[i+3])) vintages.set(args[i+3],args[i+1]);
      }
      hashes.set(args[3],data);hashes.set(args[4],vintages);return inserted;
    }
    if(command==='GET') return manifest;
    if(command==='SET') { assert.equal(args[0],MACRO_HISTORY_MANIFEST_KEY);manifest=args[1];return 'OK'; }
    if(command==='ZRANGEBYSCORE') return [...index].filter(([,time])=>time>=Number(args[1])&&time<=Number(args[2])).map(([id])=>id);
    if(command==='HMGET') return args.slice(1).map(id=>hashes.get(args[0])?.get(id)||null);
    if(command==='ZCARD') return index.size;
    if(command==='HLEN') return hashes.get(args[0])?.size||0;
    throw Error('Unexpected Redis command '+command);
  };
  return {redis,hashes};
}

test('first seen stays immutable; revisions append; repeat ingestion is idempotent', async () => {
  const {redis,hashes} = memoryRedis();
  assert.equal((await persistMacroReleases([event({id:null,country:null})],redis,options)).stored,0,'legacy display cache must not contaminate v2');
  assert.equal((await persistMacroReleases([event()],redis,options)).inserted,1);
  assert.equal((await persistMacroReleases([event()],redis,options)).inserted,0);
  await persistMacroReleases([event({actualRaw:4})],redis,{observedAt:'2026-11-06T00:00:00Z'});
  assert.equal(hashes.get(MACRO_HISTORY_VINTAGES_KEY).size,2);
  assert.deepEqual(await loadMacroReleases(redis),[],'unverified history fails closed');
  const rows = await loadMacroReleases(redis,{fromMs:0,toMs:Date.parse(options.observedAt),requireManifest:false});
  assert.equal(rows.length,1);assert.equal(rows[0].actual,3.4);
});

test('rebuild verifies content before activation and refuses a conflicting reimport', async () => {
  const {prepareSnapshots,publish} = require('../../scripts/rebuild_macro_foundation');
  const {redis} = memoryRedis();
  const prepared = prepareSnapshots([{source:'tradingview',fetched_at:options.observedAt,rows:[event()]}]);
  const manifest = await publish(prepared,redis,Date.parse(options.observedAt));
  assert.equal(manifest.status,'ready');
  assert.equal((await loadMacroReleases(redis,{fromMs:0})).length,1);
  const conflicting = prepareSnapshots([{source:'tradingview',fetched_at:options.observedAt,rows:[event({actualRaw:9})]}]);
  await assert.rejects(()=>publish(conflicting,redis,Date.parse(options.observedAt)),/refusing to overwrite/);
});

test('freshness expires per cadence instead of treating any historical family as fresh', () => {
  const asOf = Date.parse('2026-11-06T00:00:00Z');
  for(const [cadence,maxAge] of [['weekly',21],['monthly',75],['quarterly',150]]) {
    const rows = Array.from({length:14},(_,i)=>({id:String(i),currency:'USD',series:'probe',pillar:'inflation',family:'headline_consumer_prices',cadence,actual:i%2?1:-1,forecast:0,time_ms:asOf-(maxAge+1+13-i)*86400000}));
    const stale = buildMacroPillarScores(rows,{asOfMs:asOf}).currencies.USD.inflation;
    assert.equal(stale.freshness,'stale');assert.equal(stale.ready,false);
    rows[13].time_ms=asOf-(maxAge-1)*86400000;
    assert.equal(buildMacroPillarScores(rows,{asOfMs:asOf}).currencies.USD.inflation.freshness,'fresh');
  }
});
