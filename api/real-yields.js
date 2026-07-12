// api/real-yields.js
// Real (inflation-adjusted) yield per major currency.
// USD: FRED DGS10 (nominal 10Y) − FRED T10YIE (TIPS breakeven) = real yield.
// Others: FRED long-term bond yield − survey-based inflation expectation (hardcoded, refresh quarterly).
// Also includes: TGA + Fed Balance Sheet liquidity indicators, USD+EUR yield curve.
// Cached in Redis under 'real_yields' for 6 hours.

const { withSingleFlight } = require('./_fetch_lock')
const rateLimit = require('./_ratelimit')
const { fetchLabourSeries, computeLabourAssessment } = require('./_labour_market')

const CACHE_KEY = 'real_yields'
const CACHE_TTL = 6 * 60 * 60 // 6 hours in seconds

// US Labour Market Assessment (?section=labour) — menumpang function ini karena
// limit 12 serverless function Vercel Hobby sudah penuh. Logic di _labour_market.js.
// _v3: bust cache saat PAYEMS (NFP) ditambahkan sebagai indikator ke-9 (2026-07-10)
const LABOUR_CACHE_KEY = 'labour_market_v3'
const LABOUR_TTL = 6 * 60 * 60

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

// Hardcoded inflation expectations with mandatory source + refresh date.
// Update each quarter. If as_of > 90 days old, UI shows stale indicator.
const INFLATION_EXPECTATIONS = {
  // Source: ECB Survey of Professional Forecasters Q2 2026 — refresh Oct 2026
  EUR: { value: 2.0,  source: 'ECB SPF Q2 2026',    as_of: '2026-04-10' },
  // Source: BoE Inflation Attitudes Survey Feb 2026 — Q2 results published ~Aug 2026
  GBP: { value: 3.2,  source: 'BoE IAS Feb 2026',   as_of: '2026-02-12' },
  // Source: BoJ Tankan Q1 2026 — refresh Jul 2026 (Q2 Tankan published late Jun)
  JPY: { value: 2.6,  source: 'BoJ Tankan Q1 2026', as_of: '2026-03-28' },
  // Source: Bank of Canada MPR Apr 2026 — refresh Jul 2026
  CAD: { value: 2.2,  source: 'BoC MPR Apr 2026',   as_of: '2026-04-16' },
  // Source: RBA Statement on Monetary Policy May 2026 — refresh Aug 2026
  AUD: { value: 3.2,  source: 'RBA SoMP May 2026',  as_of: '2026-05-06' },
  // Source: RBNZ Monetary Policy Statement May 2026 — refresh Aug 2026
  NZD: { value: 2.1,  source: 'RBNZ MPS May 2026',  as_of: '2026-05-27' },
  // Source: SNB Inflation Forecast Mar 2026 (held at 0.00%) — refresh Jun 2026 meeting
  CHF: { value: 0.4,  source: 'SNB Mar 2026',       as_of: '2026-03-19' },
}

// FRED series IDs for 10Y government bond nominal yields (monthly for non-USD)
const FRED_NOMINAL_SERIES = {
  EUR: 'IRLTLT01EZM156N', // Euro area 10Y
  GBP: 'IRLTLT01GBM156N', // UK 10Y Gilt
  JPY: 'IRLTLT01JPM156N', // Japan 10Y JGB
  CAD: 'IRLTLT01CAM156N', // Canada 10Y
  AUD: 'IRLTLT01AUM156N', // Australia 10Y
  NZD: 'IRLTLT01NZM156N', // New Zealand 10Y
  CHF: 'IRLTLT01CHM156N', // Switzerland 10Y
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-cache')

  if (req.method === 'OPTIONS') return res.status(204).end()

  if (await rateLimit(req, res, { limit: 15, windowSecs: 60, endpoint: 'real-yields' })) return

  if (req.query && req.query.section === 'labour') return handleLabourSection(req, res)

  // Read all caches in parallel
  let mainCached = null, liquidityCached = null, yieldCurveCached = null
  try {
    ;[mainCached, liquidityCached, yieldCurveCached] = await Promise.all([
      redisCmd('GET', CACHE_KEY),
      redisCmd('GET', 'liquidity_usd'),
      redisCmd('GET', 'yield_curve'),
    ])
  } catch(e) { console.warn('real-yields: cache batch read failed:', e.message) }

  // Parse supplementary caches
  let liquidityData = null, yieldCurveData = null
  try {
    if (liquidityCached) {
      const l = JSON.parse(liquidityCached)
      if (Date.now() - new Date(l.computed_at).getTime() < 3600 * 1000) liquidityData = l
    }
    if (yieldCurveCached) {
      const y = JSON.parse(yieldCurveCached)
      if (Date.now() - new Date(y.computed_at).getTime() < 3600 * 1000) yieldCurveData = y
    }
  } catch(e) {}

  // Serve main cache if fresh, refreshing supplementary in the background if stale
  if (mainCached) {
    try {
      const parsed = JSON.parse(mainCached)
      const ageMs = Date.now() - new Date(parsed.computed_at).getTime()
      if (ageMs < CACHE_TTL * 1000) {
        const toRefresh = []
        if (!liquidityData) toRefresh.push(
          fetchLiquidityIndicators()
            .then(l => { liquidityData = l; redisCmd('SET', 'liquidity_usd', JSON.stringify(l), 'EX', 3600).catch(() => {}) })
            .catch(() => {})
        )
        if (!yieldCurveData) toRefresh.push(
          fetchYieldCurve()
            .then(y => { yieldCurveData = y; redisCmd('SET', 'yield_curve', JSON.stringify(y), 'EX', 3600).catch(() => {}) })
            .catch(() => {})
        )
        await Promise.allSettled(toRefresh)
        return res.status(200).json({ ...parsed, liquidity: liquidityData, yield_curve: yieldCurveData })
      }
    } catch(e) {
      console.warn('real-yields: Redis GET failed:', e.message)
    }
  }

  // Cache expired — single-flight lock. The fresh path below fans out to 16+
  // FRED/ECB calls; without this, concurrent requests at the same TTL-expiry
  // instant would each independently do that whole fan-out.
  const mainSf = await withSingleFlight(redisCmd, {
    lockKey: 'lock:real_yields',
    cacheKey: CACHE_KEY,
    isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < CACHE_TTL * 1000 } catch(e) { return false } },
  })
  if (!mainSf.gotLock && mainSf.fresh) {
    const parsed = JSON.parse(mainSf.fresh)
    return res.status(200).json({ ...parsed, liquidity: liquidityData, yield_curve: yieldCurveData })
  }

  // ── Fetch everything fresh ──────────────────────────────────────────────────

  // Inflation expectations: hardcoded quarterly values, update manually each quarter.
  // OECD stats.oecd.org (deprecated 2025) and sdmx.oecd.org (Cloudflare-blocked from Vercel)
  // are both inaccessible — hardcoded data is the only reliable path.
  const inflationExp = {}
  for (const [cur, inf] of Object.entries(INFLATION_EXPECTATIONS)) {
    inflationExp[cur] = { ...inf }
  }

  // Fetch all yields + liquidity + yield curve + Cleveland Fed in parallel
  // EXPINF10YR = Cleveland Fed 10-year inflation expectation (model-based, monthly, via FRED)
  // Used as fallback when TIPS breakeven (T10YIE) is unavailable; also cross-validates TIPS.
  const otherCurrencies = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF']

  const [
    usdNomResult,
    usdBEResult,
    usdClevFedResult,
    liquidityResult,
    yieldCurveResult,
    ecbSpfResult,
    ...otherNomResults
  ] = await Promise.allSettled([
    fetchFred('DGS10'),
    fetchFred('T10YIE'),
    fetchFred('EXPINF10YR'),
    fetchLiquidityIndicators(),
    fetchYieldCurve(),
    fetchEcbSpfEur(),
    ...otherCurrencies.map(cur =>
      fetchFred(FRED_NOMINAL_SERIES[cur])
        .then(d => ({ cur, data: d }))
        .catch(e => { console.warn(`real-yields: ${cur} nominal fetch failed:`, e.message); return { cur, data: null } })
    ),
  ])

  // EUR: ekspektasi inflasi dari ECB SPF live (API yang sama dengan yield curve EUR) —
  // menggantikan hardcode kuartalan KHUSUS untuk EUR; 6 mata uang lain tetap hardcode
  // karena survei mereka memang tidak punya API (audit vendor 2026-07-12). Gagal fetch →
  // hardcode tetap dipakai (fallback, bukan error).
  if (ecbSpfResult.status === 'fulfilled' && ecbSpfResult.value) {
    const spf = ecbSpfResult.value
    inflationExp.EUR = {
      value: spf.value,
      source: `ECB SPF ${spf.period || 'live'} (auto)`,
      as_of: new Date().toISOString().slice(0, 10),
    }
  }

  // Process supplementary results
  if (liquidityResult.status === 'fulfilled') {
    liquidityData = liquidityResult.value
    redisCmd('SET', 'liquidity_usd', JSON.stringify(liquidityData), 'EX', 3600).catch(() => {})
  }
  if (yieldCurveResult.status === 'fulfilled') {
    yieldCurveData = yieldCurveResult.value
    redisCmd('SET', 'yield_curve', JSON.stringify(yieldCurveData), 'EX', 3600).catch(() => {})
  }

  const results = {}

  // USD: nominal from FRED DGS10.
  // Inflation expectation: primary = TIPS T10YIE (market-implied, daily);
  // fallback = Cleveland Fed EXPINF10YR (model-based, monthly, published via FRED).
  try {
    if (usdNomResult.status !== 'fulfilled') throw new Error(usdNomResult.reason?.message)
    const nominal = usdNomResult.value.latest
    const tipsBE    = usdBEResult.status    === 'fulfilled' ? usdBEResult.value.latest    : null
    const clevFedBE = usdClevFedResult.status === 'fulfilled' ? usdClevFedResult.value.latest : null
    const inflation_exp = tipsBE ?? clevFedBE
    if (inflation_exp == null) throw new Error('USD: no inflation expectation (TIPS + Cleveland Fed both unavailable)')
    const real = +(nominal - inflation_exp).toFixed(2)
    const source_inflation = tipsBE != null
      ? `FRED T10YIE (TIPS breakeven)${clevFedBE != null ? ` · Cleveland Fed 10yr: ${clevFedBE}%` : ''}`
      : `Cleveland Fed EXPINF10YR (TIPS unavailable)`
    results.USD = {
      nominal, inflation_exp, real,
      source_nominal: 'FRED DGS10',
      source_inflation,
      cleveland_fed_exp: clevFedBE,
      as_of: usdNomResult.value.date,
      stale: false,
    }
  } catch(e) {
    console.warn('real-yields: USD fetch failed:', e.message)
  }

  // Other currencies: FRED monthly nominal + inflation expectation (hardcoded or OECD)
  for (const nomResult of otherNomResults) {
    if (nomResult.status !== 'fulfilled') continue
    const { cur, data } = nomResult.value
    const inf = inflationExp[cur]
    if (!inf) continue

    const staleDays = (Date.now() - new Date(inf.as_of).getTime()) / 86400000
    const stale = staleDays > 90

    if (!data) {
      results[cur] = {
        nominal: null, inflation_exp: inf.value, real: null,
        source_nominal: FRED_NOMINAL_SERIES[cur],
        source_inflation: inf.source,
        inflation_as_of: inf.as_of,
        as_of: null,
        stale,
        error: 'nominal_unavailable',
      }
      continue
    }

    const nominal = data.latest
    const real = +(nominal - inf.value).toFixed(2)
    results[cur] = {
      nominal, inflation_exp: inf.value, real,
      source_nominal: FRED_NOMINAL_SERIES[cur],
      source_inflation: inf.source,
      inflation_as_of: inf.as_of,
      as_of: data.date,
      stale,
    }
  }

  if (Object.keys(results).length === 0) {
    if (mainSf.gotLock) mainSf.release()
    // All failed — return stale cache with supplementary
    try {
      const stale = await redisCmd('GET', CACHE_KEY)
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true, liquidity: liquidityData, yield_curve: yieldCurveData })
    } catch(e) {}
    return res.status(502).json({ error: 'All real yield sources unavailable' })
  }

  const payload = { currencies: results, computed_at: new Date().toISOString() }

  redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL)
    .catch(e => console.warn('real-yields: Redis SET failed:', e.message))
  if (mainSf.gotLock) mainSf.release()

  return res.status(200).json({ ...payload, liquidity: liquidityData, yield_curve: yieldCurveData })
}

// ── US Labour Market Assessment (?section=labour) ────────────────────────────
// Pola sama dengan main path: cache Redis 6 jam → single-flight lock → compute →
// gagal semua → serve cache stale, atau 502 kalau tidak ada cache sama sekali.

async function handleLabourSection(req, res) {
  try {
    const cached = await redisCmd('GET', LABOUR_CACHE_KEY)
    if (cached) {
      const d = JSON.parse(cached)
      if (Date.now() - new Date(d.computed_at).getTime() < LABOUR_TTL * 1000) {
        return res.status(200).json({ ...d, stale: false })
      }
    }
  } catch(e) { console.warn('labour: cache read failed:', e.message) }

  // Redis down tidak boleh menggagalkan response — fallback ke compute tanpa lock
  let sf = { gotLock: false, fresh: null, release: () => {} }
  try {
    sf = await withSingleFlight(redisCmd, {
      lockKey: 'lock:labour_market',
      cacheKey: LABOUR_CACHE_KEY,
      isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).computed_at).getTime() < LABOUR_TTL * 1000 } catch(e) { return false } },
    })
  } catch(e) { console.warn('labour: single-flight failed:', e.message) }
  if (!sf.gotLock && sf.fresh) return res.status(200).json({ ...JSON.parse(sf.fresh), stale: false })

  try {
    const obsList = await fetchLabourSeries(fetch)
    const assessment = computeLabourAssessment(obsList)
    if (assessment.agreement.available === 0) throw new Error('all labour series unavailable')

    const payload = { ...assessment, computed_at: new Date().toISOString() }
    redisCmd('SET', LABOUR_CACHE_KEY, JSON.stringify(payload), 'EX', LABOUR_TTL)
      .catch(e => console.warn('labour: Redis SET failed:', e.message))
    if (sf.gotLock) sf.release()
    return res.status(200).json({ ...payload, stale: false })
  } catch(e) {
    console.warn('labour: compute failed:', e.message)
    if (sf.gotLock) sf.release()
    try {
      const stale = await redisCmd('GET', LABOUR_CACHE_KEY)
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true })
    } catch(_) {}
    return res.status(502).json({ error: 'Labour market data unavailable' })
  }
}

// ── TGA + Fed Balance Sheet Liquidity Indicators ─────────────────────────────
// WDTGAL = US Treasury General Account (Fed H.4.1, Wednesday levels) via FRED.
// fiscaldata.treasury.gov is blocked from Vercel datacenter IPs — FRED is the reliable path.

async function fetchLiquidityIndicators() {
  // RRPONTSYD = ON Reverse Repo (miliar USD, harian) — kaki ketiga formula net
  // liquidity standar: WALCL − TGA − RRP (audit vendor 2026-07-12). Tanpa RRP,
  // drain TGA yang cuma pindah parkir ke RRP terbaca keliru sebagai perubahan
  // likuiditas pasar.
  const [fedAssetsResult, tgaResult, rrpResult] = await Promise.allSettled([
    fetchFred('WALCL'),
    fetchFredMulti('WDTGAL', 2),
    fetchFredMulti('RRPONTSYD', 2),
  ])

  const result = { computed_at: new Date().toISOString() }

  if (fedAssetsResult.status === 'fulfilled') {
    result.fed_assets_bn = Math.round(fedAssetsResult.value.latest / 1000)
    result.fed_assets_date = fedAssetsResult.value.date
  }

  if (tgaResult.status === 'fulfilled') {
    const obs = tgaResult.value
    if (obs.length > 0) {
      result.tga_balance_bn = Math.round(obs[0].value / 1000)
      result.tga_date = obs[0].date
      if (obs.length > 1) {
        result.tga_change_bn = result.tga_balance_bn - Math.round(obs[1].value / 1000)
      }
    }
  }

  if (rrpResult.status === 'fulfilled') {
    const obs = rrpResult.value
    if (obs.length > 0) {
      // RRPONTSYD sudah dalam miliar (beda dari WALCL/WDTGAL yang jutaan)
      result.rrp_bn = Math.round(obs[0].value)
      result.rrp_date = obs[0].date
      if (obs.length > 1) result.rrp_change_bn = result.rrp_bn - Math.round(obs[1].value)
    }
  }

  if (result.fed_assets_bn != null && result.tga_balance_bn != null && result.rrp_bn != null) {
    result.net_liquidity_bn = result.fed_assets_bn - result.tga_balance_bn - result.rrp_bn
  }

  return result
}

// ── ECB SPF — ekspektasi inflasi longer-term euro area (kuartalan) ────────────
// Dataflow SPF, key Q.U2.HICP.POINT.LT.Q.AVG = rata-rata point forecast HICP
// longer-term. Diverifikasi live 2026-07-12: nilai ~2.03%, konsisten dengan
// hardcode lama 2.0 (ECB SPF Q2 2026). API yang sama dengan yield curve EUR.
async function fetchEcbSpfEur() {
  const url = 'https://data-api.ecb.europa.eu/service/data/SPF/Q.U2.HICP.POINT.LT.Q.AVG?format=jsondata&lastNObservations=1'
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`ECB SPF HTTP ${r.status}`)
  const j = await r.json()
  const seriesObj = j?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0']?.observations
  if (!seriesObj) return null
  const keys = Object.keys(seriesObj).sort((a, b) => +b - +a)
  const raw = seriesObj[keys[0]]?.[0]
  const value = parseFloat(raw)
  if (isNaN(value) || value < -2 || value > 15) return null
  // Label periode (mis. "2026-Q3") dari dimensi waktu — best-effort, boleh null
  let period = null
  try {
    const timeDim = (j?.structure?.dimensions?.observation || []).find(d => d.id === 'TIME_PERIOD')
    period = timeDim?.values?.[+keys[0]]?.id || timeDim?.values?.[+keys[0]]?.name || null
  } catch(e) {}
  return { value: +value.toFixed(2), period }
}

// ── Yield Curve (USD from FRED, EUR from ECB SDW) ────────────────────────────

async function fetchYieldCurve() {
  const result = { computed_at: new Date().toISOString() }

  // USD: 4 FRED series in parallel (DGS10 already fetched above, but re-fetch here independently)
  const [dgs2, dgs5, dgs10, dgs30] = await Promise.allSettled([
    fetchFred('DGS2'), fetchFred('DGS5'), fetchFred('DGS10'), fetchFred('DGS30'),
  ])

  const usd = {}
  if (dgs2.status  === 'fulfilled') usd['2y']  = dgs2.value.latest
  if (dgs5.status  === 'fulfilled') usd['5y']  = dgs5.value.latest
  if (dgs10.status === 'fulfilled') usd['10y'] = dgs10.value.latest
  if (dgs30.status === 'fulfilled') usd['30y'] = dgs30.value.latest
  if (usd['2y'] != null && usd['10y'] != null)
    usd['spread_2y10y'] = +(usd['10y'] - usd['2y']).toFixed(3)
  if (Object.keys(usd).length > 0) result.USD = usd

  // EUR: ECB Statistical Data Warehouse (2Y + 10Y)
  try {
    const [eur2yRes, eur10yRes] = await Promise.allSettled([
      fetch('https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=jsondata&lastNObservations=1', { signal: AbortSignal.timeout(8000) }),
      fetch('https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata&lastNObservations=1', { signal: AbortSignal.timeout(8000) }),
    ])

    const parseEcb = async (res) => {
      if (res.status !== 'fulfilled' || !res.value.ok) return null
      const j = await res.value.json()
      const series = j?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0']?.observations
      if (!series) return null
      const keys = Object.keys(series).sort((a, b) => +b - +a)
      return series[keys[0]]?.[0] ?? null
    }

    const [e2y, e10y] = await Promise.all([parseEcb(eur2yRes), parseEcb(eur10yRes)])
    const eur = {}
    if (e2y  != null) eur['2y']  = +parseFloat(e2y).toFixed(3)
    if (e10y != null) eur['10y'] = +parseFloat(e10y).toFixed(3)
    if (eur['2y'] != null && eur['10y'] != null)
      eur['spread_2y10y'] = +(eur['10y'] - eur['2y']).toFixed(3)
    if (Object.keys(eur).length > 0) result.EUR = eur
  } catch(e) { console.warn('fetchYieldCurve EUR failed:', e.message) }

  return result
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function fetchFred(seriesId) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&limit=5&sort_order=desc&file_type=json`
  const r = await fetch(url, {
    headers: { 'User-Agent': 'DaunMerah/1.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`)

  const json = await r.json()
  const obs = (json.observations || []).filter(o => o.value !== '.')
  if (obs.length === 0) throw new Error(`FRED ${seriesId}: no valid observations`)

  return { latest: parseFloat(obs[0].value), date: obs[0].date }
}

// Fetch N most recent observations for a FRED series (used for change calculations).
async function fetchFredMulti(seriesId, limit = 2) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&limit=${limit}&sort_order=desc&file_type=json`
  const r = await fetch(url, {
    headers: { 'User-Agent': 'DaunMerah/1.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`)

  const json = await r.json()
  const obs = (json.observations || []).filter(o => o.value !== '.')
  if (obs.length === 0) throw new Error(`FRED ${seriesId}: no valid observations`)

  return obs.map(o => ({ value: parseFloat(o.value), date: o.date }))
}

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!REDIS_URL || !REDIS_TOKEN) return null
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  return (await r.json()).result
}

// Ekspor helper murni untuk unit/live test — properti tambahan pada handler
// function tidak mengubah perilaku Vercel (pola sama dengan feeds.js).
module.exports.fetchEcbSpfEur = fetchEcbSpfEur
