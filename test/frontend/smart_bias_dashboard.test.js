const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `marker awal tidak ditemukan: ${start}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `marker akhir tidak ditemukan: ${end}`);
  return html.slice(from, to);
}

test('Dashboard memakai tabel Smart Bias enam kolom data dan tidak lagi memakai briefing utama', () => {
  const markup = between('<!-- DASHBOARD PANEL -->', '<!-- COT PANEL -->');
  assert.match(markup, /SMART BIAS · WEEK AHEAD/);
  assert.match(markup, /id="dashSmartBiasSection"/);
  assert.doesNotMatch(markup, /id="dashDigestSection"|id="dashBiasList"|id="dashFundStrip"|id="dashRetailStrip"/);

  const renderer = between('function renderDashSmartBias()', '\nfunction renderDashPositionAlerts()');
  for (const heading of ['Growth', 'Inflation', 'Central bank', 'Banks', 'Positioning', 'Overall']) {
    assert.match(renderer, new RegExp(`<th>${heading}</th>`));
  }
  assert.doesNotMatch(renderer, /<th>Trend<\/th>|<th>Seasonality<\/th>/);
  assert.match(html, /@media \(max-width: 1023px\)[\s\S]*?#dashboardPanel\.visible \{ display:flex;/);
  assert.match(html, /view:'dashboard',\s+label:'Dashboard'/);
});

test('Positioning menjaga Institutional dan Retail terpisah serta hanya Dukascopy yang menjadi label source', () => {
  const renderer = between('function renderDashSmartBias()', '\nfunction renderDashPositionAlerts()');
  assert.match(renderer, />Inst</);
  assert.match(renderer, />Retail</);
  assert.match(renderer, /src: Dukascopy/);
  assert.doesNotMatch(renderer, /FinancialJuice|FXSSI|Yahoo|Deriv|Twelve Data/);
});

test('Teknikal mengganti selector MTF dan kartu RSI/SMA dengan pemeriksaan Prime 3 langkah', () => {
  const markup = between('<!-- TEKNIKAL PANEL -->', '<!-- DASHBOARD PANEL -->');
  assert.match(markup, /id="tekPrimePanel"/);
  assert.doesNotMatch(markup, /mtfSelD1|mtfSelH4|mtfSelH1|mtfSelM15|id="tekTaPanel"/);

  const renderer = between('function renderPrimeExecution()', '\nasync function fetchPrimeExecution');
  assert.match(renderer, /Trend D1/);
  assert.match(renderer, /Arah H4/);
  assert.match(renderer, /Kekuatan/);
  assert.match(renderer, /ATR 14 H6/);
  assert.match(renderer, /Dua dari tiga tetap WAIT/);
});

test('Konfirmasi kata jelas terikat snapshot dan data lama tidak bisa memberi BUY/SELL', () => {
  const verdict = between('function tekPrimeVerdict(', '\nfunction tekPrimeManualFor');
  const manual = between('function tekPrimeManualFor(', '\nfunction setPrimeTrend');
  assert.match(verdict, /data\.stale/);
  assert.match(verdict, /return 'WAIT'/);
  assert.match(manual, /saved\.snapshot_key !== data\?\.trend\?\.snapshot_key/);
});
