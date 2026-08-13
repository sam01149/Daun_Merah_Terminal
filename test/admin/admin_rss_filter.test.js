// test/admin/admin_rss_filter.test.js
// Regresi 2026-08-13: sama seperti test/feeds/feeds_rss_filter.test.js, tapi untuk
// dua parser RSS admin.js yang fetch FinancialJuice LANGSUNG (bukan lewat
// /api/feeds?type=rss), jadi filter di feeds.js:stripBlockedHeadlines tidak
// menjangkau jalur ini — parseRSSHeadlines (auto-update fundamental) dan
// parsePushRSS (push notification browser) butuh filter sendiri.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRSSHeadlines, parsePushRSS } = require('../../api/admin.js');

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

test('parseRSSHeadlines: headline "Currency Strength Chart" tidak masuk daftar (tidak ikut auto-update fundamental)', () => {
  const items = parseRSSHeadlines(RSS_WRAPPER(BLOCKED_ITEM + NORMAL_ITEM));
  assert.equal(items.length, 1);
  assert.equal(items[0].guid, '9718023');
});

test('parsePushRSS: headline "Currency Strength Chart" tidak masuk daftar (tidak ikut trigger push notification)', () => {
  const items = parsePushRSS(RSS_WRAPPER(BLOCKED_ITEM + NORMAL_ITEM));
  assert.equal(items.length, 1);
  assert.equal(items[0].guid, '9718023');
});
