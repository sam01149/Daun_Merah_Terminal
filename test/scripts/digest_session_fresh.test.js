const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  latestDigestSessionStart,
  isDigestCurrentSession,
  isCachedDigestCurrentSession,
} = require('../../scripts/digest_session_fresh.js');

test('latestDigestSessionStart: memilih slot sesi terakhir yang sudah dimulai dalam UTC', () => {
  assert.equal(latestDigestSessionStart('2026-10-23T12:33:00Z').toISOString(), '2026-10-23T12:32:00.000Z');
  assert.equal(latestDigestSessionStart('2026-10-23T07:01:59Z').toISOString(), '2026-10-23T00:02:00.000Z');
});

test('latestDigestSessionStart: sebelum Asia mengacu New York hari sebelumnya', () => {
  assert.equal(latestDigestSessionStart('2026-10-23T00:01:59Z').toISOString(), '2026-10-22T12:32:00.000Z');
});

test('isDigestCurrentSession: hasil sesi saat ini valid, hasil sesi sebelumnya stale', () => {
  const now = '2026-10-23T12:33:00Z';
  assert.equal(isDigestCurrentSession('2026-10-23T12:32:00.000Z', now), true);
  assert.equal(isDigestCurrentSession('2026-10-23T07:02:25.180Z', now), false);
});

test('isCachedDigestCurrentSession: cache rusak, kosong, atau timestamp masa depan selalu stale', () => {
  const now = '2026-10-23T12:33:00Z';
  assert.equal(isCachedDigestCurrentSession(null, now), false);
  assert.equal(isCachedDigestCurrentSession({}, now), false);
  assert.equal(isCachedDigestCurrentSession({ generated_at: 'bukan-tanggal' }, now), false);
  assert.equal(isCachedDigestCurrentSession({ generated_at: '2026-10-23T12:34:00Z' }, now), false);
});

test('workflow: fallback memakai validitas sesi cache, bukan heartbeat saja', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'market-digest.yml'), 'utf8');
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /node scripts\/digest_session_fresh\.js \/tmp\/digest-cache\.json/);
  assert.match(workflow, /steps\.vps\.outputs\.alive == 'false' \|\| steps\.digest\.outputs\.session_fresh != 'true'/);
});
