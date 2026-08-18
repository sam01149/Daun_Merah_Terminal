// test/api/_levels.test.js
// Unit test PLAN Z (2026-08-18) — kandidat SL/TP deterministik, api/_levels.js.
// Pola sama test/api/_auto_entry_guard.test.js (modul murni, tanpa mock jaringan).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeLevelCandidates } = require('../../api/_levels.js');

// Fixture simetris tangan (bukan lewat _confluenceZones — modul ini murni menerima
// `zones` sebagai input, jadi dites langsung dengan bentuk output `_confluenceZones`
// yang sudah diketahui: { now, tolerance, above, below }). Above/below sengaja diisi
// urutan skor-turun (persis konvensi _confluenceZones) supaya tes tie-break "zona
// terdekat = presumed entry" berbeda dari urutan skor.
function zonesFixture() {
  return {
    now: 100,
    tolerance: 1,
    above: [
      { center: 102, score: 5, members: ['a-102'] },
      { center: 106, score: 3, members: ['a-106'] },
      { center: 112, score: 1, members: ['a-112'] },
    ],
    below: [
      { center: 98, score: 5, members: ['b-98'] },
      { center: 94, score: 3, members: ['b-94'] },
      { center: 88, score: 1, members: ['b-88'] },
    ],
  };
}

const OPTS = { zones: zonesFixture(), atrD: 1, isXau: false, dec: 2 };

test('computeLevelCandidates: SL bearish selalu di ATAS Now (sisi invalidasi) dan bukan zona terdekat (di luar entry)', () => {
  const r = computeLevelCandidates(OPTS);
  assert.ok(r.bearish, 'bearish harus terhitung untuk fixture ini');
  for (const c of r.bearish.sl) assert.ok(c.price > r.now, `SL bearish ${c.price} harus > now ${r.now}`);
  // Zona terdekat (102) diasumsikan jadi entry_zone -> TIDAK boleh muncul di kandidat SL.
  assert.ok(!r.bearish.sl.some(c => c.price === 102), 'zona terdekat (presumed entry) tidak boleh jadi kandidat SL');
});

test('computeLevelCandidates: SL bullish selalu di BAWAH Now (sisi invalidasi) dan bukan zona terdekat', () => {
  const r = computeLevelCandidates(OPTS);
  assert.ok(r.bullish, 'bullish harus terhitung untuk fixture ini');
  for (const c of r.bullish.sl) assert.ok(c.price < r.now, `SL bullish ${c.price} harus < now ${r.now}`);
  assert.ok(!r.bullish.sl.some(c => c.price === 98), 'zona terdekat (presumed entry) tidak boleh jadi kandidat SL');
});

test('computeLevelCandidates: TP bearish selalu di BAWAH Now (sisi profit)', () => {
  const r = computeLevelCandidates(OPTS);
  for (const c of r.bearish.tp) assert.ok(c.price < r.now, `TP bearish ${c.price} harus < now ${r.now}`);
});

test('computeLevelCandidates: TP bullish selalu di ATAS Now (sisi profit)', () => {
  const r = computeLevelCandidates(OPTS);
  for (const c of r.bullish.tp) assert.ok(c.price > r.now, `TP bullish ${c.price} harus > now ${r.now}`);
});

test('computeLevelCandidates: kandidat sintetis buffer ATR selalu ada di ujung SL (jaring pengaman walau confluence tipis)', () => {
  const r = computeLevelCandidates(OPTS);
  // buffer = atrD(1) * 0.5 (FX) = 0.5; farthest above = 112 -> synthetic 112.5; farthest below = 88 -> synthetic 87.5
  assert.ok(r.bearish.sl.some(c => Math.abs(c.price - 112.5) < 1e-9), 'kandidat sintetis bearish SL harus 112.5');
  assert.ok(r.bullish.sl.some(c => Math.abs(c.price - 87.5) < 1e-9), 'kandidat sintetis bullish SL harus 87.5');
});

test('computeLevelCandidates: RR<1 tidak pernah muncul — TP tersisa selalu >= jarak SL TERDEKAT (skenario RR terbaik)', () => {
  const r = computeLevelCandidates(OPTS);
  const minSlDistBearish = Math.min(...r.bearish.sl.map(c => Math.abs(c.price - r.now)));
  for (const c of r.bearish.tp) assert.ok(Math.abs(c.price - r.now) >= minSlDistBearish, `TP bearish ${c.price} lebih dekat dari SL terdekat — RR<1 walau skenario terbaik`);
  const minSlDistBullish = Math.min(...r.bullish.sl.map(c => Math.abs(c.price - r.now)));
  for (const c of r.bullish.tp) assert.ok(Math.abs(c.price - r.now) >= minSlDistBullish, `TP bullish ${c.price} lebih dekat dari SL terdekat — RR<1 walau skenario terbaik`);
});

test('computeLevelCandidates: kandidat TP yang gagal RR bahkan di skenario terbaik dibuang dari daftar', () => {
  const r = computeLevelCandidates(OPTS);
  // bearish: minSlDist = min(dist(106,100)=6, dist(112,100)=12, dist(112.5,100)=12.5) = 6
  // tpBelow tersedia [98(d2),94(d6),88(d12)] -> 98 (d2<6) harus DIBUANG, 94 & 88 lolos.
  assert.ok(!r.bearish.tp.some(c => c.price === 98), 'TP 98 (dist 2 < minSL 6) harus dibuang');
  assert.ok(r.bearish.tp.some(c => c.price === 94));
  assert.ok(r.bearish.tp.some(c => c.price === 88));
});

test('computeLevelCandidates: determinisme — input identik dipanggil dua kali menghasilkan daftar identik persis', () => {
  const a = computeLevelCandidates(zonesFixture() && { zones: zonesFixture(), atrD: 1, isXau: false, dec: 2 });
  const b = computeLevelCandidates({ zones: zonesFixture(), atrD: 1, isXau: false, dec: 2 });
  assert.deepStrictEqual(a, b);
});

test('computeLevelCandidates: zones null (data minim, mis. h1 unavailable) -> null, bukan crash', () => {
  assert.strictEqual(computeLevelCandidates({ zones: null, atrD: 1, isXau: false, dec: 2 }), null);
});

test('computeLevelCandidates: zones.now bukan angka -> null, bukan crash', () => {
  assert.strictEqual(computeLevelCandidates({ zones: { now: null, tolerance: 1, above: [], below: [] }, atrD: 1, isXau: false, dec: 2 }), null);
});

test('computeLevelCandidates: hanya satu sisi terisi (above kosong) -> kedua arah null (SL bearish & TP bullish butuh above)', () => {
  const z = zonesFixture();
  z.above = [];
  const r = computeLevelCandidates({ zones: z, atrD: 1, isXau: false, dec: 2 });
  assert.strictEqual(r, null);
});

test('computeLevelCandidates: tanpa ATR (atrD null) pakai fallback persentase dari Now, tetap terhitung tanpa crash', () => {
  const r = computeLevelCandidates({ zones: zonesFixture(), atrD: null, isXau: false, dec: 2 });
  assert.ok(r, 'harus tetap terhitung dengan fallback buffer');
  // buffer fallback = now * 0.0015 = 0.15 -> synthetic bearish = 112 + 0.15 = 112.15
  assert.ok(r.bearish.sl.some(c => Math.abs(c.price - 112.15) < 1e-9));
});

test('computeLevelCandidates: buffer XAU (1x ATR) lebih lebar dari FX (0.5x ATR) pada data identik', () => {
  const xau = computeLevelCandidates({ zones: zonesFixture(), atrD: 1, isXau: true, dec: 2 });
  const fx = computeLevelCandidates({ zones: zonesFixture(), atrD: 1, isXau: false, dec: 2 });
  const synthXau = xau.bearish.sl.find(c => c.price > 112.4);
  const synthFx = fx.bearish.sl.find(c => c.price > 112.4);
  assert.ok(synthXau.price > synthFx.price, 'buffer XAU (1x ATR) harus lebih jauh dari FX (0.5x ATR)');
});

test('computeLevelCandidates: harga hasil tetap format angka terbaca regex existing (/[\\d.]+/g)', () => {
  const r = computeLevelCandidates(OPTS);
  const rx = /[\d.]+/g;
  for (const c of [...r.bearish.sl, ...r.bearish.tp, ...r.bullish.sl, ...r.bullish.tp]) {
    const asString = c.price.toFixed(r.dec);
    const matched = (String(asString).match(rx) || []).map(Number);
    assert.ok(matched.length >= 1 && !isNaN(matched[0]), `harga ${asString} harus terbaca regex angka`);
  }
});

test('computeLevelCandidates: tolerance di-passthrough dari zones.tolerance (dipakai admin.js untuk snap)', () => {
  const r = computeLevelCandidates(OPTS);
  assert.strictEqual(r.tolerance, 1);
});
