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

test('News memakai baris artikel datar, bukan kartu membulat terpisah', () => {
  const css = between('.feed-item {', '.feed-item:active');
  assert.match(css, /background:transparent/);
  assert.match(css, /border-bottom:1px solid var\(--border\)/);
  assert.match(css, /border-radius:0/);
  assert.match(css, /margin:0/);
});

test('headline News menaruh badge kategori di kiri judul dan waktu di bawahnya', () => {
  const render = between('function _feedItemHtml(item, isNew, idx)', '\n// allItems');
  const headlineAt = render.indexOf('class="item-headline-row"');
  const tagAt = render.indexOf('class="item-tag');
  const titleAt = render.indexOf('class="item-title"');
  const metaAt = render.indexOf('class="item-meta"');
  assert.ok(headlineAt >= 0 && tagAt > headlineAt && titleAt > tagAt,
    'badge kategori harus berada di kiri judul dalam baris headline');
  assert.ok(metaAt > titleAt, 'metadata waktu harus berada di bawah headline');
});
