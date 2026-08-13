// test/feeds/feeds_rss_filter.test.js
// Regresi 2026-08-13: judul auto-generated FinancialJuice "Currency Strength Chart:
// Strongest: GBP, USD, AUD, CAD, NZD, JPY, CHF, NZD - Weakest" (7 currency sekaligus
// diklaim "Strongest", currency "Weakest" kosong/terpotong) pernah dibaca mentah oleh
// AI Call 1 market-digest dan diparafrasekan jadi narasi kontradiktif (USD disebut
// melemah SEKALIGUS masuk daftar "currency terkuat"). User tidak menganggap info
// "currency strength board" ini berguna sama sekali — headline jenis ini harus
// dibuang total sebelum sampai ke consumer manapun (live feed, tab NEWS, AI digest,
// auto-update fundamental, push notification).

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripBlockedHeadlines, parseRSSItems } = require('../../api/feeds.js');

const RSS_WRAPPER = items => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;

const BLOCKED_ITEM = `<item>
  <title>Currency Strength Chart: Strongest: GBP, USD, AUD, CAD, NZD, JPY, CHF, NZD - Weakest</title>
  <guid>9717574</guid>
  <pubDate>Wed, 12 Aug 2026 07:01:03 GMT</pubDate>
  <link>https://www.financialjuice.com/News/9717574/x.aspx</link>
</item>`;

const NORMAL_ITEM = `<item>
  <title><![CDATA[US Core CPI MoM Actual 0.2% (Forecast 0.2%, Previous 0.0%)]]></title>
  <guid>9718023</guid>
  <pubDate>Wed, 12 Aug 2026 12:30:04 GMT</pubDate>
  <link>https://www.financialjuice.com/News/9718023/x.aspx</link>
</item>`;

test('stripBlockedHeadlines: buang item "Currency Strength Chart" dari XML mentah, sisakan item lain', () => {
  const xml = RSS_WRAPPER(BLOCKED_ITEM + NORMAL_ITEM);
  const cleaned = stripBlockedHeadlines(xml);
  assert.equal(/currency strength chart/i.test(cleaned), false);
  assert.equal(cleaned.includes('9718023'), true);
});

test('stripBlockedHeadlines: case-insensitive dan tetap valid kalau tidak ada item terblokir', () => {
  const xml = RSS_WRAPPER(NORMAL_ITEM);
  const cleaned = stripBlockedHeadlines(xml);
  assert.equal(cleaned, xml);
});

test('stripBlockedHeadlines -> parseRSSItems: headline terblokir tidak pernah masuk daftar item (jadi tidak ikut ke news_history/AI)', () => {
  const xml = RSS_WRAPPER(BLOCKED_ITEM + NORMAL_ITEM);
  const items = parseRSSItems(stripBlockedHeadlines(xml));
  assert.equal(items.length, 1);
  assert.equal(items[0].guid, '9718023');
});
