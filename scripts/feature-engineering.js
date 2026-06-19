// Builds a merged feature matrix from all collected BTC datasets, for a given OHLCV timeframe.
// Lower-frequency series (weekly COT, daily sentiment/on-chain) are forward-filled onto the
// OHLCV timestamps — i.e. each row carries the latest known value as of that candle's time.
// Usage: node scripts/feature-engineering.js [4h|1d]   (defaults to building both)
'use strict';

const { readCsv, DATA_DIR } = require('./lib/btc-data');
const { sma, ema, rsi, macd, atr, bollingerPctB, zscore, pctChange, stdev, rollingQuantile } = require('./lib/indicators');
const fs = require('fs');
const path = require('path');

const VOL_REGIME_HORIZON = 6;            // same horizon as target_dir_6, for direct comparison
const VOL_REGIME_QUANTILE_WINDOW = 500;  // trailing window for the adaptive threshold
const VOL_REGIME_QUANTILE = 0.70;        // "high vol" = top 30% of recent forward-vol readings

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
  const dvol     = readCsv('dvol');

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

  // --- Realized volatility (the actual LEVEL of vol, unlike volatility_z20 above which is a
  // z-scored return — "how unusual is today's return", not "how volatile is the market right
  // now"). Validated experimentally (ml/volatility_regime.py) to predict forward volatility
  // regime far better than any direction-prediction feature found so far (CV AUC ~0.63 vs ~0.53).
  const logRet1Filled = logRet1.map(v => v === null ? 0 : v);
  const realizedVol6  = stdev(logRet1Filled, 6);
  const realizedVol20 = stdev(logRet1Filled, 20);
  const parkinsonVol  = high.map((h, i) => Math.sqrt((1 / (4 * Math.log(2))) * (Math.log(h / low[i]) ** 2)));
  const parkinsonVolMean6 = sma(parkinsonVol, 6);

  // Forward-looking realized vol over the next VOL_REGIME_HORIZON periods, compared against an
  // adaptive trailing quantile (BTC's baseline vol level in 2018 isn't comparable to 2024's, so
  // a fixed cutoff would drift out of relevance — same reasoning as the COT normalization fix).
  const trailingStd6ForForward = stdev(logRet1Filled, VOL_REGIME_HORIZON);
  const forwardVol = trailingStd6ForForward.map((_, i) =>
    (i + VOL_REGIME_HORIZON < trailingStd6ForForward.length) ? trailingStd6ForForward[i + VOL_REGIME_HORIZON] : null);
  const volRegimeThreshold = rollingQuantile(forwardVol, VOL_REGIME_QUANTILE_WINDOW, VOL_REGIME_QUANTILE, 100);
  const targetVolRegime6 = forwardVol.map((v, i) =>
    (v === null || volRegimeThreshold[i] === null) ? null : (v > volRegimeThreshold[i] ? 1 : 0));

  // --- External series, forward-filled onto each candle's timestamp ---
  // CFTC publishes COT on Fridays, but the report's "as of" date (our stored timestamp) is the
  // preceding Tuesday — a ~3-day reporting lag. Forward-filling on the raw timestamp would let a
  // candle "see" Tuesday's positioning data before it was actually public (lookahead bias). Shift
  // by the publish lag for forward-fill purposes only, before joining — that's also why the COT
  // index lookup below keys off the *shifted* timestamp (cotForFf), not the original.
  const COT_PUBLISH_LAG_MS = 3 * 86400e3;
  const cotForFf = cot.map(r => ({ ...r, timestamp: r.timestamp + COT_PUBLISH_LAG_MS }));

  // Raw open_interest and net positioning (long - short) trend upward over the years simply
  // because the CME Bitcoin futures market has grown — feeding that raw, non-stationary level
  // into a model risks it learning "what year is it" rather than real positioning signal (the
  // same problem we already avoid by excluding raw close price). Transform both to stationary
  // measures computed on COT's native weekly cadence, before forward-filling:
  //   - cot_open_interest_z: rolling z-score vs the trailing ~1y (52 reports) of open interest
  //   - cot_net_pct: net positioning as a % of that week's open interest (self-normalizing —
  //     doesn't need a rolling window since it's already relative to current market size)
  const cotOiZ     = zscore(cot.map(r => r.open_interest), 52);
  const cotNetPctArr = cot.map(r => (r.noncomm_long - r.noncomm_short) / r.open_interest);

  const cotFf    = forwardFill(ts, cotForFf);
  const fngFf    = forwardFill(ts, fng);
  const hashFf   = forwardFill(ts, hash);
  const stableFf = forwardFill(ts, stable);
  const domFf    = forwardFill(ts, dom);
  const dvolFf   = forwardFill(ts, dvol);

  // DVOL is Deribit's BTC implied-volatility index — the market's own forward-looking volatility
  // expectation, a different kind of information than the realized-vol features above (which
  // only look backward). dvolChange1 uses the *native* hourly DVOL series (not the candle-level
  // forward-fill) so consecutive candles within the same DVOL reading don't show a spurious 0.
  const dvolIndexByTs = new Map(dvol.map((r, idx) => [r.timestamp, idx]));

  // COT week-over-week net positioning change needs the *previous* COT row, not just the ffilled one.
  // Indexed by the shifted timestamp since that's what cotFf rows carry (see above).
  const cotIndexByTs = new Map(cotForFf.map((r, idx) => [r.timestamp, idx]));

  const rows = ts.map((t, i) => {
    const c = cotFf[i];
    const cotIdx = c ? cotIndexByTs.get(c.timestamp) : undefined;
    // Change in the already-normalized net_pct, not raw contract counts — same stationarity
    // reasoning as above applies to the week-over-week delta.
    let cotNetChange1w = null;
    if (cotIdx > 0) {
      cotNetChange1w = cotNetPctArr[cotIdx] - cotNetPctArr[cotIdx - 1];
    }

    const dvolIdx = dvolFf[i] ? dvolIndexByTs.get(dvolFf[i].timestamp) : undefined;
    let dvolChange1 = null;
    if (dvolIdx > 0) dvolChange1 = dvol[dvolIdx].close - dvol[dvolIdx - 1].close;

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
      realized_vol_6: realizedVol6[i],
      realized_vol_20: realizedVol20[i],
      parkinson_vol_mean_6: parkinsonVolMean6[i],

      cot_open_interest_z: cotIdx !== undefined ? cotOiZ[cotIdx] : null,
      cot_net_pct: cotIdx !== undefined ? cotNetPctArr[cotIdx] : null,
      cot_noncomm_long_pct: c ? c.noncomm_long / c.open_interest : null,
      cot_net_change_1w: cotNetChange1w,

      fear_greed: fngFf[i] ? fngFf[i].value : null,

      hashrate: hashFf[i] ? hashFf[i].avg_hashrate : null,

      stablecoin_total_cap: stableFf[i] ? stableFf[i].total_stablecoin_cap : null,

      btc_dominance_pct: domFf[i] ? domFf[i].btc_dominance_pct : null,

      dvol_close: dvolFf[i] ? dvolFf[i].close : null,
      dvol_change_1: dvolChange1,

      // Forward-looking targets — null near the end of the series where future data doesn't exist yet.
      target_ret_6: (i + 6 < close.length) ? close[i + 6] / close[i] - 1 : null,
      target_ret_18: (i + 18 < close.length) ? close[i + 18] / close[i] - 1 : null,
      target_dir_6: (i + 6 < close.length) ? (close[i + 6] > close[i] ? 1 : 0) : null,
      target_dir_18: (i + 18 < close.length) ? (close[i + 18] > close[i] ? 1 : 0) : null,
      // Validated far more predictable than price direction (ml/volatility_regime.py, walk-
      // forward CV AUC ~0.63 vs ~0.53 for direction) — 1 = forward realized vol in the top 30%
      // of its trailing 500-period range, 0 = otherwise.
      target_vol_regime_6: targetVolRegime6[i],
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
