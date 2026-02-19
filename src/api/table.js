/**
 * ServiceNow Table API client.
 * Queries sys_store_app, sys_app_version, and sys_plugins.
 */
import { withRetry } from '../utils/retry.js';

/**
 * Fetch all installed store applications.
 * @param {import('axios').AxiosInstance} client
 * @returns {Promise<Array<{sysId, scope, name, version, sourceId, type: 'app'}>>}
 */
export async function fetchInstalledApps(client) {
  const resp = await withRetry(() =>
    client.get('/api/now/table/sys_store_app', {
      params: {
        sysparm_fields: 'sys_id,scope,name,version,source',
        sysparm_limit: 1000,
        sysparm_query: 'active=true',
      },
    })
  );

  return (resp.data.result ?? []).map((r) => ({
    sysId: r.sys_id,
    scope: r.scope,
    name: r.name,
    version: r.version,
    sourceId: r.source?.value ?? r.source ?? null,
    type: 'app',
  }));
}

/**
 * Fetch the latest available version for a list of source IDs.
 * @param {import('axios').AxiosInstance} client
 * @param {string[]} sourceIds
 * @returns {Promise<Map<string, string>>} sourceId → latest version string
 */
export async function fetchAvailableVersions(client, sourceIds) {
  if (!sourceIds.length) return new Map();

  const query = `sourceIN${sourceIds.join(',')}`;
  const resp = await withRetry(() =>
    client.get('/api/now/table/sys_app_version', {
      params: {
        sysparm_fields: 'source,version',
        sysparm_limit: 5000,
        sysparm_query: query,
        sysparm_orderby: 'version^DESC',
      },
    })
  );

  const map = new Map();
  for (const r of resp.data.result ?? []) {
    const src = r.source?.value ?? r.source;
    if (src && !map.has(src)) {
      map.set(src, r.version);
    }
  }
  return map;
}

/**
 * Fetch installed plugins.
 * @param {import('axios').AxiosInstance} client
 * @returns {Promise<Array<{sysId, scope, name, version, type: 'plugin'}>>}
 */
export async function fetchPlugins(client) {
  const resp = await withRetry(() =>
    client.get('/api/now/table/sys_plugins', {
      params: {
        sysparm_fields: 'sys_id,id,name,version',
        sysparm_limit: 1000,
        sysparm_query: 'active=true',
      },
    })
  );

  return (resp.data.result ?? []).map((r) => ({
    sysId: r.sys_id,
    scope: r.id,
    name: r.name,
    version: r.version,
    sourceId: null,
    type: 'plugin',
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
