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
  for (const row of rows) table.push(row);
  console.error(table.toString());
}

/**
 * Create an ora spinner. Returns a no-op object in MCP mode.
 * @param {string} text
 */
export function createSpinner(text) {
  if (MCP_MODE) {
    return { start: () => {}, succeed: () => {}, fail: () => {}, warn: () => {}, text: '' };
  }
  return ora({ text, stream: process.stderr });
}

export { chalk };
