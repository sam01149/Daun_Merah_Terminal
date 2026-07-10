// test/labour_market.test.js
// Unit test pure functions US Labour Market Assessment (api/_labour_market.js).
// Semua obs fixture TERURUT DESC (terbaru duluan) — mengikuti pola fetchFredMulti.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LABOUR_INDICATORS,
  classifyIndicator,
  buildAssessment,
  computeLabourAssessment,
  fetchLabourSeries,
} = require('../api/_labour_market.js');

const cfgById = (id) => LABOUR_INDICATORS.find(c => c.id === id);

// Bikin obs desc dari array nilai (terbaru duluan), tanggal bulanan mundur dari 2026-06-01
function obsMonthly(values, startYm = [2026, 6]) {
  let [y, m] = startYm;
  return values.map(v => {
    const date = `${y}-${String(m).padStart(2, '0')}-01`;
    m -= 1; if (m === 0) { m = 12; y -= 1; }
    return { value: v, date };
  });
}
function obsWeekly(values, startDate = new Date('2026-06-27')) {
  return values.map((v, i) => {
    const d = new Date(startDate.getTime() - i * 7 * 86400000);
    return { value: v, date: d.toISOString().slice(0, 10) };
  });
}

const NOW = new Date('2026-07-10').getTime();

// ── classifyIndicator: latest_vs_mean6 (band % relatif) ──────────────────────

test('JTSJOL: latest naik >1.5% dari mean 6 bln → strengthening', () => {
  // mean(7400..7400)=7400, latest 7600 → +2.7%
  const st = classifyIndicator(cfgById('JTSJOL'), obsMonthly([7600, 7400, 7400, 7400, 7400, 7400, 7400]), NOW);
  assert.equal(st.status, 'strengthening');
  assert.equal(st.as_of, '2026-06-01');
});

test('JTSJOL: dalam flat band ±1.5% → flat', () => {
  const st = classifyIndicator(cfgById('JTSJOL'), obsMonthly([7450, 7400, 7400, 7400, 7400, 7400, 7400]), NOW);
  assert.equal(st.status, 'flat');
});

test('JTSJOL: turun >1.5% → weakening', () => {
  const st = classifyIndicator(cfgById('JTSJOL'), obsMonthly([7100, 7400, 7400, 7400, 7400, 7400, 7400]), NOW);
  assert.equal(st.status, 'weakening');
});

// ── classifyIndicator: latest_vs_mean6 (band pp absolut) ─────────────────────

test('JTSQUR: +0.2pp dari mean → strengthening; ±0.05pp → flat', () => {
  const up = classifyIndicator(cfgById('JTSQUR'), obsMonthly([2.3, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1]), NOW);
  assert.equal(up.status, 'strengthening');
  const fl = classifyIndicator(cfgById('JTSQUR'), obsMonthly([2.15, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1]), NOW);
  assert.equal(fl.status, 'flat');
});

// ── classifyIndicator: delta3m_vs_prior3m (ADP) ──────────────────────────────

test('ADP: laju penambahan 3 bln terakhir jauh di atas 3 bln sebelumnya → strengthening', () => {
  // Δ terbaru: +60,+60,+60 (avg 60); Δ sebelumnya: +10,+10,+10 (avg 10) → diff 50 > 25
  const levels = [135400, 135340, 135280, 135220, 135210, 135200, 135190];
  const st = classifyIndicator(cfgById('ADPMNUSNERSA'), obsMonthly(levels), NOW);
  assert.equal(st.status, 'strengthening');
});

test('ADP: laju melambat drastis → weakening; selisih <25rb → flat', () => {
  // Δ terbaru avg +10 vs sebelumnya avg +60 → diff -50
  const slow = [135310, 135300, 135290, 135280, 135220, 135160, 135100];
  assert.equal(classifyIndicator(cfgById('ADPMNUSNERSA'), obsMonthly(slow), NOW).status, 'weakening');
  // Δ terbaru avg +30 vs sebelumnya avg +20 → diff 10 < 25 → flat
  const steady = [135250, 135220, 135190, 135160, 135140, 135120, 135100];
  assert.equal(classifyIndicator(cfgById('ADPMNUSNERSA'), obsMonthly(steady), NOW).status, 'flat');
});

// ── classifyIndicator: mean4w_vs_prior13w + arah dibalik (klaim) ─────────────

test('ICSA: klaim naik >3% → weakening (arah dibalik)', () => {
  const vals = [250000, 250000, 250000, 250000, ...Array(13).fill(230000)];
  const st = classifyIndicator(cfgById('ICSA'), obsWeekly(vals), NOW);
  assert.equal(st.status, 'weakening');
});

test('ICSA: klaim turun >3% → strengthening; dalam band ±3% → flat', () => {
  const down = [220000, 220000, 220000, 220000, ...Array(13).fill(230000)];
  assert.equal(classifyIndicator(cfgById('ICSA'), obsWeekly(down), NOW).status, 'strengthening');
  const flat = [231000, 231000, 231000, 231000, ...Array(13).fill(230000)];
  assert.equal(classifyIndicator(cfgById('ICSA'), obsWeekly(flat), NOW).status, 'flat');
});

test('JTSLDR: layoffs rate turun 0.2pp → strengthening (arah dibalik)', () => {
  const st = classifyIndicator(cfgById('JTSLDR'), obsMonthly([0.9, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1]), NOW);
  assert.equal(st.status, 'strengthening');
});

test('raw = arah data mentah, terpisah dari status (utk panah UI indikator terbalik)', () => {
  // Klaim NAIK → status weakening tapi raw 'up' (panah UI harus ↑, warna merah)
  const claimsUp = classifyIndicator(cfgById('ICSA'),
    obsWeekly([250000, 250000, 250000, 250000, ...Array(13).fill(230000)]), NOW);
  assert.equal(claimsUp.status, 'weakening');
  assert.equal(claimsUp.raw, 'up');
  // Openings naik → status strengthening dan raw 'up' (searah, tidak dibalik)
  const openingsUp = classifyIndicator(cfgById('JTSJOL'),
    obsMonthly([7600, 7400, 7400, 7400, 7400, 7400, 7400]), NOW);
  assert.equal(openingsUp.status, 'strengthening');
  assert.equal(openingsUp.raw, 'up');
});

// ── classifyIndicator: AHE annualized growth ─────────────────────────────────

test('AHE: akselerasi upah >0.3pp annualized → strengthening', () => {
  // 3 bln terakhir naik ~0.45%/bln (≈5.5% ann.), 3 bln sebelumnya ~0.2%/bln (≈2.4% ann.)
  const st = classifyIndicator(cfgById('CES0500000003'),
    obsMonthly([36.49, 36.33, 36.16, 36.00, 35.93, 35.86, 35.79]), NOW);
  assert.equal(st.status, 'strengthening');
});

test('AHE: butuh ≥7 observasi, kurang → unavailable', () => {
  const st = classifyIndicator(cfgById('CES0500000003'), obsMonthly([36.0, 35.9, 35.8]), NOW);
  assert.equal(st.status, 'unavailable');
});

// ── stale flag ───────────────────────────────────────────────────────────────

test('stale: bulanan >75 hari → stale=true, JOLTS lag 2 bln normal → stale=false', () => {
  const fresh = classifyIndicator(cfgById('JTSJOL'),
    obsMonthly([7600, 7400, 7400, 7400, 7400, 7400, 7400], [2026, 5]), NOW); // as_of 2026-05-01 (~70 hari)
  assert.equal(fresh.stale, false);
  const old = classifyIndicator(cfgById('JTSJOL'),
    obsMonthly([7600, 7400, 7400, 7400, 7400, 7400, 7400], [2026, 3]), NOW); // as_of 2026-03-01 (>75 hari)
  assert.equal(old.stale, true);
});

// ── buildAssessment: agreement & label ordinal ───────────────────────────────

function mkState(dim, status, id = Math.random().toString(36).slice(2)) {
  return { id, label: id, dim, status, value: 1, display: '1', detail: '', as_of: '2026-06-01', stale: false };
}

test('agreement 6/8 strengthening (75%, total ≥6) → STRONG STRENGTHENING', () => {
  const states = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('LAYOFFS', 'strengthening'), mkState('LAYOFFS', 'strengthening'),
    mkState('LAYOFFS', 'flat'), mkState('WAGE', 'weakening'),
  ];
  const a = buildAssessment(states);
  assert.equal(a.label, 'STRONG STRENGTHENING');
  assert.equal(a.agreement.text, '6 dari 8 indikator searah');
  assert.equal(a.agreement.direction, 'strengthening');
});

test('agreement 5/8 weakening (62.5%) → MODERATE WEAKENING', () => {
  const states = [
    mkState('HIRING', 'weakening'), mkState('HIRING', 'weakening'),
    mkState('HIRING', 'weakening'), mkState('HIRING', 'weakening'),
    mkState('LAYOFFS', 'weakening'), mkState('LAYOFFS', 'strengthening'),
    mkState('LAYOFFS', 'strengthening'), mkState('WAGE', 'strengthening'),
  ];
  const a = buildAssessment(states);
  assert.equal(a.label, 'MODERATE WEAKENING');
});

test('flat masuk denominator: 3 strength + 1 weak + 4 flat → 3/8 (<55%) → MIXED', () => {
  const states = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'weakening'),
    mkState('LAYOFFS', 'flat'), mkState('LAYOFFS', 'flat'),
    mkState('LAYOFFS', 'flat'), mkState('WAGE', 'flat'),
  ];
  const a = buildAssessment(states);
  assert.equal(a.label, 'MIXED');
  assert.equal(a.agreement.direction, 'mixed');
});

test('seri: 4 strength vs 4 weak (seri imbang) → MIXED', () => {
  const states = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('LAYOFFS', 'weakening'), mkState('LAYOFFS', 'weakening'),
    mkState('LAYOFFS', 'weakening'), mkState('WAGE', 'weakening'),
  ];
  assert.equal(buildAssessment(states).label, 'MIXED');
});

test('indikator missing: denominator menyesuaikan; <4 tersedia → DATA TIDAK CUKUP', () => {
  // 5 tersedia (4 strength 1 flat) → 4/5 = 80% tapi total <6 → MODERATE
  const partial = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('HIRING', 'strengthening'), mkState('LAYOFFS', 'strengthening'),
    mkState('LAYOFFS', 'flat'),
    mkState('LAYOFFS', 'unavailable'), mkState('WAGE', 'unavailable'), mkState('HIRING', 'unavailable'),
  ];
  const a = buildAssessment(partial);
  assert.equal(a.label, 'MODERATE STRENGTHENING');
  assert.equal(a.agreement.available, 5);

  const few = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'), mkState('WAGE', 'flat'),
    mkState('LAYOFFS', 'unavailable'), mkState('LAYOFFS', 'unavailable'),
    mkState('LAYOFFS', 'unavailable'), mkState('HIRING', 'unavailable'), mkState('HIRING', 'unavailable'),
  ];
  const b = buildAssessment(few);
  assert.equal(b.label, 'DATA TIDAK CUKUP');
  assert.equal(b.insufficient, true);
});

// ── Narasi: frasa teori + disclaimer priced-in, TANPA persen ─────────────────

test('narasi memuat framing teori dan disclaimer priced-in', () => {
  const states = [
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('HIRING', 'strengthening'), mkState('HIRING', 'strengthening'),
    mkState('LAYOFFS', 'strengthening'), mkState('LAYOFFS', 'strengthening'),
    mkState('LAYOFFS', 'flat'), mkState('WAGE', 'strengthening'),
  ];
  const a = buildAssessment(states);
  assert.match(a.narrative, /Secara teori/);
  assert.match(a.narrative, /priced-in/);
  assert.match(a.narrative, /konteks, bukan sinyal/);
  // Tanpa persen confidence di label/teks agreement (syarat wajib #1)
  assert.ok(!a.agreement.text.includes('%'), 'agreement text tidak boleh mengandung persen');
  assert.ok(!a.label.includes('%'), 'label tidak boleh mengandung persen');
});

// ── fetchLabourSeries: filter '.' + kegagalan per-seri tidak fatal ───────────

test('fetchLabourSeries: scale ADP diterapkan (seri berunit orang → ribuan)', async () => {
  process.env.FRED_API_KEY = 'test-key';
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ observations: [{ value: '134500000', date: '2026-06-01' }] }),
  });
  const obsList = await fetchLabourSeries(mockFetch);
  const adpIdx = LABOUR_INDICATORS.findIndex(c => c.id === 'ADPMNUSNERSA');
  assert.equal(obsList[adpIdx][0].value, 134500, 'ADP 134.5jt orang harus jadi 134500 (ribuan)');
  const jtsIdx = LABOUR_INDICATORS.findIndex(c => c.id === 'JTSJOL');
  assert.equal(obsList[jtsIdx][0].value, 134500000, 'seri tanpa scale tidak berubah');
});

test('fetchLabourSeries: observasi "." terfilter, seri gagal → null (unavailable)', async () => {
  process.env.FRED_API_KEY = 'test-key';
  const mockFetch = async (url) => {
    if (url.includes('series_id=ICSA')) return { ok: false, status: 500 };
    return {
      ok: true,
      json: async () => ({ observations: [
        { value: '7600', date: '2026-06-01' },
        { value: '.',    date: '2026-05-01' }, // harus terfilter
        { value: '7400', date: '2026-04-01' },
      ] }),
    };
  };
  const obsList = await fetchLabourSeries(mockFetch);
  assert.equal(obsList.length, LABOUR_INDICATORS.length);
  const icsaIdx = LABOUR_INDICATORS.findIndex(c => c.id === 'ICSA');
  assert.equal(obsList[icsaIdx], null, 'seri gagal harus null');
  const jtsIdx = LABOUR_INDICATORS.findIndex(c => c.id === 'JTSJOL');
  assert.equal(obsList[jtsIdx].length, 2, 'nilai "." harus terfilter');
  assert.equal(obsList[jtsIdx][1].value, 7400);
});

// ── computeLabourAssessment end-to-end dengan payload sintetis lengkap ───────

test('computeLabourAssessment: 8 seri sehat → payload lengkap 3 dimensi', () => {
  const obsById = {
    JTSJOL:        obsMonthly([7600, 7400, 7400, 7400, 7400, 7400, 7400]),
    JTSQUR:        obsMonthly([2.3, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1]),
    ADPMNUSNERSA:  obsMonthly([135400, 135340, 135280, 135220, 135210, 135200, 135190]),
    TEMPHELPS:     obsMonthly([2600, 2600, 2600, 2500, 2500, 2500, 2500]),
    ICSA:          obsWeekly([220000, 220000, 220000, 220000, ...Array(13).fill(230000)]),
    CCSA:          obsWeekly([1850000, 1850000, 1850000, 1850000, ...Array(13).fill(1900000)]),
    JTSLDR:        obsMonthly([0.9, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1]),
    CES0500000003: obsMonthly([36.49, 36.33, 36.16, 36.00, 35.93, 35.86, 35.79]),
  };
  const obsList = LABOUR_INDICATORS.map(cfg => obsById[cfg.id]);
  const a = computeLabourAssessment(obsList, NOW);
  assert.equal(a.label, 'STRONG STRENGTHENING'); // 8/8 searah
  assert.equal(a.dimensions.HIRING.length, 4);
  assert.equal(a.dimensions.LAYOFFS.length, 3);
  assert.equal(a.dimensions.WAGE.length, 1);
  assert.equal(a.as_of_latest, '2026-06-27');
  assert.ok(a.narrative.length > 50);
});
