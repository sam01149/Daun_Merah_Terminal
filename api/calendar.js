// api/calendar.js
//
// ForexFactory fallback dihapus 2026-07-13 (request user): swap sumber saat
// TradingView outage bikin UX membingungkan (data dari sumber lain lalu balik
// lagi). Kalau TradingView gagal, handler jatuh langsung ke stale-cache Redis
// (lihat catch block di bawah) — riwayat FF sebagai fallback dicatat di
// Dokumentasi/daun_merah_vendor.md.
const TV_EVENTS_URL = 'https://economic-calendar.tradingview.com/events';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
// TradingView filters by country code, not currency — map the majors we track.
const CCY_TO_TV_COUNTRY = { USD:'US', EUR:'EU', GBP:'GB', JPY:'JP', CAD:'CA', AUD:'AU', NZD:'NZ', CHF:'CH' };
const CACHE_TTL = 6 * 3600; // Redis key TTL — long survival window for stale-serve fallback
const FRESH_TTL = 60;       // normal serve window — frontend polls every 90s; this previously
                             // had NO freshness gate at all (every single request re-fetched
                             // the calendar source unconditionally, worst offender for stampede risk)
const { withSingleFlight } = require('./_fetch_lock');
const rateLimit = require('./_ratelimit');

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()).result;
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (await rateLimit(req, res, { limit: 20, windowSecs: 60, endpoint: 'calendar' })) return;

  // Arbitrary date jump (e.g. "2 bulan ke depan") — ?date=YYYY-MM-DD shows the
  // Mon-Sun week containing that date. TradingView only, since it accepts an
  // arbitrary from/to range.
  const dateParam = req.query && typeof req.query.date === 'string' ? req.query.date : null;
  const isCustomDate = !!dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) && !isNaN(new Date(dateParam + 'T00:00:00Z').getTime());
  if (dateParam && !isCustomDate) return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });

  const isNextWeek = req.query && req.query.week === 'next';
  const targetWib = isCustomDate ? new Date(new Date(dateParam + 'T00:00:00Z').getTime() + 7 * 3600000) : null;
  let CACHE_KEY, LOCK_KEY;
  if (isCustomDate) {
    const mondayKey = toDateStr(computeWeekMonday(targetWib));
    CACHE_KEY = `calendar_custom_${mondayKey}`;
    LOCK_KEY  = `lock:calendar:custom:${mondayKey}`;
  } else {
    CACHE_KEY = isNextWeek ? 'calendar_next_v1' : 'calendar_v1';
    LOCK_KEY  = isNextWeek ? 'lock:calendar:next' : 'lock:calendar';
  }

  // Serve Redis cache if still fresh — every open tab polls this every 90s,
  // so without this gate every poll re-hits TradingView regardless of age.
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (Date.now() - new Date(obj.fetched_at).getTime() < FRESH_TTL * 1000) {
        res.setHeader('Cache-Control', 'max-age=60');
        return res.status(200).json({ ...obj, stale: false });
      }
    }
  } catch(_) {}

  // Cache stale/missing — single-flight lock so concurrent tabs/users hitting
  // this at the same moment don't all fan out to TradingView simultaneously.
  const sf = await withSingleFlight(redisCmd, {
    lockKey: LOCK_KEY,
    cacheKey: CACHE_KEY,
    isFresh: (raw) => {
      try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < FRESH_TTL * 1000; }
      catch(e) { return false; }
    },
  });
  if (!sf.gotLock && sf.fresh) {
    res.setHeader('Cache-Control', 'max-age=60');
    return res.status(200).json({ ...JSON.parse(sf.fresh), stale: false });
  }

  try {
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const { dateRange, rangeStartWib, rangeEndWib } = isCustomDate
      ? computeWeekRange(targetWib, false, true)
      : computeWeekRange(nowWib, isNextWeek);

    // TradingView adalah satu-satunya sumber (fallback ForexFactory dihapus,
    // lihat catatan di atas) — kalau ini gagal, error dilempar ke catch block
    // di bawah yang jatuh ke stale-cache Redis.
    const allEvents = await fetchTradingViewEvents(rangeStartWib, rangeEndWib);
    const source = 'tradingview';

    const seen = new Set();
    const deduped = allEvents
      .filter(e => dateRange.has(e.date) && (e.impact === 'High' || e.impact === 'Medium') && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => {
        const k = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => {
        const ka = a.date + (a.time_wib === 'Tentative' ? '99:99' : a.time_wib || '99:99');
        const kb = b.date + (b.time_wib === 'Tentative' ? '99:99' : b.time_wib || '99:99');
        return ka.localeCompare(kb);
      });

    const payload = { events: deduped, count: deduped.length, source, fetched_at: new Date().toISOString() };
    try { await redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL); } catch(_) {}
    if (sf.gotLock) sf.release();
    res.setHeader('Cache-Control', 'max-age=300');
    return res.status(200).json({ ...payload, stale: false });
  } catch(e) {
    if (sf.gotLock) sf.release();
    console.error('Calendar error:', e.message);
    // TradingView blocked/down or transient network error — serve last known-good calendar rather than nothing
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).json({ ...JSON.parse(cached), stale: true, stale_reason: e.message });
      }
    } catch(_) {}
    return res.status(500).json({ error: e.message });
  }
};

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Monday (00:00 WIB wall-clock) of the ISO week (Mon-Sun) containing `wib`.
function computeWeekMonday(wib) {
  const dow = wib.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  return new Date(wib.getTime() + mondayOffset * 86400000);
}

// Default "this week" view: rolling 5-day window starting today (unchanged
// from the original ForexFactory-only behavior). "next week" means the next
// ISO calendar week (Mon-Sun) after the current one, like FF's nextweek.xml.
// isCustomWeek (date-jump feature, ?date=YYYY-MM-DD): full Mon-Sun week
// containing `nowWib` itself, rather than the rolling window or next-week offset.
function computeWeekRange(nowWib, isNextWeek, isCustomWeek) {
  const dateRange = new Set();
  if (isCustomWeek) {
    const monday = computeWeekMonday(nowWib);
    for (let i = 0; i < 7; i++) dateRange.add(toDateStr(new Date(monday.getTime() + i * 86400000)));
    return { dateRange, rangeStartWib: monday, rangeEndWib: new Date(monday.getTime() + 6 * 86400000) };
  }
  if (!isNextWeek) {
    for (let i = 0; i <= 4; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    return { dateRange, rangeStartWib: nowWib, rangeEndWib: new Date(nowWib.getTime() + 4 * 86400000) };
  }
  const nextMonday = new Date(computeWeekMonday(nowWib).getTime() + 7 * 86400000);
  for (let i = 0; i < 7; i++) dateRange.add(toDateStr(new Date(nextMonday.getTime() + i * 86400000)));
  return { dateRange, rangeStartWib: nextMonday, rangeEndWib: new Date(nextMonday.getTime() + 6 * 86400000) };
}

const TV_IMPORTANCE_TO_IMPACT = { 1: 'High', 0: 'Medium', '-1': 'Low' };

// TradingView's calendar widget endpoint — undocumented but open (no key, no
// Cloudflare challenge), just needs an Origin/Referer matching their own site.
// `actual`/`previous`/`forecast` come pre-scaled (e.g. 7.618) with a separate
// `scale` (M/B/K) and `unit` (%) to append for display.
async function fetchTradingViewEvents(rangeStartWib, rangeEndWib) {
  const from = new Date(Date.UTC(rangeStartWib.getUTCFullYear(), rangeStartWib.getUTCMonth(), rangeStartWib.getUTCDate()) - 7 * 3600000);
  const to = new Date(Date.UTC(rangeEndWib.getUTCFullYear(), rangeEndWib.getUTCMonth(), rangeEndWib.getUTCDate()) + 24 * 3600000 - 7 * 3600000);
  const countries = Object.values(CCY_TO_TV_COUNTRY).join(',');
  const url = `${TV_EVENTS_URL}?from=${from.toISOString()}&to=${to.toISOString()}&countries=${countries}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/economic-calendar/',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`TradingView calendar HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.result)) throw new Error('TradingView calendar: malformed response');

  return json.result.filter(e => {
    // Skema minimal per event — item tanpa judul/tanggal valid bikin baris "undefined" di UI
    return e && typeof e.title === 'string' && e.title && !isNaN(new Date(e.date).getTime());
  }).map(e => {
    const utc = new Date(e.date);
    const wib = new Date(utc.getTime() + 7 * 3600000);
    // Audit vendor 2026-07-12: response TradingView juga berisi field yang selama ini
    // dibuang — actualRaw/forecastRaw/previousRaw (angka mentah, beat/miss bisa dihitung
    // numerik tanpa parsing string berformat), period (periode acuan rilis, mis. "Jun"),
    // dan comment (penjelasan 1 kalimat indikatornya). Nol request tambahan.
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
    return {
      date:     toDateStr(wib),
      time_wib: `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`,
      currency: (e.currency || '').toUpperCase(),
      event:    e.title,
      impact:   TV_IMPORTANCE_TO_IMPACT[e.importance] || 'Low',
      forecast: formatTVValue(e.forecast, e.scale, e.unit),
      previous: formatTVValue(e.previous, e.scale, e.unit),
      actual:   formatTVValue(e.actual, e.scale, e.unit),
      // HANYA field *Raw (skala penuh, mis. 7618000) — jangan fallback ke e.forecast
      // (terskalakan, 7.618 + scale "M"): campuran keduanya antar field bikin
      // perbandingan beat/miss salah total. Kalau raw tidak ada, client jatuh ke
      // perbandingan string seperti sebelumnya.
      forecast_raw: num(e.forecastRaw),
      previous_raw: num(e.previousRaw),
      actual_raw:   num(e.actualRaw),
      period:   (typeof e.period === 'string' && e.period) ? e.period : null,
      comment:  (typeof e.comment === 'string' && e.comment) ? e.comment.trim() : null,
      url:      e.source_url || null,
    };
  });
}

const CURRENCY_SYMBOLS = new Set(['£','$','€','¥','₣','₹']);

function formatTVValue(value, scale, unit) {
  if (value === null || value === undefined) return null;
  if (unit && CURRENCY_SYMBOLS.has(unit)) return `${unit}${value}${scale || ''}`;
  return `${value}${scale || ''}${unit || ''}`;
}

