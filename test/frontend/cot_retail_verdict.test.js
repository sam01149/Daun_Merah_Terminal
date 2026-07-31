// test/frontend/cot_retail_verdict.test.js
// Section "Posisi & Bias" tab TEK (rapat 2026-07-31): verdict COT+retail
// digeneralisasi dari matriks divergensi tab COT (dulu cuma 4 pair hardcode)
// jadi reusable untuk 7 major pair + fallback COT-only untuk pair silang.
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
  'var cotData = null, retailData = null;',
  grab('const COT_RETAIL_PAIRS', '\nfunction renderCotDivergenceMatrix'),
].join('\n');

const api = new Function(src + `
  return {
    COT_RETAIL_PAIRS, computeCotRetailVerdict, computeCotOnlyLean,
    set: p => {
      if ('cotData'    in p) cotData    = p.cotData;
      if ('retailData' in p) retailData = p.retailData;
    },
  };
`)();

test('COT_RETAIL_PAIRS: 7 major pair (bukan cuma 4 seperti sebelumnya) — XAUUSD sengaja tidak masuk (belum ada COT Gold)', () => {
  const keys = Object.keys(api.COT_RETAIL_PAIRS);
  assert.deepStrictEqual(keys.sort(), ['AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'].sort());
  assert.ok(!keys.includes('XAUUSD'));
});

test('computeCotRetailVerdict: null kalau cotData/retailData belum ada', () => {
  api.set({ cotData: null, retailData: null });
  assert.strictEqual(api.computeCotRetailVerdict('EURUSD'), null);
});

test('computeCotRetailVerdict: null untuk pair yang tidak ada di COT_RETAIL_PAIRS (mis. cross/XAUUSD)', () => {
  api.set({
    cotData: { positions: { EUR: { lev_net: 5000 }, USD: { lev_net: -5000 } } },
    retailData: { positions: { EURUSD: { long_pct: 40, short_pct: 60, signal: 'NEUTRAL' } } },
  });
  assert.strictEqual(api.computeCotRetailVerdict('EURGBP'), null);
  assert.strictEqual(api.computeCotRetailVerdict('XAUUSD'), null);
});

test('computeCotRetailVerdict: retDir HARUS ikut signal server (65%/35%), bukan hitung ulang threshold sendiri — bug S270 lanjutan (data live 2026-07-31: EURUSD/GBPUSD/USDJPY/USDCAD/AUDUSD semua 58-62% short, di bawah 65% jadi NEUTRAL di panel retail, tapi badge ini sempat salah menganggapnya sinyal karena pakai cutoff 60%)', () => {
  api.set({
    cotData: { positions: { EUR: { lev_net: 20000 }, USD: { lev_net: -5000 } } }, // cotDir 'long'
    retailData: { positions: { EURUSD: { long_pct: 38, short_pct: 62, signal: 'NEUTRAL' } } }, // server: NEUTRAL (38 > 35)
  });
  const v = api.computeCotRetailVerdict('EURUSD');
  // retDir harus 'netral' (ikut signal), BUKAN 'long_signal' (yang akan terjadi kalau masih pakai cutoff 60%
  // lama: short_pct 62 >= 60 -> long_signal -> badge keliru jadi 'Divergensi Naik').
  assert.strictEqual(v.badge, 'Belum Jelas');
  assert.strictEqual(v.badgeCls, 'neutral');
});

test('computeCotRetailVerdict: Dorongan Naik Kuat — COT long + retail menumpuk short (kontrarian long)', () => {
  api.set({
    cotData: { positions: { EUR: { lev_net: 20000 }, USD: { lev_net: -5000 } } },
    retailData: { positions: { EURUSD: { long_pct: 30, short_pct: 70, signal: 'CONTRARIAN_LONG' } } },
  });
  const v = api.computeCotRetailVerdict('EURUSD');
  assert.strictEqual(v.badge, 'Dorongan Naik Kuat');
  assert.strictEqual(v.badgeCls, 'strong-up');
});

test('computeCotRetailVerdict: Divergensi Turun — COT short tapi retail juga menumpuk short', () => {
  api.set({
    cotData: { positions: { EUR: { lev_net: -20000 }, USD: { lev_net: 5000 } } },
    retailData: { positions: { EURUSD: { long_pct: 30, short_pct: 70, signal: 'CONTRARIAN_LONG' } } },
  });
  const v = api.computeCotRetailVerdict('EURUSD');
  assert.strictEqual(v.badge, 'Divergensi Turun');
  assert.strictEqual(v.badgeCls, 'strong-down');
});

test('computeCotRetailVerdict: Belum Jelas kalau COT & retail sama-sama netral', () => {
  api.set({
    cotData: { positions: { EUR: { lev_net: 200 }, USD: { lev_net: 100 } } },
    retailData: { positions: { EURUSD: { long_pct: 52, short_pct: 48, signal: 'NEUTRAL' } } },
  });
  const v = api.computeCotRetailVerdict('EURUSD');
  assert.strictEqual(v.badge, 'Belum Jelas');
  assert.strictEqual(v.badgeCls, 'neutral');
});

test('computeCotRetailVerdict: USDJPY (usdBase=true) — net dibalik supaya tetap "spekulan besar vs retail" bukan "USD vs JPY" mentah', () => {
  api.set({
    cotData: { positions: { USD: { lev_net: 20000 }, JPY: { lev_net: -5000 } } },
    retailData: { positions: { USDJPY: { long_pct: 70, short_pct: 30, signal: 'CONTRARIAN_SHORT' } } },
  });
  const v = api.computeCotRetailVerdict('USDJPY');
  // usdBase flip: cotNetPair = -(20000 - (-5000)) = -25000 -> cotDir short; retail long 70% -> retDir short_signal
  // -> Dorongan Turun Kuat
  assert.strictEqual(v.badge, 'Dorongan Turun Kuat');
});

test('computeCotOnlyLean: null kalau salah satu currency tidak ada datanya', () => {
  api.set({ cotData: { positions: { EUR: { lev_net: 1000 } } }, retailData: null });
  assert.strictEqual(api.computeCotOnlyLean('EUR', 'GBP'), null);
});

test('computeCotOnlyLean: dir long/short/netral murni dari net posisi base vs quote (tanpa retail)', () => {
  api.set({ cotData: { positions: { EUR: { lev_net: 15000 }, GBP: { lev_net: 2000 } } }, retailData: null });
  assert.strictEqual(api.computeCotOnlyLean('EUR', 'GBP').dir, 'long');

  api.set({ cotData: { positions: { EUR: { lev_net: 2000 }, GBP: { lev_net: 15000 } } }, retailData: null });
  assert.strictEqual(api.computeCotOnlyLean('EUR', 'GBP').dir, 'short');

  api.set({ cotData: { positions: { EUR: { lev_net: 500 }, GBP: { lev_net: 400 } } }, retailData: null });
  assert.strictEqual(api.computeCotOnlyLean('EUR', 'GBP').dir, 'netral');
});
