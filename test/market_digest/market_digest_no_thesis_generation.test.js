const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'market-digest.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

test('market digest mematikan Call 3 thesis pada semua jalur', () => {
  assert.match(source, /const GENERATE_TRADE_THESIS = false;/);
  assert.match(source, /if \(!GENERATE_TRADE_THESIS\) \{[\s\S]*?Call 3 disabled/);
});

test('market digest menunggu latest_article tersimpan sebelum membalas', () => {
  assert.match(source, /await redisCmd\('SET', 'latest_article', JSON\.stringify\(toCache\), 'EX', 86400\)/);
  assert.doesNotMatch(source, /redisCmd\('SET', 'latest_article', JSON\.stringify\(toCache\), 'EX', 86400\)\.catch/);
});

test('payload baru tidak lagi membawa thesis generatif', () => {
  const payloadStart = source.lastIndexOf('const payload = {', source.indexOf('// Persist full payload'));
  const payloadEnd = source.indexOf('\n  };', payloadStart);
  assert.notEqual(payloadStart, -1);
  assert.notEqual(payloadEnd, -1);
  const payload = source.slice(payloadStart, payloadEnd);
  assert.doesNotMatch(payload, /\bthesis\s*[,}:]/);
  assert.match(source, /redisCmd\('DEL', 'latest_thesis'\)/);
});

test('respons cache lama membuang field thesis sebelum dikirim ke frontend', () => {
  assert.match(source, /const \{ thesis: _legacyThesis, \.\.\.cached \} = JSON\.parse\(raw\)/);
  assert.match(source, /const \{ thesis: _legacyThesis, \.\.\.cachedWithoutThesis \} = cached/);
});

test('frontend dan sinkronisasi OHLCV tidak lagi memakai thesis generatif lama', () => {
  assert.doesNotMatch(html, /_lastThesis|ringkasanCache\.thesis\b|data\.thesis\b/);
  assert.match(html, /localStorage\.removeItem\('daun_merah_thesis'\)/);
  assert.doesNotMatch(adminSource, /redisCmd\('GET', 'latest_thesis'\)|artObj\.thesis/);
});
