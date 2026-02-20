/**
 * Schedule utilities for --start-at and elapsed time formatting.
 */
import { sleep } from './retry.js';

/**
 * Parse a --start-at value into a target Date.
 * Accepts "HH:MM" or "HH:MM:SS" (24h) — schedules for today, or tomorrow if already past.
 * Also accepts ISO 8601 datetime strings.
 * @param {string} input
 * @returns {Date}
 */
export function parseStartAt(input) {
  const timeMatch = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const [, h, m, s] = timeMatch;
    const now = new Date();
    const target = new Date(now);
    target.setHours(parseInt(h, 10), parseInt(m, 10), parseInt(s ?? '0', 10), 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid --start-at value: "${input}". Use HH:MM or ISO datetime.`);
  }
  return parsed;
}

/**
 * Format a millisecond duration for countdown display: "3h 22m" or "12m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

/**
 * Format a millisecond duration as elapsed time: "42s", "3m 12s", "1h 47m".
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Format a Date as a readable time string (e.g. "02:00 AM").
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Sleep loop that displays a countdown on stderr every 30 seconds.
 * @param {Date} targetTime
 */
export async function waitUntil(targetTime) {
  const remaining = targetTime.getTime() - Date.now();
  if (remaining <= 0) return;

  const timeStr = formatTime(targetTime);
  const isTTY = process.stderr.isTTY;

  const writeLine = (msg) => {
    if (isTTY) {
      process.stderr.write(`\r\x1b[K${msg}`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
  };

  writeLine(`\u23F3 Waiting to start at ${timeStr} (${formatDuration(remaining)} remaining)... Press Ctrl+C to cancel.`);

  while (Date.now() < targetTime.getTime()) {
    const wait = Math.min(30_000, targetTime.getTime() - Date.now());
    if (wait <= 0) break;
    await sleep(wait);
    const left = targetTime.getTime() - Date.now();
    if (left > 0) {
      writeLine(`\u23F3 Waiting to start at ${timeStr} (${formatDuration(left)} remaining)... Press Ctrl+C to cancel.`);
    }
  }

  if (isTTY) process.stderr.write('\r\x1b[K');
  process.stderr.write('\n');
}
