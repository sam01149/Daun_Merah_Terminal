// netlify/functions/calendar.js
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

    if (allEvents.length === 0) throw new Error('No events parsed from FF feeds');

    // Today + next 4 days in WIB (covers weekend gaps & week boundary)
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 4; i++) {
      dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    }

    const filtered = allEvents.filter(e =>
      dateRange.has(e.date) &&
      e.impact === 'High' &&
      MAJOR_CURRENCIES.has(e.currency)
    );

    // Deduplicate
    const seen = new Set();
    const deduped = filtered.filter(e => {
      const key = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => {
      const ka = a.date + (a.time_wib || '');
      const kb = b.date + (b.time_wib || '');
      return ka.localeCompare(kb);
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=900',
      },
      body: JSON.stringify({
        events: deduped,
        count: deduped.length,
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
      if (!r) return '';
      // Strip CDATA wrapper: <![CDATA[value]]> → value
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    const title    = get('title');
    const country  = get('country').toUpperCase();
    const date     = get('date');
    const time     = get('time');
    const impact   = get('impact');
    const forecast = get('forecast');
    const previous = get('previous');

    if (!title || !country) continue;

    // MM-DD-YYYY → YYYY-MM-DD
    const dateParts = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dateParts) continue;
    const dateIso = `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}`;

    events.push({
      date: dateIso,
      time_wib: convertToWIB(time),
      currency: country,
      event: title,
      impact,
      forecast: forecast || null,
      previous: previous || null,
    });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') return 'Tentative';
  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return timeStr;

  let hour = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // FF = US Eastern Time
  // EDT (UTC-4) Mar-Nov: WIB offset = +11
  // EST (UTC-5) Nov-Mar: WIB offset = +12
  const nowMonth = new Date().getUTCMonth() + 1;
  const isDST = nowMonth >= 3 && nowMonth <= 10;
  const wibHour = (hour + (isDST ? 11 : 12)) % 24;
  return `${String(wibHour).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}
