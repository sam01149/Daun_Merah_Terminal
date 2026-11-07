'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const abn=require('../../api/_abn_research'),m=require('../../api/_institution_views');
const NOW=Date.parse('2026-11-04T12:00:00Z'),published='2026-10-30T08:00:00Z';
const url='https://www.abnamro.com/research/en/our-research/fx-weekly-outlook';
const text='We expect sterling to strengthen next week on resilient monetary policy expectations.';
function html(){const data=[{mainText:1,enSlug:2,publicationDate:3,title:4,introduction:5},[], 'fx-weekly-outlook',Date.parse(published),'FX Weekly - Outlook',text];
  return `<h1>FX Weekly - Outlook</h1><script id="__NUXT_DATA__">${JSON.stringify(data)}</script><div data-component-type="rich-text">${text.repeat(4)}</div><div data-component-type="rich-text">${text.repeat(4)}</div>ABN AMRO Bank N.V.`;}
test('ABN discovery stays on the official weekly research path',()=>{
  const h='<a href="/research/en/our-research/fx-weekly-outlook">weekly</a><a href="https://evil.test/">fake</a>';
  assert.deepEqual(abn.discover(h),[url]);assert.equal(abn.safeUrl(url.replace('abnamro.com','abnamro.com.evil.test')),null);
});
test('ABN article requires matching structured/rendered identity, exact slug, valid recent publication and bounded body',()=>{
  const plain=s=>s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const a=abn.parseArticle(html(),url,plain,NOW);assert.equal(a.institution,'ABN AMRO');assert.equal(a.published_at,published.replace('Z','.000Z'));
  for(const h of [html().replace('<h1>FX Weekly - Outlook','<h1>Other'),html().replace('ABN AMRO Bank N.V.','other'),html().replace(String(Date.parse(published)),'9999999999999')]){
    if(h!==html())assert.throws(()=>abn.parseArticle(h,url,plain,NOW));
  }
  assert.throws(()=>abn.parseArticle(html(),url+'-wrong',plain,NOW));
  assert.throws(()=>abn.parseArticle(html(),url,plain,Date.parse('2026-10-20')));
});
test('Multiple banks vote independently; duplicates stay one vote, conflicts mixed, fake bank/origin rejected',()=>{
  const make=(institution,direction='bullish')=>{const a={institution,url:institution==='ING'?'https://think.ing.com/articles/outlook/':url,published_at:published,content_hash:institution,extractor_version:m.VERSION,text};
    return {...a,claims:m.validateClaims({claims:[{currency:'GBP',pair:null,direction,layer:'fundamental',conditional:false,horizon:'next_week',horizon_quote:'next week',quote:text,reason:'Dukungan suku bunga.'}]},a)};};
  const a=make('ING'),b=make('ABN AMRO');assert.equal(m.buildInstitutionColumn('GBP',[a,b,b],NOW).institution_count,2);
  assert.equal(m.buildInstitutionColumn('GBP',[a,make('ABN AMRO','bearish')],NOW).state,'mixed');
  assert.equal(m.buildInstitutionColumn('GBP',[{...b,url:a.url}],NOW).institution_count,0);
  assert.equal(m.buildInstitutionColumn('GBP',[{...b,institution:'Unknown'}],NOW).institution_count,0);
  assert.equal(m.buildInstitutionColumn('GBP',[a,b],Date.parse('2026-11-07')).state,'insufficient');
});
