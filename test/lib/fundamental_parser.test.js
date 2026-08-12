// test/fundamental_parser.test.js
// Unit test parser murni — jalankan: npm test (node --test, tanpa network/Redis)
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseFundamentalFromHeadline, parseCBDecision, autoUpdateFundamentals,
  extractFundamentalFromCalendarEvent, autoUpdateFundamentalsFromCalendar,
  reconcileFundamentalKeys,
} = require('../../api/_fundamental_parser');

// ── parseFundamentalFromHeadline ────────────────────────────────────────────

test('format FinancialJuice standar: US CPI YoY', () => {
  const r = parseFundamentalFromHeadline('US CPI YoY: Actual 3.2% Forecast 3.1% Previous 3.4%');
  assert.deepStrictEqual(r, { currency: 'USD', key: 'CPI YoY', value: '3.2%', previous: '3.4%', forecast: '3.1%' });
});

// Audit 2026-08-12 (respons user "apa lagi yang bisa diperluas"): forecast
// (ekspektasi konsensus pasar) sudah lama dipakai buat DETEKSI format rilis
// kalender (isCalendarFormat) tapi nilainya sendiri tidak pernah diekstrak —
// AI cuma tahu actual vs previous, tidak pernah tahu beat/miss vs ekspektasi pasar.
test('forecast diekstrak terpisah dari previous', () => {
  const r = parseFundamentalFromHeadline('UK GDP MoM Actual 0.3% Forecast 0.1% Previous 0.1%');
  assert.strictEqual(r.value, '0.3%');
  assert.strictEqual(r.forecast, '0.1%');
  assert.strictEqual(r.previous, '0.1%');
});

test('headline tanpa Forecast -> field forecast null (tidak crash)', () => {
  const r = parseFundamentalFromHeadline('US NFP: Actual 175K Previous 227K');
  assert.strictEqual(r.forecast, null);
});

test('NFP dengan nilai K (count) diterima', () => {
  const r = parseFundamentalFromHeadline('US NFP: Actual 175K Forecast 180K Previous 227K');
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.key, 'NFP');
  assert.strictEqual(r.value, '175K');
  assert.strictEqual(r.previous, '227K');
});

test('NFP dengan nilai % ditolak (QUANTITY_INDICATORS guard)', () => {
  const r = parseFundamentalFromHeadline('US NFP: Actual 0.0% Forecast 180K');
  assert.strictEqual(r, null);
});

test('Core PCE y/y disimpan sebagai key terpisah (tidak overwrite MoM)', () => {
  const r = parseFundamentalFromHeadline('US Core PCE y/y: Actual 2.8% Previous 2.9%');
  assert.strictEqual(r.key, 'Core PCE YoY');
});

test('Core PCE m/m tetap key Core PCE (cocok seed)', () => {
  const r = parseFundamentalFromHeadline('US Core PCE m/m: Actual 0.3% Previous 0.2%');
  assert.strictEqual(r.key, 'Core PCE');
});

test('kata sisipan Core: fallback country-only saat format kalender', () => {
  const r = parseFundamentalFromHeadline('Eurozone Core CPI YoY: Actual 2.9% Forecast 2.8% Previous 3.0%');
  assert.strictEqual(r.currency, 'EUR');
  assert.strictEqual(r.key, 'Core CPI YoY');
  assert.strictEqual(r.value, '2.9%');
});

test('qualifier Flash di akhir judul redirect ke key CPI Flash YoY', () => {
  const r = parseFundamentalFromHeadline('Eurozone CPI YoY Flash: Actual 2.4% Previous 2.2%');
  assert.strictEqual(r.key, 'CPI Flash YoY');
});

// Bug 2026-08-11 (laporan user): headline FJ "US ADP Wkly Employment Change" —
// qualifier "Wkly" nempel di TENGAH judul (ADP [Wkly] Employment Change), beda
// posisi dari versi calendar_v1 (lihat test extractFundamentalFromCalendarEvent
// di bawah) — kedua bentuk harus tetap ke-redirect, bukan cuma satu.
test('ADP Wkly Employment Change (headline FJ, qualifier di tengah) redirect ke key ADP Employment Weekly, tidak menimpa rilis bulanan resmi', () => {
  const r = parseFundamentalFromHeadline('US ADP Wkly Employment Change Actual 8.25K Previous 15K');
  assert.strictEqual(r.key, 'ADP Employment Weekly');
});

// Regresi bug 2026-08-10 (laporan user — AUD "Retail Sales" + "CPI QoQ" tak pernah
// terverifikasi): headline literal "CPI QoQ" (bukan "CPI Q/Q"/"CPI QQ") gagal match
// keyword FUND_INDICATOR_MAP, jatuh ke fallback tebak-key title-case naif yang
// merusak akronim jadi "Cpi Qoq" — bikin duplikat key beda casing dari "CPI QoQ"
// kanonik, jadi seed lama permanen tidak pernah ke-update walau data barunya
// sebenarnya sudah masuk (cuma nyasar ke key yang salah).
test('Australia CPI QoQ (ejaan "qoq" tanpa slash) match langsung ke key kanonik "CPI QoQ"', () => {
  const r = parseFundamentalFromHeadline('Australia CPI QoQ: Actual 0.6% Forecast 0.5% Previous 1.4%');
  assert.strictEqual(r.currency, 'AUD');
  assert.strictEqual(r.key, 'CPI QoQ');
  assert.strictEqual(r.value, '0.6%');
});

test('fallback tebak-key: kalau tebakan title-case kebetulan cocok key kanonik (case-insensitive), pakai casing kanonik bukan tebakan mentah', () => {
  // Indikator fiktif yang sengaja tidak ada di FUND_INDICATOR_MAP -> tetap dari tebakan mentah (tidak ada acuan kanonik).
  const r = parseFundamentalFromHeadline('Australia Made Up Indicator: Actual 1.0% Forecast 0.9% Previous 0.8%');
  assert.strictEqual(r.key, 'Made Up Indicator');
});

// AUD "Retail Sales MoM" diganti "Household Spending MoM" 2026-08-10 (ABS
// menghentikan Retail Trade sejak Juni 2025) — lihat daun_merah.md Session 298 lanjutan.
test('Australia Household Spending MoM (pengganti Retail Sales yang dihentikan ABS) match key baru', () => {
  const r = parseFundamentalFromHeadline('Australia Household Spending MoM: Actual 0.8% Forecast 0.4% Previous 1.2%');
  assert.strictEqual(r.currency, 'AUD');
  assert.strictEqual(r.key, 'Household Spending MoM');
  assert.strictEqual(r.value, '0.8%');
});

test('headline non-fundamental (tanpa currency match) → null', () => {
  assert.strictEqual(parseFundamentalFromHeadline('Gold rises above 2700 as dollar weakens'), null);
});

test('headline tanpa angka → null', () => {
  assert.strictEqual(parseFundamentalFromHeadline('US CPI data due later today'), null);
});

// Regresi bug 2026-07-30: "French Non-Farm Payrolls QoQ" salah ditandai USD
// karena FUND_PREFIX_MAP cek keyword bare 'non-farm payroll' (USD) duluan sebelum
// nama negara eksplisit "French" sempat dicek — kejadian live di produksi (redis
// fundamental:USD.NFP ketimpa "-0.1" tertanggal hari ini walau tak ada di kalender).
test('French Non-Farm Payrolls tidak ketimpa ke NFP (USD) — currency EUR, key terpisah', () => {
  const r = parseFundamentalFromHeadline('French Non-Farm Payrolls QoQ Actual -0.1 (Forecast -0.1, Previous -)');
  assert.strictEqual(r.currency, 'EUR');
  assert.strictEqual(r.key, 'Non-Farm Payrolls QoQ');
  assert.strictEqual(r.value, '-0.1');
});

// Bug sama juga berpotensi kena indikator "bare" lain di FUND_PREFIX_MAP yang
// tidak diprefix "us " (mis. 'personal spending') — kalau negara lain kebetulan
// disebut eksplisit di headline yang sama, harus menang atas keyword bare USD.
test('Japan Personal Spending tidak ketimpa ke USD', () => {
  const r = parseFundamentalFromHeadline('Japan Personal Spending y/y Actual 1.2% Forecast 0.9% Previous 0.5%');
  assert.strictEqual(r.currency, 'JPY');
});

test('US NFP tanpa prefix negara tetap default USD (tidak diregresi oleh fix di atas)', () => {
  const r = parseFundamentalFromHeadline('Non-Farm Payrolls Actual 175K Forecast 180K Previous 227K');
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.key, 'NFP');
  assert.strictEqual(r.value, '175K');
});

test('judul umum yang cuma menyebut nama negara (bukan format rilis) tetap null', () => {
  assert.strictEqual(parseFundamentalFromHeadline('UK stocks rally as BoE hints at cuts'), null);
});

// Regresi bug 2026-07-30 (kejadian live kedua): artikel PROSA (bukan cetakan rilis
// kalender, tanpa kata "Actual") kebetulan menyebut frasa bare USD 'consumer
// spending' → sebelum fix, lolos ke fallback angka-pertama-di-judul dan ketimpa
// jadi 'Personal Spending' USD tertanggal hari ini, padahal ini data Prancis (INSEE).
test('artikel prosa tanpa kata Actual (bukan rilis kalender) → null walau ada keyword bare', () => {
  const r = parseFundamentalFromHeadline('French June consumer spending rises 0.4% m/m vs forecast -0.1%, May revised up to 0.3%: INSEE');
  assert.strictEqual(r, null);
});

// Regresi Plan W-4 bug 1 (2026-08-03): keyword generic 'retail sales' (→ Retail
// Sales MoM) ada SEBELUM keyword spesifik 'retail sales yoy' di FUND_INDICATOR_MAP
// — loop match berhenti di entry pertama, jadi headline YoY apa pun (currency mana
// pun) selalu salah ke-tangkep sebagai MoM. Dites lewat JPY (kasus nyata yang
// ditemukan stuck permanen di produksi).
test('Retail Sales YoY tidak ketimpa jadi Retail Sales MoM (Plan W-4 bug 1)', () => {
  const r = parseFundamentalFromHeadline('Japan Retail Sales YoY Actual 2.0% Forecast 1.8% Previous 1.7%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.key, 'Retail Sales YoY');
});

test('Retail Sales MoM (tanpa YoY) tetap ke key MoM (regresi tidak boleh berubah)', () => {
  const r = parseFundamentalFromHeadline('UK Retail Sales Actual 0.7% Forecast 0.3% Previous -0.2%');
  assert.strictEqual(r.currency, 'GBP');
  assert.strictEqual(r.key, 'Retail Sales MoM');
});

// Pola bug yang sama ditemukan kedua kalinya di FUND_INDICATOR_MAP saat audit
// menyeluruh Plan W-4: keyword 'gdp advance'/'flash gdp' (→ GDP QoQ Flash) berada
// SETELAH catch-all bare 'gdp' — headline "GDP Advance" selalu ke-tangkep bare
// 'gdp' duluan, entry spesifik tidak pernah tercapai (dead code).
test('GDP Advance tidak ketimpa GDP QoQ biasa, masuk key GDP QoQ Flash (Plan W-4 audit)', () => {
  const r = parseFundamentalFromHeadline('US GDP Advance Actual 2.1% Forecast 1.9% Previous 2.0%');
  assert.strictEqual(r.key, 'GDP QoQ Flash');
});

// Regresi Plan W-4 bug 2 (2026-08-03): kode currency literal ("GBP") tidak dikenal
// FUND_COUNTRY_ONLY/FUND_PREFIX_MAP — cuma nama negara ("United Kingdom"/"British").
test('kode currency literal GBP dikenali (Plan W-4 bug 2)', () => {
  const r = parseFundamentalFromHeadline('GBP GDP MoM Actual 0.2% Forecast 0.1% Previous -0.1%');
  assert.strictEqual(r?.currency, 'GBP');
  assert.strictEqual(r?.key, 'GDP MoM');
});

// ── autoUpdateFundamentals: previous & date tidak boleh hilang di re-scan ──────

function makeMockRedis(initialHash) {
  const store = { ...initialHash };
  return async (...args) => {
    const [cmd] = args;
    if (cmd === 'HMGET') {
      const [, , ...keys] = args;
      return keys.map(k => store[k] ?? null);
    }
    if (cmd === 'HSET') {
      const [, , ...kv] = args;
      for (let i = 0; i < kv.length; i += 2) store[kv[i]] = kv[i + 1];
      return kv.length / 2;
    }
    if (cmd === 'HGET') return null;
    return null;
  };
}

test('re-scan headline identik tidak menghapus previous & tidak memajukan date', async () => {
  const seedDate = '2026-07-03';
  const redis = makeMockRedis({
    NFP: JSON.stringify({ actual: '206K', period: '—', date: seedDate, source: 'headline' }),
  });
  const headline = { title: 'US NFP: Actual 175K Forecast 180K Previous 206K' };

  await autoUpdateFundamentals([headline], redis);
  const afterFirst = JSON.parse((await redis('HMGET', 'fundamental:USD', 'NFP'))[0]);
  assert.strictEqual(afterFirst.actual, '175K');
  assert.strictEqual(afterFirst.previous, '206K');
  const firstDate = afterFirst.date;

  // Digest run kedua men-scan headline SAMA PERSIS lagi (masih di window 36h) —
  // sebelum fix, previous hilang & date maju ke hari ini walau bukan rilis baru.
  await autoUpdateFundamentals([headline], redis);
  const afterSecond = JSON.parse((await redis('HMGET', 'fundamental:USD', 'NFP'))[0]);
  assert.strictEqual(afterSecond.actual, '175K');
  assert.strictEqual(afterSecond.previous, '206K');
  assert.strictEqual(afterSecond.date, firstDate);
});

// Kasus persis kejadian produksi: headline TANPA angka "Previous" eksplisit
// (mis. "Previous -" seperti kasus French NFP) — sebelum fix, previous hilang
// total di scan kedua karena entry selalu dibangun dari objek kosong.
test('re-scan headline tanpa Previous eksplisit tetap pertahankan previous lama', async () => {
  const redis = makeMockRedis({
    'Non-Farm Payrolls QoQ': JSON.stringify({ actual: '-0.1', period: '—', date: '2026-07-30', source: 'headline', previous: '0.2' }),
  });
  const headline = { title: 'French Non-Farm Payrolls QoQ Actual -0.1 (Forecast -0.1, Previous -)' };

  // Nilai actual sama seperti seed → simulasikan digest run kedua men-scan
  // headline yang sama tanpa angka "Previous" yang bisa diekstrak.
  await autoUpdateFundamentals([headline], redis);
  const fr = JSON.parse((await redis('HMGET', 'fundamental:EUR', 'Non-Farm Payrolls QoQ'))[0]);
  assert.strictEqual(fr.actual, '-0.1');
  assert.strictEqual(fr.previous, '0.2');
});

// ── extractFundamentalFromCalendarEvent / autoUpdateFundamentalsFromCalendar ──
// Plan W-5 (2026-08-03): calendar_v1/calendar_next_v1 (TradingView) sebagai
// lapis tambahan yang dicoba DULU sebelum parsing headline FinancialJuice.

function calEvent(overrides) {
  return {
    date: '2026-08-03', time_wib: '14:00 WIB', currency: 'JPY',
    event: 'Retail Sales YoY', impact: 'High',
    forecast: '1.8%', previous: '1.7%', actual: '1.9%',
    ...overrides,
  };
}

test('extractFundamentalFromCalendarEvent: event terstruktur -> {currency,key,value,previous,forecast,date}', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent());
  assert.deepStrictEqual(r, { currency: 'JPY', key: 'Retail Sales YoY', value: '1.9%', previous: '1.7%', forecast: '1.8%', date: '2026-08-03' });
});

// Audit 2026-08-12: forecast (ekspektasi konsensus) sudah ada di calendar_v1
// (api/calendar.js) sejak lama tapi dibuang begitu saja — sekarang diteruskan.
test('extractFundamentalFromCalendarEvent: forecast kosong -> field forecast null', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ forecast: null }));
  assert.strictEqual(r.forecast, null);
});

test('extractFundamentalFromCalendarEvent: currency sudah kode ISO eksplisit, tidak perlu tebak dari nama negara', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ currency: 'USD', event: 'Non Farm Payrolls', actual: '180K', previous: '175K' }));
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.key, 'NFP');
});

test('extractFundamentalFromCalendarEvent: judul tidak dikenal FUND_INDICATOR_MAP -> null (TIDAK menebak key baru)', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ event: 'Some Totally Unknown Indicator XYZ', actual: '1.0%' }));
  assert.strictEqual(r, null);
});

test('extractFundamentalFromCalendarEvent: currency di luar 8 yang dicover -> null', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ currency: 'CNY' }));
  assert.strictEqual(r, null);
});

test('extractFundamentalFromCalendarEvent: actual belum keluar (null) -> null (rilis belum terjadi)', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ actual: null }));
  assert.strictEqual(r, null);
});

test('extractFundamentalFromCalendarEvent: date tidak valid -> null', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ date: 'Tentative' }));
  assert.strictEqual(r, null);
});

// Bug 2026-08-11 (laporan user): calendar_v1 menulis "ADP Employment Change
// Weekly" — qualifier di AKHIR judul (beda posisi dari headline FJ di atas) —
// tetap harus ke-redirect ke key terpisah, bukan menimpa 'ADP Employment' (rilis
// bulanan resmi, ADPMNUSNERSA).
test('extractFundamentalFromCalendarEvent: ADP Employment Change Weekly redirect ke key ADP Employment Weekly', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({
    currency: 'USD', event: 'ADP Employment Change Weekly', actual: '8.25K', previous: '15K',
  }));
  assert.strictEqual(r.key, 'ADP Employment Weekly');
});

test('extractFundamentalFromCalendarEvent: rilis bulanan resmi ADP Employment Change (tanpa qualifier weekly) tetap masuk key ADP Employment', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({
    currency: 'USD', event: 'ADP Employment Change', actual: '104K', previous: '62K',
  }));
  assert.strictEqual(r.key, 'ADP Employment');
});

test('extractFundamentalFromCalendarEvent: NFP dengan actual % (bukan K/M) ditolak (QUANTITY_INDICATORS guard)', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent({ currency: 'USD', event: 'Non Farm Payrolls', actual: '0.0%' }));
  assert.strictEqual(r, null);
});

test('extractFundamentalFromCalendarEvent: input null/rusak -> null, tidak crash', () => {
  assert.strictEqual(extractFundamentalFromCalendarEvent(null), null);
  assert.strictEqual(extractFundamentalFromCalendarEvent({}), null);
});

test('autoUpdateFundamentalsFromCalendar: HSET dengan source calendar, group per currency', async () => {
  const redis = makeMockRedis({});
  const events = [calEvent(), calEvent({ currency: 'USD', event: 'Non Farm Payrolls', actual: '180K', previous: '175K' })];
  const updated = await autoUpdateFundamentalsFromCalendar(events, redis);
  assert.deepStrictEqual(updated, { JPY: ['Retail Sales YoY'], USD: ['NFP'] });
  const jpy = JSON.parse((await redis('HMGET', 'fundamental:JPY', 'Retail Sales YoY'))[0]);
  assert.deepStrictEqual(jpy, { actual: '1.9%', period: '—', date: '2026-08-03', source: 'calendar', previous: '1.7%', forecast: '1.8%' });
});

test('autoUpdateFundamentalsFromCalendar: TIDAK mundur kalau entry existing sudah dari tanggal lebih baru', async () => {
  const redis = makeMockRedis({
    'Retail Sales YoY': JSON.stringify({ actual: '2.5%', period: '—', date: '2026-08-10', source: 'headline' }),
  });
  // calendar_v1 kebetulan serve cache basi minggu lalu (date 2026-08-03, lebih lama).
  const updated = await autoUpdateFundamentalsFromCalendar([calEvent({ date: '2026-08-03' })], redis);
  assert.deepStrictEqual(updated, {});
  const jpy = JSON.parse((await redis('HMGET', 'fundamental:JPY', 'Retail Sales YoY'))[0]);
  assert.strictEqual(jpy.actual, '2.5%', 'tidak boleh mundur ke nilai calendar yang lebih lama');
});

test('autoUpdateFundamentalsFromCalendar: array kosong/invalid -> {} tanpa crash', async () => {
  const redis = makeMockRedis({});
  assert.deepStrictEqual(await autoUpdateFundamentalsFromCalendar([], redis), {});
  assert.deepStrictEqual(await autoUpdateFundamentalsFromCalendar(null, redis), {});
});

// ── parseCBDecision ─────────────────────────────────────────────────────────

test('Fed cut 25 bps → bps negatif + rate absolut', () => {
  const r = parseCBDecision('Federal Reserve cuts rates by 25 bps to 4.25%');
  assert.deepStrictEqual(r, { currency: 'USD', rate: 4.25, bps: -25, decision: 'cut' });
});

test('ECB hike 25bps', () => {
  const r = parseCBDecision('European Central Bank raises deposit rate by 25bps to 2.25%');
  assert.strictEqual(r.currency, 'EUR');
  assert.strictEqual(r.decision, 'hike');
  assert.strictEqual(r.bps, 25);
  assert.strictEqual(r.rate, 2.25);
});

test('BoJ hold (unchanged) dengan rate absolut', () => {
  const r = parseCBDecision('Bank of Japan leaves policy rate unchanged at 0.5%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.decision, 'hold');
  assert.strictEqual(r.rate, 0.5);
});

test('bentuk present-tense "holds" terdeteksi (regresi bug \\bhold\\b)', () => {
  const r = parseCBDecision('Bank of Japan holds policy rate at 0.5%');
  assert.strictEqual(r?.decision, 'hold');
});

test('bentuk present-tense "hikes" terdeteksi (regresi bug \\bhike\\b)', () => {
  const r = parseCBDecision('Swiss National Bank hikes policy rate by 25 bps to 0.75%');
  assert.strictEqual(r?.currency, 'CHF');
  assert.strictEqual(r?.decision, 'hike');
  assert.strictEqual(r?.bps, 25);
});

test('headline data ekonomi biasa (bukan keputusan CB) → null', () => {
  assert.strictEqual(parseCBDecision('US inflation rate rises to 3% annually'), null);
});

test('keputusan tanpa angka rate/bps → null (tidak bisa dipakai)', () => {
  assert.strictEqual(parseCBDecision('Federal Reserve expected to cut rates next meeting'), null);
});

// ── Audit 2026-08-12 (laporan user: kenapa confidence JPY selalu "rendah") ─────
// Root cause: judul rilis asli Jepang/Swiss ("CPI Overall Nationwide", "Industrial
// Output Prelim MoM SA", "KOF Indicator") tidak match keyword lama di
// FUND_INDICATOR_MAP, jatuh ke fallback tebak-nama dan numpuk sebagai key baru
// alih-alih menimpa seed "CPI YoY"/"Industrial Production"/"KOF Barometer" — seed
// itu macet PERMANEN walau datanya sebenarnya ada (di key lain yang tak pernah
// dibaca sebagai representasi indikator itu). Keyword ditambah supaya match langsung.

test('Japan CPI Overall Nationwide match langsung ke key kanonik CPI YoY', () => {
  const r = parseFundamentalFromHeadline('Japan CPI Overall Nationwide Actual 1.7% Forecast 1.6% Previous 1.5%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.key, 'CPI YoY');
  assert.strictEqual(r.value, '1.7%');
});

test('Japan Industrial Output Prelim MoM SA match ke key kanonik Industrial Production', () => {
  const r = parseFundamentalFromHeadline('Japan Industrial Output Prelim Mom Sa Actual 1.3% Forecast 0.5% Previous 0.1%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.key, 'Industrial Production');
});

test('Switzerland KOF Indicator match ke key kanonik KOF Barometer', () => {
  const r = parseFundamentalFromHeadline('Switzerland KOF Indicator Actual 103.5 Forecast 100.0 Previous 101.2');
  assert.strictEqual(r.currency, 'CHF');
  assert.strictEqual(r.key, 'KOF Barometer');
});

test('Japan Retail Trade YoY (terminologi alternatif) match ke key Retail Sales YoY', () => {
  const r = parseFundamentalFromHeadline('Japan Retail Trade YoY Actual 2.0% Forecast 1.8% Previous 1.7%');
  assert.strictEqual(r.currency, 'JPY');
  assert.strictEqual(r.key, 'Retail Sales YoY');
});

// ── reconcileFundamentalKeys ────────────────────────────────────────────────

function makeMultiKeyMockRedis(initialByRedisKey) {
  const store = {};
  for (const [rk, hash] of Object.entries(initialByRedisKey)) store[rk] = { ...hash };
  const fn = async (...args) => {
    const [cmd, redisKey] = args;
    if (cmd === 'HGETALL') {
      const h = store[redisKey] || {};
      const out = [];
      for (const [k, v] of Object.entries(h)) out.push(k, v);
      return out;
    }
    if (cmd === 'HSET') {
      const kv = args.slice(2);
      if (!store[redisKey]) store[redisKey] = {};
      for (let i = 0; i < kv.length; i += 2) store[redisKey][kv[i]] = kv[i + 1];
      return kv.length / 2;
    }
    if (cmd === 'HDEL') {
      const keys = args.slice(2);
      let n = 0;
      const h = store[redisKey] || {};
      for (const k of keys) { if (k in h) { delete h[k]; n++; } }
      return n;
    }
    return null;
  };
  fn.store = store;
  return fn;
}

test('reconcileFundamentalKeys: case-mismatch (NZD "Cpi Qoq" vs seed "CPI QoQ") — data segar menang, orphan dihapus', async () => {
  const redis = makeMultiKeyMockRedis({
    'fundamental:NZD': {
      'CPI QoQ': JSON.stringify({ actual: '0.6%', period: 'Q4 2025', date: '—', source: 'seed', seeded_at: '2026-08-03T06:12:06.524Z' }),
      'Cpi Qoq': JSON.stringify({ actual: '1.5%', period: '—', date: '2026-07-21', source: 'headline', previous: '0.9%' }),
    },
  });
  const reconciled = await reconcileFundamentalKeys(redis);
  assert.ok(reconciled.NZD, 'NZD harus dilaporkan direkonsiliasi');
  const nzd = redis.store['fundamental:NZD'];
  assert.strictEqual(nzd['Cpi Qoq'], undefined, 'orphan case-mismatch harus dihapus');
  const canonical = JSON.parse(nzd['CPI QoQ']);
  assert.strictEqual(canonical.actual, '1.5%', 'nilai segar (bukan seed) yang menang');
  assert.strictEqual(canonical.source, 'headline');
});

test('reconcileFundamentalKeys: sinonim JPY (seed "CPI YoY" vs "Cpi Overall Nationwide") — migrasi ke key kanonik', async () => {
  const redis = makeMultiKeyMockRedis({
    'fundamental:JPY': {
      'CPI YoY': JSON.stringify({ actual: '1.5%', period: 'Mar 2026', date: '—', source: 'seed', seeded_at: '2026-08-03T06:12:03.952Z' }),
      'Cpi Overall Nationwide': JSON.stringify({ actual: '1.7%', period: '—', date: '2026-07-24', source: 'headline', previous: '1.5%' }),
    },
  });
  const reconciled = await reconcileFundamentalKeys(redis);
  assert.ok(reconciled.JPY);
  const jpy = redis.store['fundamental:JPY'];
  assert.strictEqual(jpy['Cpi Overall Nationwide'], undefined);
  const canonical = JSON.parse(jpy['CPI YoY']);
  assert.strictEqual(canonical.actual, '1.7%');
  assert.strictEqual(canonical.source, 'headline');
});

test('reconcileFundamentalKeys: idempotent — jalan kedua kali tanpa perubahan lagi', async () => {
  const redis = makeMultiKeyMockRedis({
    'fundamental:CHF': {
      'KOF Barometer': JSON.stringify({ actual: '97.9', period: 'Apr 2026', date: '—', source: 'seed' }),
      'Kof Indicator': JSON.stringify({ actual: '103.5', period: '—', date: '2026-07-30', source: 'headline' }),
    },
  });
  await reconcileFundamentalKeys(redis);
  const secondRun = await reconcileFundamentalKeys(redis);
  assert.deepStrictEqual(secondRun, {}, 'tidak ada lagi yang perlu direkonsiliasi di jalan kedua');
  const chf = redis.store['fundamental:CHF'];
  assert.strictEqual(JSON.parse(chf['KOF Barometer']).actual, '103.5');
});

test('reconcileFundamentalKeys: canonical belum pernah ada sama sekali — orphan jadi isi key kanonik', async () => {
  const redis = makeMultiKeyMockRedis({
    'fundamental:CHF': {
      'Kof Indicator': JSON.stringify({ actual: '103.5', period: '—', date: '2026-07-30', source: 'headline' }),
    },
  });
  await reconcileFundamentalKeys(redis);
  const chf = redis.store['fundamental:CHF'];
  assert.strictEqual(chf['Kof Indicator'], undefined);
  assert.strictEqual(JSON.parse(chf['KOF Barometer']).actual, '103.5');
});

test('reconcileFundamentalKeys: currency tanpa data sama sekali dilewati tanpa error', async () => {
  const redis = makeMultiKeyMockRedis({});
  const reconciled = await reconcileFundamentalKeys(redis);
  assert.deepStrictEqual(reconciled, {});
});
