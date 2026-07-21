// test/makro_ctx.test.js
// Unit test integrasi Ringkasan→Analisa (api/admin.js):
// _extractRingkasanExcerpt (ekstraksi excerpt tertarget per pair via {{TAG}}),
// _formatFundamentalBlock (blok fundamental terstruktur cb_bias/COT/risk regime),
// + konsistensi mirror client (_extractRingkasanExcerptJs di index.html) vs server.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { _extractRingkasanExcerpt, _formatFundamentalBlock, _extractMacroDrivers } = require('../../api/admin.js');

// Artikel sintetis bergaya digest: jangkar → tag per currency → Konfirmasi → blok XAU
const ARTICLE = [
  'Powell menegaskan rate path higher-for-longer, DXY menguat 0.4% ke 105.2 sebagai tema utama sesi.',
  '{{TAG: EUR}} EUR tertekan setelah PMI Jerman 47.1 di zona kontraksi, ECB diperkirakan tetap dovish.',
  '{{TAG: JPY/CHF}} JPY dan CHF menguat sebagai safe haven, USD/JPY turun ke 148.5 karena flow risk-off.',
  '{{TAG: AUD}} AUD melemah karena iron ore turun 2%, RBA on hold.',
  '{{TAG: Konfirmasi}} USD paling kuat hari ini, EUR paling lemah karena divergensi data.',
  'XAUUSD: Emas naik 0.8% ke 4160 didukung real yield turun. {{TAG: Geopolitik}} Eskalasi Hormuz menambah bid haven.',
].join('\n\n');

// ── _extractRingkasanExcerpt: XAU ────────────────────────────────────────────

test('excerpt XAU: ambil blok XAUUSD:, tag dibuang, bagian FX tidak ikut', () => {
  const out = _extractRingkasanExcerpt(ARTICLE, 'XAU/USD', true);
  assert.ok(out.startsWith('XAUUSD:'), out.slice(0, 40));
  assert.ok(out.includes('4160') && out.includes('Hormuz'));
  assert.ok(!out.includes('{{TAG'), 'tag harus dibuang');
  assert.ok(!out.includes('PMI Jerman'), 'bagian FX tidak boleh ikut');
});

// ── _extractRingkasanExcerpt: FX tertarget ───────────────────────────────────

test('excerpt EUR/USD: jangkar + segmen EUR + Konfirmasi, tanpa JPY/CHF & AUD & XAU', () => {
  const out = _extractRingkasanExcerpt(ARTICLE, 'EUR/USD', false);
  assert.ok(out.includes('Powell'), 'jangkar tema utama selalu ikut');
  assert.ok(out.includes('PMI Jerman'), 'segmen EUR ikut');
  assert.ok(out.includes('USD paling kuat'), 'blok Konfirmasi ikut');
  assert.ok(!out.includes('148.5'), 'segmen JPY/CHF tidak relevan untuk EUR/USD');
  assert.ok(!out.includes('iron ore'), 'segmen AUD tidak relevan');
  assert.ok(!out.includes('XAUUSD:'), 'bagian XAU tidak ikut');
});

test('excerpt USD/JPY: tag gabungan "JPY/CHF" match leg JPY', () => {
  const out = _extractRingkasanExcerpt(ARTICLE, 'USD/JPY', false);
  assert.ok(out.includes('148.5'), 'segmen JPY/CHF harus ikut');
  assert.ok(!out.includes('iron ore'), 'segmen AUD tidak ikut');
});

test('excerpt tanpa tag: fallback 3 paragraf pertama (perilaku lama)', () => {
  const plain = 'Para satu tema USD.\n\nPara dua tentang EUR.\n\nPara tiga tentang GBP.\n\nPara empat kelebihan.';
  const out = _extractRingkasanExcerpt(plain, 'EUR/USD', false);
  assert.ok(out.includes('Para satu') && out.includes('Para tiga'));
  assert.ok(!out.includes('Para empat'));
});

test('excerpt: pair tanpa segmen match → fallback 3 paragraf, artikel null → null, cap panjang jalan', () => {
  // NZD tidak ada tag-nya — jangkar tetap dapat (picked >= 1) sehingga bukan fallback;
  // tapi Konfirmasi tetap ikut karena wajib.
  const out = _extractRingkasanExcerpt(ARTICLE, 'NZD/USD', false);
  assert.ok(out.includes('Powell') && out.includes('USD paling kuat'));
  assert.ok(!out.includes('PMI Jerman'));
  assert.strictEqual(_extractRingkasanExcerpt(null, 'EUR/USD', false), null);
  const longArt = 'A'.repeat(2000);
  assert.ok(_extractRingkasanExcerpt(longArt, 'EUR/USD', false).length <= 700);
});

test('cap tertarget 2500 (S194): picked panjang tidak lagi terpotong di 900, fallback tetap 700', () => {
  const longTagged = [
    'JANGKAR ' + 'a'.repeat(1400),
    '{{TAG: EUR}} SEGEUR ' + 'b'.repeat(1400),
    '{{TAG: Konfirmasi}} KONF ' + 'c'.repeat(400),
  ].join('\n\n');
  const out = _extractRingkasanExcerpt(longTagged, 'EUR/USD', false);
  assert.ok(out.length > 900, `cap lama 900 harus sudah longgar, dapat ${out.length}`);
  assert.ok(out.length <= 2500, `cap 2500 harus jalan, dapat ${out.length}`);
  // Blok XAUUSD self-contained = tertarget → ikut cap 2500, bukan 700 lama
  const longXau = 'Bagian FX dulu.\n\nXAUUSD: ' + 'z'.repeat(3000);
  const outXau = _extractRingkasanExcerpt(longXau, 'XAU/USD', true);
  assert.ok(outXau.length > 700 && outXau.length <= 2500, `dapat ${outXau.length}`);
});

// ── Mirror client vs server ──────────────────────────────────────────────────

test('mirror: _extractRingkasanExcerptJs (index.html) identik dengan versi server', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const start = html.indexOf('function _extractRingkasanExcerptJs(');
  assert.ok(start !== -1, 'fungsi client harus ada di index.html');
  // Brace-counting naif gagal di sini (fungsi berisi regex dengan {} tak seimbang,
  // mis. [^}] dan \}\}) — potong sampai deklarasi fungsi berikutnya saja.
  const end = html.indexOf('async function analyzeOhlcvAi(', start);
  assert.ok(end !== -1, 'analyzeOhlcvAi harus tepat setelah fungsi mirror');
  const clientFn = eval(`(${html.slice(start, end).trim()})`);
  for (const [label, isXau] of [['XAU/USD', true], ['EUR/USD', false], ['USD/JPY', false], ['NZD/USD', false], ['AUD/USD', false]]) {
    assert.strictEqual(clientFn(ARTICLE, label, isXau), _extractRingkasanExcerpt(ARTICLE, label, isXau), `hasil beda untuk ${label}`);
  }
  const plain = 'Satu.\n\nDua.\n\nTiga.\n\nEmpat.';
  assert.strictEqual(clientFn(plain, 'EUR/USD', false), _extractRingkasanExcerpt(plain, 'EUR/USD', false));
});

// ── _formatFundamentalBlock ──────────────────────────────────────────────────

const NOW = Date.parse('2026-07-06T12:00:00Z');
const CB = {
  EUR: { bias: 'Dovish',  confidence: 'High',   updated_at: '2026-07-06T04:00:00Z' },
  USD: { bias: 'Hawkish', confidence: 'Medium', updated_at: '2026-07-06T04:00:00Z' },
};
const COT = { positions: {
  EUR: { lev_net: -23400, lev_change_net: 5100 },
  USD: { lev_net: 12000,  lev_change_net: -800 },
}, fetched_at: '2026-07-05T00:00:00Z' };
const RISK = { regime: 'risk_off', vix: 22.3, vix_change_2d: 3.1, move: 110 };

test('fund block EUR/USD: kedua leg + COT + risk regime, umur bias dihitung', () => {
  const out = _formatFundamentalBlock({ label: 'EUR/USD', isXau: false, cbBias: CB, cot: COT, risk: RISK, nowMs: NOW });
  assert.ok(out.startsWith('FUNDAMENTAL TERSTRUKTUR'), out.slice(0, 60));
  assert.ok(out.includes('EUR: bias CB Dovish (confidence High, update 8j lalu)'), out);
  assert.ok(out.includes('COT leveraged net -23.4K (+5.1K w/w)'), out);
  assert.ok(out.includes('USD: bias CB Hawkish'), out);
  assert.ok(out.includes('RISK REGIME: Regime: RISK_OFF | VIX 22.3 (+3.1 2d) | MOVE 110'), out);
});

test('fund block XAU/USD: leg XAU tanpa CB/COT (tidak ada barisnya), catatan proxy Fed', () => {
  const out = _formatFundamentalBlock({ label: 'XAU/USD', isXau: true, cbBias: CB, cot: COT, risk: RISK, nowMs: NOW });
  assert.ok(!out.includes('XAU: '), 'XAU tidak punya CB/COT — tidak boleh ada baris XAU');
  assert.ok(out.includes('USD: bias CB Hawkish'));
  assert.ok(out.includes('XAU tidak punya bank sentral'));
});

test('fund block: data parsial tetap jalan, semua kosong → string kosong', () => {
  const onlyRisk = _formatFundamentalBlock({ label: 'EUR/USD', isXau: false, cbBias: null, cot: null, risk: RISK, nowMs: NOW });
  assert.ok(onlyRisk.includes('RISK REGIME') && !onlyRisk.includes('EUR:'));
  assert.strictEqual(_formatFundamentalBlock({ label: 'EUR/USD', isXau: false, cbBias: null, cot: null, risk: null, nowMs: NOW }), '');
  assert.strictEqual(_formatFundamentalBlock({ label: '', isXau: false, cbBias: CB, cot: COT, risk: RISK, nowMs: NOW }), '');
});

// ── Driver makro: DXY/WTI/real yield (2026-07-21) ────────────────────────────
// Konteks: diskusi user soal AI Analisa yang cuma menempel label ("geopolitik naik,
// tapi real yield tinggi") tanpa angka mentah untuk menelusuri mekanismenya. Blok ini
// menyuntik DXY/WTI (dari daily_snapshot) + breakdown nominal/inflasi (dari real_yields)
// supaya makro_alignment_reason bisa mengutip data konkret.

const DRIVERS = {
  dxy: { level: 104.32, pct: 0.42 },
  wti: { level: 68.2,   pct: 1.8 },
  realYieldUsd: { nominal: 4.2, inflation_exp: 2.35, real: 1.85 },
};

test('fund block XAU/USD: drivers lengkap -> baris DOLLAR & KOMODITAS + REAL YIELD USD (USD termasuk leg)', () => {
  const out = _formatFundamentalBlock({ label: 'XAU/USD', isXau: true, cbBias: null, cot: null, risk: null, drivers: DRIVERS, nowMs: NOW });
  assert.ok(out.includes('DOLLAR & KOMODITAS: DXY 104.32 (+0.42% hari ini) | WTI $68.20 (+1.80% hari ini)'), out);
  assert.ok(out.includes('REAL YIELD USD: nominal 4.2% − ekspektasi inflasi 2.35% = real yield 1.85%'), out);
});

test('fund block EUR/GBP: DXY/WTI tetap tampil (barometer global), REAL YIELD USD disembunyikan (USD bukan leg)', () => {
  const out = _formatFundamentalBlock({ label: 'EUR/GBP', isXau: false, cbBias: null, cot: null, risk: null, drivers: DRIVERS, nowMs: NOW });
  assert.ok(out.includes('DOLLAR & KOMODITAS'), out);
  assert.ok(!out.includes('REAL YIELD USD'), out);
});

test('fund block: drivers kosong/null -> tidak menambah baris apapun (fail-open)', () => {
  const out = _formatFundamentalBlock({ label: 'EUR/USD', isXau: false, cbBias: null, cot: null, risk: RISK, drivers: null, nowMs: NOW });
  assert.ok(!out.includes('DOLLAR & KOMODITAS'));
  assert.ok(!out.includes('REAL YIELD USD'));
});

test('_extractMacroDrivers: parse daily_snapshot.drivers + real_yields.currencies.USD', () => {
  const rawSnap = JSON.stringify({ drivers: { DXY: { level: 104.32, pct: 0.42 }, WTI: { level: 68.2, pct: 1.8 } } });
  const rawRY = JSON.stringify({ currencies: { USD: { nominal: 4.2, inflation_exp: 2.35, real: 1.85 }, EUR: { real: 0.1 } } });
  const out = _extractMacroDrivers(rawSnap, rawRY);
  assert.deepStrictEqual(out.dxy, { level: 104.32, pct: 0.42 });
  assert.deepStrictEqual(out.wti, { level: 68.2, pct: 1.8 });
  assert.deepStrictEqual(out.realYieldUsd, { nominal: 4.2, inflation_exp: 2.35, real: 1.85 });
});

test('_extractMacroDrivers: cache kosong/korup/null -> semua null, tidak throw', () => {
  assert.deepStrictEqual(_extractMacroDrivers(null, null), { dxy: null, wti: null, realYieldUsd: null });
  assert.deepStrictEqual(_extractMacroDrivers('not json', 'also not json'), { dxy: null, wti: null, realYieldUsd: null });
  const rawSnapNoDrivers = JSON.stringify({ fx: { EUR: { pct: 0.1 } } });
  assert.deepStrictEqual(_extractMacroDrivers(rawSnapNoDrivers, null), { dxy: null, wti: null, realYieldUsd: null });
});
