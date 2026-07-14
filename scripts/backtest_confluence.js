// scripts/backtest_confluence.js — Tier 3 riset (session 166): backtest OFFLINE zona
// konfluensi (_confluenceZones di api/admin.js) terhadap data historis Yahoo publik.
// Tujuan: memvalidasi asumsi inti fitur Analisa — "zona dengan banyak struktur
// bertumpuk = area harga bereaksi" — TANPA satu pun AI call dan tanpa kredensial.
//
// Metode:
//   - Fetch 1H 60 hari + Daily 1 tahun per pair langsung dari Yahoo (API publik yang
//     sama dengan ohlcv_sync; tidak lewat Redis/Vercel).
//   - Replay: tiap 24 bar 1H (≈ harian), bangun snapshot data PERSIS seperti yang
//     dilihat produksi (computeOhlcvMetrics dari candle sampai titik itu, tanpa
//     lookahead), hitung zona konfluensi.
//   - Untuk tiap zona: dalam 48 bar 1H ke depan, kalau harga MENYENTUH zona
//     (± 0.5x tolerance dari center), amati 12 bar berikutnya: BOUNCE (close menjauh
//     ≥ 0.3x ATR Daily ke arah datangnya) vs BREAK (close menembus ≥ 0.3x ATR Daily
//     ke sisi lain) vs CHOP (tidak keduanya).
//   - Bandingkan zona skor TINGGI (≥ 3) vs skor RENDAH (≤ 1.5): kalau konfluensi
//     memang berarti, bounce-rate zona tinggi harus lebih besar.
//
// Jalankan: node scripts/backtest_confluence.js
// Hasil dicatat di Dokumentasi/daun_merah_riset_ai_pintar.md (bagian Tier 3).

const { computeOhlcvMetrics, resampleTo4h, _confluenceZones } = require('../api/admin.js');

const PAIRS = [
  { symbol: 'GC=F',     label: 'XAU/USD' },
  { symbol: 'EURUSD=X', label: 'EUR/USD' },
  { symbol: 'USDJPY=X', label: 'USD/JPY' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD' },
];

const LOOKAHEAD_BARS = 48;  // jendela sentuh: 48 jam
const REACT_BARS     = 12;  // jendela reaksi setelah sentuh: 12 jam
const STEP_BARS      = 24;  // titik evaluasi tiap 24 bar (≈ harian)
const HIGH_SCORE     = 3;
const LOW_SCORE      = 1.5;

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

function evalZone(zone, side, tol, atrD, c1hFuture) {
  // side: 'above' (resistance — harga datang dari bawah) | 'below' (support)
  const half = tol * 0.5;
  let touchIdx = -1;
  const look = c1hFuture.slice(0, LOOKAHEAD_BARS);
  for (let i = 0; i < look.length; i++) {
    if (look[i].h >= zone.center - half && look[i].l <= zone.center + half) { touchIdx = i; break; }
  }
  if (touchIdx === -1) return { touched: false };
  const react = c1hFuture.slice(touchIdx + 1, touchIdx + 1 + REACT_BARS);
  const move = atrD * 0.3;
  for (const c of react) {
    if (side === 'above') { // resistance: bounce = turun menjauh; break = tembus naik
      if (c.c <= zone.center - move) return { touched: true, outcome: 'bounce' };
      if (c.c >= zone.center + move) return { touched: true, outcome: 'break' };
    } else {                // support: bounce = naik menjauh; break = tembus turun
      if (c.c >= zone.center + move) return { touched: true, outcome: 'bounce' };
      if (c.c <= zone.center - move) return { touched: true, outcome: 'break' };
    }
  }
  return { touched: true, outcome: 'chop' };
}

async function run() {
  const tally = {
    high: { zones: 0, touched: 0, bounce: 0, break: 0, chop: 0 },
    low:  { zones: 0, touched: 0, bounce: 0, break: 0, chop: 0 },
  };
  const perPair = {};

  for (const { symbol, label } of PAIRS) {
    process.stdout.write(`Fetch ${label}... `);
    let c1hAll, c1dAll;
    try {
      [c1hAll, c1dAll] = await Promise.all([
        fetchYahoo(symbol, '1h', '60d'),
        fetchYahoo(symbol, '1d', '1y'),
      ]);
    } catch (e) { console.log(`SKIP (${e.message})`); continue; }
    console.log(`${c1hAll.length} bar 1H, ${c1dAll.length} bar Daily`);
    const pp = perPair[label] = { points: 0, high: { zones: 0, touched: 0, bounce: 0 }, low: { zones: 0, touched: 0, bounce: 0 } };

    // Titik evaluasi: butuh minimal 240 bar histori 1H dan 48 bar lookahead
    for (let i = 240; i < c1hAll.length - LOOKAHEAD_BARS; i += STEP_BARS) {
      const tEval = c1hAll[i].t;
      const c1hHist = c1hAll.slice(Math.max(0, i - 240), i + 1);
      const c1dHist = c1dAll.filter(c => c.t < tEval).slice(-260);
      if (c1dHist.length < 40) continue;
      const c4h = resampleTo4h(c1hHist);
      const data = computeOhlcvMetrics({ symbol, label, c1h: c1hHist.slice(-120), c4h, c1dFull: c1dHist, ta: null });
      const zones = _confluenceZones(data, []);
      if (!zones) continue;
      pp.points++;
      const atrD = data.d1_ext?.available && data.d1_ext.atr_d != null ? data.d1_ext.atr_d : null;
      if (!atrD) continue;
      const future = c1hAll.slice(i + 1);
      for (const side of ['above', 'below']) {
        for (const z of zones[side]) {
          const bucket = z.score >= HIGH_SCORE ? 'high' : z.score <= LOW_SCORE ? 'low' : null;
          if (!bucket) continue;
          const r = evalZone(z, side, zones.tolerance, atrD, future);
          tally[bucket].zones++; pp[bucket].zones++;
          if (r.touched) {
            tally[bucket].touched++; pp[bucket].touched++;
            tally[bucket][r.outcome]++;
            if (r.outcome === 'bounce') pp[bucket].bounce++;
          }
        }
      }
    }
  }

  console.log('\n══ HASIL PER PAIR ══');
  for (const [label, pp] of Object.entries(perPair)) {
    const rate = b => b.touched ? `${Math.round(b.bounce / b.touched * 100)}% bounce dari ${b.touched} sentuh (${b.zones} zona)` : `0 sentuh (${b.zones} zona)`;
    console.log(`${label}: ${pp.points} titik evaluasi`);
    console.log(`  skor tinggi (≥${HIGH_SCORE}): ${rate(pp.high)}`);
    console.log(`  skor rendah (≤${LOW_SCORE}): ${rate(pp.low)}`);
  }
  console.log('\n══ AGREGAT ══');
  for (const bucket of ['high', 'low']) {
    const b = tally[bucket];
    const touchRate = b.zones ? Math.round(b.touched / b.zones * 100) : 0;
    const bounceRate = b.touched ? Math.round(b.bounce / b.touched * 100) : 0;
    const breakRate = b.touched ? Math.round(b.break / b.touched * 100) : 0;
    const chopRate = b.touched ? Math.round(b.chop / b.touched * 100) : 0;
    console.log(`Zona skor ${bucket === 'high' ? `TINGGI (≥${HIGH_SCORE})` : `RENDAH (≤${LOW_SCORE})`}: ${b.zones} zona, ${b.touched} tersentuh (${touchRate}%) → bounce ${bounceRate}% | break ${breakRate}% | chop ${chopRate}%`);
  }
  console.log('\nInterpretasi: kalau bounce-rate zona TINGGI >> zona RENDAH, konfluensi memang');
  console.log('prediktif sebagai area reaksi. Kalau setara → skor konfluensi belum membawa');
  console.log('informasi tambahan, revisit sebelum lanjut Tier 5.');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
