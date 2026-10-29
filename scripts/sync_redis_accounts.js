/**
 * Sinkronisasi penuh dua akun Redis Daun Merah.
 *
 * Alur aman yang dituju:
 *   1. Redis 1 -> Redis 2 (merge, Redis 2 yang lebih baru menang)
 *   2. Redis 2 -> Redis 1 (mirror hasil gabungan)
 *   3. Verifikasi kesetaraan sebelum REDIS_ACTIVE_ACCOUNT diubah ke 1
 *
 * Default hanya audit/dry-run. Eksekusi tulis membutuhkan dua pagar eksplisit:
 *   node scripts/sync_redis_accounts.js --execute --confirm=SYNC_BOTH_REDIS_ACCOUNTS
 *
 * Backup JSON lengkap kedua akun disimpan di .cache/redis-migration/ (gitignored).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIRM_TEXT = 'SYNC_BOTH_REDIS_ACCOUNTS';
const HISTORY_STRING_KEYS = new Set(['setup_log:v1', 'setup_log_auto:v1', 'sizing:history']);
const EPHEMERAL_KEY_PATTERNS = [
  /^rl:/,
  /^lock:/,
  /^cron_dedup:/,
  /^selfheal:/,
  /^ohlcv_fresh:/,
  /^push_lock$/,
  /^vps:heartbeat$/,
  /^daemon_degraded_alert_ts$/,
];

function getEnvVal(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return null;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value;
  }
  return null;
}

function credentials() {
  return {
    redis1: {
      label: 'Redis 1',
      url: getEnvVal('UPSTASH_REDIS_REST_URL'),
      token: getEnvVal('UPSTASH_REDIS_REST_TOKEN'),
    },
    redis2: {
      label: 'Redis 2',
      url: getEnvVal('UPSTASH_REDIS_REST_URL_2') || getEnvVal('UPSTASH2_REDIS_REST_URL'),
      token: getEnvVal('UPSTASH_REDIS_REST_TOKEN_2') || getEnvVal('UPSTASH2_REDIS_REST_TOKEN'),
    },
  };
}

async function redisCall(db, ...args) {
  const response = await fetch(db.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${db.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'codex-daun-merah-redis-migration',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000),
  });
  let json;
  try { json = await response.json(); }
  catch { throw new Error(`${db.label}: HTTP ${response.status}, respons bukan JSON`); }
  if (!response.ok || json.error) {
    throw new Error(`${db.label}: HTTP ${response.status}: ${json.error || 'unknown'}`);
  }
  return json.result;
}

function isEphemeralKey(key) {
  return EPHEMERAL_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function flatPairsToObject(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? { ...value } : {};
  const result = {};
  for (let i = 0; i + 1 < value.length; i += 2) result[String(value[i])] = value[i + 1];
  return result;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function timestampFrom(value) {
  const obj = typeof value === 'string' ? parseMaybeJson(value) : value;
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['updated_at', 'fetched_at', 'release_date', 'date', 'as_of', 'created_at', 'timestamp', 'ts']) {
    const raw = obj[key];
    if (raw == null) continue;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function chooseNewer(sourceValue, destinationValue) {
  const sourceTs = timestampFrom(sourceValue);
  const destinationTs = timestampFrom(destinationValue);
  if (sourceTs != null && destinationTs != null && sourceTs > destinationTs) return sourceValue;
  return destinationValue;
}

function identityFor(item) {
  if (item && typeof item === 'object') {
    for (const key of ['id', 'guid', 'ticket', 'mt5_ticket', 'timestamp', 'ts', 'created_at']) {
      if (item[key] != null) return `${key}:${item[key]}`;
    }
  }
  return `raw:${JSON.stringify(item)}`;
}

function mergeJsonHistory(sourceRaw, destinationRaw) {
  const source = parseMaybeJson(sourceRaw);
  const destination = parseMaybeJson(destinationRaw);
  if (!Array.isArray(source) || !Array.isArray(destination)) return destinationRaw;
  const merged = new Map();
  for (const item of source) merged.set(identityFor(item), item);
  for (const item of destination) {
    const id = identityFor(item);
    merged.set(id, merged.has(id) ? chooseNewer(merged.get(id), item) : item);
  }
  return JSON.stringify([...merged.values()].sort((a, b) => (timestampFrom(b) || 0) - (timestampFrom(a) || 0)));
}

function normalizeZset(value) {
  const result = new Map();
  for (let i = 0; Array.isArray(value) && i + 1 < value.length; i += 2) {
    result.set(String(value[i]), String(value[i + 1]));
  }
  return result;
}

function mergeRecords(key, source, destination) {
  if (!source) return destination;
  if (!destination) return { ...source };
  if (source.type !== destination.type) return { ...destination, conflict: `type:${source.type}->${destination.type}` };

  const ttlMs = destination.ttlMs;
  if (source.type === 'string') {
    const value = HISTORY_STRING_KEYS.has(key)
      ? mergeJsonHistory(source.value, destination.value)
      : chooseNewer(source.value, destination.value);
    return { ...destination, value, ttlMs };
  }
  if (source.type === 'hash') {
    const left = flatPairsToObject(source.value);
    const right = flatPairsToObject(destination.value);
    const value = { ...left, ...right };
    for (const field of Object.keys(left)) {
      if (Object.hasOwn(right, field)) value[field] = chooseNewer(left[field], right[field]);
    }
    return { ...destination, value, ttlMs };
  }
  if (source.type === 'set') {
    return { ...destination, value: [...new Set([...(destination.value || []), ...(source.value || [])])], ttlMs };
  }
  if (source.type === 'zset') {
    const merged = normalizeZset(source.value);
    for (const [member, score] of normalizeZset(destination.value)) merged.set(member, score);
    const value = [];
    for (const [member, score] of merged) value.push(member, score);
    return { ...destination, value, ttlMs };
  }
  if (source.type === 'list') {
    const seen = new Set();
    const value = [];
    for (const item of [...(destination.value || []), ...(source.value || [])]) {
      const id = typeof item === 'string' ? identityFor(parseMaybeJson(item) ?? item) : identityFor(item);
      if (seen.has(id)) continue;
      seen.add(id);
      value.push(item);
    }
    return { ...destination, value, ttlMs };
  }
  if (source.type === 'stream') {
    const byId = new Map((source.value || []).map(entry => [entry[0], entry]));
    for (const entry of destination.value || []) byId.set(entry[0], entry);
    return { ...destination, value: [...byId.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))), ttlMs };
  }
  return { ...destination, ttlMs };
}

function stableValue(record) {
  if (!record) return null;
  if (record.type === 'hash') {
    return Object.fromEntries(Object.entries(flatPairsToObject(record.value)).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (record.type === 'set') return [...(record.value || [])].map(String).sort();
  if (record.type === 'zset') {
    return [...normalizeZset(record.value).entries()].sort(([a], [b]) => a.localeCompare(b));
  }
  return record.value;
}

function recordDigest(record) {
  if (!record) return null;
  return crypto.createHash('sha256').update(JSON.stringify({ type: record.type, value: stableValue(record) })).digest('hex');
}

async function scanKeys(db) {
  let cursor = '0';
  const keys = new Set();
  do {
    const result = await redisCall(db, 'SCAN', cursor, 'COUNT', '200');
    cursor = String(result?.[0] ?? '0');
    for (const key of result?.[1] || []) keys.add(String(key));
  } while (cursor !== '0');
  return [...keys].sort();
}

async function readRecord(db, key) {
  const type = String(await redisCall(db, 'TYPE', key) || 'none').toLowerCase();
  if (type === 'none') return null;
  const ttlMs = Number(await redisCall(db, 'PTTL', key));
  let value;
  if (type === 'string') value = await redisCall(db, 'GET', key);
  else if (type === 'hash') value = flatPairsToObject(await redisCall(db, 'HGETALL', key));
  else if (type === 'list') value = await redisCall(db, 'LRANGE', key, '0', '-1');
  else if (type === 'set') value = await redisCall(db, 'SMEMBERS', key);
  else if (type === 'zset') value = await redisCall(db, 'ZRANGE', key, '0', '-1', 'WITHSCORES');
  else if (type === 'stream') value = await redisCall(db, 'XRANGE', key, '-', '+');
  else if (type.includes('json')) value = await redisCall(db, 'JSON.GET', key, '$');
  else throw new Error(`${db.label}: tipe Redis belum didukung untuk ${key}: ${type}`);
  return { key, type, ttlMs, value };
}

async function snapshotDatabase(db) {
  // SCAN/DBSIZE membuktikan data-plane sudah pulih; PING saja bisa tetap sukses
  // ketika limit bandwidth memblokir command data.
  await redisCall(db, 'PING');
  const keys = await scanKeys(db);
  const records = {};
  for (const key of keys) records[key] = await readRecord(db, key);
  return { label: db.label, host: new URL(db.url).hostname, capturedAt: new Date().toISOString(), records };
}

function writeBackup(baseDir, name, snapshot) {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' });
  return file;
}

function chunks(items, size = 100) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function buildTemporaryRecord(db, tempKey, record) {
  await redisCall(db, 'DEL', tempKey);
  if (record.type === 'string') await redisCall(db, 'SET', tempKey, record.value ?? '');
  else if (record.type === 'hash') {
    const args = Object.entries(record.value || {}).flat();
    for (const part of chunks(args, 100)) if (part.length) await redisCall(db, 'HSET', tempKey, ...part);
  } else if (record.type === 'list') {
    for (const part of chunks(record.value || [])) if (part.length) await redisCall(db, 'RPUSH', tempKey, ...part);
  } else if (record.type === 'set') {
    for (const part of chunks(record.value || [])) if (part.length) await redisCall(db, 'SADD', tempKey, ...part);
  } else if (record.type === 'zset') {
    const args = [];
    for (const [member, score] of normalizeZset(record.value)) args.push(score, member);
    for (const part of chunks(args, 100)) if (part.length) await redisCall(db, 'ZADD', tempKey, ...part);
  } else if (record.type === 'stream') {
    for (const [id, fields] of record.value || []) await redisCall(db, 'XADD', tempKey, id, ...(fields || []));
  } else if (record.type.includes('json')) {
    await redisCall(db, 'JSON.SET', tempKey, '$', record.value);
  } else throw new Error(`Tidak dapat menulis tipe ${record.type}`);
  if (record.ttlMs > 0) await redisCall(db, 'PEXPIRE', tempKey, String(record.ttlMs));
}

async function replaceRecord(db, key, record, runId) {
  const tempKey = `__migration__:${runId}:${key}`;
  await buildTemporaryRecord(db, tempKey, record);
  await redisCall(db, 'RENAME', tempKey, key);
}

async function mergeInto(sourceSnapshot, destinationDb, execute, runId) {
  const report = { considered: 0, changed: 0, skippedEphemeral: 0, conflicts: [] };
  for (const [key, sourceRecord] of Object.entries(sourceSnapshot.records)) {
    if (isEphemeralKey(key)) { report.skippedEphemeral++; continue; }
    report.considered++;
    const freshDestination = await readRecord(destinationDb, key);
    const merged = mergeRecords(key, sourceRecord, freshDestination);
    if (merged?.conflict) report.conflicts.push({ key, conflict: merged.conflict });
    if (recordDigest(merged) === recordDigest(freshDestination)) continue;
    report.changed++;
    if (execute) await replaceRecord(destinationDb, key, merged, runId);
  }
  return report;
}

async function mirrorSnapshot(sourceSnapshot, destinationDb, execute, runId) {
  const report = { considered: 0, changed: 0, skippedEphemeral: 0 };
  for (const [key, sourceRecord] of Object.entries(sourceSnapshot.records)) {
    if (isEphemeralKey(key)) { report.skippedEphemeral++; continue; }
    report.considered++;
    const destination = await readRecord(destinationDb, key);
    if (recordDigest(sourceRecord) === recordDigest(destination)) continue;
    report.changed++;
    if (execute) await replaceRecord(destinationDb, key, sourceRecord, runId);
  }
  return report;
}

async function verifyEquivalent(sourceDb, destinationDb) {
  const sourceKeys = (await scanKeys(sourceDb)).filter(key => !isEphemeralKey(key));
  const missing = [];
  const mismatched = [];
  for (const key of sourceKeys) {
    const [source, destination] = await Promise.all([readRecord(sourceDb, key), readRecord(destinationDb, key)]);
    if (!destination) missing.push(key);
    else if (recordDigest(source) !== recordDigest(destination)) mismatched.push(key);
  }
  return { checked: sourceKeys.length, missing, mismatched, ok: missing.length === 0 && mismatched.length === 0 };
}

function parseArgs(argv) {
  const args = new Set(argv);
  const confirmArg = argv.find(arg => arg.startsWith('--confirm='));
  return {
    execute: args.has('--execute'),
    confirm: confirmArg ? confirmArg.slice('--confirm='.length) : '',
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.execute && options.confirm !== CONFIRM_TEXT) {
    throw new Error(`Mode tulis membutuhkan --confirm=${CONFIRM_TEXT}`);
  }
  const { redis1, redis2 } = credentials();
  for (const db of [redis1, redis2]) {
    if (!db.url || !db.token) throw new Error(`Kredensial ${db.label} belum lengkap`);
  }
  if (redis1.url === redis2.url) throw new Error('Redis 1 dan Redis 2 menunjuk URL yang sama; migrasi dibatalkan');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(process.cwd(), '.cache', 'redis-migration', runId);
  console.log(`Mode: ${options.execute ? 'EXECUTE' : 'DRY-RUN'}; backup: ${backupDir}`);

  const snapshot1 = await snapshotDatabase(redis1);
  const snapshot2 = await snapshotDatabase(redis2);
  console.log(`Inventaris awal: Redis 1=${Object.keys(snapshot1.records).length} key, Redis 2=${Object.keys(snapshot2.records).length} key`);
  console.log('Backup Redis 1:', writeBackup(backupDir, 'redis1-before', snapshot1));
  console.log('Backup Redis 2:', writeBackup(backupDir, 'redis2-before', snapshot2));

  const mergeReport = await mergeInto(snapshot1, redis2, options.execute, runId);
  console.log('Tahap 1 Redis 1 -> Redis 2:', mergeReport);
  if (!options.execute) {
    console.log('Dry-run selesai. Tidak ada data Redis yang diubah.');
    return { dryRun: true, mergeReport };
  }

  const canonical2 = await snapshotDatabase(redis2);
  console.log('Backup Redis 2 gabungan:', writeBackup(backupDir, 'redis2-canonical', canonical2));
  const mirrorReport = await mirrorSnapshot(canonical2, redis1, true, runId);
  console.log('Tahap 2 Redis 2 -> Redis 1:', mirrorReport);

  // Satu delta pass menangkap perubahan yang masuk ke Redis 2 ketika pass pertama berjalan.
  const latest2 = await snapshotDatabase(redis2);
  const deltaReport = await mirrorSnapshot(latest2, redis1, true, `${runId}:delta`);
  console.log('Delta pass Redis 2 -> Redis 1:', deltaReport);

  const verification = await verifyEquivalent(redis2, redis1);
  writeBackup(backupDir, 'verification', verification);
  if (!verification.ok) {
    throw new Error(`Verifikasi gagal: missing=${verification.missing.length}, mismatch=${verification.mismatched.length}. Jangan cutover ke Redis 1.`);
  }
  console.log(`Verifikasi lulus: ${verification.checked} key bernilai setara. Redis 1 siap untuk cutover manual/otomasi.`);
  return { dryRun: false, mergeReport, mirrorReport, deltaReport, verification };
}

if (require.main === module) {
  main().catch(error => {
    console.error('Migrasi Redis gagal aman:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRM_TEXT,
  isEphemeralKey,
  flatPairsToObject,
  timestampFrom,
  chooseNewer,
  mergeJsonHistory,
  mergeRecords,
  recordDigest,
  parseArgs,
  main,
};
