// test/journal_bias.test.js
// Journal Bias Analyzer (Plan I item 5, session 180) — statistik deterministik
// dari jurnal trading (overtrading/revenge trading, disposition effect, distribusi
// sesi, win-rate per playbook, streak). Statistik dihitung KODE (dites di sini);
// narasi AI hanya lapisan opsional di atas angka yang sudah pasti benar.
const test = require('node:test');
const assert = require('node:assert/strict');
const journalHandler = require('../api/journal.js');
const { _journalBiasStats: journalBiasStats } = journalHandler;

function mkEntry({ id, createdAt, closedAt, r, playbook = null, pair = 'EUR/USD', status = 'closed' }) {
  return {
    id, pair, status, r_actual: r,
    created_at: createdAt, closed_at: closedAt || createdAt,
    checklist_playbook: playbook,
  };
}

test('_journalBiasStats: sampel < 10 trade closed -> sufficient false, tidak menghitung apapun lagi', () => {
  const entries = Array.from({ length: 9 }, (_, i) =>
    mkEntry({ id: `t${i}`, createdAt: `2026-07-0${i + 1}T10:00:00Z`, r: 1 }));
  const stats = journalBiasStats(entries);
  assert.equal(stats.sufficient, false);
  assert.equal(stats.sample_count, 9);
  assert.equal(stats.min_required, 10);
  assert.equal(stats.disposition, undefined);
});

test('_journalBiasStats: entri open/archived, r_actual null, atau tanpa created_at TIDAK dihitung ke sampel', () => {
  const closed10 = Array.from({ length: 10 }, (_, i) =>
    mkEntry({ id: `t${i}`, createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`, r: 1 }));
  const noise = [
    mkEntry({ id: 'open1', createdAt: '2026-07-11T10:00:00Z', r: 1, status: 'open' }),
    mkEntry({ id: 'nor',   createdAt: '2026-07-12T10:00:00Z', r: null }),
    { id: 'nodate', status: 'closed', r_actual: 1 }, // tanpa created_at
  ];
  const stats = journalBiasStats([...closed10, ...noise]);
  assert.equal(stats.sufficient, true);
  assert.equal(stats.sample_count, 10);
});

test('_journalBiasStats: disposition ratio = avg win R / avg loss R (magnitude)', () => {
  // 5 win @ +1R, 5 loss @ -2R -> avg win 1, avg loss 2, ratio 0.5 (indikasi disposition effect)
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => mkEntry({ id: `w${i}`, createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`, r: 1 })),
    ...Array.from({ length: 5 }, (_, i) => mkEntry({ id: `l${i}`, createdAt: `2026-07-${String(i + 6).padStart(2, '0')}T10:00:00Z`, r: -2 })),
  ];
  const stats = journalBiasStats(entries);
  assert.equal(stats.disposition.avg_win_r, 1);
  assert.equal(stats.disposition.avg_loss_r, 2);
  assert.equal(stats.disposition.ratio, 0.5);
});

test('_journalBiasStats: overtrading signal true kalau jarak entry setelah LOSS jauh lebih pendek dari setelah WIN', () => {
  // Pola bergantian win/loss; setelah win jarak 48 jam, setelah loss jarak 2 jam (revenge)
  const entries = [];
  let t = new Date('2026-07-01T00:00:00Z').getTime();
  for (let i = 0; i < 10; i++) {
    const isWin = i % 2 === 0;
    const createdAt = new Date(t).toISOString();
    const closedAt = new Date(t + 3600000).toISOString(); // trade berlangsung 1 jam
    entries.push(mkEntry({ id: `t${i}`, createdAt, closedAt, r: isWin ? 1 : -1 }));
    t += (isWin ? 48 : 2) * 3600000; // jarak ke entry berikutnya
  }
  const stats = journalBiasStats(entries);
  assert.equal(stats.overtrading.signal, true);
  assert.ok(stats.overtrading.avg_gap_after_loss_h < stats.overtrading.avg_gap_after_win_h);
});

test('_journalBiasStats: overtrading signal false/null kalau jarak setelah loss TIDAK jauh lebih pendek', () => {
  const entries = [];
  let t = new Date('2026-07-01T00:00:00Z').getTime();
  for (let i = 0; i < 10; i++) {
    const isWin = i % 2 === 0;
    entries.push(mkEntry({ id: `t${i}`, createdAt: new Date(t).toISOString(), r: isWin ? 1 : -1 }));
    t += 24 * 3600000; // jarak konsisten, tidak ada pola revenge
  }
  const stats = journalBiasStats(entries);
  assert.equal(stats.overtrading.signal, false);
});

test('_journalBiasStats: distribusi sesi mengelompokkan entry berdasarkan jam UTC entry', () => {
  const entries = [
    // 5 entry jam 02:00 UTC (Tokyo)
    ...Array.from({ length: 5 }, (_, i) => mkEntry({ id: `tk${i}`, createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T02:00:00Z`, r: 1 })),
    // 5 entry jam 22:00 UTC (Closed/low liquidity), semuanya loss
    ...Array.from({ length: 5 }, (_, i) => mkEntry({ id: `cl${i}`, createdAt: `2026-07-${String(i + 10).padStart(2, '0')}T22:00:00Z`, r: -1 })),
  ];
  const stats = journalBiasStats(entries);
  const tokyo = stats.session_stats.find(s => s.session === 'tokyo');
  const closedSess = stats.session_stats.find(s => s.session === 'closed');
  assert.equal(tokyo.n, 5);
  assert.equal(tokyo.win_rate, 100);
  assert.equal(closedSess.n, 5);
  assert.equal(closedSess.win_rate, 0);
});

test('_journalBiasStats: win-rate per playbook dikelompokkan benar, null jadi "manual (tanpa checklist)"', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => mkEntry({ id: `smc${i}`, createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`, r: i < 4 ? 1 : -1, playbook: 'smc_ict' })),
    ...Array.from({ length: 4 }, (_, i) => mkEntry({ id: `man${i}`, createdAt: `2026-07-${String(i + 10).padStart(2, '0')}T10:00:00Z`, r: -1, playbook: null })),
  ];
  const stats = journalBiasStats(entries);
  const smc = stats.playbook_stats.find(p => p.playbook === 'smc_ict');
  const manual = stats.playbook_stats.find(p => p.playbook === 'manual (tanpa checklist)');
  assert.equal(smc.n, 6);
  assert.equal(smc.win_rate, 67); // 4/6
  assert.equal(manual.n, 4);
  assert.equal(manual.win_rate, 0);
});

test('_journalBiasStats: streak beruntun saat ini + loss streak terpanjang historis', () => {
  // Urutan kronologis: W L L L W W (streak saat ini = 2x win, longest loss streak = 3x)
  const results = [1, -1, -1, -1, 1, 1];
  const entries = results.map((r, i) => mkEntry({ id: `t${i}`, createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`, r }));
  entries.push(...Array.from({ length: 4 }, (_, i) => mkEntry({ id: `pad${i}`, createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`, r: 1 })));
  const stats = journalBiasStats(entries);
  assert.equal(stats.streak.current, 2);
  assert.equal(stats.streak.current_type, 'win');
  assert.equal(stats.streak.longest_loss_streak, 3);
});
