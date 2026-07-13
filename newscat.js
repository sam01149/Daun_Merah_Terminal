/* newscat.js — klasifikasi kategori berita Daun Merah (SINGLE SOURCE OF TRUTH).
 *
 * Sebelum file ini ada, detectCat() punya 3 salinan berbeda (index.html, sw.js,
 * api/market-digest.js) + detectPushCat() di api/admin.js — semuanya substring
 * match polos (t.includes(k)) yang menghasilkan salah kategori sistemik:
 *   "shipping"  → cocok 'ppi'   → econ-data     (bug repro session 158)
 *   "Goldman"   → cocok 'gold'  → commodities
 *   "turmoil"   → cocok 'oil'   → energy
 *   "software"  → cocok 'war'   → market-moving
 *   "Boeing"    → cocok 'boe'   → macro
 *   "Bundesbank"→ cocok 'bund'  → bonds
 *   "won the …" → cocok 'won'   → forex
 *
 * File ini menggantikan semuanya dengan satu engine:
 *   1. Word-boundary match — keyword di-compile jadi RegExp dengan \b di sisi
 *      yang bersebelahan huruf/angka, jadi 'ppi' tidak pernah kena "shipping".
 *   2. Plural otomatis — 'stock' juga match "stocks", 'treasury' match
 *      "treasuries" (aturan -y → -ies), tanpa kena "stockpile".
 *   3. Wildcard eksplisit — 'refiner*' match refinery/refiners/refining;
 *      'iran*' match Iranian. Wildcard harus ditulis sadar, bukan efek samping.
 *   4. Scoring berbobot, bukan first-match — semua kategori dihitung skornya
 *      (frasa multi-kata/pair FX berbobot 2, kata tunggal 1), skor tertinggi
 *      menang; seri jatuh ke urutan prioritas tabel (urutan lama dipertahankan).
 *      Contoh menang-karena-skor: "Trump: China tariffs will rise" →
 *      geopolitical (3) walau tidak ada lagi first-match yang menyerobot.
 *   5. Hard rule tetap di depan: format rilis kalender (Actual + Forecast/
 *      Previous) SELALU econ-data (keputusan session 135); marker urgensi
 *      eksplisit (BREAKING, market halt, …) SELALU market-moving. 'war' TIDAK
 *      lagi jadi marker market-moving — pindah ke geopolitical (dulu ikut
 *      market-moving hanya karena substring, dan ikut menjerat "warning").
 *
 * Konsumen (jaga tetap sinkron kalau menambah kategori):
 *   - index.html   : <script src="/newscat.js?v=…"> → window.NewsCat
 *   - sw.js        : importScripts('/newscat.js?v=…') → self.NewsCat
 *   - api/market-digest.js, api/admin.js : require('../newscat')
 * Naikkan NEWSCAT_VERSION di index.html & sw.js tiap kali file ini berubah
 * (query ?v= adalah satu-satunya cache-buster untuk browser/SW).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NewsCat = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const VERSION = '2026.07.13.1';

  // Samakan tipografi feed (kutip melengkung, dash panjang) & spasi ganda
  // supaya keyword ASCII selalu ketemu. Sama filosofinya dengan sanitasi PDF.
  function normalize(title) {
    return String(title == null ? '' : title)
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”«»]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Escape semua metachar regex KECUALI '*' (wildcard DSL kita, dibuang dulu).
  const RX_ESCAPE = /[.+?^${}()|[\]\\]/g;

  // Sintaks keyword (mini-DSL):
  //   'stock'      → \bstock(?:e?s)?\b    boundary dua sisi + plural otomatis
  //   'treasury'   → \btreasur(?:y|ies)\b plural -y jadi -ies
  //   'rate cut'   → \brate cut(?:e?s)?\b plural hanya di kata terakhir
  //   'refiner*'   → \brefiner\w*         prefix match eksplisit
  //   'eur/'       → \beur/               boundary cuma di sisi alfanumerik
  //   '/usd'       → /usd\b
  //   'opec+'      → \bopec\+             metachar di-escape, tanpa plural
  // Boundary \b cukup karena feed FinancialJuice praktis ASCII; apostrof/'s
  // otomatis kena ("Fed's" tetap match 'fed').
  function compileKeyword(kw) {
    let w = normalize(kw);
    let wild = false;
    if (w.endsWith('*')) { wild = true; w = w.slice(0, -1); }
    const pre = /^[a-z0-9]/.test(w) ? '\\b' : '';
    let body = w.replace(RX_ESCAPE, '\\$&');
    let post = '';
    if (wild) {
      post = '\\w*';
    } else if (/[a-z]$/.test(w)) {
      if (w.endsWith('y')) { body = body.slice(0, -1); post = '(?:y|ies)\\b'; }
      else post = '(?:e?s)?\\b';
    } else if (/[0-9]$/.test(w)) {
      post = '\\b';
    }
    // Frasa multi-kata & notasi pair FX jauh lebih spesifik daripada kata
    // tunggal → bobot 2, supaya "debt ceiling" (macro) menang atas "debt" (bonds).
    const weight = (w.includes(' ') || w.includes('/')) ? 2 : 1;
    return { rx: new RegExp(pre + body + post), weight: weight, kw: kw };
  }

  function compileList(list) { return list.map(compileKeyword); }
  function anyMatch(text, compiled) { return compiled.some(c => c.rx.test(text)); }
  function score(text, compiled) {
    let s = 0;
    for (const c of compiled) if (c.rx.test(text)) s += c.weight;
    return s;
  }

  // ── HARD RULE 1: rilis kalender FinancialJuice ("… Actual X Forecast Y
  // Previous Z") selalu econ-data, dicek sebelum apa pun (session 135).
  function isCalendarRelease(t) {
    return /\bactual\b/.test(t) && (/\bforecast\b/.test(t) || /\bprevious\b/.test(t));
  }

  // ── HARD RULE 2: marker urgensi eksplisit → market-moving, apapun topiknya.
  // Sengaja sempit (selaras filosofi PUSH_KW.MARKET_MOVING): hanya kata yang
  // eksklusif menandai kejadian besar. 'flash'/'alert' TIDAK masuk (session
  // 135/138: Flash CPI/PMI = rilis preliminer). 'war' TIDAK masuk (pindah ke
  // geopolitical — perang itu geopolitik, bukan otomatis market-moving).
  const MARKET_MOVING_MARKERS = [
    'market moving', 'breaking', 'urgent', 'blockade',
    'flash crash', 'circuit breaker', 'trading halt', 'trading halted',
    'halts trading', 'market halt', 'emergency meeting', 'emergency rate',
    'surprise rate', 'unexpected rate', 'shock decision',
    'market crash', 'market rout', 'market meltdown', 'market turmoil',
    'black swan',
  ];

  /* Tabel kategori kanonik — union dari 3 salinan lama (index.html paling
   * lengkap sebagai basis), dibersihkan dari keyword yang terbukti jadi false
   * positive. URUTAN OBJEK = prioritas tie-break (skor seri → yang lebih atas
   * menang), dipertahankan sama dengan urutan first-match lama supaya perilaku
   * pada headline satu-topik tidak berubah.
   *
   * Keyword yang sengaja DIBUANG dari daftar lama:
   *   'won'    (forex)  → ambigu dengan verb "won"; diganti 'korean won'
   *   'rand'   (forex)  → kena "Rand Paul"/"grand"; diganti 'south african rand'
   *   'strait' (energy) → kena "Taiwan Strait"; cukup 'hormuz'/'strait of hormuz'
   *   'war'    (market-moving) → pindah geopolitical
   *   'sentiment' bare  → terlalu luas; cukup frasa spesifiknya
   * Keyword bermasalah yang kini AMAN karena word-boundary (tidak perlu dibuang):
   *   'ppi' vs shipping, 'gold' vs Goldman, 'oil' vs turmoil, 'boe' vs Boeing,
   *   'bund' vs Bundesbank, 'corn' vs cornerstone, 'eth' vs method.
   */
  const CATS = {
    'forex': [
      // notasi pair — prefix/suffix menangkap semua kombinasi (eur/usd, usd/idr, …)
      'eur/', 'gbp/', 'usd/', 'aud/', 'nzd/', 'cad/', 'chf/', 'jpy/', 'xau/', 'xag/',
      '/usd', '/eur', '/gbp', '/jpy', '/cad', '/chf', '/aud', '/nzd', '/cnh', '/cny',
      // kode ISO bare — dipakai FJ untuk rilis positioning per-instrumen
      // ("EUR CFTC Positions Week Ended …", audit feed asli session 158 lanj.4).
      // 'try'(kata Inggris), 'won'(verb), 'rub'(verb), 'cop'(COP28), 'all' sengaja TIDAK ada.
      'usd', 'eur', 'gbp', 'jpy', 'aud', 'nzd', 'chf', 'cad', 'cnh', 'cny',
      'mxn', 'sek', 'nok', 'dkk', 'zar', 'krw', 'inr', 'idr', 'sgd', 'hkd',
      'thb', 'brl', 'pln', 'huf', 'czk', 'myr', 'php', 'twd', 'ils', 'aed',
      // indeks & julukan dolar
      'dollar index', 'dxy', 'usdx', 'trade-weighted dollar', 'us dollar', 'greenback',
      // mata uang mayor (nama & julukan)
      'euro', 'euro zone', 'euro area', 'eurozone', 'fiber',
      'sterling', 'pound sterling', 'pound', 'cable',
      'yen', 'japanese yen',
      'franc', 'swiss franc', 'swissy',
      'canadian dollar', 'loonie',
      'australian dollar', 'aussie',
      'new zealand dollar', 'kiwi',
      'yuan', 'renminbi', 'offshore yuan',
      // pasar FX generik
      'fx options', 'options expir*', 'currency pair*', 'currency market',
      'currency intervention', 'fx intervention', 'currency war',
      'forex', 'foreign exchange', 'fx market', 'spot rate', 'exchange rate',
      'safe haven', 'carry trade', 'devaluation',
      // minor/EM — 'won' & 'rand' bare sengaja tidak ada (lihat catatan atas)
      'forint', 'zloty', 'krona', 'krone', 'ringgit', 'lira', 'rupee', 'rupiah',
      'peso', 'baht', 'korean won', 'south african rand',
    ],
    'equities': [
      's&p', 's&p 500', 'nasdaq', 'dow', 'dow jones', 'ftse', 'dax', 'nikkei',
      'hang seng', 'russell 2000', 'wall street', 'vix',
      'stock', 'stock market', 'equity', 'equities', 'shares', 'share buyback',
      'earnings', 'ipo', 'nyse', 'spx',
      // ticker futures indeks (rilis CFTC positioning FJ) + order-flow close NYSE.
      // 'es' bare terlalu ambigu → hanya sebagai frasa 'es cftc'.
      'nq', 'ym', 'rty', 'es cftc', 'e-mini*', 'moc', 'moc imbalance', 'market wrap',
      'nvda', 'nvidia', 'apple', 'tesla', 'meta', 'alphabet', 'microsoft',
      'amazon', 'samsung', 'tsmc',
    ],
    'commodities': [
      'gold', 'bullion', 'silver', 'copper', 'wheat', 'corn', 'soybean',
      'coffee', 'cocoa', 'cotton', 'lumber', 'palladium', 'platinum',
      'xau', 'xag', 'commodity', 'zinc', 'nickel', 'iron ore', 'steel', 'alumin*',
      'sugar', 'oats', 'cattle', 'hogs',
    ],
    'energy': [
      'oil', 'crude', 'brent', 'wti', 'opec', 'opec+', 'gasoline', 'diesel',
      'natural gas', 'barrel', 'petroleum', 'hormuz', 'strait of hormuz',
      'iea', 'tanker', 'refiner*', 'pipeline', 'lng', 'energy price*', 'fuel',
      'shale', 'rig count', 'baker hughes', 'heating oil', 'aramco', 'natgas',
      'crude inventories', 'gasoline inventories', 'oil depot*',
    ],
    'bonds': [
      'bond', 'yield', 'treasury', 'gilt', 'bund', 't-note', 'jgb', 'btp',
      '10-year', '2-year', '30-year', 'fixed income', 'debt', 'sovereign', 'auction',
      'fitch', "moody's", 'credit rating*', 'sovereign rating*',
      // ticker futures Treasury CME (rilis CFTC positioning FJ)
      'zn', 'zt', 'zb', 'zf',
    ],
    'crypto': [
      'bitcoin', 'btc', 'ethereum', 'eth', 'crypto*', 'blockchain', 'coinbase',
      'binance', 'stablecoin', 'defi', 'nft', 'altcoin', 'ripple', 'xrp', 'solana',
    ],
    'indexes': ['composite index'],
    'macro': [
      // Fed & pejabat
      'fed', 'fomc', 'powell', 'goolsbee', 'waller', 'kashkari', 'warsh',
      'federal reserve', 'fed minutes', 'dot plot', 'beige book',
      // bank sentral lain & pejabatnya
      'ecb', 'european central bank', 'lagarde',
      'boe', 'bank of england', 'bailey',
      'boj', 'bank of japan', 'ueda',
      'pboc', "people's bank of china",
      'rba', 'bullock', 'rbnz', 'orr', 'snb', 'schlegel',
      'boc', 'bank of canada', 'macklem',
      'norges bank', 'riksbank', 'rbi', 'bundesbank',
      'central bank*', 'monetary policy',
      // keputusan & sinyal suku bunga
      'rate cut', 'rate hike', 'cut rates', 'hike rates', 'raise rates',
      'lower rates', 'rate decision', 'rate hold', 'rate pause',
      'interest rate*', 'policy rate', 'benchmark rate',
      'quantitative easing', 'quantitative tightening', 'qe', 'qt', 'ycc',
      'yield curve', 'hawkish', 'dovish', 'stimulus',
      // institusi & fiskal
      'imf', 'world bank', 'g7', 'g20', 'recession',
      'debt ceiling', 'government shutdown',
      // pejabat fiskal — 'treasury secretary' bobot 2 supaya menang atas
      // 'treasury' (1, bonds): "Treasury Secretary Bessent says…" itu macro
      'treasury secretary', 'bessent', 'finance minister*',
    ],
    'econ-data': [
      'actual', 'forecast', 'previous',
      'cpi', 'pce', 'ppi', 'nfp', 'nonfarm', 'gdp', 'gdpnow',
      'core cpi', 'core pce', 'flash cpi', 'flash gdp', 'producer price*',
      'pmi', 'ism', 'caixin', 'ifo', 'zew', 'gfk', 'tankan',
      'flash pmi', 'manufacturing pmi', 'services pmi', 'composite pmi',
      'chicago pmi', 'ism manufacturing', 'ism services',
      'unemployment', 'payroll*', 'jolts', 'job openings', 'adp',
      'jobless claims', 'initial claims', 'continuing claims', 'claimant count',
      'employment change', 'wage growth', 'inflation rate',
      'retail sales', 'trade balance', 'current account',
      'consumer confidence', 'business confidence', 'consumer sentiment',
      'michigan sentiment', 'industrial production', 'capacity utilization',
      'factory orders', 'durable goods', 'wholesale price*',
      'housing', 'housing starts', 'building permits', 'home sales',
      'existing home sales', 'new home sales', 'jobs report',
      'philly fed', 'empire state', 'budget deficit', 'fiscal deficit',
      'nab business', 'westpac',
    ],
    'geopolitical': [
      'iran*', 'tehran', 'khamenei', 'irgc', 'revolutionary guard*',
      'nuclear', 'ceasefire', 'hezbollah', 'houthi*', 'hamas',
      'israel*', 'netanyahu', 'idf', 'lebanon', 'gaza', 'red sea', 'middle east',
      // Teluk & sekitarnya — dominan konteks konflik/diplomasi di feed FJ
      // (audit session 158 lanj.4); headline minyaknya tetap ke energy karena
      // keyword energy (oil/opec/aramco/hormuz) menang skor/urutan.
      'saudi*', 'riyadh', 'kuwait*', 'qatar*', 'doha', 'bahrain*', 'oman*',
      'uae', 'abu dhabi', 'yemen', 'syria*', 'iraq*', 'afghanistan', 'libya*',
      'turkey', 'turkish', 'erdogan', 'ankara', 'pakistan*', 'mexico*',
      'russia*', 'moscow', 'kremlin', 'putin', 'lavrov', 'peskov',
      'ukrain*', 'zelensk*', 'kyiv',
      'china', 'chinese', 'beijing', 'xi jinping', 'taiwan',
      'korea*', 'north korea', 'kim jong un', 'pyongyang',
      'sanction*', 'tariff*', 'trade war', 'trade deal', 'trade tension*',
      'trade pact*', 'trade talk*', 'embargo', 'export ban', 'retaliat*',
      'trump', 'vance', 'white house', 'pentagon', 'nato',
      'state department', 'state dept', 'rubio', 'secretary of state',
      'commerce secretary', 'lutnick', 'ustr', 'trade representative',
      'dhs', 'homeland security', 'national intelligence',
      'united nations', 'security council',
      'foreign minister*', 'foreign ministry', 'interior ministry',
      'defense*', 'defence*', 'prime minister*', 'parliament*',
      'senate', 'congress',
      // insiden militer/maritim (banyak headline UKMTO/Centcom tanpa nama negara)
      'military', 'centcom', 'central command', 'ukmto', 'armed forces',
      'navy', 'naval', 'warship*', 'vessel*', 'container ship*', 'airspace',
      'air defense*', 'air defence*', 'siren*', 'hostile', 'intercept*',
      'explosion*', 'blast*', 'security alert*',
      'war', 'invasion', 'airstrike*', 'missile*', 'drone*',
      'military strike*', 'retaliatory strike*', 'strikes on', 'strike on',
      'election*', 'referendum', 'coup', 'diplomat*',
    ],
  };

  const MM_COMPILED = compileList(MARKET_MOVING_MARKERS);
  const CAT_COMPILED = Object.keys(CATS).map(cat => ({ cat: cat, compiled: compileList(CATS[cat]) }));

  // Fallback default 'macro' — sama dengan perilaku lama, dan cocok dengan set
  // chip filter UI yang tidak punya kategori "other".
  function detectCat(title) {
    const t = normalize(title);
    if (!t) return 'macro';
    if (isCalendarRelease(t)) return 'econ-data';
    if (anyMatch(t, MM_COMPILED)) return 'market-moving';
    let best = null, bestScore = 0;
    for (const entry of CAT_COMPILED) {
      const s = score(t, entry.compiled);
      if (s > bestScore) { best = entry.cat; bestScore = s; }
    }
    return best || 'macro';
  }

  return {
    VERSION: VERSION,
    normalize: normalize,
    compileKeyword: compileKeyword,
    compileList: compileList,
    anyMatch: anyMatch,
    score: score,
    isCalendarRelease: isCalendarRelease,
    detectCat: detectCat,
    CATS: CATS,
    MARKET_MOVING_MARKERS: MARKET_MOVING_MARKERS,
  };
});
