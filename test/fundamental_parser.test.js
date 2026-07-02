// test/fundamental_parser.test.js
// Unit test parser murni — jalankan: npm test (node --test, tanpa network/Redis)
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFundamentalFromHeadline, parseCBDecision } = require('../api/_fundamental_parser');

// ── parseFundamentalFromHeadline ────────────────────────────────────────────

test('format FinancialJuice standar: US CPI YoY', () => {
  const r = parseFundamentalFromHeadline('US CPI YoY: Actual 3.2% Forecast 3.1% Previous 3.4%');
  assert.deepStrictEqual(r, { currency: 'USD', key: 'CPI YoY', value: '3.2%', previous: '3.4%' });
});

test('NFP dengan nilai K (count) diterima', () => {
  const r = parseFundamentalFromHeadline('US NFP: Actual 175K Forecast 180K Previous 227K');
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.key, 'NFP');
  assert.strictEqual(r.value, '175K');
  assert.strictEqual(r.previous, '227K');
});

test('NFP dengan nilai % ditolak (QUANTITY_INDICATORS guard)', () => {
  const r = parseFundamentalFromHeadline('US NFP: Actual 0.0% Forecast 180K');
  assert.strictEqual(r, null);
});

test('Core PCE y/y disimpan sebagai key terpisah (tidak overwrite MoM)', () => {
  const r = parseFundamentalFromHeadline('US Core PCE y/y: Actual 2.8% Previous 2.9%');
  assert.strictEqual(r.key, 'Core PCE YoY');
});

test('Core PCE m/m tetap key Core PCE (cocok seed)', () => {
  const r = parseFundamentalFromHeadline('US Core PCE m/m: Actual 0.3% Previous 0.2%');
  assert.strictEqual(r.key, 'Core PCE');
});

test('kata sisipan Core: fallback country-only saat format kalender', () => {
  const r = parseFundamentalFromHeadline('Eurozone Core CPI YoY: Actual 2.9% Forecast 2.8% Previous 3.0%');
  assert.strictEqual(r.currency, 'EUR');
  assert.strictEqual(r.key, 'Core CPI YoY');
  assert.strictEqual(r.value, '2.9%');
});

test('qualifier Flash di akhir judul redirect ke key CPI Flash YoY', () => {
  const r = parseFundamentalFromHeadline('Eurozone CPI YoY Flash: Actual 2.4% Previous 2.2%');
  assert.strictEqual(r.key, 'CPI Flash YoY');
});

test('headline non-fundamental (tanpa currency match) → null', () => {
  assert.strictEqual(parseFundamentalFromHeadline('Gold rises above 2700 as dollar weakens'), null);
});

test('headline tanpa angka → null', () => {
  assert.strictEqual(parseFundamentalFromHeadline('US CPI data due later today'), null);
});

// ── parseCBDecision ─────────────────────────────────────────────────────────

test('Fed cut 25 bps → bps negatif + rate absolut', () => {
  const r = parseCBDecision('Federal Reserve cuts rates by 25 bps to 4.25%');
  assert.deepStrictEqual(r, { currency: 'USD', rate: 4.25, bps: -25, decision: 'cut' });
});

test('ECB hike 25bps', () => {
  const r = parseCBDecision('European Central Bank raises deposit rate by 25bps to 2.25%');
  assert.strictEqual(r.currency, 'EUR');
  assert.strictEqual(r.decision, 'hike');
  assert.strictEqual(r.bps, 25);
  assert.strictEqual(r.rate, 2.25);
});

test('BoJ hold (unchanged) dengan rate absolut', () => {
  const r = parseCBDecision('Bank of Japan leaves policy rate unchanged at 0.5%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.decision, 'hold');
  assert.strictEqual(r.rate, 0.5);
});

test('bentuk present-tense "holds" terdeteksi (regresi bug \\bhold\\b)', () => {
  const r = parseCBDecision('Bank of Japan holds policy rate at 0.5%');
  assert.strictEqual(r?.decision, 'hold');
});

test('bentuk present-tense "hikes" terdeteksi (regresi bug \\bhike\\b)', () => {
  const r = parseCBDecision('Swiss National Bank hikes policy rate by 25 bps to 0.75%');
  assert.strictEqual(r?.currency, 'CHF');
  assert.strictEqual(r?.decision, 'hike');
  assert.strictEqual(r?.bps, 25);
});

test('headline data ekonomi biasa (bukan keputusan CB) → null', () => {
  assert.strictEqual(parseCBDecision('US inflation rate rises to 3% annually'), null);
});

test('keputusan tanpa angka rate/bps → null (tidak bisa dipakai)', () => {
  assert.strictEqual(parseCBDecision('Federal Reserve expected to cut rates next meeting'), null);
});
