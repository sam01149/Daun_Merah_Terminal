// Menentukan apakah cache Ringkasan sudah dibuat untuk sesi terjadwal saat ini.
// Dipakai market-digest.yml: heartbeat daemon membuktikan proses VPS hidup,
// tetapi tidak membuktikan callback scheduler digest benar-benar berjalan.
// File ini sengaja murni dan diekspor supaya batas sesi dapat diuji deterministik.

const SESSION_SLOTS_UTC = [
  [0, 2],   // Asia: 07:02 WIB
  [7, 2],   // London: 14:02 WIB
  [12, 32], // New York: 19:32 WIB
];

function latestDigestSessionStart(now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;
  const utc = new Date(nowMs);
  const y = utc.getUTCFullYear(), m = utc.getUTCMonth(), d = utc.getUTCDate();

  for (let i = SESSION_SLOTS_UTC.length - 1; i >= 0; i--) {
    const [hour, minute] = SESSION_SLOTS_UTC[i];
    const candidate = new Date(Date.UTC(y, m, d, hour, minute));
    if (candidate.getTime() <= nowMs) return candidate;
  }

  // Sebelum sesi Asia hari ini, acuan terakhir adalah sesi New York kemarin.
  const [hour, minute] = SESSION_SLOTS_UTC.at(-1);
  return new Date(Date.UTC(y, m, d - 1, hour, minute));
}

function isDigestCurrentSession(generatedAt, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const generatedMs = new Date(generatedAt).getTime();
  const boundary = latestDigestSessionStart(now);
  return Number.isFinite(nowMs) && Number.isFinite(generatedMs) &&
    generatedMs <= nowMs && !!boundary && generatedMs >= boundary.getTime();
}

function isCachedDigestCurrentSession(payload, now = new Date()) {
  return !!payload && isDigestCurrentSession(payload.generated_at, now);
}

if (require.main === module) {
  const fs = require('fs');
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (_) { /* cache invalid = stale */ }
  process.stdout.write(isCachedDigestCurrentSession(payload) ? 'true\n' : 'false\n');
}

module.exports = { SESSION_SLOTS_UTC, latestDigestSessionStart, isDigestCurrentSession, isCachedDigestCurrentSession };
