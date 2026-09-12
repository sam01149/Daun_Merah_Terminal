const test = require('node:test');
const assert = require('node:assert/strict');
const {finiteDecimal,normalizeJournalNumbers,sanitizeSizing}=require('../../api/_data_values');
const {_sanitizeChecklistSnapshot}=require('../../api/journal');
test('malformed values cannot become valid trade metrics',()=>{
 for(const x of ['12abc','',true,[],{},'Infinity',NaN,'0x10']) assert.equal(finiteDecimal(x),null);
 assert.equal(finiteDecimal(' -1.25 '),-1.25);
 assert.equal(normalizeJournalNumbers({r_actual:-2},['r_actual']),null);
 assert.equal(normalizeJournalNumbers({exit_price:'12abc'},['exit_price']),'exit_price');
 assert.equal(normalizeJournalNumbers({mt5_ticket:1.5},['mt5_ticket']),'mt5_ticket');
 assert.deepEqual(_sanitizeChecklistSnapshot({a:'false',b:false,c:true,d:1}),{b:false,c:true});
});
test('sizing accepts calculator payload, rejects incoherent derived risk',()=>{
 const e={pair:'EUR/USD',riskPct:1,lotSize:0.1,equity:1000,stopPips:10,dollarRisk:10};
 assert.deepEqual(sanitizeSizing(e),e);
 assert.equal(sanitizeSizing({...e,dollarRisk:100}),null);
 assert.equal(sanitizeSizing({...e,lotSize:'1abc'}),null);
 assert.equal(sanitizeSizing({}),null);
});

test('archive updates existing outcomes, deduplicates batch and reports capped total',()=>{
 const {mergeSetupArchive}=require('../../api/_data_values');
 const r=mergeSetupArchive([{id:1,status:'open',ts:1},{id:2,ts:2}],[{id:'1',status:'tp',ts:1},{id:3,ts:3},{id:3,ts:3}],2);
 assert.equal(r.added,1);assert.equal(r.updated,1);assert.equal(r.entries.length,2);
 assert.equal(mergeSetupArchive([{id:1,status:'open'}],[{id:1,status:'sl'}]).entries[0].status,'sl');
});

test('refine refreshes current snapshot while preserving original provenance',()=>{
 const {snapshotRevision}=require('../../api/_data_values');
 const initial={macro_snapshot:{rate:2.5},macro_snapshot_at:1};
 const revised=snapshotRevision({rate:2.75},2,initial);
 assert.equal(revised.macro_snapshot.rate,2.75);assert.equal(revised.macro_snapshot_origin.rate,2.5);
 const again=snapshotRevision(null,3,revised);
 assert.equal(again.macro_snapshot,null);assert.equal(again.macro_snapshot_origin.rate,2.5);assert.equal(again.macro_snapshot_origin_at,1);
 assert.equal(initial.macro_snapshot.rate,2.5);
});
