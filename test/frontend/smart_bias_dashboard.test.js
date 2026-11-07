const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  for (const heading of ['Pertumbuhan', 'Inflasi', 'Bank sentral', 'Pandangan institusi', 'Posisi pasar', 'Bias']) {
    assert.match(renderer, new RegExp(`<th>${heading}</th>`));
  }
  assert.doesNotMatch(renderer, /<th>Kesimpulan<\/th>/);
  assert.doesNotMatch(html, /<div class="sb-detail-title">Overall<\/div>/);
  assert.doesNotMatch(html, /Marc Chandler|marcRecord|_sbRecordText/);
  assert.doesNotMatch(html, /Pandangan bank/);
  assert.doesNotMatch(renderer, /Sumber Pandangan bank|Rapor forward|Buka artikel minggu ini|Snapshot minggu ini terlambat|sb-track-record|marcRecord/);
  assert.match(html, /growth:[^}]*bullish:'Membaik'[^}]*bearish:'Melemah'/);
  assert.match(html, /inflation:[^}]*bullish:'Memanas'[^}]*bearish:'Mendingin'/);
  assert.match(html, /policy:[^}]*bullish:'Hawkish'[^}]*bearish:'Dovish'/);
  assert.match(html, /return `<span class="sb-state \$\{valid\} sb-kind-\$\{kind\}" aria-label="\$\{ariaLabel\}"><\/span>`/);
  assert.doesNotMatch(html, /<span class="sb-state \$\{valid\} sb-kind-\$\{kind\}"[^>]*>\$\{_sbStateLabel/);
  assert.match(html, /\.sb-state\.bullish \{ color:var\(--green\); \}/);
  assert.match(html, /\.sb-state\.bearish \{ color:#f87171; \}/);
  assert.match(html, /\.sb-state\.mixed::before \{ width:6px; height:2px; border:0; background:currentColor; \}/);
  assert.match(html, /\.sb-state\.neutral::before, \.sb-state\.insufficient::before \{ width:6px; height:1px; border:0; background:currentColor; \}/);
  assert.doesNotMatch(html, /\.sb-state\.sb-kind-(?:inflation|policy)\.(?:bullish|bearish)/);
  assert.match(html, /row\.inflation\?\.inflation_impulse/);
  const details=between('function _sbDetailHtml(row)', '\nfunction toggleDashSmartBias');
  assert.doesNotMatch(details, /href=|source_url|source_headlines|forecast|published_at|as_of|hit_rate|confidence|coverage_count/);
  assert.match(details,/Belum ada pandangan mingguan yang cukup jelas/);
  assert.doesNotMatch(renderer,/Konteks|banks\?\.context/);
  assert.match(renderer,/Bias fundamental kualitatif/);
  assert.match(renderer,/Pembaruan belum berhasil/);
  assert.doesNotMatch(renderer, /<th>Trend<\/th>|<th>Seasonality<\/th>/);
  assert.match(html, /@media \(max-width: 1023px\)[\s\S]*?#dashboardPanel\.visible \{ display:flex;/);
  assert.match(html, /view:'dashboard',\s+label:'Dashboard'/);
});

test('Rincian Dashboard merangkum kondisi tanpa headline mentah, angka atau tautan eksternal', () => {
  const source=between('function _sbDetailHtml(row)', '\nfunction toggleDashSmartBias');
  const render=vm.runInNewContext('('+source.trim()+')',{escHtml:String});
  const row={growth:{conditions:{state:'unchanged',components:[{concept:'output',direction:0},{concept:'labour',direction:0}]}},
    inflation:{conditions:{state:'unclear',components:[{concept:'headline',direction:1},{concept:'underlying',direction:0}]}},
    central_bank:{state:'bearish',as_of:'2026-11-07T00:00:00Z',evidence:[{title:'ECB raw English headline'}]},
    banks:{state:'insufficient',context:[{reason:'LONG RAW TEXT',url:'https://example.com'}]},
    positioning:{institutional:{state:'mixed'}},overall:{state:'mixed'}};
  const result=render(row);
  assert.equal((result.match(/class="sb-detail-group"/g)||[]).length,6);
  assert.match(result,/Laju GDP tetap\. Pengangguran tetap\./);
  assert.match(result,/Inflasi umum naik\. Inflasi inti tetap\./);
  assert.match(result,/Sikap bank sentral cenderung longgar\./);
  assert.match(result,/Arah fundamental belum sejalan\./);
  assert.doesNotMatch(result,/href|https:|English|LONG RAW|2026|%/);
  assert.match(render({}),/Data pertumbuhan belum cukup\./);
  const slowing={growth:{conditions:{state:'down',components:[{concept:'output',direction:-1,level_direction:1},{concept:'labour',direction:-1}]}}};
  assert.match(render(slowing),/Ekonomi masih tumbuh, tetapi melambat\./);
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
