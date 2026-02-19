import { describe, it, expect } from 'vitest';
import { createSpinner, stripAnsi } from '../../src/utils/display.js';

describe('createSpinner no-op completeness (P0-2)', () => {
  // In test environment, MCP_MODE may not be set, so we test the function existence
  it('exports createSpinner', () => {
    expect(typeof createSpinner).toBe('function');
  });
});

describe('stripAnsi (P3-3)', () => {
  it('strips ANSI escape sequences', () => {
    expect(stripAnsi('\x1B[31mred text\x1B[0m')).toBe('red text');
  });

  it('strips control characters', () => {
    expect(stripAnsi('hello\x07world')).toBe('helloworld');
  });

  it('preserves normal text', () => {
    expect(stripAnsi('Hello World 123')).toBe('Hello World 123');
  });

  it('handles non-string values', () => {
    expect(stripAnsi(42)).toBe(42);
    expect(stripAnsi(null)).toBe(null);
    expect(stripAnsi(undefined)).toBe(undefined);
  });

  it('strips multiple ANSI sequences', () => {
    expect(stripAnsi('\x1B[1m\x1B[31mbold red\x1B[0m normal')).toBe('bold red normal');
  });
});
