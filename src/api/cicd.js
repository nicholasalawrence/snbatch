/**
 * ServiceNow CI/CD API client.
 * Handles batch install, rollback, and progress polling.
 */
import { withRetry, sleep } from '../utils/retry.js';

/**
 * Start a batch installation.
 * @param {import('axios').AxiosInstance} client
 * @param {Array<{id: string, version: string}>} packages
 * @returns {Promise<{progressId: string, rollbackToken: string|null}>}
 */
export async function startBatchInstall(client, packages) {
  const resp = await withRetry(() =>
    client.post('/api/sn_cicd/app/batch/install', { packages })
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
 * @returns {Promise<{progressId: string}>}
 */
export async function startBatchRollback(client, rollbackToken) {
  const resp = await withRetry(() =>
    client.post('/api/sn_cicd/app/batch/rollback', { rollback_token: rollbackToken })
  );
  const result = resp.data.result ?? resp.data;
  return { progressId: result.links?.progress?.id ?? result.id };
}

/**
 * Poll the progress API until completion.
 * Yields each poll response for real-time updates.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} progressId
 * @param {{ pollInterval?: number, maxPollDuration?: number }} opts
 * @yields {{ percentComplete: number, status: string, packages: object[] }}
 */
export async function* pollProgress(client, progressId, opts = {}) {
  const { pollInterval = 10_000, maxPollDuration = 7_200_000 } = opts;
  const deadline = Date.now() + maxPollDuration;
  let interval = pollInterval;

  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await withRetry(() => client.get(`/api/sn_cicd/progress/${progressId}`));
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        interval = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30_000;
        await sleep(interval);
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
