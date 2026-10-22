// test/frontend/checklist_verdict_multiplier.test.js
// Rencana Entry memakai hard gate, bukan skor berbobot:
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
  var localStore = {};
  var localStorage = {
    getItem: key => Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : null,
    setItem: (key, value) => { localStore[key] = String(value); },
    removeItem: key => { delete localStore[key]; },
  };
  function ckRender() {}
  ${src}
  return {
    ckGetVerdict, ckAutoTick, ckAutoBlock, ckAutoConflict,
    ckPrimePlaybookForPair,
    setStoredSetup: (pair, value) => {
      const key = 'daunmerah_entry_setup_' + pair.replace('/', '');
      if (value == null) delete localStore[key];
      else localStore[key] = value;
    },
    reset: () => { ckState = {}; ckConflict = {}; ckAutoBlocked = {}; ckOverrideReasons = {}; localStore = {}; },
    setPlan: (id, sections, gates, isNoTrade = false, isPending = false) => {
      PLAYBOOKS[id] = { sections, gates, isNoTrade, isPending };
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

test('tanpa pair atau setup, planner MENUNGGU dan bukan memberi keputusan NO TRADE', () => {
  api.reset();
  api.setPlan('test_pending', [], [], false, true);
  const v = api.ckGetVerdict();
  assert.equal(v.verdict, 'MENUNGGU');
  assert.equal(v.isPending, true);
  assert.equal(v.isNoTrade, false);
  assert.equal(v.isReady, false);
});

test('konflik konteks tidak membatalkan gate dan tidak mengubah ukuran risiko', () => {
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

test('panel aktif berupa satu planner dengan pilihan setup manual yang ringkas', () => {
  const panel = grab('<!-- PRIME ENTRY PLAN PANEL -->', '<!-- TOAST -->');
  assert.match(panel, /class="ck-main"/);
  assert.match(panel, /class="ck-toolbar"/);
  assert.match(panel, /class="ck-selectors"/);
  assert.match(html, /grid-template-columns: clamp\(300px, 34%, 520px\) minmax\(0, 1fr\)/);
  assert.match(panel, /id="ckStrategySelector"/);
  assert.match(panel, /value="prime_momentum">Momentum/);
  assert.match(panel, /value="prime_range">Range/);
  assert.match(panel, /value="prime_tactical_fade">Tactical Fade/);
  assert.match(panel, /width:min\(100%,260px\)/);
  assert.match(panel, /width:min\(100%,200px\)/);
  assert.doesNotMatch(panel, /flex:0 1 260px|flex:0 1 200px/);
  assert.doesNotMatch(panel, /id="ckStrategyStatus"/);
  assert.doesNotMatch(panel, /Strategi dipilih otomatis/);
  assert.doesNotMatch(panel, /id="ckPlaybookSelector"/);
  for (const id of ['prime_no_trade', 'smc_ict', 'macro_momentum', 'event_driven', 'mean_reversion']) {
    assert.doesNotMatch(panel, new RegExp(`value="${id}"`));
  }
  assert.doesNotMatch(panel, /Pre-Entry|Periksa Sebelum Entry|scoring/i);
  assert.doesNotMatch(panel, /Momentum, Range, atau Tactical Fade dimuat otomatis/);
  assert.match(html, /PILIH PAIR/);
  assert.match(html, /PILIH SETUP/);
  assert.doesNotMatch(html, /ANALISA PRIME DIPERLUKAN/);
});

test('pair yang dipilih memuat setup manual yang tersimpan', () => {
  const pairFn = grab('function ckOnPairChange()', '\n// Catatan analisa');
  assert.match(pairFn, /ckConfigurePrimePlaybook\(ckPrimePlaybookForPair\(pair\)\)/);
  const autoFn = grab('function ckAutoTickRegimeCheck(pair)', '\nfunction _ckAutoPrime');
  assert.match(autoFn, /ckPrimePlaybookForPair\(pair\)/);
  assert.match(autoFn, /ckSwitchPlaybook\(resolvedPlaybook\)/);
});

test('resolver setup membaca pilihan per pair dan menolak nilai di luar menu', () => {
  for (const setupId of ['prime_momentum', 'prime_range', 'prime_tactical_fade']) {
    api.setStoredSetup('EUR/USD', setupId);
    assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), setupId);
  }
  api.setStoredSetup('EUR/USD', 'prime_no_trade');
  assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), 'prime_pending');
  api.setStoredSetup('EUR/USD', 'strategy_from_ai');
  assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), 'prime_pending');
  api.setStoredSetup('EUR/USD', null);
  assert.equal(api.ckPrimePlaybookForPair('EUR/USD'), 'prime_pending');
  assert.equal(api.ckPrimePlaybookForPair(''), 'prime_pending');
});

test('data AI tidak memilih setup atau memblok gate manual', () => {
  const autoPrimeFn = grab('function _ckAutoPrime(pair)', '\nfunction _ckAutoSMC');
  assert.match(autoPrimeFn, /window\._lastSizing/);
  assert.doesNotMatch(autoPrimeFn, /analisaAiCache|strategy_id|analysis_policy_v|academy_contract_status/);
  const hardBlock = grab('const CK_PRIME_HARD_BLOCK_IDS', '\n\nfunction ckFormatConflictLabel');
  assert.match(hardBlock, /pm_risk_pct/);
  assert.match(hardBlock, /rc4/);
  assert.doesNotMatch(hardBlock, /pm_policy|pm_direction|pm_reason|pm_contract/);
});

test('skenario kalender membuka Analisa tanpa langsung meloloskan rencana', () => {
  const scenarioFn = grab('function scenarioGoToChecklist(pair)', '\nfunction scenarioGoToSizing');
  assert.match(scenarioFn, /switchView\('analisa'\)/);
  assert.match(scenarioFn, /selectAnalisaPair/);
  assert.doesNotMatch(scenarioFn, /switchView\('checklist'\)/);
});

test('statistik edge UI meminta populasi Prime secara eksplisit', () => {
  const edgeFn = grab('async function jnRunEdgeStats()', '\n// Journal Bias Analyzer');
  assert.match(edgeFn, /action=edge_stats&population=prime/);
});
