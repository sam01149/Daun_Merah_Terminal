// test/newscat.test.js
// Unit test newscat.js (session 158: perombakan total filter kategori NEWS).
// Dua lapis: (1) engine matching — word boundary, plural otomatis, wildcard,
// notasi pair FX; (2) korpus headline gaya FinancialJuice — termasuk SEMUA
// false positive yang terdokumentasi dari era substring-match (shipping→ppi,
// Goldman→gold, turmoil→oil, software→war, Boeing→boe, Bundesbank→bund, dst).
const { test } = require('node:test');
const assert = require('node:assert');
const NewsCat = require('../newscat');

const { compileKeyword, compileList, anyMatch, detectCat, normalize } = NewsCat;

function hits(kw, text) { return compileKeyword(kw).rx.test(normalize(text)); }

// ── Lapis 1: engine ─────────────────────────────────────────────────────────

test('boundary: keyword pendek tidak match di tengah kata', () => {
  assert.equal(hits('ppi', 'Global shipping rates surge'), false);
  assert.equal(hits('gold', 'Goldman Sachs raises target'), false);
  assert.equal(hits('oil', 'Market turmoil deepens'), false);
  assert.equal(hits('war', 'Microsoft software update warning'), false);
  assert.equal(hits('boe', 'Boeing shares fall'), false);
  assert.equal(hits('bund', 'Bundesbank chief speaks'), false);
  assert.equal(hits('corn', 'Cornerstone deal announced'), false);
  assert.equal(hits('eth', 'New method for measuring inflation'), false);
  assert.equal(hits('ism', 'Pessimism grows among investors'), false);
});

test('boundary: keyword tetap match saat berdiri sendiri', () => {
  assert.equal(hits('ppi', 'US PPI rises 0.3% in June'), true);
  assert.equal(hits('gold', 'Gold hits record high'), true);
  assert.equal(hits('oil', 'Oil jumps 3%'), true);
  assert.equal(hits('war', 'War in the Middle East escalates'), true);
  assert.equal(hits('ism', 'ISM manufacturing beats forecast'), true);
});

test('plural otomatis: -s/-es dan -y→-ies, tanpa kena kata turunan', () => {
  assert.equal(hits('stock', 'Stocks rally on Wall Street'), true);
  assert.equal(hits('stock', 'Oil stockpile data due'), false);
  assert.equal(hits('treasury', 'Treasuries sell off'), true);
  assert.equal(hits('commodity', 'Commodities slump broadly'), true);
  assert.equal(hits('rate cut', 'Two rate cuts expected this year'), true);
  assert.equal(hits('tanker', 'Two tankers attacked'), true);
});

test('possessive: apostrof adalah boundary', () => {
  assert.equal(hits('fed', "Fed's Powell speaks at Jackson Hole"), true);
  assert.equal(hits('trump', 'Trump’s tariffs hit imports'), true); // kutip melengkung feed
});

test('wildcard eksplisit: prefix match hanya kalau diminta', () => {
  assert.equal(hits('refiner*', 'Refinery outage in Texas'), true);
  assert.equal(hits('iran*', 'Iranian officials respond'), true);
  assert.equal(hits('sanction*', 'New sanctions announced'), true);
  assert.equal(hits('crypto*', 'Cryptocurrency market cap grows'), true);
});

test('notasi pair FX: sisi slash terbuka, sisi huruf ber-boundary', () => {
  assert.equal(hits('/usd', 'EUR/USD climbs above 1.09'), true);
  assert.equal(hits('usd/', 'USD/JPY hits 150'), true);
  assert.equal(hits('usd/', 'consensus around it'), false);
  assert.equal(hits('s&p', 'S&P 500 futures edge higher'), true);
  assert.equal(hits('opec+', 'OPEC+ agrees to output cut'), true);
});

test('euro tidak match european', () => {
  assert.equal(hits('euro', 'European stocks open higher'), false);
  assert.equal(hits('euro', 'Euro rises after ECB'), true);
});

test('normalize: tipografi feed disamakan', () => {
  assert.equal(normalize('Fed’s  “dovish” — pivot'), 'fed\'s "dovish" - pivot');
});

// ── Lapis 2: korpus headline — false positive lama harus sembuh ────────────

const CORPUS = [
  // [headline, kategoriBenar, catatan]
  ['Global shipping rates surge on Red Sea attacks', 'geopolitical', 'dulu econ-data via ppi⊂shipping'],
  ['Goldman Sachs raises S&P 500 target to 6500', 'equities', 'dulu commodities via gold⊂goldman'],
  ['Boeing shares fall after mid-air incident', 'equities', 'dulu macro via boe⊂boeing'],
  ['Bundesbank chief warns on inflation persistence', 'macro', 'dulu bonds via bund⊂bundesbank'],
  ['South Korean won weakens past 1400 per dollar', 'forex', 'won kini hanya via frasa korean won'],
  ['Ethereum upgrade completes successfully', 'crypto', 'eth/ethereum tetap jalan'],

  // hard rule kalender (session 135)
  ['US CPI Actual 2.4% Forecast 2.5% Previous 2.6%', 'econ-data', 'format kalender FJ'],
  ['German Ifo Business Climate Actual 88.4 (Forecast 89.0, Previous 87.5)', 'econ-data', 'format kalender FJ'],

  // hard rule market-moving: hanya marker urgensi eksplisit
  ['BREAKING: Iran launches missiles at Israel', 'market-moving', 'marker BREAKING menang atas topik'],
  ['Trading halted on NYSE after circuit breaker triggered', 'market-moving', 'marker halt'],
  ['Iran launches missiles at Israel', 'geopolitical', 'tanpa marker → topiknya sendiri'],
  ['Ukraine war update: fighting intensifies near Kharkiv', 'geopolitical', 'war kini geopolitical, bukan market-moving'],

  // satu topik per kategori (regresi perilaku lama)
  ['USD/JPY hits 150 as yen weakens', 'forex', ''],
  ['Dollar index rises to 105.2 after payrolls', 'forex', 'dollar index (2) > payroll (1)'],
  ['Oil jumps 3% after OPEC+ announces output cut', 'energy', ''],
  ['Gold hits record high above $2,700', 'commodities', ''],
  ['10-year Treasury yield falls to 4.2%', 'bonds', ''],
  ['Bitcoin tops $100,000 for the first time', 'crypto', ''],
  ['Japan composite index rises for third month', 'indexes', ''],
  ["Fed's Powell: rate cuts depend on incoming data", 'macro', ''],
  ['US initial jobless claims rise to 230k', 'econ-data', ''],
  ['Eurozone flash PMI beats expectations', 'econ-data', 'pmi (2 hit) > eurozone (1)'],
  ['Nvidia earnings beat estimates, shares surge', 'equities', ''],

  // scoring: konteks dominan menang
  ['Trump: China tariffs will rise to 60%', 'geopolitical', 'trump+china+tariff=3'],
  ['Taiwan Strait tensions escalate after drills', 'geopolitical', 'strait bare dibuang dari energy'],
  ['US debt ceiling standoff rattles markets', 'macro', 'debt ceiling (2, macro) > debt (1, bonds)'],
  ['EU threatens retaliation over steel tariffs', 'geopolitical', 'retaliat*+tariff=3 > steel=1'],

  // fallback
  ['Quiet session ahead of holiday weekend', 'macro', 'tanpa match → fallback macro'],
];

for (const [headline, expected, note] of CORPUS) {
  test(`detectCat: "${headline}" → ${expected}${note ? ` (${note})` : ''}`, () => {
    assert.equal(detectCat(headline), expected);
  });
}

test('detectCat: input kosong/null aman → macro', () => {
  assert.equal(detectCat(''), 'macro');
  assert.equal(detectCat(null), 'macro');
  assert.equal(detectCat(undefined), 'macro');
});

test('semua kategori CATS punya keyword yang bisa dikompilasi', () => {
  for (const [cat, kws] of Object.entries(NewsCat.CATS)) {
    const compiled = compileList(kws);
    assert.ok(compiled.length > 0, `${cat} kosong`);
    for (const c of compiled) assert.ok(c.rx instanceof RegExp);
  }
});

// ── Lapis 3: detectPushCat (api/admin.js) memakai engine yang sama ─────────

test('detectPushCat: boundary fix juga berlaku di push', () => {
  const admin = require('../api/admin.js');
  assert.equal(typeof admin.detectPushCat, 'function');
  // dulu: "software" ⊂ 'war' → geopolitical; "turmoil" ⊂ 'oil' → energy
  assert.equal(admin.detectPushCat('Microsoft software update released'), 'news');
  assert.equal(admin.detectPushCat('Political turmoil in France deepens'), 'news');
  assert.equal(admin.detectPushCat('Market turmoil: stocks plunge'), 'market-moving');
  assert.equal(admin.detectPushCat('Oil rises on supply concerns'), 'energy');
  assert.equal(admin.detectPushCat('Dollar rallies after strong data'), 'forex');
  assert.equal(admin.detectPushCat("Fed's Powell signals patience"), 'macro');
  assert.equal(admin.detectPushCat('Iranian officials reject proposal'), 'geopolitical');
  assert.equal(admin.detectPushCat('US CPI Actual 2.4% Forecast 2.5%'), 'econ-data');
});
