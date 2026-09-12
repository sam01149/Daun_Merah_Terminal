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
