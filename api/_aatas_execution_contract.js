// Kontrak eksekusi AATAS (PLAN AD, 2026-09-20).
//
// Modul ini TIDAK memilih level dan TIDAK membaca Redis. Ia hanya mengikat level
// final yang sudah di-snap oleh admin.js ke kandidat deterministik yang memang ada
// saat keputusan dibuat. Dengan begitu narasi/SL tidak dapat menyebut struktur yang
// berbeda dari angka efektif. Histori sebelum kontrak ini tetap dibaca apa adanya.

const CONTRACT_VERSION = 1;

function _num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.match(/^[^\d+\-]*([+\-]?(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function _entryBounds(value) {
  // Entry range memakai tanda hubung (`1.23400-1.23500`), bukan angka negatif.
  // Harga instrumen yang didukung juga positif, jadi parser sengaja sama dengan
  // evaluator lama agar pemisah range tidak dibaca sebagai minus.
  const nums = String(value || '').match(/(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?/gi);
  const parsed = (nums || []).map(Number).filter(Number.isFinite);
  return parsed.length ? { low: Math.min(...parsed), high: Math.max(...parsed) } : null;
}

function candidateId(direction, kind, index) {
  return `${direction}_${kind}_${index + 1}`;
}

function candidateById(levelCandidates, direction, kind, id) {
  const list = levelCandidates?.[direction]?.[kind];
  if (!Array.isArray(list) || typeof id !== 'string') return null;
  return list.find((candidate, index) => candidateId(direction, kind, index) === id) || null;
}

function candidateByPrice(levelCandidates, direction, kind, price, tolerance) {
  const list = levelCandidates?.[direction]?.[kind];
  if (!Array.isArray(list) || !Number.isFinite(price)) return null;
  return list.find(candidate => Math.abs(candidate.price - price) <= tolerance) || null;
}

function isStructuralAnchor(candidate) {
  // Buffer ATR adalah fallback protektif, bukan struktur yang dapat dijadikan anchor.
  return !!candidate && !/^buffer ATR\b/i.test(String(candidate.label || ''));
}

function validateStoredExecutionContract(setup) {
  if (!setup?.execution_contract || setup.execution_contract.v !== CONTRACT_VERSION) return { ok: true, legacy: true };
  const c = setup.execution_contract;
  const bounds = _entryBounds(setup.entry_zone);
  const sl = _num(setup.sl), tp = _num(setup.tp);
  if (!bounds || sl == null || tp == null || !['bullish', 'bearish'].includes(setup.bias)) return { ok: false, reason: 'level_tidak_valid' };
  if (c.anchor_id !== setup.selected_sl_id || c.selected_tp_id !== setup.selected_tp_id) return { ok: false, reason: 'referensi_id_tidak_cocok' };
  if (!Number.isFinite(c.anchor_price) || Math.abs(c.anchor_price - sl) > 1e-9) return { ok: false, reason: 'harga_anchor_tidak_cocok' };
  if (c.invalidation_side !== (setup.bias === 'bullish' ? 'below' : 'above')) return { ok: false, reason: 'sisi_invalidasi_tidak_cocok' };
  const validDirection = setup.bias === 'bullish'
    ? sl < bounds.low && tp > bounds.high
    : sl > bounds.high && tp < bounds.low;
  if (!validDirection) return { ok: false, reason: 'arah_entry_sl_tp_salah' };
  return { ok: true, legacy: false };
}

function bindExecutionContract({ structured, levelCandidates, revisionId, decidedAt }) {
  const direction = structured?.bias;
  if (!['bullish', 'bearish'].includes(direction)) return { ok: false, reason: 'bias_tidak_valid' };
  const dec = Number.isInteger(levelCandidates?.dec) ? levelCandidates.dec : 5;
  const tolerance = Math.max(1e-12, Number(levelCandidates?.tolerance) || Math.pow(10, -dec) / 2);
  const rawSl = _num(structured.sl), rawTp = _num(structured.tp);
  // Respons sebelum prompt AD tidak membawa ID. Selama angka hasil snap cocok persis
  // dengan SATU kandidat, turunkan ID secara deterministik. Respons baru yang SUDAH
  // membawa ID tetap diverifikasi ketat dan tidak boleh menunjuk kandidat lain.
  const slCandidate = structured.selected_sl_id
    ? candidateById(levelCandidates, direction, 'sl', structured.selected_sl_id)
    : candidateByPrice(levelCandidates, direction, 'sl', rawSl, tolerance);
  const tpCandidate = structured.selected_tp_id
    ? candidateById(levelCandidates, direction, 'tp', structured.selected_tp_id)
    : candidateByPrice(levelCandidates, direction, 'tp', rawTp, tolerance);
  if (!slCandidate || !tpCandidate) return { ok: false, reason: 'kandidat_id_tidak_tersedia' };
  if (!isStructuralAnchor(slCandidate)) return { ok: false, reason: 'anchor_bukan_struktur' };

  const sl = rawSl, tp = rawTp;
  if (sl == null || tp == null || Math.abs(sl - slCandidate.price) > tolerance || Math.abs(tp - tpCandidate.price) > tolerance) {
    return { ok: false, reason: 'angka_tidak_cocok_dengan_kandidat' };
  }
  const effective = {
    ...structured,
    sl: slCandidate.price.toFixed(dec),
    tp: tpCandidate.price.toFixed(dec),
    selected_sl_id: structured.selected_sl_id || candidateId(direction, 'sl', levelCandidates[direction].sl.indexOf(slCandidate)),
    selected_tp_id: structured.selected_tp_id || candidateId(direction, 'tp', levelCandidates[direction].tp.indexOf(tpCandidate)),
    execution_contract: {
      v: CONTRACT_VERSION,
      anchor_id: structured.selected_sl_id || candidateId(direction, 'sl', levelCandidates[direction].sl.indexOf(slCandidate)),
      anchor_price: slCandidate.price,
      invalidation_side: direction === 'bullish' ? 'below' : 'above',
      // Kandidat dapat berasal dari cluster multi-timeframe; timestamp pivot individu
      // belum dipertahankan oleh _confluenceZones. Jangan memalsukan timestamp historis.
      anchor_timeframe: 'confluence',
      anchor_t: null,
      anchor_confirmed_at: decidedAt,
      anchor_evidence: slCandidate.label,
      selected_tp_id: structured.selected_tp_id || candidateId(direction, 'tp', levelCandidates[direction].tp.indexOf(tpCandidate)),
      revision_id: revisionId,
    },
  };
  const valid = validateStoredExecutionContract(effective);
  return valid.ok ? { ok: true, structured: effective } : valid;
}

module.exports = {
  CONTRACT_VERSION,
  candidateId,
  candidateById,
  candidateByPrice,
  bindExecutionContract,
  validateStoredExecutionContract,
};
