/**
 * Lightweight mock ServiceNow HTTP server for integration tests.
 * Uses Node's built-in http module — no external dependencies.
 */
import { createServer } from 'http';

export const MOCK_APPS = [
  { sys_id: 'app001', scope: 'x_snc_itsm', name: 'ITSM Core', version: '3.2.1', latest_version: '3.2.4', update_available: 'true', active: 'true' },
  { sys_id: 'app002', scope: 'x_snc_hr',   name: 'HR Service Delivery', version: '4.1.0', latest_version: '4.2.1', update_available: 'true', active: 'true' },
  { sys_id: 'app003', scope: 'x_snc_sec',  name: 'Security Operations', version: '2.0.3', latest_version: '3.0.0', update_available: 'true', active: 'true' },
];

// Apps that are already current (no update available)
export const MOCK_APPS_CURRENT = [
  { sys_id: 'app004', scope: 'x_snc_csm', name: 'Customer Service', version: '1.5.0', latest_version: '1.5.0', update_available: 'false', active: 'true' },
];

export const MOCK_BATCH_RESULT = {
  result: {
    links: {
      progress: { id: 'progress-abc-123' },
      rollback: { id: 'rollback-token-xyz' },
      results: { id: 'results-batch-789' },
    },
  },
};

export const MOCK_BATCH_RESULTS = {
  result: [
    { id: 'app001', name: 'ITSM Core', scope: 'x_snc_itsm', version: '3.2.4', status: 'success' },
    { id: 'app002', name: 'HR Service Delivery', scope: 'x_snc_hr', version: '4.2.1', status: 'success' },
  ],
};

export const MOCK_PROGRESS_COMPLETE = {
  result: {
    percentComplete: 100,
    status: 'complete',
  },
};

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Create and start a mock ServiceNow server.
 * @returns {{ server: http.Server, baseUrl: string, close: () => Promise<void> }}
 */
export async function createMockServer(opts = {}) {
  let callCount = { batchInstall: 0, appInstall: 0, appRollback: 0, progress: 0 };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = url.searchParams.get('sysparm_query') ?? '';

    if (path === '/api/now/stats/sys_store_app') {
      // Stats API — return count of matching apps
      const allApps = opts.allApps ?? [...MOCK_APPS, ...MOCK_APPS_CURRENT];
      let filtered = allApps;
      if (query.includes('update_available=true')) {
        filtered = allApps.filter((a) => a.update_available === 'true');
      }
      return jsonResponse(res, 200, { result: { stats: { count: String(filtered.length) } } });
    }

    if (path === '/api/now/table/sys_store_app') {
      const allApps = opts.allApps ?? [...MOCK_APPS, ...MOCK_APPS_CURRENT];
      // Filter by query
      let filtered = allApps;
      if (query.includes('update_available=true')) {
        filtered = allApps.filter((a) => a.update_available === 'true');
      }
      // Pagination support
      const limit = parseInt(url.searchParams.get('sysparm_limit') ?? '1000', 10);
      const offset = parseInt(url.searchParams.get('sysparm_offset') ?? '0', 10);
      const page = filtered.slice(offset, offset + limit);
      return jsonResponse(res, 200, { result: page });
    }

    if (path === '/api/now/table/sys_properties') {
      // Check for specific property queries
      if (query.includes('sn_cicd.apprepo.install.enabled')) {
        const enabled = opts.appRepoInstallEnabled ?? true;
        return jsonResponse(res, 200, { result: [{ value: enabled ? 'true' : 'false' }] });
      }
      return jsonResponse(res, 200, { result: [{ value: 'Yokohama Patch 3' }] });
    }

    if (path === '/api/now/table/sys_plugins') {
      const pluginId = query.match(/id=([^\^]+)/)?.[1];
      const plugins = opts.plugins ?? {
        'com.sn_cicd_spoke': { id: 'com.sn_cicd_spoke', active: 'true' },
        'com.glide.continuousdelivery': { id: 'com.glide.continuousdelivery', active: 'true' },
      };
      const match = pluginId ? plugins[pluginId] : null;
      return jsonResponse(res, 200, { result: match ? [match] : [] });
    }

    if (path === '/api/now/table/sys_user_has_role') {
      const hasRole = opts.missingRole ? [] : [{ role: 'role_sys_id' }];
      return jsonResponse(res, 200, { result: hasRole });
    }

    if (path === '/api/now/table/sys_db_object') {
      const tableName = query.match(/name=([^\^]+)/)?.[1];
      const wsDisabled = opts.wsDisabled ?? [];
      const wsAccess = wsDisabled.includes(tableName) ? 'false' : 'true';
      return jsonResponse(res, 200, { result: [{ sys_id: `dbobj_${tableName}`, name: tableName, ws_access: wsAccess }] });
    }

    if (path === '/api/now/table/sys_user_role') {
      return jsonResponse(res, 200, { result: [{ sys_id: 'role_cicd_123' }] });
    }

    if (path === '/api/now/table/sys_user') {
      return jsonResponse(res, 200, { result: [{ sys_id: 'user_admin_456' }] });
    }

    // ── Single-app install (app_repo) ──
    if (path === '/api/sn_cicd/app_repo/install' && req.method === 'POST') {
      callCount.appInstall++;
      const scope = url.searchParams.get('scope');
      const version = url.searchParams.get('version');

      // Simulate failure for specific scopes
      const failScopes = opts.failScopes ?? [];
      if (failScopes.includes(scope)) {
        return jsonResponse(res, 200, {
          result: {
            links: { progress: { id: `progress-fail-${scope}` } },
            rollback_version: null,
          },
        });
      }

      return jsonResponse(res, 200, {
        result: {
          links: { progress: { id: `progress-${scope}-${version}` } },
          rollback_version: opts.rollbackVersionMap?.[scope] ?? `${scope}-prev`,
        },
      });
    }

    // ── Single-app rollback (app_repo) ──
    if (path === '/api/sn_cicd/app_repo/rollback' && req.method === 'POST') {
      callCount.appRollback++;
      const scope = url.searchParams.get('scope');
      return jsonResponse(res, 200, {
        result: {
          links: { progress: { id: `rollback-progress-${scope}` } },
        },
      });
    }

    // ── Batch install ──
    if (path === '/api/sn_cicd/app/batch/install' && req.method === 'POST') {
      callCount.batchInstall++;
      // Simulate 503 on first call if configured
      if (opts.failBatchOnce && callCount.batchInstall === 1) {
        return jsonResponse(res, 503, { error: 'Service temporarily unavailable' });
      }
      return jsonResponse(res, 200, MOCK_BATCH_RESULT);
    }

    // ── Batch rollback ──
    if (path === '/api/sn_cicd/app/batch/rollback' && req.method === 'POST') {
      return jsonResponse(res, 200, { result: { links: { progress: { id: 'rollback-progress-456' } } } });
    }

    // ── Batch results ──
    if (path.startsWith('/api/sn_cicd/app/batch/results/')) {
      const batchResults = opts.batchResults ?? MOCK_BATCH_RESULTS;
      return jsonResponse(res, 200, batchResults);
    }

    // ── Progress polling ──
    if (path.startsWith('/api/sn_cicd/progress/')) {
      const progressId = path.split('/').pop();
      callCount.progress++;

      // Failed app progress — return numeric status 3
      if (progressId.startsWith('progress-fail-')) {
        return jsonResponse(res, 200, {
          result: { status: 3, percent_complete: 100, status_message: 'Installation failed' },
        });
      }

      // Single-app progress (app_repo) — use numeric status codes
      if (progressId.startsWith('progress-') && !progressId.startsWith('progress-abc')) {
        const key = `progress_${progressId}`;
        callCount[key] = (callCount[key] ?? 0) + 1;
        if (callCount[key] === 1 && !opts.skipInProgress) {
          return jsonResponse(res, 200, { result: { status: 1, percent_complete: 50 } });
        }
        return jsonResponse(res, 200, { result: { status: 2, percent_complete: 100 } });
      }

      // Rollback progress (app_repo) — succeed immediately
      if (progressId.startsWith('rollback-progress-') && progressId !== 'rollback-progress-456') {
        return jsonResponse(res, 200, { result: { status: 2, percent_complete: 100 } });
      }

      // Batch progress (string status codes) — existing behavior
      const batchKey = `progress_batch_${callCount.progress}`;
      if (callCount.progress === 1 && !opts.skipInProgress) {
        return jsonResponse(res, 200, { result: { percentComplete: 50, status: 'in_progress', packages: [] } });
      }
      return jsonResponse(res, 200, MOCK_PROGRESS_COMPLETE);
    }

    jsonResponse(res, 404, { error: `Unknown path: ${path}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    callCount,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
