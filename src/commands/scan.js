/**
 * snbatch scan — discover available updates
 *
 * Uses the update_available and latest_version fields on sys_store_app directly.
 * No need for sys_app_version queries or sourceId extraction.
 */
import { Command } from 'commander';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { fetchUpdatableApps, fetchInstanceVersion } from '../api/table.js';
import { buildPackageObject } from '../models/package.js';
import { riskEmoji } from '../utils/version.js';
import { printTable, printInfo, printWarn, printError, createSpinner } from '../utils/display.js';
import { loadConfig } from '../utils/config.js';

/**
 * Core scan logic — returns package objects with upgrade info.
 * Separated from display for reuse by preview and MCP.
 *
 * Returns:
 *   upgrades    — normal packages ready to install
 *   jumboApps   — excluded bundles requiring manual UI install
 *   creds       — resolved credentials
 *   instanceVersion
 */
export async function scanData(profileName, config) {
  const creds = await resolveCredentials(profileName);
  const client = createClient(creds);
  const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };

  const [updatableApps, instanceVersion] = await Promise.all([
    fetchUpdatableApps(client, retryOpts),
    fetchInstanceVersion(client),
  ]);

  // Filter out excluded scopes
  const filtered = updatableApps.filter((p) => !(config.excludeAlways ?? []).includes(p.scope));

  // Split jumbo apps (bundled platform plugins) from regular apps
  const jumboApps = filtered.filter((p) => p.isJumbo);
  const normal = filtered.filter((p) => !p.isJumbo);

  // Build package objects — latestVersion comes directly from sys_store_app
  const upgrades = normal.map((p) => buildPackageObject(p, p.latestVersion));

  return { upgrades, jumboApps, creds, instanceVersion };
}

/**
 * Print the jumbo app exclusion warning block.
 * @param {Array} jumboApps - Raw app rows from table.js
 */
export function printJumboWarning(jumboApps) {
  if (!jumboApps.length) return;
  printWarn(`\n${jumboApps.length} app(s) excluded — jumbo bundles requiring manual installation:`);
  for (const app of jumboApps) {
    printWarn(`  • ${app.name} (${app.scope})`);
  }
  printWarn('  These contain bundled platform plugins. Install them via the ServiceNow UI:');
  printWarn('  System Applications → All Available Applications → All');
}

export function scanCommand() {
  return new Command('scan')
    .description('Discover available updates')
    .option('--profile <name>', 'Target profile')
    .option('--format <fmt>', 'Output format: table|json|csv', 'table')
    .option('--patches-only', 'Show only patch-level updates')
    .option('--json', 'Output JSON (alias for --format json)')
    .option('--exclude <scopes>', 'Comma-separated scopes to exclude')
    .action(async (opts) => {
      const config = await loadConfig({
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      const isJson = opts.json || opts.format === 'json' || !process.stdout.isTTY;

      const spinner = createSpinner('Scanning instance...');
      if (!isJson) spinner.start();

      try {
        const { upgrades, jumboApps, creds, instanceVersion } = await scanData(opts.profile, config);
        if (!isJson) spinner.succeed(`Scanned ${creds.instanceHost} (${instanceVersion})`);

        let results = upgrades;
        if (opts.patchesOnly) results = results.filter((p) => p.upgradeType === 'patch');

        if (isJson) {
          process.stdout.write(JSON.stringify({ upgrades: results, jumboApps }, null, 2) + '\n');
          return;
        }

        if (!results.length && !jumboApps.length) {
          printInfo('No updates available.');
          return;
        }

        if (results.length) {
          printTable(
            ['Application', 'Scope', 'Current', 'Latest', 'Risk'],
            results.map((p) => [
              p.name,
              p.scope,
              p.currentVersion,
              p.targetVersion,
              riskEmoji(p.upgradeType),
            ])
          );
        }

        const counts = { patch: 0, minor: 0, major: 0 };
        for (const p of results) counts[p.upgradeType] = (counts[p.upgradeType] ?? 0) + 1;
        const jumboNote = jumboApps.length > 0 ? ` (${jumboApps.length} excluded — jumbo apps, see below)` : '';
        printInfo(`Summary: ${counts.patch} patches, ${counts.minor} minor, ${counts.major} major — ${results.length} total${jumboNote}`);

        printJumboWarning(jumboApps);
      } catch (err) {
        if (!isJson) spinner.fail('Scan failed');
        printError(err.message);
        process.exit(2);
      }
    });
}
