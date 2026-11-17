// test/vps/auto_entry_live_exposure_drift.test.js
// Audit AATAS 2026-11-17 (S487). vps/ di-deploy sebagai Docker image terisolasi,
// jadi definisi "posisi hidup" DIDUPLIKASI dari api/_auto_entry_guard.js
// (isLiveExposure) alih-alih di-require lintas folder — pola sama isCorroborated/
// isFxMarketOpen. Drift-guard ini menjaga keduanya tetap berperilaku identik,
// karena kalau salah satunya menyimpang, daemon bisa memicu review posisi untuk
// entri yang sudah selesai (close_early ghost / managed resolved) dan menghabiskan
// jatah POSREVIEW_DAILY_CAP.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isLiveAutoSetup } = require('../../vps/daemon.js');
const { isLiveExposure } = require('../../api/_auto_entry_guard.js');

const CASES = [
  null,
  undefined,
  {},
  { status: 'open' },                                              // posisi live biasa
  { status: 'pending' },                                           // limit order belum terisi
  { status: 'tp' },                                                // sudah resolve terminal
  { status: 'sl' },
  { status: 'canceled' },
  { status: 'expired' },
  { status: 'open', intervention: { type: 'close_early', t: 1 } },  // ghost U-5a
  { status: 'pending', intervention: { type: 'close_early', t: 1 } },
  { status: 'open', intervention: { type: 'tighten_sl', new_sl: 1 } },              // intervensi belum resolve
  { status: 'open', intervention: { type: 'tighten_sl', new_sl: 1 }, managed_status: 'sl' },
  { status: 'open', intervention: { type: 'tighten_sl', new_sl: 1 }, managed_status: 'ambiguous' },
  { status: 'open', intervention: { type: 'tighten_sl_preventive', new_sl: 1 }, managed_status: 'tp' },
  { status: 'open', intervention: { type: 'tighten_sl', new_sl: 1 }, managed_status: 'stale' },
  { status: 'open', intervention: { type: 'close_early', t: 1 }, managed_status: 'closed_early' },
  { status: 'open', entry_execution: 'aatas_rejection_h1_v1', choppy_management: { status: 'tp' } },
  { status: 'open', entry_execution: 'aatas_rejection_h1_v1', choppy_management: { status: 'sl' } },
  { status: 'open', entry_execution: 'aatas_rejection_h1_v1', choppy_management: { status: 'ambiguous' } },
  { status: 'open', entry_execution: 'aatas_rejection_h1_v1', choppy_management: {} },
  { status: 'pending', entry_execution: 'aatas_rejection_h1_v1' },
  { status: 'open', entry_execution: 'aatas_rejection_h1_v1', choppy_management: { status: 'tp' }, intervention: { type: 'tighten_sl', new_sl: 1 } },
];

test('drift-guard: isLiveAutoSetup daemon.js identik dengan isLiveExposure api/_auto_entry_guard.js', () => {
  for (const setup of CASES) {
    assert.equal(
      isLiveAutoSetup(setup),
      isLiveExposure(setup),
      `hasil beda untuk ${JSON.stringify(setup)}`
    );
  }
});
