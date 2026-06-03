// api/risk-regime.js
// Classifies global risk regime: Risk-On / Neutral / Risk-Off
// Sources: FRED (VIX, HY OAS), Stooq (MOVE index)
// Cached in Redis under 'risk_regime' for 30 minutes (data is EOD, refreshing more often is wasteful)

const cb = require('./_circuit_breaker');

const CACHE_KEY = 'risk_regime'
const CACHE_TTL = 5 * 60 // 5 minutes — VIX now from Yahoo (15-min delay), worth refreshing often

// FRED series: VIXCLS = CBOE VIX, BAMLH0A0HYM2 = ICE BofA US HY OAS spread
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'
const STOOQ_MOVE = 'https://stooq.com/q/d/l/?s=%5emove&i=d&l=5'

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
]

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-cache')

  if (req.method === 'OPTIONS') return res.status(204).end()

  // Serve Redis cache if fresh
  try {
    const cached = await redisCmd('GET', CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      const ageMs = Date.now() - new Date(parsed.computed_at).getTime()
      if (ageMs < CACHE_TTL * 1000) {
        return res.status(200).json(parsed)
      }
    }
  } catch (e) {
    console.warn('risk-regime: Redis GET failed:', e.message)
  }

  // Fetch all sources in parallel; partial failures are tolerable.
  // VIX: Yahoo Finance primary (near real-time, 15-min delay) → FRED fallback (EOD).
  // MOVE + HY: EOD only — no free real-time alternative exists.
  const [stooqAllowed, fredAllowed] = await Promise.all([
    cb.canCall('stooq'),
    cb.canCall('fred'),
  ])

  const [vixResult, moveResult, hyResult, vix1mResult, vix3mResult] = await Promise.allSettled([
    fetchYahooVix(),
    stooqAllowed ? fetchMove()                      : Promise.reject(new Error('circuit:stooq OPEN')),
    fredAllowed  ? fetchFredSeries('BAMLH0A0HYM2') : Promise.reject(new Error('circuit:fred OPEN')),
    fetchYahooVixTerm('^VIX1M'),
    fetchYahooVixTerm('^VIX3M'),
  ])

  // VIX: use Yahoo result; fall back to FRED if Yahoo failed
  let vixData = vixResult.status === 'fulfilled' ? vixResult.value : null
  if (!vixData && fredAllowed) {
    console.warn('risk-regime: Yahoo VIX failed, trying FRED fallback')
    try {
      vixData = await fetchFredSeries('VIXCLS')
      if (vixData) vixData.source = 'fred'
    } catch(e) {
      console.warn('risk-regime: FRED VIX fallback also failed:', e.message)
      cb.onFailure('fred').catch(() => {})
    }
  }

  const moveData = moveResult.status === 'fulfilled' ? moveResult.value : null
  const hyData   = hyResult.status   === 'fulfilled' ? hyResult.value   : null

  if (stooqAllowed) {
    if (moveData) cb.onSuccess('stooq').catch(() => {});
    else          cb.onFailure('stooq').catch(() => {});
  }
  if (fredAllowed && hyData) cb.onSuccess('fred').catch(() => {})

  if (!vixData)  console.warn('risk-regime: VIX fetch failed (Yahoo + FRED both failed)')
  if (!moveData) console.warn('risk-regime: MOVE fetch failed — Stooq may have blocked')
  if (!hyData)   console.warn('risk-regime: HY spread fetch failed')

  // All three sources failed — return stale cache rather than empty error
  if (!vixData && !moveData && !hyData) {
    try {
      const stale = await redisCmd('GET', CACHE_KEY)
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true })
    } catch (e) {}
    return res.status(502).json({ error: 'All data sources unavailable' })
  }

  const vix1mData = vix1mResult.status === 'fulfilled' ? vix1mResult.value : null
  const vix3mData = vix3mResult.status === 'fulfilled' ? vix3mResult.value : null

  const vix      = vixData  ? vixData.latest  : null
  const move     = moveData ? moveData.latest  : null
  const hySpread = hyData   ? hyData.latest    : null
  // 2-day changes: positive = rising/widening
  const vixChange  = vixData  && vixData.prev  != null ? +(vixData.latest  - vixData.prev).toFixed(2)  : null
  const moveChange = moveData && moveData.prev != null ? +(moveData.latest - moveData.prev).toFixed(1) : null
  const hyChange   = hyData   && hyData.prev   != null ? +(hyData.latest   - hyData.prev).toFixed(4)   : null

  const components = {
    vix_trigger:  vix  != null ? vix  > 25          : null,
    move_trigger: move != null ? move > 130          : null,
    hy_trigger:   hyChange != null ? hyChange > 0.15 : null,
  }

  const regime = classifyRegime(vix, move, hyChange, hySpread)

  // eod_date: most recent date from EOD sources (MOVE + HY) — shown in UI as "Data [tanggal]"
  // vix_date: separate, used only when vix_source = 'fred' (also EOD)
  const eodDate  = [moveData?.date, hyData?.date].filter(Boolean).sort().pop() || null
  const vixDate  = vixData?.date || null

  // VIX term structure: contango vs backwardation
  let vixTermStructure = null
  if (vix != null && (vix1mData || vix3mData)) {
    const vix1m = vix1mData?.latest ?? null
    const vix3m = vix3mData?.latest ?? null
    let structure = null
    if (vix1m != null) {
      structure = vix > vix1m ? 'backwardation' : 'contango'
    }
    vixTermStructure = { vix_spot: vix, vix_1m: vix1m, vix_3m: vix3m, structure }
  }

  const payload = {
    regime,
    vix,
    vix_change_2d: vixChange,
    vix_source: vixData?.source || null, // 'yahoo' = near real-time | 'fred' = EOD fallback
    vix_term_structure: vixTermStructure,
    move,
    move_change_2d: moveChange,
    hy_spread: hySpread,
    hy_change_2d: hyChange,
    components,
    computed_at: new Date().toISOString(),
    data_date: eodDate,   // EOD label (MOVE + HY)
    vix_date:  vixDate,   // kept for debugging; frontend uses vix_source to decide display
  }

  redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL).catch(e => {
    console.warn('risk-regime: Redis SET failed:', e.message)
  })

  return res.status(200).json(payload)
}

// ── Classifier ────────────────────────────────────────────────────────────────

function classifyRegime(vix, move, hyChange) {
  const triggers = {
    riskOff: [],
    riskOn:  [],
  }

  if (vix  != null && vix  > 25)          triggers.riskOff.push('vix')
  if (move != null && move > 130)          triggers.riskOff.push('move')
  if (hyChange != null && hyChange > 0.15) triggers.riskOff.push('hy_widening')

  // Risk-On requires ALL three available metrics to be benign
  const vixOk  = vix  == null || vix  < 15
  const moveOk = move == null || move < 90
  const hyOk   = hyChange == null || hyChange <= 0

  if (triggers.riskOff.length > 0)        return 'risk_off'
  if (vixOk && moveOk && hyOk)            return 'risk_on'
  return 'neutral'
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

// Yahoo Finance ^VIX — near real-time (15-min delay), updates during market hours
async function fetchYahooVix() {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=5m', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error(`Yahoo VIX HTTP ${r.status}`)
  const json = await r.json()
  const meta  = json?.chart?.result?.[0]?.meta
  const price = meta?.regularMarketPrice
  const prev  = meta?.previousClose || meta?.chartPreviousClose
  if (!price || price <= 0) throw new Error('Yahoo VIX: no valid price')
  const marketTime = meta?.regularMarketTime
  const date = marketTime
    ? new Date(marketTime * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)
  return { latest: +price.toFixed(2), prev: prev ? +prev.toFixed(2) : null, date, source: 'yahoo' }
}

// Yahoo Finance VIX term structure — ^VIX1M (30-day) and ^VIX3M (3-month)
async function fetchYahooVixTerm(symbol) {
  const encoded = encodeURIComponent(symbol)
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=5m`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`)
  const json = await r.json()
  const meta  = json?.chart?.result?.[0]?.meta
  const price = meta?.regularMarketPrice
  if (!price || price <= 0) throw new Error(`Yahoo ${symbol}: no valid price`)
  return { latest: +price.toFixed(2), symbol }
}

async function fetchFredSeries(seriesId) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&limit=5&sort_order=desc&file_type=json`
  const r = await fetch(url, {
    headers: { 'User-Agent': 'DaunMerah/1.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`)

  const json = await r.json()
  // observations are sorted desc; filter out missing values ('.')
  const obs = (json.observations || []).filter(o => o.value !== '.')
  if (obs.length === 0) throw new Error(`FRED ${seriesId}: no valid observations`)

  return {
    latest: parseFloat(obs[0].value),
    prev:   obs.length > 2 ? parseFloat(obs[2].value) : null, // ~2 trading days ago
    date:   obs[0].date,
  }
}

async function fetchMove() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
  const r = await fetch(STOOQ_MOVE, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`Stooq MOVE HTTP ${r.status}`)

  const csv = await r.text()
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('Date'))
  if (lines.length === 0) throw new Error('Stooq MOVE: empty CSV')

  // CSV columns: Date,Open,High,Low,Close,Volume — use Close
  const parse = line => {
    const cols = line.split(',')
    return { date: cols[0], close: parseFloat(cols[4]) }
  }

  const rows = lines.map(parse).filter(r => !isNaN(r.close))
  if (rows.length === 0) throw new Error('Stooq MOVE: no parseable rows')

  // Stooq returns newest-first
  return {
    latest: rows[0].close,
    prev:   rows.length > 2 ? rows[2].close : null,
    date:   rows[0].date,
  }
}

// ── Redis helper (matches cot.js pattern) ────────────────────────────────────

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!REDIS_URL || !REDIS_TOKEN) return null
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  return (await res.json()).result
}
