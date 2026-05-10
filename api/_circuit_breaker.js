// api/_circuit_breaker.js
// Redis-backed circuit breaker for external sources and AI providers.
// Underscore prefix = Vercel does NOT expose this as a public route.
//
// States:
//   closed    — normal operation, calls allowed
//   open      — source failing, calls blocked for OPEN_DURATION_MS
//   half_open — probe window after OPEN expires; one call allowed to test recovery
//
// Redis key: circuit:{source} → JSON { state, failures, openUntil, lastFailure, lastSuccess }
// TTL: 1h (auto-expires if source is stable and never trips)
//
// Usage:
//   const cb = require('./_circuit_breaker');
//   if (!await cb.canCall('fred')) return serve_stale();
//   try {
//     const data = await fetch(...);
//     await cb.onSuccess('fred');
//   } catch(e) {
//     await cb.onFailure('fred');
//     throw e;
//   }

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS  = 5 * 60 * 1000; // 5 min
const KEY_TTL_S         = 3600;           // 1h Redis key TTL

async function redisGet(url, token, key) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
      signal: AbortSignal.timeout(2000),
    });
    return (await r.json()).result;
  } catch(_) { return null; }
}

async function redisSet(url, token, key, value) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, value, 'EX', KEY_TTL_S]),
      signal: AbortSignal.timeout(2000),
    });
  } catch(_) {}
}

function getRedis() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

function circuitKey(source) {
  return `circuit:${source}`;
}

/**
 * Returns true if the call is allowed (circuit CLOSED or HALF_OPEN probe).
 * Returns false if circuit is OPEN (source is failing — skip the call).
 * Fails open if Redis is unavailable.
 */
async function canCall(source) {
  const { url, token } = getRedis();
  if (!url || !token) return true;

  const raw = await redisGet(url, token, circuitKey(source));
  if (!raw) return true;

  let state;
  try { state = JSON.parse(raw); } catch(_) { return true; }

  if (state.state === 'closed') return true;

  if (state.state === 'open') {
    if (Date.now() < state.openUntil) {
      console.warn(`circuit:${source} OPEN — skipping call (${Math.round((state.openUntil - Date.now()) / 1000)}s remaining)`);
      return false;
    }
    // Timeout expired → transition to HALF_OPEN for one probe
    state.state = 'half_open';
    await redisSet(url, token, circuitKey(source), JSON.stringify(state));
    console.log(`circuit:${source} → HALF_OPEN (probing)`);
    return true;
  }

  // half_open: allow probe
  return true;
}

/**
 * Record a successful call. Resets circuit to CLOSED and clears failure count.
 */
async function onSuccess(source) {
  const { url, token } = getRedis();
  if (!url || !token) return;

  const raw = await redisGet(url, token, circuitKey(source));
  if (!raw) return; // circuit was already closed with no record — nothing to reset

  let state;
  try { state = JSON.parse(raw); } catch(_) { return; }

  if (state.state !== 'closed' || (state.failures || 0) > 0) {
    const closed = { state: 'closed', failures: 0, openUntil: null, lastSuccess: new Date().toISOString() };
    await redisSet(url, token, circuitKey(source), JSON.stringify(closed));
    if (state.state !== 'closed') {
      console.log(`circuit:${source} → CLOSED (recovered)`);
    }
  }
}

/**
 * Record a failed call. Opens the circuit after FAILURE_THRESHOLD consecutive failures.
 * @param {string} source  - Source name (e.g. 'fred', 'stooq', 'ai:cerebras')
 * @param {number} threshold - Override failure threshold (default: FAILURE_THRESHOLD)
 */
async function onFailure(source, threshold = FAILURE_THRESHOLD) {
  const { url, token } = getRedis();
  if (!url || !token) return;

  const key = circuitKey(source);
  const raw = await redisGet(url, token, key);
  let state = { state: 'closed', failures: 0, openUntil: null };
  if (raw) { try { state = JSON.parse(raw); } catch(_) {} }

  // If it was half_open and failed, go straight back to open
  state.failures = (state.failures || 0) + 1;
  state.lastFailure = new Date().toISOString();

  if (state.failures >= threshold || state.state === 'half_open') {
    state.state    = 'open';
    state.openUntil = Date.now() + OPEN_DURATION_MS;
    console.warn(`circuit:${source} → OPEN (${state.failures} failures, paused ${OPEN_DURATION_MS / 60000}m)`);
  }

  await redisSet(url, token, key, JSON.stringify(state));
}

/**
 * Read circuit state for diagnostics (used by admin health endpoint).
 */
async function getState(source) {
  const { url, token } = getRedis();
  if (!url || !token) return null;
  const raw = await redisGet(url, token, circuitKey(source));
  if (!raw) return { state: 'closed', failures: 0 };
  try { return JSON.parse(raw); } catch(_) { return null; }
}

module.exports = { canCall, onSuccess, onFailure, getState };
