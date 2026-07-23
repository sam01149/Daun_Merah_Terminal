// api/_position_review.js — PLAN U-5a (2026-07-20)
// In-trade management VIRTUAL untuk setup_log:v1 — semua manajemen adalah catatan,
// TIDAK ADA eksekusi broker. Pure functions saja (I/O Redis/HTTP/AI tetap di
// api/admin.js, pola sama seperti api/_pair_context.js), supaya bisa dites unit
// tanpa mock jaringan.
//
// PRINSIP (rapat 2026-07-20, lihat daun_merah_plan.md §U-5 "Prinsip desain"):
// data mentah & lifecycle pasif (entry_zone/sl/tp/status) TIDAK PERNAH ditimpa —
// itulah ghost/counterfactual pasif, tetap dievaluasi _evaluateSetups (admin.js)
// apa adanya. Intervensi dicatat di field TERPISAH (`intervention`, `managed_status`).

// Validasi keputusan TIGHTEN_SL dari LLM (fail-safe -> caller WAJIB downgrade ke
// HOLD kalau ini return false). Aturan (plan U-5a langkah 2d):
// - bearish (short): sl asli di ATAS zona entry, tp di BAWAH. Tighten = new_sl
//   LEBIH RENDAH dari sl lama (mendekat ke harga) TAPI harga belum menembusnya
//   (new_sl > closeLast), dan TIDAK BOLEH turun sampai ke/masuk zona entry
//   (new_sl harus tetap > eHi — di atas seluruh zona).
// - bullish (long): mirror — new_sl LEBIH TINGGI dari sl lama, new_sl < closeLast,
//   new_sl harus tetap < eLo (di bawah seluruh zona entry).
function validateTightenSl({ bias, slOld, newSl, closeLast, eLo, eHi }) {
  if (!Number.isFinite(newSl) || !Number.isFinite(slOld) || !Number.isFinite(closeLast)) return false;
  if (bias === 'bearish') {
    if (!(newSl < slOld && newSl > closeLast)) return false;
    if (Number.isFinite(eHi) && newSl <= eHi) return false;
    return true;
  }
  if (bias === 'bullish') {
    if (!(newSl > slOld && newSl < closeLast)) return false;
    if (Number.isFinite(eLo) && newSl >= eLo) return false;
    return true;
  }
  return false;
}

// Evaluasi outcome MANAJEMEN (beda dari `status` pasif/ghost yang dievaluasi
// _evaluateSetups di admin.js — itu tetap jalan apa adanya, tidak disentuh di sini).
// Hanya intervention.type==='tighten_sl' yang butuh evaluasi lanjutan dari candle
// (close_early sudah final saat diterapkan handler — managed_status='closed_early'
// langsung, tidak lewat sini). Pure function, mutasi in-place (pola _evaluateSetups).
function _evaluateManaged(setups, candlesBySymbol) {
  const nums = s => (String(s).match(/[\d.]+/g) || []).map(Number).filter(n => !isNaN(n));
  for (const st of setups || []) {
    if (!st || !st.intervention || st.intervention.type !== 'tighten_sl') continue;
    if (st.managed_status) continue; // sudah resolved (sl/tp/ambiguous) — jangan re-evaluasi
    const newSl = st.intervention.new_sl;
    const tp = nums(st.tp)[0];
    if (!Number.isFinite(newSl) || tp == null || (st.bias !== 'bullish' && st.bias !== 'bearish')) continue;
    const all = candlesBySymbol?.[st.symbol] || [];
    for (const c of all) {
      if (c.t * 1000 <= st.intervention.t) continue;
      const hitSl = st.bias === 'bearish' ? c.h >= newSl : c.l <= newSl;
      const hitTp = st.bias === 'bearish' ? c.l <= tp : c.h >= tp;
      if (hitSl && hitTp) { st.managed_status = 'ambiguous'; st.managed_closed_t = c.t; break; }
      if (hitSl) { st.managed_status = 'sl'; st.managed_closed_t = c.t; break; }
      if (hitTp) { st.managed_status = 'tp'; st.managed_closed_t = c.t; break; }
    }
  }
  return setups;
}

// Agregat blok "management" untuk _aggSetupStats (admin.js). Ghost/counterfactual
// pasif = `status` field setup ITU SENDIRI (tidak pernah ditimpa intervensi) —
// saved/cost dibandingkan terhadap status pasif itu, dua sisi apa adanya (plan
// U-5a langkah 4, TIDAK ada metrik yang menyensor kegagalan intervensi).
// `reviews` = total review_count (bisa >1 per setup kalau berkali-kali HOLD lalu
// direview lagi); hold = reviews dikurangi yang berujung intervensi (satu
// intervensi per posisi, lihat langkah 2b).
function _aggManagementStats(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const reviews = list.reduce((sum, x) => sum + ((x && x.review_count) || 0), 0);
  const tightenEntries = list.filter(x => x && x.intervention && x.intervention.type === 'tighten_sl');
  const closeEntries   = list.filter(x => x && x.intervention && x.intervention.type === 'close_early');
  const tighten_sl  = tightenEntries.length;
  const close_early = closeEntries.length;
  const hold = Math.max(0, reviews - tighten_sl - close_early);
  return {
    reviews, hold, tighten_sl, close_early,
    close_early_saved:        closeEntries.filter(x => x.status === 'sl').length,
    close_early_cost:         closeEntries.filter(x => x.status === 'tp').length,
    close_early_ghost_pending: closeEntries.filter(x => x.status === 'pending' || x.status === 'open').length,
    tighten_saved: tightenEntries.filter(x => x.status === 'sl').length,
    tighten_cost:  tightenEntries.filter(x => x.status === 'tp').length,
  };
}

// Heuristik UNCONFIRMED (PLAN U-5b, aturan kode bukan AI) — diletakkan di sini
// (bukan vps/daemon.js) supaya bisa dites via node:test tanpa duplikasi manual;
// vps/daemon.js (Docker terisolasi) tetap duplikasi pure function ini secara
// SADAR persis seperti pola isFxMarketOpen/calEventMsWib (lihat catatan kepala
// vps/daemon.js) — dijaga sinkron oleh test drift-guard.
// - kategori 'geopolitical' ATAU 'energy': butuh >=1 item LAIN (guid beda) dalam
//   +-30 menit dengan overlap >=2 token signifikan (lowercase, buang stopword,
//   token >3 huruf). 'energy' ikut disyaratkan korroborasi sejak audit S218
//   (2026-07-23) — headline guncangan energi/geopolitik (mis. "Oil surges after
//   Iran strikes tanker in Hormuz") sering ke-skor newscat.js sebagai 'energy'
//   bukan 'geopolitical' (kata energy menang skor), padahal substansinya sama-sama
//   butuh konfirmasi sebelum dipercaya — sebelum ini category lain di luar
//   geopolitical/market-moving lolos TANPA korroborasi sama sekali (celah).
// - 'market-moving' (data/bank sentral terjadwal): corroborated by default.
const STOPWORDS = new Set(['dengan','yang','untuk','dari','akan','pada','dalam','oleh',
  'atau','juga','masih','sudah','telah','saat','para','ini','itu','the','and','for',
  'with','from','that','this','have','has','been','after','before','over','into']);

function _significantTokens(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !STOPWORDS.has(t));
}

function isCorroborated(item, recentItems) {
  if (!item) return false;
  if (item.cat === 'market-moving') return true;
  if (item.cat !== 'geopolitical' && item.cat !== 'energy') return false;
  const itemMs = Date.parse(item.pubDate);
  if (!Number.isFinite(itemMs)) return false;
  const itemTokens = new Set(_significantTokens(item.title));
  if (itemTokens.size === 0) return false;
  const WINDOW_MS = 30 * 60 * 1000;
  for (const other of recentItems || []) {
    if (!other || other === item) continue;
    const otherGuid = other.guid || other.link;
    const itemGuid = item.guid || item.link;
    if (otherGuid && itemGuid && otherGuid === itemGuid) continue; // item sama, bukan korroborasi
    const otherMs = Date.parse(other.pubDate);
    if (!Number.isFinite(otherMs) || Math.abs(otherMs - itemMs) > WINDOW_MS) continue;
    const otherTokens = _significantTokens(other.title);
    let overlap = 0;
    for (const t of otherTokens) { if (itemTokens.has(t)) overlap++; }
    if (overlap >= 2) return true;
  }
  return false;
}

module.exports = { validateTightenSl, _evaluateManaged, _aggManagementStats, isCorroborated, _significantTokens };
