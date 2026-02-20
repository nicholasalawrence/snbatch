/**
 * ServiceNow Table API client.
 * Queries sys_store_app, sys_app_version, and sys_plugins.
 */
import { withRetry } from '../utils/retry.js';

// P3-4: Validate sourceIds to prevent ServiceNow query injection
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateSourceIds(sourceIds) {
  return sourceIds.filter((id) => {
    if (!SAFE_ID_RE.test(id)) {
      process.stderr.write(`[snbatch] Warning: skipping invalid sourceId: ${id}\n`);
      return false;
    }
    return true;
  });
}

/**
 * Fetch all installed store applications.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, sourceId, type: 'app'}>>}
 */
export async function fetchInstalledApps(client, retryOpts = {}) {
  const resp = await withRetry(
    () => client.get('/api/now/table/sys_store_app', {
      params: {
        sysparm_fields: 'sys_id,scope,name,version,source',
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
    sourceId: r.source?.value ?? r.source ?? null,
    type: 'app',
  }));
}

/**
 * Fetch the latest available version for a list of source IDs.
 * Batches requests to avoid 414 URI Too Long errors on large instances.
 * @param {import('axios').AxiosInstance} client
 * @param {string[]} sourceIds
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Map<string, string>>} sourceId → latest version string
 */
export async function fetchAvailableVersions(client, sourceIds, retryOpts = {}) {
  if (!sourceIds.length) return new Map();

  // P3-4: Validate sourceIds before building query
  const safeIds = validateSourceIds(sourceIds);
  if (!safeIds.length) return new Map();

  const CHUNK_SIZE = 50;
  const map = new Map();

  for (let i = 0; i < safeIds.length; i += CHUNK_SIZE) {
    const chunk = safeIds.slice(i, i + CHUNK_SIZE);
    const query = `sourceIN${chunk.join(',')}`;
    const resp = await withRetry(
      () => client.get('/api/now/table/sys_app_version', {
        params: {
          sysparm_fields: 'source,version',
          sysparm_limit: 5000,
          sysparm_query: query,
          sysparm_orderby: 'version^DESC',
        },
      }),
      retryOpts
    );

    for (const r of resp.data.result ?? []) {
      const src = r.source?.value ?? r.source;
      if (src && !map.has(src)) {
        map.set(src, r.version);
      }
    }
  }

  return map;
}

/**
 * Fetch installed plugins.
 * @param {import('axios').AxiosInstance} client
 * @param {{ retries?: number, backoffBase?: number }} [retryOpts]
 * @returns {Promise<Array<{sysId, scope, name, version, type: 'plugin'}>>}
 */
export async function fetchPlugins(client, retryOpts = {}) {
  const resp = await withRetry(
    () => client.get('/api/now/table/sys_plugins', {
      params: {
        sysparm_fields: 'sys_id,id,name,version',
        sysparm_limit: 1000,
        sysparm_query: 'active=true',
      },
    }),
    retryOpts
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
