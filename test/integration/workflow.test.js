/**
 * Integration test: scan → preview → install workflow against mock server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from './mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { fetchInstalledApps, fetchAvailableVersions } from '../../src/api/table.js';
import { startBatchInstall, pollProgress } from '../../src/api/cicd.js';
import { buildPackageObject } from '../../src/models/package.js';
import { buildManifest, computeStats } from '../../src/models/manifest.js';
import { isUpgrade } from '../../src/utils/version.js';

let mock;
let client;

beforeEach(async () => {
  mock = await createMockServer();
  client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
});

afterEach(async () => {
  await mock.close();
});

describe('scan workflow', () => {
  it('fetches installed apps and available versions', async () => {
    const apps = await fetchInstalledApps(client);
    expect(apps).toHaveLength(3);
    expect(apps[0]).toMatchObject({ scope: 'x_snc_itsm', version: '3.2.1', type: 'app' });
  });

  it('maps available versions correctly', async () => {
    const apps = await fetchInstalledApps(client);
    const sourceIds = apps.map((a) => a.sourceId);
    const versionMap = await fetchAvailableVersions(client, sourceIds);
    expect(versionMap.get('src001')).toBe('3.2.4');
    expect(versionMap.get('src002')).toBe('4.2.1');
    expect(versionMap.get('src003')).toBe('3.0.0');
  });

  it('identifies upgrades correctly', async () => {
    const apps = await fetchInstalledApps(client);
    const sourceIds = apps.map((a) => a.sourceId);
    const versionMap = await fetchAvailableVersions(client, sourceIds);
    const packages = apps.map((a) => buildPackageObject(a, versionMap.get(a.sourceId)));
    const upgrades = packages.filter((p) => isUpgrade(p.currentVersion, p.targetVersion));
    expect(upgrades).toHaveLength(3);
    expect(upgrades.find((p) => p.scope === 'x_snc_itsm')?.upgradeType).toBe('patch');
    expect(upgrades.find((p) => p.scope === 'x_snc_hr')?.upgradeType).toBe('minor');
    expect(upgrades.find((p) => p.scope === 'x_snc_sec')?.upgradeType).toBe('major');
  });
});

describe('manifest generation', () => {
  it('builds a deterministic manifest', async () => {
    const apps = await fetchInstalledApps(client);
    const sourceIds = apps.map((a) => a.sourceId);
    const versionMap = await fetchAvailableVersions(client, sourceIds);
    const packages = apps.map((a) => buildPackageObject(a, versionMap.get(a.sourceId)));
    const upgrades = packages.filter((p) => isUpgrade(p.currentVersion, p.targetVersion));

    const manifest = buildManifest(upgrades, mock.baseUrl, 'test');
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.packages.map((p) => p.scope)).toEqual(
      [...manifest.packages.map((p) => p.scope)].sort((a, b) => a.localeCompare(b))
    );
    expect(manifest.stats).toMatchObject({ total: 3, patch: 1, minor: 1, major: 1 });
  });
});

describe('batch install + poll', () => {
  it('starts a batch and polls to completion', async () => {
    const { progressId, rollbackToken } = await startBatchInstall(client, [
      { id: 'app001', version: '3.2.4', type: 'application' },
    ]);
    expect(progressId).toBe('progress-abc-123');
    expect(rollbackToken).toBe('rollback-token-xyz');

    const results = [];
    for await (const data of pollProgress(client, progressId, { pollInterval: 50, maxPollDuration: 10_000 })) {
      results.push(data);
    }

    const last = results[results.length - 1];
    expect(last.percentComplete).toBe(100);
  });
});

describe('retry on 503', () => {
  it('retries batch install after transient 503', async () => {
    await mock.close();
    mock = await createMockServer({ failBatchOnce: true });
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });

    // withRetry should handle the 503 and succeed on second attempt
    const { progressId } = await startBatchInstall(client, [
      { id: 'app001', version: '3.2.4', type: 'application' },
    ]);
    expect(progressId).toBe('progress-abc-123');
    expect(mock.callCount.batchInstall).toBe(2);
  });
});
