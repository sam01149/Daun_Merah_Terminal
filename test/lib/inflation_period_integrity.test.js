const test = require('node:test');
const assert = require('node:assert/strict');
const {parseFundamentalFromHeadline, extractFundamentalFromCalendarEvent, autoUpdateFundamentalsFromCalendar} = require('../../api/_fundamental_parser');

test('inflation period and variant stay distinct in both source parsers', () => {
  for (const [title,key] of [
    ['Inflation Rate MoM','CPI MoM'], ['Inflation Rate YoY','CPI YoY'],
    ['Trimmed Mean CPI MoM','CPI Trimmed Mean MoM'],
    ['Trimmed Mean CPI YoY','CPI Trimmed Mean YoY'],
    ['Weighted Median CPI QoQ','CPI Weighted Median QoQ'],
    ['Core Inflation Rate YoY','Core CPI YoY'],
  ]) {
    assert.equal(extractFundamentalFromCalendarEvent({currency:'AUD',event:title,actual:'1%',date:'2026-08-26'}).key,key);
    assert.equal(parseFundamentalFromHeadline(`Australia ${title} Actual 1% Previous -0.1%`).key,key);
  }
  assert.equal(parseFundamentalFromHeadline('German CPI MoM Actual 0.2%').key,'German CPI MoM');
  assert.equal(parseFundamentalFromHeadline('German HICP MoM Actual 0.2% Previous 0.1%').key,'German CPI MoM');
  assert.equal(parseFundamentalFromHeadline('French CPI MoM Actual 0.2%'),null);
});

test('annual, monthly and trimmed releases cannot overwrite each other in either arrival order', async () => {
  const events=[['Inflation Rate YoY','3.5%'],['Inflation Rate MoM','1%'],['Trimmed Mean CPI MoM','0.5%']]
    .map(([event,actual])=>({currency:'AUD',event,actual,date:'2026-08-26'}));
  for (const batch of [events,[...events].reverse()]) {
    const hash={};
    await autoUpdateFundamentalsFromCalendar(batch,async(cmd,key,...args)=>{
      if(cmd==='HMGET')return args.map(k=>hash[k]||null);
      if(cmd==='HSET')for(let i=0;i<args.length;i+=2)hash[args[i]]=args[i+1];
    });
    assert.equal(JSON.parse(hash['CPI YoY']).actual,'3.5%');
    assert.equal(JSON.parse(hash['CPI MoM']).actual,'1%');
    assert.equal(JSON.parse(hash['CPI Trimmed Mean MoM']).actual,'0.5%');
  }
});
