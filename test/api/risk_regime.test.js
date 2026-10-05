const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadRiskRegime() {
  delete require.cache[require.resolve('../../api/risk-regime.js')];
  return require('../../api/risk-regime.js');
}

test('MOVE memakai query2 Yahoo saat query1 gagal', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    if (url.includes('query1.finance.yahoo.com')) return { ok: false, status: 503 };
    if (url.includes('query2.finance.yahoo.com')) {
      return {
        ok: true,
        json: async () => ({ chart: { result: [{ meta: {
          regularMarketPrice: 98.26,
          previousClose: 96.5,
          regularMarketTime: 1791133200,
        } }] } }),
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const data = await loadRiskRegime()._fetchMove();
    assert.equal(data.latest, 98.3);
    assert.equal(data.prev, 96.5);
    assert.equal(data.source, 'yahoo');
    assert.equal(requested.length, 2);
    assert.match(requested[1], /query2\.finance\.yahoo\.com/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pelebaran HY saja adalah elevated, bukan risk-off', () => {
  const { _classifyRegime: classifyRegime } = loadRiskRegime();

  // Snapshot produksi 5 Oktober: kredit melebar 16bps, sementara VIX rendah
  // dan MOVE hanya elevated. Label harus tidak mengklaim penghindaran risiko luas.
  assert.equal(classifyRegime(15.31, 107.3, 0.16, -1.08), 'elevated');
  assert.equal(classifyRegime(16, 95, 0.16, 0.2), 'elevated');
});

test('ambang risk-off VIX dan MOVE tidak berubah', () => {
  const { _classifyRegime: classifyRegime } = loadRiskRegime();

  assert.equal(classifyRegime(25.01, 100, 0, 0), 'risk_off');
  assert.equal(classifyRegime(18, 130.01, 0, 0), 'risk_off');
});
