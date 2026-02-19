/**
 * snbatch reconcile — adapt a manifest for a different environment
 */
import { Command } from 'commander';
import { join } from 'path';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { fetchInstalledApps, fetchAvailableVersions, fetchPlugins } from '../api/table.js';
import { readManifest, buildManifest, writeManifest, defaultManifestName } from '../models/manifest.js';
import { buildPackageObject } from '../models/package.js';
import { compareVersions } from '../utils/version.js';
import { printTable, printInfo, printError, printSuccess, printWarn, createSpinner, chalk } from '../utils/display.js';
import { loadConfig } from '../utils/config.js';

const ACTIONS = {
  INCLUDE: '✅ Include',
  SKIP_CURRENT: '⏭️ Already current',
  VERSION_MISMATCH: '⚠️ Version mismatch',
  NOT_INSTALLED: '❌ Not installed',
  EXTRA: '➕ Extra on target',
};

/**
 * Core reconcile logic — pure function for testability.
 * P2-6: Added 'extra_available' category for apps on target not in manifest.
 */
export function reconcilePackages(manifestPackages, targetApps) {
  const targetMap = new Map(targetApps.map((a) => [a.scope, a]));
  const manifestScopes = new Set(manifestPackages.map((p) => p.scope));
  const results = [];

  for (const pkg of manifestPackages) {
    const target = targetMap.get(pkg.scope);

    if (!target) {
      results.push({ ...pkg, action: 'skip', reason: 'not_installed' });
      continue;
    }

    const cmp = compareVersions(target.version, pkg.targetVersion);
    if (cmp === 0) {
      results.push({ ...pkg, targetCurrentVersion: target.version, action: 'skip', reason: 'already_current' });
    } else if (cmp < 0) {
      // Target is behind — include (possibly with version mismatch warning)
      const startDiffers = target.version !== pkg.currentVersion;
      results.push({
        ...pkg,
        targetCurrentVersion: target.version,
        action: 'include',
        reason: startDiffers ? 'version_mismatch' : 'matched',
      });
    } else {
      // Target is ahead — skip
      results.push({ ...pkg, targetCurrentVersion: target.version, action: 'skip', reason: 'target_ahead' });
    }
  }

  // P2-6: Report apps/plugins on target that are NOT in the source manifest
  for (const [scope, target] of targetMap) {
    if (!manifestScopes.has(scope)) {
      results.push({
        scope,
        name: target.name,
        currentVersion: target.version,
        targetVersion: target.version,
        targetCurrentVersion: target.version,
        action: 'extra',
        reason: 'extra_available',
        packageType: target.type ?? 'app',
      });
    }
  }

  return results;
}

export function reconcileCommand() {
  return new Command('reconcile')
    .description('Adapt a manifest for a different environment')
    .requiredOption('--manifest <file>', 'Source manifest file')
    .requiredOption('--profile <name>', 'Target instance profile')
    .option('--out <file>', 'Output filename for adjusted manifest')
    .option('--execute', 'Execute the reconciled manifest immediately')
    .action(async (opts) => {
      const config = await loadConfig({});

      try {
        const sourceManifest = await readManifest(opts.manifest);
        printInfo(`Source manifest: ${sourceManifest.packages.length} packages from ${sourceManifest.metadata.instance}`);

        const creds = await resolveCredentials(opts.profile);
        const client = createClient(creds);

        const spinner = createSpinner(`Scanning target: ${creds.instanceHost}...`);
        spinner.start();

        // P2-5: Include plugins in target scan
        const [targetApps, targetPlugins] = await Promise.all([
          fetchInstalledApps(client),
          fetchPlugins(client),
        ]);
        const allTarget = [...targetApps, ...targetPlugins];
        spinner.succeed(`Scanned ${creds.instanceHost}`);

        const reconciled = reconcilePackages(sourceManifest.packages, allTarget);

        // Display diff table
        printTable(
          ['Scope', 'Source Target', 'Target Current', 'Action'],
          reconciled.map((r) => {
            let action;
            if (r.action === 'extra') action = ACTIONS.EXTRA;
            else if (r.action === 'include') action = r.reason === 'version_mismatch' ? ACTIONS.VERSION_MISMATCH : ACTIONS.INCLUDE;
            else if (r.reason === 'not_installed') action = ACTIONS.NOT_INSTALLED;
            else action = ACTIONS.SKIP_CURRENT;
            return [r.scope, r.targetVersion, r.targetCurrentVersion ?? '—', action];
          })
        );

        const toInstall = reconciled.filter((r) => r.action === 'include');
        const skipped = reconciled.filter((r) => r.action === 'skip');
        const extras = reconciled.filter((r) => r.action === 'extra');
        const mismatches = reconciled.filter((r) => r.reason === 'version_mismatch');

        printInfo(`${toInstall.length} to install, ${skipped.length} skipped`);
        if (extras.length) printInfo(`${extras.length} extra app(s)/plugin(s) on target not in source manifest`);
        if (mismatches.length) printWarn(`${mismatches.length} package(s) have version mismatches — review before proceeding`);

        if (!toInstall.length) {
          printInfo('Nothing to install on target.');
          return;
        }

        const outputPath = opts.out ?? join(process.cwd(), defaultManifestName(creds.instanceHost));
        const adjustedManifest = buildManifest(toInstall, creds.baseUrl, opts.profile);
        await writeManifest(adjustedManifest, outputPath);
        printSuccess(`Adjusted manifest written to: ${chalk.underline(outputPath)}`);

        if (opts.execute) {
          printInfo('--execute flag detected. Run: snbatch install --manifest ' + outputPath);
          // For safety, we don't auto-trigger install — user runs it explicitly
        }
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
