// Plain-JS technical indicators over arrays of numbers. No external deps.
// Every function returns an array the same length as the input, with `null` for indices
// where there isn't enough history yet to compute a value.
'use strict';

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i >= period - 1) {
        // seed with SMA of the first `period` values
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's RSI.
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = null, avgLoss = null;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (avgGain === null) {
      if (i >= period) {
        let gSum = 0, lSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const c = closes[j] - closes[j - 1];
          gSum += Math.max(c, 0);
          lSum += Math.max(-c, 0);
        }
        avgGain = gSum / period;
        avgLoss = lSum / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] !== null && emaSlow[i] !== null) ? emaFast[i] - emaSlow[i] : null);
  // signal = EMA of macdLine, but ema() expects no leading nulls — feed only the defined tail.
  const firstValid = macdLine.findIndex(v => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (firstValid !== -1) {
    const tail = macdLine.slice(firstValid);
    const signalTail = ema(tail, signalPeriod);
    signalTail.forEach((v, i) => { signal[firstValid + i] = v; });
  }
  const hist = closes.map((_, i) => (macdLine[i] !== null && signal[i] !== null) ? macdLine[i] - signal[i] : null);
  return { macdLine, signal, hist };
}

// Wilder's ATR.
function atr(highs, lows, closes, period = 14) {
  const tr = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { tr[i] = highs[i] - lows[i]; continue; }
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const out = new Array(closes.length).fill(null);
  let prevAtr = null;
  for (let i = 0; i < tr.length; i++) {
    if (prevAtr === null) {
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += tr[j];
        prevAtr = sum / period;
        out[i] = prevAtr;
      }
    } else {
      prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
      out[i] = prevAtr;
    }
  }
  return out;
}

// Bollinger %B: 0 = price at lower band, 1 = price at upper band.
function bollingerPctB(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  return closes.map((c, i) => {
    if (mid[i] === null || sd[i] === null || sd[i] === 0) return null;
    const upper = mid[i] + mult * sd[i];
    const lower = mid[i] - mult * sd[i];
    return (c - lower) / (upper - lower);
  });
}

// Rolling z-score: (value - rolling mean) / rolling stdev.
function zscore(values, period) {
  const mean = sma(values, period);
  const sd = stdev(values, period);
  return values.map((v, i) => (mean[i] === null || sd[i] === null || sd[i] === 0) ? null : (v - mean[i]) / sd[i]);
}

// Percent return looking back `n` steps: (v[i] / v[i-n]) - 1.
function pctChange(values, n) {
  return values.map((v, i) => (i < n) ? null : (v / values[i - n] - 1));
}

module.exports = { sma, stdev, ema, rsi, macd, atr, bollingerPctB, zscore, pctChange };
