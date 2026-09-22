const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dev-auto-entry.html'), 'utf8');

test('Chart Posisi: candle 1H pair Deriv memakai feed langsung agar candle aktif dapat realtime', () => {
  assert.match(html, /const DERIV_GRANULARITY\s*=\s*\{[^}]*'1h':\s*3600/s);
  assert.match(html, /if \(directBars && directBars\.length\) return \{ bars: directBars, liveSource: 'Deriv' \};/);
});

test('Chart Posisi: pemuatan candle selesai sebelum socket tick dimulai dan status stale tidak menutup chart', () => {
  assert.match(html, /await Promise\.all\(pairs\.map\(p => renderChartCard\(p\.symbol, '1h'\)\)\);/);
  assert.match(html, /class="chart-data-status"/);
  assert.doesNotMatch(html, /chartbox \.chart-stale/);
});

test('Chart Posisi: sumber cadangan tampilan tetap diberi label dan tidak disamarkan sebagai Deriv', () => {
  assert.match(html, /liveSource: json\.live_source \|\| null/);
  assert.match(html, /Data live \$\{liveSource\}/);
  assert.match(html, /auto-entry tetap menunggu candle Deriv yang segar/);
});
