// api/_fetch_lock.js — shared "single-flight" Redis lock to prevent cache-stampede.
// Underscore prefix = not counted toward Vercel's 12-function limit, not a public route.
//
// Problem: handler checks Redis cache → if stale, fetch() an external URL →
// write cache. With no lock, several concurrent requests (multiple browser
// tabs, multiple users) that all miss cache in the same instant each fetch
// upstream independently — a classic thundering herd. For sources with their
// own anti-bot/anti-scrape defenses (FinancialJuice, central bank sites, CME),
// that burst can get the app's IP blocked.
//
// Fix: only the request that wins SET-NX-EX actually fetches. Everyone else
// polls Redis briefly for the winner's fresh result, falling back to stale
// cache (handled by the caller) instead of also fetching.
//
// Usage:
//   const { withSingleFlight } = require('./_fetch_lock');
//   const sf = await withSingleFlight(redisCmd, { lockKey: 'lock:foo', cacheKey, isFresh });
//   if (!sf.gotLock) {
//     if (sf.fresh) return res.status(200).json({ ...JSON.parse(sf.fresh), from_cache: true });
//     // else fall through and fetch yourself — cold-start race, nothing cached yet
//   }
//   ... do the fetch + cache write ...
//   if (sf.gotLock) sf.release();

async function withSingleFlight(redisCmd, { lockKey, lockTtlSecs = 25, cacheKey, isFresh, waitMs = 350, waitTries = 4 }) {
  const gotLock = await redisCmd('SET', lockKey, '1', 'NX', 'EX', lockTtlSecs);
  if (gotLock) {
    return { gotLock: true, release: () => redisCmd('DEL', lockKey).catch(() => {}) };
  }

  for (let i = 0; i < waitTries; i++) {
    await new Promise(r => setTimeout(r, waitMs));
    try {
      const raw = await redisCmd('GET', cacheKey);
      if (raw && isFresh(raw)) return { gotLock: false, fresh: raw };
    } catch(e) {}
  }
  return { gotLock: false, fresh: null };
}

module.exports = { withSingleFlight };
