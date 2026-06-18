// Builds a merged feature matrix from all collected BTC datasets, for a given OHLCV timeframe.
// Lower-frequency series (weekly COT, daily sentiment/on-chain) are forward-filled onto the
// OHLCV timestamps — i.e. each row carries the latest known value as of that candle's time.
// Usage: node scripts/feature-engineering.js [4h|1d]   (defaults to building both)
'use strict';

const { readCsv, DATA_DIR } = require('./lib/btc-data');
const { sma, ema, rsi, macd, atr, bollingerPctB, zscore, pctChange } = require('./lib/indicators');
const fs = require('fs');
const path = require('path');

// Forward-fills `sourceRows` (sorted, each with .timestamp) onto `targetTimestamps` (sorted).
// Returns an array same length as targetTimestamps, each either the matching source row or null
// (null only for target timestamps that precede the source series' first entry).
function forwardFill(targetTimestamps, sourceRows) {
  const out = new Array(targetTimestamps.length).fill(null);
  let j = 0;
  for (let i = 0; i < targetTimestamps.length; i++) {
    while (j < sourceRows.length && sourceRows[j].timestamp <= targetTimestamps[i]) j++;
    out[i] = j > 0 ? sourceRows[j - 1] : null;
  }
  return out;
}

function buildFeatures(ohlcvKey, outFile) {
  const candles = readCsv(ohlcvKey);
  const cot      = readCsv('cot_bitcoin');
  const fng      = readCsv('fear_greed');
  const hash     = readCsv('hashrate');
  const stable   = readCsv('stablecoin_supply');
  const dom      = readCsv('btc_dominance');

  const ts     = candles.map(c => c.timestamp);
  const open   = candles.map(c => c.open);
  const high   = candles.map(c => c.high);
  const low    = candles.map(c => c.low);
  const close  = candles.map(c => c.close);
  const volume = candles.map(c => c.volume);

  // --- Price / volume technical features ---
  const ret1   = pctChange(close, 1);
  const ret6   = pctChange(close, 6);   // ~1 day on 4h candles, ~6 days on 1d candles
  const ret18  = pctChange(close, 18);  // ~3 days on 4h, ~18 days (~2.5wk) on 1d
  const logRet1 = close.map((c, i) => (i === 0) ? null : Math.log(c / close[i - 1]));
  const vol20  = zscore(logRet1.map(v => v === null ? 0 : v), 20); // realized-vol proxy via z-scored log returns
  const rsi14  = rsi(close, 14);
  const { macdLine, signal: macdSignal, hist: macdHist } = macd(close, 12, 26, 9);
  const atr14  = atr(high, low, close, 14);
  const bbPctB = bollingerPctB(close, 20, 2);
  const sma20  = sma(close, 20);
  const sma50  = sma(close, 50);
  const ema12  = ema(close, 12);
  const ema26  = ema(close, 26);
  const priceToSma20 = close.map((c, i) => sma20[i] === null ? null : c / sma20[i] - 1);
  const smaTrend      = close.map((_, i) => (sma20[i] === null || sma50[i] === null) ? null : (sma20[i] > sma50[i] ? 1 : 0));
  const volumeZ        = zscore(volume, 20);
  const volumeChangePct = pctChange(volume, 1);

  // --- External series, forward-filled onto each candle's timestamp ---
  const cotFf    = forwardFill(ts, cot);
  const fngFf    = forwardFill(ts, fng);
  const hashFf   = forwardFill(ts, hash);
  const stableFf = forwardFill(ts, stable);
  const domFf    = forwardFill(ts, dom);

  // COT week-over-week net positioning change needs the *previous* COT row, not just the ffilled one.
  const cotIndexByTs = new Map(cot.map((r, idx) => [r.timestamp, idx]));

  const rows = ts.map((t, i) => {
    const c = cotFf[i];
    let cotNetChange1w = null;
    if (c) {
      const idx = cotIndexByTs.get(c.timestamp);
      if (idx > 0) {
        const prevNet = cot[idx - 1].noncomm_long - cot[idx - 1].noncomm_short;
        const curNet = c.noncomm_long - c.noncomm_short;
        cotNetChange1w = curNet - prevNet;
      }
    }

    return {
      timestamp: t,
      date_iso: candles[i].date_iso,
      close: close[i],
      ret_1: ret1[i],
      ret_6: ret6[i],
      ret_18: ret18[i],
      log_ret_1: logRet1[i],
      volatility_z20: vol20[i],
      rsi_14: rsi14[i],
      macd: macdLine[i],
      macd_signal: macdSignal[i],
      macd_hist: macdHist[i],
      atr_14: atr14[i],
      bb_pctb: bbPctB[i],
      price_to_sma20: priceToSma20[i],
      sma20_gt_sma50: smaTrend[i],
      ema12_gt_ema26: (ema12[i] !== null && ema26[i] !== null) ? (ema12[i] > ema26[i] ? 1 : 0) : null,
      volume_z20: volumeZ[i],
      volume_change_pct: volumeChangePct[i],

      cot_open_interest: c ? c.open_interest : null,
      cot_net_noncomm: c ? c.noncomm_long - c.noncomm_short : null,
      cot_noncomm_long_pct: c ? c.noncomm_long / c.open_interest : null,
      cot_net_change_1w: cotNetChange1w,

      fear_greed: fngFf[i] ? fngFf[i].value : null,

      hashrate: hashFf[i] ? hashFf[i].avg_hashrate : null,

      stablecoin_total_cap: stableFf[i] ? stableFf[i].total_stablecoin_cap : null,

      btc_dominance_pct: domFf[i] ? domFf[i].btc_dominance_pct : null,

      // Forward-looking targets — null near the end of the series where future data doesn't exist yet.
      target_ret_6: (i + 6 < close.length) ? close[i + 6] / close[i] - 1 : null,
      target_ret_18: (i + 18 < close.length) ? close[i + 18] / close[i] - 1 : null,
      target_dir_6: (i + 6 < close.length) ? (close[i + 6] > close[i] ? 1 : 0) : null,
      target_dir_18: (i + 18 < close.length) ? (close[i + 18] > close[i] ? 1 : 0) : null,
    };
  });

  const headers = Object.keys(rows[0]);
  const csvLines = [headers.join(',')];
  for (const r of rows) {
    csvLines.push(headers.map(h => {
      const v = r[h];
      return (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) ? '' : v;
    }).join(','));
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, outFile), csvLines.join('\n') + '\n');
  console.log(`${outFile}: ${rows.length} rows, ${headers.length} columns`);
  return rows;
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === '4h') buildFeatures('ohlcv_4h', 'features_4h.csv');
  if (!arg || arg === '1d') buildFeatures('ohlcv_1d', 'features_1d.csv');
}

main();
