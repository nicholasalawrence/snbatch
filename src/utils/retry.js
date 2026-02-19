/**
 * Retry with exponential backoff.
 * Honors Retry-After header on 429 responses.
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Execute an async function with automatic retry on transient errors.
 *
 * @param {() => Promise<any>} fn  The function to retry
 * @param {object} opts
 * @param {number} [opts.retries=3]       Max number of retry attempts
 * @param {number} [opts.backoffBase=2000] Base backoff in ms (doubles each attempt)
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 3, backoffBase = 2000 } = opts;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;

      if (!RETRYABLE_STATUSES.has(status)) {
        throw err;
      }

      if (attempt === retries) break;

      let waitMs;
      if (status === 429) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30_000;
      } else {
        waitMs = backoffBase * Math.pow(2, attempt);
      }

      await sleep(waitMs);
    }
  }

  throw lastError;
}
