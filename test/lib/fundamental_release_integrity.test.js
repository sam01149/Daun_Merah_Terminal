const test=require('node:test');
const assert=require('node:assert/strict');
const {autoUpdateFundamentalsFromCalendar,autoUpdateFundamentals}=require('../../api/_fundamental_parser');
function redis(initial){let row=JSON.stringify(initial);return {cmd:async(cmd,key,...args)=>{if(cmd==='HMGET')return [row];if(cmd==='HSET')row=args[1];return null;},read:()=>JSON.parse(row)};}
test('new release cannot inherit an old forecast or previous; same release revision can',async()=>{
 for(const date of ['2026-09-11','2026-08-11']){
  const r=redis({date:'2026-08-11',actual:'2%',forecast:'2.1%',previous:'1.9%'});
  await autoUpdateFundamentalsFromCalendar([{currency:'USD',event:'CPI YoY',actual:'3%',date}],r.cmd);
  assert.equal(r.read().forecast,date==='2026-08-11'?'2.1%':undefined);
  assert.equal(r.read().previous,date==='2026-08-11'?'1.9%':undefined);
 }
});
test('headline new value drops old consensus and preserves an explicit unchanged previous',async()=>{
 const r=redis({date:'2026-08-11',actual:'2%',forecast:'2.1%',previous:'1.9%'});
 await autoUpdateFundamentals([{title:'US CPI YoY Actual 3% Previous 3%'}],r.cmd);
 assert.equal(r.read().forecast,undefined);
 assert.equal(r.read().previous,'3%');
});
