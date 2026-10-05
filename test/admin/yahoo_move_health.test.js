const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadAdmin() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

test('probe kesehatan MOVE hanya OK bila harga Yahoo valid, dan mencoba host mirror', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    if (url.includes('query1.finance.yahoo.com')) return { ok: false, status: 403 };
    if (url.includes('query2.finance.yahoo.com')) {
      return {
        ok: true,
        json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 101.04 } }] } }),
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const detail = await loadAdmin().probeYahooMove();
    assert.deepEqual(detail, { price: 101, host: 'query2.finance.yahoo.com' });
    assert.equal(requested.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
