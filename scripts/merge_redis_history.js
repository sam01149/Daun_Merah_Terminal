/**
 * scripts/merge_redis_history.js
 * Skrip penyelamat ingatan: menggabungkan data historis berharga dari Redis 1
 * (setup auto-entry, riwayat jurnal trading, sizing, subscriber notifikasi)
 * ke Redis 2 tanpa menimpa atau merusak data baru yang dibuat selama masa fallback.
 *
 * Jalankan setelah Redis 1 pulih/reset kuota:
 *   node scripts/merge_redis_history.js
 */

const fs = require('fs');
const path = require('path');

function getEnvVal(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return null;
  const env = fs.readFileSync(envPath, 'utf8');
  const lines = env.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(key + '=')) {
      let val = line.slice(key.length + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      return val;
    }
  }
  return null;
}

async function redisCall(url, token, ...args) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  const json = await r.json();
  if (!r.ok || json.error) throw new Error(`HTTP ${r.status}: ${json.error || 'unknown'}`);
  return json.result;
}

async function main() {
  const url1 = getEnvVal('UPSTASH_REDIS_REST_URL');
  const token1 = getEnvVal('UPSTASH_REDIS_REST_TOKEN');
  const url2 = getEnvVal('UPSTASH_REDIS_REST_URL_2') || getEnvVal('UPSTASH2_REDIS_REST_URL');
  const token2 = getEnvVal('UPSTASH_REDIS_REST_TOKEN_2') || getEnvVal('UPSTASH2_REDIS_REST_TOKEN');

  if (!url1 || !token1 || !url2 || !token2) {
    console.error('Error: Kredensial Redis 1 dan Redis 2 harus tersedia di env atau .env.local');
    process.exit(1);
  }

  console.log('--- Skrip Penggabungan Riwayat Redis 1 -> Redis 2 ---');
  console.log('Sumber (Redis 1):', url1);
  console.log('Tujuan (Redis 2):', url2);

  // 1. Cek kesehatan sumber
  try {
    const ping1 = await redisCall(url1, token1, 'PING');
    console.log('Status Redis 1:', ping1);
  } catch (err) {
    console.error('Redis 1 belum dapat diakses:', err.message);
    console.log('Silakan jalankan kembali setelah kuota bulanan Redis 1 reset.');
    process.exit(0);
  }

  // 2. Cek tujuan
  try {
    const ping2 = await redisCall(url2, token2, 'PING');
    console.log('Status Redis 2:', ping2);
  } catch (err) {
    console.error('Redis 2 tidak dapat diakses:', err.message);
    process.exit(1);
  }

  // 3. Merge setup_log_auto:v1
  try {
    console.log('\n[1/4] Menggabungkan setup_log_auto:v1...');
    const raw1 = await redisCall(url1, token1, 'GET', 'setup_log_auto:v1');
    const raw2 = await redisCall(url2, token2, 'GET', 'setup_log_auto:v1');
    const list1 = raw1 ? JSON.parse(raw1) : [];
    const list2 = raw2 ? JSON.parse(raw2) : [];

    const existingIds = new Set(list2.map(item => item.id || item.timestamp));
    let added = 0;
    for (const item of list1) {
      const key = item.id || item.timestamp;
      if (!existingIds.has(key)) {
        list2.push(item);
        existingIds.add(key);
        added++;
      }
    }
    // Sort descending by timestamp
    list2.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    await redisCall(url2, token2, 'SET', 'setup_log_auto:v1', JSON.stringify(list2));
    console.log(`Selesai: ${added} setup lama digabungkan (total sekarang: ${list2.length}).`);
  } catch (err) {
    console.warn('Peringatan saat menggabungkan setup_log_auto:', err.message);
  }

  // 4. Merge Journal (journal:index & journal:entries:*)
  try {
    console.log('\n[2/4] Menggabungkan jurnal transaksi manual...');
    const rawIdx1 = await redisCall(url1, token1, 'GET', 'journal:index');
    const rawIdx2 = await redisCall(url2, token2, 'GET', 'journal:index');
    const idx1 = rawIdx1 ? JSON.parse(rawIdx1) : [];
    const idx2 = rawIdx2 ? JSON.parse(rawIdx2) : [];

    const existingEntries = new Set(idx2);
    let copiedEntries = 0;
    for (const entryId of idx1) {
      if (!existingEntries.has(entryId)) {
        const itemData = await redisCall(url1, token1, 'GET', `journal:entries:${entryId}`);
        if (itemData) {
          await redisCall(url2, token2, 'SET', `journal:entries:${entryId}`, itemData);
          idx2.push(entryId);
          existingEntries.add(entryId);
          copiedEntries++;
        }
      }
    }
    await redisCall(url2, token2, 'SET', 'journal:index', JSON.stringify(idx2));
    console.log(`Selesai: ${copiedEntries} entri jurnal lama disalin (total index: ${idx2.length}).`);
  } catch (err) {
    console.warn('Peringatan saat menggabungkan jurnal:', err.message);
  }

  // 5. Merge Sizing History
  try {
    console.log('\n[3/4] Menggabungkan riwayat kalkulator sizing...');
    const rawSz1 = await redisCall(url1, token1, 'GET', 'sizing:history');
    const rawSz2 = await redisCall(url2, token2, 'GET', 'sizing:history');
    const sz1 = rawSz1 ? JSON.parse(rawSz1) : [];
    const sz2 = rawSz2 ? JSON.parse(rawSz2) : [];

    const existingSz = new Set(sz2.map(s => s.id || s.timestamp));
    let addedSz = 0;
    for (const s of sz1) {
      const key = s.id || s.timestamp;
      if (!existingSz.has(key)) {
        sz2.push(s);
        existingSz.add(key);
        addedSz++;
      }
    }
    sz2.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    await redisCall(url2, token2, 'SET', 'sizing:history', JSON.stringify(sz2));
    console.log(`Selesai: ${addedSz} entri sizing lama digabungkan (total: ${sz2.length}).`);
  } catch (err) {
    console.warn('Peringatan saat menggabungkan sizing history:', err.message);
  }

  // 6. Merge Push Subscribers
  try {
    console.log('\n[4/4] Menggabungkan subscriber notifikasi...');
    const subs1 = await redisCall(url1, token1, 'HGETALL', 'push_subs') || {};
    let subsMerged = 0;
    const keys = Array.isArray(subs1) ? [] : Object.keys(subs1);
    for (let i = 0; i < (Array.isArray(subs1) ? subs1.length : keys.length); i += (Array.isArray(subs1) ? 2 : 1)) {
      const k = Array.isArray(subs1) ? subs1[i] : keys[i];
      const v = Array.isArray(subs1) ? subs1[i + 1] : subs1[k];
      await redisCall(url2, token2, 'HSETNX', 'push_subs', k, v);
      subsMerged++;
    }
    console.log(`Selesai: sinkronisasi subscriber notifikasi (${subsMerged} diperiksa/ditambahkan).`);
  } catch (err) {
    console.warn('Peringatan saat menggabungkan subscriber:', err.message);
  }

  console.log('\nPenggabungan riwayat selesai dengan sukses!');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
