'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../../api/_institution_views');
const NOW=Date.parse('2026-11-04T12:00:00Z');
const article=(text='We expect sterling to strengthen next week on resilient rate expectations.')=>({institution:'ING',
  title:'FX Daily: Outlook',url:'https://think.ing.com/articles/outlook/',published_at:'2026-10-30T08:00:00Z',
  content_hash:'abc',extractor_version:m.VERSION,text});
const claim=(more={})=>({currency:'GBP',pair:null,direction:'bullish',layer:'fundamental',conditional:false,
  horizon:'next_week',horizon_quote:'next week',quote:article().text,reason:'Dukungan kebijakan untuk sterling.',...more});
const snapshot=(claims,a=article())=>({...a,claims:m.validateClaims({claims},a)});

test('Institution feed: only dated recent FX Daily on the official host; no macro agenda or future',()=>{
  const row=(title,url,date)=>`<item><title><![CDATA[${title}]]></title><link>${url}</link><dc:date>${date}</dc:date></item>`;
  const xml=row('FX Daily: Outlook',article().url,article().published_at)
    +row('GDP week ahead',article().url,article().published_at)
    +row('FX Daily: Future',article().url,'2026-11-10T08:00:00Z')
    +row('FX Daily: Fake','https://think.ing.com.evil.test/articles/a',article().published_at);
  assert.equal(m.parseFeed(xml,NOW).length,1);
});
test('Institution article: a changed structure/date fails closed instead of reading the footer',()=>{
  const a=article(),date=Date.parse(a.published_at)/1000;
  const html=`<meta content="ING Bank N.V."><h1 data-date-raw="${date}"></h1><div class="content_builder"><p>${a.text.repeat(9)}</p></div>Content Disclaimer`;
  assert.ok(m.parseArticle(html,a).text.includes(a.text));
  assert.throws(()=>m.parseArticle(html.replace('content_builder','other'),a));
  assert.throws(()=>m.parseArticle(html,{...a,published_at:'2026-10-31T08:00:00Z'}));
});
test('Institution extraction: fabricated evidence, subject, missing horizon and malformed shapes are rejected',()=>{
  assert.equal(m.validateClaims({claims:[claim()]},article()).length,1);
  for(const c of [claim({quote:'We expect sterling to weaken next week, invented quote.'}),claim({currency:'NZD'}),
    claim({horizon_quote:'coming week'}),claim({conditional:null})])assert.equal(m.validateClaims({claims:[c]},article()).length,0);
  assert.throws(()=>m.validateClaims({},article()));
});
test('Institution horizon cannot be borrowed from an unrelated event calendar',()=>{
  const text='We expect sterling to strengthen. Next week the US will release CPI.';
  assert.equal(m.validateClaims({claims:[claim({quote:'We expect sterling to strengthen.',horizon_quote:'Next week'})]},article(text)).length,0);
});
test('Institution weekly direction has an actual validity window and never survives expiry',()=>{
  const s=snapshot([claim()]);
  assert.equal(m.buildInstitutionColumn('GBP',[s],NOW).state,'bullish');
  assert.equal(m.buildInstitutionColumn('GBP',[s],Date.parse('2026-11-07T00:00:00Z')).state,'bullish');
  assert.equal(m.buildInstitutionColumn('GBP',[s],Date.parse('2026-11-09T00:00:00Z')).state,'insufficient');
  assert.equal(m.buildInstitutionColumn('GBP',[s],Date.parse('2026-10-31T12:00:00Z')).state,'insufficient');
});
test('Institution pair views stay relative; cannot masquerade as currency-wide weekly votes',()=>{
  const a=article('We expect EUR/GBP to fall next week as sterling benefits from policy divergence.');
  const c=claim({currency:'EUR',direction:'bearish',pair:'EUR/GBP',quote:a.text});
  const s=snapshot([c],a),col=m.buildInstitutionColumn('GBP',[s],NOW);
  assert.equal(col.state,'insufficient');assert.equal(col.context.length,0);
  assert.equal(col.relative_views[0].against,'EUR');assert.equal(col.relative_views[0].state,'bullish');
  assert.equal(col.eligible_for_overall,false);
  assert.equal(m.buildInstitutionColumn('EUR',[s],NOW).relative_views[0].state,'bearish');
  assert.equal(m.validateClaims({claims:[{...c,pair:null}]},a).length,0);
  assert.equal(m.buildInstitutionColumn('USD',[s],NOW).context.length,0);
});
test('Institution nonweekly, technical and conditional views are excluded from weekly results',()=>{
  for(const c of [claim({horizon:'near_term',horizon_quote:''}),claim({layer:'technical'}),claim({conditional:true})]){
    const col=m.buildInstitutionColumn('GBP',[snapshot([c])],NOW);
    assert.equal(col.state,'insufficient');assert.equal(col.context.length,0);assert.equal(col.eligible_for_overall,false);
  }
});
test('Institution one bank remains one vote; internal contradictions remain explicit',()=>{
  const s=snapshot([claim(),claim()]);
  assert.equal(m.buildInstitutionColumn('GBP',[s,s],NOW).institution_count,1);
  const a=article(article().text+' We expect sterling to weaken next week on weaker growth.');
  const conflicting=snapshot([claim(),claim({direction:'bearish',quote:'We expect sterling to weaken next week on weaker growth.'})],a);
  assert.equal(m.buildInstitutionColumn('GBP',[conflicting],NOW).state,'mixed');
});
test('Institution newer report with no view does not erase an unexpired currency outlook',()=>{
  const old=snapshot([claim()]);
  const newer=snapshot([],{...article(),published_at:'2026-11-03T08:00:00Z'});
  assert.equal(m.buildInstitutionColumn('GBP',[old,newer],NOW).state,'bullish');
});
test('Institution malformed, future, stale and wrong-origin stored records do not supply votes',()=>{
  const s=snapshot([claim()]);
  for(const bad of [{...s,extractor_version:'bad'},{...s,url:'https://evil.test/articles/a'},
    {...s,claims:[null,{...s.claims[0],conditional:undefined},{...s.claims[0],pair:undefined}]},
    {...s,published_at:'2026-11-10T08:00:00Z'},{...s,published_at:'2026-01-01T08:00:00Z'},null]){
    assert.equal(m.buildInstitutionColumn('GBP',[bad],NOW).state,'insufficient');
  }
});
test('Institution opinions cannot reverse a consistent fundamental core',()=>{
  const {buildOverall}=require('../../api/_smart_bias');
  const bullish={state:'bullish',evidence:[],confidence:null};
  const banks={...bullish,state:'bearish'};
  assert.equal(buildOverall({growth:bullish,inflation:{...bullish,inflation_impulse:'bullish'},central_bank:bullish,banks,positioning:{state:'insufficient'}}).state,'bullish');
});
