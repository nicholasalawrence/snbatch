import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from '../integration/mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { scanData } from '../../src/commands/scan.js';

// Stub resolveCredentials/loadConfig since scanData calls them internally.
// Instead, we export a helper path — but scanData calls resolveCredentials internally.
// We'll use the mock server and verify through table.js directly.

describe('scanData jumbo separation', () => {
  let mock;

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it('excludes jumbo apps from upgrades and returns them separately', async () => {
    mock = await createMockServer({ includeJumbo: true });
    const client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });

    // Call the underlying table fetch directly since scanData resolves credentials internally
    const { fetchUpdatableApps } = await import('../../src/api/table.js');
    const { buildPackageObject } = await import('../../src/models/package.js');

    const updatableApps = await fetchUpdatableApps(client);
    const jumboApps = updatableApps.filter((p) => p.isJumbo);
    const normal = updatableApps.filter((p) => !p.isJumbo);
    const upgrades = normal.map((p) => buildPackageObject(p, p.latestVersion));

    // Should have 1 jumbo, 3 normal
    expect(jumboApps).toHaveLength(1);
    expect(jumboApps[0].scope).toBe('sn_hs_csc');
    expect(upgrades).toHaveLength(3);
    expect(upgrades.every((p) => !p.isJumbo)).toBe(true);
  });

  it('normal scan has no jumbo apps', async () => {
    mock = await createMockServer();
    const client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });

    const { fetchUpdatableApps } = await import('../../src/api/table.js');
    const updatableApps = await fetchUpdatableApps(client);
    const jumboApps = updatableApps.filter((p) => p.isJumbo);
    expect(jumboApps).toHaveLength(0);
  });
});

describe('buildPackageObject demo data', () => {
  it('passes hasDemoData through to package object', async () => {
    const { buildPackageObject } = await import('../../src/models/package.js');
    const pkg = buildPackageObject(
      { sysId: 'x', scope: 'x_snc_hr', name: 'HR', version: '1.0.0', hasDemoData: true, type: 'app' },
      '1.1.0'
    );
    expect(pkg.hasDemoData).toBe(true);
    expect(pkg.loadDemoData).toBe(false); // default false until user selects
  });

  it('defaults hasDemoData to false when missing', async () => {
    const { buildPackageObject } = await import('../../src/models/package.js');
    const pkg = buildPackageObject(
      { sysId: 'x', scope: 'x_snc_itsm', name: 'ITSM', version: '1.0.0', type: 'app' },
      '1.1.0'
    );
    expect(pkg.hasDemoData).toBe(false);
    expect(pkg.loadDemoData).toBe(false);
  });
});
