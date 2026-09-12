const test = require('node:test');
const assert = require('node:assert/strict');
const { windowedCorrelation } = require('../../api/correlations');
test('60 observations exclude older points and align dates before slicing', () => {
  const a = Array.from({length:90}, (_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),close:i+1}));
  const b = a.map((p,i)=>({...p,close:i<30?1000-i:i+1}));
  assert.equal(windowedCorrelation(a,b).r60,1);
  assert.equal(windowedCorrelation(a,b).n60,60);
  assert.deepEqual(windowedCorrelation(a,b),windowedCorrelation([...a].reverse(),[...b,b[89],{date:'2027-01-01',close:NaN}]));
  const small = windowedCorrelation(a,b.slice(-4));
  assert.equal(small.r20,null);assert.equal(small.r60,null);assert.equal(small.n60,4);
});
