/**
 * Alias kompatibilitas untuk nama skrip migrasi lama.
 *
 * Implementasi lama hanya memindahkan empat kelompok key dari Redis 1 ke Redis 2
 * dan tidak membawa data fundamental ataupun data fallback kembali ke Redis 1.
 * Seluruh eksekusi sekarang diarahkan ke sinkronisasi penuh dua tahap.
 *
 * Dry-run (default):
 *   node scripts/merge_redis_history.js
 *
 * Eksekusi setelah Redis 1 pulih:
 *   node scripts/merge_redis_history.js --execute --confirm=SYNC_BOTH_REDIS_ACCOUNTS
 */

const { main } = require('./sync_redis_accounts');

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error('Migrasi Redis gagal aman:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
