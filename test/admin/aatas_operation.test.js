'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _statsPayloadFromLog } = require('../../api/admin');
const { SHADOW_ENABLED } = require('../../api/_aatas_operation');

test('operasional mempertahankan statistik gabungan sekaligus rincian policy', () => {
  const rows = [
    { id: 'a', ts: Date.parse('2026-10-24'), symbol: 'EURUSD=X', policy_v: 63, status: 'tp', risk_reward: 2 },
    { id: 'b', ts: Date.parse('2026-11-07'), symbol: 'EURUSD=X', policy_v: 64, strategy_id: 'momentum', status: 'sl' },
  ];
  const original = JSON.stringify(rows);
  const stats = _statsPayloadFromLog(rows);
  assert.equal(stats.global.tp, 1);
  assert.equal(stats.global.sl, 1);
  assert.equal(stats.by_policy['63'].tp, 1);
  assert.equal(stats.by_policy['64'].sl, 1);
  assert.equal(stats.by_strategy.legacy.tp, 1);
  assert.equal(stats.by_strategy.momentum.sl, 1);
  assert.equal(stats.recent.length, 2);
  assert.equal(stats.stats_from_policy_v, 31);
  assert.equal(JSON.stringify(rows), original);
  assert.equal(SHADOW_ENABLED, false);
});
