// api/_cb_rates.js — shared live CB rate resolver (scrape + 6h Redis cache)
// Used by api/cb-status.js (UI bias card) and api/admin.js fundamental_get
// (so the Fundamental tab's "{Bank} Rate" row is always the live-scraped value,
// not the static seed — see daun_merah.md ECB Rate stale-seed incident).

const CB_FALLBACK = {
  USD: { bank:'Federal Reserve',             short:'Fed',  rate:3.75, last_meeting:'2026-04-29', last_decision:'hold', last_bps:0  },
  EUR: { bank:'European Central Bank',       short:'ECB',  rate:2.15, last_meeting:'2026-04-30', last_decision:'hold', last_bps:0  },
  GBP: { bank:'Bank of England',             short:'BOE',  rate:3.75, last_meeting:'2026-04-30', last_decision:'hold', last_bps:0  },
  JPY: { bank:'Bank of Japan',               short:'BOJ',  rate:0.75, last_meeting:'2026-04-28', last_decision:'hold', last_bps:0  },
  CAD: { bank:'Bank of Canada',              short:'BOC',  rate:2.25, last_meeting:'2026-04-29', last_decision:'hold', last_bps:0  },
  AUD: { bank:'Reserve Bank of Australia',   short:'RBA',  rate:4.35, last_meeting:'2026-05-05', last_decision:'hike', last_bps:25 },
  NZD: { bank:'Reserve Bank of New Zealand', short:'RBNZ', rate:2.25, last_meeting:'2026-05-27', last_decision:'hold', last_bps:0  },
  CHF: { bank:'Swiss National Bank',         short:'SNB',  rate:0.00, last_meeting:'2026-03-19', last_decision:'hold', last_bps:0  },
};

const { withSingleFlight } = require('./_fetch_lock');

const RATES_CACHE_KEY = 'cb_rates_live_v2';
const RATES_TTL_MS    = 6 * 60 * 60 * 1000; // 6 hours

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

const UA = 'Mozilla/5.0 (compatible; CBRateBot/1.0; +https://daun-merah.vercel.app)';

async function getText(url, timeout = 8000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function getJson(url, timeout = 8000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Reader CSV FRED keyless yang BENAR (fix audit S336, 2026-08-29). Dua jebakan
// yang sebelumnya bikin scrapeUSD SELALU gagal diam-diam:
//   1. FRED sudah mengganti nama kolom header dari `DATE` jadi `observation_date`,
//      jadi filter lama `!l.startsWith('DATE')` TIDAK lagi membuang header — baris
//      header jadi lines[0] dan parseFloat(nama seri) = NaN, fungsi selalu throw.
//   2. `fredgraph.csv` MENGABAIKAN `sort_order` & `limit` (diverifikasi live:
//      request limit=2 mengembalikan 6.467 baris urut ASCENDING). Jadi baris
//      pertama itu observasi TERTUA, bukan terbaru.
// Solusi: buang baris pertama apa pun (itu selalu header), lalu pindai dari
// BELAKANG untuk observasi valid pertama (FRED menandai data kosong dengan '.').
// Parameter sort_order/limit sengaja TIDAK dipasang — memang tidak berefek, dan
// memasangnya bikin pembaca kode berikutnya salah asumsi lagi.
function _parseFredCsvLatest(csv, seriesId) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error(seriesId + ': CSV FRED kosong');
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(',');
    const v = (parts[1] || '').trim();
    if (!v || v === '.') continue;
    const rate = parseFloat(v);
    if (isNaN(rate)) continue;
    return { rate, date: (parts[0] || '').trim() || null };
  }
  throw new Error(seriesId + ': tidak ada observasi valid di CSV FRED');
}

async function fetchFredCsvLatest(seriesId, timeout = 10000) {
  const csv = await getText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + seriesId, timeout);
  return _parseFredCsvLatest(csv, seriesId);
}

async function scrapeUSD() {
  // DFEDTARU = batas ATAS target range Fed. Sengaja DIPERTAHANKAN (bukan diganti
  // midpoint versi BIS yang 3.625) supaya angka yang tampil konsisten dengan
  // seluruh riwayat app ini dan dengan CB_FALLBACK.USD.
  return fetchFredCsvLatest('DFEDTARU');
}

async function scrapeEUR() {
  const json = await getJson(
    'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.MRR_FR.LEV?format=jsondata&lastNObservations=1&detail=dataonly'
  );
  const series  = json.dataSets?.[0]?.series;
  if (!series) throw new Error('EUR: no series');
  const firstSeries = Object.values(series)[0];
  const obs = firstSeries?.observations;
  if (!obs) throw new Error('EUR: no obs');
  const lastObs = obs[Object.keys(obs).sort((a, b) => +a - +b).pop()];
  const rate = parseFloat(lastObs?.[0]);
  if (isNaN(rate)) throw new Error('EUR: NaN');
  return { rate, date: null };
}

// GBP: BoE IADB (Interactive Database), seri IUDBEDR = Official Bank Rate harian.
// Menggantikan scraping halaman HTML yang MATI (audit S336: fetch balas 200 tapi 0
// match untuk ketiga regex lama — struktur halaman BoE berubah). IADB itu database
// statistik resmi BoE dengan format CSV stabil, bukan halaman marketing yang sering
// di-redesain. PENTING: endpoint ini membalas 302 — `fetch` Node mengikuti redirect
// secara default, tapi kalau logika ini pernah dipindah ke klien lain, redirect WAJIB
// diikuti; tanpa itu balasannya 302 body kosong dan parser di bawah akan throw.
async function scrapeGBP() {
  const MON  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmt  = d => String(d.getUTCDate()).padStart(2, '0') + '/' + MON[d.getUTCMonth()] + '/' + d.getUTCFullYear();
  const now  = new Date();
  const from = new Date(now.getTime() - 90 * 86400000); // 90 hari: Bank Rate diumumkan ~8x/tahun, pasti kena minimal 1 observasi
  const url  = 'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes'
             + '&Datefrom=' + fmt(from) + '&Dateto=' + fmt(now)
             + '&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N';
  const csv   = await getText(url, 10000);
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('GBP: CSV BoE kosong (redirect tidak diikuti?)');
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(',');
    const rate  = parseFloat((parts[1] || '').trim());
    if (!isNaN(rate)) return { rate, date: (parts[0] || '').trim() || null };
  }
  throw new Error('GBP: tidak ada observasi valid di CSV BoE');
}

async function scrapeCAD() {
  const json = await getJson('https://www.bankofcanada.ca/valet/observations/V39079/json?recent=1');
  const obs  = json.observations?.[0];
  const rate = parseFloat(obs?.V39079?.v);
  if (isNaN(rate)) throw new Error('CAD: NaN');
  return { rate, date: obs?.d || null };
}

// ── BIS WS_CBPOL — pengganti 4 scraper HTML yang mati (JPY/AUD/NZD/CHF) ───────
// Audit S336 (2026-08-29): keempat scraper situs resmi mati — BoJ 404, RBA HTTP 403,
// RBNZ HTTP 403, SNB 0 match regex. BIS Data Portal menerbitkan "Central bank policy
// rates" (dataflow WS_CBPOL) untuk semua negara ini dalam SATU dataset SDMX, gratis,
// tanpa key, dan membawa TANGGAL observasi (scraper lama semua mengembalikan
// date:null). Satu request untuk 4 currency sekaligus, bukan 4 request terpisah.
//
// Kenapa BIS TIDAK dipakai untuk USD & EUR walau datanya ada di sini juga:
//   - USD: BIS memakai MIDPOINT target range Fed (3.625), app ini memakai batas ATAS
//     (DFEDTARU, 3.75) di seluruh riwayatnya. Beda definisi, bukan beda kesegaran.
//   - EUR: BIS memakai main refinancing operations versi sendiri (2.25), sementara
//     scrapeEUR mengambil MRR_FR langsung dari API resmi ECB (2.40). Sumber primer
//     menang.
// Verifikasi live 2026-08-29 (deret bulanan, bukan satu titik): BIS menangkap dua
// kenaikan yang SELAMA INI TIDAK PERNAH MASUK ke app karena scraper-nya mati —
// BoJ 0.75 -> 1.0 (Juni 2026) dan RBNZ 2.25 -> 2.5 (Juli 2026).
const BIS_CBPOL_URL = 'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.JP+AU+NZ+CH?lastNObservations=1&format=csv';
const BIS_AREA_TO_CUR = { JP: 'JPY', AU: 'AUD', NZ: 'NZD', CH: 'CHF' };

// Parser CSV minimal yang menghormati field ber-tanda-kutip — WAJIB di sini karena
// kolom TITLE/COMPILATION BIS berisi koma di dalam kutip (split(',') polos menghasilkan
// kolom yang bergeser dan nilai yang salah).
function _splitCsvLine(line) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function _parseBisCbpol(csv) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('BIS: CSV kosong');
  const head = _splitCsvLine(lines[0]);
  const iArea = head.indexOf('REF_AREA'), iTime = head.indexOf('TIME_PERIOD'), iVal = head.indexOf('OBS_VALUE');
  if (iArea < 0 || iVal < 0) throw new Error('BIS: kolom REF_AREA/OBS_VALUE tidak ada (format berubah?)');
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const row = _splitCsvLine(lines[i]);
    const cur = BIS_AREA_TO_CUR[(row[iArea] || '').trim()];
    if (!cur) continue;
    const rate = parseFloat((row[iVal] || '').trim());
    if (isNaN(rate)) continue;
    out[cur] = { rate, date: (iTime >= 0 ? (row[iTime] || '').trim() : '') || null };
  }
  return out;
}

async function scrapeBisPolicyRates() {
  const csv = await getText(BIS_CBPOL_URL, 12000);
  const rates = _parseBisCbpol(csv);
  if (Object.keys(rates).length === 0) throw new Error('BIS: 0 currency terparse');
  return rates;
}

// Scraper per-currency yang punya sumber PRIMER sendiri. JPY/AUD/NZD/CHF tidak ada
// di sini — keempatnya diambil sekaligus lewat scrapeBisPolicyRates() di bawah.
const SCRAPERS = { USD: scrapeUSD, EUR: scrapeEUR, GBP: scrapeGBP, CAD: scrapeCAD };

// Ambang alarm (audit S336): kalau cakupan live turun di bawah ini, sesuatu di
// sumber luar berubah lagi dan kita WAJIB tahu. Sebelum ada alarm ini, 6 dari 8
// scraper mati berbulan-bulan tanpa satu pun sinyal — CB_FALLBACK menelan
// kegagalannya diam-diam, dan dua suku bunga (JPY, NZD) tertinggal 2-3 bulan.
const CB_COVERAGE_MIN = 6; // dari 8 currency

async function scrapeAllRates() {
  const [primary, bis] = await Promise.all([
    Promise.allSettled(Object.entries(SCRAPERS).map(async ([cur, fn]) => [cur, await fn()])),
    scrapeBisPolicyRates().catch(e => { console.warn('[cb-scrape] BIS gagal:', e.message); return {}; }),
  ]);

  const rates = {};
  const failed = [];
  for (const r of primary) {
    if (r.status === 'fulfilled') {
      const [cur, data] = r.value;
      rates[cur] = data;
      console.log(`[cb-scrape] ${cur}: ${data.rate}% (sumber primer)`);
    } else {
      failed.push(r.reason?.message || 'unknown');
      console.warn('[cb-scrape] gagal:', r.reason?.message);
    }
  }
  for (const [cur, data] of Object.entries(bis)) {
    rates[cur] = data;
    console.log(`[cb-scrape] ${cur}: ${data.rate}% (BIS, ${data.date || 'tanpa tanggal'})`);
  }

  const total = Object.keys(CB_FALLBACK).length;
  const live  = Object.keys(rates).length;
  if (live < CB_COVERAGE_MIN) {
    const missing = Object.keys(CB_FALLBACK).filter(c => !rates[c]);
    notifyCbCoverageDrop(live, total, missing, failed).catch(() => {});
  }
  return rates;
}

// Alarm Telegram sekali per 24 jam (dedup lewat Redis SET NX) supaya kegagalan
// scraper tidak lagi senyap, tapi juga tidak spam tiap kali cache 6 jam expired.
// Fail-silent total: alarm yang gagal TIDAK boleh menggagalkan pengambilan rate.
async function notifyCbCoverageDrop(live, total, missing, failed) {
  const lock = await redisCmd('SET', 'cb_rates_alert_lock', '1', 'EX', 86400, 'NX');
  if (!lock) return;
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  console.warn(`[cb-scrape] CAKUPAN TURUN: ${live}/${total} live, hilang: ${missing.join(',')}`);
  if (!token || !chat) return;
  const text = `Suku bunga bank sentral: cuma ${live}/${total} berhasil diambil live.\n`
             + `Hilang (pakai tabel statis): ${missing.join(', ')}\n`
             + (failed.length ? `Error: ${failed.slice(0, 4).join(' | ')}` : '');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
    signal: AbortSignal.timeout(6000),
  });
}

// Returns array of { currency, bank, short, rate, last_meeting, last_decision, last_bps, rate_source }
// rate_source: 'live_cached' | 'live_fresh' | 'fallback'
async function getLiveCbRates() {
  const now = Date.now();
  let liveRates  = {};
  let rateSource = 'fallback';

  try {
    const ratesRaw = await redisCmd('GET', RATES_CACHE_KEY);
    if (ratesRaw) {
      const obj = JSON.parse(ratesRaw);
      if (now - obj.fetchedAt < RATES_TTL_MS) {
        liveRates  = obj.rates;
        rateSource = 'live_cached';
      }
    }
  } catch(e) { console.warn('cb_rates cache load failed:', e.message); }

  if (Object.keys(liveRates).length === 0) {
    // Cache expired — single-flight lock. Without it, concurrent calls from
    // cb-status.js (CB Bias tab) and admin.js (fundamental_get) missing cache
    // at the same instant would each independently scrape all 8 official
    // central-bank sites (FRED, ECB, BoE, BoJ, BoC, RBA, RBNZ, SNB) — some of
    // those (BoE, RBA, SNB) are sensitive to bot-like traffic.
    const sf = await withSingleFlight(redisCmd, {
      lockKey: 'lock:cb_rates_live',
      cacheKey: RATES_CACHE_KEY,
      isFresh: (raw) => { try { return now - JSON.parse(raw).fetchedAt < RATES_TTL_MS; } catch(e) { return false; } },
    });
    if (!sf.gotLock && sf.fresh) {
      liveRates  = JSON.parse(sf.fresh).rates;
      rateSource = 'live_cached';
    } else {
      liveRates = await scrapeAllRates();
      if (Object.keys(liveRates).length > 0) {
        rateSource = 'live_fresh';
        redisCmd('SET', RATES_CACHE_KEY,
          JSON.stringify({ rates: liveRates, fetchedAt: now }),
          'EX', 7 * 3600
        ).catch(() => {});
      }
      if (sf.gotLock) sf.release();
    }
  }

  let cbDecisions = {};
  try {
    const raw = await redisCmd('HGETALL', 'cb_decisions');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { cbDecisions[raw[i]] = JSON.parse(raw[i + 1]); } catch(_) {}
      }
    }
  } catch(e) { console.warn('cb_decisions load failed:', e.message); }

  return Object.entries(CB_FALLBACK).map(([cur, fb]) =>
    mergeCbRate(cur, fb, liveRates[cur], cbDecisions[cur], liveRates[cur] ? rateSource : 'fallback')
  );
}

// Pure merge logic — diekstrak (2026-07-29) supaya bisa ditest langsung tanpa
// mock network scrape/Redis. `live`/`dec` boleh undefined.
//
// Diff vs CB_FALLBACK (baseline statis di source code) HANYA dipakai sebagai
// tebakan darurat kalau belum pernah ada keputusan tercatat dari headline
// (dec undefined) — mis. parser belum pernah nangkep rilis CB currency ini.
// `dec` (hasil parse headline resmi via cb_decisions) selalu menang kalau ada,
// karena itu sumber paling akurat (bukan cuma selisih angka vs baseline yang
// bisa basi kapan saja). Bug lama (2026-07-29): heuristik diff ini dulu SELALU
// menang kalau selisih >=5bps, walau dec sudah ada dan valid.
function mergeCbRate(cur, fb, live, dec, rateSource) {
  const rate = live?.rate ?? fb.rate;
  const diff = live?.rate != null ? Math.round((live.rate - fb.rate) * 100) : 0;
  const rateChanged = Math.abs(diff) >= 5;
  const useHeuristic = !dec && rateChanged;

  return {
    currency:      cur,
    bank:          fb.bank,
    short:         fb.short,
    rate,
    last_meeting:  dec?.last_meeting  || fb.last_meeting,
    last_decision: dec?.last_decision || (useHeuristic ? (diff > 0 ? 'hike' : 'cut') : fb.last_decision),
    last_bps:      dec?.last_bps ?? (useHeuristic ? diff : fb.last_bps),
    rate_source:   rateSource,
  };
}

// _parseFredCsvLatest & _parseBisCbpol diekspor untuk unit test (pure, tanpa network) —
// pola sama _parseCotPercentLine di api/feeds.js.
module.exports = { CB_FALLBACK, getLiveCbRates, mergeCbRate, RATES_CACHE_KEY, RATES_TTL_MS,
                   _parseFredCsvLatest, _parseBisCbpol, _splitCsvLine };
