// vps/heartbeat.js — Q-1: uji uptime hosting (Render dan Oracle DITOLAK di
// tahap verifikasi kartu, lihat README-deploy.md — Railway jadi jalur aktif
// karena tidak minta kartu di signup) sebelum Plan Q lanjut ke daemon
// streaming (Q-2+). Fungsi TUNGGAL: SET vps:heartbeat <epoch> EX 300 di
// Upstash Redis tiap 60 detik. TANPA token AI/Deriv/Telegram — kalau host ini
// kompromi, tidak ada kunci berbayar yang ikut bocor (lihat Edge Case di
// daun_merah_plan.md §Plan Q).
//
// Host Web Service (Render/Railway) BUKAN background worker biasa — WAJIB
// listen di $PORT dan balas HTTP supaya platform tidak anggap service mati.
// Endpoint yang sama juga jadi target pinger cron-job.org. Bind eksplisit ke
// 0.0.0.0 (bukan default) — syarat Railway (lihat docs.railway.com/guides/
// fixing-common-errors), aman juga untuk Render.

const http = require('node:http');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PORT         = process.env.PORT || 3000;
const BEAT_INTERVAL_MS = 60 * 1000;
const BEAT_TTL_SECS    = 300; // 5 menit — gate Q-1 mendeteksi gap >5 menit

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('heartbeat: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN belum di-set — berhenti.');
  process.exit(1);
}

let lastBeatOk = null;
let lastBeatError = null;

async function redisCmd(...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  return (await r.json()).result;
}

async function beat() {
  const epoch = Math.floor(Date.now() / 1000);
  try {
    const result = await redisCmd('SET', 'vps:heartbeat', String(epoch), 'EX', String(BEAT_TTL_SECS));
    if (result !== 'OK') throw new Error(`Unexpected Redis reply: ${JSON.stringify(result)}`);
    // Marker PERMANEN (tanpa EX) — dipakai probeVpsHeartbeat (api/admin.js) untuk
    // membedakan "daemon belum pernah di-deploy" (diam, jangan alert) dari
    // "daemon sempat jalan, sekarang beneran mati >5 menit" (alert asli). Tanpa
    // ini, probe akan mengira BELUM di-deploy = DOWN dan spam Telegram sejak
    // detik pertama sebelum user sempat deploy ke Render.
    if (!lastBeatOk) await redisCmd('SET', 'vps:heartbeat:configured', '1');
    lastBeatOk = epoch;
    lastBeatError = null;
    console.log(`heartbeat: OK @ ${epoch}`);
  } catch (e) {
    lastBeatError = e.message;
    console.warn(`heartbeat: FAILED — ${e.message}`);
  }
}

beat();
setInterval(beat, BEAT_INTERVAL_MS);

// Endpoint minimal untuk health check platform + pinger cron-job.org.
// Sengaja tanpa dependency HTTP framework — satu route saja.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'up',
    last_beat_epoch: lastBeatOk,
    last_beat_error: lastBeatError,
  }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`heartbeat: HTTP server listening on 0.0.0.0:${PORT}`);
});
