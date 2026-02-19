/**
 * Integration test: history file and reconcile logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readManifest, buildManifest, writeManifest, validateManifest } from '../../src/models/manifest.js';
import { reconcilePackages } from '../../src/commands/reconcile.js';

const TMP = tmpdir();

describe('manifest file round-trip', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = join(TMP, `snbatch-test-${Date.now()}.json`);
  });

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it('writes and reads a manifest correctly', async () => {
    const packages = [
      { sysId: 'a1', scope: 'app_a', name: 'App A', currentVersion: '1.0.0', targetVersion: '1.1.0', upgradeType: 'minor', sourceId: 's1', packageType: 'app' },
    ];
    const manifest = buildManifest(packages, 'https://dev.service-now.com', 'dev');
    await writeManifest(manifest, tmpFile);
    const loaded = await readManifest(tmpFile);
    expect(loaded.manifestVersion).toBe(1);
    expect(loaded.packages).toHaveLength(1);
    expect(loaded.packages[0].scope).toBe('app_a');
  });

  it('throws on invalid manifest file', async () => {
    await writeFile(tmpFile, JSON.stringify({ manifestVersion: 99, metadata: {}, packages: [] }), 'utf8');
    await expect(readManifest(tmpFile)).rejects.toThrow();
  });
});

describe('reconcile with manifest', () => {
  it('correctly computes what needs installing on target', () => {
    const manifestPackages = [
      { scope: 'app_a', sysId: 's1', name: 'App A', currentVersion: '1.0.0', targetVersion: '1.1.0', upgradeType: 'minor' },
      { scope: 'app_b', sysId: 's2', name: 'App B', currentVersion: '2.0.0', targetVersion: '2.0.1', upgradeType: 'patch' },
    ];
    const targetApps = [
      { scope: 'app_a', version: '1.1.0' }, // already at target
      { scope: 'app_b', version: '2.0.0' }, // needs update
    ];
    const result = reconcilePackages(manifestPackages, targetApps);
    const toInstall = result.filter((r) => r.action === 'include');
    const skipped = result.filter((r) => r.action === 'skip');
    expect(toInstall).toHaveLength(1);
    expect(toInstall[0].scope).toBe('app_b');
    expect(skipped[0].reason).toBe('already_current');
  });
});
