// scripts/analyze_pair_correlation.js — cek independensi 3 pair Golden Trio
// Plan U (XAU/USD, EUR/USD, GBP/USD) — dipicu diskusi user 2026-07-26: ketiganya
// share kaki USD, jadi n>=30 per-pair yang diasumsikan i.i.d. (CLT) mungkin
// sebenarnya lebih korelatif dari yang disadari waktu skema ini dipilih
// (lihat "Golden Trio", Dokumentasi/daun_merah_riset.md 2026-07-22 — keputusan
// itu murni soal kecepatan akumulasi sampel, TIDAK mempertimbangkan korelasi).
//
// Metode utama (TANPA kredensial, sama pola backtest_confluence.js): fetch 1H
// 60 hari langsung dari Yahoo publik untuk 3 pair Golden Trio + 1 pair kontrol
// EUR/GBP (tidak share USD, buat pembanding "beneran independen kelihatan
// seperti apa"). Hitung korelasi Pearson return per-bar antar pasangan.
//
// Metode tambahan (opsional, butuh UPSTASH_REDIS_REST_URL/TOKEN): baca
// setup_log_auto:v1 riil, cek apakah bias yang di-generate AI per slot cron
// searah (co-movement langsung di level keputusan AI, bukan cuma harga).
// Sample kemungkinan masih kecil (Golden Trio baru berjalan sejak 2026-07-22)
// — dilaporkan apa adanya dengan n, tidak diklaim signifikan kalau kecil.
//
// Jalankan:
//   node scripts/analyze_pair_correlation.js                (harga saja)
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/analyze_pair_correlation.js   (+ cek bias AI riil)

const { pearsonCorrelation, mean } = require('./_stats.js');

const PAIRS = [
  { symbol: 'GC=F',     label: 'XAU/USD' },
  { symbol: 'EURUSD=X', label: 'EUR/USD' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { symbol: 'EURGBP=X', label: 'EUR/GBP (kontrol, tidak share USD)' },
];

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
    const c = q.close?.[i];
    if (c == null || isNaN(c)) continue;
    out.push({ t: ts[i], c: +c });
  }
  return out;
}

// Return log-return per bar, keyed by timestamp (bucket ke jam terdekat supaya
// bisa di-align antar pair walau Yahoo kadang punya timestamp sedikit geser).
function toReturnMap(candles) {
  const map = new Map();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].c, cur = candles[i].c;
    if (!prev || !cur) continue;
    const bucketT = Math.round(candles[i].t / 3600) * 3600;
    map.set(bucketT, Math.log(cur / prev));
  }
  return map;
}

function alignedSeries(mapA, mapB) {
  const a = [], b = [];
  for (const [t, ra] of mapA) {
    if (mapB.has(t)) { a.push(ra); b.push(mapB.get(t)); }
  }
  return { a, b, n: a.length };
}

function interpret(r) {
  const abs = Math.abs(r);
  if (abs >= 0.7) return 'SANGAT KUAT';
  if (abs >= 0.5) return 'kuat';
  if (abs >= 0.3) return 'sedang';
  if (abs >= 0.1) return 'lemah';
  return 'nyaris tidak ada';
}

async function main() {
  console.log('=== Korelasi return 1H, 60 hari terakhir (Yahoo, data publik) ===\n');
  const returnMaps = {};
  for (const p of PAIRS) {
    try {
      const candles = await fetchYahoo(p.symbol, '1h', '60d');
      returnMaps[p.label] = toReturnMap(candles);
      console.log(`${p.label}: ${candles.length} candle diambil`);
    } catch (e) {
      console.warn(`${p.label}: GAGAL fetch (${e.message}) — dilewati`);
    }
  }
  console.log('');

  const labels = Object.keys(returnMaps);
  const rows = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const { a, b, n } = alignedSeries(returnMaps[labels[i]], returnMaps[labels[j]]);
      const r = pearsonCorrelation(a, b);
      rows.push({ pair: `${labels[i]}  vs  ${labels[j]}`, r, n });
    }
  }
  rows.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  for (const row of rows) {
    console.log(`${row.pair.padEnd(55)}  r = ${row.r.toFixed(3).padStart(7)}  (${interpret(row.r)}, n=${row.n})`);
  }

  console.log('\n=== Cek tambahan: bias AI riil di setup_log_auto:v1 (kalau ada kredensial) ===');
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.log('(dilewati — UPSTASH_REDIS_REST_URL/TOKEN tidak diset)');
    return;
  }
  const redisCmd = async (...args) => {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return (await r.json()).result;
  };
  const raw = await redisCmd('GET', 'setup_log_auto:v1');
  const log = raw ? JSON.parse(raw) : [];
  console.log(`Total entri setup_log_auto:v1: ${log.length}`);
  if (!log.length) return;

  // Kelompokkan per slot: ts dibulatkan ke jam terdekat DAN hari yang sama —
  // daemon memanggil 3 pair berurutan dalam satu run cron (detik ke detik,
  // bukan pas sama), jadi toleransi 2 jam cukup menangkap "1 slot" yang sama.
  const SLOT_TOLERANCE_MS = 2 * 3600 * 1000;
  const bySlot = [];
  for (const s of log.sort((a, b) => a.ts - b.ts)) {
    let slot = bySlot.find(sl => Math.abs(sl.ts - s.ts) < SLOT_TOLERANCE_MS);
    if (!slot) { slot = { ts: s.ts, entries: [] }; bySlot.push(slot); }
    slot.entries.push(s);
  }
  const multiPairSlots = bySlot.filter(sl => sl.entries.length >= 2);
  console.log(`Slot dengan >=2 pair sekaligus: ${multiPairSlots.length} dari ${bySlot.length} total slot\n`);

  let sameBias = 0, diffBias = 0;
  for (const slot of multiPairSlots) {
    const biases = slot.entries.map(e => `${e.symbol}:${e.bias}`);
    // "searah vs USD" — anggap XAU bullish = USD lemah (searah dgn EUR/GBP bullish);
    // EUR/USD & GBP/USD bullish = USD lemah juga. Jadi normalisasi ke "USD lemah"/"USD kuat".
    const usdView = slot.entries.map(e => {
      if (e.symbol === 'GC=F') return e.bias === 'bullish' ? 'usd_lemah' : 'usd_kuat';
      return e.bias === 'bullish' ? 'usd_lemah' : 'usd_kuat'; // EURUSD/GBPUSD bullish = USD lemah juga
    });
    const allSame = usdView.every(v => v === usdView[0]);
    if (allSame) sameBias++; else diffBias++;
    console.log(`Slot ts=${slot.ts} (${new Date(slot.ts).toISOString()}): ${biases.join(', ')} -> ${allSame ? 'SEARAH (semua implikasikan pandangan USD sama)' : 'beda arah'}`);
  }
  console.log(`\nRingkasan: ${sameBias}/${multiPairSlots.length} slot semua pair searah pandangan USD, ${diffBias}/${multiPairSlots.length} beda arah.`);
  if (multiPairSlots.length < 10) {
    console.log('CATATAN: n masih sangat kecil (Golden Trio baru berjalan beberapa hari) — angka di atas indikatif, BUKAN kesimpulan statistik final.');
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
