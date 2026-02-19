import { describe, it, expect } from 'vitest';
import { reconcilePackages } from '../../src/commands/reconcile.js';

describe('reconcile — extra_available category (P2-6)', () => {
  const manifestPackages = [
    { scope: 'app_a', sysId: 's1', name: 'App A', currentVersion: '1.0.0', targetVersion: '1.1.0', upgradeType: 'minor' },
    { scope: 'app_b', sysId: 's2', name: 'App B', currentVersion: '2.0.0', targetVersion: '2.0.1', upgradeType: 'patch' },
  ];

  it('reports extra apps on target not in manifest', () => {
    const targetApps = [
      { scope: 'app_a', version: '1.0.0', name: 'App A', type: 'app' },
      { scope: 'app_b', version: '2.0.0', name: 'App B', type: 'app' },
      { scope: 'app_extra', version: '5.0.0', name: 'Extra App', type: 'app' },
    ];

    const result = reconcilePackages(manifestPackages, targetApps);
    const extras = result.filter((r) => r.action === 'extra');
    expect(extras).toHaveLength(1);
    expect(extras[0].scope).toBe('app_extra');
    expect(extras[0].reason).toBe('extra_available');
  });

  it('reports multiple extras', () => {
    const targetApps = [
      { scope: 'app_a', version: '1.0.0', name: 'App A', type: 'app' },
      { scope: 'extra1', version: '1.0.0', name: 'Extra 1', type: 'app' },
      { scope: 'extra2', version: '2.0.0', name: 'Extra 2', type: 'plugin' },
    ];

    const result = reconcilePackages(manifestPackages, targetApps);
    const extras = result.filter((r) => r.action === 'extra');
    expect(extras).toHaveLength(2);
    expect(extras.map((e) => e.scope).sort()).toEqual(['extra1', 'extra2']);
  });

  it('reports no extras when target is subset of manifest', () => {
    const targetApps = [
      { scope: 'app_a', version: '1.0.0', name: 'App A', type: 'app' },
    ];

    const result = reconcilePackages(manifestPackages, targetApps);
    const extras = result.filter((r) => r.action === 'extra');
    expect(extras).toHaveLength(0);
  });
});

describe('reconcile — plugins included (P2-5)', () => {
  it('matches plugins from target against manifest', () => {
    const manifestPackages = [
      { scope: 'com.snc.discovery', sysId: 'p1', name: 'Discovery', currentVersion: '3.0.0', targetVersion: '3.1.0', upgradeType: 'minor' },
    ];
    const targetApps = [
      // This is a plugin on the target
      { scope: 'com.snc.discovery', version: '3.0.0', name: 'Discovery', type: 'plugin' },
    ];

    const result = reconcilePackages(manifestPackages, targetApps);
    const toInstall = result.filter((r) => r.action === 'include');
    expect(toInstall).toHaveLength(1);
    expect(toInstall[0].scope).toBe('com.snc.discovery');
  });
});
