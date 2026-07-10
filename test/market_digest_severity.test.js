// test/market_digest_severity.test.js
// Plan G3 — sign effect (Andersen/Bollerslev/Diebold/Vega 2003): klasifikasi
// severitas data rilis dihitung DI KODE dari actual vs forecast, bukan oleh AI.
// "Miss = lemah" tidak seragam: mapping eksplisit per indikator dengan invert
// (unemployment/claims dibalik), CPI sengaja di luar mapping (ambigu → netral).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDataSurpriseSeverity,
  severityTagForHeadline,
  parseEconNumber,
} = require('../api/market-digest.js');

// ── parseEconNumber ──────────────────────────────────────────────────────────

test('parseEconNumber: suffix K/M/B dikalikan, % apa adanya, koma ribuan dibuang', () => {
  assert.equal(parseEconNumber('147K'), 147000);
  assert.equal(parseEconNumber('1.5M'), 1500000);
  assert.equal(parseEconNumber('2B'), 2000000000);
  assert.equal(parseEconNumber('3.5%'), 3.5);
  assert.equal(parseEconNumber('-0.2%'), -0.2);
  assert.equal(parseEconNumber('1,250K'), 1250000);
  assert.equal(parseEconNumber('52.3'), 52.3);
});

test('parseEconNumber: input bukan angka → null', () => {
  assert.equal(parseEconNumber('abc'), null);
  assert.equal(parseEconNumber(''), null);
  assert.equal(parseEconNumber(null), null);
  assert.equal(parseEconNumber(undefined), null);
});

// ── classifyDataSurpriseSeverity: arah per jenis indikator ───────────────────

test('NFP miss (actual < forecast) → weak, tag severitas', () => {
  const r = classifyDataSurpriseSeverity(100000, 130000, 'US Nonfarm Payrolls');
  assert.equal(r.weak, true);
  assert.ok(r.urgencyTag.includes('SEVERITAS: TINGGI'));
  assert.ok(r.magnitude > 0);
});

test('NFP beat (actual > forecast) → bukan weak, tanpa tag (sign effect asimetris)', () => {
  const r = classifyDataSurpriseSeverity(160000, 130000, 'US Nonfarm Payrolls');
  assert.equal(r.weak, false);
  assert.equal(r.urgencyTag, '');
  assert.ok(r.magnitude > 0, 'magnitude tetap dihitung');
});

test('Unemployment Rate NAIK di atas forecast → weak (arah dibalik)', () => {
  const r = classifyDataSurpriseSeverity(4.5, 4.2, 'US Unemployment Rate');
  assert.equal(r.weak, true);
  assert.ok(r.urgencyTag.includes('SEVERITAS'));
});

test('Unemployment Rate turun di bawah forecast → bukan weak', () => {
  const r = classifyDataSurpriseSeverity(4.0, 4.2, 'US Unemployment Rate');
  assert.equal(r.weak, false);
  assert.equal(r.urgencyTag, '');
});

test('Jobless Claims naik di atas forecast → weak (arah dibalik)', () => {
  const r = classifyDataSurpriseSeverity(260000, 230000, 'US Initial Jobless Claims');
  assert.equal(r.weak, true);
});

test('Retail Sales miss → weak; PMI miss → weak', () => {
  assert.equal(classifyDataSurpriseSeverity(-0.5, 0.3, 'US Retail Sales MoM').weak, true);
  assert.equal(classifyDataSurpriseSeverity(47.1, 50.2, 'ISM Manufacturing PMI').weak, true);
});

// ── Edge case wajib plan: indikator di luar mapping → netral, jangan menebak ──

test('CPI tidak di-mapping (ambigu dovish/hawkish) → netral tanpa tag', () => {
  const r = classifyDataSurpriseSeverity(2.1, 2.4, 'US CPI YoY');
  assert.equal(r.weak, false);
  assert.equal(r.urgencyTag, '');
  assert.equal(r.magnitude, 0);
});

test('indikator tak dikenal → netral; input non-angka → netral', () => {
  assert.equal(classifyDataSurpriseSeverity(1, 2, 'Random Unknown Indicator').urgencyTag, '');
  assert.equal(classifyDataSurpriseSeverity(NaN, 2, 'US Nonfarm Payrolls').urgencyTag, '');
  assert.equal(classifyDataSurpriseSeverity(1, null, 'US Nonfarm Payrolls').urgencyTag, '');
});

test('actual === forecast (tanpa surprise) → netral', () => {
  const r = classifyDataSurpriseSeverity(130000, 130000, 'US Nonfarm Payrolls');
  assert.equal(r.weak, false);
  assert.equal(r.magnitude, 0);
});

// ── severityTagForHeadline: ekstraksi dari format headline FinancialJuice ─────

test('headline NFP miss format FinancialJuice → dapat tag', () => {
  const tag = severityTagForHeadline('US Nonfarm Payrolls Actual 100K (Forecast 130K, Previous 139K)');
  assert.ok(tag.includes('SEVERITAS: TINGGI'));
});

test('headline NFP beat → tanpa tag; headline unemployment naik → dapat tag', () => {
  assert.equal(severityTagForHeadline('US Nonfarm Payrolls Actual 160K (Forecast 130K, Previous 139K)'), '');
  assert.ok(severityTagForHeadline('US Unemployment Rate Actual 4.5% (Forecast 4.2%, Previous 4.1%)').includes('SEVERITAS'));
});

test('headline CPI → tanpa tag (di luar mapping); headline biasa tanpa Actual/Forecast → tanpa tag', () => {
  assert.equal(severityTagForHeadline('US CPI YoY Actual 2.1% (Forecast 2.4%, Previous 2.3%)'), '');
  assert.equal(severityTagForHeadline('Fed Chair Powell speaks at Jackson Hole'), '');
  assert.equal(severityTagForHeadline(''), '');
  assert.equal(severityTagForHeadline(null), '');
});
