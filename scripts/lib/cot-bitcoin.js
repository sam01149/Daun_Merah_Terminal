// CFTC Commitments of Traders — CME Bitcoin futures (Legacy Futures Only report).
// Free, official (cftc.gov), weekly, not subject to the US-IP geo-block that affects crypto
// exchange futures APIs (fapi.binance.com etc). Used as the open-interest / positioning source.
'use strict';

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { execFileSync } = require('child_process');

const CONTRACT_CODE = '133741'; // BITCOIN - CHICAGO MERCANTILE EXCHANGE

// annual.txt column indices (0-based) we need, per CFTC's documented Legacy report layout.
const COL = {
  dateIso:       2,
  contractCode:  3,
  openInterest:  7,
  noncommLong:   8,
  noncommShort:  9,
  noncommSpread: 10,
  commLong:      11,
  commShort:     12,
  nonreptLong:   15,
  nonreptShort:  16,
};

function parseAnnualTxt(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i];
    if (!line.includes(CONTRACT_CODE)) continue;
    const fields = line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
    if (fields[COL.contractCode] !== CONTRACT_CODE) continue;
    const ts = Date.parse(fields[COL.dateIso] + 'T00:00:00Z');
    if (!Number.isFinite(ts)) continue;
    rows.push([
      ts,
      new Date(ts).toISOString(),
      Number(fields[COL.openInterest]),
      Number(fields[COL.noncommLong]),
      Number(fields[COL.noncommShort]),
      Number(fields[COL.noncommSpread]),
      Number(fields[COL.commLong]),
      Number(fields[COL.commShort]),
      Number(fields[COL.nonreptLong]),
      Number(fields[COL.nonreptShort]),
    ]);
  }
  return rows;
}

// Downloads + extracts one year's Legacy Futures Only COT zip and returns Bitcoin rows.
// 404 means the year predates CME Bitcoin futures (launched Dec 2017) or hasn't been published yet.
// Uses curl rather than fetch() — cftc.gov sits behind Cloudflare bot management that 403s
// Node's fetch (undici) regardless of headers, but passes plain curl requests through fine.
async function fetchCotBitcoinYear(year) {
  const url = `https://www.cftc.gov/files/dea/history/deacot${year}.zip`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cot-btc-'));
  try {
    const zipPath = path.join(tmpDir, 'cot.zip');
    const status = execFileSync('curl', ['-s', '-o', zipPath, '-w', '%{http_code}', url]).toString().trim();
    if (status === '404') return [];
    if (status !== '200') throw new Error(`${url} -> HTTP ${status}`);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', tmpDir]);
    const text = fs.readFileSync(path.join(tmpDir, 'annual.txt'), 'utf8');
    return parseAnnualTxt(text);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Full backfill across all years CME Bitcoin futures have existed.
async function fetchCotBitcoinAll(startYear = 2018) {
  const endYear = new Date().getUTCFullYear();
  const all = [];
  for (let y = startYear; y <= endYear; y++) {
    all.push(...(await fetchCotBitcoinYear(y)));
  }
  all.sort((a, b) => a[0] - b[0]);
  return all;
}

module.exports = { CONTRACT_CODE, fetchCotBitcoinYear, fetchCotBitcoinAll };
