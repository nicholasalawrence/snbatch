/**
 * Integration test: scan → preview → install workflow against mock server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from './mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { fetchInstalledApps, fetchUpdatableApps } from '../../src/api/table.js';
import { startBatchInstall, pollProgress, fetchBatchResults } from '../../src/api/cicd.js';
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
  it('fetches all installed apps including current ones', async () => {
    const apps = await fetchInstalledApps(client);
    expect(apps).toHaveLength(4); // 3 updatable + 1 current
    expect(apps[0]).toMatchObject({ scope: 'x_snc_itsm', version: '3.2.1', type: 'app' });
  });

  it('fetches only updatable apps', async () => {
    const apps = await fetchUpdatableApps(client);
    expect(apps).toHaveLength(3);
    expect(apps.every((a) => a.updateAvailable)).toBe(true);
  });

  it('maps latest versions directly from sys_store_app', async () => {
    const apps = await fetchUpdatableApps(client);
    const itsm = apps.find((a) => a.scope === 'x_snc_itsm');
    expect(itsm.latestVersion).toBe('3.2.4');
    const hr = apps.find((a) => a.scope === 'x_snc_hr');
    expect(hr.latestVersion).toBe('4.2.1');
    const sec = apps.find((a) => a.scope === 'x_snc_sec');
    expect(sec.latestVersion).toBe('3.0.0');
  });

  it('identifies upgrades correctly', async () => {
    const apps = await fetchUpdatableApps(client);
    const packages = apps.map((a) => buildPackageObject(a, a.latestVersion));
    const upgrades = packages.filter((p) => isUpgrade(p.currentVersion, p.targetVersion));
    expect(upgrades).toHaveLength(3);
    expect(upgrades.find((p) => p.scope === 'x_snc_itsm')?.upgradeType).toBe('patch');
    expect(upgrades.find((p) => p.scope === 'x_snc_hr')?.upgradeType).toBe('minor');
    expect(upgrades.find((p) => p.scope === 'x_snc_sec')?.upgradeType).toBe('major');
  });
});

describe('manifest generation', () => {
  it('builds a deterministic manifest', async () => {
    const apps = await fetchUpdatableApps(client);
    const packages = apps.map((a) => buildPackageObject(a, a.latestVersion));
    const upgrades = packages.filter((p) => isUpgrade(p.currentVersion, p.targetVersion));

    const manifest = buildManifest(upgrades, mock.baseUrl, 'test');
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.packages.map((p) => p.scope)).toEqual(
      [...manifest.packages.map((p) => p.scope)].sort((a, b) => a.localeCompare(b))
    );
    expect(manifest.stats).toMatchObject({ total: 3, patch: 1, minor: 1, major: 1 });
  });
});

describe('batch install + poll + results', () => {
  it('starts a batch, polls to completion, and fetches results', async () => {
    const { progressId, rollbackToken, resultsId } = await startBatchInstall(client, [
      { id: 'app001', version: '3.2.4', type: 'application' },
    ]);
    expect(progressId).toBe('progress-abc-123');
    expect(rollbackToken).toBe('rollback-token-xyz');
    expect(resultsId).toBe('results-batch-789');

    const progressData = [];
    for await (const data of pollProgress(client, progressId, { pollInterval: 50, maxPollDuration: 10_000 })) {
      progressData.push(data);
    }

    const last = progressData[progressData.length - 1];
    expect(last.percentComplete).toBe(100);

    // Fetch per-package results from the dedicated results endpoint
    const results = await fetchBatchResults(client, resultsId);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'app001', name: 'ITSM Core', status: 'success' });
    expect(results[1]).toMatchObject({ id: 'app002', name: 'HR Service Delivery', status: 'success' });
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
