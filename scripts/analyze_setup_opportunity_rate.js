// scripts/analyze_setup_opportunity_rate.js — cek dugaan (2026-07-26, diskusi
// user): kalau salah satu pair Golden Trio (XAU/USD, EUR/USD, GBP/USD) diganti
// cross non-USD (mis. EUR/GBP, AUD/JPY) buat kurangi korelasi (lihat
// analyze_pair_correlation.js), APAKAH pair penggantinya kemungkinan lebih
// sering "ditolak" AI (entry_zone di-null-kan karena struktur Mixed/tidak ada
// zona layak — lihat instruksi entry_zone di ohlcv_analyze, api/admin.js)
// sehingga n>=33 per-pair terkumpul lebih lambat meski jumlah percobaan/hari
// SAMA?
//
// Metode: proxy OBJEKTIF pakai fungsi kode murni yang SAMA dipakai produksi
// (_classifyStructure, _confluenceZones, computeOhlcvMetrics — nol AI call),
// replay historis gaya backtest_confluence.js. Di tiap titik evaluasi (setiap
// 12 bar 1H, ~2x/hari, meniru cadence AUTO_ENTRY_HOURS_UTC):
//   1. Structure H4 Mixed/Range -> DIANGGAP DITOLAK (AI diinstruksikan null-kan
//      entry_zone kalau "struktur Mixed, harga di tengah range").
//   2. Structure jelas (HH+HL / LH+LL) tapi TIDAK ADA zona konfluensi di sisi
//      yang benar (below kalau bullish, above kalau bearish) -> DIANGGAP DITOLAK
//      ("semua zona skor rendah" / tidak ada dasar struktur).
//   3. Selain itu -> DIANGGAP ADA PELUANG setup (bukan jaminan AI generate,
//      krn makro_alignment='konflik' juga bisa menolak — TIDAK dimodelkan di
//      sini, jadi angka "peluang" ini batas ATAS, bukan estimasi presisi).
//
// Tujuan: PERBANDINGAN RELATIF antar-pair (apakah kandidat pengganti secara
// konsisten lebih rendah peluangnya dari pair Golden Trio saat ini), bukan
// angka mutlak tingkat penolakan AI yang sebenarnya.
//
// Jalankan: node scripts/analyze_setup_opportunity_rate.js

const { computeOhlcvMetrics, resampleTo4h, _confluenceZones, _classifyStructure } = require('../api/admin.js');

const CURRENT_PAIRS = [
  { symbol: 'GC=F',     label: 'XAU/USD (Golden Trio saat ini)' },
  { symbol: 'EURUSD=X', label: 'EUR/USD (Golden Trio saat ini)' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD (Golden Trio saat ini)' },
];
const CANDIDATE_PAIRS = [
  { symbol: 'EURGBP=X', label: 'EUR/GBP (kandidat pengganti)' },
  { symbol: 'AUDJPY=X', label: 'AUD/JPY (kandidat pengganti)' },
  { symbol: 'AUDNZD=X', label: 'AUD/NZD (kandidat pengganti)' },
  { symbol: 'CHFJPY=X', label: 'CHF/JPY (kandidat pengganti)' },
];
const PAIRS = [...CURRENT_PAIRS, ...CANDIDATE_PAIRS];

const STEP_BARS = 12; // ~12 jam antar titik evaluasi, meniru 2 slot/hari

async function fetchYahoo(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${interval} HTTP ${r.status}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some(v => v == null || isNaN(v))) continue;
    out.push({ t: ts[i], o: +o, h: +h, l: +l, c: +c, v: Math.round(q.volume?.[i] || 0) });
  }
  return out;
}

async function run() {
  const results = [];
  for (const { symbol, label } of PAIRS) {
    process.stdout.write(`Fetch ${label}... `);
    let c1hAll, c1dAll;
    try {
      [c1hAll, c1dAll] = await Promise.all([
        fetchYahoo(symbol, '1h', '60d'),
        fetchYahoo(symbol, '1d', '1y'),
      ]);
    } catch (e) { console.log(`SKIP (${e.message})`); continue; }
    console.log(`${c1hAll.length} bar 1H`);

    let points = 0, mixed = 0, noZone = 0, opportunity = 0;
    for (let i = 240; i < c1hAll.length; i += STEP_BARS) {
      const tEval = c1hAll[i].t;
      const c1hHist = c1hAll.slice(Math.max(0, i - 240), i + 1);
      const c1dHist = c1dAll.filter(c => c.t < tEval).slice(-260);
      if (c1dHist.length < 40) continue;
      const c4h = resampleTo4h(c1hHist);
      const data = computeOhlcvMetrics({ symbol, label, c1h: c1hHist.slice(-120), c4h, c1dFull: c1dHist, ta: null });
      if (!data.h4?.available) continue;
      points++;

      const structure = _classifyStructure(data.h4.swing_highs, data.h4.swing_lows, data.h4.current, data.dec);
      if (!structure || structure.label.startsWith('Mixed')) { mixed++; continue; }

      const zones = _confluenceZones(data, []);
      if (!zones) { noZone++; continue; }
      const isBullish = structure.label.startsWith('Bullish');
      const sideZones = isBullish ? zones.below : zones.above; // bullish -> entry pullback ke support (below); bearish -> rally ke resistance (above)
      if (!sideZones || sideZones.length === 0) { noZone++; continue; }
      opportunity++;
    }

    const pct = n => points ? Math.round(n / points * 100) : 0;
    results.push({ label, points, mixed, noZone, opportunity, oppPct: pct(opportunity) });
    console.log(`  ${points} titik evaluasi -> peluang setup ${pct(opportunity)}% (Mixed ${pct(mixed)}%, tanpa zona layak ${pct(noZone)}%)`);
  }

  console.log('\n══ RINGKASAN (urut peluang setup tertinggi -> terendah) ══');
  results.sort((a, b) => b.oppPct - a.oppPct);
  for (const r of results) {
    console.log(`${r.label.padEnd(38)}  peluang setup ~${String(r.oppPct).padStart(3)}%  (n=${r.points} titik, Mixed ${r.mixed}, tanpa-zona ${r.noZone}, peluang ${r.opportunity})`);
  }

  const currentAvg = Math.round(results.filter(r => CURRENT_PAIRS.some(p => r.label.startsWith(p.label.split(' ')[0]))).reduce((s, r) => s + r.oppPct, 0) / CURRENT_PAIRS.length);
  console.log(`\nRata-rata peluang setup 3 pair Golden Trio saat ini: ~${currentAvg}%`);
  for (const c of CANDIDATE_PAIRS) {
    const r = results.find(x => x.label === c.label);
    if (!r) continue;
    const diff = r.oppPct - currentAvg;
    console.log(`${c.label}: ~${r.oppPct}% (${diff >= 0 ? '+' : ''}${diff} poin vs rata-rata Golden Trio saat ini)`);
  }
  console.log('\nCATATAN: ini proxy batas-atas (tidak memodelkan penolakan karena konflik makro) — dipakai untuk PERBANDINGAN RELATIF antar-pair, bukan estimasi presisi tingkat penolakan AI yang sebenarnya.');
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
