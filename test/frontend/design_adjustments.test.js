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

test('berita Teknikal memakai baris datar seperti News tanpa kartu atau garis aksen kiri', () => {
  const css = between('.tek-news-item {', '.tek-news-item:hover');
  const render = between('function renderTekNews()', '\n// Handler tombol load-more');
  assert.match(css, /background:\s*transparent/);
  assert.match(css, /border-bottom:\s*1px solid var\(--border\)/);
  assert.match(css, /border-radius:\s*0/);
  assert.match(css, /border-left:\s*0 !important/);
  assert.doesNotMatch(render, /tek-news-item[^\n]*border-left/);
});

test('berita Dashboard tidak memakai titik merah dan tetap punya hierarki netral', () => {
  const render = between('function renderDashNews()', '\n// Tombol generate');
  assert.doesNotMatch(render, /dash-news-dot|dash-cluster-dot/);
  assert.match(html, /\.dash-news-item:hover\s*\{\s*background:/);
  assert.match(html, /\.dash-cluster-header::before[^}]*background:var\(--text-mid\)/);
});

test('COT memiliki tiga tab horizontal dan posisi dua kolom pada laptop', () => {
  const panel = between('<!-- COT PANEL -->', '<!-- FUNDAMENTAL PANEL -->');
  assert.match(panel, /data-cot-section="positioning"[^>]*>Posisi COT</);
  assert.match(panel, /data-cot-section="direction"[^>]*>Arah Pasar</);
  assert.match(panel, /data-cot-section="retail"[^>]*>Retail</);
  assert.match(html, /@media \(min-width:900px\)[\s\S]*?\.cot-position-columns\s*\{\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.cot-panel-inner\s*\{[^}]*max-width:\s*1100px/);
  const render = between('function renderCOT()', '\nlet cotActiveSection');
  assert.match(render, /class="cot-position-columns"/);
  assert.strictEqual((render.match(/class="cot-position-group"/g) || []).length, 2);
});

test('pemilih subfitur COT hanya mengaktifkan tombol dan panel yang dipilih', () => {
  const source = between("let cotActiveSection = 'positioning';", '\n// ── COT TREND PANEL');
  const makeEl = dataset => ({
    dataset,
    classes: new Set(),
    attrs: {},
    classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); }, owner: null },
    setAttribute(name, value) { this.attrs[name] = value; },
  });
  const buttons = ['positioning', 'direction', 'retail'].map(value => makeEl({ cotSection: value }));
  const panes = ['positioning', 'direction', 'retail'].map(value => makeEl({ cotPane: value }));
  [...buttons, ...panes].forEach(el => { el.classList.owner = el; });
  const document = {
    querySelectorAll(selector) {
      return selector === '[data-cot-section]' ? buttons : panes;
    },
  };
  const setCotSection = new Function('document', `${source}; return setCotSection;`)(document);

  setCotSection('retail');
  assert.deepStrictEqual(buttons.map(el => el.attrs['aria-selected']), ['false', 'false', 'true']);
  assert.deepStrictEqual(panes.map(el => el.classes.has('active')), [false, false, true]);

  setCotSection('tidak-valid');
  assert.deepStrictEqual(panes.map(el => el.classes.has('active')), [true, false, false]);
});
