// test/frontend/checklist_verdict_multiplier.test.js
// Rencana Entry Prime memakai hard gate, bukan skor berbobot:
// - persentase hanya kelengkapan tampilan;
// - semua section gate wajib lengkap sebelum SIAP ENTRY;
// - konteks positioning boleh berbeda tanpa membatalkan gate;
// - strategi no_trade selalu NO TRADE.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function grab(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s !== -1, `marker awal tidak ketemu: ${startMarker}`);
  const e = html.indexOf(endMarker, s);
  assert.ok(e !== -1, `marker akhir tidak ketemu: ${endMarker}`);
  return html.slice(s, e);
}

const src = [
  grab('// ── CHECKLIST', '\nfunction ckBuildUI'),
  grab('function ckAutoTick(id, hint)', '\nfunction ckAutoTickRegimeCheck'),
].join('\n');

const api = new Function(`
  var document = { getElementById: () => null };
  var localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  var analisaAiCache = {};
  function _analisaResultIsStale(result) { return !!result.stale; }
  function ckRender() {}
  ${src}
  return {
    ckGetVerdict, ckAutoTick, ckAutoBlock, ckAutoConflict,
    ckPrimePlaybookForPair,
    setAnalisaCache: value => { analisaAiCache = value; },
    reset: () => { ckState = {}; ckConflict = {}; ckAutoBlocked = {}; ckOverrideReasons = {}; },
    setPlan: (id, sections, gates, isNoTrade = false) => {
      PLAYBOOKS[id] = { sections, gates, isNoTrade };
      ckActivePlaybook = id;
      CK_SECTIONS = sections;
      CK_GATES = gates;
    },
  };
`)();

const MACRO = { id: 'macro', title: 'ARAH MAKRO', items: [{ id: 'm1' }, { id: 'm2' }] };
const TRIGGER = { id: 'trigger', title: 'TRIGGER', items: [{ id: 't1' }] };
const CONTEXT = { id: 'context', title: 'KONTEKS', items: [{ id: 'c1' }] };

function setup() {
  api.reset();
  api.setPlan('test_prime', [MACRO, TRIGGER, CONTEXT], ['macro', 'trigger']);
}

test('semua gate lengkap menghasilkan SIAP ENTRY tanpa pengali risiko otomatis', () => {
  setup();
  ['m1', 'm2', 't1'].forEach(id => api.ckAutoTick(id, 'ok'));
  const v = api.ckGetVerdict();
  assert.equal(v.verdict, 'SIAP ENTRY');
  assert.equal(v.isReady, true);
  assert.equal(v.gatesOk, true);
  assert.equal(v.riskMultiplier, 1);
  assert.equal(v.pct, 75, 'konteks kosong hanya menurunkan angka kelengkapan, bukan keputusan');
});

test('gate belum lengkap tetap TUNGGU walau kelengkapan tinggi', () => {
  setup();
  api.ckAutoTick('m1', 'ok');
  api.ckAutoTick('m2', 'ok');
  api.ckAutoTick('c1', 'ok');
  const v = api.ckGetVerdict();
  assert.equal(v.pct, 75);
  assert.equal(v.verdict, 'TUNGGU');
  assert.equal(v.isReady, false);
  assert.equal(v.riskMultiplier, 0);
  assert.deepEqual(v.incompleteGates.map(s => s.id), ['trigger']);
});

test('Sizing terbuka setelah semua prasyarat selain pm_risk_pct selesai, tetapi entry masih TUNGGU', () => {
  api.reset();
  const macro = { id: 'macro', title: 'ARAH MAKRO', items: [{ id: 'm1' }] };
  const risk = { id: 'risk', title: 'LEVEL DAN RISIKO', items: [{ id: 'pm_levels' }, { id: 'pm_rr' }, { id: 'pm_stop' }, { id: 'pm_risk_pct' }] };
  api.setPlan('test_prime_sizing', [macro, risk], ['macro', 'risk']);
  ['m1', 'pm_levels', 'pm_rr', 'pm_stop'].forEach(id => api.ckAutoTick(id, 'ok'));
  const before = api.ckGetVerdict();
  assert.equal(before.canSize, true);
  assert.equal(before.isReady, false);
  assert.equal(before.verdict, 'TUNGGU');

  api.ckAutoTick('pm_risk_pct', 'risk 1%');
  const after = api.ckGetVerdict();
  assert.equal(after.canSize, true);
  assert.equal(after.isReady, true);
  assert.equal(after.verdict, 'SIAP ENTRY');
});

test('belum ada konfirmasi dimulai dari TUNGGU, bukan NO TRADE karena skor nol', () => {
  setup();
  const v = api.ckGetVerdict();
  assert.equal(v.pct, 0);
  assert.equal(v.verdict, 'TUNGGU');
  assert.equal(v.isNoTrade, false);
});

test('strategi no_trade selalu NO TRADE meski pengakuan sudah dicentang', () => {
  api.reset();
  const sec = { id: 'decision', title: 'NO TRADE', items: [{ id: 'ack' }] };
  api.setPlan('test_no_trade', [sec], [], true);
  api.ckAutoTick('ack', 'dibaca');
  const v = api.ckGetVerdict();
  assert.equal(v.verdict, 'NO TRADE');
  assert.equal(v.isNoTrade, true);
  assert.equal(v.isReady, false);
  assert.equal(v.riskMultiplier, 0);
});

test('konflik konteks tidak membatalkan gate Prime dan tidak mengubah ukuran risiko', () => {
  setup();
  ['m1', 'm2', 't1'].forEach(id => api.ckAutoTick(id, 'ok'));
  api.ckAutoConflict('c1', 'COT berbeda arah');
  const v = api.ckGetVerdict();
  assert.equal(v.verdict, 'SIAP ENTRY');
  assert.equal(v.cls, 'konflik');
  assert.equal(v.hasArahConflict, true);
  assert.equal(v.riskMultiplier, 1);
});

test('auto-block pada item gate membuat keputusan tetap TUNGGU', () => {
  setup();
  api.ckAutoTick('m1', 'ok');
  api.ckAutoBlock('m2', 'kontrak ditolak');
  api.ckAutoTick('t1', 'ok');
  const v = api.ckGetVerdict();
  assert.equal(v.gatesOk, false);
  assert.equal(v.verdict, 'TUNGGU');
  assert.equal(v.riskMultiplier, 0);
});

test('ckAutoTick membersihkan flag konflik atau block lama pada id yang sama', () => {
  setup();
  api.ckAutoConflict('m1', 'kontra');
  api.ckAutoBlock('m2', 'basi');
  api.ckAutoTick('m1', 'sekarang selaras');
  api.ckAutoTick('m2', 'sekarang valid');
  api.ckAutoTick('t1', 'ok');
  const v = api.ckGetVerdict();
  assert.equal(v.hasArahConflict, false);
  assert.equal(v.verdict, 'SIAP ENTRY');
});

test('panel aktif berupa satu planner dan strategi hanya ditampilkan sebagai hasil otomatis', () => {
  const panel = grab('<!-- PRIME ENTRY PLAN PANEL -->', '<!-- TOAST -->');
  assert.match(panel, /id="ckStrategyStatus"/);
  assert.match(panel, /Strategi dipilih otomatis/);
  assert.doesNotMatch(panel, /id="ckPlaybookSelector"/);
  for (const id of ['prime_momentum', 'prime_range', 'prime_tactical_fade', 'prime_no_trade', 'smc_ict', 'macro_momentum', 'event_driven', 'mean_reversion']) {
    assert.doesNotMatch(panel, new RegExp(`value="${id}"`));
  }
  assert.doesNotMatch(panel, /Pre-Entry|Periksa Sebelum Entry|scoring/i);
  assert.match(panel, /Kotak hanya mencatat konfirmasi, bukan menambah skor\. Semua gate wajib lulus\./);
});

test('pair yang dipilih memuat strategi dari Analisa Prime tanpa pilihan manual', () => {
  const pairFn = grab('function ckOnPairChange()', '\n// Catatan analisa');
  assert.match(pairFn, /ckConfigurePrimePlaybook\(ckPrimePlaybookForPair\(pair\)\)/);
  const autoFn = grab('function ckAutoTickRegimeCheck(pair)', '\nfunction _ckAutoPrime');
  assert.match(autoFn, /ckPrimePlaybookForPair\(pair\)/);
  assert.match(autoFn, /ckSwitchPlaybook\(resolvedPlaybook\)/);
});

test('resolver strategi memakai hasil Analisa segar dan kembali ke No Trade saat basi atau kosong', () => {
  for (const [strategyId, expected] of [
    ['momentum', 'prime_momentum'],
    ['range', 'prime_range'],
    ['tactical_fade', 'prime_tactical_fade'],
    ['no_trade', 'prime_no_trade'],
  ]) {
    api.setAnalisaCache({ 'EURUSD=X': { structured: { strategy_id: strategyId }, stale: false } });
    assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), expected);
  }
  api.setAnalisaCache({ 'EURUSD=X': { structured: { strategy_id: 'momentum' }, stale: true } });
  assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), 'prime_no_trade');
  api.setAnalisaCache({});
  assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), 'prime_no_trade');
});

test('skenario kalender kembali ke Analisa Prime, bukan langsung meloloskan rencana', () => {
  const scenarioFn = grab('function scenarioGoToChecklist(pair)', '\nfunction scenarioGoToSizing');
  assert.match(scenarioFn, /switchView\('analisa'\)/);
  assert.match(scenarioFn, /selectAnalisaPair/);
  assert.doesNotMatch(scenarioFn, /switchView\('checklist'\)/);
});

test('statistik edge UI meminta populasi Prime secara eksplisit', () => {
  const edgeFn = grab('async function jnRunEdgeStats()', '\n// Journal Bias Analyzer');
  assert.match(edgeFn, /action=edge_stats&population=prime/);
});
