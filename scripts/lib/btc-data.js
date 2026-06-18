// Shared helpers for BTC data collection scripts (backfill + sync).
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'btc');

const FILES = {
  ohlcv_1h:       'ohlcv_1h.csv',
  ohlcv_4h:       'ohlcv_4h.csv',
  ohlcv_1d:       'ohlcv_1d.csv',
  funding_rate:   'funding_rate.csv',
  open_interest:  'open_interest.csv',
  fear_greed:     'fear_greed.csv',
};

const HEADERS = {
  ohlcv_1h:      ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  ohlcv_4h:      ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  ohlcv_1d:      ['timestamp', 'date_iso', 'open', 'high', 'low', 'close', 'volume'],
  funding_rate:  ['timestamp', 'date_iso', 'funding_rate'],
  open_interest: ['timestamp', 'date_iso', 'open_interest', 'open_interest_value'],
  fear_greed:    ['timestamp', 'date_iso', 'value', 'classification'],
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

async function fetchJson(url, attempt = 1) {
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 429 && attempt <= 3) {
      await new Promise(res => setTimeout(res, 1000 * attempt));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`${url} -> HTTP ${r.status}`);
  }
  return r.json();
}

module.exports = { DATA_DIR, FILES, HEADERS, filePath, ensureDataDir, lastTimestamp, writeCsv, appendCsv, rowCount, fetchJson };
