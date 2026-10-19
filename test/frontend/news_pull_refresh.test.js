const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

test('News mobile menyembunyikan tombol REFRESH dan menyediakan indikator ikon', () => {
  assert.match(html, /@media \(max-width: 767px\)[\s\S]*?#refreshBtn \{ display:none; \}/);
  assert.match(html, /id="newsPullIndicator"[\s\S]*?<svg/);
  const indicator = html.match(/<div class="news-pull-indicator"[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(indicator);
  assert.doesNotMatch(indicator, /REFRESH|Tarik|Muat/i, 'indikator pull-to-refresh harus ikon saja');
});

test('gestur hanya aktif saat News mobile berada di posisi paling atas', () => {
  const start = html.indexOf('function initNewsPullToRefresh()');
  const end = html.indexOf('\ninitNewsPullToRefresh();', start);
  assert.ok(start >= 0 && end > start);
  const src = html.slice(start, end);
  assert.match(src, /activeView === 'feed'/);
  assert.match(src, /scroll\.scrollTop > 0/);
  assert.match(src, /pullDistance >= threshold/);
  assert.match(src, /fetchFeed\(true\)/, 'tarik manual harus melewati debounce refresh otomatis');
  assert.match(src, /touchcancel/);
});

test('state awal dan state kosong News tidak memakai emoji', () => {
  assert.doesNotMatch(html, /📡|🔍|⏳/);
  assert.match(html, /Berita akan dimuat otomatis/);
});

test('judul News memakai ukuran 13px', () => {
  assert.match(html, /\.item-title\s*\{[\s\S]*?font-size:13px;/);
});
