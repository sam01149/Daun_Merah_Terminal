// test/frontend/checklist_verdict_multiplier.test.js
// PLAN U-4: verdict bertingkat + risk multiplier di ckGetVerdict().
// 1. Kelas ARAH (ckAutoConflict) tidak menggagalkan gate/pct (ckState tetap true),
//    tapi menurunkan verdict lewat riskMultiplier 0.5 ("KONFLIK — HALF SIZE").
// 2. Kelas WAKTU (ckAutoBlock, mis. rc4) tetap mutlak — riskMultiplier 0 (NO TRADE).
// 3. pct<50 tanpa gate/conflict tetap NO TRADE murni seperti sebelum U-4.
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

// Range A: PB_REGIME_CHECK/PLAYBOOKS/ckState-cs/ckGetVerdict (belum termasuk ckBuildUI
// yang murni DOM). Range B: ckAutoTick/ckAutoBlock/ckAutoConflict (belum termasuk
// ckAutoTickRegimeCheck yang butuh cbData/cotData/calData live).
const src = [
  grab('// ── CHECKLIST', '\nfunction ckBuildUI'),
  grab('function ckAutoTick(id, hint)', '\nfunction ckAutoTickRegimeCheck'),
].join('\n');

const api = new Function(`
  var document = { getElementById: () => null };
  var localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  function ckRender() {}
  ${src}
  return {
    ckGetVerdict, ckAutoTick, ckAutoBlock, ckAutoConflict,
    reset: () => { ckState = {}; ckConflict = {}; ckAutoBlocked = {}; ckOverrideReasons = {}; },
    setSections: (sections, gates) => { CK_SECTIONS = sections; CK_GATES = gates; },
  };
`)();

// Playbook sintetis kecil (bukan smc_ict asli) — cukup 1 gate section berisi item
// WAKTU (t1, seperti rc4) + item ARAH (t2, seperti rc3/rc6), plus 1 section biasa (t3).
const GATE_SEC = { id: 'gate_sec', items: [{ id: 't1' }, { id: 't2' }] };
const PLAIN_SEC = { id: 'plain_sec', items: [{ id: 't3' }] };

function setup() {
  api.reset();
  api.setSections([GATE_SEC, PLAIN_SEC], ['gate_sec']);
}

test('clean pass (semua tercentang, tanpa konflik) -> riskMultiplier 1', () => {
  setup();
  api.ckAutoTick('t1', 'ok');
  api.ckAutoTick('t2', 'ok');
  api.ckAutoTick('t3', 'ok');
  const v = api.ckGetVerdict();
  assert.strictEqual(v.riskMultiplier, 1);
  assert.strictEqual(v.gatesOk, true);
  assert.strictEqual(v.hasArahConflict, false);
  assert.notStrictEqual(v.verdict, 'NO TRADE');
});

test('konflik ARAH (ckAutoConflict) -> gate tetap lolos, riskMultiplier 0.5, verdict KONFLIK', () => {
  setup();
  api.ckAutoTick('t1', 'ok');
  api.ckAutoConflict('t2', 'COT kontra arah');
  api.ckAutoTick('t3', 'ok');
  const v = api.ckGetVerdict();
  assert.strictEqual(v.gatesOk, true, 'item konflik ARAH tidak boleh menggagalkan gate');
  assert.strictEqual(v.riskMultiplier, 0.5);
  assert.strictEqual(v.verdict, 'KONFLIK — HALF SIZE');
  assert.strictEqual(v.cls, 'konflik');
  assert.strictEqual(v.hasArahConflict, true);
  assert.strictEqual(v.conflictItems.length, 1);
});

test('blok WAKTU (ckAutoBlock, mis. rc4) -> gate gagal, riskMultiplier 0, NO TRADE mutlak', () => {
  setup();
  api.ckAutoBlock('t1', 'event high-impact <6 jam');
  api.ckAutoTick('t2', 'ok');
  api.ckAutoTick('t3', 'ok');
  const v = api.ckGetVerdict();
  assert.strictEqual(v.gatesOk, false);
  assert.strictEqual(v.riskMultiplier, 0);
  assert.strictEqual(v.verdict, 'NO TRADE');
});

test('pct<50 (belum cukup dicentang) -> NO TRADE, riskMultiplier 0, walau tidak ada blok/konflik', () => {
  setup();
  api.ckAutoTick('t1', 'ok'); // gate section: t1 tercentang tapi t2 belum -> gate juga gagal
  const v = api.ckGetVerdict();
  assert.strictEqual(v.riskMultiplier, 0);
  assert.strictEqual(v.verdict, 'NO TRADE');
});

test('ckAutoTick membersihkan flag konflik/block lama pada id yang sama (tidak nyangkut basi)', () => {
  setup();
  api.ckAutoConflict('t2', 'kontra');
  let v = api.ckGetVerdict();
  assert.strictEqual(v.hasArahConflict, true);

  api.ckAutoTick('t1', 'ok');
  api.ckAutoTick('t2', 'sekarang selaras'); // kondisi berubah jadi selaras
  api.ckAutoTick('t3', 'ok');
  v = api.ckGetVerdict();
  assert.strictEqual(v.hasArahConflict, false, 'ckAutoTick harus membersihkan ckConflict lama');
  assert.strictEqual(v.riskMultiplier, 1);
});

test('ckAutoBlock membersihkan flag konflik lama pada id yang sama', () => {
  setup();
  api.ckAutoConflict('t2', 'kontra');
  api.ckAutoTick('t1', 'ok');
  api.ckAutoBlock('t2', 'berubah jadi blok waktu');
  api.ckAutoTick('t3', 'ok');
  const v = api.ckGetVerdict();
  assert.strictEqual(v.hasArahConflict, false, 'ckAutoBlock harus membersihkan ckConflict lama');
  assert.strictEqual(v.riskMultiplier, 0);
  assert.strictEqual(v.gatesOk, false);
});
