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

test('CB Bias berada di Ringkasan dan tidak lagi memenuhi tab Kalender', () => {
  const ringkasanMarkup = between('<!-- RINGKASAN PANEL -->', '<!-- ANALISA PANEL -->');
  const calendarMarkup = between('<!-- CALENDAR PANEL -->', '<!-- SIZING PANEL -->');
  assert.match(ringkasanMarkup, /id="cbSection"/);
  assert.match(ringkasanMarkup, /CB Bias · 8 Bank Sentral/);
  assert.doesNotMatch(calendarMarkup, /id="cbSection"|id="cbGrid"/);
});

test('desktop Ringkasan memakai tiga kolom: CB kiri, narasi tengah, Polymarket kanan', () => {
  const ringkasanMarkup = between('<!-- RINGKASAN PANEL -->', '<!-- ANALISA PANEL -->');
  assert.match(ringkasanMarkup, /class="ringkasan-main"/);
  assert.match(ringkasanMarkup, /class="ringkasan-side ringkasan-side-left"/);
  assert.match(ringkasanMarkup, /class="ringkasan-side ringkasan-side-right no-print"/);
  assert.match(html, /grid-template-areas:\s*"left main right"/);
  assert.match(html, /grid-template-columns:\s*minmax\(310px, 380px\) minmax\(440px, 1fr\) minmax\(260px, 320px\)/);
});

test('Ringkasan turun responsif menjadi dua kolom tablet dan satu kolom ponsel', () => {
  assert.match(html, /grid-template-areas:\s*"main main" "left right"/);
  assert.match(html, /grid-template-areas:\s*"main" "left" "right"/);
  assert.match(html, /@media \(min-width: 768px\) and \(max-width: 1199px\)/);
});

test('Ringkasan kembali satu kolom saat dicetak agar isi tidak menyempit', () => {
  assert.match(html, /body\.printing-ringkasan #ringkasanPanel \.ringkasan-workspace\s*\{\s*display:\s*block !important;/);
});

test('Ringkasan tidak merender kartu Thesis FX/XAU, tetapi Thesis Alert tetap ada', () => {
  const render = between('function renderRingkasan()', '\nfunction _printWibNow');
  assert.doesNotMatch(render, /renderThesisCard|renderXauThesisCard/);
  assert.match(render, /renderThesisAlerts/);
  assert.ok(render.indexOf('renderThesisAlerts') < render.indexOf('renderArticleSections'),
    'Thesis Alert harus tampil sebelum narasi berita');
});

test('narasi Ringkasan dan Dashboard memakai satu briefing makro tanpa toggle XAU', () => {
  const renderSections = between('function renderArticleSections(article)', '\nlet _lastThesis');
  const dashDigest = between('function renderDashDigest()', '\n  if (thesisEl)');
  assert.match(renderSections, /ANALISIS BERITA · MAKRO/);
  assert.doesNotMatch(renderSections, /ANALISIS BERITA · FX|ANALISIS BERITA · XAUUSD/);
  assert.match(dashDigest, /unifyDigestArticle/);
  assert.doesNotMatch(dashDigest, /toggleDashDigestSide|dashDigestSide|FX \+ XAU/);
});

test('Polymarket mengurutkan volume dan menampilkan tiga market utama sebelum detail sisanya', () => {
  const source = between('function renderPolymarket(data)', '\n// ── CB Research');
  const panel = { innerHTML: '' };
  const document = { getElementById: id => id === 'polymarketPanel' ? panel : null };
  const escHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const POLY_CAT_COLORS = { 'Macro Data': '#60a5fa' };
  const renderPolymarket = new Function('document', 'escHtml', 'POLY_CAT_COLORS',
    `${source}; return renderPolymarket;`)(document, escHtml, POLY_CAT_COLORS);

  renderPolymarket({ markets: [
    { question:'volume 2', volume24h:200, yes_prob:50, category:'Macro Data' },
    { question:'volume 4', volume24h:400, yes_prob:50, category:'Macro Data' },
    { question:'volume 1', volume24h:100, yes_prob:50, category:'Macro Data' },
    { question:'volume 3', volume24h:300, yes_prob:50, category:'Macro Data' },
  ] });

  assert.match(panel.innerHTML, /TOP 3 BY VOLUME/);
  assert.ok(panel.innerHTML.indexOf('volume 4') < panel.innerHTML.indexOf('volume 3'));
  assert.ok(panel.innerHTML.indexOf('volume 3') < panel.innerHTML.indexOf('volume 2'));
  assert.ok(panel.innerHTML.indexOf('<details>') < panel.innerHTML.indexOf('volume 1'),
    'market di luar top 3 harus tersedia di detail yang dapat dibuka');
});

test('membuka Ringkasan memuat CB; membuka Kalender tidak lagi melakukannya', () => {
  const switchSource = between("} else if (view === 'ringkasan')", "} else if (view === 'cot')");
  const [ringkasanBranch, calendarBranch] = switchSource.split("} else if (view === 'cal')");
  assert.match(ringkasanBranch, /fetchCBStatus\(\)/);
  assert.match(ringkasanBranch, /fetchPolymarket\(\)/);
  assert.doesNotMatch(calendarBranch, /fetchCBStatus\(\)|renderCBTracker\(\)/);
});
