import { describe, it, expect } from 'vitest';
import { compareVersions, isUpgrade, upgradeType, riskEmoji } from '../../src/utils/version.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => expect(compareVersions('1.2.3', '1.2.3')).toBe(0));
  it('returns -1 when a < b', () => expect(compareVersions('1.0.0', '2.0.0')).toBe(-1));
  it('returns 1 when a > b', () => expect(compareVersions('3.0.0', '2.9.9')).toBe(1));
  it('handles missing patch segment', () => expect(compareVersions('1.2', '1.2.0')).toBe(0));
  it('compares patch correctly', () => expect(compareVersions('1.2.3', '1.2.4')).toBe(-1));
  it('compares minor correctly', () => expect(compareVersions('1.2.9', '1.3.0')).toBe(-1));
});

describe('upgradeType', () => {
  it('returns none for equal versions', () => expect(upgradeType('1.0.0', '1.0.0')).toBe('none'));
  it('returns none for downgrade', () => expect(upgradeType('2.0.0', '1.0.0')).toBe('none'));
  it('returns patch for patch increment', () => expect(upgradeType('1.2.3', '1.2.4')).toBe('patch'));
  it('returns minor for minor increment', () => expect(upgradeType('1.2.9', '1.3.0')).toBe('minor'));
  it('returns major for major increment', () => expect(upgradeType('1.9.9', '2.0.0')).toBe('major'));
  it('returns major even if minor also increases', () => expect(upgradeType('1.0.0', '2.1.0')).toBe('major'));
});

describe('riskEmoji', () => {
  it('returns green for patch', () => expect(riskEmoji('patch')).toBe('🟢'));
  it('returns yellow for minor', () => expect(riskEmoji('minor')).toBe('🟡'));
  it('returns red for major', () => expect(riskEmoji('major')).toBe('🔴'));
  it('returns white for none', () => expect(riskEmoji('none')).toBe('⚪'));
});
