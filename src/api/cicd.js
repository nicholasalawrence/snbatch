/**
 * ServiceNow CI/CD API client.
 * Handles batch install, rollback, and progress polling.
 */
import { withRetry, sleep } from '../utils/retry.js';

/**
 * Start a batch installation.
 * @param {import('axios').AxiosInstance} client
 * @param {Array<{id: string, version: string}>} packages
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<{progressId: string, rollbackToken: string|null}>}
 */
export async function startBatchInstall(client, packages, retryOpts = {}) {
  const resp = await withRetry(
    () => client.post('/api/sn_cicd/app/batch/install', { packages }),
    retryOpts
  );
  const result = resp.data.result ?? resp.data;
  return {
    progressId: result.links?.progress?.id ?? result.id,
    rollbackToken: result.links?.rollback?.id ?? result.rollback_token ?? null,
  };
}

/**
 * Start a batch rollback.
 * @param {import('axios').AxiosInstance} client
 * @param {string} rollbackToken
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<{progressId: string}>}
 */
export async function startBatchRollback(client, rollbackToken, retryOpts = {}) {
  const resp = await withRetry(
    () => client.post('/api/sn_cicd/app/batch/rollback', { rollback_token: rollbackToken }),
    retryOpts
  );
  const result = resp.data.result ?? resp.data;
  return { progressId: result.links?.progress?.id ?? result.id };
}

/**
 * Poll the progress API until completion.
 * Yields each poll response for real-time updates.
 *
 * P2-2: Removed withRetry from poll calls to avoid double-retry.
 * Retries are handled manually inside the generator.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} progressId
 * @param {{ pollInterval?: number, maxPollDuration?: number, retries?: number, backoffBase?: number }} opts
 * @yields {{ percentComplete: number, status: string, packages: object[] }}
 */
export async function* pollProgress(client, progressId, opts = {}) {
  const { pollInterval = 10_000, maxPollDuration = 7_200_000, retries = 3, backoffBase = 2000 } = opts;
  const deadline = Date.now() + maxPollDuration;
  let interval = pollInterval;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    let resp;
    try {
      // P2-2: No withRetry wrapper — handle retries manually to avoid conflicting logic
      resp = await client.get(`/api/sn_cicd/progress/${progressId}`);
      consecutiveErrors = 0;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        const parsed = parseInt(retryAfter, 10);
        interval = (!isNaN(parsed) && parsed > 0) ? parsed * 1000 : 30_000;
        await sleep(interval);
        continue;
      }
      // Retry transient errors up to configured limit
      if ([500, 502, 503, 504].includes(status) && consecutiveErrors < retries) {
        consecutiveErrors++;
        await sleep(backoffBase * Math.pow(2, consecutiveErrors - 1));
        continue;
      }
      throw err;
    }

    const data = resp.data.result ?? resp.data;
    yield data;

    const pct = data.percentComplete ?? data.percent_complete ?? 0;
    const statusVal = (data.status ?? data.state ?? '').toLowerCase();

    if (pct >= 100 || statusVal === 'complete' || statusVal === 'success' || statusVal === 'failed') {
      return;
    }

    // Reset interval back to normal after backoff
    interval = pollInterval;
    await sleep(interval);
  }

  throw new Error(`Polling timed out after ${maxPollDuration / 60000} minutes. The batch may still be running server-side.`);
}
