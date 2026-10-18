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

test('Ringkasan menaruh agenda high-impact ringkas tepat di kolom CB Bias', () => {
  const panel = between('<!-- RINGKASAN PANEL -->', '<!-- ANALISA PANEL -->');
  const left = between('<aside class="ringkasan-side ringkasan-side-left">', '<aside class="ringkasan-side ringkasan-side-right no-print">');
  assert.ok(left.indexOf('id="cbSection"') < left.indexOf('id="ringkasanCalendarCard"'));
  assert.match(panel, /id="ringkasanCalendarList"/);
  assert.match(panel, /onclick="switchView\('cal'\)"/);
});

test('agenda Ringkasan hanya mengambil tiga event High mendatang', () => {
  const render = between('function renderRingkasanCalendar(errorMessage)', '\nfunction updateCalLastUpdated');
  assert.match(render, /ev\.impact === 'High'/);
  assert.match(render, /_ckEvTimestamp\(ev\) > now/);
  assert.match(render, /\.slice\(0, 3\)/);
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
