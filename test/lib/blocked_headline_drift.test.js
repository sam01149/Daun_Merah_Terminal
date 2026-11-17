// test/lib/blocked_headline_drift.test.js
// Audit 2026-11-17 (§3.2 checklist C): BLOCKED_HEADLINE_RE diduplikasi MANUAL di
// dua titik — api/feeds.js (jalur /api/feeds?type=rss, dipakai index.html dan
// market-digest.js secara transitif) dan api/admin.js (2 parser yang fetch XML
// FinancialJuice langsung, bypass feeds.js). Sebelumnya tidak ada test yang
// menjamin keduanya tetap sinkron: menambah pola di satu titik dan lupa titik
// lain lolos tanpa ketahuan sampai ada headline rusak yang tampil lagi.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const feeds = require('../../api/feeds.js');
const admin = require('../../api/admin.js');

test('BLOCKED_HEADLINE_RE feeds.js identik dengan admin.js (duplikasi manual wajib sinkron)', () => {
  assert.ok(feeds.BLOCKED_HEADLINE_RE instanceof RegExp,
    'api/feeds.js harus mengekspor BLOCKED_HEADLINE_RE supaya bisa dijaga drift-guard');
  assert.ok(admin.BLOCKED_HEADLINE_RE instanceof RegExp,
    'api/admin.js harus mengekspor BLOCKED_HEADLINE_RE');
  assert.equal(
    feeds.BLOCKED_HEADLINE_RE.source,
    admin.BLOCKED_HEADLINE_RE.source,
    'pola regex menyimpang antar dua parser — samakan di KEDUA titik'
  );
  assert.equal(
    feeds.BLOCKED_HEADLINE_RE.flags,
    admin.BLOCKED_HEADLINE_RE.flags,
    'flag regex menyimpang antar dua parser'
  );
});
