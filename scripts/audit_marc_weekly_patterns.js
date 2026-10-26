'use strict';

// Audit reproducible untuk pola editorial artikel mingguan Marc to Market.
// Hanya membaca feed Blogger publik; tidak memanggil model dan tidak menulis Redis.

const START_YEAR = Number(process.argv[2]) || 2020;
const END_YEAR = Number(process.argv[3]) || new Date().getUTCFullYear();
const PAGE_SIZE = 150;

function cleanHtml(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|div|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function countMatches(text, pattern) {
  return [...String(text || '').matchAll(pattern)].length;
}

function titleKind(title) {
  if (/\bweek ahead\b/i.test(title)) return 'week_ahead';
  if (/\bnext week\b/i.test(title)) return 'next_week';
  if (/\bweekly\b/i.test(title)) return 'weekly';
  return null;
}

function articleLink(entry) {
  return (entry.link || []).find(item => item.rel === 'alternate')?.href || null;
}

async function fetchYear(year) {
  const all = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const params = new URLSearchParams({
      alt: 'json',
      'max-results': String(PAGE_SIZE),
      'start-index': String(start),
      'published-min': `${year}-01-01T00:00:00Z`,
      'published-max': `${year + 1}-01-01T00:00:00Z`,
    });
    const url = `https://www.marctomarket.com/feeds/posts/default?${params}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DaunMerah-Research/1.0 (public feed audit)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${year}, start ${start}`);
    const json = await res.json();
    const entries = json.feed?.entry || [];
    all.push(...entries);
    const total = Number(json.feed?.['openSearch$totalResults']?.$t || 0);
    if (!entries.length || all.length >= total) break;
  }
  return all;
}

function summarizeArticle(entry) {
  const title = String(entry.title?.$t || '').trim();
  const html = entry.content?.$t || entry.summary?.$t || '';
  const text = cleanHtml(html);
  const published = new Date(entry.published?.$t || entry.updated?.$t);
  const sections = [...html.matchAll(/<(?:b|strong|u|h[1-6])[^>]*>\s*([^<>]{2,50}):?\s*<\/(?:b|strong|u|h[1-6])>/gi)]
    .map(match => cleanHtml(match[1]).replace(/:$/, '').trim())
    .filter(Boolean);
  return {
    title,
    kind: titleKind(title),
    published: published.toISOString(),
    weekday_utc: published.getUTCDay(),
    url: articleLink(entry),
    chars: text.length,
    sections,
    signals: {
      retrospective: countMatches(text, /\b(?:last week|past week|rose|fell|gained|lost|advanced|declined)\b/gi),
      explicit: countMatches(text, /\b(?:we expect|we suspect|we look for|our bias|is expected to|will likely)\b/gi),
      probabilistic: countMatches(text, /\b(?:likely|unlikely|may|might|could|should|appears?|seems?|perhaps)\b/gi),
      conditional: countMatches(text, /\b(?:if|unless|provided that|in the event|risk is)\b/gi),
      technical: countMatches(text, /\b(?:support|resistance|target|retest|break(?:s|ing)?|recover|consolidat\w*|correct\w*|momentum)\b/gi),
      levels: countMatches(text, /(?:[$¥£€]|\b(?:JPY|CAD|CHF|AUD|NZD|EUR|GBP|USD)\b)?\s*\d+(?:\.\d+)?%?/gi),
    },
  };
}

function addCounter(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function top(map, limit = 20) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

async function main() {
  if (START_YEAR > END_YEAR) throw new Error('start year must be <= end year');
  const posts = [];
  const fetchedByYear = {};
  for (let year = START_YEAR; year <= END_YEAR; year++) {
    const entries = await fetchYear(year);
    fetchedByYear[year] = entries.length;
    posts.push(...entries.map(summarizeArticle));
  }

  const named = posts.filter(post => post.kind);
  const canonical = named.filter(post => ['week_ahead', 'next_week'].includes(post.kind));
  const longWeekend = posts.filter(post => [0, 6].includes(post.weekday_utc) && post.chars >= 7000);
  const missedCandidates = longWeekend.filter(post => !post.kind);
  const sectionCounts = new Map();
  const kindCounts = new Map();
  const weekdayCounts = new Map();
  const yearCounts = new Map();
  const signalTotals = {};
  for (const post of canonical) {
    addCounter(kindCounts, post.kind);
    addCounter(weekdayCounts, String(post.weekday_utc));
    addCounter(yearCounts, post.published.slice(0, 4));
    for (const section of new Set(post.sections)) addCounter(sectionCounts, section);
    for (const [key, value] of Object.entries(post.signals)) signalTotals[key] = (signalTotals[key] || 0) + value;
  }

  const divide = value => canonical.length ? +(value / canonical.length).toFixed(2) : 0;
  const output = {
    range: { start_year: START_YEAR, end_year: END_YEAR },
    fetched_posts_by_year: fetchedByYear,
    canonical_weekly_articles: canonical.length,
    title_patterns: Object.fromEntries(kindCounts),
    weekly_articles_by_year: Object.fromEntries([...yearCounts].sort()),
    publication_weekday_utc: Object.fromEntries(weekdayCounts),
    article_length_chars: {
      min: canonical.length ? Math.min(...canonical.map(x => x.chars)) : 0,
      median: canonical.length ? canonical.map(x => x.chars).sort((a, b) => a - b)[Math.floor(canonical.length / 2)] : 0,
      max: canonical.length ? Math.max(...canonical.map(x => x.chars)) : 0,
    },
    signal_occurrences_per_article: Object.fromEntries(Object.entries(signalTotals).map(([key, value]) => [key, divide(value)])),
    common_sections: top(sectionCounts, 30),
    noncanonical_long_weekend_candidates: missedCandidates.slice(0, 40).map(({ title, published, chars, url }) => ({ title, published, chars, url })),
    title_examples: canonical.slice().sort((a, b) => b.published.localeCompare(a.published)).slice(0, 20).map(({ title, published, kind, url }) => ({ title, published, kind, url })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
