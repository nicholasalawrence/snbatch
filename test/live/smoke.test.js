/**
 * Live smoke tests — only run when SNBATCH_LIVE=1 is set.
 * Requires: SNBATCH_INSTANCE, SNBATCH_USERNAME, SNBATCH_PASSWORD
 */
import { describe, it, expect, beforeAll } from 'vitest';

const LIVE = process.env.SNBATCH_LIVE === '1';

describe.skipIf(!LIVE)('live smoke tests', () => {
  let client;

  beforeAll(async () => {
    const { createClient } = await import('../../src/api/index.js');
    const baseUrl = process.env.SNBATCH_INSTANCE;
    const username = process.env.SNBATCH_USERNAME;
    const password = process.env.SNBATCH_PASSWORD;
    if (!baseUrl || !username || !password) throw new Error('Missing SNBATCH_INSTANCE, SNBATCH_USERNAME, SNBATCH_PASSWORD');
    client = createClient({ baseUrl, username, password });
  });

  it('fetches installed apps', async () => {
    const { fetchInstalledApps } = await import('../../src/api/table.js');
    const apps = await fetchInstalledApps(client);
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
  });

  it('fetches instance version', async () => {
    const { fetchInstanceVersion } = await import('../../src/api/table.js');
    const version = await fetchInstanceVersion(client);
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
