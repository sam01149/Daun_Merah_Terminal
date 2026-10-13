const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEvidenceRecord, validateEvidenceRecord, groupEvidenceFamilies,
  evidenceCoverage, buildDecisionEnvelope, stableHash,
} = require('../../api/_aatas_evidence');

test('evidence: hash stabil walau urutan key object berbeda', () => {
  assert.equal(stableHash({ a: 1, b: { c: 2, d: 3 } }), stableHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(stableHash({ values: [1, 2] }), stableHash({ values: [2, 1] }), 'urutan array tetap bermakna');
});

test('evidence: normalisasi deterministik mempertahankan as-of, unit dan provenance', () => {
  const raw = {
    source_id: 'bls-cpi', source_type: 'official_release', source_published_at: '2026-10-01T12:30:00Z',
    available_at: '2026-10-01T12:30:02Z', observed_at: '2026-10-01T12:31:00Z', event_id: 'us-cpi-2026-09',
    country: 'US', currency: 'usd', category: 'inflation', claim_type: 'fact', value: '3.1', unit: '% YoY',
    period: '2026-09', vintage: 'initial', relation: 'supports', text: 'CPI 3,1% YoY',
  };
  const a = normalizeEvidenceRecord(raw), b = normalizeEvidenceRecord(raw);
  assert.deepEqual(a, b);
  assert.match(a.evidence_id, /^ev_[a-f0-9]{20}$/);
  assert.match(a.family_id, /^event_[a-f0-9]{20}$/);
  assert.equal(a.currency, 'USD');
  assert.equal(a.value, 3.1);
  assert.equal(a.validation.ok, true);
});

test('evidence: data hilang, look-ahead dan nilai tanpa unit tidak disamarkan', () => {
  const record = normalizeEvidenceRecord({
    source_id: 'calendar', source_type: 'calendar', available_at: '2026-10-02T00:00:00Z',
    claim_type: 'fact', value: 10,
  });
  const result = validateEvidenceRecord(record, '2026-10-01T00:00:00Z');
  assert.equal(result.ok, false);
  assert.ok(result.flags.includes('look_ahead'));
  assert.ok(result.flags.includes('value_without_unit'));
  assert.ok(result.flags.includes('family_unknown'));
  const missing = normalizeEvidenceRecord({ text: 'tanpa sumber' });
  assert.ok(missing.validation.missing.includes('source_id'));
  assert.ok(missing.validation.missing.includes('available_at'));
});

test('evidence: keluarga hanya digabung dari ID eksplisit, bukan kemiripan teks', () => {
  const shared = { source_type: 'news', available_at: '2026-10-01T00:00:00Z', claim_type: 'interpretation' };
  const records = [
    normalizeEvidenceRecord({ ...shared, source_id: 'a', event_id: 'same-cpi', text: 'inflasi naik' }),
    normalizeEvidenceRecord({ ...shared, source_id: 'b', event_id: 'same-cpi', text: 'CPI menguat' }),
    normalizeEvidenceRecord({ ...shared, source_id: 'c', text: 'inflasi naik' }),
  ];
  const groups = groupEvidenceFamilies(records);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(g => g.family_id === records[0].family_id).evidence.length, 2);
  const coverage = evidenceCoverage(records);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.known_families, 1);
  assert.equal(coverage.unknown_families, 1);
});

test('evidence: decision envelope tidak mengarang revision/hash/model yang hilang', () => {
  const setup = { id: 'EURUSD=X:1', ts: 1000, policy_v: 62, aatas_v: 14, model: 'deepseek-v4-pro' };
  const out = buildDecisionEnvelope(setup, { code_commit: 'abc123', source_refs: ['ev_b', 'ev_a', 'ev_a'] });
  assert.equal(out.setup_id, setup.id);
  assert.equal(out.policy_v, 62);
  assert.deepEqual(out.source_refs, ['ev_a', 'ev_b']);
  assert.equal(out.prompt_hash, null);
  assert.equal(out.revision_id, null);
  assert.equal(out.decision_as_of, '1970-01-01T00:16:40.000Z');
});
