#!/usr/bin/env node
// PLAN AE-2/3: evaluator offline untuk provenance, reasoning fixture, dan ukuran
// snapshot. Tidak memanggil model/provider dan tidak menyentuh Redis/produksi.
const fs = require('node:fs');
const {
  normalizeEvidenceRecord, validateEvidenceRecord, evidenceCoverage,
  buildDecisionEnvelope, stableHash,
} = require('../api/_aatas_evidence');

const AS_OF = '2026-10-12T12:00:00Z';

function ev(id, family, overrides = {}) {
  return normalizeEvidenceRecord({
    evidence_id: id,
    source_id: `source-${id}`,
    source_type: 'official_release',
    source_published_at: '2026-10-12T10:00:00Z',
    available_at: '2026-10-12T10:00:01Z',
    observed_at: '2026-10-12T10:01:00Z',
    event_id: family,
    family_id: family,
    currency: 'USD',
    category: 'macro',
    claim_type: 'fact',
    relation: 'supports',
    text: id,
    ...overrides,
  });
}

function fixture(id, category, evidence, expected, reference, trap) {
  return { id, category, decision_as_of: AS_OF, evidence, expected, reference_response: reference, trap_response: trap };
}

const FIXTURES = [
  fixture('fact-expectation-valid', 'fact_vs_expectation', [
    ev('actual-cpi', 'cpi', { value: 3.1, unit: '% YoY' }),
    ev('forecast-cpi', 'forecast', { claim_type: 'expectation', value: 3.0, unit: '% YoY' }),
  ], { status: 'valid', direction: 'bullish', must_use: ['actual-cpi', 'forecast-cpi'], required_kinds: ['fact', 'expectation'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['actual-cpi', 'forecast-cpi'], claims: [{ kind: 'fact', evidence_ids: ['actual-cpi'] }, { kind: 'expectation', evidence_ids: ['forecast-cpi'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['forecast-cpi'], claims: [{ kind: 'fact', evidence_ids: ['forecast-cpi'] }] }),
  fixture('fact-expectation-adversarial', 'fact_vs_expectation', [
    ev('rate-expectation', 'rates', { claim_type: 'expectation', text: 'pasar memperkirakan pemotongan' }),
  ], { status: 'unknown', direction: null, require_unknown_reason: true, forbidden_directions: ['bullish', 'bearish'] },
  { status: 'unknown', direction: null, unknown_reason: 'Tidak ada keputusan bank sentral aktual.', used_evidence_ids: ['rate-expectation'], claims: [{ kind: 'expectation', evidence_ids: ['rate-expectation'] }] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: ['rate-expectation'], claims: [{ kind: 'fact', evidence_ids: ['rate-expectation'] }] }),

  fixture('unit-period-valid', 'unit_period', [ev('headline-yoy', 'cpi-yoy', { value: 3.1, unit: '% YoY', period: '2026-09' })],
  { status: 'valid', must_use: ['headline-yoy'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['headline-yoy'], claims: [{ kind: 'fact', evidence_ids: ['headline-yoy'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: [], claims: [{ kind: 'fact', evidence_ids: [] }] }),
  fixture('unit-period-adversarial', 'unit_period', [
    ev('mom-cpi', 'cpi-mom', { value: 0.2, unit: '% MoM', period: '2026-09' }),
    ev('yoy-cpi', 'cpi-yoy', { value: 3.1, unit: '% YoY', period: '2026-09' }),
  ], { status: 'unknown', direction: null, must_use: ['mom-cpi', 'yoy-cpi'], require_unknown_reason: true },
  { status: 'unknown', direction: null, unknown_reason: 'MoM dan YoY berbeda horizon; arah tidak dipaksakan.', used_evidence_ids: ['mom-cpi', 'yoy-cpi'], claims: [{ kind: 'fact', evidence_ids: ['mom-cpi', 'yoy-cpi'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['mom-cpi'], claims: [{ kind: 'fact', evidence_ids: ['mom-cpi'] }] }),

  fixture('base-quote-valid', 'base_quote', [ev('eur-strong', 'eur-data', { currency: 'EUR' }), ev('usd-weak', 'usd-data', { currency: 'USD' })],
  { status: 'valid', direction: 'bullish', must_use: ['eur-strong', 'usd-weak'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['eur-strong', 'usd-weak'], claims: [{ kind: 'interpretation', evidence_ids: ['eur-strong', 'usd-weak'] }] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: ['eur-strong', 'usd-weak'], claims: [{ kind: 'interpretation', evidence_ids: ['eur-strong', 'usd-weak'] }] }),
  fixture('base-quote-adversarial', 'base_quote', [ev('jpy-strong', 'jpy-data', { currency: 'JPY' })],
  { status: 'valid', direction: 'bearish', must_use: ['jpy-strong'] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: ['jpy-strong'], claims: [{ kind: 'interpretation', evidence_ids: ['jpy-strong'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['jpy-strong'], claims: [{ kind: 'interpretation', evidence_ids: ['jpy-strong'] }] }),

  fixture('stale-source-valid', 'stale_source', [ev('fresh-pmi', 'pmi', { available_at: '2026-10-12T11:00:00Z' })],
  { status: 'valid', must_use: ['fresh-pmi'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['fresh-pmi'], claims: [{ kind: 'fact', evidence_ids: ['fresh-pmi'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: [], claims: [{ kind: 'fact', evidence_ids: [] }] }),
  fixture('stale-source-adversarial', 'stale_source', [ev('future-release', 'future', { available_at: '2026-10-12T13:00:00Z' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, must_not_use: ['future-release'] },
  { status: 'unknown', direction: null, unknown_reason: 'Rilis belum tersedia pada cutoff.', used_evidence_ids: [], claims: [] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['future-release'], claims: [{ kind: 'fact', evidence_ids: ['future-release'] }] }),

  fixture('duplicate-family-valid', 'duplicate_family', [ev('cpi-wire-a', 'same-cpi'), ev('cpi-wire-b', 'same-cpi')],
  { status: 'valid', max_independent_families: 1 },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['cpi-wire-a', 'cpi-wire-b'], independent_evidence_ids: ['cpi-wire-a'], claims: [{ kind: 'fact', evidence_ids: ['cpi-wire-a', 'cpi-wire-b'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['cpi-wire-a', 'cpi-wire-b'], independent_evidence_ids: ['cpi-wire-a', 'cpi-wire-b'], claims: [{ kind: 'fact', evidence_ids: ['cpi-wire-a', 'cpi-wire-b'] }] }),
  fixture('duplicate-family-adversarial', 'duplicate_family', [ev('same-a', 'same-event'), ev('same-b', 'same-event'), ev('independent-cb', 'cb-event')],
  { status: 'valid', max_independent_families: 2, must_use: ['independent-cb'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['same-a', 'same-b', 'independent-cb'], independent_evidence_ids: ['same-a', 'independent-cb'], claims: [{ kind: 'fact', evidence_ids: ['same-a', 'same-b', 'independent-cb'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['same-a', 'same-b'], independent_evidence_ids: ['same-a', 'same-b'], claims: [{ kind: 'fact', evidence_ids: ['same-a', 'same-b'] }] }),

  fixture('counter-evidence-valid', 'counter_evidence', [ev('support', 'growth'), ev('oppose', 'inflation', { relation: 'opposes' })],
  { status: 'valid', must_use: ['support'], require_counter_evidence: ['oppose'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['support', 'oppose'], claims: [{ kind: 'interpretation', evidence_ids: ['support', 'oppose'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['support'], claims: [{ kind: 'interpretation', evidence_ids: ['support'] }] }),
  fixture('counter-evidence-adversarial', 'counter_evidence', [ev('only-oppose', 'risk', { relation: 'opposes' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, require_counter_evidence: ['only-oppose'] },
  { status: 'unknown', direction: null, unknown_reason: 'Hanya bukti yang melawan tersedia.', used_evidence_ids: ['only-oppose'], claims: [{ kind: 'fact', evidence_ids: ['only-oppose'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: [], claims: [] }),

  fixture('horizon-valid', 'horizon_mismatch', [ev('weekly-bias', 'weekly', { horizon: '1 week' }), ev('intraday-event', 'intraday', { horizon: '6 hours' })],
  { status: 'wait', direction: 'bullish', must_use: ['weekly-bias', 'intraday-event'] },
  { status: 'wait', direction: 'bullish', used_evidence_ids: ['weekly-bias', 'intraday-event'], claims: [{ kind: 'scenario', evidence_ids: ['weekly-bias', 'intraday-event'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['weekly-bias'], claims: [{ kind: 'fact', evidence_ids: ['weekly-bias'] }] }),
  fixture('horizon-adversarial', 'horizon_mismatch', [ev('monthly-cot', 'cot', { horizon: 'weekly', source_type: 'positioning' })],
  { status: 'unknown', direction: null, require_unknown_reason: true },
  { status: 'unknown', direction: null, unknown_reason: 'Positioning mingguan tidak menentukan entry intraday.', used_evidence_ids: ['monthly-cot'], claims: [{ kind: 'interpretation', evidence_ids: ['monthly-cot'] }] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: ['monthly-cot'], claims: [{ kind: 'fact', evidence_ids: ['monthly-cot'] }] }),

  fixture('missing-data-valid', 'missing_data', [],
  { status: 'unknown', direction: null, require_unknown_reason: true },
  { status: 'unknown', direction: null, unknown_reason: 'Tidak ada bukti yang tersedia.', used_evidence_ids: [], claims: [] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: [], claims: [] }),
  fixture('missing-data-adversarial', 'missing_data', [ev('one-leg', 'aud', { currency: 'AUD' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, must_use: ['one-leg'] },
  { status: 'unknown', direction: null, unknown_reason: 'Data kaki NZD tidak tersedia.', used_evidence_ids: ['one-leg'], claims: [{ kind: 'fact', evidence_ids: ['one-leg'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['one-leg'], claims: [{ kind: 'interpretation', evidence_ids: ['one-leg'] }] }),

  fixture('reaction-valid', 'reaction_causation', [ev('release', 'nfp'), ev('price-reaction', 'price', { claim_type: 'reaction', source_type: 'price' })],
  { status: 'valid', must_use: ['release', 'price-reaction'], forbid_causal_language: true },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['release', 'price-reaction'], claims: [{ kind: 'reaction', evidence_ids: ['release', 'price-reaction'], text: 'Respons konsisten dengan prediksi, sebab tunggal tidak diketahui.' }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['price-reaction'], claims: [{ kind: 'reaction', evidence_ids: ['price-reaction'], text: 'NFP pasti menyebabkan kenaikan.' }] }),
  fixture('reaction-adversarial', 'reaction_causation', [ev('price-only', 'price', { claim_type: 'reaction', source_type: 'price' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, forbid_causal_language: true },
  { status: 'unknown', direction: null, unknown_reason: 'Event penyebab tidak dapat diisolasi.', used_evidence_ids: ['price-only'], claims: [{ kind: 'reaction', evidence_ids: ['price-only'], text: 'Harga bergerak; atribusi sebab tidak diketahui.' }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['price-only'], claims: [{ kind: 'reaction', evidence_ids: ['price-only'], text: 'Kenaikan pasti disebabkan CPI.' }] }),

  fixture('cutoff-valid', 'cutoff_revision', [ev('initial', 'payroll', { vintage: 'initial' })],
  { status: 'valid', must_use: ['initial'] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['initial'], claims: [{ kind: 'fact', evidence_ids: ['initial'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: [], claims: [{ kind: 'fact', evidence_ids: [] }] }),
  fixture('cutoff-adversarial', 'cutoff_revision', [ev('revision-future', 'payroll-revision', { vintage: 'revision', available_at: '2026-10-13T10:00:00Z' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, must_not_use: ['revision-future'] },
  { status: 'unknown', direction: null, unknown_reason: 'Revisi belum tersedia pada cutoff.', used_evidence_ids: [], claims: [] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: ['revision-future'], claims: [{ kind: 'fact', evidence_ids: ['revision-future'] }] }),

  fixture('plan-outcome-valid', 'plan_vs_outcome', [ev('pre-plan', 'plan', { claim_type: 'scenario' })],
  { status: 'valid', must_use: ['pre-plan'], forbid_outcome_language: true },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['pre-plan'], claims: [{ kind: 'scenario', evidence_ids: ['pre-plan'], text: 'Rencana sebelum outcome.' }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['pre-plan'], claims: [{ kind: 'interpretation', evidence_ids: ['pre-plan'], text: 'Rencana benar karena akhirnya TP.' }] }),
  fixture('plan-outcome-adversarial', 'plan_vs_outcome', [ev('loss-result', 'outcome', { claim_type: 'reaction', available_at: '2026-10-12T11:30:00Z' })],
  { status: 'unknown', direction: null, require_unknown_reason: true, forbid_outcome_language: true },
  { status: 'unknown', direction: null, unknown_reason: 'Outcome tidak membuktikan kualitas rencana awal.', used_evidence_ids: ['loss-result'], claims: [{ kind: 'reaction', evidence_ids: ['loss-result'], text: 'Hasil dicatat terpisah dari proses.' }] },
  { status: 'invalid', direction: 'bearish', used_evidence_ids: ['loss-result'], claims: [{ kind: 'interpretation', evidence_ids: ['loss-result'], text: 'Tesis pasti salah karena kena SL.' }] }),

  fixture('hidden-info-valid', 'hidden_information', [ev('headline', 'headline')],
  { status: 'unknown', direction: null, require_unknown_reason: true },
  { status: 'unknown', direction: null, unknown_reason: 'Core CPI tidak tersedia dalam input.', used_evidence_ids: ['headline'], claims: [{ kind: 'fact', evidence_ids: ['headline'] }] },
  { status: 'valid', direction: 'bullish', used_evidence_ids: ['headline'], claims: [{ kind: 'fact', evidence_ids: ['headline'], text: 'Core CPI juga naik.' }] }),
  fixture('hidden-info-adversarial', 'hidden_information', [],
  { status: 'unknown', direction: null, require_unknown_reason: true },
  { status: 'unknown', direction: null, unknown_reason: 'Jawaban tidak boleh menebak informasi yang disembunyikan.', used_evidence_ids: [], claims: [] },
  { status: 'valid', direction: 'bearish', used_evidence_ids: [], claims: [{ kind: 'fact', evidence_ids: [], text: 'Data tersembunyi pasti lemah.' }] }),
];

function validateReasoningResponse(item, response = {}) {
  const errors = [];
  const expected = item.expected || {};
  const evidenceById = new Map(item.evidence.map(record => [record.evidence_id, record]));
  const used = [...new Set(Array.isArray(response.used_evidence_ids) ? response.used_evidence_ids : [])];
  const claims = Array.isArray(response.claims) ? response.claims : [];
  if (expected.status !== undefined && response.status !== expected.status) errors.push(`status:${response.status ?? 'missing'}!=${expected.status}`);
  if (expected.direction !== undefined && response.direction !== expected.direction) errors.push(`direction:${response.direction ?? 'null'}!=${expected.direction}`);
  if ((expected.forbidden_directions || []).includes(response.direction)) errors.push(`forbidden_direction:${response.direction}`);
  if (expected.require_unknown_reason && !String(response.unknown_reason || '').trim()) errors.push('missing_unknown_reason');
  for (const id of expected.must_use || []) if (!used.includes(id)) errors.push(`missing_evidence:${id}`);
  for (const id of expected.must_not_use || []) if (used.includes(id)) errors.push(`forbidden_evidence:${id}`);
  for (const id of expected.require_counter_evidence || []) if (!used.includes(id)) errors.push(`missing_counter_evidence:${id}`);
  for (const id of used) {
    const record = evidenceById.get(id);
    if (!record) { errors.push(`unknown_evidence:${id}`); continue; }
    const validation = validateEvidenceRecord(record, item.decision_as_of);
    if (validation.flags.includes('look_ahead')) errors.push(`look_ahead:${id}`);
  }
  for (const kind of expected.required_kinds || []) {
    if (!claims.some(claim => claim.kind === kind)) errors.push(`missing_claim_kind:${kind}`);
  }
  for (const claim of claims) {
    const ids = Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [];
    if (claim.kind === 'fact' && ids.length === 0) errors.push('ungrounded_fact');
    for (const id of ids) {
      const record = evidenceById.get(id);
      if (!record) errors.push(`claim_unknown_evidence:${id}`);
      if (!used.includes(id)) errors.push(`claim_not_declared_used:${id}`);
      if (record && ['fact', 'expectation'].includes(claim.kind) && record.claim_type !== claim.kind) {
        errors.push(`claim_kind_mismatch:${id}:${claim.kind}!=${record.claim_type}`);
      }
    }
    const text = String(claim.text || '');
    if (expected.forbid_causal_language && /\b(pasti menyebabkan|proves?|caused? by)\b/i.test(text)) errors.push('unsupported_causation');
    if (expected.forbid_outcome_language && /\b(karena akhirnya|karena kena|pasti salah karena|pasti benar karena)\b/i.test(text)) errors.push('outcome_hindsight');
  }
  const independent = Array.isArray(response.independent_evidence_ids) ? response.independent_evidence_ids : [];
  for (const id of independent) {
    if (!evidenceById.has(id)) errors.push(`independent_unknown_evidence:${id}`);
    else if (!used.includes(id)) errors.push(`independent_not_used:${id}`);
  }
  const families = new Set(independent.map(id => evidenceById.get(id)?.family_id).filter(Boolean));
  if (expected.max_independent_families != null && independent.length > families.size) errors.push('duplicate_family_counted_independent');
  if (expected.max_independent_families != null && families.size > expected.max_independent_families) errors.push('too_many_independent_families');
  return { id: item.id, category: item.category, pass: errors.length === 0, errors };
}

function evaluateResponses(responses = {}, fixtures = FIXTURES) {
  const results = fixtures.map(item => validateReasoningResponse(item, responses[item.id] || {}));
  const byCategory = {};
  for (const result of results) {
    byCategory[result.category] ||= { total: 0, pass: 0, fail: 0 };
    byCategory[result.category].total++;
    byCategory[result.category][result.pass ? 'pass' : 'fail']++;
  }
  return {
    fixture_count: fixtures.length,
    passed: results.filter(result => result.pass).length,
    failed: results.filter(result => !result.pass).length,
    by_category: byCategory,
    results,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function auditSnapshot(records = [], meta = {}) {
  const sizes = records.map(record => Buffer.byteLength(JSON.stringify(record)));
  const evidence = records.flatMap(record => Array.isArray(record.evidence) ? record.evidence : []);
  return {
    records: records.length,
    record_bytes: { total: sizes.reduce((a, b) => a + b, 0), p50: percentile(sizes, 0.5), p95: percentile(sizes, 0.95), max: sizes.length ? Math.max(...sizes) : null },
    evidence: evidenceCoverage(evidence, meta.decision_as_of),
    envelopes: records.map(record => buildDecisionEnvelope(record, meta)),
    input_hash: stableHash(records),
    limitations: evidence.length ? [] : ['Record belum membawa array evidence terstruktur; provenance coverage belum dapat dinilai.'],
  };
}

module.exports = { FIXTURES, validateReasoningResponse, evaluateResponses, auditSnapshot, percentile };

if (require.main === module) {
  const responses = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : Object.fromEntries(FIXTURES.map(item => [item.id, item.reference_response]));
  const snapshot = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [];
  const records = Array.isArray(snapshot) ? snapshot : (snapshot.records || snapshot['setup_log_auto:v1'] || []);
  process.stdout.write(JSON.stringify({
    reasoning: evaluateResponses(responses),
    snapshot: auditSnapshot(records),
    fixture_hash: stableHash(FIXTURES),
  }, null, 2) + '\n');
}
