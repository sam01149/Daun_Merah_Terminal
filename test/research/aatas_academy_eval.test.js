const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXTURES, validateReasoningResponse, evaluateResponses, auditSnapshot, percentile,
} = require('../../scripts/aatas_academy_eval.cjs');

test('academy eval: tepat 24 fixture mencakup 12 kelas, masing-masing valid dan adversarial', () => {
  assert.equal(FIXTURES.length, 24);
  const categories = new Map();
  for (const item of FIXTURES) categories.set(item.category, (categories.get(item.category) || 0) + 1);
  assert.equal(categories.size, 12);
  for (const count of categories.values()) assert.equal(count, 2);
});

test('academy eval: reference response lulus dan seluruh trap terdeteksi', () => {
  const references = Object.fromEntries(FIXTURES.map(item => [item.id, item.reference_response]));
  const traps = Object.fromEntries(FIXTURES.map(item => [item.id, item.trap_response]));
  const good = evaluateResponses(references), bad = evaluateResponses(traps);
  assert.equal(good.passed, 24);
  assert.equal(good.failed, 0);
  assert.equal(bad.passed, 0);
  assert.equal(bad.failed, 24);
  assert.ok(bad.results.every(result => result.errors.length > 0));
});

test('academy eval: look-ahead dan evidence ID yang tidak tersedia ditolak', () => {
  const item = FIXTURES.find(x => x.id === 'stale-source-adversarial');
  const result = validateReasoningResponse(item, item.trap_response);
  assert.equal(result.pass, false);
  assert.ok(result.errors.includes('forbidden_evidence:future-release'));
  assert.ok(result.errors.includes('look_ahead:future-release'));
});

test('academy eval: klaim wajib konsisten dengan jenis evidence dan daftar yang digunakan', () => {
  const item = FIXTURES.find(x => x.id === 'fact-expectation-valid');
  const result = validateReasoningResponse(item, {
    status: 'valid', direction: 'bullish',
    used_evidence_ids: ['actual-cpi', 'forecast-cpi'],
    claims: [
      { kind: 'fact', evidence_ids: ['forecast-cpi'] },
      { kind: 'expectation', evidence_ids: ['actual-cpi'] },
    ],
  });
  assert.equal(result.pass, false);
  assert.ok(result.errors.some(error => error.startsWith('claim_kind_mismatch:')));
});

test('academy eval: audit snapshot hanya mengukur payload dan missingness, tidak mengarang evidence', () => {
  const records = [
    { id: 'a', ts: 1000, policy_v: 62, aatas_v: 14, model: 'm' },
    { id: 'b', ts: 2000, evidence: FIXTURES[0].evidence },
  ];
  const report = auditSnapshot(records, { code_commit: 'abc' });
  assert.equal(report.records, 2);
  assert.ok(report.record_bytes.total > 0);
  assert.equal(report.evidence.total, 2);
  assert.equal(report.envelopes.length, 2);
  assert.match(report.input_hash, /^[a-f0-9]{20}$/);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([], 0.95), null);
});
