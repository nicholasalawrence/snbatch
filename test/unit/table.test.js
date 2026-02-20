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
});
