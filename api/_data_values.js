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
