const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateId, bindExecutionContract, validateStoredExecutionContract,
} = require('../../api/_aatas_execution_contract');

const candidates = {
  dec: 5, tolerance: 0.00005,
  bullish: {
    sl: [{ price: 1.234, label: 'zona konfluensi 1.23400 [skor 4]' }],
    tp: [{ price: 1.242, label: 'zona konfluensi 1.24200 [skor 3]' }],
  },
  bearish: {
    sl: [{ price: 1.246, label: 'zona konfluensi 1.24600 [skor 4]' }],
    tp: [{ price: 1.238, label: 'zona konfluensi 1.23800 [skor 3]' }],
  },
};

test('kontrak AD: bullish mengikat ID kandidat, angka efektif, dan anchor yang tersedia saat keputusan', () => {
  const result = bindExecutionContract({
    structured: {
      bias: 'bullish', entry_zone: '1.23700-1.23720', sl: '1.23401', tp: '1.24200',
      selected_sl_id: candidateId('bullish', 'sl', 0), selected_tp_id: candidateId('bullish', 'tp', 0),
    }, levelCandidates: candidates, revisionId: 'r-1', decidedAt: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.structured.sl, '1.23400');
  assert.equal(result.structured.execution_contract.invalidation_side, 'below');
  assert.equal(result.structured.execution_contract.anchor_confirmed_at, 1000);
  assert.equal(validateStoredExecutionContract(result.structured).ok, true);
});

test('kontrak AD: respons transisi tanpa ID diturunkan deterministik; ID salah, anchor ATR sintetis, angka salah, dan arah bearish salah ditolak', () => {
  const base = { bias: 'bearish', entry_zone: '1.24000', sl: '1.24600', tp: '1.23800', selected_sl_id: candidateId('bearish', 'sl', 0), selected_tp_id: candidateId('bearish', 'tp', 0) };
  const derived = bindExecutionContract({ structured: { ...base, selected_sl_id: null, selected_tp_id: null }, levelCandidates: candidates });
  assert.equal(derived.ok, true);
  assert.equal(derived.structured.selected_sl_id, 'bearish_sl_1');
  assert.equal(bindExecutionContract({ structured: { ...base, selected_sl_id: 'hilang' }, levelCandidates: candidates }).ok, false);
  assert.equal(bindExecutionContract({ structured: { ...base, sl: '1.25000' }, levelCandidates: candidates }).ok, false);
  const synthetic = structured => bindExecutionContract({ structured, levelCandidates: {
    ...candidates, bearish: { ...candidates.bearish, sl: [{ price: 1.246, label: 'buffer ATR di luar struktur terjauh 1.24500' }] },
  } });
  assert.equal(synthetic(base).reason, 'anchor_bukan_struktur');
  const bad = bindExecutionContract({ structured: { ...base, entry_zone: '1.24700' }, levelCandidates: candidates }).structured;
  assert.equal(bad, undefined, 'SL bearish yang berada di dalam sisi entry tidak boleh lolos');
});

test('kontrak AD: histori tanpa kontrak tetap kompatibel, tetapi kontrak baru tidak boleh drift setelah refine', () => {
  assert.deepEqual(validateStoredExecutionContract({ bias: 'bullish', sl: '1', tp: '2' }), { ok: true, legacy: true });
  const bound = bindExecutionContract({
    structured: { bias: 'bullish', entry_zone: '1.237', sl: '1.234', tp: '1.242', selected_sl_id: 'bullish_sl_1', selected_tp_id: 'bullish_tp_1' },
    levelCandidates: candidates, revisionId: 'r-2', decidedAt: 2000,
  }).structured;
  assert.equal(validateStoredExecutionContract({ ...bound, sl: '1.23300' }).reason, 'harga_anchor_tidak_cocok');
});
