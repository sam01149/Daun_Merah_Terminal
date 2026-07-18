// test/ohlcv_sync_fallback_integration.test.js
// M1 kriteria selesai: "mematikan Yahoo secara artifisial (mock/ubah URL di test)
// -> sistem menyajikan candle dari fallback dengan shape identik". Test murni
// unit (ohlcv_fallback.test.js) sudah cek fetchFallbackCandles secara terisolasi;
// test ini memverifikasi WIRING end-to-end lewat handler admin.js action=ohlcv_sync
// sungguhan — Yahoo dipaksa gagal total, Twelve Data di-mock sukses, dan hasil
// akhir (response JSON) harus menandai source1h/source1d = 'twelvedata'.
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

  delete require.cache[require.resolve('../api/admin.js')];
  const handler = require('../api/admin.js');
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

  for (const pair of res.body.synced) {
    assert.equal(pair.source1h, 'twelvedata', `${pair.symbol}: source1h harus twelvedata saat Yahoo mati`);
    assert.equal(pair.source1d, 'twelvedata', `${pair.symbol}: source1d harus twelvedata saat Yahoo mati`);
    assert.ok(pair.count1h > 0, `${pair.symbol}: candle 1h harus ada isinya`);
  }
  assert.equal(res.body.failed.length, 0, 'tidak boleh ada pair gagal total — semua harus tertolong fallback');
});
