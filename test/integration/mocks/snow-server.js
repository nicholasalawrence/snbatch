/**
 * Lightweight mock ServiceNow HTTP server for integration tests.
 * Uses Node's built-in http module — no external dependencies.
 */
import { createServer } from 'http';

export const MOCK_APPS = [
  { sys_id: 'app001', scope: 'x_snc_itsm', name: 'ITSM Core', version: '3.2.1', source: { value: 'src001' }, active: 'true' },
  { sys_id: 'app002', scope: 'x_snc_hr',   name: 'HR Service Delivery', version: '4.1.0', source: { value: 'src002' }, active: 'true' },
  { sys_id: 'app003', scope: 'x_snc_sec',  name: 'Security Operations', version: '2.0.3', source: { value: 'src003' }, active: 'true' },
];

export const MOCK_VERSIONS = [
  { source: { value: 'src001' }, version: '3.2.4' },
  { source: { value: 'src002' }, version: '4.2.1' },
  { source: { value: 'src003' }, version: '3.0.0' },
];

export const MOCK_BATCH_RESULT = {
  result: {
    links: {
      progress: { id: 'progress-abc-123' },
      rollback: { id: 'rollback-token-xyz' },
    },
  },
};

export const MOCK_PROGRESS_COMPLETE = {
  result: {
    percentComplete: 100,
    status: 'complete',
    packages: [
      { id: 'app001', name: 'ITSM Core', status: 'success' },
      { id: 'app002', name: 'HR Service Delivery', status: 'success' },
    ],
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
  let callCount = { batchInstall: 0, progress: 0 };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/api/now/table/sys_store_app') {
      return jsonResponse(res, 200, { result: MOCK_APPS });
    }

    if (path === '/api/now/table/sys_app_version') {
      return jsonResponse(res, 200, { result: MOCK_VERSIONS });
    }

    if (path === '/api/now/table/sys_plugins') {
      return jsonResponse(res, 200, { result: [] });
    }

    if (path === '/api/now/table/sys_properties') {
      return jsonResponse(res, 200, { result: [{ value: 'Yokohama Patch 3' }] });
    }

    if (path === '/api/sn_cicd/app/batch/install' && req.method === 'POST') {
      callCount.batchInstall++;
      // Simulate 503 on first call if configured
      if (opts.failBatchOnce && callCount.batchInstall === 1) {
        return jsonResponse(res, 503, { error: 'Service temporarily unavailable' });
      }
      return jsonResponse(res, 200, MOCK_BATCH_RESULT);
    }

    if (path === '/api/sn_cicd/app/batch/rollback' && req.method === 'POST') {
      return jsonResponse(res, 200, { result: { links: { progress: { id: 'rollback-progress-456' } } } });
    }

    if (path.startsWith('/api/sn_cicd/progress/')) {
      callCount.progress++;
      // Return in-progress on first poll, complete on subsequent
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
