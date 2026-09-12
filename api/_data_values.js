// Decimal input from JSON/form fields. Never accept partial strings, arrays or booleans.
function finiteDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}
function normalizeJournalNumbers(data, fields) {
  for (const key of fields) {
    if (data[key] == null) continue;
    const n = finiteDecimal(data[key]);
    if (n == null || (key !== 'r_actual' && n < 0)
      || (key === 'mt5_ticket' && (!Number.isSafeInteger(n) || n <= 0))
      || (key === 'checklist_pct' && n > 100)) return key;
    data[key] = n;
  }
  return null;
}
function sanitizeSizing(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !/^[A-Z]{3}\/[A-Z]{3}$/.test(entry.pair)) return null;
  const out = { pair: entry.pair };
  for (const k of ['riskPct','lotSize','equity','stopPips','dollarRisk']) {
    const n = finiteDecimal(entry[k]);
    if (n == null || n <= 0 || (k === 'riskPct' && n > 100)) return null;
    out[k] = n;
  }
  // dollarRisk is derived from these two inputs in the existing calculator.
  if (Math.abs(out.dollarRisk - out.equity * out.riskPct / 100) > 0.011) return null;
  return out;
}
module.exports = { finiteDecimal, normalizeJournalNumbers, sanitizeSizing };

function mergeSetupArchive(archive, current, limit = 5000) {
  const map = new Map();
  for (const row of Array.isArray(archive) ? archive : []) if (row && row.id != null) map.set(String(row.id), row);
  const old = new Map(map), seen = new Set();
  let added = 0, updated = 0;
  for (const row of Array.isArray(current) ? current : []) {
    if (!row || row.id == null) continue;
    const key = String(row.id);
    map.set(key, row); seen.add(key);
  }
  for (const key of seen) {
    if (!old.has(key)) added++;
    else if (JSON.stringify(old.get(key)) !== JSON.stringify(map.get(key))) updated++;
  }
  const entries = [...map.values()].sort((a,b)=>(Number(a.ts)||0)-(Number(b.ts)||0)).slice(-limit);
  return {entries,added,updated};
}
module.exports.mergeSetupArchive = mergeSetupArchive;

function snapshotRevision(current, capturedAt, prior) {
  const fields = {macro_snapshot:current,macro_snapshot_at:capturedAt};
  if (prior) {
    fields.macro_snapshot_origin = Object.hasOwn(prior,'macro_snapshot_origin') ? prior.macro_snapshot_origin : (prior.macro_snapshot ?? null);
    fields.macro_snapshot_origin_at = Object.hasOwn(prior,'macro_snapshot_origin_at') ? prior.macro_snapshot_origin_at : (prior.macro_snapshot_at ?? null);
  }
  return fields;
}
module.exports.snapshotRevision = snapshotRevision;
