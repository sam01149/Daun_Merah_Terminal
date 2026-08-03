// test/fundamental_parser.test.js
// Unit test parser murni — jalankan: npm test (node --test, tanpa network/Redis)
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseFundamentalFromHeadline, parseCBDecision, autoUpdateFundamentals,
  extractFundamentalFromCalendarEvent, autoUpdateFundamentalsFromCalendar,
} = require('../../api/_fundamental_parser');

// ── parseFundamentalFromHeadline ────────────────────────────────────────────

test('format FinancialJuice standar: US CPI YoY', () => {
  const r = parseFundamentalFromHeadline('US CPI YoY: Actual 3.2% Forecast 3.1% Previous 3.4%');
  assert.deepStrictEqual(r, { currency: 'USD', key: 'CPI YoY', value: '3.2%', previous: '3.4%' });
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

test('extractFundamentalFromCalendarEvent: event terstruktur -> {currency,key,value,previous,date}', () => {
  const r = extractFundamentalFromCalendarEvent(calEvent());
  assert.deepStrictEqual(r, { currency: 'JPY', key: 'Retail Sales YoY', value: '1.9%', previous: '1.7%', date: '2026-08-03' });
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
  assert.deepStrictEqual(jpy, { actual: '1.9%', period: '—', date: '2026-08-03', source: 'calendar', previous: '1.7%' });
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
