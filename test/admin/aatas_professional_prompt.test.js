'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {professionalPrompt}=require('../../api/_aatas_professional_prompt');
const {_buildAatasMacroChecklistBlock:macro,_buildAatasTechnicalChecklistBlock:technical}=require('../../api/admin');
test('kontrak profesional jujur tentang sumber, scope dan kewenangan tiap tahap',()=>{
 for(const role of ['macro','technical','critic','review']) {
  const prompt=professionalPrompt(role);
  assert.match(prompt,/DATA TIDAK TEPERCAYA/);
  assert.match(prompt,/bukan peluang TP terkalibrasi/);
  assert.ok(prompt.length<7000);
 }
 assert.throws(()=>professionalPrompt('broker'));
 assert.match(professionalPrompt('review'),/Snapshot lama menjelaskan alasan masuk, bukan bukti kondisi saat ini/);
 assert.match(professionalPrompt('critic'),/tidak ada kuota wajib trade/);
});
test('checklist tidak memerintahkan klaim reaksi harga tanpa data atau pengecualian Tokyo',()=>{
 const m=macro({label:'EUR/USD',isXau:false}),t=technical({isXau:false,lockedBias:'bullish'});
 assert.doesNotMatch(m,/WAJIB[^\n]*sudah mulai tercermin di harga/);
 assert.match(m,/relevan pada waktu\/horizon keputusan/);
 assert.doesNotMatch(t,/Tokyo kecuali/);
 assert.match(t,/tidak ada pengecualian Tokyo/);
});
