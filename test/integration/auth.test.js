import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCredentials } from '../../src/api/auth.js';

describe('HTTPS enforcement (P1-4)', () => {
  beforeEach(() => {
    vi.stubEnv('SNBATCH_INSTANCE', 'http://dev.service-now.com');
    vi.stubEnv('SNBATCH_USERNAME', 'admin');
    vi.stubEnv('SNBATCH_PASSWORD', 'secret');
    // Ensure SNBATCH_ALLOW_HTTP is NOT set
    delete process.env.SNBATCH_ALLOW_HTTP;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects HTTP URLs by default', async () => {
    await expect(resolveCredentials(null)).rejects.toThrow('HTTP URLs are not allowed');
  });

  it('allows HTTP URLs when SNBATCH_ALLOW_HTTP=1', async () => {
    vi.stubEnv('SNBATCH_ALLOW_HTTP', '1');
    const creds = await resolveCredentials(null);
    expect(creds.baseUrl).toBe('http://dev.service-now.com');
  });

  it('allows HTTP URLs with allowInsecureHttp option', async () => {
    const creds = await resolveCredentials(null, { allowInsecureHttp: true });
    expect(creds.baseUrl).toBe('http://dev.service-now.com');
  });

  it('accepts HTTPS URLs without issue', async () => {
    vi.stubEnv('SNBATCH_INSTANCE', 'https://dev.service-now.com');
    const creds = await resolveCredentials(null);
    expect(creds.baseUrl).toBe('https://dev.service-now.com');
  });

  it('defaults bare hostnames to HTTPS', async () => {
    vi.stubEnv('SNBATCH_INSTANCE', 'dev.service-now.com');
    const creds = await resolveCredentials(null);
    expect(creds.baseUrl).toBe('https://dev.service-now.com');
  });
});

describe('non-TTY auth detection (P2-3)', () => {
  let origIsTTY;

  beforeEach(() => {
    origIsTTY = process.stdin.isTTY;
    // Clear env vars so we fall through to interactive prompt
    delete process.env.SNBATCH_INSTANCE;
    delete process.env.SNBATCH_USERNAME;
    delete process.env.SNBATCH_PASSWORD;
  });

  afterEach(() => {
    process.stdin.isTTY = origIsTTY;
  });

  it('throws with helpful message in non-TTY environment', async () => {
    process.stdin.isTTY = false;
    await expect(resolveCredentials(null)).rejects.toThrow('No credentials found');
    await expect(resolveCredentials(null)).rejects.toThrow('SNBATCH_INSTANCE');
  });
});
