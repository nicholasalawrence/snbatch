import { describe, it, expect } from 'vitest';
import { reconcilePackages } from '../../src/commands/reconcile.js';

const manifestPackages = [
  { scope: 'app_a', sysId: 's1', name: 'App A', currentVersion: '1.0.0', targetVersion: '1.1.0', upgradeType: 'minor' },
  { scope: 'app_b', sysId: 's2', name: 'App B', currentVersion: '2.0.0', targetVersion: '2.0.1', upgradeType: 'patch' },
  { scope: 'app_c', sysId: 's3', name: 'App C', currentVersion: '1.0.0', targetVersion: '2.0.0', upgradeType: 'major' },
  { scope: 'app_d', sysId: 's4', name: 'App D', currentVersion: '1.0.0', targetVersion: '1.0.2', upgradeType: 'patch' },
];

describe('reconcilePackages', () => {
  it('includes packages where target is behind', () => {
    const targetApps = [
      { scope: 'app_a', version: '1.0.0' },
      { scope: 'app_b', version: '2.0.0' },
    ];
    const result = reconcilePackages(manifestPackages.slice(0, 2), targetApps);
    expect(result.every((r) => r.action === 'include')).toBe(true);
  });

  it('skips packages already at target version', () => {
    const targetApps = [{ scope: 'app_b', version: '2.0.1' }];
    const [r] = reconcilePackages([manifestPackages[1]], targetApps);
    expect(r.action).toBe('skip');
    expect(r.reason).toBe('already_current');
  });

  it('skips packages not installed on target', () => {
    const [r] = reconcilePackages([manifestPackages[0]], []);
    expect(r.action).toBe('skip');
    expect(r.reason).toBe('not_installed');
  });

  it('flags version mismatches but still includes', () => {
    const targetApps = [{ scope: 'app_a', version: '0.9.0' }]; // different starting version
    const [r] = reconcilePackages([manifestPackages[0]], targetApps);
    expect(r.action).toBe('include');
    expect(r.reason).toBe('version_mismatch');
  });

  it('skips packages where target is already ahead', () => {
    const targetApps = [{ scope: 'app_c', version: '3.0.0' }]; // ahead of manifest target 2.0.0
    const [r] = reconcilePackages([manifestPackages[2]], targetApps);
    expect(r.action).toBe('skip');
    expect(r.reason).toBe('target_ahead');
  });

  it('handles mixed batch correctly', () => {
    const targetApps = [
      { scope: 'app_a', version: '1.0.0' },  // behind → include
      { scope: 'app_b', version: '2.0.1' },  // at target → skip
      // app_c not installed → skip
      { scope: 'app_d', version: '1.0.2' },  // at target → skip
    ];
    const result = reconcilePackages(manifestPackages, targetApps);
    const included = result.filter((r) => r.action === 'include');
    const skipped = result.filter((r) => r.action === 'skip');
    expect(included.map((r) => r.scope)).toEqual(['app_a']);
    expect(skipped).toHaveLength(3);
  });
});
