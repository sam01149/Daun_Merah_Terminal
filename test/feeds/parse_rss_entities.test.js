// test/parse_rss_entities.test.js
// Bug report (session 162): headline "Top S&P 500 Stock Names Implied Volatility"
// tampil literal sebagai "Top S&amp;P 500 Stock Names Implied Volatility" di tab
// NEWS. Root cause: RSS <title> sudah XML-escaped di feed asal ("&amp;" untuk "&"
// literal), tapi parseRSSItems() cuma extract teksnya mentah tanpa decode — jadi
// title yang tersimpan JS-nya literal mengandung "&amp;". escHtml() di render time
// meng-escape "&" yang tersisa itu SEKALI LAGI ("&amp;amp;"), yang browser render
// sebagai teks "&amp;" — bukan gambar yang hilang, murni double-escape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRSSItems } = require('../../api/feeds.js');

function fixtureItem({ title, guid, pubDate }) {
  return `<item><title>${title}</title><guid>${guid}</guid><pubDate>${pubDate}</pubDate><link>https://example.com/${guid}</link></item>`;
}

test('parseRSSItems: &amp; di title RSS didecode jadi & literal (bug S&P)', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'Top S&amp;P 500 Stock Names Implied Volatility',
    guid: '1', pubDate: 'Sun, 13 Jul 2026 13:51:00 GMT',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Top S&P 500 Stock Names Implied Volatility');
});

test('parseRSSItems: &lt; &gt; &quot; &#39; &nbsp; di title semua didecode', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'A &lt;tag&gt; and &quot;quotes&quot; and it&#39;s&nbsp;fine',
    guid: '2', pubDate: 'Sun, 13 Jul 2026 13:51:00 GMT',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items[0].title, 'A <tag> and "quotes" and it\'s fine');
});

test('parseRSSItems: entitas numerik desimal/hex (mis. kutip melengkung) didecode', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'Fed&#8217;s decision &#x2013; a surprise',
    guid: '3', pubDate: 'Sun, 13 Jul 2026 13:51:00 GMT',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items[0].title, 'Fed’s decision – a surprise');
});

test('parseRSSItems: title tanpa entitas tidak berubah', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'Plain headline with no entities',
    guid: '4', pubDate: 'Sun, 13 Jul 2026 13:51:00 GMT',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items[0].title, 'Plain headline with no entities');
});

test('parseRSSItems: FinancialJuice prefix tetap dibuang setelah decode', () => {
  const xml = `<rss><channel>${fixtureItem({
    title: 'FinancialJuice: AT&amp;T announces buyback',
    guid: '5', pubDate: 'Sun, 13 Jul 2026 13:51:00 GMT',
  })}</channel></rss>`;
  const items = parseRSSItems(xml);
  assert.equal(items[0].title, 'AT&T announces buyback');
});
