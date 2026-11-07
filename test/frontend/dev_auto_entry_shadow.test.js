'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dev-auto-entry.html'), 'utf8');

test('dashboard memakai kontrak operasional dan statistik per policy tanpa panel shadow aktif', () => {
  assert.match(html, /id="card-operation"/);
  assert.match(html, /Statistik gabungan tetap berlanjut/);
  assert.match(html, /Pengumpulan shadow dihentikan/);
  assert.match(html, /by_policy/);
  assert.match(html, /by_strategy/);
  assert.match(html, /operational_contract/);
  assert.doesNotMatch(html, /id="card-entry-shadow"/);
});
