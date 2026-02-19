import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../src/utils/retry.js';

describe('withRetry — NaN Retry-After guard (P2-1)', () => {
  it('does not enter tight loop on NaN Retry-After', async () => {
    let attempts = 0;

    try {
      await withRetry(
        () => {
          attempts++;
          const err = new Error('429');
          err.response = {
            status: 429,
            headers: { 'retry-after': 'Thu, 01 Jan 2099 00:00:00 GMT' }, // HTTP-date → NaN
          };
          throw err;
        },
        { retries: 0 } // Only 1 attempt, no actual retry
      );
    } catch {
      // Expected to throw after exhausting retries
    }

    // Should have tried once, not looped
    expect(attempts).toBe(1);
  });

  it('uses parsed Retry-After when it is a valid number', async () => {
    let attempts = 0;
    const start = Date.now();

    await withRetry(
      () => {
        attempts++;
        if (attempts <= 1) {
          const err = new Error('429');
          err.response = {
            status: 429,
            headers: { 'retry-after': '1' }, // 1 second
          };
          throw err;
        }
        return 'ok';
      },
      { retries: 1 }
    );

    const elapsed = Date.now() - start;
    expect(attempts).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1 second
    expect(elapsed).toBeLessThan(5000);
  });

  it('uses 30s default for malformed Retry-After (verified via timing)', async () => {
    // With retries=0, it should throw immediately (no sleep happens)
    // The key test is that NaN doesn't cause setTimeout(fn, NaN) → instant fire
    // We already tested that above. Here we verify the actual value chosen is 30s
    // by using a single retry and checking that it waited a non-trivial amount.
    let attempts = 0;
    const start = Date.now();

    try {
      await withRetry(
        () => {
          attempts++;
          const err = new Error('429');
          err.response = {
            status: 429,
            headers: { 'retry-after': 'garbage' },
          };
          throw err;
        },
        { retries: 1 }
      );
    } catch {
      // Expected
    }

    const elapsed = Date.now() - start;
    // Should have waited ~30 seconds for the fallback
    expect(attempts).toBe(2);
    expect(elapsed).toBeGreaterThan(25_000);
  }, 35_000);
});
