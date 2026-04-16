// netlify/functions/calendar.js
// Fetches high-impact economic calendar events from Investing.com
// Returns events for today + tomorrow, converted to WIB timezone

const COUNTRY_CODES = {
  USD: 5, EUR: 72, GBP: 4, JPY: 35,
  CAD: 6, AUD: 25, NZD: 43, CHF: 12,
};

// Currency name → code reverse lookup (for response parsing)
const COUNTRY_TO_CURRENCY = Object.fromEntries(
  Object.entries(COUNTRY_CODES).map(([cur, code]) => [code, cur])
);

exports.handler = async function(event, context) {
  try {
    const now = new Date();
    // Date range: today and tomorrow (UTC)
    const today = formatDate(now);
    const tomorrow = formatDate(new Date(now.getTime() + 86400000));

    const countryParams = Object.values(COUNTRY_CODES)
      .map(c => `country[]=${c}`)
      .join('&');

    const body = [
      'dateFrom=' + today,
      'dateTo=' + tomorrow,
      'timeZone=55',   // WIB (UTC+7) — Investing.com timezone code 55
      'timeFilter=timeRemain',
      'currentTab=custom',
      'submitFilters=1',
      'limit_from=0',
      countryParams,
      'importance[]=3', // high impact only
    ].join('&');

    const res = await fetch(
      'https://www.investing.com/economic-calendar/Service/getCalendarFilteredData',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.investing.com/economic-calendar/',
          'Origin': 'https://www.investing.com',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*',
        },
        body,
        signal: AbortSignal.timeout(12000),
      }
    );

    if (!res.ok) {
      throw new Error('Investing.com HTTP ' + res.status);
    }

    const data = await res.json();
    const html = data.data || '';

    if (!html) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ events: [], fetched_at: new Date().toISOString() }),
      };
    }

    const events = parseCalendarHTML(html, today, tomorrow);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        events,
        count: events.length,
        fetched_at: new Date().toISOString(),
      }),
    };

  } catch(e) {
    console.error('Calendar fetch error:', e.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseCalendarHTML(html, today, tomorrow) {
  const events = [];

  // Match each table row in the calendar
  const rowRe = /<tr[^>]*data-event-datetime="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;

  while ((m = rowRe.exec(html)) !== null) {
    const datetime = m[1]; // format: "2025/04/16 19:30:00"
    const rowHtml = m[2];

    // Extract currency flag/name
    const flagMatch = rowHtml.match(/class="[^"]*ceFlags?\s+([A-Z]{2,4})[^"]*"/);
    const currency = flagMatch ? flagMatch[1] : null;
    if (!currency || !Object.keys(COUNTRY_CODES).includes(currency)) continue;

    // Extract event name
    const nameMatch = rowHtml.match(/class="[^"]*event[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
    const eventName = nameMatch ? nameMatch[1].trim() : null;
    if (!eventName) continue;

    // Parse datetime → WIB display
    // Investing.com returns times in the requested timezone (WIB, timeZone=55)
    const dtParts = datetime.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!dtParts) continue;

    const dateStr = `${dtParts[1]}-${dtParts[2]}-${dtParts[3]}`;
    const timeWib = `${dtParts[4]}:${dtParts[5]} WIB`;

    // Only include today and tomorrow
    if (dateStr !== today && dateStr !== tomorrow) continue;

    events.push({
      date: dateStr,
      time_wib: timeWib,
      currency,
      event: eventName,
      impact: 'high',
    });
  }

  // Fallback: simpler regex if the above yields nothing
  if (events.length === 0) {
    return parseCalendarHTMLFallback(html, today, tomorrow);
  }

  // Sort by date + time
  events.sort((a, b) => {
    const ka = a.date + a.time_wib;
    const kb = b.date + b.time_wib;
    return ka.localeCompare(kb);
  });

  return events;
}

function parseCalendarHTMLFallback(html, today, tomorrow) {
  // Fallback: extract from simpler td structure
  const events = [];
  const rows = html.split('<tr ');

  for (const row of rows) {
    if (!row.includes('high') && !row.includes('bull3')) continue;

    // Time
    const timeM = row.match(/class="[^"]*time[^"]*"[^>]*>(\d{2}:\d{2})<\/td>/);
    if (!timeM) continue;

    // Currency
    const curM = row.match(/title="([A-Z]{2,4})"/) || row.match(/alt="([A-Z]{3})"/);
    if (!curM) continue;
    const currency = curM[1];
    if (!Object.keys(COUNTRY_CODES).includes(currency)) continue;

    // Event name
    const nameM = row.match(/<a[^>]+event_attr_id[^>]*>([^<]+)<\/a>/);
    if (!nameM) continue;

    events.push({
      date: today,
      time_wib: timeM[1] + ' WIB',
      currency,
      event: nameM[1].trim(),
      impact: 'high',
    });
  }

  return events;
}
