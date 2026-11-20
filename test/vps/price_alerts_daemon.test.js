// test/vps/price_alerts_daemon.test.js — PLAN AJ: evaluasi harga live + format
// notifikasi Telegram alert harga, diuji sebagai fungsi murni tanpa network.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../../vps/daemon.js');

const baseAlert = (over = {}) => ({
  id: 'pa_1', pair: 'EURUSD', target_price: 1.08500, direction: 'touch', note: '', ...over,
});

// ── evaluatePriceAlert ───────────────────────────────────────────────────────

test('evaluatePriceAlert: touch bernilai benar saat harga menyentuh level', () => {
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08500, 1.08480), true);
  // toleransi 1 pip: 1.08509 masih dihitung menyentuh
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08509, 1.08480), true);
  // 5 pip jauh = belum
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08450, 1.08440), false);
});

test('evaluatePriceAlert: touch ikut terpicu saat tick MELGOMPATI level (gap)', () => {
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08520, 1.08480), true);
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08470, 1.08510), true);
});

test('evaluatePriceAlert: cross_up butuh perpindahan sisi, bukan kesamaan persis', () => {
  const alert = baseAlert({ direction: 'cross_up' });
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08520, 1.08480), true, 'gap melewati target tetap terdeteksi');
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08520, 1.08510), false, 'sudah di atas sejak tick sebelumnya bukan tembus baru');
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08490, 1.08480), false);
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08500, 1.08499), true, 'tepat di level dihitung tembus');
});

test('evaluatePriceAlert: cross_down cermin dari cross_up', () => {
  const alert = baseAlert({ direction: 'cross_down' });
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08470, 1.08520), true);
  assert.equal(daemon.evaluatePriceAlert(alert, 1.08470, 1.08480), false, 'sudah di bawah sejak awal bukan tembus baru');
});

test('evaluatePriceAlert: sampel pertama (prev null) tidak pernah memicu', () => {
  assert.equal(daemon.evaluatePriceAlert(baseAlert({ direction: 'cross_up' }), 1.08600, null), false);
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), 1.08500, null), true, 'touch boleh dari sampel pertama');
});

test('evaluatePriceAlert: input rusak gagal-tertutup', () => {
  assert.equal(daemon.evaluatePriceAlert(null, 1.085, 1.084), false);
  assert.equal(daemon.evaluatePriceAlert(baseAlert({ target_price: 'x' }), 1.085, 1.084), false);
  assert.equal(daemon.evaluatePriceAlert(baseAlert(), NaN, 1.084), false);
  assert.equal(daemon.evaluatePriceAlert(baseAlert({ target_price: 0 }), 1.085, 1.084), false);
});

test('alertPipSize: JPY 0.01, XAU 0.1, FX mayor 0.0001', () => {
  assert.equal(daemon.alertPipSize('USDJPY'), 0.01);
  assert.equal(daemon.alertPipSize('XAUUSD'), 0.1);
  assert.equal(daemon.alertPipSize('EURUSD'), 0.0001);
});

// ── Format notifikasi Telegram ───────────────────────────────────────────────

test('formatPriceAlertTelegram: format lengkap, tanpa emoji, waktu WIB benar', () => {
  const nowMs = Date.UTC(2026, 10, 20, 13, 5); // 20:05 WIB
  const text = daemon.formatPriceAlertTelegram(
    baseAlert({ note: 'Retest S/R' }),
    { currentPrice: 1.08501, previousPrice: 1.08480, nowMs }
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '*[ALERT HARGA - DAUN MERAH]*');
  assert.equal(lines[1], 'Pair: EUR/USD');
  assert.equal(lines[2], 'Status: Harga menyentuh level alert');
  assert.equal(lines[3], 'Level Target: 1.08500');
  assert.equal(lines[4], 'Harga Pasar: 1.08501 (dari bawah)');
  assert.equal(lines[5], 'Waktu: 20:05 WIB');
  assert.equal(lines[6], 'Catatan: Retest S/R');
  // ATURAN.md §4.1 — tidak boleh ada emoji / karakter non-ASCII di pesan UI.
  assert.equal(/[^\x00-\x7F]/.test(text), false, 'pesan Telegram wajib ASCII murni (tanpa emoji)');
});

test('formatPriceAlertTelegram: status cross + label XAU + catatan kosong', () => {
  const nowMs = Date.UTC(2026, 10, 20, 0, 0); // 07:00 WIB
  const text = daemon.formatPriceAlertTelegram(
    { id: 'pa_2', pair: 'XAUUSD', target_price: 2650.5, direction: 'cross_down', note: '' },
    { currentPrice: 2650.1, previousPrice: 2650.9, nowMs }
  );
  assert.match(text, /Pair: XAU\/USD/);
  assert.match(text, /Status: Harga menembus turun level alert/);
  assert.match(text, /Level Target: 2650\.50/);
  assert.match(text, /Harga Pasar: 2650\.10 \(dari atas\)/);
  assert.match(text, /Waktu: 07:00 WIB/);
  assert.match(text, /Catatan: Tidak ada catatan/);
  assert.equal(/[^\x00-\x7F]/.test(text), false);
});

test('formatPriceAlertTelegram: desimal JPY 3 digit', () => {
  const text = daemon.formatPriceAlertTelegram(
    { id: 'pa_3', pair: 'USDJPY', target_price: 154.25, direction: 'touch', note: '' },
    { currentPrice: 154.249, previousPrice: 154.26, nowMs: Date.UTC(2026, 10, 20, 2, 0) }
  );
  assert.match(text, /Level Target: 154\.250/);
  assert.match(text, /Harga Pasar: 154\.249/);
});

// ── Sumber harga: langsung vs silang ─────────────────────────────────────────

test('alertPairPrice: pakai harga langsung bila pair tersedia dan segar', () => {
  const now = 1_000_000;
  const rates = { EURUSD: 1.085 };
  const at = { EURUSD: now - 1000 };
  assert.equal(daemon.alertPairPrice('EURUSD', rates, at, now), 1.085);
});

test('alertPairPrice: NZDCAD dihitung silang NZDUSD x USDCAD', () => {
  const now = 1_000_000;
  const rates = { NZDUSD: 0.6, USDCAD: 1.4 };
  const at = { NZDUSD: now - 1000, USDCAD: now - 1000 };
  // 1 NZD = 0.6 USD, 1 USD = 1.4 CAD -> 1 NZD = 0.84 CAD
  assert.equal(daemon.alertPairPrice('NZDCAD', rates, at, now), 0.6 * 1.4);
});

test('alertPairPrice: CADCHF dihitung dari USDCAD dan USDCHF (keduanya terbalik)', () => {
  const now = 1_000_000;
  const rates = { USDCAD: 1.4, USDCHF: 0.88 };
  const at = { USDCAD: now - 1000, USDCHF: now - 1000 };
  // 1 CAD = (1/1.4) USD, 1 USD = 0.88 CHF -> selisih floating point wajar
  const expected = (1 / 1.4) * 0.88;
  assert.ok(Math.abs(daemon.alertPairPrice('CADCHF', rates, at, now) - expected) < 1e-12);
});

test('alertPairPrice: harga basi (> 3 menit) tidak dipakai — lebih baik tunggu daripada kirim level salah', () => {
  const now = 10_000_000;
  const rates = { NZDUSD: 0.6, USDCAD: 1.4 };
  const at = { NZDUSD: now - 10 * 60 * 1000, USDCAD: now - 10 * 60 * 1000 };
  assert.equal(daemon.alertPairPrice('NZDCAD', rates, at, now), null);
  assert.equal(daemon.alertPairPrice('EURUSD', { EURUSD: 1.1 }, { EURUSD: now - 10 * 60 * 1000 }, now), null);
});

// ── Rencana langganan tick ───────────────────────────────────────────────────

test('planAlertSymbols: pair tanpa simbol Deriv langsung memakai leg USD (tanpa langganan baru)', () => {
  const symbols = daemon.planAlertSymbols([{ pair: 'NZDCAD', target_price: 0.79 }]);
  // NZDUSD & USDCAD sudah dialirkan candle Q-3, jadi tidak perlu langganan tick.
  assert.deepEqual([...symbols], []);
});

test('planAlertSymbols: pair yang punya simbol Deriv tapi tidak dialirkan candle ikut dilanggan', () => {
  assert.deepEqual([...daemon.planAlertSymbols([{ pair: 'EURCAD', target_price: 1.57 }])], ['frxEURCAD']);
  assert.deepEqual([...daemon.planAlertSymbols([{ pair: 'XAUUSD', target_price: 2650 }])], ['frxXAUUSD']);
});

test('planAlertSymbols: pair yang sudah dialirkan candle tidak menambah langganan', () => {
  assert.deepEqual([...daemon.planAlertSymbols([{ pair: 'EURUSD', target_price: 1.1 }, { pair: 'GBPJPY', target_price: 200 }])], []);
});

test('planAlertSymbols: daftar alert kosong = tidak ada langganan', () => {
  assert.deepEqual([...daemon.planAlertSymbols([])], []);
});

test('ALERT_DERIV_SYMBOLS: 4 pair yang tidak tersedia di feed Deriv TIDAK didaftarkan', () => {
  // Dokumentasi hidup: kalau Deriv menambah simbol ini, test ini yang mengingatkan
  // untuk memindahkannya dari jalur silang ke jalur langsung.
  for (const pair of ['NZDCAD', 'NZDCHF', 'CADCHF', 'CADJPY']) {
    assert.equal(daemon.ALERT_DERIV_SYMBOLS.includes('frx' + pair), false);
  }
  assert.equal(daemon.ALERT_DERIV_SYMBOLS.includes('frxXAUUSD'), true);
});
