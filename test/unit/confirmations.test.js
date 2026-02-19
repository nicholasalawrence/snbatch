import { describe, it, expect } from 'vitest';
import { requiresTypedConfirmation, validateTypedConfirmation } from '../../src/utils/confirmations.js';

describe('requiresTypedConfirmation', () => {
  it('returns true when major > 0', () => expect(requiresTypedConfirmation({ major: 1 })).toBe(true));
  it('returns false when major === 0', () => expect(requiresTypedConfirmation({ major: 0 })).toBe(false));
});

describe('validateTypedConfirmation', () => {
  it('accepts exact match', () => expect(validateTypedConfirmation('dev.service-now.com', 'dev.service-now.com')).toBe(true));
  it('strips https:// prefix', () => expect(validateTypedConfirmation('https://dev.service-now.com', 'dev.service-now.com')).toBe(true));
  it('is case-insensitive', () => expect(validateTypedConfirmation('DEV.SERVICE-NOW.COM', 'dev.service-now.com')).toBe(true));
  it('strips trailing slash', () => expect(validateTypedConfirmation('dev.service-now.com/', 'dev.service-now.com')).toBe(true));
  it('rejects wrong hostname', () => expect(validateTypedConfirmation('prod.service-now.com', 'dev.service-now.com')).toBe(false));
  it('rejects empty string', () => expect(validateTypedConfirmation('', 'dev.service-now.com')).toBe(false));
});
