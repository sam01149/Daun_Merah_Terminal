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

// ── Fallback provider: Twelve Data (M1, audit 2026-07-18) ──────────────────────
// Yahoo = titik gagal tunggal semua candle FX (blokir IP/ubah skema → seluruh
// tab TEK/Analisa/Kritikus/checklist kehilangan data serentak, tanpa notifikasi).
// Twelve Data free tier (diverifikasi 2026-07-18 via docs.twelvedata.com):
// 800 credit/hari, 8 request/menit, symbol forex format "EUR/USD" (BUKAN
// "EURUSD=X" ala Yahoo) — endpoint time_series, 1 credit/request terlepas dari
// outputsize. Dipakai HANYA saat Yahoo gagal/0 candle (lihat pemanggil di
// admin.js ohlcvSyncHandler & refreshOhlcvFromYahoo) — bukan sumber utama.
const YAHOO_TO_TWELVEDATA_SYMBOL = {
  'GC=F':     'XAU/USD',
  'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD', 'USDJPY=X': 'USD/JPY',
  'AUDUSD=X': 'AUD/USD', 'USDCAD=X': 'USD/CAD', 'USDCHF=X': 'USD/CHF',
  'NZDUSD=X': 'NZD/USD', 'EURJPY=X': 'EUR/JPY', 'GBPJPY=X': 'GBP/JPY',
  'EURGBP=X': 'EUR/GBP', 'AUDJPY=X': 'AUD/JPY', 'EURAUD=X': 'EUR/AUD',
  'GBPAUD=X': 'GBP/AUD', 'GBPCAD=X': 'GBP/CAD',
};

function mapYahooSymbolToTwelveData(yahooSymbol) {
  return YAHOO_TO_TWELVEDATA_SYMBOL[yahooSymbol] || null;
}

// Twelve Data time_series (timezone=UTC, order=asc) values[] -> shape IDENTIK
// dengan fetchYahooOhlcv1h/fetchYahooOhlcvDaily: {t (epoch detik UTC), o, h, l, c, v}
// — konsumen downstream (resampleTo4h, indikator, cache Redis) tidak berubah.
function normalizeTwelveDataCandles(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    if (!v || !v.datetime) continue;
    const o = parseFloat(v.open), h = parseFloat(v.high), l = parseFloat(v.low), c = parseFloat(v.close);
    if ([o, h, l, c].some(n => isNaN(n))) continue;
    // "YYYY-MM-DD HH:mm:ss" (timezone=UTC dari query) -> epoch detik UTC.
    const t = Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000);
    if (isNaN(t)) continue;
    out.push({ t, o: +o.toFixed(6), h: +h.toFixed(6), l: +l.toFixed(6), c: +c.toFixed(6), v: Math.round(parseFloat(v.volume) || 0) });
  }
  return out.sort((a, b) => a.t - b.t);
}

// interval: '1h' | '1d' (konvensi internal app, sama dengan key Redis ohlcv:<symbol>:<interval>).
async function fetchFallbackCandles(yahooSymbol, interval) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error('fetchFallbackCandles: TWELVEDATA_API_KEY belum diset');
  const tdSymbol = mapYahooSymbolToTwelveData(yahooSymbol);
  if (!tdSymbol) throw new Error(`fetchFallbackCandles: tidak ada mapping Twelve Data untuk ${yahooSymbol}`);
  const tdInterval = interval === '1d' ? '1day' : interval;
  // outputsize: 250 (1h) ~ mendekati window Yahoo range=10d (240 jam) untuk resampleTo4h
  // punya cukup bar; 140 (1d) ~ mendekati Yahoo range=6mo (~130 bar dagang). 1 credit/request
  // terlepas dari outputsize (docs.twelvedata.com), jadi tidak ada biaya tambahan minta lebih banyak.
  const outputsize = interval === '1d' ? 140 : 250;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&outputsize=${outputsize}&timezone=UTC&order=asc&apikey=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const json = await r.json();
  if (json.status === 'error' || !Array.isArray(json.values)) {
    throw new Error(`Twelve Data ${tdSymbol} ${tdInterval}: ${json.message || `HTTP ${r.status}`}`);
  }
  const candles = normalizeTwelveDataCandles(json.values);
  if (candles.length === 0) throw new Error(`Twelve Data ${tdSymbol} ${tdInterval}: 0 candle valid`);
  return candles;
}

// ── Primary provider FX: Deriv WebSocket API (Plan P, 2026-07-18) ──────────────
// Broker-grade, streaming-capable, 15/15 pair Daun Merah tersedia via `frx*` symbol.
// SENGAJA hanya 14 pair FX — XAU/USD (GC=F) TIDAK ikut migrasi: GC=F harga FUTURES,
// frxXAUUSD SPOT (level absolut beda beberapa dolar, campur sumber = zona konfluensi
// melompat) DAN GC=F volume dipakai analisis sedangkan Deriv tidak punya volume.
// Emas tetap Yahoo → PAXG Binance → Twelve Data (lihat fetchYahooOhlcv1h di atas).
//
// DERIV_APP_ID (2026-07-18): sementara pakai app_id PUBLIK 1089 — app_id dedicated
// yang didaftarkan user via developers.deriv.com TERNYATA tidak kompatibel dengan
// endpoint ws.derivws.com ini (server balas {"error":"InvalidAppID"}, diverifikasi
// live terhadap 3 titik server (ws/green/blue).derivws.com). Root cause: Deriv
// punya 2 sistem developer terpisah (portal baru developers.deriv.com vs API lama
// yang dipakai endpoint ini) yang app_id-nya belum/tidak saling kompatibel — belum
// ditemukan jalur self-service untuk app_id lama yang kompatibel (semua link
// "API developer" di akun mengarah ke portal baru). Risiko app_id publik: dibagi
// SEMUA developer dunia (rate limit bisa kena walau traffic kita sendiri kecil),
// dan Deriv bisa mematikan/membatasi 1089 sepihak kapan saja (bukan untuk trafik
// produksi). Ganti via env var DERIV_APP_ID begitu dapat app_id dedicated yang
// terbukti kompatibel — TIDAK perlu ubah kode apa pun di sini.
const YAHOO_TO_DERIV_SYMBOL = {
  'EURUSD=X': 'frxEURUSD', 'GBPUSD=X': 'frxGBPUSD', 'USDJPY=X': 'frxUSDJPY',
  'AUDUSD=X': 'frxAUDUSD', 'USDCAD=X': 'frxUSDCAD', 'USDCHF=X': 'frxUSDCHF',
  'NZDUSD=X': 'frxNZDUSD', 'EURJPY=X': 'frxEURJPY', 'GBPJPY=X': 'frxGBPJPY',
  'EURGBP=X': 'frxEURGBP', 'AUDJPY=X': 'frxAUDJPY', 'EURAUD=X': 'frxEURAUD',
  'GBPAUD=X': 'frxGBPAUD', 'GBPCAD=X': 'frxGBPCAD',
  // 'GC=F' SENGAJA TIDAK dipetakan — lihat catatan scope di atas.
};

function mapYahooSymbolToDeriv(yahooSymbol) {
  return YAHOO_TO_DERIV_SYMBOL[yahooSymbol] || null;
}

// interval: '1h' | '1d' (konvensi internal app, sama dengan fetchFallbackCandles).
// count: jumlah candle diminta — 250 (1h, ~mendekati window Yahoo range=10d untuk
// resampleTo4h) / 140 (1d, ~mendekati Yahoo range=6mo), sama dengan outputsize
// Twelve Data supaya konsisten window historis di seluruh fallback chain.
async function fetchDerivCandles(yahooSymbol, interval, count) {
  const derivSymbol = mapYahooSymbolToDeriv(yahooSymbol);
  if (!derivSymbol) throw new Error(`fetchDerivCandles: tidak ada mapping Deriv untuk ${yahooSymbol}`);
  const appId = process.env.DERIV_APP_ID;
  if (!appId) throw new Error('fetchDerivCandles: DERIV_APP_ID belum diset');
  const granularity = interval === '1d' ? 86400 : 3600;

  return new Promise((resolve, reject) => {
    // Timeout total 8s (Plan P-2) — di bawah timeout Yahoo (12s) supaya rantai
    // fallback Deriv→Yahoo→TwelveData tidak melar kalau Deriv lambat/down.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      reject(new Error(`fetchDerivCandles ${derivSymbol}: timeout 8s`));
    }, 8000);
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ ticks_history: derivSymbol, style: 'candles', granularity, count, end: 'latest' }));
    });
    ws.addEventListener('message', (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return reject(new Error(`fetchDerivCandles ${derivSymbol}: response bukan JSON valid`)); }
      if (data.error) return reject(new Error(`fetchDerivCandles ${derivSymbol}: ${data.error.code || 'error'} — ${data.error.message || ''}`));
      const raw = Array.isArray(data.candles) ? data.candles : [];
      if (raw.length === 0) return reject(new Error(`fetchDerivCandles ${derivSymbol}: 0 candle`));
      // Normalisasi ke shape {t,o,h,l,c,v} IDENTIK dengan Yahoo/Twelve Data — konsumen
      // downstream (resampleTo4h, indikator, cache Redis) tidak berubah. Deriv tanpa
      // volume (v:0) — FX Yahoo volumenya juga selalu 0, bukan regresi.
      const candles = raw
        .map(c => ({
          t: c.epoch,
          o: +parseFloat(c.open).toFixed(6), h: +parseFloat(c.high).toFixed(6),
          l: +parseFloat(c.low).toFixed(6), c: +parseFloat(c.close).toFixed(6),
          v: 0,
        }))
        .filter(c => !isNaN(c.o) && !isNaN(c.h) && !isNaN(c.l) && !isNaN(c.c))
        .sort((a, b) => a.t - b.t);
      if (candles.length === 0) return reject(new Error(`fetchDerivCandles ${derivSymbol}: 0 candle valid setelah normalisasi`));
      resolve(candles);
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`fetchDerivCandles ${derivSymbol}: WebSocket error`));
    });
  });
}

// Keputusan alert Telegram "Yahoo down" — pure function, dipanggil dari admin.js
// setelah update counter yahoo_fail_streak di Redis. threshold/cooldown eksplisit
// jadi param (bukan konstanta tersembunyi) supaya gampang diuji.
function shouldSendYahooAlert(streak, lastAlertTs, now, threshold = 3, cooldownMs = 6 * 60 * 60 * 1000) {
  if (streak < threshold) return false;
  if (!lastAlertTs) return true;
  return (now - lastAlertTs) >= cooldownMs;
}

module.exports = {
  fetchYahooOhlcv1h, fetchBinancePaxg1h,
  mapYahooSymbolToTwelveData, normalizeTwelveDataCandles, fetchFallbackCandles,
  mapYahooSymbolToDeriv, fetchDerivCandles,
  shouldSendYahooAlert,
};
