/**
 * ServiceNow Table API client.
 * Queries sys_store_app for installed apps and available updates.
 *
 * Uses the update_available and latest_version fields on sys_store_app directly,
 * avoiding the need to query sys_app_version (which caused 414 URI Too Long on
 * large instances and broke when the source field contained scope names instead
 * of sys_ids).
 */
import { withRetry } from '../utils/retry.js';

/**
 * Fetch all installed store applications with their version info.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, latestVersion, updateAvailable, type: 'app'}>>}
 */
export async function fetchInstalledApps(client, retryOpts = {}) {
  const resp = await withRetry(
    () => client.get('/api/now/table/sys_store_app', {
      params: {
        sysparm_fields: 'sys_id,scope,name,version,latest_version,update_available',
        sysparm_limit: 1000,
        sysparm_query: 'active=true',
      },
    }),
    retryOpts
  );

  return (resp.data.result ?? []).map((r) => ({
    sysId: r.sys_id,
    scope: r.scope,
    name: r.name,
    version: r.version,
    latestVersion: r.latest_version ?? r.version,
    updateAvailable: r.update_available === 'true' || r.update_available === true,
    type: 'app',
  }));
}

/**
 * Fetch only store applications that have updates available.
 * Single query — no need for sys_app_version or batching.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, latestVersion, updateAvailable, type: 'app'}>>}
 */
export async function fetchUpdatableApps(client, retryOpts = {}) {
  const resp = await withRetry(
    () => client.get('/api/now/table/sys_store_app', {
      params: {
        sysparm_fields: 'sys_id,scope,name,version,latest_version,update_available',
        sysparm_limit: 1000,
        sysparm_query: 'active=true^update_available=true',
      },
    }),
    retryOpts
  );

  return (resp.data.result ?? []).map((r) => ({
    sysId: r.sys_id,
    scope: r.scope,
    name: r.name,
    version: r.version,
    latestVersion: r.latest_version ?? r.version,
    updateAvailable: true,
    type: 'app',
  }));
}

/**
 * Get instance version string from the instance for logging purposes.
 * @param {import('axios').AxiosInstance} client
 * @returns {Promise<string>}
 */
export async function fetchInstanceVersion(client) {
  try {
    const resp = await client.get('/api/now/table/sys_properties', {
      params: {
        sysparm_fields: 'value',
        sysparm_query: 'name=glide.buildname',
        sysparm_limit: 1,
      },
    });
    return resp.data.result?.[0]?.value ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}
