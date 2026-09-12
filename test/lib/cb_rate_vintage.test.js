const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeCbRate,CB_FALLBACK}=require('../../api/_cb_rates');
const dec={rate:2.75,last_meeting:'2026-09-02',last_bps:25,last_decision:'hike'};
test('fresh fetch of an old observation cannot undo a newer central bank decision',()=>{
 for(const live of [{rate:2.5,date:'2026-08-31'},{rate:2.5},undefined]){
  const r=mergeCbRate('NZD',CB_FALLBACK.NZD,live,dec,'live_cached');
  assert.equal(r.rate,2.75);assert.equal(r.rate_as_of,'2026-09-02');assert.equal(r.rate_source,'decision');
 }
});
test('newer observation wins, invalid or undated decision cannot overwrite it',()=>{
 const live={rate:3,date:'2026-10-10'};
 for(const d of [dec,{...dec,rate:null},{...dec,last_meeting:null}]){
  const r=mergeCbRate('NZD',CB_FALLBACK.NZD,live,d,'live_cached');
  assert.equal(r.rate,3);assert.equal(r.rate_as_of,'2026-10-10');
 }
});

test('invalid live values cannot label fallback as a live observation',()=>{
 const r=mergeCbRate('NZD',CB_FALLBACK.NZD,{rate:NaN,date:'2026-09-10'},undefined,'live_cached');
 assert.equal(r.rate,CB_FALLBACK.NZD.rate);assert.equal(r.rate_source,'fallback');assert.equal(r.rate_as_of,null);
});
