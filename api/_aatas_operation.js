'use strict';

// Keputusan user: eksperimen shadow dihentikan, histori tidak dihapus.
const SHADOW_ENABLED = false;

function groupHistory(records) {
  const policies = {}, strategies = {};
  for (const record of records || []) {
    if (!record) continue;
    const policy = record.policy_v ?? record.policy_v_est ?? 'unknown';
    const strategy = record.strategy_id || 'legacy';
    (policies[policy] ||= []).push(record);
    (strategies[strategy] ||= []).push(record);
  }
  return { policies, strategies };
}

module.exports = { SHADOW_ENABLED, groupHistory };
