// api/_labour_market.js
// US Labour Market Assessment — RULE-BASED, bukan prediksi/ML (pasca kill-gate riset
// NFP S150/S151/S153). Merangkum 8 seri FRED gratis jadi satu label ordinal
// ("X dari Y indikator searah") sebagai KONTEKS positioning, bukan edge — data
// sudah priced-in ke konsensus. Tiga syarat wajib (memory labour-market-assessment-pivot):
//   1. Confidence ordinal berbasis agreement count — TANPA persen.
//   2. Narasi antar-indikator dibingkai teori ekonomi ("secara teori..."), bukan
//      temuan empiris kita (lead-lag terbukti tidak robust di Fase 1).
//   3. Positioning jujur: "konteks, bukan sinyal".
// Underscore prefix = bukan serverless function (limit Vercel Hobby 12/12 sudah penuh);
// di-serve lewat api/real-yields.js?section=labour.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

// band: lebar zona "flat" (dua sisi). bandKind: 'pct' = % relatif terhadap pembanding,
// 'pp' = poin persentase absolut, 'abs' = satuan seri (ribuan utk ADP).
// invert: true = kenaikan metrik berarti pasar tenaga kerja MELEMAH (klaim/layoffs).
const LABOUR_INDICATORS = [
  { id: 'JTSJOL',        label: 'JOLTS Openings',  dim: 'HIRING',  invert: false, cadence: 'monthly', limit: 12, method: 'latest_vs_mean6',      band: 1.5, bandKind: 'pct', fmt: 'kJt',
    theory: 'lowongan kerja terbuka — proxy permintaan tenaga kerja' },
  { id: 'JTSQUR',        label: 'Quits Rate',      dim: 'HIRING',  invert: false, cadence: 'monthly', limit: 12, method: 'latest_vs_mean6',      band: 0.1, bandKind: 'pp',  fmt: 'pct1',
    theory: 'quits tinggi secara teori = pekerja pede pindah kerja' },
  // scale 0.001: seri FRED ini berunit ORANG (level ~134 juta), bukan ribuan —
  // dinormalisasi ke ribuan supaya band ±25 berarti ±25 ribu & display benar
  // (terverifikasi dari data live 2026-07-10: tanpa scale, display "+108333rb/bln")
  { id: 'ADPMNUSNERSA',  label: 'ADP Employment',  dim: 'HIRING',  invert: false, cadence: 'monthly', limit: 12, method: 'delta3m_vs_prior3m',   band: 25,  bandKind: 'abs', fmt: 'deltaK', scale: 0.001,
    theory: 'laju penambahan payroll swasta (rata-rata 3 bulan)' },
  { id: 'TEMPHELPS',     label: 'Temp Help',       dim: 'HIRING',  invert: false, cadence: 'monthly', limit: 12, method: 'mean3_vs_prior3',      band: 0.5, bandKind: 'pct', fmt: 'kJt',
    theory: 'temp hiring secara teori sering bergerak duluan' },
  { id: 'ICSA',          label: 'Initial Claims',  dim: 'LAYOFFS', invert: true,  cadence: 'weekly',  limit: 26, method: 'mean4w_vs_prior13w',   band: 3,   bandKind: 'pct', fmt: 'rawRb',
    theory: 'klaim pengangguran baru — naik = PHK meningkat' },
  { id: 'CCSA',          label: 'Continued Claims',dim: 'LAYOFFS', invert: true,  cadence: 'weekly',  limit: 26, method: 'mean4w_vs_prior13w',   band: 2,   bandKind: 'pct', fmt: 'rawJt',
    theory: 'klaim berlanjut — naik = makin sulit dapat kerja baru' },
  { id: 'JTSLDR',        label: 'Layoffs Rate',    dim: 'LAYOFFS', invert: true,  cadence: 'monthly', limit: 12, method: 'latest_vs_mean6',      band: 0.1, bandKind: 'pp',  fmt: 'pct1',
    theory: 'tingkat pemutusan kerja JOLTS' },
  { id: 'CES0500000003', label: 'Avg Hourly Earn', dim: 'WAGE',    invert: false, cadence: 'monthly', limit: 12, method: 'ahe_annualized_3m',    band: 0.3, bandKind: 'pp',  fmt: 'aheAnn',
    theory: 'akselerasi upah secara teori dibaca sebagai pasar kerja ketat' },
]

const DIMENSIONS = ['HIRING', 'LAYOFFS', 'WAGE']
const STALE_DAYS = { weekly: 21, monthly: 75 } // > 2× kadens normal → tandai stale

function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length }

function _fmtValue(fmt, v) {
  if (v == null || !isFinite(v)) return '—'
  switch (fmt) {
    case 'kJt':    return (v / 1000).toFixed(2) + 'jt'      // seri dalam ribuan → juta
    case 'rawRb':  return Math.round(v / 1000) + 'rb'       // seri dalam orang → ribu
    case 'rawJt':  return (v / 1e6).toFixed(2) + 'jt'       // seri dalam orang → juta
    case 'pct1':   return v.toFixed(1) + '%'
    case 'deltaK': return (v >= 0 ? '+' : '') + Math.round(v) + 'rb/bln'
    case 'aheAnn': return (v >= 0 ? '+' : '') + v.toFixed(1) + '% ann.'
    default:       return String(v)
  }
}

// obs = [{value, date}] TERURUT DESC (terbaru duluan) — pola fetchFredMulti existing.
// Return { id, label, dim, status, value, display, detail, as_of, stale }.
function classifyIndicator(cfg, obs, nowMs = Date.now()) {
  const base = { id: cfg.id, label: cfg.label, dim: cfg.dim, theory: cfg.theory }
  const unavailable = (why) => ({ ...base, status: 'unavailable', raw: null, value: null, display: '—', detail: why, as_of: null, stale: false })
  if (!Array.isArray(obs) || obs.length === 0) return unavailable('data tidak tersedia')

  const v = obs.map(o => o.value)
  let diff = null       // metrik perbandingan, satuan mengikuti bandKind
  let displayVal = null // angka yang ditampilkan di chip
  let detail = ''

  if (cfg.method === 'latest_vs_mean6') {
    if (v.length < 7) return unavailable('observasi kurang (butuh ≥7)')
    const latest = v[0], m = _mean(v.slice(1, 7))
    diff = cfg.bandKind === 'pct' ? (latest - m) / m * 100 : latest - m
    displayVal = latest
    detail = `Terkini ${_fmtValue(cfg.fmt, latest)} vs rata-rata 6 bln ${_fmtValue(cfg.fmt, m)}`
  } else if (cfg.method === 'delta3m_vs_prior3m') {
    if (v.length < 7) return unavailable('observasi kurang (butuh ≥7)')
    const deltas = []
    for (let i = 0; i < 6; i++) deltas.push(v[i] - v[i + 1])
    const recent = _mean(deltas.slice(0, 3)), prior = _mean(deltas.slice(3, 6))
    diff = recent - prior // satuan ribuan (seri ADP dalam ribuan)
    displayVal = recent
    detail = `Rata-rata Δ 3 bln terakhir ${_fmtValue('deltaK', recent)} vs 3 bln sebelumnya ${_fmtValue('deltaK', prior)}`
  } else if (cfg.method === 'mean3_vs_prior3') {
    if (v.length < 6) return unavailable('observasi kurang (butuh ≥6)')
    const recent = _mean(v.slice(0, 3)), prior = _mean(v.slice(3, 6))
    diff = (recent - prior) / prior * 100
    displayVal = recent
    detail = `Rata-rata 3 bln terakhir ${_fmtValue(cfg.fmt, recent)} vs 3 bln sebelumnya ${_fmtValue(cfg.fmt, prior)}`
  } else if (cfg.method === 'mean4w_vs_prior13w') {
    if (v.length < 17) return unavailable('observasi kurang (butuh ≥17)')
    const recent = _mean(v.slice(0, 4)), prior = _mean(v.slice(4, 17))
    diff = (recent - prior) / prior * 100
    displayVal = recent
    detail = `Rata-rata 4 mgg terakhir ${_fmtValue(cfg.fmt, recent)} vs 13 mgg sebelumnya ${_fmtValue(cfg.fmt, prior)}`
  } else if (cfg.method === 'ahe_annualized_3m') {
    if (v.length < 7) return unavailable('observasi kurang (butuh ≥7)')
    if (v[3] <= 0 || v[6] <= 0) return unavailable('level tidak valid')
    const gRecent = (Math.pow(v[0] / v[3], 4) - 1) * 100 // growth 3 bln, annualized
    const gPrior  = (Math.pow(v[3] / v[6], 4) - 1) * 100
    diff = gRecent - gPrior
    displayVal = gRecent
    detail = `Growth annualized 3 bln ${_fmtValue('aheAnn', gRecent)} vs sebelumnya ${_fmtValue('aheAnn', gPrior)}`
  } else {
    return unavailable('metode tidak dikenal')
  }

  const raw = diff > cfg.band ? 'up' : diff < -cfg.band ? 'down' : 'flat'
  const status = raw === 'flat' ? 'flat'
    : (raw === 'up') !== cfg.invert ? 'strengthening'
    : 'weakening'

  const asOf = obs[0].date
  const ageDays = (nowMs - new Date(asOf).getTime()) / 86400000
  const stale = isFinite(ageDays) && ageDays > STALE_DAYS[cfg.cadence]

  return {
    ...base,
    status,
    raw, // arah data mentah ('up'/'down'/'flat') — utk indikator terbalik (klaim/layoffs)
         // panah UI harus ikut arah mentah, warna ikut status; tanpa ini "Initial
         // Claims ↓" bisa tampil justru saat klaim naik (menyesatkan)
    value: displayVal,
    display: _fmtValue(cfg.fmt, displayVal),
    detail,
    as_of: asOf,
    stale,
  }
}

// Agreement ordinal — TANPA persen. Flat masuk denominator (netral).
function buildAssessment(states) {
  const available = states.filter(s => s.status !== 'unavailable')
  const nStrength = available.filter(s => s.status === 'strengthening').length
  const nWeak     = available.filter(s => s.status === 'weakening').length
  const total     = available.length
  const aligned   = Math.max(nStrength, nWeak)

  let direction = nStrength === nWeak ? 'mixed' : nStrength > nWeak ? 'strengthening' : 'weakening'
  let label
  let insufficient = false

  if (total < 4) {
    insufficient = true
    direction = 'mixed'
    label = 'DATA TIDAK CUKUP'
  } else if (direction === 'mixed') {
    label = 'MIXED'
  } else {
    const word = direction === 'strengthening' ? 'STRENGTHENING' : 'WEAKENING'
    if (aligned / total >= 0.75 && total >= 6) label = `STRONG ${word}`
    else if (aligned / total >= 0.55)          label = `MODERATE ${word}`
    else                                       label = 'MIXED'
  }
  if (label === 'MIXED') direction = 'mixed'

  const dimensions = {}
  for (const dim of DIMENSIONS) dimensions[dim] = states.filter(s => s.dim === dim)

  const agreement = {
    strengthening: nStrength,
    weakening: nWeak,
    flat: total - nStrength - nWeak,
    available: total,
    aligned,
    direction,
    text: insufficient
      ? `hanya ${total} dari ${states.length} indikator tersedia`
      : `${aligned} dari ${total} indikator searah`,
  }

  return {
    dimensions,
    agreement,
    label,
    insufficient,
    narrative: _buildNarrative(dimensions, agreement, insufficient),
    as_of_latest: available.reduce((max, s) => (s.as_of && (!max || s.as_of > max)) ? s.as_of : max, null),
  }
}

function _dimSentence(dim, states) {
  const avail = states.filter(s => s.status !== 'unavailable')
  const name = dim === 'HIRING' ? 'Sisi hiring' : dim === 'LAYOFFS' ? 'Sisi layoffs' : 'Tekanan upah'
  if (avail.length === 0) return `${name}: data tidak tersedia.`
  const nS = avail.filter(s => s.status === 'strengthening').length
  const nW = avail.filter(s => s.status === 'weakening').length
  if (avail.length === 1) {
    const s = avail[0]
    const word = s.status === 'strengthening' ? 'mengarah menguat' : s.status === 'weakening' ? 'mengarah melemah' : 'relatif datar'
    return `${name}: ${s.label} ${word} (${s.display}).`
  }
  if (nS > nW)      return `${name}: ${nS} dari ${avail.length} indikator mengarah menguat.`
  else if (nW > nS) return `${name}: ${nW} dari ${avail.length} indikator mengarah melemah.`
  return `${name}: campuran, tidak ada arah dominan.`
}

// Narasi deterministik Bahasa Indonesia — bukan LLM (keputusan plan H.6): murni
// derivatif dari status terhitung, 100% testable, tanpa biaya/latensi provider AI.
function _buildNarrative(dimensions, agreement, insufficient) {
  const parts = DIMENSIONS.map(dim => _dimSentence(dim, dimensions[dim]))

  let theory
  if (insufficient) {
    theory = 'Terlalu sedikit indikator yang tersedia untuk menilai arah — tunggu data berikutnya.'
  } else if (agreement.direction === 'strengthening') {
    theory = 'Secara teori, pasar tenaga kerja yang menguat umumnya dibaca menopang ekspektasi upah dan sikap Fed yang lebih hawkish — cenderung suportif USD dan menekan XAU.'
  } else if (agreement.direction === 'weakening') {
    theory = 'Secara teori, pelemahan pasar tenaga kerja umumnya dibaca membuka ruang pelonggaran Fed — cenderung menekan USD dan menopang XAU.'
  } else {
    theory = 'Secara teori, sinyal campuran seperti ini umumnya dibaca netral — pasar menunggu konfirmasi dari rilis tenaga kerja berikutnya.'
  }

  const disclaimer = 'Ini konteks, bukan sinyal — data di atas umumnya sudah priced-in ke konsensus pasar.'
  return [...parts, theory, disclaimer].join(' ')
}

// Fan-out 8 seri FRED paralel. fetchImpl di-inject supaya testable tanpa network.
// Gagal per-seri → null (indikator jadi 'unavailable'), bukan gagal total.
async function fetchLabourSeries(fetchImpl = fetch) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const settled = await Promise.allSettled(LABOUR_INDICATORS.map(async cfg => {
    const url = `${FRED_BASE}?series_id=${cfg.id}&api_key=${apiKey}&limit=${cfg.limit}&sort_order=desc&file_type=json`
    const r = await fetchImpl(url, {
      headers: { 'User-Agent': 'DaunMerah/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) throw new Error(`FRED ${cfg.id} HTTP ${r.status}`)
    const json = await r.json()
    // Filter '.' (placeholder FRED utk data kosong) — pola fetchFred existing
    return (json.observations || [])
      .filter(o => o.value !== '.')
      .map(o => ({ value: parseFloat(o.value) * (cfg.scale || 1), date: o.date }))
  }))

  return LABOUR_INDICATORS.map((cfg, i) => {
    if (settled[i].status !== 'fulfilled') {
      console.warn(`labour: ${cfg.id} fetch failed:`, settled[i].reason?.message)
      return null
    }
    return settled[i].value
  })
}

function computeLabourAssessment(obsList, nowMs = Date.now()) {
  const states = LABOUR_INDICATORS.map((cfg, i) => classifyIndicator(cfg, obsList[i], nowMs))
  return buildAssessment(states)
}

module.exports = {
  LABOUR_INDICATORS,
  classifyIndicator,
  buildAssessment,
  computeLabourAssessment,
  fetchLabourSeries,
}
