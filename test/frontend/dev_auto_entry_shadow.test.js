'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dev-auto-entry.html'), 'utf8');

test('Auto Entry dashboard menampilkan shadow entry optimization secara eksplisit', () => {
  assert.match(html, /id="card-entry-shadow"/);
  assert.match(html, /Tidak memengaruhi entry produksi/);
  assert.match(html, /entry_optimization_shadow/);
  assert.match(html, /Status Produksi Pembanding/);
  assert.match(html, /Net R \/ Stress 2x/);
});
