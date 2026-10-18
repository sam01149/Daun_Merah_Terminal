const { test } = require('node:test');
const assert = require('node:assert');
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

test('Ringkasan menaruh kalender ekonomi tepat di bawah CB Bias', () => {
  const panel = between('<!-- RINGKASAN PANEL -->', '<!-- ANALISA PANEL -->');
  const left = between('<aside class="ringkasan-side ringkasan-side-left">', '<aside class="ringkasan-side ringkasan-side-right no-print">');
  assert.ok(left.indexOf('id="cbSection"') < left.indexOf('id="ringkasanCalendarCard"'));
  assert.match(panel, /id="ringkasanCalendarList"/);
  assert.match(panel, /onclick="switchView\('cal'\)"/);
  assert.match(panel, />Kalender Ekonomi</);
  assert.match(panel, />High</);
  assert.match(panel, />Medium</);
});

test('kalender Ringkasan menampilkan seluruh event Medium dan High dalam tabel terkelompok', () => {
  const render = between('function renderRingkasanCalendar(errorMessage)', '\nfunction updateCalLastUpdated');
  assert.match(render, /ev\.impact === 'High' \|\| ev\.impact === 'Medium'/);
  assert.match(render, /ev\.date >= todayWib/);
  assert.doesNotMatch(render, /\.slice\(/);
  assert.match(render, />Waktu<\/span><span>Aktual<\/span><span>Forecast<\/span><span>Sebelumnya<\/span>/);
  assert.match(render, /Object\.entries\(groups\)/);
  assert.match(render, /compareActualForecast\(ev\.actual, ev\.forecast, ev\.event, ev\)/);
  assert.match(render, /value === null \|\| value === undefined \|\| value === ''/);
});

test('kalender Ringkasan tetap nyaman: scroll internal desktop dan mengikuti halaman pada ponsel', () => {
  assert.match(html, /\.ringkasan-calendar-list\s*\{[^}]*max-height:680px;[^}]*overflow-y:auto;/s);
  assert.match(html, /@media \(max-width: 480px\)[\s\S]*?\.ringkasan-calendar-list\s*\{\s*max-height:none;\s*overflow:visible;/);
  assert.match(html, /@media \(max-width: 480px\)[\s\S]*?\.ringkasan-calendar-columns\s*\{\s*position:static;/);
  assert.match(html, /grid-template-columns:46px repeat\(3,minmax\(0,1fr\)\)/);
});

test('Analisa memakai tiga zona dan urutan ponsel mengutamakan keputusan lalu narasi', () => {
  const panel = between('<!-- ANALISA PANEL -->', '<!-- CALENDAR PANEL -->');
  assert.match(panel, /class="analisa-context-col"/);
  assert.match(panel, /class="analisa-main-col"/);
  assert.match(panel, /class="analisa-decision-col no-print"/);
  assert.match(html, /grid-template-areas:"execution" "main" "positioning" "context"/);
  assert.match(html, /grid-template-areas:"main main" "context execution" "context positioning"/);
  assert.match(html, /grid-template-areas:"context main execution" "context main positioning"/);
});

test('COT dan retail pada Analisa diberi batas sebagai indikator tambahan', () => {
  const render = between('function renderAnalisaPositioning()', '\nfunction renderAnalisa()');
  assert.match(render, /computeCotRetailVerdict\(pairKey\)/);
  assert.match(render, /computeCotOnlyLean\(base, quote\)/);
  assert.match(render, /Indikator pendukung, bukan penentu arah atau pengganti trigger chart/);
});

test('workspace Analisa kembali menjadi satu kolom saat dicetak', () => {
  assert.match(html, /body\.printing-analisa #analisaPanel \.analisa-workspace\s*\{\s*display:\s*block !important;/);
});

test('aturan visual akhir tidak lagi menyempitkan workspace Analisa ke 680px', () => {
  assert.doesNotMatch(html, /\.analisa-inner\s*\{[^}]*max-width:\s*680px\s*!important/s);
  assert.match(html, /\.analisa-inner\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*1540px\s*!important/s);
});

test('hasil Analisa lama tetap terlihat tetapi tidak dianggap setup aktif', () => {
  assert.match(html, /const ANALISA_ACTIONABLE_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(html, /const statusLabel = stale \? 'HASIL LAMA'/);
  assert.match(html, /Level dipertahankan sebagai riwayat\. Jalankan analisa ulang sebelum dipakai/);
  assert.match(html, /if \(_analisaResultIsStale\(ai\)\)[\s\S]*?sebelum mengirim level ke Checklist/);
});

test('umur setup memakai waktu analisa asli, bukan waktu cache lama dimuat ulang', () => {
  const start = html.indexOf('const ANALISA_ACTIONABLE_MS');
  const end = html.indexOf('const LS_ANALISA_DATA', start);
  assert.ok(start >= 0 && end > start);
  const isStale = new Function(`${html.slice(start, end)}; return _analisaResultIsStale;`)();
  const now = Date.parse('2026-10-18T10:00:00Z');
  assert.equal(isStale({ analyzedAt:'2026-09-24T10:00:00Z', saved_at:now }, now), true);
  assert.equal(isStale({ analyzedAt:'2026-10-18T06:00:00Z', saved_at:now - 99e9 }, now), false);
});
