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

test('Dashboard memakai tabel arah mata uang enam kolom data dan tidak lagi memakai briefing utama', () => {
  const markup = between('<!-- DASHBOARD PANEL -->', '<!-- COT PANEL -->');
  assert.match(markup, /ARAH MATA UANG MINGGU INI/);
  assert.doesNotMatch(markup, /SMART BIAS|WEEK AHEAD/);
  assert.match(markup, /id="dashSmartBiasSection"/);
  assert.doesNotMatch(markup, /id="dashDigestSection"|id="dashBiasList"|id="dashFundStrip"|id="dashRetailStrip"/);

  const renderer = between('function renderDashSmartBias()', '\nfunction renderDashPositionAlerts()');
  for (const heading of ['Pertumbuhan', 'Inflasi', 'Bank sentral', 'Pandangan ekonom', 'Posisi pasar', 'Bias']) {
    assert.match(renderer, new RegExp(`<th>${heading}</th>`));
  }
  assert.match(html, /<div class="sb-detail-title">Bias<\/div>/);
  assert.doesNotMatch(renderer, /<th>Kesimpulan<\/th>/);
  assert.doesNotMatch(html, /<div class="sb-detail-title">Overall<\/div>/);
  assert.match(html, /<div class="sb-detail-title">Pandangan ekonom<\/div><div class="sb-detail-text">Sumber: Marc to Market · Marc Chandler<\/div>/);
  assert.doesNotMatch(html, /Pandangan bank/);
  assert.doesNotMatch(renderer, /Sumber Pandangan bank|Rapor forward|Buka artikel minggu ini|Snapshot minggu ini terlambat|sb-track-record|marcRecord/);
  assert.match(html, /Belum cukup sampel/);
  assert.doesNotMatch(renderer, /<th>Trend<\/th>|<th>Seasonality<\/th>/);
  assert.match(html, /@media \(max-width: 1023px\)[\s\S]*?#dashboardPanel\.visible \{ display:flex;/);
  assert.match(html, /view:'dashboard',\s+label:'Dashboard'/);
});

test('Positioning Smart Bias hanya menampilkan institutional tanpa Retail', () => {
  const renderer = between('function renderDashSmartBias()', '\nfunction renderDashPositionAlerts()');
  assert.match(renderer, />Inst</);
  assert.doesNotMatch(renderer, />Retail|src: Dukascopy|retailNote|p\.retail/);
  assert.doesNotMatch(renderer, /FinancialJuice|FXSSI|Yahoo|Deriv|Twelve Data/);
});

test('Teknikal hanya menampilkan EMA gap, ATR, dan arah otomatis', () => {
  const markup = between('<!-- TEKNIKAL PANEL -->', '<!-- DASHBOARD PANEL -->');
  assert.match(markup, /id="tekPrimePanel"/);
  assert.doesNotMatch(markup, /mtfSelD1|mtfSelH4|mtfSelH1|mtfSelM15|id="tekTaPanel"/);

  const renderer = between('function renderPrimeExecution()', '\nasync function fetchPrimeExecution');
  assert.match(renderer, />EMA GAP \(EMA 21 &amp; 100\)</);
  assert.match(renderer, />ATR</);
  assert.match(renderer, />ARAH</);
  assert.match(renderer, /rawVerdict === 'BUY ONLY' \? 'BUY'/);
  assert.match(renderer, /rawVerdict === 'SELL ONLY' \? 'SELL' : 'TUNGGU'/);
  assert.doesNotMatch(renderer, /TIDAK SELARAS|D1 DAN H4 BERBEDA|strengthLabel|tek-trend-detail/);
  assert.doesNotMatch(renderer, /tek-prime-grid|1 · Trend D1|2 · Arah H4|3 · Kekuatan|Tren kuat:/);
  assert.doesNotMatch(renderer, /Konfirmasi visual|Jelas di atas|Jelas di bawah|Tidak jelas|momentum Prime/i);
});

test('Kesimpulan tren memakai data sistem dan data lama tetap TUNGGU', () => {
  const verdict = between('function tekPrimeVerdict(', '\n\nfunction _tekPrimeNum');
  assert.match(verdict, /data\.stale/);
  assert.match(verdict, /return 'WAIT'/);
  assert.match(verdict, /data\.trend\?\.relation === 'above'/);
  assert.doesNotMatch(html, /TEK_PRIME_CONFIRM_KEY|setPrimeTrend\(|tekPrimeManualFor\(/);
});

test('Chart Teknikal memakai EMA 200 dan RSI sebagai dua indikator untuk seluruh pair', () => {
  const chart = between('function createTVChart()', '\nfunction toggleTekPairDropdown');
  assert.match(chart, /const sym = TEK_TV_SYM\[tekPair\]/);
  assert.match(chart, /MAExp@tv-basicstudies[^\n]+length: 200/);
  assert.match(chart, /RSI@tv-basicstudies/);
  assert.doesNotMatch(chart, /MAExp@tv-basicstudies[^\n]+length: (?:21|100)/);
  assert.doesNotMatch(chart, /MASimple@tv-basicstudies/);
});
