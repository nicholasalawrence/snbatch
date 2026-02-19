/**
 * snbatch scan — discover available updates
 */
import { Command } from 'commander';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { fetchInstalledApps, fetchAvailableVersions, fetchPlugins, fetchInstanceVersion } from '../api/table.js';
import { buildPackageObject } from '../models/package.js';
import { isUpgrade, riskEmoji } from '../utils/version.js';
import { printTable, printInfo, printError, createSpinner } from '../utils/display.js';
import { loadConfig } from '../utils/config.js';

/**
 * Core scan logic — returns package objects with upgrade info.
 * Separated from display for reuse by preview and MCP.
 */
export async function scanData(profileName, config) {
  const creds = await resolveCredentials(profileName);
  const client = createClient(creds);

  const [apps, plugins, instanceVersion] = await Promise.all([
    fetchInstalledApps(client),
    config.type !== 'app' ? fetchPlugins(client) : Promise.resolve([]),
    fetchInstanceVersion(client),
  ]);

  const allPackages = config.type === 'plugin' ? plugins : config.type === 'app' ? apps : [...apps, ...plugins];

  // Filter out excluded scopes
  const filtered = allPackages.filter((p) => !(config.excludeAlways ?? []).includes(p.scope));

  // Fetch available versions for apps (plugins don't use the same version API)
  const sourceIds = filtered.filter((p) => p.type === 'app' && p.sourceId).map((p) => p.sourceId);
  const versionMap = await fetchAvailableVersions(client, sourceIds);

  const packages = filtered.map((p) => {
    const latestVersion = p.type === 'app' ? (versionMap.get(p.sourceId) ?? p.version) : p.version;
    return buildPackageObject(p, latestVersion);
  });

  // Only packages with actual upgrades
  const upgrades = packages.filter((p) => isUpgrade(p.currentVersion, p.targetVersion));

  return { upgrades, creds, instanceVersion };
}

export function scanCommand() {
  return new Command('scan')
    .description('Discover available updates')
    .option('--profile <name>', 'Target profile')
    .option('--format <fmt>', 'Output format: table|json|csv', 'table')
    .option('--patches-only', 'Show only patch-level updates')
    .option('--type <type>', 'Filter by type: app|plugin|all', 'all')
    .option('--json', 'Output JSON (alias for --format json)')
    .action(async (opts) => {
      const config = await loadConfig({
        type: opts.type,
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      const isJson = opts.json || opts.format === 'json' || !process.stdout.isTTY;

      const spinner = createSpinner('Scanning instance...');
      if (!isJson) spinner.start();

      try {
        const { upgrades, creds, instanceVersion } = await scanData(opts.profile, config);
        if (!isJson) spinner.succeed(`Scanned ${creds.instanceHost} (${instanceVersion})`);

        let results = upgrades;
        if (opts.patchesOnly) results = results.filter((p) => p.upgradeType === 'patch');

        if (isJson) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
          return;
        }

        if (!results.length) {
          printInfo('No updates available.');
          return;
        }

        printTable(
          ['Application / Plugin', 'Scope', 'Current', 'Latest', 'Risk'],
          results.map((p) => [
            p.name,
            p.scope,
            p.currentVersion,
            p.targetVersion,
            riskEmoji(p.upgradeType),
          ])
        );

        const counts = { patch: 0, minor: 0, major: 0 };
        for (const p of results) counts[p.upgradeType] = (counts[p.upgradeType] ?? 0) + 1;
        printInfo(`Summary: ${counts.patch} patches, ${counts.minor} minor, ${counts.major} major — ${results.length} total updates available`);
      } catch (err) {
        if (!isJson) spinner.fail('Scan failed');
        printError(err.message);
        process.exit(2);
      }
    });
}
