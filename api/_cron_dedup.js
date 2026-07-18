// api/_cron_dedup.js — cek "apakah cache masih cukup fresh untuk sumber cron
// KEDUA lewati generate ulang" (Plan Q-6, 2026-07-18). Diekstrak jadi pure
// function supaya dites tanpa perlu mock Redis/handler penuh — dipakai di
// api/market-digest.js (latest_article) dan api/admin.js ohlcvAnalyzeHandler
// (ohlcv_analysis:<symbol>), dua tempat yang tadinya masing-masing punya
// salinan logic sendiri.
//
// Kenapa perlu: market-digest & ohlcv_analyze dulu diasumsikan "cron cuma 1
// sumber, tidak pernah tabrakan" — begitu vps/daemon.js ikut memicu paralel
// dengan GitHub Actions (sengaja, untuk bandingkan ketepatan jadwal), asumsi
// itu tidak berlaku lagi. Tanpa dedup ini, AI dipanggil 2x per slot untuk
// hasil yang identik + push notifikasi dobel ke user.
// Underscore prefix = bukan serverless function (limit Vercel Hobby 12/12 penuh).

function isCronCall(req) {
  return req.headers['x-vercel-cron'] === '1' ||
    !!(process.env.CRON_SECRET && (
      req.headers['x-cron-secret']  === process.env.CRON_SECRET ||
      req.headers['x-admin-secret'] === process.env.CRON_SECRET));
}

// timestampIso: field waktu dari payload cache (generated_at / loaded_at).
// now: Date.now() — parameter eksplisit (bukan dipanggil di dalam) supaya
// gampang dites deterministik, bukan kebetulan lolos/gagal karena timing.
function isCronDedupFresh(timestampIso, now, windowMs) {
  if (!timestampIso) return false;
  const age = now - new Date(timestampIso).getTime();
  return Number.isFinite(age) && age >= 0 && age < windowMs;
}

module.exports = { isCronCall, isCronDedupFresh };
