import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/utils/config.js';

describe('loadConfig — exclude merging (P1-1)', () => {
  it('reads excludeAlways from CLI overrides (not "exclude")', async () => {
    const config = await loadConfig({ excludeAlways: ['sn_devstudio', 'sn_atf'] });
    expect(config.excludeAlways).toContain('sn_devstudio');
    expect(config.excludeAlways).toContain('sn_atf');
  });

  it('returns empty excludeAlways when no excludes provided', async () => {
    const config = await loadConfig({});
    expect(config.excludeAlways).toEqual([]);
  });

  it('deduplicates exclude scopes', async () => {
    const config = await loadConfig({ excludeAlways: ['sn_devstudio', 'sn_devstudio'] });
    expect(config.excludeAlways).toEqual(['sn_devstudio']);
  });
});

describe('loadConfig — retry tunables (P2-7)', () => {
  it('exposes retries and backoffBase defaults', async () => {
    const config = await loadConfig({});
    expect(config.retries).toBe(3);
    expect(config.backoffBase).toBe(2000);
  });

  it('allows overriding retries via CLI', async () => {
    const config = await loadConfig({ retries: 5 });
    expect(config.retries).toBe(5);
  });

  describe('env var override', () => {
    beforeEach(() => {
      vi.stubEnv('SNBATCH_RETRIES', '7');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('allows overriding retries via env var', async () => {
      const config = await loadConfig({});
      expect(config.retries).toBe(7);
    });
  });
});
