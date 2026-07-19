// test/cal_scenario_sim.test.js
// Simulasi kalender (dasar bertumpu) — audit S155:
// 1. Indikator terbalik (unemployment/claims/...): tombol & header BEAT/MISS harus
//    mengikuti arah ANGKA rilis (BEAT = ▼ angka turun), bukan panah ▲ hardcoded yang
//    dulu bikin "Unemployment Rate ▲ BEAT → CAD menguat" terbaca kontradiktif dan
//    bisa menjebak user memilih arah pair yang persis terbalik.
// 2. Baris Retail selalu dirender (tersedia / tidak tersedia / belum dimuat) supaya
//    jumlah faktor yang dinilai setara antar pair — verdict badge apples-to-apples.
// 3. Tag "⚡ reaksi langsung" menandai pair mayor mata uang event (bukan utk event USD).
// 4. Bias CB ortogonal (Data Dependent/On Hold/Split) diberi tanda (≈netral).
// 5. escJs: nama event ber-apostrof tidak mematahkan literal JS di atribut onclick.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

function grab(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s !== -1, `marker awal tidak ketemu: ${startMarker}`);
  const e = html.indexOf(endMarker, s);
  assert.ok(e !== -1, `marker akhir tidak ketemu: ${endMarker}`);
  return html.slice(s, e);
}

const src = [
  // stub data global yang direferensikan scenarioConfluence — bisa dimutasi via set()
  'var cbData = null, fundData = null, cotData = null, retailData = null, corrData = null;',
  'function scoreInd() { return null; }',
  grab('const CAL_INVERSE_INDICATOR_RE', '\nfunction compareActualForecast'),
  grab('function decodeHtmlEntities(s)', 'function escHtml(s)'),
  grab('function escHtml(s)', '\n// ── ANALISA'),
  grab('const SCENARIO_PAIR_MAP', '\nfunction calOpenScenario'),
  grab('const CB_BIAS_LEVEL', '\n// Bandingin arah'),
  grab('function cotAlignmentNote', '\nfunction _ckEvTimestamp'),
  grab('const TEK_CORR_LEG', '\n'),
  grab('function scenarioRenderResults', '\n// ── Konfluensi'),
  grab('const SCEN_FUND_RATE_KEYS', '\nfunction scenarioVerdictBadge'),
  grab('function scenarioVerdictBadge', '\n// Dipanggil saat'),
].join('\n');

const api = new Function(src + `
  return {
    CAL_INVERSE_INDICATOR_RE, escHtml, escJs,
    scenarioRenderResults, scenarioConfluence, scenarioVerdictBadge,
    set: p => {
      if ('cbData'     in p) cbData     = p.cbData;
      if ('fundData'   in p) fundData   = p.fundData;
      if ('cotData'    in p) cotData    = p.cotData;
      if ('retailData' in p) retailData = p.retailData;
      if ('corrData'   in p) corrData   = p.corrData;
    },
  };
`)();

const mkPair = (pair, dir, plus = 2, minus = 1) =>
  ({ pair, dir, conf: { rows: [], plus, minus } });

test('regex indikator terbalik: unemployment/claims kena, CPI & NFP tidak', () => {
  assert.ok(api.CAL_INVERSE_INDICATOR_RE.test('Unemployment Rate'));
  assert.ok(api.CAL_INVERSE_INDICATOR_RE.test('Unemployment Claims'));
  assert.ok(api.CAL_INVERSE_INDICATOR_RE.test('Crude Oil Inventories'));
  assert.ok(!api.CAL_INVERSE_INDICATOR_RE.test('CPI y/y'));
  assert.ok(!api.CAL_INVERSE_INDICATOR_RE.test('Non-Farm Employment Change'));
});

test('header BEAT indikator terbalik: panah ▼ + "(angka turun)" + currency menguat', () => {
  const out = api.scenarioRenderResults(
    [mkPair('USD/CAD', 'short')], 'CAD', 'beat', 'Unemployment Rate', 'ev1');
  assert.ok(out.includes('▼ BEAT (angka turun)'), 'BEAT terbalik harus panah turun');
  assert.ok(out.includes('CAD menguat'));
  assert.ok(!out.includes('▲ BEAT'), 'panah ▲ BEAT lama tidak boleh muncul di indikator terbalik');
});

test('header MISS indikator terbalik: panah ▲ + "(angka naik)" + currency melemah', () => {
  const out = api.scenarioRenderResults(
    [mkPair('USD/CAD', 'long')], 'CAD', 'miss', 'Unemployment Rate', 'ev1');
  assert.ok(out.includes('▲ MISS (angka naik)'));
  assert.ok(out.includes('CAD melemah'));
});

test('header indikator normal: BEAT tetap ▲ tanpa keterangan angka', () => {
  const out = api.scenarioRenderResults(
    [mkPair('EUR/USD', 'long')], 'EUR', 'beat', 'CPI y/y', 'ev1');
  assert.ok(out.includes('▲ BEAT'));
  assert.ok(!out.includes('angka turun') && !out.includes('angka naik'));
});

test('tag reaksi langsung: hanya di pair mayor mata uang event', () => {
  const out = api.scenarioRenderResults(
    [mkPair('USD/CAD', 'short'), mkPair('CAD/CHF', 'long')],
    'CAD', 'beat', 'Employment Change', 'ev1');
  const first = out.indexOf('reaksi langsung');
  assert.ok(first !== -1, 'tag harus muncul');
  assert.strictEqual(out.indexOf('reaksi langsung', first + 1), -1, 'tag hanya sekali');
  assert.ok(first > out.indexOf('USD/CAD') && first < out.indexOf('CAD/CHF'),
    'tag menempel di blok USD/CAD, bukan CAD/CHF');
});

test('tag reaksi langsung: tidak muncul untuk event USD (semua kandidat memuat USD)', () => {
  const out = api.scenarioRenderResults(
    [mkPair('USD/JPY', 'long'), mkPair('EUR/USD', 'short')],
    'USD', 'beat', 'Core CPI m/m', 'ev1');
  assert.ok(!out.includes('reaksi langsung'));
});

test('caption & footer: jujur soal basis ranking + besaran deviasi', () => {
  const out = api.scenarioRenderResults(
    [mkPair('EUR/USD', 'long')], 'EUR', 'beat', 'CPI y/y', 'ev1');
  assert.ok(out.includes('bukan seberapa besar pair biasanya bereaksi'));
  assert.ok(out.includes('besaran deviasi actual vs forecast'));
  assert.ok(!out.includes('faktor independen'), 'klaim independen dihapus');
});

test('retail: pair tak tercakup data → baris netral "tidak tersedia", tidak dihitung', () => {
  api.set({
    cbData: [{ currency: 'CAD', bias: 'Cautious Hawkish', rate_display: '2.25' },
             { currency: 'CHF', bias: 'Cautious Dovish',  rate_display: '0.00' }],
    retailData: { positions: { USDCAD: { long_pct: 79.8, short_pct: 20.2, signal: 'CONTRARIAN_SHORT' } } },
    cotData: null, corrData: null, fundData: null,
  });
  const c = api.scenarioConfluence('CAD/CHF', 'long', 'CAD', 'beat');
  const rows = c.rows.join('');
  assert.ok(rows.includes('tidak tersedia untuk CAD/CHF'));
  // CB ✓ (Cautious Hawkish 5 vs Cautious Dovish 3) satu-satunya yang dihitung
  assert.strictEqual(c.plus, 1);
  assert.strictEqual(c.minus, 0);
});

test('retail: belum dimuat → baris "belum dimuat…" (bukan hilang diam-diam)', () => {
  api.set({ retailData: null });
  const c = api.scenarioConfluence('CAD/CHF', 'long', 'CAD', 'beat');
  assert.ok(c.rows.join('').includes('data retail belum dimuat'));
});

test('retail: pair tercakup → kontrarian dinilai seperti sebelumnya', () => {
  api.set({ retailData: { positions: { USDCAD: { long_pct: 79.8, short_pct: 20.2, signal: 'CONTRARIAN_SHORT' } } } });
  const c = api.scenarioConfluence('USD/CAD', 'short', 'CAD', 'beat');
  const rows = c.rows.join('');
  assert.ok(rows.includes('79.8% long / 20.2% short'));
  assert.ok(rows.includes('kontrarian mendukung SHORT'));
});

test('bias CB ortogonal: Data Dependent diberi tanda (≈netral), bias axis tidak', () => {
  api.set({
    cbData: [{ currency: 'CAD', bias: 'Cautious Hawkish', rate_display: '2.25' },
             { currency: 'EUR', bias: 'Data Dependent',   rate_display: '2.40' }],
    retailData: null,
  });
  const rows = api.scenarioConfluence('EUR/CAD', 'short', 'CAD', 'beat').rows.join('');
  assert.ok(rows.includes('EUR Data Dependent (≈netral)'));
  assert.ok(!rows.includes('Cautious Hawkish (≈netral)'));
});

test('escJs: apostrof & backslash di nama event tidak mematahkan literal onclick', () => {
  assert.strictEqual(api.escJs("Trump's Speech"), "Trump\\'s Speech");
  assert.strictEqual(api.escJs('a\\b'), 'a\\\\b');
  assert.strictEqual(api.escJs('a"b'), 'a\\u0022b');
  assert.strictEqual(api.escJs('a<b>&c'), 'a&lt;b&gt;&amp;c');
  // hasil escape valid dievaluasi balik jadi string aslinya
  assert.strictEqual(eval(`'${"Trump\\'s Speech"}'`), "Trump's Speech");
});
