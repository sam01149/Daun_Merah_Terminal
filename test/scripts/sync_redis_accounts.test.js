const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIRM_TEXT,
  isEphemeralKey,
  timestampFrom,
  chooseNewer,
  mergeJsonHistory,
  mergeRecords,
  recordDigest,
  parseArgs,
} = require('../../scripts/sync_redis_accounts');

test('sync Redis: key sementara tidak ikut dipindahkan, data fundamental tetap ikut', () => {
  for (const key of ['rl:feeds:ip:1', 'lock:setuplog', 'push_lock', 'vps:heartbeat', 'ohlcv_fresh:EURUSD=X']) {
    assert.equal(isEphemeralKey(key), true, key);
  }
  for (const key of ['fundamental:USD', 'setup_log_auto:v1', 'journal:device:id', 'ohlcv:EURUSD=X:1h']) {
    assert.equal(isEphemeralKey(key), false, key);
  }
});

test('sync Redis: timestamp dikenali dari epoch dan tanggal ISO', () => {
  assert.equal(timestampFrom({ ts: 1_700_000_000 }), 1_700_000_000_000);
  assert.equal(timestampFrom(JSON.stringify({ updated_at: '2026-10-29T10:00:00Z' })), Date.parse('2026-10-29T10:00:00Z'));
  assert.equal(timestampFrom('bukan-json'), null);
});

test('sync Redis: nilai bertanggal lebih baru menang, tanpa tanggal tujuan aktif menang', () => {
  const oldValue = JSON.stringify({ date: '2026-09-01', actual: 1 });
  const newValue = JSON.stringify({ date: '2026-10-01', actual: 2 });
  assert.equal(chooseNewer(newValue, oldValue), newValue);
  assert.equal(chooseNewer('lama tanpa tanggal', 'tujuan aktif'), 'tujuan aktif');
});

test('sync Redis: histori JSON digabung berdasarkan id dan versi tujuan yang lebih baru dipertahankan', () => {
  const source = JSON.stringify([
    { id: 'lama', timestamp: 100, status: 'open' },
    { id: 'sama', timestamp: 200, status: 'open' },
  ]);
  const destination = JSON.stringify([
    { id: 'sama', timestamp: 300, status: 'tp' },
    { id: 'baru', timestamp: 400, status: 'open' },
  ]);
  const result = JSON.parse(mergeJsonHistory(source, destination));
  assert.deepEqual(result.map(item => item.id), ['baru', 'sama', 'lama']);
  assert.equal(result.find(item => item.id === 'sama').status, 'tp');
});

test('sync Redis: hash fundamental melengkapi field kosong dan memilih field bertanggal terbaru', () => {
  const source = {
    key: 'fundamental:USD', type: 'hash', ttlMs: -1,
    value: {
      GDP: JSON.stringify({ date: '2026-09-01', actual: 2.0 }),
      CPI: JSON.stringify({ date: '2026-10-01', actual: 3.0 }),
    },
  };
  const destination = {
    key: 'fundamental:USD', type: 'hash', ttlMs: -1,
    value: {
      GDP: JSON.stringify({ date: '2026-10-01', actual: 2.5 }),
      PMI: JSON.stringify({ date: '2026-10-20', actual: 52 }),
    },
  };
  const merged = mergeRecords(source.key, source, destination);
  assert.equal(JSON.parse(merged.value.GDP).actual, 2.5);
  assert.equal(JSON.parse(merged.value.CPI).actual, 3.0);
  assert.equal(JSON.parse(merged.value.PMI).actual, 52);
});

test('sync Redis: set dan sorted set di-union tanpa mengubah skor tujuan', () => {
  const setMerged = mergeRecords('members',
    { type: 'set', ttlMs: -1, value: ['a', 'b'] },
    { type: 'set', ttlMs: -1, value: ['b', 'c'] });
  assert.deepEqual(new Set(setMerged.value), new Set(['a', 'b', 'c']));

  const zsetMerged = mergeRecords('journal_index:x',
    { type: 'zset', ttlMs: -1, value: ['a', '1', 'b', '2'] },
    { type: 'zset', ttlMs: -1, value: ['b', '3', 'c', '4'] });
  assert.deepEqual(zsetMerged.value, ['a', '1', 'b', '3', 'c', '4']);
});

test('sync Redis: stream digabung per ID dan entri tujuan menang saat ID sama', () => {
  const merged = mergeRecords('events',
    { type: 'stream', ttlMs: -1, value: [['1-0', ['v', 'old']], ['2-0', ['v', 'two']]] },
    { type: 'stream', ttlMs: -1, value: [['1-0', ['v', 'new']], ['3-0', ['v', 'three']]] });
  assert.deepEqual(merged.value, [
    ['1-0', ['v', 'new']],
    ['2-0', ['v', 'two']],
    ['3-0', ['v', 'three']],
  ]);
});

test('sync Redis: digest hash/set stabil walau urutan berbeda', () => {
  assert.equal(
    recordDigest({ type: 'hash', value: { b: '2', a: '1' } }),
    recordDigest({ type: 'hash', value: { a: '1', b: '2' } }),
  );
  assert.equal(
    recordDigest({ type: 'set', value: ['b', 'a'] }),
    recordDigest({ type: 'set', value: ['a', 'b'] }),
  );
});

test('sync Redis: mode tulis memerlukan frasa konfirmasi eksplisit', () => {
  assert.deepEqual(parseArgs([]), { execute: false, confirm: '' });
  assert.deepEqual(parseArgs(['--execute', `--confirm=${CONFIRM_TEXT}`]), { execute: true, confirm: CONFIRM_TEXT });
});
