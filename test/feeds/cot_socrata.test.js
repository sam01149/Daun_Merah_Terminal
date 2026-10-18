const { test } = require('node:test');
const assert = require('node:assert');

const {
  _parseCotSocrataRows,
  _formatCotDates,
  _parseCotHtmlText,
  COT_SOCRATA_MARKETS,
} = require('../../api/feeds.js');

test('COT: _formatCotDates memformat ISO string ke Selasa & Jumat UTC', () => {
  const { reportDate, releaseDate } = _formatCotDates('2026-10-13T00:00:00.000');
  assert.strictEqual(reportDate, 'October 13, 2026');
  assert.strictEqual(releaseDate, 'October 16, 2026');

  // Input null atau tidak valid -> null
  assert.deepStrictEqual(_formatCotDates(null), { reportDate: null, releaseDate: null });
  assert.deepStrictEqual(_formatCotDates(''), { reportDate: null, releaseDate: null });
  assert.deepStrictEqual(_formatCotDates('invalid-date'), { reportDate: null, releaseDate: null });
});

test('COT: _parseCotSocrataRows membaca baris Socrata ke posisi 8 mata uang', () => {
  const sampleRows = [
    {
      contract_market_name: 'EURO FX',
      report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000',
      open_interest_all: '1000000',
      asset_mgr_positions_long: '500000',
      asset_mgr_positions_short: '300000',
      lev_money_positions_long: '100000',
      lev_money_positions_short: '180000',
      change_in_asset_mgr_long: '-5000',
      change_in_asset_mgr_short: '-1000',
      change_in_lev_money_long: '1000',
      change_in_lev_money_short: '5000',
      pct_of_oi_asset_mgr_long: '50.0',
      pct_of_oi_asset_mgr_short: '30.0',
      pct_of_oi_lev_money_long: '10.0',
      pct_of_oi_lev_money_short: '18.0',
    },
    {
      contract_market_name: 'USD INDEX',
      report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000',
      open_interest_all: '50000',
      asset_mgr_positions_long: '20000',
      asset_mgr_positions_short: '2000',
      lev_money_positions_long: '19000',
      lev_money_positions_short: '16000',
      change_in_asset_mgr_long: '-2000',
      change_in_asset_mgr_short: '-1000',
      change_in_lev_money_long: '3000',
      change_in_lev_money_short: '2000',
      pct_of_oi_asset_mgr_long: '40.0',
      pct_of_oi_asset_mgr_short: '4.0',
      pct_of_oi_lev_money_long: '38.0',
      pct_of_oi_lev_money_short: '32.0',
    },
  ];

  const res = _parseCotSocrataRows(sampleRows);
  assert.ok(res);
  assert.strictEqual(res.reportDate, 'October 13, 2026');
  assert.strictEqual(res.releaseDate, 'October 16, 2026');

  const eur = res.positions.EUR;
  assert.ok(eur);
  assert.strictEqual(eur.am_long, 500000);
  assert.strictEqual(eur.am_short, 300000);
  assert.strictEqual(eur.am_net, 200000);
  assert.strictEqual(eur.am_change_net, -4000);
  assert.strictEqual(eur.lev_long, 100000);
  assert.strictEqual(eur.lev_short, 180000);
  assert.strictEqual(eur.lev_net, -80000);
  assert.strictEqual(eur.lev_change_net, -4000);
  assert.strictEqual(eur.oi, 1000000);
  assert.strictEqual(eur.am_net_pct_oi, 20.0);
  assert.strictEqual(eur.lev_net_pct_oi, -8.0);

  const usd = res.positions.USD;
  assert.ok(usd);
  assert.strictEqual(usd.am_net, 18000);
  assert.strictEqual(usd.lev_net, 3000);
  assert.strictEqual(usd.am_net_pct_oi, 36.0);
  assert.strictEqual(usd.lev_net_pct_oi, 6.0);
});

test('COT: _parseCotSocrataRows mengabaikan baris tanggal lama jika ada baris lebih baru', () => {
  const mixedRows = [
    {
      contract_market_name: 'EURO FX',
      report_date_as_yyyy_mm_dd: '2026-10-06T00:00:00.000', // lama
      open_interest_all: '900000',
      asset_mgr_positions_long: '450000',
      asset_mgr_positions_short: '290000',
      lev_money_positions_long: '95000',
      lev_money_positions_short: '175000',
    },
    {
      contract_market_name: 'EURO FX',
      report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000', // terbaru
      open_interest_all: '1000000',
      asset_mgr_positions_long: '500000',
      asset_mgr_positions_short: '300000',
      lev_money_positions_long: '100000',
      lev_money_positions_short: '180000',
    },
  ];

  const res = _parseCotSocrataRows(mixedRows);
  assert.strictEqual(res.reportDate, 'October 13, 2026');
  assert.strictEqual(res.positions.EUR.oi, 1000000);
});

test('COT: _parseCotSocrataRows null pada input kosong / cacat', () => {
  assert.strictEqual(_parseCotSocrataRows([]), null);
  assert.strictEqual(_parseCotSocrataRows(null), null);
  assert.strictEqual(_parseCotSocrataRows([{ no_date: 1 }]), null);
});
