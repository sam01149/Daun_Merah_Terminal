// Shared helpers for BTC data collection scripts (backfill + sync).
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'btc');

const FILES = {
  ohlcv_1h:          'ohlcv_1h.csv',
  ohlcv_4h:          'ohlcv_4h.csv',
  ohlcv_1d:          'ohlcv_1d.csv',
  cot_bitcoin:       'cot_bitcoin.csv',
  fear_greed:        'fear_greed.csv',
  btc_dominance:     'btc_dominance.csv',
  stablecoin_supply: 'stablecoin_supply.csv',
  hashrate:          'hashrate.csv',
};

const HEADERS = {
  ohlcv_1h:          ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  ohlcv_4h:          ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  ohlcv_1d:          ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  cot_bitcoin:       ['timestamp', 'date_iso', 'open_interest', 'noncomm_long', 'noncomm_short', 'noncomm_spread', 'comm_long', 'comm_short', 'nonreportable_long', 'nonreportable_short'],
  fear_greed:        ['timestamp', 'date_iso', 'value', 'classification'],
  btc_dominance:     ['timestamp', 'date_iso', 'btc_dominance_pct'],
  stablecoin_supply: ['timestamp', 'date_iso', 'usdt_market_cap', 'usdc_market_cap', 'total_stablecoin_cap'],
  hashrate:          ['timestamp', 'date_iso', 'avg_hashrate'],
};

function filePath(key) {
  return path.join(DATA_DIR, FILES[key]);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Reads the timestamp (ms) of the last row in a CSV, or null if file doesn't exist / has no rows.
function lastTimestamp(key) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return null;
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
  if (lines.length < 2) return null;
  const lastLine = lines[lines.length - 1];
  const ts = Number(lastLine.split(',')[0]);
  return Number.isFinite(ts) ? ts : null;
}

// Writes a fresh CSV (header + rows), overwriting any existing file. Rows are arrays matching HEADERS[key] order.
function writeCsv(key, rows) {
  ensureDataDir();
  const header = HEADERS[key].join(',');
  const body = rows.map(r => r.join(',')).join('\n');
  fs.writeFileSync(filePath(key), header + '\n' + body + (rows.length ? '\n' : ''));
}

// Appends rows to an existing CSV, creating it with a header if missing.
function appendCsv(key, rows) {
  if (!rows.length) return;
  ensureDataDir();
  const fp = filePath(key);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, HEADERS[key].join(',') + '\n');
  }
  const body = rows.map(r => r.join(',')).join('\n') + '\n';
  fs.appendFileSync(fp, body);
}

function rowCount(key) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return 0;
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
  return Math.max(0, lines.length - 1);
}

// Reads a CSV into an array of objects keyed by HEADERS[key], with numeric columns coerced to
// Number (everything except date_iso / classification, which stay strings). Sorted by timestamp.
function readCsv(key) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return [];
  const headers = HEADERS[key];
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').slice(1);
  const rows = lines.filter(Boolean).map(line => {
    const cells = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      const v = cells[i];
      obj[h] = (h === 'date_iso' || h === 'classification') ? v : Number(v);
    });
    return obj;
  });
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function fetchJson(url, attempt = 1) {
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 429 && attempt <= 3) {
      await sleep(1000 * attempt);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`${url} -> HTTP ${r.status}`);
  }
  return r.json();
}

// CoinGecko's free tier rate-limits aggressively (~429 after a handful of calls in quick
// succession) and the window is longer than a couple seconds — back off harder than fetchJson.
async function fetchJsonPatient(url, attempt = 1) {
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 429 && attempt <= 5) {
      await sleep(10000 * attempt);
      return fetchJsonPatient(url, attempt + 1);
    }
    throw new Error(`${url} -> HTTP ${r.status}`);
  }
  return r.json();
}

module.exports = { DATA_DIR, FILES, HEADERS, filePath, ensureDataDir, lastTimestamp, writeCsv, appendCsv, rowCount, readCsv, fetchJson, fetchJsonPatient, sleep };
