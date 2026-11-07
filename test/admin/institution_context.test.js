'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const m=require('../../api/_institution_views');
const {sectionsFromHtml}=require('../../api/_institution_sections');
const NOW=Date.parse('2026-11-07T03:00:00Z');
const a=(text,sections=[])=>({institution:'ING',title:'FX Daily: Outlook',url:'https://think.ing.com/articles/outlook/',
  published_at:'2026-11-02T08:00:00Z',text,sections,content_hash:'actual-test',extractor_version:m.VERSION});
const c=more=>({currency:'USD',pair:null,direction:'neutral',layer:'fundamental',conditional:false,horizon:'this_week',
  section_id:'s0',horizon_quote:'US macro debate this week will',quote:'Expect DXY to continue trading around 102.00',reason:'Dolar diperkirakan bertahan.',...more});
function accepted(article,claim=c({})){return {...article,claims:m.validateClaims({claims:[claim]},article)};}

test('Real ING 2 Nov excerpt: a weekly horizon and FX view in different paragraphs of its USD section qualify',()=>{
  // Exact short excerpts from the USD section; not a fabricated historical AI extraction.
  // https://think.ing.com/articles/fx-daily-dollar-holds-gains-into-midterms/
  const time='US macro debate this week will',quote='Expect DXY to continue trading around 102.00';
  const article=a(time+' '+quote,[{id:'s0',title:'USD: Contemplating the midterms',text:time+' '+quote}]);
  const s=accepted(article);assert.equal(s.claims.length,1);assert.equal(s.claims[0].time_basis,'section');
  assert.equal(m.buildInstitutionColumn('USD',[s],NOW).state,'neutral');
  assert.equal(m.buildInstitutionColumn('USD',[s],Date.parse('2026-11-09T00:00:00Z')).state,'insufficient');
});
test('Heading boundaries prevent horizon borrowing from unrelated currencies or an event calendar',()=>{
  const q=c({}).quote,time='US macro debate this week will';
  const article=a(q+' '+time,[{id:'s0',title:'USD: Outlook',text:q},{id:'s1',title:'Calendar',text:time}]);
  assert.equal(accepted(article).claims.length,0);
  assert.equal(accepted(article,c({section_id:'s1'})).claims.length,0);
  const unrelated=a(q+' The UK budget will be released next week.',[{id:'s0',title:'GBP: Outlook',text:q+' The UK budget will be released next week.'}]);
  assert.equal(accepted(unrelated,c({horizon:'next_week',horizon_quote:'The UK budget will be released next week.'})).claims.length,0);
});
test('A retrospective weekly move, weekly title, daily target or year-end forecast does not become a weekly view',()=>{
  const q=c({}).quote;
  for(const time of ['The dollar rose this week.','USD weakened this week.']){
    const article=a(time+' '+q,[{id:'s0',title:'USD: Outlook',text:time+' '+q}]);
    assert.equal(accepted(article,c({horizon_quote:time})).claims.length,0);
  }
  const time='The USD outlook this week will depend on growth.';
  for(const quote of ['We expect the dollar to strengthen today.','We expect the dollar to strengthen into year-end.','The dollar rose strongly this week.']){
    const article=a(time+' '+quote,[{id:'s0',title:'USD',text:time+' '+quote}]);
    assert.equal(accepted(article,c({quote,horizon_quote:time})).claims.length,0);
  }
  assert.equal(accepted({...a(q),title:'FX Weekly'},c({horizon_quote:'this week'})).claims.length,0);
  const dailyContext='US job indices this week have been strong and we expect a solid release today.';
  assert.equal(accepted(a(dailyContext+' '+q,[{id:'s0',title:'USD',text:dailyContext+' '+q}]),c({horizon_quote:dailyContext})).claims.length,0);
});
test('Section parser preserves headings and paragraph scope instead of flattening separate outlooks',()=>{
  const plain=s=>s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const sections=sectionsFromHtml('<h2>USD: Outlook</h2><p>Weekly agenda.</p><p>FX view.</p><h2>EUR: Outlook</h2><p>Other view.</p>',plain);
  assert.deepEqual(sections,[{id:'s0',title:'USD: Outlook',text:'Weekly agenda. FX view.'},{id:'s1',title:'EUR: Outlook',text:'Other view.'}]);
});
test('A newer relevant weekly view replaces an older view per currency, without another currency wiping it',()=>{
  const oldText='We expect the dollar to strengthen this week on resilient growth.';
  const old=accepted(a(oldText),c({direction:'bullish',quote:oldText,horizon_quote:'this week'}));
  const newText='We expect the dollar to weaken this week on softer inflation.';
  const newer=accepted({...a(newText),published_at:'2026-11-05T08:00:00Z'},c({direction:'bearish',quote:newText,horizon_quote:'this week'}));
  assert.equal(m.buildInstitutionColumn('USD',[old,newer],NOW).state,'bearish');
  const euro='We expect the euro to strengthen this week.';
  const other=accepted({...a(euro),published_at:'2026-11-06T08:00:00Z'},c({currency:'EUR',direction:'bullish',quote:euro,horizon_quote:'this week'}));
  assert.equal(m.buildInstitutionColumn('USD',[old,other],NOW).state,'bullish');
});
test('Pair directions are relative, invert the quote leg, combine banks once, and never vote on broad bias',()=>{
  const text='We expect EUR/USD to strengthen this week on policy divergence.';
  const ing=accepted(a(text),c({currency:'EUR',pair:'EUR/USD',direction:'bullish',quote:text,horizon_quote:'this week'}));
  const opposite=text.replace('strengthen','weaken');
  const abnArticle={...a(opposite),institution:'ABN AMRO',url:'https://www.abnamro.com/research/en/our-research/fx-weekly-outlook'};
  const abn=accepted(abnArticle,c({currency:'EUR',pair:'EUR/USD',direction:'bearish',quote:opposite,horizon_quote:'this week'}));
  const eur=m.buildInstitutionColumn('EUR',[ing,ing],NOW),usd=m.buildInstitutionColumn('USD',[ing],NOW);
  assert.equal(eur.state,'insufficient');assert.equal(eur.relative_views[0].state,'bullish');assert.equal(eur.relative_views[0].institution_count,1);
  assert.equal(usd.relative_views[0].state,'bearish');assert.equal(usd.relative_views[0].against,'EUR');assert.equal(usd.eligible_for_overall,false);
  assert.equal(m.buildInstitutionColumn('EUR',[ing,abn],NOW).relative_views[0].state,'mixed');
  assert.equal(m.buildInstitutionColumn('GBP',[ing],NOW).relative_views.length,0);
  assert.equal(accepted(a(text),c({currency:'USD',pair:'EUR/USD',quote:text,horizon_quote:'this week'})).claims.length,0);
});
test('Conditional language remains guarded even if extraction labels it as the base case',()=>{
  const text='We expect the dollar to strengthen this week if inflation is high.';
  const s=accepted(a(text),c({direction:'bullish',quote:text,horizon_quote:'this week'}));
  assert.equal(m.buildInstitutionColumn('USD',[s],NOW).state,'insufficient');
});
test('Batch extraction validates every article ID and binds quotes to their original article',()=>{
  const one=a('We expect the dollar to strengthen this week.'),two=a('We expect the euro to weaken this week.');
  const prompt=m.extractionBatchPrompt([one,two]);assert.match(prompt[0].content,/article_id/);
  assert.equal(JSON.parse(prompt[1].content).articles.length,2);
  const result={reports:[{article_id:'r0',claims:[]},{article_id:'r1',claims:[]}]};
  assert.equal(m.validateBatch(result,[one,two]).length,2);
  for(const bad of [{claims:[]},{reports:[result.reports[0]]},{reports:[result.reports[0],result.reports[0]]}])assert.throws(()=>m.validateBatch(bad,[one,two]));
  const wrong={reports:[{article_id:'r0',claims:[c({currency:'EUR',quote:two.text,horizon_quote:'this week'})]},result.reports[1]]};
  assert.equal(m.validateBatch(wrong,[one,two])[0].claims.length,0);
});
