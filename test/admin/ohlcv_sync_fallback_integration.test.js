// test/ohlcv_sync_fallback_integration.test.js
// M1 kriteria selesai: "mematikan Yahoo secara artifisial (mock/ubah URL di test)
// -> sistem menyajikan candle dari fallback dengan shape identik". Test murni
// unit (ohlcv_fallback.test.js) sudah cek fetchFallbackCandles secara terisolasi;
// test ini memverifikasi WIRING end-to-end lewat handler admin.js action=ohlcv_sync
// sungguhan — Yahoo dipaksa gagal total, Twelve Data di-mock sukses, dan hasil
// akhir (response JSON) harus menandai source1h/source1d = 'twelvedata'.
//
// REVISI 2026-08-13 (Session 313): fallback Yahoo->TwelveData ini SEKARANG hanya
// berlaku untuk pair yang Yahoo memang primary-nya sendiri (AUD/NZD, CHF/JPY —
// tidak ada di Deriv map). Pair primary Deriv (9 pair lain) TIDAK LAGI fallback ke
// Yahoo/TwelveData kalau Deriv gagal — mereka di-skip (cache lama dipakai). Test
// ini SENGAJA tidak set DERIV_APP_ID supaya Deriv gagal utk semua pair juga, biar
// premis lama "Yahoo mati total" tetap bisa diuji tapi assert-nya disesuaikan:
// hanya 2 pair Yahoo-only yang benar-benar lewat rantai fallback TwelveData.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

test('ohlcv_sync: Yahoo mati total -> semua pair fallback ke Twelve Data, shape candle identik', async () => {
  process.env.TWELVEDATA_API_KEY = 'dummy-key-test';
  delete process.env.UPSTASH_REDIS_REST_URL; // redisCmd jadi no-op (return null), tidak butuh Redis nyata
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('query1.finance.yahoo.com')) {
      throw new Error('simulated Yahoo outage');
    }
    if (u.includes('api.twelvedata.com')) {
      return {
        status: 200,
        json: async () => ({
          status: 'ok',
          values: [
            { datetime: '2026-07-18 01:00:00', open: '1.0850', high: '1.0860', low: '1.0840', close: '1.0855', volume: '100' },
            { datetime: '2026-07-18 02:00:00', open: '1.0855', high: '1.0865', low: '1.0845', close: '1.0860', volume: '120' },
          ],
        }),
      };
    }
    // ta-warm fan-out (/api/correlations?action=ta) — allSettled saja, boleh gagal
    throw new Error('unhandled URL in test mock: ' + u);
  };

  delete require.cache[require.resolve('../../api/admin.js')];
  const handler = require('../../api/admin.js');
  const res = fakeRes();
  await handler({
    method: 'GET',
    query: { action: 'ohlcv_sync' },
    headers: { 'x-vercel-cron': '1' },
  }, res);

  global.fetch = origFetch;
  delete process.env.TWELVEDATA_API_KEY;

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.synced) && res.body.synced.length > 0, 'harus ada pair yang berhasil sync via fallback');

  const twelvedataPairs = res.body.synced.filter(p => p.source1h === 'twelvedata');
  const skippedPairs = res.body.synced.filter(p => p.source1h === 'skipped_deriv_down');

  // AUD/NZD & CHF/JPY: Yahoo-only, benar-benar lewat rantai fallback TwelveData.
  assert.deepEqual(twelvedataPairs.map(p => p.symbol).sort(), ['AUDNZD=X', 'CHFJPY=X']);
  for (const pair of twelvedataPairs) {
    assert.equal(pair.source1d, 'twelvedata', `${pair.symbol}: source1d harus twelvedata saat Yahoo mati`);
    assert.ok(pair.count1h > 0, `${pair.symbol}: candle 1h harus ada isinya`);
  }
  // 9 pair primary Deriv: Deriv gagal (DERIV_APP_ID tak diset) -> di-skip, BUKAN fallback Yahoo/TwelveData.
  assert.equal(skippedPairs.length, 9, '9 pair primary Deriv harus di-skip, bukan ikut fallback Yahoo/TwelveData');
  assert.equal(res.body.failed.length, 0, 'tidak boleh ada pair gagal total — pair Deriv di-skip (bukan gagal), pair Yahoo-only tertolong fallback');
});
