// api/_cb_keywords.js — shared central-bank keyword map, dipakai market-digest.js
// (Call 2 CB bias scoping) DAN feeds.js (storeNewsHistory: nentuin headline mana
// yang layak simpan <description>-nya, bukan cuma title). Dipisah ke sini biar
// dua sisi ini nggak drift kalau salah satu di-update tanpa yang lain.

const CB_KW = {
  USD: ['fed','fomc','powell','goolsbee','waller','kashkari','warsh','federal reserve','us inflation','us gdp','us jobs','nfp','us cpi'],
  EUR: ['ecb','lagarde','lane','schnabel','euro zone','eurozone','euro area','eu inflation','eu gdp'],
  GBP: ['boe','bank of england','bailey','pill','gbp','sterling','uk inflation','uk gdp','uk jobs','claimant'],
  JPY: ['boj','bank of japan','ueda','japan inflation','japan gdp','yen','japanese'],
  CAD: ['boc','bank of canada','macklem','canada inflation','canada gdp','canadian'],
  AUD: ['rba','reserve bank of australia','bullock','australia inflation','australia gdp','aussie'],
  NZD: ['rbnz','reserve bank of new zealand','orr','new zealand inflation','new zealand gdp','kiwi'],
  CHF: ['snb','swiss national bank','schlegel','switzerland','swiss franc','franc'],
};

// Word-boundary match: single words use \b..\b so 'orr' won't match 'worrying',
// 'boc' won't match 'pboc', 'lane' won't match 'plane', etc.
// Phrases (containing space) keep simple includes since boundaries don't apply.
const kwTest = (title, kw) => kw.includes(' ')
  ? title.includes(kw)
  : new RegExp('\\b' + kw + '\\b').test(title);

const isCbHeadline = title => {
  const lower = title.toLowerCase();
  return Object.values(CB_KW).some(kws => kws.some(kw => kwTest(lower, kw)));
};

// RSS <description> can carry raw HTML (the option-expiry post structures its body as
// <li><strong>PAIR:</strong> ...</li> — that consumer parses the tags directly and must
// receive the untouched string). CB bias evidence just needs readable text, so callers
// that feed a description to the AI prompt or render it in the UI should strip it first.
const stripHtml = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

module.exports = { CB_KW, kwTest, isCbHeadline, stripHtml };
