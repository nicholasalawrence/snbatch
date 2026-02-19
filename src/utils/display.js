/**
 * Terminal output utilities.
 * All output is suppressed when SNBATCH_MCP_MODE=1 to protect the JSON-RPC transport.
 */
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';

const MCP_MODE = process.env.SNBATCH_MCP_MODE === '1';
const NO_COLOR = MCP_MODE || process.env.NO_COLOR || process.argv.includes('--no-color');

if (NO_COLOR) {
  chalk.level = 0;
}

// P3-3: Strip ANSI escape sequences and control characters from API data
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(str) {
  if (typeof str !== 'string') return str;
  return str.replace(ANSI_ESCAPE_RE, '').replace(CONTROL_CHARS_RE, '');
}

export function printSuccess(msg) {
  if (MCP_MODE) return;
  console.error(chalk.green('✅ ' + msg));
}

export function printError(msg) {
  if (MCP_MODE) return;
  console.error(chalk.red('❌ ' + msg));
}

export function printWarn(msg) {
  if (MCP_MODE) return;
  console.error(chalk.yellow('⚠️  ' + msg));
}

export function printInfo(msg) {
  if (MCP_MODE) return;
  console.error(chalk.cyan('ℹ  ' + msg));
}

/**
 * Print a table to stderr.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function printTable(headers, rows) {
  if (MCP_MODE) return;
  const table = new Table({
    head: headers.map((h) => chalk.bold(h)),
    style: { compact: false },
  });
  // P3-3: sanitize all cell values before display
  for (const row of rows) table.push(row.map(stripAnsi));
  console.error(table.toString());
}

/**
 * Create an ora spinner. Returns a no-op object in MCP mode.
 * @param {string} text
 */
export function createSpinner(text) {
  if (MCP_MODE) {
    // P0-2: include all methods that callers use (stop, clear, stopAndPersist)
    const noop = () => {};
    return { start: noop, succeed: noop, fail: noop, warn: noop, stop: noop, clear: noop, stopAndPersist: noop, text: '' };
  }
  return ora({ text, stream: process.stderr });
}

export { chalk };
