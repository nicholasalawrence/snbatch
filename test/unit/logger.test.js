import { describe, it, expect } from 'vitest';
import { sanitize } from '../../src/utils/logger.js';

describe('sanitize — expanded sensitive patterns (P3-1)', () => {
  it('redacts password keys', () => {
    expect(sanitize({ password: 'secret' })).toEqual({ password: '[REDACTED]' });
  });

  it('redacts token keys', () => {
    expect(sanitize({ authToken: 'abc123' })).toEqual({ authToken: '[REDACTED]' });
  });

  it('redacts apiKey', () => {
    expect(sanitize({ apiKey: 'key123' })).toEqual({ apiKey: '[REDACTED]' });
  });

  it('redacts api_key', () => {
    expect(sanitize({ api_key: 'key123' })).toEqual({ api_key: '[REDACTED]' });
  });

  it('redacts credential', () => {
    expect(sanitize({ credential: 'cred' })).toEqual({ credential: '[REDACTED]' });
  });

  it('redacts bearer', () => {
    expect(sanitize({ bearerValue: 'tok' })).toEqual({ bearerValue: '[REDACTED]' });
  });

  it('redacts authorization', () => {
    expect(sanitize({ authorization: 'Basic abc' })).toEqual({ authorization: '[REDACTED]' });
  });

  it('redacts private_key', () => {
    expect(sanitize({ private_key: 'pk' })).toEqual({ private_key: '[REDACTED]' });
  });

  it('redacts access_token', () => {
    expect(sanitize({ access_token: 'at' })).toEqual({ access_token: '[REDACTED]' });
  });

  it('preserves non-sensitive keys', () => {
    expect(sanitize({ name: 'App', version: '1.0' })).toEqual({ name: 'App', version: '1.0' });
  });

  it('redacts URL-embedded credentials in string values', () => {
    const result = sanitize('https://admin:s3cret@dev.service-now.com');
    expect(result).not.toContain('s3cret');
    expect(result).toContain('[REDACTED]');
  });

  it('handles nested objects', () => {
    const result = sanitize({ config: { password: 'x', name: 'test' } });
    expect(result.config.password).toBe('[REDACTED]');
    expect(result.config.name).toBe('test');
  });

  it('handles arrays', () => {
    const result = sanitize([{ password: 'x' }, { name: 'y' }]);
    expect(result[0].password).toBe('[REDACTED]');
    expect(result[1].name).toBe('y');
  });
});
