/**
 * snbatch install — execute a batch update
 */
import { Command } from 'commander';
import { appendFile, mkdir } from 'fs/promises';
import inquirer from 'inquirer';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { startBatchInstall, pollProgress, fetchBatchResults } from '../api/cicd.js';
import { readManifest } from '../models/manifest.js';
import { toInstallPayload } from '../models/package.js';
import { scanData } from './scan.js';
import { loadConfig } from '../utils/config.js';
import { requiresTypedConfirmation, validateTypedConfirmation } from '../utils/confirmations.js';
import { printTable, printInfo, printWarn, printError, printSuccess, createSpinner, chalk } from '../utils/display.js';
import { riskEmoji, upgradeType } from '../utils/version.js';
import { HISTORY_PATH, SNBATCH_DIR } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';
import { hashRollbackToken } from '../utils/crypto.js';

// P2-10: Restricted file permissions for history
async function appendHistory(entry) {
  await mkdir(SNBATCH_DIR, { recursive: true, mode: 0o700 });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

async function confirmInstall(packages, instanceHost, skipConfirm) {
  const stats = { patch: 0, minor: 0, major: 0 };
  for (const p of packages) stats[p.upgradeType] = (stats[p.upgradeType] ?? 0) + 1;

  const needsTyped = requiresTypedConfirmation(stats);

  if (needsTyped) {
    printWarn(`This batch includes ${stats.major} major version update(s).`);
    printWarn('Major updates may include breaking changes, schema modifications, and altered behavior.');
    if (skipConfirm) {
      printWarn('--yes cannot bypass confirmation for major updates.');
    }
    const { typed } = await inquirer.prompt([{
      type: 'input',
      name: 'typed',
      message: `Type the instance hostname to confirm (${chalk.bold(instanceHost)}):`,
    }]);
    if (!validateTypedConfirmation(typed, instanceHost)) {
      printError('Confirmation failed. Aborting.');
      process.exit(1);
    }
    return;
  }

  if (skipConfirm) return;

  const { ok } = await inquirer.prompt([{
    type: 'confirm',
    name: 'ok',
    message: `Install ${packages.length} update(s) on ${chalk.bold(instanceHost)}?`,
    default: false,
  }]);
  if (!ok) {
    printInfo('Aborted.');
    process.exit(0);
  }
}

export function installCommand() {
  return new Command('install')
    .description('Execute a batch update')
    .option('--manifest <file>', 'Install from a manifest file')
    .option('--scope <scope>', 'Install a single app by scope')
    .option('--patches', 'Install all patch updates')
    .option('--minor', 'Install all patch + minor updates')
    .option('--all', 'Install all updates including major')
    .option('--exclude <scopes>', 'Comma-separated scopes to skip')
    .option('-y, --yes', 'Skip y/N confirmation (not valid for major updates)')
    .option('--stop-on-error', 'Halt on first package failure')
    .option('--profile <name>', 'Target profile')
    .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
    .option('--allow-insecure-http', 'Allow HTTP connections (credentials sent in plaintext)')
    .option('--debug', 'Log raw API responses for diagnostics')
    // P2-12: --resume removed — planned for v1.1
    .action(async (opts) => {
      const config = await loadConfig({
        stopOnError: opts.stopOnError,
        pollInterval: Number(opts.pollInterval) * 1000,
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      try {
        const creds = await resolveCredentials(opts.profile, { allowInsecureHttp: opts.allowInsecureHttp });
        const client = createClient(creds);
        const logger = await createLogger(creds.instanceHost);
        // P2-7: Thread retry config to API calls
        const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };

        let packages;

        if (opts.manifest) {
          const manifest = await readManifest(opts.manifest);
          packages = manifest.packages;
          printInfo(`Loaded manifest: ${manifest.packages.length} package(s) from ${manifest.metadata.instance}`);
        } else {
          // Scan and filter
          const spinner = createSpinner('Scanning for updates...');
          spinner.start();
          const { upgrades } = await scanData(opts.profile, config);
          spinner.succeed(`Found ${upgrades.length} available update(s)`);

          if (opts.patches) packages = upgrades.filter((p) => p.upgradeType === 'patch');
          else if (opts.minor) packages = upgrades.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
          else packages = upgrades;
        }

        // P1-2: Filter by --scope (exact match)
        if (opts.scope) {
          packages = packages.filter((p) => p.scope === opts.scope);
          if (!packages.length) {
            printError(`No package found with scope: ${opts.scope}`);
            process.exit(2);
          }
        }

        // Apply excludes
        const excluded = config.excludeAlways ?? [];
        packages = packages.filter((p) => !excluded.includes(p.scope));

        if (!packages.length) {
          printInfo('No packages to install.');
          return;
        }

        // Show what will be installed
        printTable(
          ['Application', 'Scope', 'Current', 'Target', 'Risk'],
          packages.map((p) => [p.name, p.scope, p.currentVersion, p.targetVersion, riskEmoji(p.upgradeType)])
        );

        await confirmInstall(packages, creds.instanceHost, opts.yes ?? false);

        const debug = opts.debug ?? false;
        const payloads = packages.map(toInstallPayload);
        const spinner = createSpinner(`Starting batch install of ${packages.length} package(s)...`);
        spinner.start();

        const { progressId, rollbackToken, resultsId } = await startBatchInstall(client, payloads, retryOpts);
        logger.info('Batch install started', { progressId, rollbackToken, resultsId, packages: packages.map((p) => p.scope) });
        if (debug) {
          spinner.stop();
          printInfo(`[debug] Submission response: progressId=${progressId}, rollbackToken=${rollbackToken}, resultsId=${resultsId}`);
          spinner.start();
        }

        let lastData = null;
        let succeeded = 0;
        let failed = 0;

        for await (const data of pollProgress(client, progressId, {
          pollInterval: config.pollInterval,
          maxPollDuration: config.maxPollDuration,
          retries: config.retries,
          backoffBase: config.backoffBase,
        })) {
          lastData = data;
          const pct = data.percentComplete ?? data.percent_complete ?? 0;
          const statusVal = (data.status ?? data.state ?? '').toLowerCase();
          spinner.text = `[${Math.round(pct)}%] Installing... (${statusVal})`;
          if (debug) {
            spinner.stop();
            printInfo(`[debug] Poll: ${JSON.stringify(data)}`);
            spinner.start();
          }
        }

        spinner.stop();

        // Fetch per-package results from the dedicated results endpoint
        let results = [];
        if (resultsId) {
          try {
            results = await fetchBatchResults(client, resultsId, retryOpts);
            if (debug) {
              printInfo(`[debug] Batch results: ${JSON.stringify(results)}`);
            }
          } catch (e) {
            logger.warn('Failed to fetch batch results', { resultsId, error: e.message });
            if (debug) printWarn(`[debug] Failed to fetch batch results: ${e.message}`);
          }
        } else if (debug) {
          printWarn('[debug] No resultsId in submission response — cannot fetch per-package results');
        }

        // Fallback: if results endpoint returned nothing, try progress data
        if (!results.length) {
          results = lastData?.packages ?? lastData?.result?.packages ?? [];
          if (debug && results.length) {
            printInfo('[debug] Using package results from progress endpoint (fallback)');
          }
        }

        for (const r of results) {
          const status = (r.status ?? r.state ?? '').toLowerCase();
          if (status === 'success' || status === 'complete') succeeded++;
          else failed++;
        }

        // Display results
        if (results.length) {
          printTable(
            ['Package', 'Status'],
            results.map((r) => {
              const s = (r.status ?? r.state ?? 'unknown').toLowerCase();
              const icon = s === 'success' || s === 'complete' ? '✅' : '❌';
              return [r.name ?? r.id ?? 'unknown', `${icon} ${s}`];
            })
          );
        }

        // P1-5: Hash rollback token for history, show only last 4 chars
        const tokenHash = rollbackToken ? hashRollbackToken(rollbackToken) : null;
        const tokenHint = rollbackToken ? `...${rollbackToken.slice(-4)}` : null;

        // Write history
        const histEntry = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          instance: creds.baseUrl,
          instanceHost: creds.instanceHost,
          profile: opts.profile ?? null,
          action: 'install',
          packages: packages.map((p) => ({ scope: p.scope, from: p.currentVersion, to: p.targetVersion })),
          result: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
          progressId,
          rollbackTokenHash: tokenHash,
          rollbackTokenHint: tokenHint,
        };
        await appendHistory(histEntry);
        logger.info('Batch install complete', { succeeded, failed, rollbackToken });

        if (failed > 0 && succeeded > 0) {
          printWarn(`Partial success: ${succeeded} succeeded, ${failed} failed. Rollback token: ${tokenHint}`);
          process.exit(1);
        } else if (failed > 0) {
          // P2-11: All-failed → exit code 2 (fatal), not 1 (partial)
          printError(`All ${failed} package(s) failed. Rollback token: ${tokenHint}`);
          process.exit(2);
        } else {
          printSuccess(`All ${succeeded} package(s) installed successfully.`);
          if (tokenHint) printInfo(`Rollback token: ${tokenHint}`);
        }
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
