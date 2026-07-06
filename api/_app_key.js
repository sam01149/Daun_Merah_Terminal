// api/_app_key.js
// Gate akses aplikasi: endpoint publik menolak request tanpa header x-app-key yang
// cocok dengan env APP_KEY. Tujuan: kalau URL vercel.app bocor, orang asing tidak
// bisa memicu AI call / menghabiskan kuota harian (lihat _ai_guard.js) — bukan
// pengganti rate limit/budget yang sudah ada, tapi lapisan di depannya.
// Underscore prefix = Vercel TIDAK mengekspos file ini sebagai route publik.
//
// Perilaku:
// - APP_KEY tidak diset → gate NONAKTIF (fail-open) — deploy dulu aman, kunci baru
//   aktif setelah env diset di Vercel. Beda filosofi dengan _ai_guard yang juga
//   fail-open: dua-duanya memilih "app tetap hidup" saat konfigurasi belum lengkap.
// - OPTIONS selalu lolos (preflight tidak membawa custom header).
// - Cron/admin lolos via x-cron-secret / x-admin-secret === CRON_SECRET (pola yang
//   sama dengan gate cron yang sudah ada di admin.js/market-digest.js) atau header
//   x-vercel-cron dari Vercel.
// - Perbandingan key pakai timingSafeEqual (anti timing attack).
//
// Usage (di awal handler, setelah/ sebelum CORS bebas — OPTIONS sudah di-skip):
//   const { requireAppKey } = require('./_app_key');
//   if (requireAppKey(req, res)) return;   // true = sudah dibalas 401, hentikan handler

const crypto = require('crypto');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAppKey(req, res) {
  const APP_KEY = process.env.APP_KEY;
  if (!APP_KEY) return false;                          // gate belum dikonfigurasi
  if (req.method === 'OPTIONS') return false;          // preflight → biarkan handler balas 204

  const given = req.headers['x-app-key'];
  if (given && safeEqual(given, APP_KEY)) return false;

  // Jalur cron/admin yang sudah ada — jangan sampai GitHub Actions / cron-job.org putus
  if (req.headers['x-vercel-cron'] === '1') return false;
  const CRON = process.env.CRON_SECRET;
  if (CRON && (
    (req.headers['x-cron-secret']  && safeEqual(req.headers['x-cron-secret'],  CRON)) ||
    (req.headers['x-admin-secret'] && safeEqual(req.headers['x-admin-secret'], CRON))
  )) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(401).json({ error: 'app_key_required' });
  return true;
}

module.exports = { requireAppKey };
