'use strict';

// Keputusan user: eksperimen shadow dihentikan, histori tidak dihapus.
const SHADOW_ENABLED = false;

function groupHistory(records) {
  const policies = {}, strategies = {}, pairDirections = {}, environments = {};
  for (const record of records || []) {
    if (!record) continue;
    const policy = record.policy_v ?? record.policy_v_est ?? 'unknown';
    const strategy = record.strategy_id || 'legacy';
    (policies[policy] ||= []).push(record);
    (strategies[strategy] ||= []).push(record);
    (pairDirections[`${record.label || record.symbol || 'unknown'} ${record.bias || 'unknown'}`] ||= []).push(record);
    (environments[record.operational_contract?.environment?.environment || 'legacy_unknown'] ||= []).push(record);
  }
  return { policies, strategies, pairDirections, environments };
}

function summary(rows, stats, costNet = null) {
  const dates=rows.map(r=>Number(r.ts)).filter(Number.isFinite);
  const net=costNet || rows.map(r=>r.net_r_estimate).filter(v=>typeof v==='number'&&Number.isFinite(v));
  const managed=rows.map(r=>r.choppy_management?.net_r_estimate).filter(v=>typeof v==='number'&&Number.isFinite(v));
  return { total:stats.total,tp:stats.tp,sl:stats.sl,pending:stats.pending,open:stats.open,canceled:stats.canceled,
    win_rate_raw:stats.win_rate_raw,win_rate_adjusted:stats.win_rate_adjusted,
    from:dates.length?new Date(Math.min(...dates)).toISOString():null,to:dates.length?new Date(Math.max(...dates)).toISOString():null,
    net_r_estimate:net.length?net.reduce((a,b)=>a+b,0):null,net_sample:net.length,
    net_r_without_largest:net.length>1?net.reduce((a,b)=>a+b,0)-Math.max(...net):null,
    managed_net_r_estimate:managed.length?managed.reduce((a,b)=>a+b,0):null,managed_sample:managed.length };
}

module.exports = { SHADOW_ENABLED, groupHistory, summary };
