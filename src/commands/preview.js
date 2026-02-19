/**
 * snbatch preview — generate a reviewable upgrade manifest
 */
import { Command } from 'commander';
import { join } from 'path';
import { scanData } from './scan.js';
import { buildManifest, writeManifest, computeStats, defaultManifestName } from '../models/manifest.js';
import { printTable, printSuccess, printInfo, printError, createSpinner, chalk } from '../utils/display.js';
import { loadConfig } from '../utils/config.js';
import { riskEmoji } from '../utils/version.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

async function getSnbatchVersion() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

export function previewCommand() {
  return new Command('preview')
    .description('Generate a reviewable upgrade manifest')
    .option('--profile <name>', 'Target profile')
    .option('--out <filename>', 'Manifest output filename')
    .option('--patches', 'Include only patch updates')
    .option('--minor', 'Include only patch + minor updates')
    .option('--major', 'Include all updates (including major)')
    .option('--all', 'Include all updates')
    .option('--exclude <scopes>', 'Comma-separated scopes to exclude')
    .option('--type <type>', 'Filter by type: app|plugin|all', 'all')
    .option('--json', 'Output manifest JSON to stdout')
    .action(async (opts) => {
      const config = await loadConfig({
        type: opts.type,
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      const spinner = createSpinner('Scanning instance...');
      if (!opts.json) spinner.start();

      try {
        const { upgrades, creds, instanceVersion } = await scanData(opts.profile, config);
        if (!opts.json) spinner.succeed(`Scanned ${creds.instanceHost} (${instanceVersion})`);

        let packages = upgrades;
        if (opts.patches) packages = packages.filter((p) => p.upgradeType === 'patch');
        else if (opts.minor) packages = packages.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
        // --major/--all: include everything

        if (!packages.length) {
          printInfo('No updates to include in manifest.');
          return;
        }

        const version = await getSnbatchVersion();
        const manifest = buildManifest(packages, creds.baseUrl, opts.profile ?? null, instanceVersion, version);

        const outputPath = opts.out ?? join(process.cwd(), defaultManifestName(creds.instanceHost));

        if (opts.json) {
          process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
          return;
        }

        await writeManifest(manifest, outputPath);

        const stats = computeStats(packages);
        printTable(
          ['Application / Plugin', 'Scope', 'Current', 'Target', 'Risk'],
          packages.map((p) => [p.name, p.scope, p.currentVersion, p.targetVersion, riskEmoji(p.upgradeType)])
        );
        printInfo(`${stats.patch} patches, ${stats.minor} minor, ${stats.major} major — ${stats.total} total`);
        printSuccess(`Manifest written to: ${chalk.underline(outputPath)}`);
      } catch (err) {
        if (!opts.json) spinner.fail('Preview failed');
        printError(err.message);
        process.exit(2);
      }
    });
}
