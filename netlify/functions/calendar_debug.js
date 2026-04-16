// TEMPORARY DEBUG VERSION - netlify/functions/calendar.js
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

exports.handler = async function(event, context) {
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)', 'Accept': 'application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(12000),
      }),
      fetch(FF_NEXT_WEEK, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)', 'Accept': 'application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(12000),
      }),
    ]);

    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) {
          allEvents = allEvents.concat(parseFFXML(xml));
        }
      }
    }

    // DEBUG: show first 5 parsed events raw, and date range
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 4; i++) {
      dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    }

    const sample = allEvents.slice(0, 8).map(e => ({
      date: e.date,
      currency: e.currency,
      impact: e.impact,
      event: e.event.substring(0, 30),
    }));

    const highOnly = allEvents.filter(e => e.impact === 'High');
    const majorOnly = allEvents.filter(e => MAJOR_CURRENCIES.has(e.currency));
    const inRange = allEvents.filter(e => dateRange.has(e.date));
    const filtered = allEvents.filter(e =>
      dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency)
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        debug: true,
        total_parsed: allEvents.length,
        date_range: [...dateRange],
        server_wib_now: nowWib.toISOString(),
        high_impact_count: highOnly.length,
        major_currency_count: majorOnly.length,
        in_range_count: inRange.length,
        final_filtered: filtered.length,
        sample_events: sample,
        sample_high: highOnly.slice(0,5).map(e => ({ date: e.date, currency: e.currency, event: e.event.substring(0,30) })),
      }),
    };

  } catch(e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function toDateStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseFFXML(xml) {
  const events = [];
  const eventRe = /<event>([\s\S]*?)<\/event>/g;
  let m;
  while ((m = eventRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return r ? r[1].trim() : '';
    };
    const title    = get('title');
    const country  = get('country').toUpperCase();
    const date     = get('date');
    const time     = get('time');
    const impact   = get('impact');
    const forecast = get('forecast');
    const previous = get('previous');
    if (!title || !country) continue;
    const dateParts = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dateParts) continue;
    const dateIso = `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}`;
    events.push({ date: dateIso, time_wib: time, currency: country, event: title, impact });
  }
  return events;
}
