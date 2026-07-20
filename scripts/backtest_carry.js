// scripts/backtest_carry.js — Riset tambahan (2026-07-20, diskusi user pasca-Plan U,
// item #3): backtest OFFLINE komponen carry/yield differential SENDIRI, TERPISAH dari
// keputusan diskresioner AI Analisa — supaya nilai sinyal yield differential (dipakai
// di api/real-yields.js / fundamentalPanel) bisa dinilai independen, bukan bercampur
// dengan confluence zone/teknikal (itu domain scripts/backtest_confluence.js).
//
// BEDA dari backtest_confluence.js: script ini BUTUH kredensial (FRED_API_KEY) — TIDAK
// bisa jalan tanpa itu (FRED tidak punya API publik tanpa key). Set env var yang sama
// dengan Vercel (lihat README §Kunci Environment) sebelum menjalankan.
//
// Metode (proxy carry trade — BUKAN suku bunga kebijakan/short rate asli, itu tidak
// tersedia gratis via FRED untuk semua currency; 10Y nominal dipakai sebagai proxy
// yield differential, sama series yang dipakai api/real-yields.js):
//   - Tiap awal bulan (rebalance bulanan), hitung differential = yield_10Y(base) -
//     yield_10Y(USD) untuk pair BASE/USD (EUR, GBP, AUD), atau yield_10Y(USD) -
//     yield_10Y(JPY) untuk USD/JPY (USD di posisi base).
//   - Signal: differential > 0 -> LONG pair (base currency yield lebih tinggi,
//     carry klasik: long high-yielder). differential < 0 -> SHORT pair.
//   - Return realized: %change close FX bulan itu, searah signal (long -> +change,
//     short -> -change).
//   - Baseline pembanding: (a) BUY & HOLD (selalu long, tanpa signal) — carry
//     harus outperform ini kalau signal beneran menambah nilai; (b) ANTI-CARRY
//     (signal dibalik) — sanity check, kalau anti-carry menang berarti signal
//     terbalik dari yang diasumsikan.
//
// Jalankan: FRED_API_KEY=xxx node scripts/backtest_carry.js
// Hasil dicatat di Dokumentasi/daun_merah_riset.md.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

const PAIRS = [
  // base: currency yang posisinya "long" kalau signal positif. fredSeries: series 10Y
  // base currency (null untuk USD -> pakai DGS10 langsung). invert: true kalau USD
  // ada di posisi BASE pair (USD/JPY) -> differential dibalik (USD - JPY, bukan JPY - USD).
  { symbol: 'EURUSD=X', label: 'EUR/USD', base: 'EUR', fredSeries: 'IRLTLT01EZM156N', invert: false },
  { symbol: 'GBPUSD=X', label: 'GBP/USD', base: 'GBP', fredSeries: 'IRLTLT01GBM156N', invert: false },
  { symbol: 'AUDUSD=X', label: 'AUD/USD', base: 'AUD', fredSeries: 'IRLTLT01AUM156N', invert: false },
  { symbol: 'USDJPY=X', label: 'USD/JPY', base: 'USD', fredSeries: 'IRLTLT01JPM156N', invert: true },
];

const YEARS_BACK = 3;

async function fetchFredHistory(seriesId, startDate) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY tidak diset — wajib untuk backtest ini (lihat header file)');
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&observation_start=${startDate}&sort_order=asc&file_type=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`);
  const json = await r.json();
  return (json.observations || [])
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

async function fetchYahooDaily(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    out.push({ t: ts[i] * 1000, c: closes[i] });
  }
  return out;
}

// Nilai yield TERAKHIR yang tersedia PADA/SEBELUM targetDate (tanpa lookahead —
// data monthly FRED biasanya dipublikasi dengan lag beberapa hari, tapi observation
// date-nya sendiri sudah cukup buat pendekatan bulanan longgar ini).
function yieldAsOf(series, targetDate) {
  let val = null;
  for (const o of series) { if (o.date <= targetDate) val = o.value; else break; }
  return val;
}

// FX close TERDEKAT pada/sebelum targetMs.
function closeAsOf(candles, targetMs) {
  let val = null;
  for (const c of candles) { if (c.t <= targetMs) val = c.c; else break; }
  return val;
}

function monthStarts(fromDate, toDate) {
  const out = [];
  let d = new Date(fromDate + '-01T00:00:00Z');
  const end = new Date(toDate + '-01T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - YEARS_BACK * 365 * 86400000).toISOString().slice(0, 10);
  const months = monthStarts(startDate, today);

  const tally = {
    carry:      { n: 0, sumReturn: 0, wins: 0 },
    antiCarry:  { n: 0, sumReturn: 0, wins: 0 },
    buyHold:    { n: 0, sumReturn: 0, wins: 0 },
  };
  const perPair = {};

  for (const p of PAIRS) {
    process.stdout.write(`Fetch ${p.label}... `);
    let usdSeries, baseSeries, fx;
    try {
      [usdSeries, baseSeries, fx] = await Promise.all([
        fetchFredHistory('DGS10', startDate),
        fetchFredHistory(p.fredSeries, startDate),
        fetchYahooDaily(p.symbol, `${YEARS_BACK}y`),
      ]);
    } catch (e) { console.log(`SKIP (${e.message})`); continue; }
    console.log(`${usdSeries.length} obs USD, ${baseSeries.length} obs ${p.base}, ${fx.length} bar FX`);

    const pp = perPair[p.label] = { n: 0, carrySum: 0, carryWins: 0 };

    for (let i = 0; i < months.length - 1; i++) {
      const mStart = months[i], mEnd = months[i + 1];
      const usdY = yieldAsOf(usdSeries, mStart);
      const baseY = yieldAsOf(baseSeries, mStart);
      if (usdY == null || baseY == null) continue;
      const differential = p.invert ? (usdY - baseY) : (baseY - usdY);

      const startMs = new Date(mStart + 'T00:00:00Z').getTime();
      const endMs = new Date(mEnd + 'T00:00:00Z').getTime();
      const closeStart = closeAsOf(fx, startMs);
      const closeEnd = closeAsOf(fx, endMs);
      if (closeStart == null || closeEnd == null || closeStart === 0) continue;

      const pctChange = (closeEnd - closeStart) / closeStart * 100;
      const signal = differential > 0 ? 1 : differential < 0 ? -1 : 0;
      if (signal === 0) continue;

      const carryReturn = signal * pctChange;
      const antiReturn = -signal * pctChange;

      tally.carry.n++; tally.carry.sumReturn += carryReturn; if (carryReturn > 0) tally.carry.wins++;
      tally.antiCarry.n++; tally.antiCarry.sumReturn += antiReturn; if (antiReturn > 0) tally.antiCarry.wins++;
      tally.buyHold.n++; tally.buyHold.sumReturn += pctChange; if (pctChange > 0) tally.buyHold.wins++;

      pp.n++; pp.carrySum += carryReturn; if (carryReturn > 0) pp.carryWins++;
    }
  }

  console.log('\n══ HASIL PER PAIR (signal carry) ══');
  for (const [label, pp] of Object.entries(perPair)) {
    const avg = pp.n ? (pp.carrySum / pp.n).toFixed(3) : 'n/a';
    const winRate = pp.n ? Math.round(pp.carryWins / pp.n * 100) : 0;
    console.log(`${label}: ${pp.n} bulan, avg return ${avg}%/bulan, win-rate ${winRate}%`);
  }

  console.log('\n══ AGREGAT (semua pair, semua bulan) ══');
  for (const [name, t] of Object.entries(tally)) {
    const avg = t.n ? (t.sumReturn / t.n).toFixed(3) : 'n/a';
    const winRate = t.n ? Math.round(t.wins / t.n * 100) : 0;
    const displayName = { carry: 'IKUT SIGNAL CARRY', antiCarry: 'ANTI-CARRY (kontrol)', buyHold: 'BUY & HOLD (kontrol)' }[name];
    console.log(`${displayName}: n=${t.n}, avg return ${avg}%/bulan, win-rate ${winRate}%`);
  }
  console.log('\nInterpretasi: signal carry berguna kalau avg return & win-rate-nya JELAS lebih');
  console.log('baik dari BUY & HOLD dan ANTI-CARRY, DAN cukup besar untuk menutup biaya swap/spread');
  console.log('(tidak dihitung di sini — angka di atas MURNI pergerakan harga, belum net biaya).');
  console.log('n per pair kecil (~36 bulan) — treat sebagai indikasi awal, bukan kesimpulan final.');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
