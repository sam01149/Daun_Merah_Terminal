// test/feeds/feeds_research.test.js
// Riset akademik (NBER/RePEc-IFN/Scopus) dicampur ke type=research yang sudah ada
// (2026-08-15, rapat konsep di daun_merah_plan.md § lama — lihat daun_merah.md untuk
// changelog eksekusi). Fokus test: (1) filter relevansi NBER benar-benar membuang
// paper non-FX, (2) parser RePEc-IFN (format RDF, beda dari RSS 2.0 biasa) jalan,
// (3) Scopus TIDAK PERNAH membaca/menampilkan field abstrak apa pun (batas ToS).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNBERItems,
  parseRePEcIfnItems,
  parseScopusEntries,
  RESEARCH_RELEVANCE_RE,
} = require('../../api/feeds.js');

// ── NBER ────────────────────────────────────────────────────────────────────

const NBER_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"><channel>
<item>
<title>Exchange Rate Pass-Through and Monetary Policy Credibility -- by Jane Doe, John Smith</title>
<description>We study how central bank credibility affects exchange rate pass-through to import prices.</description>
<link>https://www.nber.org/papers/w99991#fromrss</link>
<guid>https://www.nber.org/papers/w99991#fromrss</guid>
</item>
<item>
<title>Fortunate Sons: Elite Political Selection in American History -- by A. Author</title>
<description>We trace the family origins of Members of Congress born between 1830 and 1950.</description>
<link>https://www.nber.org/papers/w35569#fromrss</link>
<guid>https://www.nber.org/papers/w35569#fromrss</guid>
</item>
</channel></rss>`;

test('parseNBERItems: paper FX-relevan lolos, paper tak-relevan (politik) dibuang', () => {
  const items = parseNBERItems(NBER_XML, Date.parse('2026-08-15T12:00:00Z'));
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'NBER');
  assert.match(items[0].title, /Exchange Rate Pass-Through/);
});

test('parseNBERItems: suffix "-- by <penulis>" dipangkas dari judul', () => {
  const items = parseNBERItems(NBER_XML, Date.now());
  assert.equal(items[0].title.includes('-- by'), false);
  assert.equal(items[0].title, 'Exchange Rate Pass-Through and Monetary Policy Credibility');
});

test('parseNBERItems: fragment #fromrss dibuang dari link, pubDate pakai waktu fetch (feed tanpa pubDate per-item)', () => {
  const fetchedAt = Date.parse('2026-08-15T12:00:00Z');
  const items = parseNBERItems(NBER_XML, fetchedAt);
  assert.equal(items[0].link, 'https://www.nber.org/papers/w99991');
  assert.equal(new Date(items[0].pubDate).getTime(), fetchedAt);
});

// ── RePEc-IFN (RDF/RSS 1.0 — tag berprefiks rss:) ─────────────────────────────

const REPEC_XML = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rss="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<rss:channel rdf:about="http://lists.repec.org/mailman/listinfo/nep-ifn">
<rss:title>International Finance</rss:title>
<dc:date>2026-08-10</dc:date>
</rss:channel>
<rss:item rdf:about="https://d.repec.org/n?u=RePEc:aoz:wpaper:402">
<rss:title>Global Banks' Leverage and Global Liquidity</rss:title>
<rss:link>https://d.repec.org/n?u=RePEc:aoz:wpaper:402</rss:link>
<rss:description>This paper studies the role of global banks as a source of shocks to global liquidity.</rss:description>
</rss:item>
</rdf:RDF>`;

test('parseRePEcIfnItems: parse format RDF (rss:item), title+link terambil', () => {
  const items = parseRePEcIfnItems(REPEC_XML);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'RePEc-IFN');
  assert.equal(items[0].title, "Global Banks' Leverage and Global Liquidity");
  assert.equal(items[0].link, 'https://d.repec.org/n?u=RePEc:aoz:wpaper:402');
});

test('parseRePEcIfnItems: entity &amp; di link didecode (bug live 2026-08-15: link mentah RePEc selalu berisi &amp;r=...&amp;r=ifn, tanpa decode jadi rusak/double-escape saat dirender)', () => {
  const withAmp = REPEC_XML.replace(
    '<rss:link>https://d.repec.org/n?u=RePEc:aoz:wpaper:402</rss:link>',
    '<rss:link>https://d.repec.org/n?u=RePEc:aoz:wpaper:402&amp;r=&amp;r=ifn</rss:link>'
  );
  const items = parseRePEcIfnItems(withAmp);
  assert.equal(items[0].link, 'https://d.repec.org/n?u=RePEc:aoz:wpaper:402&r=&r=ifn');
});

test('parseRePEcIfnItems: pubDate dari <dc:date> level channel (tanggal edisi mingguan asli)', () => {
  const items = parseRePEcIfnItems(REPEC_XML);
  assert.equal(new Date(items[0].pubDate).toISOString().slice(0, 10), '2026-08-10');
});

test('parseRePEcIfnItems: XML tanpa <dc:date> tetap tidak crash, fallback waktu sekarang', () => {
  const noDate = REPEC_XML.replace(/<dc:date>[^<]+<\/dc:date>/, '');
  const items = parseRePEcIfnItems(noDate);
  assert.equal(items.length, 1);
  assert.equal(isNaN(new Date(items[0].pubDate).getTime()), false);
});

// ── Scopus — batas ToS: field abstrak TIDAK PERNAH boleh sampai ke output ────

function fakeScopusJson(entry) {
  return { 'search-results': { entry: [entry] } };
}

test('parseScopusEntries: judul digabung penulis+jurnal ala kartu rujukan, tanpa abstrak', () => {
  const json = fakeScopusJson({
    'dc:title': 'Investigation of Swedish Krona exchange rate volatility',
    'dc:creator': 'Karlsson H.K.',
    'prism:publicationName': 'Financial Innovation',
    'prism:coverDate': '2026-12-01',
    'prism:doi': '10.1186/s40854-026-00910-3',
    link: [{ '@ref': 'scopus', '@href': 'https://www.scopus.com/inward/record.uri?scp=123' }],
    // Field abstrak HANDAINYA tersedia di response Elsevier — WAJIB tidak pernah
    // muncul di output, karena query produksi bahkan tidak memintanya sama sekali.
    'dc:description': 'RAHASIA: isi abstrak lengkap yang dilarang tampil publik oleh ToS Elsevier.',
  });
  const items = parseScopusEntries(json, 'Scopus-FX');
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Investigation of Swedish Krona exchange rate volatility — Karlsson H\.K\., Financial Innovation/);
  assert.equal(JSON.stringify(items[0]).includes('RAHASIA'), false);
});

test('parseScopusEntries: link scopus diutamakan, fallback ke DOI kalau tidak ada', () => {
  const withDoiOnly = fakeScopusJson({
    'dc:title': 'Paper Tanpa Link Scopus',
    'prism:doi': '10.1000/xyz123',
  });
  const items = parseScopusEntries(withDoiOnly, 'Scopus-FX');
  assert.equal(items[0].link, 'https://doi.org/10.1000/xyz123');
});

test('parseScopusEntries: openaccessFlag true ditandai "(Open Access)" di judul', () => {
  const json = fakeScopusJson({
    'dc:title': 'Paper Open Access',
    'dc:creator': 'Levantesi S.',
    'prism:publicationName': 'Journal X',
    openaccessFlag: true,
    link: [{ '@ref': 'scopus', '@href': 'https://www.scopus.com/inward/record.uri?scp=456' }],
  });
  const items = parseScopusEntries(json, 'Scopus-LLM');
  assert.match(items[0].title, /\(Open Access\)$/);
});

test('parseScopusEntries: prism:coverDate di masa depan (edisi cetak nominal) di-clamp ke sekarang, bukan dipakai mentah (bug live 2026-08-15: coverDate 2027-01-01 bikin item lolos dari respons Scopus tapi lenyap di filter anti-tanggal-masa-depan researchHandler)', () => {
  const futureDate = new Date(Date.now() + 200 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const json = fakeScopusJson({
    'dc:title': 'Paper Dengan Cover Date Masa Depan',
    'prism:coverDate': futureDate,
    link: [{ '@ref': 'scopus', '@href': 'https://www.scopus.com/inward/record.uri?scp=789' }],
  });
  const items = parseScopusEntries(json, 'Scopus-FX');
  assert.ok(new Date(items[0].pubDate).getTime() <= Date.now());
});

test('parseScopusEntries: entry tanpa judul ATAU tanpa link dibuang', () => {
  const json = fakeScopusJson({ 'dc:creator': 'Tanpa Judul' });
  const noLink = fakeScopusJson({ 'dc:title': 'Judul Tanpa Link Sama Sekali' });
  assert.equal(parseScopusEntries(json, 'Scopus-FX').length, 0);
  assert.equal(parseScopusEntries(noLink, 'Scopus-FX').length, 0);
});

// ── Filter relevansi (dipakai NBER) ───────────────────────────────────────────

test('RESEARCH_RELEVANCE_RE: cocok untuk topik FX/makro/LLM-trading', () => {
  assert.equal(RESEARCH_RELEVANCE_RE.test('Exchange rate volatility and central bank intervention'), true);
  assert.equal(RESEARCH_RELEVANCE_RE.test('A study of large language model reasoning'), true);
});

test('RESEARCH_RELEVANCE_RE: tidak cocok untuk topik tak-relevan (politik/pertanian)', () => {
  assert.equal(RESEARCH_RELEVANCE_RE.test('Elite Political Selection in American History'), false);
  assert.equal(RESEARCH_RELEVANCE_RE.test('Sri Lanka apparel sector lean manufacturing'), false);
});
