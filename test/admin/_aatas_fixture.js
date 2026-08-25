// Fixture bersama jawaban AI yang PATUH skema AATAS v2 — dipakai test yang pokok
// bahasannya BUKAN gate AATAS (Gate A/race, isolasi auto, Sistem Hakim, dll) tapi
// tetap melewati jalur `isAutoCall`, jadi harus lolos Gate 1 penegakan kode
// (`_evaluateAatasGate1`: strong_vs_weak true + minimal 2 konfirmasi + tidak ada kata
// RSI/MACD/SMA/EMA/pivot di driver & konfirmasi).
//
// Sengaja SATU sumber: kalau syarat gate berubah lagi nanti, cukup satu file diperbarui
// dan semua test ikut — bukan belasan fixture yang harus dicari satu per satu.
//
// Stub fetch di test-test itu mengembalikan rawText yang SAMA untuk Call 1 dan Call 2,
// jadi objek ini sengaja memuat field KEDUA panggilan sekaligus.
const AATAS_OK_FIELDS = {
  regime_check: {
    regime: 'neutral', cb_bias: null,
    cb_source_conflict: false, event_wait: false, event_note: null, gold: null,
  },
  gate_validitas_driver: { pass: true, note: 'driver terverifikasi dari statement resmi bank sentral' },
  fundamental_bias: {
    score_pct: 78, arah: 'bearish',
    driver: 'divergensi kebijakan bank sentral kedua leg',
    konfirmasi: ['CPI melandai di bawah forecast', 'statement resmi condong dovish'],
    konflik: null, strong_vs_weak: true,
  },
  technical: {
    score_pct: 70, bos: 'ada', area: '1.2800', fib_zone: '0.382',
    fib_reason: 'tren kuat, retracement dangkal', liquidity_context: null, ranging: false,
  },
  gate_risk_management: { pass: true, note: 'RR 1:2, SL di atas swing H4 terakhir' },
  final_validation: { cot: 'searah', retail: 'netral', efek: 'skor naik sedikit' },
  checklist_pct: 82, verdict: 'SIAP TRADE',
  reasoning_note: 'Driver fundamental sudah tercermin di harga; struktur H4 mengonfirmasi arah yang sama.',
};

module.exports = { AATAS_OK_FIELDS };
