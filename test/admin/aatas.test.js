// test/admin/aatas.test.js — AATAS ("Auto AI to Auto System", 2026-08-22).
// Porting checklist SMC/ICT manual ke jalur auto-entry: urutan keputusan dibalik jadi
// MAKRO DULU (REGIME CHECK + gate driver/fundamental), teknikal cuma presisi timing.
//
// Yang dikunci test ini:
//  (a) blok checklist hanya masuk prompt jalur auto; jalur manual publik tidak berubah;
//  (b) cabang XAU/USD beda dari FX (real yield dibuang dari pre-gate FX, hard-stop gold);
//  (c) normalisasi field baru (checklist_pct/verdict/gate/...) fail-safe ke null;
//  (d) GATE benar-benar mengikat di KODE (bukan cuma imbauan prompt) — setup batal lahir;
//  (e) field checklist tersimpan ke setup_log_auto:v1, TERMASUK reasoning_note naratif;
//  (f) statistik agregat dashboard direset ke populasi policy_v >= AATAS_EPOCH, sementara
//      tabel Riwayat Setup (`recent`) tetap menampilkan histori lama penuh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const marketHours = require('../../api/_market_hours');
const { AATAS_EPOCH } = require('../../api/_auto_entry_guard');

process.env.UPSTASH_REDIS_REST_URL   = 'https://fake-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

function loadHandler() {
  delete require.cache[require.resolve('../../api/admin.js')];
  return require('../../api/admin.js');
}

const {
  _buildAatasMacroChecklistBlock, _buildAatasTechnicalChecklistBlock, _stripIndicatorLines,
  _evaluateAatasGate1, _splitJsonCommentary,
  _normalizeAatasFields, _aatasRejectReason,
  _goldYieldCorrAnomaly, _formatAatasCriticLine, _statsPayloadFromLog, AATAS_PROMPT_VERSION,
} = loadHandler();

// ── (b) blok checklist: Call 1 (makro) vs Call 2 (teknikal), cabang FX vs XAU ─

test('AATAS block MAKRO (Call 1) FX: makro berdiri sendiri, real yield BUKAN pre-gate, chart tidak disebut sama sekali', () => {
  const b = _buildAatasMacroChecklistBlock({ label: 'EUR/USD', isXau: false, goldCorr: null });
  assert.match(b, /BAGIAN 1 DARI 2: MAKRO\/FUNDAMENTAL/);
  assert.match(b, /STEP 0 REGIME CHECK \(PRE-GATE\):/);
  assert.match(b, /Real yield differential TIDAK dipakai sebagai pre-gate di pair FX/);
  assert.match(b, /COT & retail sentiment TIDAK dipakai di sini — dipindah ke Step 8/);
  assert.match(b, /DILARANG menyebut RSI, MACD, SMA, EMA, pivot/);
  // AATAS v2 poin 4: strong_vs_weak harus lewat penelusuran mekanisme lintas-faktor,
  // bukan perbandingan label bias CB mentah.
  assert.match(b, /telusuri MEKANISME lintas-faktor/);
  assert.match(b, /CAD ke harga minyak\/WTI/);
  // AATAS v2 poin 3: syarat gate diberitahukan sebagai hal yang DIPERIKSA KODE.
  assert.match(b, /kode MEMERIKSA jawabannya/);
  assert.match(b, /Kode menghitung jumlahnya/);
  // Step 4-8 bukan urusan Call 1 — kalau bocor ke sini, pemisahan datanya percuma.
  assert.doesNotMatch(b, /STEP 4 STRUKTUR TEKNIKAL/);
  assert.doesNotMatch(b, /STEP 6 RISK MANAGEMENT/);
  // Cabang gold tidak boleh bocor ke FX.
  assert.doesNotMatch(b, /unanimous/);
});

test('AATAS block MAKRO (Call 1) XAU: real yield+DXY+regime wajib 3/3, korelasi live jadi arbitrase, angka korelasi ikut dikirim', () => {
  const b = _buildAatasMacroChecklistBlock({
    label: 'XAU/USD', isXau: true, goldCorr: { r20: -0.11, r60: -0.72, anomaly: true },
  });
  assert.match(b, /STEP 0 REGIME CHECK \(PRE-GATE, cabang XAU\/USD\)/);
  assert.match(b, /Ketiganya WAJIB sepakat \(3\/3\)/);
  assert.match(b, /r20 -0\.11 vs r60 -0\.72/, 'angka korelasi live wajib dikutip, bukan cuma label');
  assert.match(b, /ANOMALI/);
  assert.match(b, /TIDAK ENTRY sama sekali/);
});

test('AATAS block MAKRO (Call 1) XAU: korelasi tidak tersedia -> dinyatakan apa adanya, bukan diasumsikan normal', () => {
  const b = _buildAatasMacroChecklistBlock({ label: 'XAU/USD', isXau: true, goldCorr: null });
  assert.match(b, /data tidak tersedia saat ini/);
  assert.doesNotMatch(b, /status: NORMAL/);
});

test('AATAS block TEKNIKAL (Call 2): bias dikunci sebagai fakta, Step 4-8 ada, penentuan arah dilarang', () => {
  const b = _buildAatasTechnicalChecklistBlock({ isXau: false, lockedBias: 'bearish' });
  assert.match(b, /BAGIAN 2 DARI 2: STRUKTUR & LOKASI ENTRY/);
  assert.match(b, /SUDAH DIKUNCI dari analisa makro\/fundamental: BEARISH/);
  assert.match(b, /TIDAK BOLEH kamu ubah, tawar, atau balik/);
  assert.match(b, /STEP 4 STRUKTUR TEKNIKAL/);
  assert.match(b, /STEP 6 RISK MANAGEMENT \(GATE\)/);
  assert.match(b, /STEP 8 VALIDASI TERAKHIR/);
  // Delta lama yang harus tetap hidup di v2.
  assert.match(b, /FLAT 2% tanpa pengecualian/);
  assert.match(b, /TIDAK PERNAH mengecilkan ukuran posisi/);
  assert.match(b, /ZONA 0,382-0,618, bukan titik tunggal 0,618/);
  assert.match(b, /INDIKATOR MOMENTUM DIBUANG/);
  assert.match(b, /TIDAK PERNAH sebagai sinyal arah atau momentum/);
  // Aturan "maksimal 2 pair/hari" dari checklist manual tetap tidak diporting.
  assert.doesNotMatch(b, /Maksimal 2 pair/i);
  // Step 0-2 sudah selesai di Call 1 — tidak boleh diulang di sini.
  assert.doesNotMatch(b, /STEP 0 REGIME CHECK/);
  assert.doesNotMatch(b, /STEP 2 FUNDAMENTAL BIAS/);
});

test('AATAS block TEKNIKAL: cabang XAU menambah option expiry sebagai lapis konfirmasi', () => {
  const b = _buildAatasTechnicalChecklistBlock({ isXau: true, lockedBias: 'bullish' });
  assert.match(b, /option expiry/i);
  assert.match(b, /SUDAH DIKUNCI dari analisa makro\/fundamental: BULLISH/);
});

// ── AATAS v2: penegakan kode atas Gate 1 (poin 3 plan) ───────────────────────
// Dua test pertama adalah regression test LANGSUNG dari dua pelanggaran nyata yang
// ditemukan di 4 setup live pertama v1 (2026-08-24). Kalau salah satunya merah lagi,
// artinya lubang yang sama terbuka kembali.

test('_evaluateAatasGate1: kasus nyata AUD/NZD — AI lapor pass:true tapi strong_vs_weak:false -> kode override jadi false', () => {
  const g = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: {
      score_pct: 55, arah: 'bullish',
      driver: 'Struktur teknikal H4 menunjukkan bullish (HH+HL)',
      konfirmasi: ['AUD hawkish', 'NZD hawkish'],
      strong_vs_weak: false,
    },
  });
  assert.equal(g.pass, false, 'arah tidak boleh lahir saat fundamental sendiri mengaku tidak ada keunggulan');
  assert.equal(g.override_reason, 'strong_vs_weak_bukan_true');
});

test('_evaluateAatasGate1: kasus nyata XAU/USD — "RSI 76.5" di driver tertangkap pemindaian kata kunci', () => {
  const g = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: {
      score_pct: 70, arah: 'bearish',
      driver: 'posisi long yang ramai (RSI 76.5, skew call-skewed ekstrem)',
      konfirmasi: ['DXY menguat 0,4%', 'real yield naik 5bps'],
      strong_vs_weak: true,
    },
  });
  assert.equal(g.pass, false);
  assert.equal(g.override_reason, 'indikator_teknikal_di_driver');
});

test('_evaluateAatasGate1: kata indikator di KONFIRMASI (bukan cuma driver) juga tertangkap', () => {
  const g = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: {
      driver: 'divergensi kebijakan Fed-ECB', konfirmasi: ['CPI melandai', 'MACD H4 bullish crossover'],
      strong_vs_weak: true,
    },
  });
  assert.equal(g.override_reason, 'indikator_teknikal_di_driver');
});

test('_evaluateAatasGate1: konfirmasi kurang dari 2 (atau item kosong) -> gagal', () => {
  const satu = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: { driver: 'BoE dovish', konfirmasi: ['CPI melandai'], strong_vs_weak: true },
  });
  assert.equal(satu.override_reason, 'konfirmasi_kurang_dari_2');
  const kosong = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: { driver: 'BoE dovish', konfirmasi: ['CPI melandai', '   '], strong_vs_weak: true },
  });
  assert.equal(kosong.override_reason, 'konfirmasi_kurang_dari_2', 'item whitespace tidak boleh dihitung');
});

test('_evaluateAatasGate1: AI sendiri lapor gagal -> BUKAN override kode (dibedakan untuk counter observabilitas)', () => {
  const g = _evaluateAatasGate1({ aiPass: false, fundamental_bias: null });
  assert.equal(g.pass, false);
  assert.equal(g.override_reason, null, 'kegagalan yang diakui AI tidak boleh dihitung sebagai override kode');
});

test('_evaluateAatasGate1: fundamental_bias hilang total -> fail-CLOSED (beda sengaja dari v1)', () => {
  assert.equal(_evaluateAatasGate1({ aiPass: null, fundamental_bias: null }).override_reason, 'fundamental_bias_kosong');
  assert.equal(_evaluateAatasGate1({ aiPass: null, fundamental_bias: 'bukan objek' }).override_reason, 'fundamental_bias_kosong');
});

test('_evaluateAatasGate1: laporan patuh penuh -> lolos tanpa override', () => {
  const g = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: {
      driver: 'divergensi BoE-Fed, statement resmi 12 Agustus',
      konfirmasi: ['CPI UK melandai ke 2,1%', 'BoE memangkas 25bps'],
      strong_vs_weak: true,
    },
  });
  assert.deepEqual(g, { pass: true, override_reason: null });
});

test('_evaluateAatasGate1: kata biasa yang KEBETULAN memuat substring indikator tidak boleh kena', () => {
  const g = _evaluateAatasGate1({
    aiPass: true,
    fundamental_bias: {
      driver: 'permintaan domestik melemah (retail sales -0,3%)',
      konfirmasi: ['klaim pengangguran naik', 'PMI manufaktur di bawah 50'],
      strong_vs_weak: true,
    },
  });
  assert.equal(g.pass, true, 'batas kata harus mencegah false positive dari substring');
});

// ── _stripIndicatorLines: data indikator tidak dikirim, bukan cuma dilarang ──

test('_stripIndicatorLines: baris RSI/MACD/SMA/pivot dibuang, struktur & S/R & fib tetap utuh', () => {
  const txt = [
    '[INDIKATOR Daily] RSI 14: 76.5 (overbought) | SMA 50: 1.2800',
    '[MACD H4 12,26,9] Line: 0.001 | Signal: 0.000',
    '[STRUKTUR H4] Bearish (LH + LL) — swing high 1.30 -> 1.29',
    '[LEVEL S/R — cluster pivot Daily 6 bulan]',
    '[FIBONACCI leg 4H] 38.2%: 1.2820',
    '[PIVOT HARIAN klasik dari daily kemarin] P: 1.2810',
    '[RSI-14 H4] 62 (naik vs 3 candle lalu)',
    '[LEVEL REFERENSI] Prev Day H/L/C: 1.30/1.28/1.29',
  ].join('\n');
  const out = _stripIndicatorLines(txt);
  assert.doesNotMatch(out, /INDIKATOR Daily/);
  assert.doesNotMatch(out, /MACD H4/);
  assert.doesNotMatch(out, /RSI-14 H4/);
  // Pivot TETAP dikirim: itu level harga struktural (setara S/R), bukan pembacaan
  // momentum — dan instruksi pemilihan entry/SL/TP memang merujuk ke sana.
  assert.match(out, /PIVOT HARIAN/);
  assert.match(out, /STRUKTUR H4/);
  assert.match(out, /LEVEL S\/R/);
  assert.match(out, /FIBONACCI/);
  assert.match(out, /LEVEL REFERENSI/);
  assert.equal(_stripIndicatorLines(null), '');
});

// ── _splitJsonCommentary: dipakai bersama jalur manual & dua panggilan AATAS ─

test('_splitJsonCommentary: prosa setelah delimiter dipisah, JSON diekstrak dari kurung pertama sampai terakhir', () => {
  const r = _splitJsonCommentary('bla {"a":1}\n===COMMENTARY===\n  Paragraf prosa.  ');
  assert.equal(r.jsonText, '{"a":1}');
  assert.equal(r.commentary, 'Paragraf prosa.');
  const tanpaDelim = _splitJsonCommentary('```json\n{"a":2}\n```');
  assert.equal(tanpaDelim.jsonText, '{"a":2}');
  assert.equal(tanpaDelim.commentary, null);
});


// ── _goldYieldCorrAnomaly: ambang tervalidasi, bukan r20 mentah ──────────────

test('_goldYieldCorrAnomaly: |r20-r60| > 0,4 -> anomali; di bawah ambang -> normal; data kurang -> null', () => {
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: -0.1, r60: -0.7 } } }), true);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: -0.5, r60: -0.7 } } }), false);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: { RealYield: { r20: null, r60: -0.7 } } }), null);
  assert.equal(_goldYieldCorrAnomaly({ gold_correlations: {} }), null);
  assert.equal(_goldYieldCorrAnomaly(null), null);
});

// ── (c) normalisasi field baru ───────────────────────────────────────────────

test('_normalizeAatasFields: verdict dinormalkan ke label ckGetVerdict, pct dibulatkan & di-clamp', () => {
  const out = _normalizeAatasFields({
    checklist_pct: 87.6, verdict: 'siap trade',
    reasoning_note: '  Driver ECB hawkish sudah tercermin di harga.  ',
  });
  assert.equal(out.checklist_pct, 88);
  assert.equal(out.verdict, 'SIAP TRADE');
  assert.equal(out.reasoning_note, 'Driver ECB hawkish sudah tercermin di harga.');

  assert.equal(_normalizeAatasFields({ checklist_pct: 140 }).checklist_pct, 100);
  assert.equal(_normalizeAatasFields({ checklist_pct: -5 }).checklist_pct, 0);
  assert.equal(_normalizeAatasFields({ checklist_pct: 'entah' }).checklist_pct, null);
  assert.equal(_normalizeAatasFields({ verdict: 'NO_TRADE' }).verdict, 'NO TRADE');
  assert.equal(_normalizeAatasFields({ verdict: 'mantap' }).verdict, null, 'label ngawur -> null, jangan dipaksa ke salah satu');
});

test('_normalizeAatasFields: gate dinormalkan {pass,note}; pass non-boolean -> null (fail-open, bukan false)', () => {
  const out = _normalizeAatasFields({
    gate_validitas_driver: { pass: true, note: 'CPI aktual di atas forecast' },
    gate_risk_management: { pass: 'ya', note: '' },
  });
  assert.deepEqual(out.gate_validitas_driver, { pass: true, note: 'CPI aktual di atas forecast' });
  assert.deepEqual(out.gate_risk_management, { pass: null, note: null },
    'pass yang bukan boolean TIDAK boleh dibaca sebagai gagal — itu akan memblokir setup tanpa dasar');
  assert.equal(_normalizeAatasFields({}).gate_validitas_driver, null);
});

test('_normalizeAatasFields: objek per-step non-objek (string/array) dibuang jadi null', () => {
  const out = _normalizeAatasFields({
    regime_check: 'risk_off', fundamental_bias: ['bullish'], technical: { bos: 'ada' },
  });
  assert.equal(out.regime_check, null);
  assert.equal(out.fundamental_bias, null);
  assert.deepEqual(out.technical, { bos: 'ada' });
});

// ── (d) GATE mengikat di kode ────────────────────────────────────────────────

test('_aatasRejectReason: gold hard-stop menang duluan, lalu gate driver, gate risk, baru verdict', () => {
  assert.equal(_aatasRejectReason({ goldBlocked: true, verdict: 'ENTRY' }), 'gold_regime_split_corr_anomali');
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: false }, verdict: 'ENTRY' }), 'gate_validitas_driver');
  assert.equal(_aatasRejectReason({ gate_risk_management: { pass: false }, verdict: 'ENTRY' }), 'gate_risk_management');
  assert.equal(_aatasRejectReason({ verdict: 'NO TRADE' }), 'verdict_no_trade');
});

test('_aatasRejectReason: fail-open — gate tidak dilaporkan / verdict null -> setup TIDAK diblokir', () => {
  assert.equal(_aatasRejectReason({}), null);
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: null }, gate_risk_management: null, verdict: null }), null);
  assert.equal(_aatasRejectReason({ gate_validitas_driver: { pass: true }, verdict: 'PERTIMBANGKAN' }), null);
});

// ── fact sheet Gate A (AI Kritikus) ──────────────────────────────────────────

test('_formatAatasCriticLine: kirim hasil penilaian per-step, bukan label makro_alignment lama', () => {
  const line = _formatAatasCriticLine({
    checklist_pct: 72, verdict: 'PERTIMBANGKAN',
    regime_check: { regime: 'risk_off', cb_source_conflict: true, event_wait: true, event_note: 'NFP 5 jam lagi' },
    fundamental_bias: { arah: 'bearish', driver: 'Fed dovish' },
    technical: { bos: 'ada', area: '1.1710', fib_zone: '0.5' },
    final_validation: { cot: 'melawan', retail: 'netral' },
    reasoning_note: 'Skor turun karena dua sumber CB bias berbeda.',
  });
  assert.match(line, /Checklist AATAS: 72% \(PERTIMBANGKAN\)/);
  assert.match(line, /CB bias dua sumber BERBEDA/);
  assert.match(line, /menunggu event \(NFP 5 jam lagi\)/);
  assert.match(line, /Fundamental bias: bearish/);
  assert.match(line, /Catatan analis: Skor turun/);
  assert.equal(_formatAatasCriticLine({}), null);
  assert.equal(_formatAatasCriticLine(null), null);
});

// ── (f) reset statistik dashboard ────────────────────────────────────────────

test('_statsPayloadFromLog: agregat HANYA dari policy_v >= AATAS_EPOCH, Riwayat Setup tetap penuh', () => {
  const lama    = { id: 'A', symbol: 'GC=F', status: 'sl', ts: 1786000000000, policy_v: 20 };
  const lamaTp  = { id: 'B', symbol: 'GC=F', status: 'tp', ts: 1786000000001, policy_v: 21 };
  const aatas   = { id: 'C', symbol: 'GC=F', status: 'tp', ts: 1786500000000, policy_v: AATAS_EPOCH };
  const out = _statsPayloadFromLog([aatas, lamaTp, lama]);

  assert.equal(out.global.total, 1, 'hanya setup AATAS yang dihitung agregat');
  assert.equal(out.global.tp, 1);
  assert.equal(out.global.sl, 0);
  assert.equal(out.global.win_rate_raw, 100, 'win rate lama tidak boleh nyampur ke populasi baru');
  assert.equal(out.symbols['GC=F'].total, 1);
  assert.equal(out.symbols['GC=F'].history.length, 3, 'histori per-pair TIDAK difilter');
  assert.equal(out.recent.length, 3, 'tabel Riwayat Setup wajib tetap menampilkan entri lama apa adanya');
  assert.equal(out.stats_from_policy_v, AATAS_EPOCH);
});

test('_statsPayloadFromLog: entri lama tanpa policy_v dinilai lewat policy_v_est, entri tanpa ts valid tidak ikut agregat', () => {
  // ts 2026-07-21 -> epoch v2/v3 (jauh sebelum AATAS) -> keluar dari agregat.
  const tanpaStempel = { id: 'D', symbol: 'EURUSD=X', status: 'tp', ts: Date.parse('2026-07-21T00:00:00Z') };
  const tsKorup      = { id: 'E', symbol: 'EURUSD=X', status: 'tp', ts: 'bukan-angka' };
  const out = _statsPayloadFromLog([tanpaStempel, tsKorup]);
  assert.equal(out.global.total, 0);
  assert.equal(out.recent.length, 2);
  assert.ok(out.recent.find(x => x.id === 'D').policy_v_est != null, 'estimasi tetap dihitung untuk transparansi');
});

// ── (a)(d)(e) end-to-end jalur auto vs manual ────────────────────────────────

function makeStore(seed = {}) { return { strings: { ...seed }, lists: {} }; }

function redisFetchStub(store) {
  return async (url, opts) => {
    const args = JSON.parse(opts.body);
    const [cmd, key, ...rest] = args;
    switch (cmd) {
      case 'GET':
        return { ok: true, json: async () => ({ result: Object.prototype.hasOwnProperty.call(store.strings, key) ? store.strings[key] : null }) };
      case 'SET': {
        const flags = rest.slice(1).map(v => String(v).toUpperCase());
        if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(store.strings, key)) {
          return { ok: true, json: async () => ({ result: null }) };
        }
        store.strings[key] = rest[0];
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      case 'DEL': delete store.strings[key]; return { ok: true, json: async () => ({ result: 1 }) };
      case 'INCR': {
        const n = (parseInt(store.strings[key] || '0', 10)) + 1;
        store.strings[key] = String(n);
        return { ok: true, json: async () => ({ result: n }) };
      }
      // AATAS v2: `aatas_reject_log:v1` (jejak kandidat yang ditolak) bertipe LIST.
      case 'LPUSH': {
        store.lists[key] = [rest[0], ...(store.lists[key] || [])];
        return { ok: true, json: async () => ({ result: store.lists[key].length }) };
      }
      case 'LTRIM': {
        const stop = parseInt(rest[1], 10);
        if (store.lists[key]) store.lists[key] = store.lists[key].slice(0, stop + 1);
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      default: return { ok: true, json: async () => ({ result: 'OK' }) };
    }
  };
}

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

async function withEnv(vars, fn) {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
  Object.assign(process.env, vars);
  const origIsOpen = marketHours.isFxMarketOpen;
  marketHours.isFxMarketOpen = () => true;
  try { return await fn(); }
  finally {
    marketHours.isFxMarketOpen = origIsOpen;
    delete process.env.CRON_SECRET; delete process.env.DEEPSEEK_API_KEY;
    for (const k of Object.keys(prev)) { if (prev[k] !== undefined) process.env[k] = prev[k]; }
  }
}

function mkTrendCandles(startClose, endClose, hours = 80) {
  const arr = [];
  for (let i = 0; i < hours; i++) {
    const c = startClose + (endClose - startClose) * (i / (hours - 1));
    arr.push({ t: i * 3600, o: c, h: c + 0.001, l: c - 0.001, c });
  }
  return arr;
}

// Level konsisten dengan close terakhir 1.28 (bearish) supaya lolos sanity-check RR.
const BASE_JSON = {
  bias: 'bearish',
  entry_zone: '1.2795-1.2805', entry_basis: 'cluster S/R',
  sl: '1.2850', tp: '1.2700',
  trigger: 'tunggu rejection H1', invalidation_condition: 'close H4 di atas 1.2860',
  time_horizon_days: 3,
  conflict: 'none', conflict_note: null,
};

const AATAS_JSON = {
  ...BASE_JSON,
  regime_check: {
    regime: 'risk_off',
    cb_bias: { GBP: 'dovish', USD: 'hawkish' },
    cb_source_conflict: false, event_wait: false, event_note: null, gold: null,
  },
  gate_validitas_driver: { pass: true, note: 'BoE dovish, statement resmi, sudah tercermin di harga' },
  fundamental_bias: { score_pct: 80, arah: 'bearish', driver: 'divergensi BoE-Fed', konfirmasi: ['CPI UK melandai', 'BoE dovish'], konflik: null, strong_vs_weak: true },
  technical: { score_pct: 70, bos: 'ada', area: '1.2800', fib_zone: '0.382', fib_reason: 'tren kuat, retracement dangkal', liquidity_context: null, ranging: false },
  gate_risk_management: { pass: true, note: 'RR 1:2, SL di atas swing H4' },
  final_validation: { cot: 'searah', retail: 'netral', efek: 'skor naik sedikit' },
  checklist_pct: 82, verdict: 'SIAP TRADE',
  reasoning_note: 'Driver BoE dovish sudah tercermin di harga; struktur H4 LH+LL mengonfirmasi arah fundamental.',
};

function rawFrom(json, prosa = 'Paragraf komentar untuk test AATAS.') {
  return `${JSON.stringify(json)}\n===COMMENTARY===\n${prosa}`;
}

// AATAS v2: jalur auto memanggil DeepSeek dua kali (Call 1 makro, Call 2 teknikal).
// Stub di bawah mengembalikan JSON yang sama untuk keduanya — yang dibedakan cuma
// PROSA-nya, supaya penggabungan reasoning_note (makro + teknikal) benar-benar teruji,
// bukan cuma kelihatan benar karena dua string identik.
const PROSA_MAKRO = 'Paragraf komentar MAKRO untuk test AATAS (BoE dovish).';
const PROSA_TEKNIKAL = 'Paragraf komentar TEKNIKAL untuk test AATAS (BOS H4).';

function makeAnalyzeFetchStub(store, rawText, capture) {
  const redisStub = redisFetchStub(store);
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-upstash.test')) return redisStub(url, opts);
    if (u.includes('api.deepseek.com')) {
      const body = JSON.parse(opts.body);
      if (capture) capture.push(body);
      // Panggilan AATAS dibedakan dari blok checklist yang dikirim, bukan dari urutan —
      // urutan bisa berubah kalau Gate A/Kritikus ikut memanggil di tengah.
      const isCall2 = String(body.messages?.[1]?.content || '').includes('BAGIAN 2 DARI 2');
      const isCall1 = String(body.messages?.[1]?.content || '').includes('BAGIAN 1 DARI 2');
      const out = isCall2 ? rawText.replace(/(?<====COMMENTARY===\n)[\s\S]*$/, PROSA_TEKNIKAL)
        : isCall1 ? rawText.replace(/(?<====COMMENTARY===\n)[\s\S]*$/, PROSA_MAKRO)
          : rawText;
      return { ok: true, json: async () => ({ choices: [{ message: { content: out } }] }) };
    }
    throw new Error('unexpected network call di test: ' + u);
  };
}

function baseStore() {
  return makeStore({
    'ohlcv_fresh:GBPUSD=X': '1',
    'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
  });
}

test('AATAS e2e: prompt jalur auto membawa blok checklist + field baru; jalur manual TIDAK berubah', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const capAuto = [];
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON), capAuto);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }

    // AATAS v2: DUA panggilan analisa (+1 Gate A Kritikus).
    assert.equal(capAuto.length, 3, 'jalur auto = Call 1 makro + Call 2 teknikal + Gate A');
    const call1User = capAuto[0].messages[1].content;
    const call1Sys  = capAuto[0].messages[0].content;
    const call2User = capAuto[1].messages[1].content;
    const call2Sys  = capAuto[1].messages[0].content;

    // Call 1 = makro murni. INI inti fix v2: bukan sekadar teks larangan, datanya
    // memang tidak dikirim — kalau assert di bawah merah, kebocoran RSI mungkin lagi.
    assert.match(call1User, /\[CHECKLIST AATAS — BAGIAN 1 DARI 2/);
    assert.doesNotMatch(call1User, /DATA TEKNIKAL:/, 'Call 1 TIDAK BOLEH menerima data teknikal');
    assert.doesNotMatch(call1User, /RSI 14:/, 'Call 1 TIDAK BOLEH melihat angka RSI sama sekali');
    assert.doesNotMatch(call1User, /\[MACD H4/);
    assert.doesNotMatch(call1User, /\[ZONA KONFLUENSI/);
    assert.doesNotMatch(call1User, /- makro_alignment:/, 'field lama tidak boleh diminta lagi di jalur auto');
    assert.doesNotMatch(call1User, /- confidence:/);
    assert.match(call1Sys, /"fundamental_bias"/);
    assert.doesNotMatch(call1Sys, /"makro_alignment"/);

    // Call 2 = teknikal, dengan bias Call 1 masuk sebagai fakta terkunci.
    assert.match(call2User, /\[CHECKLIST AATAS — BAGIAN 2 DARI 2/);
    assert.match(call2User, /HASIL ANALISA MAKRO — FAKTA TERKUNCI/);
    assert.match(call2User, /Arah \(bias\): BEARISH/);
    assert.match(call2User, /DATA TEKNIKAL:/);
    assert.match(call2User, /- checklist_pct:/);
    assert.doesNotMatch(call2User, /RSI 14:/, 'pembacaan momentum dibuang dari data Call 2 juga');
    assert.doesNotMatch(call2User, /\[MACD H4/);
    assert.doesNotMatch(call2User, /\[RSI-14 H4\]/);
    assert.match(call2Sys, /"checklist_pct"/);
    assert.doesNotMatch(call2Sys, /"makro_alignment"/);

    // Kalender wajib ada di KEDUA call (Step 0 event <6 jam vs conflict waktu) —
    // di test ini cache kalender kosong, jadi yang dikunci cuma pembagian di atas.
  });

  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const capManual = [];
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(BASE_JSON), capManual);
    try {
      const handler = loadHandler();
      await handler({
        headers: {}, method: 'POST', body: {},
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }

    const manualUser = capManual[0].messages[1].content;
    const manualSys  = capManual[0].messages[0].content;
    assert.doesNotMatch(manualUser, /CHECKLIST AATAS/, 'isolasi Opsi A: fitur publik tidak boleh kena porting ini');
    assert.match(manualUser, /- makro_alignment:/);
    assert.match(manualUser, /- confidence:/);
    assert.match(manualUser, /Isi paragraf pertama \(tanpa header\) — bias & posisi makro harga/);
    assert.match(manualSys, /"makro_alignment"/);
  });
});

test('AATAS e2e: field checklist (termasuk reasoning_note) tersimpan ke setup_log_auto:v1 + stempel policy_v/aatas_v', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.statusCode, 200);

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const st = log[0];
      assert.equal(st.checklist_pct, 82);
      assert.equal(st.verdict, 'SIAP TRADE');
      assert.match(st.reasoning_note, /BoE dovish/);
      assert.equal(st.regime_check.regime, 'risk_off');
      assert.deepEqual(st.gate_validitas_driver.pass, true);
      assert.equal(st.technical.fib_zone, '0.382');
      assert.equal(st.final_validation.cot, 'searah');
      assert.equal(st.aatas_v, AATAS_PROMPT_VERSION);
      assert.ok(st.policy_v >= AATAS_EPOCH, 'setup AATAS wajib membawa stempel epoch baru');
      // Field execution-critical TETAP ADA (dibaca gate/evaluasi existing).
      assert.equal(st.bias, 'bearish');
      assert.equal(st.conflict, 'none');
      // Field lama yang digantikan.
      assert.equal(st.makro_alignment, null);
      assert.equal(st.confidence, null);
      assert.equal(st.sistem_hakim, null);
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS e2e: GATE gagal (validitas driver) -> setup TIDAK pernah lahir, level dinolkan', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const gagal = {
      ...AATAS_JSON,
      gate_validitas_driver: { pass: false, note: 'driver cuma ekspektasi, belum ada rilis' },
      checklist_pct: 40, verdict: 'NO TRADE',
    };
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(gagal));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.structured.entry_zone, null, 'GATE wajib mengikat di kode, bukan cuma imbauan prompt');
      assert.equal(res.body.structured.sl, null);
      assert.equal(res.body.structured.tp, null);
      assert.equal(res.body.structured.aatas_reject_reason, 'gate_validitas_driver');
      assert.equal(store.strings['setup_log_auto:v1'], undefined, 'tidak ada setup yang boleh tersimpan');
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS e2e: verdict NO TRADE saja (gate lolos) juga membatalkan setup', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom({ ...AATAS_JSON, checklist_pct: 45, verdict: 'NO TRADE' }));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.aatas_reject_reason, 'verdict_no_trade');
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

// AATAS v2 (2026-08-25) — PERUBAHAN PERILAKU YANG DISENGAJA. v1 fail-OPEN di sini
// ("skema tidak dipatuhi bukan alasan menggagalkan setup"). v2 fail-CLOSED: seluruh
// tugas Call 1 adalah menghasilkan fundamental_bias, jadi ketiadaannya berarti
// panggilan itu gagal — bukan "model memilih tidak menilai". Membiarkan setup lahir
// tanpa dasar fundamental apa pun persis lubang yang plan ini dibuat untuk menutup.
test('AATAS e2e: Call 1 tidak melaporkan fundamental_bias -> fail-CLOSED, setup TIDAK lahir', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(BASE_JSON)); // tanpa field AATAS sama sekali
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.aatas_reject_reason, 'gate_validitas_driver_kode:fundamental_bias_kosong');
      assert.equal(res.body.structured.entry_zone, null);
      assert.equal(store.strings['setup_log_auto:v1'], undefined, 'tidak ada setup yang boleh tersimpan');
      assert.equal(store.strings['auto_guard_stats:gate1_code_override'], '1', 'override kode wajib tercatat di counter');
    } finally { global.fetch = origFetch; }
  });
});

// ── AATAS v2: short-circuit hemat biaya + jejak kandidat yang ditolak ────────

test('AATAS v2: Gate 1 gagal -> Call 2 TIDAK dipanggil sama sekali (penghematan biaya nyata)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // Kasus nyata AUD/NZD: AI lapor gate lolos, tapi strong_vs_weak false.
    const bocor = {
      ...AATAS_JSON,
      fundamental_bias: { ...AATAS_JSON.fundamental_bias, strong_vs_weak: false },
    };
    const cap = [];
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(bocor), cap);
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(cap.length, 1, 'hanya Call 1 yang boleh terpanggil — Call 2 & Gate A tidak kebagian budget');
      assert.doesNotMatch(cap[0].messages[1].content, /BAGIAN 2 DARI 2/);
      assert.equal(res.body.structured.aatas_reject_reason, 'gate_validitas_driver_kode:strong_vs_weak_bukan_true');
      assert.equal(res.body.structured.verdict, 'NO TRADE');
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS v2: kandidat yang ditolak direkam ke aatas_reject_log:v1 (bukan hilang), setup_log_auto TIDAK tercemar', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const bocor = {
      ...AATAS_JSON,
      fundamental_bias: {
        ...AATAS_JSON.fundamental_bias,
        driver: 'RSI 76.5 sudah overbought, posisi long ramai',
      },
    };
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(bocor));
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());

      const raw = store.lists['aatas_reject_log:v1'];
      assert.ok(Array.isArray(raw) && raw.length === 1, 'alasan penolakan wajib punya jejak persisten');
      const entry = JSON.parse(raw[0]);
      assert.equal(entry.reason, 'gate_validitas_driver_kode:indikator_teknikal_di_driver');
      assert.equal(entry.symbol, 'GBPUSD=X');
      // Field checklist ikut tersimpan penuh — itu gunanya, bukan cuma label alasan.
      assert.match(entry.fundamental_bias.driver, /RSI 76\.5/);
      assert.match(entry.reasoning_note || '', /MAKRO/);
      assert.match(entry.gate_validitas_driver.note, /OVERRIDE KODE/);
      assert.equal(entry.aatas_v, AATAS_PROMPT_VERSION);
      // Cap 200 setup_log_auto:v1 adalah sampel n>=30 — tidak boleh digeser oleh
      // kandidat tertolak (alasan key ini dipisah, lihat komentar di api/admin.js).
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('AATAS v2: jalur MANUAL tidak pernah menulis aatas_reject_log (isolasi Opsi A)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(BASE_JSON));
    try {
      const handler = loadHandler();
      await handler({
        headers: {}, method: 'POST', body: {},
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' },
      }, fakeRes());
      assert.equal(store.lists['aatas_reject_log:v1'], undefined);
      assert.ok(store.strings['setup_log:v1'], 'setup manual tetap lahir seperti biasa');
    } finally { global.fetch = origFetch; }
  });
});


// ── Fill hantu: entry di sisi SALAH dari harga berjalan ──────────────────────
// Ditemukan 2026-08-25 dari chart CHF/JPY di dev-auto-entry.html — marker "Filled"
// jauh dari garis Entry. Akar masalahnya: sanity-check level membandingkan harga
// berjalan dengan SL dan TP, tapi TIDAK dengan entry_zone. Refine-in-place bisa
// memindahkan entry ke sisi salah (jual di BAWAH harga / beli di ATAS harga), dan
// deteksi fill yang menyimpulkan arah tunggu dari `bias` saja langsung menganggapnya
// terisi oleh candle apa pun.
//
// nowPrice di store test = 1.28 (close terakhir mkTrendCandles(1.30, 1.28)).

// Lolos SEMUA pemeriksaan lama (sl > entryHigh, entryLow > tp, now < sl, now > tp,
// RR >= 1) — yang gagal HANYA aturan sisi entry yang baru. Kalau test ini hijau
// karena kebetulan tertolak aturan lama, dia tidak membuktikan apa-apa.
const ENTRY_SISI_SALAH_BEARISH = {
  ...AATAS_JSON,
  bias: 'bearish',
  entry_zone: '1.2770-1.2780', // seluruhnya DI BAWAH harga 1.28 -> salah untuk jual
  sl: '1.2850', tp: '1.2650',    // RR ~1.67, jauh dari batas 1.0 (lihat catatan di bawah)
};
// CATATAN kenapa RR sengaja dibuat 1.67, bukan pas 1.0: kombinasi entry 1.2775 mid /
// SL 1.2850 / TP 1.2700 menghasilkan RR yang secara desimal PERSIS 1.0, tapi di floating
// point jatuh ke 0.999... sehingga tertolak pemeriksaan RR LAMA. Test-nya tetap hijau,
// tapi membuktikan hal yang salah. Fixture harus gagal HANYA karena aturan sisi entry.

test('Fill hantu: jalur auto MENOLAK entry jual yang di BAWAH harga berjalan (kasus nyata CHF/JPY)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(ENTRY_SISI_SALAH_BEARISH));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.entry_zone, null, 'entry jual di bawah harga = akan langsung dianggap terisi, wajib ditolak');
      assert.equal(res.body.structured.sl, null);
      assert.equal(res.body.structured.tp, null);
      assert.equal(store.strings['setup_log_auto:v1'], undefined, 'tidak boleh ada setup tersimpan');
    } finally { global.fetch = origFetch; }
  });
});

test('Fill hantu: jalur auto MENOLAK entry beli yang di ATAS harga berjalan (kasus nyata EUR/GBP)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const salah = {
      ...AATAS_JSON,
      bias: 'bullish',
      entry_zone: '1.2820-1.2830', // seluruhnya DI ATAS harga 1.28 -> salah untuk beli
      sl: '1.2750', tp: '1.2950',
    };
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(salah));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.entry_zone, null);
      assert.equal(store.strings['setup_log_auto:v1'], undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('Fill hantu: harga DI DALAM zona entry tetap sah (batas <=/>=, bukan penolakan berlebihan)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // harga 1.28 berada DI DALAM 1.2795-1.2805 (AATAS_JSON asli) — ini fill sah di
    // harga zona itu sendiri, jangan ikut tertolak oleh aturan baru.
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);
      assert.equal(res.body.structured.entry_zone, '1.2795-1.2805');
      assert.ok(store.strings['setup_log_auto:v1'], 'setup normal harus tetap lahir');
    } finally { global.fetch = origFetch; }
  });
});

test('Fill hantu: REFINE dengan entry sisi salah DIBATALKAN — level lama dipertahankan utuh', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const oldPending = {
      id: 'GBPUSD=X:111', symbol: 'GBPUSD=X', label: 'GBP/USD', bias: 'bearish',
      entry_zone: '1.2900-1.2910', sl: '1.2960', tp: '1.2800',
      rr: 2, horizon_days: 3, model: 'deepseek-v4-flash', ts: 111, status: 'pending',
      source: 'auto', refined_count: 1,
    };
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify([oldPending]),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(ENTRY_SISI_SALAH_BEARISH));
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      assert.equal(log.length, 1);
      const it = log[0];
      assert.equal(it.entry_zone, '1.2900-1.2910', 'level LAMA wajib dipertahankan apa adanya');
      assert.equal(it.sl, '1.2960');
      assert.equal(it.tp, '1.2800');
      assert.equal(it.refined_count, 1, 'refine yang ditolak tidak boleh menaikkan refined_count');
      assert.equal(it.status, 'pending', 'setup lama tetap menunggu, bukan dibatalkan');
    } finally { global.fetch = origFetch; }
  });
});

test('Fill hantu: jalur MANUAL publik TIDAK ikut diperketat (isolasi Opsi A)', async () => {
  await withEnv({ DEEPSEEK_API_KEY: 'k' }, async () => {
    const manualSalah = {
      ...BASE_JSON,
      bias: 'bearish',
      entry_zone: '1.2770-1.2780', sl: '1.2850', tp: '1.2650',
    };
    const store = baseStore();
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(manualSalah));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: {}, method: 'POST', body: {},
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD' },
      }, res);
      assert.equal(res.body.structured.entry_zone, '1.2770-1.2780',
        'entry di sisi salah HARUS tetap lolos di jalur manual — pengetatan ini khusus auto (isolasi Opsi A)');
      assert.ok(store.strings['setup_log:v1'], 'setup manual tetap tercatat seperti sebelumnya');
    } finally { global.fetch = origFetch; }
  });
});

// ── hard-stop Step 0 cabang XAU/USD (end-to-end) ─────────────────────────────
// Satu-satunya hard-block baru AATAS. `unanimous` datang dari laporan model,
// FAKTA anomali korelasinya dihitung kode dari cache correlations_v3 — dua sumber
// terpisah, supaya angka tidak ikut dikarang model.

const XAU_JSON_BASE = {
  bias: 'bullish',
  entry_zone: '3990-3995', entry_basis: 'cluster S/R',
  sl: '3960', tp: '4060',
  trigger: 'tunggu rejection H1 di 3990', invalidation_condition: 'close H4 di bawah 3950',
  time_horizon_days: 3, conflict: 'none', conflict_note: null,
  gate_validitas_driver: { pass: true, note: 'real yield turun, data rilis resmi' },
  // AATAS v2: Gate 1 ditegakkan kode, jadi fundamental_bias WAJIB patuh skema — pokok
  // bahasan test XAU di bawah adalah hard-stop gold Step 0, bukan Gate 1.
  fundamental_bias: {
    score_pct: 78, arah: 'bullish', driver: 'real yield riil turun 8bps setelah rilis CPI',
    konfirmasi: ['DXY melemah 0,4%', 'ekspektasi pemangkasan Fed naik di rate path'],
    konflik: null, strong_vs_weak: true,
  },
  gate_risk_management: { pass: true, note: 'RR 1:2, SL di bawah swing' },
  checklist_pct: 80, verdict: 'SIAP TRADE',
  reasoning_note: 'Real yield turun mendukung emas; struktur H4 HH+HL.',
};

function xauStore(corrPayload) {
  const seed = {
    'ohlcv_fresh:GC=F': '1',
    'ohlcv:GC=F:1h': JSON.stringify(mkTrendCandles(3900, 4000)),
  };
  if (corrPayload) seed['correlations_v3'] = JSON.stringify(corrPayload);
  return makeStore(seed);
}

const CORR_ANOMALI = { gold_correlations: { RealYield: { r20: -0.05, r60: -0.75 } }, anomalies: [] };
const CORR_NORMAL  = { gold_correlations: { RealYield: { r20: -0.60, r60: -0.75 } }, anomalies: [] };

async function runXau(store, json) {
  const origFetch = global.fetch;
  global.fetch = makeAnalyzeFetchStub(store, rawFrom(json));
  try {
    const handler = loadHandler();
    const res = fakeRes();
    await handler({
      headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
      query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', auto: '1' },
    }, res);
    return res;
  } finally { global.fetch = origFetch; }
}

test('AATAS e2e XAU: real yield/DXY/regime TIDAK bulat + korelasi live anomali -> setup dibatalkan (hard-stop)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_ANOMALI);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'neutral', gold: { real_yield: 'bullish', dxy: 'bearish', risk_regime: 'netral', unanimous: false } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.structured.aatas_reject_reason, 'gold_regime_split_corr_anomali');
    assert.equal(res.body.structured.entry_zone, null);
    assert.equal(store.strings['setup_log_auto:v1'], undefined);
  });
});

test('AATAS e2e XAU: TIDAK bulat tapi korelasi NORMAL -> setup tetap lahir (real yield jadi penentu)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_NORMAL);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'neutral', gold: { real_yield: 'bullish', dxy: 'bearish', risk_regime: 'netral', unanimous: false } },
    });
    assert.equal(res.body.structured.aatas_reject_reason, null);
    assert.ok(store.strings['setup_log_auto:v1'], 'korelasi normal bukan alasan memblokir');
  });
});

test('AATAS e2e XAU: bulat 3/3 -> setup lahir walau korelasi sedang anomali', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const store = xauStore(CORR_ANOMALI);
    const res = await runXau(store, {
      ...XAU_JSON_BASE,
      regime_check: { regime: 'risk_off', gold: { real_yield: 'bullish', dxy: 'bullish', risk_regime: 'bullish', unanimous: true } },
    });
    assert.equal(res.body.structured.aatas_reject_reason, null);
    assert.ok(store.strings['setup_log_auto:v1']);
  });
});

// ── Gate B (drawdown circuit breaker) ikut discope ke populasi AATAS ─────────
// Kalau tidak, kerugian arsitektur LAMA langsung menyalakan rem di menit pertama
// arsitektur baru hidup — sistem yang dibuat untuk memperbaiki kerugian itu tidak
// pernah dapat kesempatan membuktikan diri.

const { _isAatasEpochSetup } = loadHandler();

test('_isAatasEpochSetup: policy_v > est > rekonstruksi dari ts; versi tak tentu -> BUKAN populasi AATAS', () => {
  assert.equal(_isAatasEpochSetup({ policy_v: AATAS_EPOCH }), true);
  assert.equal(_isAatasEpochSetup({ policy_v: AATAS_EPOCH - 1 }), false);
  assert.equal(_isAatasEpochSetup({ policy_v_est: AATAS_EPOCH }), true);
  assert.equal(_isAatasEpochSetup({ ts: Date.parse('2026-07-21T00:00:00Z') }), false);
  assert.equal(_isAatasEpochSetup({ ts: 'bukan-angka' }), false);
  assert.equal(_isAatasEpochSetup(null), false);
});

test('Gate B: rentetan SL arsitektur LAMA tidak lagi memblokir kandidat AATAS', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // 6 SL beruntun dari kebijakan lama (rolling R = -6, jauh di bawah ambang manapun)
    // dan tidak ada posisi pending/open (katup darurat waktu belum tentu terbuka).
    const slLama = [];
    for (let i = 0; i < 6; i++) {
      slLama.push({
        id: `EURUSD=X:${1786100000000 + i}`, symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish',
        entry_zone: '1.1700', sl: '1.1750', tp: '1.1600', rr: 2, status: 'sl',
        ts: 1786100000000 + i, closed_t: 1786200000000 + i, source: 'auto', policy_v: 25,
      });
    }
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify(slLama),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      const res = fakeRes();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, res);

      assert.equal(res.statusCode, 200);
      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const baru = log.find(x => x.symbol === 'GBPUSD=X');
      assert.ok(baru, 'kandidat AATAS harus tetap lahir — rem diukur dari populasi kebijakan yang sekarang');
      assert.equal(baru.status, 'pending', 'harus jadi setup LIVE, bukan ghost hasil gate');
      assert.equal(baru.canceled_reason, undefined);
    } finally { global.fetch = origFetch; }
  });
});

test('Gate B: rentetan SL dari populasi AATAS sendiri TETAP memblokir (rem tidak dimatikan, cuma discope)', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    // ts SENGAJA baru (beberapa jam lalu): katup darurat waktu (>=3 hari sejak entri
    // real terakhir) harus TERTUTUP supaya yang diuji benar-benar Gate B, bukan valve.
    const now = Date.now();
    const slBaru = [];
    for (let i = 0; i < 6; i++) {
      const ts = now - (i + 1) * 3600000;
      slBaru.push({
        id: `EURUSD=X:${ts}`, symbol: 'EURUSD=X', label: 'EUR/USD', bias: 'bearish',
        entry_zone: '1.1700', sl: '1.1750', tp: '1.1600', rr: 2, status: 'sl',
        ts, closed_t: ts + 60000, source: 'auto', policy_v: AATAS_EPOCH,
      });
    }
    const store = makeStore({
      'ohlcv_fresh:GBPUSD=X': '1',
      'ohlcv:GBPUSD=X:1h': JSON.stringify(mkTrendCandles(1.30, 1.28)),
      'setup_log_auto:v1': JSON.stringify(slBaru),
    });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON));
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());

      const log = JSON.parse(store.strings['setup_log_auto:v1']);
      const baru = log.find(x => x.symbol === 'GBPUSD=X');
      // Kandidat yang ditahan gate TETAP dicatat sebagai ghost (canceled) — itu memang
      // desainnya (ghost-tracking gate_reject), yang penting dia tidak jadi posisi live.
      assert.ok(baru, 'kandidat yang ditahan tetap direkam sebagai ghost, bukan hilang tanpa jejak');
      assert.equal(baru.status, 'canceled',
        'kalau kerugian datang dari arsitektur yang sekarang, Gate B wajib tetap menahan');
      assert.equal(baru.canceled_reason, 'gate_drawdown_circuit_breaker');
    } finally { global.fetch = origFetch; }
  });
});

// ── Step 0 gold: rate path Fed implied (konteks tambahan, non-blocking) ──────

const { _formatRatePathBlock } = loadHandler();

test('_formatRatePathBlock: arah pemangkasan/kenaikan dieja jelas; data kosong -> string kosong (bukan blok kosong di prompt)', () => {
  const cut = _formatRatePathBlock({ USD: { cumulative_3m_bps: -50, cumulative_6m_bps: -75 } });
  assert.match(cut, /50bps PEMANGKASAN sudah diharga/);
  assert.match(cut, /6 bulan: 75bps PEMANGKASAN/);
  const hike = _formatRatePathBlock({ USD: { cumulative_3m_bps: 25 } });
  assert.match(hike, /25bps KENAIKAN sudah diharga/);
  assert.doesNotMatch(hike, /6 bulan/);
  assert.equal(_formatRatePathBlock({ USD: {} }), '');
  assert.equal(_formatRatePathBlock(null), '');
});

test('AATAS e2e XAU: rate path masuk prompt jalur auto; pair FX & jalur manual TIDAK menariknya', async () => {
  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const cap = [];
    const store = xauStore(CORR_NORMAL);
    store.strings['rate_path'] = JSON.stringify({ USD: { cumulative_3m_bps: -50 } });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom({
      ...XAU_JSON_BASE,
      regime_check: { regime: 'risk_off', gold: { real_yield: 'bullish', dxy: 'bullish', risk_regime: 'bullish', unanimous: true } },
    }), cap);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GC=F', label: 'XAU/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }
    assert.match(cap[0].messages[1].content, /RATE PATH FED/);
  });

  await withEnv({ CRON_SECRET: 'topsecret', DEEPSEEK_API_KEY: 'k' }, async () => {
    const cap = [];
    const store = baseStore();
    store.strings['rate_path'] = JSON.stringify({ USD: { cumulative_3m_bps: -50 } });
    const origFetch = global.fetch;
    global.fetch = makeAnalyzeFetchStub(store, rawFrom(AATAS_JSON), cap);
    try {
      const handler = loadHandler();
      await handler({
        headers: { 'x-cron-secret': 'topsecret' }, method: 'GET',
        query: { action: 'ohlcv_analyze', symbol: 'GBPUSD=X', label: 'GBP/USD', auto: '1' },
      }, fakeRes());
    } finally { global.fetch = origFetch; }
    assert.doesNotMatch(cap[0].messages[1].content, /RATE PATH FED/, 'rate path itu delta cabang gold, bukan FX');
  });
});

// ── Konsistensi LLM ikut discope, latensi pipeline TIDAK ─────────────────────
// Konsistensi = properti PROMPT (prompt jalur auto diganti total oleh AATAS, jadi
// sampel lama menjawab pertanyaan tentang prompt yang sudah tidak dipakai).
// Latensi = murni infrastruktur kalender, tidak ada hubungannya dengan keputusan AI.

test('_consistencySummary: agregat hanya dari populasi AATAS, `recent` tetap penuh; latensi tidak difilter', async () => {
  const tsLama  = Date.parse('2026-08-10T10:45:00Z'); // arsitektur lama
  const tsBaru  = Date.now();                          // pasca-AATAS
  const konsistensi = [
    { ts: tsBaru, pair: 'frxXAUUSD', bias_identical: true },
    { ts: tsLama, pair: 'frxXAUUSD', bias_identical: false },
    { ts: tsLama - 1000, pair: 'frxXAUUSD', bias_identical: false },
  ].map(o => JSON.stringify(o));
  const latensi = [
    { ts: tsLama, latency_ms: 600000 },
    { ts: tsLama - 1000, latency_ms: 1200000 },
  ].map(o => JSON.stringify(o));

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const [cmd, key] = JSON.parse(opts.body);
    if (cmd === 'LRANGE' && key === 'consistency_log:v1') return { ok: true, json: async () => ({ result: konsistensi }) };
    if (cmd === 'LRANGE' && key === 'calendar_actual_latency_log:v1') return { ok: true, json: async () => ({ result: latensi }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    const { _consistencySummary, _summarizeLatency } = loadHandler();
    const c = await _consistencySummary();
    assert.equal(c.total, 1, 'cuma sampel pasca-AATAS yang dihitung');
    assert.equal(c.bias_identical, 1);
    assert.equal(c.bias_identical_pct, 100, 'sampel prompt lama tidak boleh menyeret angka prompt baru');
    assert.equal(c.recent.length, 3, 'riwayat mentah tetap bisa dibaca');
    assert.equal(c.from_policy_v, AATAS_EPOCH);

    // Latensi: entri LAMA tetap dihitung — ini data infrastruktur yang masih berlaku.
    const l = _summarizeLatency([{ latency_ms: 600000 }, { latency_ms: 1200000 }]);
    assert.equal(l.n, 2, 'latensi pipeline TIDAK ikut direset');
  } finally { global.fetch = origFetch; }
});
