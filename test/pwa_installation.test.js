const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
const origin = 'https://financial-feed-app.vercel.app';

test('PWA utama dan auto-entry tidak saling mencakup URL instalasi', () => {
  const apps = [['manifest.json', '/index.html'], ['dev-auto-entry.webmanifest', '/dev-auto-entry.html']].map(([file, legacyId]) => {
    const manifest = read(file), manifestUrl = new URL(file, origin);
    const start = new URL(manifest.start_url, manifestUrl);
    const scope = new URL(manifest.scope, manifestUrl);
    const id = new URL(manifest.id, manifestUrl);
    assert.equal(id.href, new URL(legacyId, origin).href, 'identitas instalasi lama harus dipertahankan');
    assert.equal(start.origin, scope.origin);
    assert(start.pathname.startsWith(scope.pathname), 'halaman awal harus berada dalam cakupan aplikasi');
    return { start, scope, id };
  });
  assert.notEqual(apps[0].id.href, apps[1].id.href);
  for (const [app, other] of [[apps[0], apps[1]], [apps[1], apps[0]]]) {
    assert(!other.start.pathname.startsWith(app.scope.pathname), 'cakupan aplikasi tidak boleh mengambil halaman aplikasi lain');
  }
});

test('alamat utama membuka halaman dalam cakupan PWA tanpa memindahkan API atau auto-entry', () => {
  const redirects = read('vercel.json').redirects;
  const root = redirects.find(rule => rule.source === '/');
  assert.equal(root?.destination, '/index.html');
  assert.equal(root.permanent, false);
  assert.equal(redirects.length, 1);
});
