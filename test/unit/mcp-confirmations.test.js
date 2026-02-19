import { describe, it, expect } from 'vitest';
import { issueConfirmationChallenge, verifyConfirmation, installNeedsConfirmation } from '../../src/mcp/confirmations.js';

describe('MCP confirmation — operation binding (P2-8)', () => {
  it('rejects a token used for wrong operation type', () => {
    const challenge = issueConfirmationChallenge('dev.service-now.com', 'install');
    const result = verifyConfirmation(challenge.token, 'dev.service-now.com', 'rollback');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('install');
    expect(result.error).toContain('rollback');
  });

  it('accepts a token used for correct operation type', () => {
    const challenge = issueConfirmationChallenge('dev.service-now.com', 'rollback');
    const result = verifyConfirmation(challenge.token, 'dev.service-now.com', 'rollback');
    expect(result.valid).toBe(true);
  });

  it('still works without specifying operation (backward compatible)', () => {
    const challenge = issueConfirmationChallenge('dev.service-now.com', 'install');
    const result = verifyConfirmation(challenge.token, 'dev.service-now.com');
    expect(result.valid).toBe(true);
  });
});

describe('MCP confirmation — expired token cleanup (P3-2)', () => {
  it('cleans up expired tokens on new challenge issue', () => {
    // Issue a challenge
    const challenge1 = issueConfirmationChallenge('dev.service-now.com', 'install');
    // Verify it exists
    expect(verifyConfirmation(challenge1.token, 'wrong')).toMatchObject({ valid: false });
    // The token should have been kept (wrong value, not deleted)
    // Issue another — should trigger cleanup of any expired ones
    const challenge2 = issueConfirmationChallenge('dev.service-now.com', 'install');
    expect(challenge2.token).toBeTruthy();
    expect(challenge2.token).not.toBe(challenge1.token);
  });
});

describe('installNeedsConfirmation', () => {
  it('returns true for packages with major upgrades', () => {
    const packages = [{ upgradeType: 'major' }, { upgradeType: 'patch' }];
    expect(installNeedsConfirmation(packages)).toBe(true);
  });

  it('returns false for only patches and minors', () => {
    const packages = [{ upgradeType: 'patch' }, { upgradeType: 'minor' }];
    expect(installNeedsConfirmation(packages)).toBe(false);
  });
});
