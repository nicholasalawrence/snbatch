import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from '../integration/mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { fetchInstalledApps, fetchUpdatableApps } from '../../src/api/table.js';

describe('fetchInstalledApps', () => {
  let mock;
  let client;

  beforeEach(async () => {
    mock = await createMockServer();
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
  });

  afterEach(async () => {
    await mock.close();
  });

  it('returns all installed apps with version info', async () => {
    const apps = await fetchInstalledApps(client);
    expect(apps).toHaveLength(4);
    expect(apps[0]).toMatchObject({
      sysId: 'app001',
      scope: 'x_snc_itsm',
      version: '3.2.1',
      latestVersion: '3.2.4',
      updateAvailable: true,
      type: 'app',
    });
  });

  it('parses update_available as boolean', async () => {
    const apps = await fetchInstalledApps(client);
    const current = apps.find((a) => a.scope === 'x_snc_csm');
    expect(current.updateAvailable).toBe(false);
    expect(current.latestVersion).toBe('1.5.0');
  });
});

describe('fetchInstalledApps pagination', () => {
  let mock;
  let client;

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it('paginates when results exceed page size', async () => {
    // Generate 600 mock apps to test pagination (PAGE_SIZE is 500)
    const manyApps = Array.from({ length: 600 }, (_, i) => ({
      sys_id: `app_${String(i).padStart(3, '0')}`,
      scope: `x_snc_app_${i}`,
      name: `App ${i}`,
      version: '1.0.0',
      latest_version: '1.0.1',
      update_available: 'true',
      active: 'true',
    }));
    mock = await createMockServer({ allApps: manyApps });
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });

    const apps = await fetchInstalledApps(client);
    expect(apps).toHaveLength(600);
    expect(apps[0].scope).toBe('x_snc_app_0');
    expect(apps[599].scope).toBe('x_snc_app_599');
  });
});

describe('fetchUpdatableApps', () => {
  let mock;
  let client;

  beforeEach(async () => {
    mock = await createMockServer();
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
  });

  afterEach(async () => {
    await mock.close();
  });

  it('returns only apps with updates available', async () => {
    const apps = await fetchUpdatableApps(client);
    expect(apps).toHaveLength(3);
    expect(apps.every((a) => a.updateAvailable)).toBe(true);
  });

  it('includes latestVersion from sys_store_app', async () => {
    const apps = await fetchUpdatableApps(client);
    const itsm = apps.find((a) => a.scope === 'x_snc_itsm');
    expect(itsm.latestVersion).toBe('3.2.4');
    expect(itsm.version).toBe('3.2.1');
  });

  it('maps demo_data field — hasDemoData true for "Has demo data"', async () => {
    const apps = await fetchUpdatableApps(client);
    const hr = apps.find((a) => a.scope === 'x_snc_hr');
    expect(hr.hasDemoData).toBe(true);
    const itsm = apps.find((a) => a.scope === 'x_snc_itsm');
    expect(itsm.hasDemoData).toBe(false);
  });

  it('detects jumbo apps from apps_in_jumbo field', async () => {
    if (mock) await mock.close();
    mock = await createMockServer({ includeJumbo: true });
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    const apps = await fetchUpdatableApps(client);
    const jumbo = apps.find((a) => a.scope === 'sn_hs_csc');
    expect(jumbo).toBeDefined();
    expect(jumbo.isJumbo).toBe(true);
    expect(jumbo.appsInJumbo).toEqual(['com.sn_hs_core', 'com.sn_hs_ext']);
    const normal = apps.find((a) => a.scope === 'x_snc_itsm');
    expect(normal.isJumbo).toBe(false);
  });
});
