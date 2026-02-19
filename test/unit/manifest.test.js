import { describe, it, expect } from 'vitest';
import { buildManifest, computeStats, validateManifest } from '../../src/models/manifest.js';

const samplePackages = [
  { sysId: 'z', scope: 'z_scope', name: 'Z App', currentVersion: '1.0.0', targetVersion: '1.1.0', upgradeType: 'minor', sourceId: 's1', packageType: 'app' },
  { sysId: 'a', scope: 'a_scope', name: 'A App', currentVersion: '2.0.0', targetVersion: '2.0.1', upgradeType: 'patch', sourceId: 's2', packageType: 'app' },
  { sysId: 'm', scope: 'm_scope', name: 'M App', currentVersion: '1.0.0', targetVersion: '2.0.0', upgradeType: 'major', sourceId: 's3', packageType: 'app' },
];

describe('buildManifest', () => {
  it('sorts packages alphabetically by scope', () => {
    const manifest = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    expect(manifest.packages.map((p) => p.scope)).toEqual(['a_scope', 'm_scope', 'z_scope']);
  });

  it('is deterministic — same packages produce same sorted order', () => {
    const m1 = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    const shuffled = [samplePackages[2], samplePackages[0], samplePackages[1]];
    const m2 = buildManifest(shuffled, 'https://dev.service-now.com', 'dev');
    expect(m1.packages.map((p) => p.scope)).toEqual(m2.packages.map((p) => p.scope));
  });

  it('sets manifestVersion to 1', () => {
    const manifest = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    expect(manifest.manifestVersion).toBe(1);
  });

  it('includes stats', () => {
    const manifest = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    expect(manifest.stats).toEqual({ total: 3, patch: 1, minor: 1, major: 1, none: 0 });
  });
});

describe('computeStats', () => {
  it('counts upgrade types correctly', () => {
    expect(computeStats(samplePackages)).toEqual({ total: 3, patch: 1, minor: 1, major: 1, none: 0 });
  });

  it('handles empty array', () => {
    expect(computeStats([])).toEqual({ total: 0, patch: 0, minor: 0, major: 0, none: 0 });
  });
});

describe('validateManifest', () => {
  it('validates a correct manifest', () => {
    const m = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    expect(validateManifest(m).valid).toBe(true);
  });

  it('rejects null', () => {
    expect(validateManifest(null).valid).toBe(false);
  });

  it('rejects missing packages array', () => {
    expect(validateManifest({ manifestVersion: 1, metadata: { instance: 'x' } }).valid).toBe(false);
  });

  it('rejects wrong manifestVersion', () => {
    const m = buildManifest(samplePackages, 'https://dev.service-now.com', 'dev');
    expect(validateManifest({ ...m, manifestVersion: 99 }).valid).toBe(false);
  });
});
