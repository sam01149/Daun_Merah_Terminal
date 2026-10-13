// PLAN AE-2/3: kontrak bukti AATAS yang murni dan read-only.
// Modul ini tidak fetch, tidak menulis Redis, dan tidak memengaruhi gate/entry.
// Nilai yang tidak tersedia tetap null + missing_reason; jangan mengarang provenance.
const crypto = require('node:crypto');

const EVIDENCE_SCHEMA_VERSION = 1;
const CLAIM_TYPES = new Set(['fact', 'expectation', 'interpretation', 'scenario', 'reaction']);
const RELATIONS = new Set(['supports', 'opposes', 'context', 'unknown']);

function _canonical(value) {
  if (Array.isArray(value)) return value.map(_canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, _canonical(value[key])]));
  }
  return value;
}

function stableHash(value, length = 20) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonical(value))).digest('hex').slice(0, length);
}

function _text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function _time(value) {
  if (value == null || value === '') return null;
  if (Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function _number(value) {
  if (value == null || value === '') return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function normalizeEvidenceRecord(raw = {}, defaults = {}) {
  const merged = { ...defaults, ...raw };
  const sourceId = _text(merged.source_id);
  const eventId = _text(merged.event_id);
  const derivedFrom = Array.isArray(merged.derived_from)
    ? [...new Set(merged.derived_from.map(_text).filter(Boolean))].sort()
    : [];
  const identity = {
    source_id: sourceId,
    source_type: _text(merged.source_type),
    event_id: eventId,
    category: _text(merged.category),
    claim_type: _text(merged.claim_type),
    period: _text(merged.period),
    vintage: _text(merged.vintage),
    value: _number(merged.value),
    unit: _text(merged.unit),
    available_at: _time(merged.available_at),
  };
  const evidenceId = _text(merged.evidence_id) || `ev_${stableHash(identity)}`;
  // Keluarga hanya diturunkan bila ada event/derivasi eksplisit. Dua teks mirip tidak
  // otomatis dianggap satu keluarga, dan dua sumber tidak otomatis independen.
  const familyId = _text(merged.family_id)
    || (eventId ? `event_${stableHash(eventId)}` : null)
    || (derivedFrom.length ? `derived_${stableHash(derivedFrom)}` : null);

  const record = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: evidenceId,
    source_id: sourceId,
    source_type: _text(merged.source_type),
    source_published_at: _time(merged.source_published_at),
    available_at: _time(merged.available_at),
    observed_at: _time(merged.observed_at),
    event_id: eventId,
    family_id: familyId,
    country: _text(merged.country),
    currency: _text(merged.currency)?.toUpperCase() || null,
    category: _text(merged.category),
    claim_type: CLAIM_TYPES.has(merged.claim_type) ? merged.claim_type : null,
    value: _number(merged.value),
    unit: _text(merged.unit),
    period: _text(merged.period),
    vintage: _text(merged.vintage),
    horizon: _text(merged.horizon),
    relation: RELATIONS.has(merged.relation) ? merged.relation : 'unknown',
    derived_from: derivedFrom,
    text: _text(merged.text),
  };
  return { ...record, validation: validateEvidenceRecord(record) };
}

function validateEvidenceRecord(record, decisionAsOf = null) {
  const missing = [];
  for (const key of ['evidence_id', 'source_id', 'source_type', 'available_at', 'claim_type']) {
    if (record?.[key] == null) missing.push(key);
  }
  const flags = [];
  const availableMs = record?.available_at ? Date.parse(record.available_at) : NaN;
  const publishedMs = record?.source_published_at ? Date.parse(record.source_published_at) : NaN;
  const decisionMs = _time(decisionAsOf) ? Date.parse(_time(decisionAsOf)) : NaN;
  if (Number.isFinite(publishedMs) && Number.isFinite(availableMs) && availableMs < publishedMs) {
    flags.push('available_before_published');
  }
  if (Number.isFinite(decisionMs) && Number.isFinite(availableMs) && availableMs > decisionMs) {
    flags.push('look_ahead');
  }
  if (record?.value != null && !record?.unit) flags.push('value_without_unit');
  if (record?.claim_type === 'fact' && record?.value == null && !record?.text) flags.push('fact_without_value_or_text');
  if (!record?.family_id) flags.push('family_unknown');
  return { ok: missing.length === 0 && flags.length === 0, missing, flags };
}

function groupEvidenceFamilies(records = []) {
  const groups = new Map();
  for (const record of records) {
    const key = record?.family_id || `unknown:${record?.evidence_id || stableHash(record)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([family_id, evidence]) => ({ family_id, evidence }));
}

function evidenceCoverage(records = [], decisionAsOf = null) {
  const validations = records.map(record => validateEvidenceRecord(record, decisionAsOf));
  const counts = {};
  for (const result of validations) {
    for (const key of [...result.missing.map(x => `missing:${x}`), ...result.flags]) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  const families = groupEvidenceFamilies(records);
  return {
    total: records.length,
    valid: validations.filter(x => x.ok).length,
    invalid: validations.filter(x => !x.ok).length,
    known_families: families.filter(x => !x.family_id.startsWith('unknown:')).length,
    unknown_families: families.filter(x => x.family_id.startsWith('unknown:')).length,
    issues: counts,
  };
}

function buildDecisionEnvelope(setup = {}, meta = {}) {
  const decisionAsOf = _time(meta.decision_as_of ?? setup.level_set_at ?? setup.ts);
  const sourceRefs = [...new Set((meta.source_refs || []).map(_text).filter(Boolean))].sort();
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    decision_id: _text(meta.decision_id) || _text(setup.id) || `decision_${stableHash({ setup, decisionAsOf })}`,
    setup_id: _text(setup.id),
    revision_id: _text(meta.revision_id ?? setup.execution_contract?.revision_id),
    decision_as_of: decisionAsOf,
    code_commit: _text(meta.code_commit),
    policy_v: Number.isFinite(Number(setup.policy_v)) ? Number(setup.policy_v) : null,
    aatas_v: Number.isFinite(Number(setup.aatas_v)) ? Number(setup.aatas_v) : null,
    prompt_hash: _text(meta.prompt_hash),
    model: _text(setup.model),
    input_hash: _text(meta.input_hash),
    source_refs: sourceRefs,
    quality_flags: [...new Set((meta.quality_flags || []).map(_text).filter(Boolean))].sort(),
  };
}

module.exports = {
  EVIDENCE_SCHEMA_VERSION,
  stableHash,
  normalizeEvidenceRecord,
  validateEvidenceRecord,
  groupEvidenceFamilies,
  evidenceCoverage,
  buildDecisionEnvelope,
};
