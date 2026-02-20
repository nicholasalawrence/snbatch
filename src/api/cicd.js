/**
 * ServiceNow CI/CD API client.
 * Handles single-app install (default), batch install (--batch), rollback, and progress polling.
 */
import { withRetry, sleep } from '../utils/retry.js';

// ── Single-app install/rollback (default) ──────────────────────────────

/**
 * Install a single app via the app_repo API.
 * @param {import('axios').AxiosInstance} client
 * @param {string} scope - App scope (e.g. "x_snc_itsm")
 * @param {string} version - Target version (e.g. "3.2.4")
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @param {boolean} [loadDemoData] - Whether to load demo data at install time
 * @returns {Promise<{progressId: string, rollbackVersion: string|null}>}
 */
export async function installApp(client, scope, version, retryOpts = {}, loadDemoData = false) {
  const params = { scope, version };
  if (loadDemoData) params.load_demo_data = 'true';
  const resp = await withRetry(
    () => client.post('/api/sn_cicd/app_repo/install', null, { params }),
    retryOpts
  );
  const result = resp.data.result ?? resp.data;
  return {
    progressId: result.links?.progress?.id ?? result.id,
    rollbackVersion: result.rollback_version ?? null,
  };
}

/**
 * Roll back a single app via the app_repo API.
 * @param {import('axios').AxiosInstance} client
 * @param {string} scope - App scope
 * @param {string} version - Version to roll back to
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<{progressId: string}>}
 */
export async function rollbackApp(client, scope, version, retryOpts = {}) {
  const resp = await withRetry(
    () => client.post('/api/sn_cicd/app_repo/rollback', null, {
      params: { scope, version },
    }),
    retryOpts
  );
  const result = resp.data.result ?? resp.data;
  return { progressId: result.links?.progress?.id ?? result.id };
}

/**
 * Determine whether a progress poll result indicates success.
 * Handles both numeric (app_repo: 2=Succeeded, 3=Failed) and
 * string (batch: "complete", "success", "failed") status values.
 * @param {object} data - Final poll data
 * @returns {boolean}
 */
export function isProgressSuccess(data) {
  if (!data) return false;
  const raw = data.status ?? data.state;
  const statusNum = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (statusNum === 2) return true;
  if (statusNum === 3) return false;
  const statusStr = String(raw ?? '').toLowerCase();
  return statusStr === 'success' || statusStr === 'complete';
}

// ── Batch install/rollback (--batch flag) ──────────────────────────────

/**
 * Start a batch installation.
 * @param {import('axios').AxiosInstance} client
 * @param {Array<{id: string, version: string, type: string, load_demo_data: boolean}>} packages
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<{progressId: string, rollbackToken: string|null, resultsId: string|null}>}
 */
export async function startBatchInstall(client, packages, retryOpts = {}) {
  const payload = {
    name: `snbatch batch install - ${new Date().toISOString().slice(0, 10)}`,
    packages,
    notes: `Batch install of ${packages.length} package(s) via snbatch`,
  };
  const resp = await withRetry(
    () => client.post('/api/sn_cicd/app/batch/install', payload),
    retryOpts
  );
  const result = resp.data.result ?? resp.data;
  return {
    progressId: result.links?.progress?.id ?? result.id,
    rollbackToken: result.links?.rollback?.id ?? result.rollback_token ?? null,
    resultsId: result.links?.results?.id ?? null,
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
 * Fetch per-package results after batch install completes.
 * The results endpoint is separate from the progress endpoint.
 * @param {import('axios').AxiosInstance} client
 * @param {string} resultsId  — from links.results.id in the batch submission response
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<object[]>}
 */
export async function fetchBatchResults(client, resultsId, retryOpts = {}) {
  const resp = await withRetry(
    () => client.get(`/api/sn_cicd/app/batch/results/${resultsId}`),
    retryOpts
  );
  const data = resp.data.result ?? resp.data;
  return Array.isArray(data) ? data : data?.batch_items ?? [];
}

// ── Progress polling (shared) ──────────────────────────────────────────

/**
 * Poll the progress API until completion.
 * Yields each poll response for real-time updates.
 *
 * Handles both numeric status codes (app_repo: 0=Pending, 1=Running, 2=Succeeded, 3=Failed)
 * and string status values (batch: "complete", "success", "failed").
 *
 * P2-2: Removed withRetry from poll calls to avoid double-retry.
 * Retries are handled manually inside the generator.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} progressId
 * @param {{ pollInterval?: number, maxPollDuration?: number, retries?: number, backoffBase?: number }} opts
 * @yields {object} Progress data from API
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
    const raw = data.status ?? data.state;
    const statusNum = typeof raw === 'number' ? raw : parseInt(raw, 10);
    const statusStr = String(raw ?? '').toLowerCase();

    // Numeric terminal: 2=Succeeded, 3=Failed
    if (statusNum === 2 || statusNum === 3) return;
    // String terminal (batch API compat)
    if (statusStr === 'complete' || statusStr === 'success' || statusStr === 'failed') return;
    // Percent-based terminal
    if (pct >= 100) return;

    // Reset interval back to normal after backoff
    interval = pollInterval;
    await sleep(interval);
  }

  throw new Error(`Polling timed out after ${maxPollDuration / 60000} minutes. The operation may still be running server-side.`);
}
