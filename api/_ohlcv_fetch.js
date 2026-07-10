// api/_ohlcv_fetch.js — fetch OHLCV 1 jam Yahoo Finance (+ fallback Binance PAXG
// untuk GC=F), diekstrak dari admin.js (plan G6 langkah persiapan) supaya bisa
// dipakai bersama oleh admin.js (ohlcv_sync/ohlcv_analyze) dan cb-status.js
// (?section=shock) tanpa duplikasi kode.
// Underscore prefix = bukan serverless function (limit Vercel Hobby 12/12 penuh).
//
// Catatan granularitas: interval=1h&range=10d adalah resolusi TERTINGGI yang
// tersedia di app ini — jendela reaksi 30-60 menit ala paper akademis tidak bisa
// direplikasi; konsumen harus men-scope analisis ke "reaksi per-jam".

async function fetchYahooOhlcv1h(symbol) {
  // range=10d — extended for 4H resampling over 10 days; ohlcv_sync stores only last 120 of the 1H result
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1h&range=10d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No chart result for ${symbol}`);
    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      const vol = q.volume?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
      candles.push({ t: timestamps[i], o: +o.toFixed(6), h: +h.toFixed(6), l: +l.toFixed(6), c: +c.toFixed(6), v: Math.round(vol || 0) });
    }
    if (candles.length === 0 && symbol === 'GC=F') throw new Error('Yahoo GC=F: 0 valid candles');
    return candles;
  } catch (e) {
    if (symbol === 'GC=F') {
      console.warn(`fetchYahooOhlcv1h: Yahoo GC=F failed (${e.message}), falling back to Binance PAXG`);
      return fetchBinancePaxg1h(250);
    }
    throw e;
  }
}

// Binance PAXG/USDT klines — fallback for GC=F when Yahoo fails.
// 1 PAXG = 1 troy oz gold stored in Brink's vault; tracks XAU spot within ~0.1%.
// No auth required; public market-data endpoint.
async function fetchBinancePaxg1h(limit = 250) {
  const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=${limit}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Binance PAXG HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Binance PAXG: empty response');
  return rows.map(row => ({
    t: Math.floor(Number(row[0]) / 1000),  // openTime ms → s
    o: +parseFloat(row[1]).toFixed(2),
    h: +parseFloat(row[2]).toFixed(2),
    l: +parseFloat(row[3]).toFixed(2),
    c: +parseFloat(row[4]).toFixed(2),
    v: Math.round(parseFloat(row[5])),
  }));
}

module.exports = { fetchYahooOhlcv1h, fetchBinancePaxg1h };
