// api/_market_hours.js — helper murni jam buka market FX + deteksi candle basi.
// Underscore prefix = bukan route publik, tidak makan jatah 12 function Vercel.
//
// Dipakai probe `data_freshness` di api/admin.js (action=health) untuk lapisan
// self-healing sisi Vercel: kalau candle sentinel basi saat market buka, health
// check MENYEMBUHKAN (trigger ohlcv_sync) bukan cuma melapor.
//
// DUPLIKASI SADAR dengan vps/daemon.js (isFxMarketOpen/newestCandleEpoch/
// isCandleStale) — vps/ di-build sebagai Docker image terisolasi (Root
// Directory Railway = vps/) jadi tidak bisa require lintas folder; dijaga
// sinkron oleh test/vps/self_healing.test.js (sweep per-jam dibandingkan).

const CANDLE_STALE_MS = 3 * 60 * 60 * 1000; // 3 jam — candle H1 sehat maks ~2 jam

function isFxMarketOpen(date = new Date()) {
  const day = date.getUTCDay(), hour = date.getUTCHours();
  if (day === 6) return false;      // Sabtu tutup penuh
  if (day === 0) return hour >= 22; // Minggu buka ~21:00 UTC; 22 = margin aman
  if (day === 5) return hour < 21;  // Jumat tutup 21:00 UTC
  return true;
}

function newestCandleEpoch(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let max = null;
  for (const c of arr) {
    const t = Number(c && c.t);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

function isCandleStale(arr, nowMs, staleMs = CANDLE_STALE_MS) {
  const t = newestCandleEpoch(arr);
  if (t == null) return true; // tidak ada data sama sekali = basi
  return nowMs - t * 1000 > staleMs;
}

module.exports = { isFxMarketOpen, newestCandleEpoch, isCandleStale, CANDLE_STALE_MS };
