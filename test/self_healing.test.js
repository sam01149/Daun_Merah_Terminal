// test/self_healing.test.js — lapisan self-healing (2026-07-18):
//   Lapis 0: safety net proses (tidak dites di sini — butuh proses hidup)
//   Lapis 1: guard degradasi Redis (createRedisGuard, vps/daemon.js)
//   Lapis 2: watchdog WS zombie (shouldForceReconnect, vps/daemon.js)
//   Lapis 3: supervisor freshness data (isFxMarketOpen/isCandleStale — daemon
//            DAN api/_market_hours.js, duplikasi sadar yang dijaga drift-guard)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../vps/daemon.js');
const marketHours = require('../api/_market_hours.js');

// ── Lapis 1: createRedisGuard ────────────────────────────────────────────────

test('redisGuard: belum degraded sebelum ambang gagal beruntun tercapai', () => {
  const g = daemon.createRedisGuard({ threshold: 5 });
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(g.onFailure(t0), false, `gagal ke-${i + 1} belum boleh degraded`);
  assert.equal(g.isDegraded(t0), false);
});

test('redisGuard: masuk degraded tepat di ambang, transisi dilaporkan SEKALI', () => {
  const g = daemon.createRedisGuard({ threshold: 3, baseCooldownMs: 60_000 });
  const t0 = 1_000_000;
  g.onFailure(t0); g.onFailure(t0);
  assert.equal(g.onFailure(t0), true, 'gagal ke-3 = transisi masuk degraded');
  assert.equal(g.isDegraded(t0 + 1), true);
  assert.equal(g.onFailure(t0 + 2), false, 'gagal berikutnya bukan transisi baru (anti spam alert)');
});

test('redisGuard: cooldown habis membuka jendela probe, gagal lagi menggandakan cooldown', () => {
  const g = daemon.createRedisGuard({ threshold: 1, baseCooldownMs: 60_000, maxCooldownMs: 240_000 });
  const t0 = 1_000_000;
  g.onFailure(t0);
  assert.equal(g.isDegraded(t0 + 59_000), true, 'masih dalam cooldown 60s');
  assert.equal(g.isDegraded(t0 + 61_000), false, 'cooldown lewat = jendela probe terbuka');
  g.onFailure(t0 + 61_000); // probe gagal -> cooldown kedua = 120s
  assert.equal(g.isDegraded(t0 + 61_000 + 119_000), true, 'cooldown kedua harus 120s (digandakan)');
  assert.equal(g.isDegraded(t0 + 61_000 + 121_000), false);
});

test('redisGuard: cooldown tidak melewati maxCooldownMs', () => {
  const g = daemon.createRedisGuard({ threshold: 1, baseCooldownMs: 60_000, maxCooldownMs: 120_000 });
  let t = 1_000_000;
  for (let i = 0; i < 10; i++) { g.onFailure(t); t += 1_000_000; }
  g.onFailure(t);
  assert.equal(g.isDegraded(t + 119_000), true);
  assert.equal(g.isDegraded(t + 121_000), false, 'cooldown harus mentok di 120s, bukan terus menggandakan');
});

test('redisGuard: sukses me-reset penuh dan melaporkan recovery sekali', () => {
  const g = daemon.createRedisGuard({ threshold: 2, baseCooldownMs: 60_000 });
  const t0 = 1_000_000;
  g.onFailure(t0); g.onFailure(t0);
  assert.equal(g.isDegraded(t0 + 1), true);
  assert.equal(g.onSuccess(), true, 'sukses pertama setelah degraded = recovery');
  assert.equal(g.isDegraded(t0 + 2), false);
  assert.equal(g.onSuccess(), false, 'sukses berikutnya bukan recovery lagi (anti spam alert)');
  assert.equal(g.onFailure(t0 + 3), false, 'counter gagal harus mulai dari 0 lagi setelah sukses');
});

// ── Lapis 2: shouldForceReconnect ────────────────────────────────────────────

test('shouldForceReconnect: false sebelum ada aktivitas pertama (lastActivityAt 0)', () => {
  assert.equal(daemon.shouldForceReconnect(0, 10 * 60 * 1000), false,
    'sebelum open pertama jangan pernah paksa reconnect');
});

test('shouldForceReconnect: false saat pesan masih mengalir, true setelah diam >3 menit', () => {
  const now = 10_000_000;
  assert.equal(daemon.shouldForceReconnect(now - 60_000, now), false, 'diam 1 menit itu normal');
  assert.equal(daemon.shouldForceReconnect(now - 3 * 60_000, now), false, 'tepat di ambang belum melewati');
  assert.equal(daemon.shouldForceReconnect(now - 3 * 60_000 - 1, now), true, 'lewat ambang = zombie');
});

// ── Lapis 3: isFxMarketOpen (kedua salinan) ──────────────────────────────────

const marketOpenCases = [
  ['Rabu 14:00 UTC',   Date.UTC(2026, 6, 15, 14, 0), true],
  ['Sabtu 12:00 UTC',  Date.UTC(2026, 6, 18, 12, 0), false],
  ['Minggu 20:00 UTC', Date.UTC(2026, 6, 19, 20, 0), false],
  ['Minggu 22:30 UTC', Date.UTC(2026, 6, 19, 22, 30), true],
  ['Jumat 20:59 UTC',  Date.UTC(2026, 6, 17, 20, 59), true],
  ['Jumat 21:00 UTC',  Date.UTC(2026, 6, 17, 21, 0), false],
  ['Senin 00:00 UTC',  Date.UTC(2026, 6, 13, 0, 0), true],
];

for (const [label, ms, expected] of marketOpenCases) {
  test(`isFxMarketOpen (daemon & _market_hours): ${label} -> ${expected}`, () => {
    assert.equal(daemon.isFxMarketOpen(new Date(ms)), expected, `daemon.js salah untuk ${label}`);
    assert.equal(marketHours.isFxMarketOpen(new Date(ms)), expected, `_market_hours.js salah untuk ${label}`);
  });
}

test('drift-guard: isFxMarketOpen daemon vs _market_hours identik untuk sweep 336 jam (2 minggu)', () => {
  const start = Date.UTC(2026, 6, 12, 0, 0); // Minggu 2026-07-12
  for (let h = 0; h < 336; h++) {
    const d = new Date(start + h * 3600 * 1000);
    assert.equal(daemon.isFxMarketOpen(d), marketHours.isFxMarketOpen(d),
      `hasil beda di ${d.toISOString()} — duplikasi sadar menyimpang, samakan kedua salinan`);
  }
});

// ── Lapis 3: newestCandleEpoch / isCandleStale (kedua salinan) ───────────────

test('newestCandleEpoch: ambil t terbesar, abaikan entri cacat', () => {
  const arr = [{ t: 100 }, { t: 300 }, { t: 200 }, { t: 'x' }, null];
  assert.equal(daemon.newestCandleEpoch(arr), 300);
  assert.equal(marketHours.newestCandleEpoch(arr), 300);
});

test('newestCandleEpoch: array kosong / bukan array -> null', () => {
  for (const bad of [[], null, undefined, 'oops']) {
    assert.equal(daemon.newestCandleEpoch(bad), null);
    assert.equal(marketHours.newestCandleEpoch(bad), null);
  }
});

test('isCandleStale: data hilang total dianggap basi (harus memicu heal)', () => {
  assert.equal(daemon.isCandleStale(null, Date.now()), true);
  assert.equal(marketHours.isCandleStale([], Date.now()), true);
});

test('isCandleStale: segar di bawah 3 jam, basi di atasnya', () => {
  const nowMs = Date.UTC(2026, 6, 15, 14, 0);
  const fresh = [{ t: Math.floor(nowMs / 1000) - 2 * 3600 }];
  const stale = [{ t: Math.floor(nowMs / 1000) - 3 * 3600 - 60 }];
  for (const mod of [daemon, marketHours]) {
    assert.equal(mod.isCandleStale(fresh, nowMs), false, 'candle umur 2 jam masih sehat (H1 wajar)');
    assert.equal(mod.isCandleStale(stale, nowMs), true, 'candle umur >3 jam = pipeline mati, heal');
  }
});
