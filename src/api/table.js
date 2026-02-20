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

const PAGE_SIZE = 500;

function mapAppRow(r) {
  // apps_in_jumbo is a JSON string (or empty) indicating bundled platform plugins
  let appsInJumbo = [];
  if (r.apps_in_jumbo) {
    try {
      const parsed = JSON.parse(r.apps_in_jumbo);
      appsInJumbo = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Non-empty but unparseable — treat as jumbo to be safe
      appsInJumbo = [r.apps_in_jumbo];
    }
  }
  return {
    sysId: r.sys_id,
    scope: r.scope,
    name: r.name,
    version: r.version,
    latestVersion: r.latest_version ?? r.version,
    updateAvailable: r.update_available === 'true' || r.update_available === true,
    isJumbo: appsInJumbo.length > 0,
    appsInJumbo,
    hasDemoData: typeof r.demo_data === 'string' && r.demo_data.toLowerCase().includes('has'),
    type: 'app',
  };
}

/**
 * Paginated fetch helper — loops with sysparm_offset until a partial page.
 */
async function paginatedFetch(client, path, baseParams, retryOpts = {}) {
  let offset = 0;
  const allResults = [];

  while (true) {
    const resp = await withRetry(
      () => client.get(path, {
        params: { ...baseParams, sysparm_limit: PAGE_SIZE, sysparm_offset: offset },
      }),
      retryOpts
    );
    const page = resp.data.result ?? [];
    allResults.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allResults;
}

/**
 * Fetch all installed store applications with their version info.
 * Paginates to handle instances with >500 apps.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, latestVersion, updateAvailable, type: 'app'}>>}
 */
export async function fetchInstalledApps(client, retryOpts = {}) {
  const rows = await paginatedFetch(client, '/api/now/table/sys_store_app', {
    sysparm_fields: 'sys_id,scope,name,version,latest_version,update_available,apps_in_jumbo,demo_data',
    sysparm_query: 'active=true',
  }, retryOpts);

  return rows.map(mapAppRow);
}

/**
 * Fetch only store applications that have updates available.
 * Single filtered query with pagination — no need for sys_app_version.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, latestVersion, updateAvailable, type: 'app'}>>}
 */
export async function fetchUpdatableApps(client, retryOpts = {}) {
  const rows = await paginatedFetch(client, '/api/now/table/sys_store_app', {
    sysparm_fields: 'sys_id,scope,name,version,latest_version,update_available,apps_in_jumbo,demo_data',
    sysparm_query: 'active=true^update_available=true',
  }, retryOpts);

  return rows.map(mapAppRow);
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
    const value = resp.data.result?.[0]?.value;
    if (value) return value;
  } catch {
    // Fall through to fallback
  }

  // Fallback: try stats.do endpoint
  try {
    const resp = await client.get('/stats.do', {
      headers: { Accept: 'application/json' },
      timeout: 5000,
    });
    if (resp.data?.build_name) return resp.data.build_name;
  } catch {
    // Ignore
  }

  return 'Unknown';
}
