// api/_levels.js
// PLAN Z (2026-08-18, Dokumentasi/professional_llm_trader/changelog.md) — kandidat
// SL/TP deterministik, memperluas pola `_confluenceZones` (api/admin.js) yang sudah
// terbukti menghentikan entry_zone "lompat-lompat" antar re-generate, ke dua field
// yang sampai sekarang masih bebas dikarang AI tiap generate: sl dan tp.
//
// Pure functions saja (pola sama api/_auto_entry_guard.js / api/_position_review.js)
// — TIDAK mengumpulkan level sendiri dari candle mentah. Menerima `zones` (OUTPUT
// `_confluenceZones` yang sudah dihitung admin.js) sebagai input, supaya SATU sumber
// kebenaran struktur (S/R, fib, pivot, swing, SMA, expiry) dipakai bersama entry_zone
// DAN sl/tp — bukan pipeline ekstraksi kedua yang bisa divergen dari yang pertama.
//
// Desain (bias TIDAK diketahui saat prompt dibangun — sama seperti entryZoneInstr
// di admin.js): dihitung untuk KEDUA arah sekaligus (bearish & bullish); prompt
// menyajikan dua varian, AI memilih sesuai bias yang ia tentukan sendiri di respons
// yang sama.
//
// - SL: sisi zona yang SAMA dengan arah invalidasi (bearish -> above Now, bullish ->
//   below Now). Zona TERDEKAT ke Now di sisi itu diasumsikan jadi pilihan entry_zone
//   AI (pola entryZoneInstr: skor tertinggi, tie-break ke yang terdekat) — dikeluarkan
//   dari kandidat SL supaya SL tidak kebetulan sama dengan entry. Kandidat sintetis
//   "buffer ATR di luar struktur terjauh" SELALU ditambahkan (buffer sama persis
//   dengan slBufferMult yang sudah dipakai instruksi sl bebas di admin.js: 1x ATR
//   XAU, 0.5x ATR FX) supaya SL tetap ada walau confluence di sisi itu tipis (mis.
//   cuma 1 zona) — jaring pengaman ATR ini boleh untuk SL (murni protektif), TIDAK
//   untuk TP (lihat bawah).
// - TP: SEMUA zona di sisi profit (sisi berlawanan dari SL) apa adanya — tidak ada
//   eksklusi atau kandidat sintetis. TP harus struktural sungguhan, beda filosofi
//   dari SL yang boleh punya jaring pengaman ATR murni.
// - Filter RR: kandidat TP yang bahkan dipasangkan dengan SL TERDEKAT (skenario RR
//   terbaik yang tersedia) masih < 1 dibuang dari daftar SEBELUM sampai ke AI (plan
//   langkah 3). Ini BUKAN jaminan setiap kombinasi >= 1 (AI masih bisa pilih SL
//   terjauh + TP yang lolos filter ini dan hasilnya tetap < 1 kalau strukturnya
//   ekstrem) — jaring pengaman TERAKHIR tetap sanity-check RR yang SUDAH ADA di
//   ohlcvAnalyzeHandler (api/admin.js), TIDAK diubah/digantikan modul ini.
// - `time_horizon_days` SENGAJA TIDAK dipakai menyaring TP yang kelewat jauh (plan
//   menyebutnya "pertimbangkan", bukan wajib) — field itu dihasilkan AI di RESPONS
//   YANG SAMA dengan sl/tp, jadi tidak tersedia saat kandidat ini dihitung untuk
//   PROMPT. Menyaring dari ATR saja tanpa horizon nyata berisiko menambah konstanta
//   tebakan baru yang belum divalidasi data — dihindari sesuai prinsip proyek ini.
// - `tolerance` yang dikembalikan = `zones.tolerance` (granularitas cluster yang
//   SAMA dipakai `_confluenceZones` menyatukan level berdekatan jadi satu zona) —
//   dipakai admin.js buat snap-atau-tolak sl/tp hasil parse AI terhadap kandidat ini
//   (kalau selisihnya dalam granularitas "zona yang sama", itu cuma pembulatan; di
//   luar itu, level yang genuinely berbeda).

function _zoneList(zones, dec) {
  if (!Array.isArray(zones) || !zones.length) return null;
  return zones.map(z => ({ price: z.center, label: `zona konfluensi ${z.center.toFixed(dec)} [skor ${z.score}]` }));
}

// Kandidat SL untuk satu sisi: semua zona di sisi itu KECUALI yang terdekat ke Now
// (diasumsikan itu pilihan entry_zone AI), ditambah SATU kandidat sintetis "buffer
// ATR di luar struktur terjauh" di sisi yang sama — `sign` = +1 (above, makin besar)
// atau -1 (below, makin kecil), menentukan arah ekstensi buffer.
function _slSide(zones, now, buffer, sign, dec) {
  if (!Array.isArray(zones) || !zones.length) return null;
  const byDist = [...zones].sort((a, b) => Math.abs(a.center - now) - Math.abs(b.center - now));
  const rest = byDist.slice(1).map(z => ({ price: z.center, label: `zona konfluensi ${z.center.toFixed(dec)} [skor ${z.score}]` }));
  const farthest = byDist[byDist.length - 1].center;
  const synthetic = { price: +(farthest + sign * buffer).toFixed(dec), label: `buffer ATR di luar struktur terjauh ${farthest.toFixed(dec)}` };
  return [...rest, synthetic];
}

function _direction(slPool, tpPool, now) {
  if (!slPool || !tpPool) return null;
  const minSlDist = Math.min(...slPool.map(s => Math.abs(s.price - now)));
  const tp = tpPool.filter(t => Math.abs(t.price - now) >= minSlDist);
  if (!tp.length) return null;
  return { sl: slPool, tp };
}

// zones: output `_confluenceZones(data, expiryLvls)` dari admin.js — { now, tolerance, above, below } atau null.
// atrD: `data.d1_ext.atr_d` kalau tersedia, else null (fallback persentase, pola sama _confluenceZones).
// isXau: `data.is_xau` — menentukan buffer SL 1x ATR (XAU) vs 0.5x ATR (FX), pola sama slBufferMult admin.js.
// dec: `data.dec` — presisi desimal pair ini.
function computeLevelCandidates({ zones, atrD, isXau, dec }) {
  if (!zones || typeof zones.now !== 'number' || !Number.isFinite(zones.now)) return null;
  const now = zones.now;
  const d = dec ?? 5;
  const bufMult = isXau ? 1 : 0.5;
  const buffer = (atrD != null && Number.isFinite(atrD) && atrD > 0) ? atrD * bufMult : now * 0.0015;

  const slAbove = _slSide(zones.above, now, buffer, +1, d); // kandidat SL bearish
  const slBelow = _slSide(zones.below, now, buffer, -1, d); // kandidat SL bullish
  const tpAbove = _zoneList(zones.above, d);                // kandidat TP bullish
  const tpBelow = _zoneList(zones.below, d);                // kandidat TP bearish

  const bearish = _direction(slAbove, tpBelow, now); // SL di atas Now, TP di bawah Now
  const bullish = _direction(slBelow, tpAbove, now); // SL di bawah Now, TP di atas Now
  if (!bearish && !bullish) return null;

  return { now: +now.toFixed(d), dec: d, tolerance: zones.tolerance, bearish, bullish };
}

module.exports = { computeLevelCandidates };
