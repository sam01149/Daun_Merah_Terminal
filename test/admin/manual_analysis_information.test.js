'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measureScenario } = require('../../api/_manual_analysis');

test('perhitungan skenario memberi RR di bawah 1:2 dari sisi konservatif zona', () => {
  const entry_zone = '100-102';
  const bullish = measureScenario({ bias: 'bullish', entry_zone, sl: 97, tp: 109 });
  const bearish = measureScenario({ bias: 'bearish', entry_zone, sl: 105, tp: 93 });

  assert.equal(bullish.rr, 1.4);
  assert.equal(bearish.rr, 1.4);
});

test('perhitungan skenario tidak menghasilkan RR dari arah atau level yang tidak valid', () => {
  const valid = { bias: 'bullish', entry_zone: '100-102', sl: 97, tp: 109 };
  for (const invalid of [{ bias: 'neutral' }, { sl: 100 }, { tp: 'tidak tersedia' }, { tp: 98 }]) {
    const result = measureScenario({ ...valid, ...invalid });
    assert.equal(result.rr, undefined);
    assert.ok(result.reason);
  }
});
