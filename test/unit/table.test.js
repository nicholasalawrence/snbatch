import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from '../integration/mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { fetchAvailableVersions } from '../../src/api/table.js';

describe('sourceId validation (P3-4)', () => {
  let mock;
  let client;

  beforeEach(async () => {
    mock = await createMockServer();
    client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
  });

  afterEach(async () => {
    await mock.close();
  });

  it('accepts valid sourceIds', async () => {
    const result = await fetchAvailableVersions(client, ['src001', 'src002']);
    expect(result.size).toBeGreaterThan(0);
  });

  it('filters out sourceIds containing query injection characters', async () => {
    // ^ORname!=admin would inject query logic
    const result = await fetchAvailableVersions(client, ['src001', 'bad^ORname!=admin']);
    // Should still work with the valid one
    expect(result.has('src001')).toBe(true);
  });

  it('returns empty map when all sourceIds are invalid', async () => {
    const result = await fetchAvailableVersions(client, ['^injection', '../traversal']);
    expect(result.size).toBe(0);
  });
});
