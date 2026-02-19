import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, hashRollbackToken } from '../../src/utils/crypto.js';

describe('crypto round-trip', () => {
  const passphrase = 'test-passphrase-123';

  it('encrypts and decrypts a simple string', () => {
    const original = 'hello world';
    const ciphertext = encrypt(original, passphrase);
    expect(decrypt(ciphertext, passphrase)).toBe(original);
  });

  it('encrypts JSON credentials correctly', () => {
    const credentials = JSON.stringify({ username: 'admin', password: 'super$ecret!' });
    const ciphertext = encrypt(credentials, passphrase);
    expect(decrypt(ciphertext, passphrase)).toBe(credentials);
  });

  it('produces different ciphertext each time (random salt/IV)', () => {
    const msg = 'same message';
    const ct1 = encrypt(msg, passphrase);
    const ct2 = encrypt(msg, passphrase);
    expect(ct1).not.toBe(ct2);
  });

  it('throws on wrong passphrase', () => {
    const ciphertext = encrypt('secret', passphrase);
    expect(() => decrypt(ciphertext, 'wrong-passphrase')).toThrow();
  });

  it('throws on malformed ciphertext', () => {
    expect(() => decrypt('not:valid', passphrase)).toThrow('Invalid ciphertext format');
  });
});

describe('hashRollbackToken (P1-5)', () => {
  it('returns a SHA-256 hex string', () => {
    const hash = hashRollbackToken('rollback-token-xyz');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = hashRollbackToken('my-token');
    const h2 = hashRollbackToken('my-token');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different tokens', () => {
    const h1 = hashRollbackToken('token-a');
    const h2 = hashRollbackToken('token-b');
    expect(h1).not.toBe(h2);
  });
});
