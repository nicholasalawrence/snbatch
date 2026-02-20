/**
 * snbatch preview — generate a reviewable upgrade manifest
 */
import { Command } from 'commander';
import { join } from 'path';
import inquirer from 'inquirer';
import { scanData, printJumboWarning } from './scan.js';
import { buildManifest, writeManifest, computeStats, defaultManifestName } from '../models/manifest.js';
import { printTable, printSuccess, printInfo, printWarn, printError, createSpinner, chalk } from '../utils/display.js';
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

/**
 * Prompt the user interactively to select which apps should have demo data loaded.
 * Returns a Set of scopes that should have loadDemoData = true.
 * In non-interactive mode, returns an empty set (no demo data).
 *
 * @param {object[]} packages — packages with hasDemoData flag
 * @param {boolean} skipConfirm — non-interactive mode (--yes)
 * @returns {Promise<Set<string>>}
 */
async function promptDemoData(packages, skipConfirm) {
  const withDemo = packages.filter((p) => p.hasDemoData);
  if (!withDemo.length) return new Set();

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY || skipConfirm) {
    printInfo(`\u{1F4E6} ${withDemo.length} app(s) have optional demo data. Skipping in non-interactive mode (defaulting to no demo data).`);
    return new Set();
  }

  printInfo(`\n\u{1F4E6} ${withDemo.length} app(s) have optional demo data available.`);

  const { choice } = await inquirer.prompt([{
    type: 'list',
    name: 'choice',
    message: 'Install demo data for:',
    choices: [
      { name: '[N] None (skip demo data for all)', value: 'none' },
      { name: '[A] All apps with demo data', value: 'all' },
      { name: '[S] Select specific apps', value: 'select' },
    ],
  }]);

  if (choice === 'none') return new Set();

  if (choice === 'all') {
    return new Set(withDemo.map((p) => p.scope));
  }

  // Select specific apps — show numbered list
  console.log();
  withDemo.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name} (${p.scope})`);
  });
  console.log();

  const { selected } = await inquirer.prompt([{
    type: 'input',
    name: 'selected',
    message: `Enter numbers of apps to include demo data for (comma-separated, e.g. 1,3,5):`,
    validate: (input) => {
      if (!input.trim()) return 'Enter at least one number, or go back and choose None.';
      const nums = input.split(',').map((s) => parseInt(s.trim(), 10));
      if (nums.some((n) => isNaN(n) || n < 1 || n > withDemo.length)) {
        return `Enter numbers between 1 and ${withDemo.length}`;
      }
      return true;
    },
  }]);

  const indices = selected.split(',').map((s) => parseInt(s.trim(), 10) - 1);
  return new Set(indices.map((i) => withDemo[i].scope));
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
    .option('-y, --yes', 'Skip interactive prompts (no demo data)')
    .option('--json', 'Output manifest JSON to stdout')
    .action(async (opts) => {
      const config = await loadConfig({
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      const spinner = createSpinner('Scanning instance...');
      if (!opts.json) spinner.start();

      try {
        const { upgrades, jumboApps, creds, instanceVersion } = await scanData(opts.profile, config);
        if (!opts.json) spinner.succeed(`Scanned ${creds.instanceHost} (${instanceVersion})`);

        let packages = upgrades;
        if (opts.patches) packages = packages.filter((p) => p.upgradeType === 'patch');
        else if (opts.minor) packages = packages.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
        // --major/--all: include everything

        // Show jumbo exclusion warning before continuing
        if (!opts.json) printJumboWarning(jumboApps);

        if (!packages.length) {
          printInfo('No updates to include in manifest.');
          return;
        }

        // Demo data selection (interactive, TTY only)
        const demoScopes = await promptDemoData(packages, opts.yes ?? false);
        if (demoScopes.size > 0) {
          packages = packages.map((p) => ({ ...p, loadDemoData: demoScopes.has(p.scope) }));
          printInfo(`\u{1F4E6} Demo data enabled for ${demoScopes.size} app(s).`);
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
          ['Application', 'Scope', 'Current', 'Target', 'Risk'],
          packages.map((p) => [
            p.name + (p.loadDemoData ? ' 📦' : ''),
            p.scope,
            p.currentVersion,
            p.targetVersion,
            riskEmoji(p.upgradeType),
          ])
        );
        const jumboNote = jumboApps.length > 0 ? ` (${jumboApps.length} jumbo excluded)` : '';
        printInfo(`${stats.patch} patches, ${stats.minor} minor, ${stats.major} major — ${stats.total} total${jumboNote}`);
        printSuccess(`Manifest written to: ${chalk.underline(outputPath)}`);
      } catch (err) {
        if (!opts.json) spinner.fail('Preview failed');
        printError(err.message);
        process.exit(2);
      }
    });
}
