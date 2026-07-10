// api/_cb_shock.js — FOMC/Central Bank Shock Detector (plan G6).
// RULE-BASED SEPENUHNYA, TANPA panggilan AI: klasifikasi dihitung pasti di kode
// (prinsip plan G — aturan checkable dihitung di kode, AI tidak dipakai menilai),
// narasi Bahasa Indonesia dari template deterministik (pola _labour_market.js).
//
// Kerangka: Nakamura & Steinsson — reaksi pasar atas keputusan bank sentral bisa
// berupa "policy shock" (kejutan kebijakan murni: harga bergerak searah arah
// keputusan) atau "information shock" (pasar membaca keputusan sebagai sinyal
// tentang kondisi ekonomi: harga bergerak berlawanan, atau bergerak signifikan
// padahal keputusan tidak berubah).
//
// KETERBATASAN RESOLUSI (wajib tampil di UI): data harga tertinggi yang tersedia
// di app ini adalah candle 1 JAM (Yahoo interval=1h) — jendela reaksi 30-60 menit
// ala paper TIDAK bisa direplikasi. Analisis di sini adalah "reaksi per-jam" dan
// bisa tercampur antara reaksi keputusan vs reaksi konferensi pers.
//
// Underscore prefix = bukan serverless function (limit Vercel Hobby 12/12 penuh);
// di-serve lewat api/cb-status.js?section=shock.

// Ambang noise ±0.3% FX — HEURISTIK TAHAP PERTAMA, perlu kalibrasi ulang dari
// observasi live pasca-deploy (pola sama seperti flat-band _labour_market.js yang
// juga mulai dari estimasi lalu dikalibrasi).
const NOISE_BAND_PCT = 0.3;

// Jam pengumuman keputusan per bank sentral (UTC, approx — DST bisa menggeser ±1
// jam; resolusi kita toh per-jam). Dipakai untuk memilih candle baseline pre-rapat.
const CB_ANNOUNCE_HOUR_UTC = {
  USD: 19, // FOMC 14:00 ET
  EUR: 13, // ECB 14:15 CET
  GBP: 12, // BoE 12:00 London
  JPY: 3,  // BoJ ~lunchtime JST
  CAD: 14, // BoC 09:45 ET
  AUD: 4,  // RBA 14:30 AEST
  NZD: 2,  // RBNZ 14:00 NZST
  CHF: 8,  // SNB 09:30 CET
};

// Proxy pair per currency (simbol Yahoo yang sudah disync ohlcv_sync).
// invert=true → currency yang dinilai adalah QUOTE pair (pair naik = currency melemah).
const CB_SHOCK_PROXY = {
  USD: { symbol: 'EURUSD=X', pair: 'EUR/USD', invert: true },
  EUR: { symbol: 'EURUSD=X', pair: 'EUR/USD', invert: false },
  GBP: { symbol: 'GBPUSD=X', pair: 'GBP/USD', invert: false },
  JPY: { symbol: 'USDJPY=X', pair: 'USD/JPY', invert: true },
  CAD: { symbol: 'USDCAD=X', pair: 'USD/CAD', invert: true },
  AUD: { symbol: 'AUDUSD=X', pair: 'AUD/USD', invert: false },
  NZD: { symbol: 'NZDUSD=X', pair: 'NZD/USD', invert: false },
  CHF: { symbol: 'USDCHF=X', pair: 'USD/CHF', invert: true },
};

const REACTION_HOURS = 3; // close baseline → close +3 jam (mencakup awal konferensi pers)

// Reaksi harga per-jam dari candle 1h: % perubahan close candle terakhir SEBELUM
// jam pengumuman → close ~REACTION_HOURS jam sesudahnya. null kalau candle tidak
// cukup menutupi jendela (libur/gap Yahoo) — "jangan menebak".
function computeHourlyReaction(candles, announceTsSec, hours = REACTION_HOURS) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  let baseIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].t < announceTsSec) baseIdx = i;
    else break;
  }
  if (baseIdx < 0) return null;
  const base = sorted[baseIdx];
  // Baseline harus dekat pengumuman (≤3 jam sebelum) — kalau candle terakhir jauh
  // (gap weekend/libur), reaksi tidak bisa diukur jujur.
  if (announceTsSec - base.t > 3 * 3600) return null;
  const targetTs = announceTsSec + hours * 3600;
  // Candle terakhir dalam jendela [announce, target] — pakai yang terdekat ke target.
  let after = null;
  for (let i = baseIdx + 1; i < sorted.length; i++) {
    if (sorted[i].t <= targetTs) after = sorted[i];
    else break;
  }
  if (!after || base.c <= 0) return null;
  return +(((after.c - base.c) / base.c) * 100).toFixed(3);
}

// Klasifikasi shock — pure function.
//   changed          : keputusan mengubah suku bunga (bukan hold)
//   rateChangeBps    : besaran perubahan (negatif = cut), 0 kalau hold
//   expectedChangeBps: perubahan yang di-price-in pre-meeting dari rate-path
//                      (null kalau tidak tersedia — umumnya hanya USD & hanya
//                      kalau snapshot pre-meeting ada)
//   pairMovePct      : % pergerakan proxy pair dalam jendela reaksi (null = gap data)
//   invert           : currency adalah quote pair → arah dibalik
// Return { classification, currencyMovePct }.
function classifyCbShock({ changed, rateChangeBps, expectedChangeBps = null, pairMovePct, invert = false }) {
  if (pairMovePct == null || !isFinite(pairMovePct)) {
    return { classification: 'insufficient_data', currencyMovePct: null };
  }
  const move = +(invert ? -pairMovePct : pairMovePct).toFixed(3); // + = currency menguat
  if (Math.abs(move) <= NOISE_BAND_PCT) {
    return { classification: 'no_shock', currencyMovePct: move };
  }
  if (changed && rateChangeBps !== 0) {
    // Keputusan berubah lebih kecil dari yang di-price-in = efektif kejutan hawkish/
    // dovish relatif ekspektasi → information shock walau harga searah keputusan.
    const smallerThanPriced = expectedChangeBps != null
      && Math.sign(expectedChangeBps) === Math.sign(rateChangeBps)
      && Math.abs(rateChangeBps) < Math.abs(expectedChangeBps);
    const sameDirection = Math.sign(move) === Math.sign(rateChangeBps);
    if (sameDirection && !smallerThanPriced) return { classification: 'policy_shock', currencyMovePct: move };
    return { classification: 'information_shock', currencyMovePct: move };
  }
  // Keputusan TIDAK berubah tapi harga bergerak signifikan → information shock
  // (guidance/konferensi pers/pembacaan pasar atas sinyal ekonomi).
  return { classification: 'information_shock', currencyMovePct: move };
}

// Narasi deterministik Bahasa Indonesia — BUKAN LLM (pola _buildNarrative labour market).
function buildShockNarrative({ classification, bank, currency, rateChangeBps, currencyMovePct }) {
  const absMove = currencyMovePct != null ? Math.abs(currencyMovePct).toFixed(2) : null;
  const arah = currencyMovePct > 0 ? 'menguat' : 'melemah';
  const bpsText = rateChangeBps > 0 ? `menaikkan suku bunga ${rateChangeBps}bps` : rateChangeBps < 0 ? `memangkas suku bunga ${Math.abs(rateChangeBps)}bps` : 'menahan suku bunga';

  switch (classification) {
    case 'policy_shock':
      return `${bank} ${bpsText} dan ${currency} ${arah} ${absMove}% dalam ~${REACTION_HOURS} jam — pola policy shock: pasar bergerak searah arah keputusan.`;
    case 'information_shock':
      if (rateChangeBps !== 0) {
        return `${bank} ${bpsText} tapi ${currency} justru ${arah} ${absMove}% — pola information shock: pasar tampak membaca keputusan sebagai sinyal tentang kondisi ekonomi/ekspektasi ke depan, bukan sekadar kejutan kebijakan.`;
      }
      return `${bank} ${bpsText} tapi ${currency} bergerak ${absMove}% — pola information shock: pergerakan kemungkinan datang dari guidance/konferensi pers, bukan dari perubahan suku bunga itu sendiri.`;
    case 'no_shock':
      return `Reaksi ${currency} ${absMove}% masih dalam band noise ±${NOISE_BAND_PCT}% — tidak ada kejutan berarti dari keputusan ${bank}.`;
    case 'insufficient_data':
    default:
      return `Data reaksi harga belum tersedia untuk jendela rapat ${bank} (gap/libur data) — tidak ditebak.`;
  }
}

const SHOCK_DISCLAIMER = `Resolusi data 1 jam (bukan jendela 30-60 menit presisi) — reaksi keputusan dan reaksi konferensi pers bisa tercampur. Ambang noise ±${NOISE_BAND_PCT}% adalah heuristik awal yang masih perlu kalibrasi dari observasi live. Konteks, bukan sinyal.`;

// "YYYY-MM-DD" + jam pengumuman UTC → epoch detik. null kalau tanggal rusak.
function announceTsFromMeetingDate(meetingDate, currency) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meetingDate || ''))) return null;
  const hour = CB_ANNOUNCE_HOUR_UTC[currency];
  if (hour == null) return null;
  const ts = Date.parse(`${meetingDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  return isFinite(ts) ? Math.floor(ts / 1000) : null;
}

module.exports = {
  NOISE_BAND_PCT,
  REACTION_HOURS,
  CB_ANNOUNCE_HOUR_UTC,
  CB_SHOCK_PROXY,
  SHOCK_DISCLAIMER,
  computeHourlyReaction,
  classifyCbShock,
  buildShockNarrative,
  announceTsFromMeetingDate,
};
