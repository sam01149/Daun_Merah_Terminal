// api/_retry.js
// Wraps fetch() with exponential backoff retry for transient failures.
// Underscore prefix = Vercel does NOT expose this as a public route.
//
// Retries on: network errors, timeouts, HTTP 5xx
// No retry on: HTTP 4xx (client error — retrying won't help)
//
// Usage:
//   const { fetchWithRetry } = require('./_retry');
//   const r = await fetchWithRetry(url, fetchOptions, { retries: 1, baseDelayMs: 300 });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {string}   url
 * @param {object}   options        - fetch() options (headers, signal, etc.)
 * @param {object}   retryOpts
 * @param {number}   retryOpts.retries      - max additional attempts after first (default 1)
 * @param {number}   retryOpts.baseDelayMs  - delay before first retry; doubles each attempt (default 300)
 * @returns {Response} resolved on first successful response
 * @throws  on final failure
 */
async function fetchWithRetry(url, options = {}, { retries = 1, baseDelayMs = 300 } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options);

      if (r.ok) return r;

      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      // 4xx = client error; retrying is pointless
      if (r.status >= 400 && r.status < 500) throw err;

      lastErr = err;
    } catch(e) {
      lastErr = e;
      if (e.status >= 400 && e.status < 500) throw e;
    }

    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      const label = url.split('?')[0].split('/').slice(-2).join('/');
      console.warn(`_retry: attempt ${attempt + 1}/${retries + 1} failed for ${label} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

module.exports = { fetchWithRetry };
