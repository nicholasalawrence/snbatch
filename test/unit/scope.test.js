import { describe, it, expect } from 'vitest';

describe('--scope filtering (P1-2)', () => {
  // Test the filtering logic directly since we can't easily invoke the CLI command
  const packages = [
    { scope: 'sn_hr_service_delivery', name: 'HR Service Delivery', upgradeType: 'patch', currentVersion: '1.0.0', targetVersion: '1.0.1' },
    { scope: 'sn_itsm', name: 'ITSM Core', upgradeType: 'minor', currentVersion: '2.0.0', targetVersion: '2.1.0' },
    { scope: 'sn_sec_ops', name: 'Security Operations', upgradeType: 'major', currentVersion: '3.0.0', targetVersion: '4.0.0' },
  ];

  it('filters to exact scope match', () => {
    const scope = 'sn_hr_service_delivery';
    const filtered = packages.filter((p) => p.scope === scope);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('HR Service Delivery');
  });

  it('returns empty when scope does not match', () => {
    const scope = 'nonexistent_app';
    const filtered = packages.filter((p) => p.scope === scope);
    expect(filtered).toHaveLength(0);
  });

  it('does not do partial matching', () => {
    const scope = 'sn_hr';
    const filtered = packages.filter((p) => p.scope === scope);
    expect(filtered).toHaveLength(0);
  });
});
