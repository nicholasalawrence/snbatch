import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseStartAt, formatElapsed, formatDuration } from '../../src/utils/schedule.js';

describe('parseStartAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set current time to 2025-06-15 10:00:00
    vi.setSystemTime(new Date('2025-06-15T10:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses HH:MM in the future today', () => {
    const result = parseStartAt('14:30');
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getDate()).toBe(15);
  });

  it('schedules tomorrow when HH:MM is in the past', () => {
    const result = parseStartAt('02:00');
    expect(result.getHours()).toBe(2);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(16); // next day
  });

  it('parses HH:MM:SS format', () => {
    const result = parseStartAt('14:30:45');
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(45);
  });

  it('parses ISO datetime string', () => {
    const result = parseStartAt('2025-12-25T08:00:00');
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(25);
  });

  it('throws on invalid input', () => {
    expect(() => parseStartAt('not-a-date')).toThrow('Invalid --start-at value');
  });
});

describe('formatElapsed', () => {
  it('formats seconds only', () => {
    expect(formatElapsed(42_000)).toBe('42s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(192_000)).toBe('3m 12s');
  });

  it('formats hours and minutes', () => {
    expect(formatElapsed(6_420_000)).toBe('1h 47m');
  });

  it('formats zero', () => {
    expect(formatElapsed(0)).toBe('0s');
  });
});

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(5_000)).toBe('5s');
  });

  it('formats minutes', () => {
    expect(formatDuration(720_000)).toBe('12m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(12_120_000)).toBe('3h 22m');
  });

  it('returns 0s for zero or negative', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-1000)).toBe('0s');
  });
});
