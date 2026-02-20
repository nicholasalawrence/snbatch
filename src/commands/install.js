/**
 * snbatch install — execute app updates (sequential by default, --batch for legacy API)
 */
import { Command } from 'commander';
import { appendFile, mkdir } from 'fs/promises';
import inquirer from 'inquirer';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { installApp, pollProgress, isProgressSuccess, startBatchInstall, fetchBatchResults } from '../api/cicd.js';
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
import { parseStartAt, waitUntil, formatElapsed } from '../utils/schedule.js';
import { checkCICDCredentialAlias } from './doctor.js';

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

// ── Sequential install (default) ─────────────────────────────────────

async function runSequentialInstall(client, packages, config, opts, creds, logger) {
  const total = packages.length;
  let succeeded = 0;
  let failed = 0;
  const failedPackages = [];
  const rollbackVersions = [];
  const totalStart = Date.now();
  const debug = opts.debug ?? false;
  const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };
  const isTTY = process.stderr.isTTY;

  for (let i = 0; i < total; i++) {
    const pkg = packages[i];
    const idx = i + 1;
    const label = `${pkg.name} ${pkg.currentVersion} \u2192 ${pkg.targetVersion}`;

    // Show in-progress line
    const inProgressLine = `[${idx}/${total}] \uD83D\uDD04 ${label}...`;
    if (isTTY) {
      process.stderr.write(`\r\x1b[K${inProgressLine}`);
    } else {
      process.stderr.write(`${inProgressLine}\n`);
    }

    const appStart = Date.now();

    try {
      const { progressId, rollbackVersion } = await installApp(client, pkg.scope, pkg.targetVersion, retryOpts);

      if (rollbackVersion) {
        rollbackVersions.push({ scope: pkg.scope, version: rollbackVersion });
      }

      if (debug) {
        if (isTTY) process.stderr.write('\n');
        printInfo(`[debug] installApp response: progressId=${progressId}, rollbackVersion=${rollbackVersion}`);
      }

      // Poll to completion
      let lastData = null;
      for await (const data of pollProgress(client, progressId, {
        pollInterval: config.sequentialPollInterval,
        maxPollDuration: config.maxPollDuration,
        retries: config.retries,
        backoffBase: config.backoffBase,
      })) {
        lastData = data;
        if (debug) {
          if (isTTY) process.stderr.write('\n');
          printInfo(`[debug] Poll: ${JSON.stringify(data)}`);
        }
      }

      const appElapsed = formatElapsed(Date.now() - appStart);
      const success = isProgressSuccess(lastData);

      if (success) {
        succeeded++;
        const successLine = `[${idx}/${total}] \u2705 ${label} (${appElapsed})`;
        if (isTTY) {
          process.stderr.write(`\r\x1b[K${successLine}\n`);
        } else {
          process.stderr.write(`${successLine}\n`);
        }
      } else {
        failed++;
        const errorMsg = lastData?.status_message ?? 'Failed';
        failedPackages.push({ ...pkg, error: errorMsg });
        const failLine = `[${idx}/${total}] \u274C ${label} (${appElapsed}) \u2014 ${errorMsg}`;
        if (isTTY) {
          process.stderr.write(`\r\x1b[K${failLine}\n`);
        } else {
          process.stderr.write(`${failLine}\n`);
        }

        // Handle failure continuation
        if (!opts.continueOnError && i < total - 1) {
          if (opts.stopOnError || !isTTY) {
            printError('Halting on first failure.');
            break;
          }
          const remaining = total - idx;
          const { cont } = await inquirer.prompt([{
            type: 'confirm',
            name: 'cont',
            message: `Continue with remaining ${remaining} package(s)?`,
            default: false,
          }]);
          if (!cont) break;
        }
      }

      logger.info('App install complete', { scope: pkg.scope, progressId, success, elapsed: appElapsed });

    } catch (err) {
      const appElapsed = formatElapsed(Date.now() - appStart);
      failed++;
      failedPackages.push({ ...pkg, error: err.message });
      const failLine = `[${idx}/${total}] \u274C ${label} (${appElapsed}) \u2014 ${err.message}`;
      if (isTTY) {
        process.stderr.write(`\r\x1b[K${failLine}\n`);
      } else {
        process.stderr.write(`${failLine}\n`);
      }

      logger.info('App install error', { scope: pkg.scope, error: err.message, elapsed: appElapsed });

      if (!opts.continueOnError && i < total - 1) {
        if (opts.stopOnError || !isTTY) {
          printError('Halting on first failure.');
          break;
        }
        const remaining = total - idx;
        const { cont } = await inquirer.prompt([{
          type: 'confirm',
          name: 'cont',
          message: `Continue with remaining ${remaining} package(s)?`,
          default: false,
        }]);
        if (!cont) break;
      }
    }
  }

  const totalElapsed = formatElapsed(Date.now() - totalStart);

  // Final summary
  process.stderr.write('\n');
  const summary = [];
  summary.push(`\u2705 ${succeeded} succeeded`);
  if (failed > 0) summary.push(chalk.red(`\u274C ${failed} failed`));
  else summary.push(`\u274C 0 failed`);
  summary.push(`\u23F1\uFE0F  ${totalElapsed} total`);
  printInfo(summary.join(', '));

  if (failedPackages.length > 0) {
    process.stderr.write('\n');
    printError('Failed:');
    for (const fp of failedPackages) {
      printError(`  ${fp.scope} ${fp.currentVersion} \u2192 ${fp.targetVersion}: "${fp.error}"`);
    }
  }

  return { succeeded, failed, failedPackages, rollbackVersions };
}

// ── Batch install (--batch flag) ─────────────────────────────────────

async function runBatchInstall(client, packages, config, opts, creds, logger) {
  const debug = opts.debug ?? false;
  const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };
  const payloads = packages.map(toInstallPayload);
  const spinner = createSpinner(`Starting batch install of ${packages.length} package(s)...`);
  spinner.start();

  const { progressId, rollbackToken, resultsId } = await startBatchInstall(client, payloads, retryOpts);
  const tokenHintShort = rollbackToken ? `...${rollbackToken.slice(-4)}` : null;
  logger.info('Batch install started', { progressId, rollbackTokenHint: tokenHintShort, resultsId, packages: packages.map((p) => p.scope) });
  if (debug) {
    spinner.stop();
    printInfo(`[debug] Submission response: progressId=${progressId}, rollbackToken=${tokenHintShort}, resultsId=${resultsId}`);
    spinner.start();
  }

  let lastData = null;
  for await (const data of pollProgress(client, progressId, {
    pollInterval: config.pollInterval,
    maxPollDuration: config.maxPollDuration,
    retries: config.retries,
    backoffBase: config.backoffBase,
  })) {
    lastData = data;
    const pct = data.percentComplete ?? data.percent_complete ?? 0;
    const statusVal = (data.status ?? data.state ?? '').toString().toLowerCase();
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
      if (debug) printInfo(`[debug] Batch results: ${JSON.stringify(results)}`);
    } catch (e) {
      logger.warn('Failed to fetch batch results', { resultsId, error: e.message });
      if (debug) printWarn(`[debug] Failed to fetch batch results: ${e.message}`);
    }
  }
  if (!results.length) {
    results = lastData?.packages ?? lastData?.result?.packages ?? [];
  }

  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    const status = (r.status ?? r.state ?? '').toLowerCase();
    if (status === 'success' || status === 'complete') succeeded++;
    else failed++;
  }

  if (results.length) {
    printTable(
      ['Package', 'Status'],
      results.map((r) => {
        const s = (r.status ?? r.state ?? 'unknown').toLowerCase();
        const icon = s === 'success' || s === 'complete' ? '\u2705' : '\u274C';
        return [r.name ?? r.id ?? 'unknown', `${icon} ${s}`];
      })
    );
  }

  // P1-5: Hash rollback token for history, show only last 4 chars
  const tokenHash = rollbackToken ? hashRollbackToken(rollbackToken) : null;
  const tokenHint = rollbackToken ? `...${rollbackToken.slice(-4)}` : null;

  await appendHistory({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    instance: creds.baseUrl,
    instanceHost: creds.instanceHost,
    profile: opts.profile ?? null,
    action: 'install',
    mode: 'batch',
    packages: packages.map((p) => ({ scope: p.scope, from: p.currentVersion, to: p.targetVersion })),
    result: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
    progressId,
    rollbackTokenHash: tokenHash,
    rollbackTokenHint: tokenHint,
  });
  logger.info('Batch install complete', { succeeded, failed, rollbackTokenHint: tokenHint });

  if (failed > 0 && succeeded > 0) {
    printWarn(`Partial success: ${succeeded} succeeded, ${failed} failed. Rollback token: ${tokenHint}`);
    process.exit(1);
  } else if (failed > 0) {
    printError(`All ${failed} package(s) failed. Rollback token: ${tokenHint}`);
    process.exit(2);
  } else {
    printSuccess(`All ${succeeded} package(s) installed successfully.`);
    if (tokenHint) printInfo(`Rollback token: ${tokenHint}`);
  }
}

// ── Command definition ───────────────────────────────────────────────

export function installCommand() {
  return new Command('install')
    .description('Execute app updates (sequential by default)')
    .option('--manifest <file>', 'Install from a manifest file')
    .option('--scope <scope>', 'Install a single app by scope')
    .option('--patches', 'Install all patch updates')
    .option('--minor', 'Install all patch + minor updates')
    .option('--all', 'Install all updates including major')
    .option('--exclude <scopes>', 'Comma-separated scopes to skip')
    .option('-y, --yes', 'Skip y/N confirmation (not valid for major updates)')
    .option('--continue-on-error', 'Continue installing remaining packages after a failure')
    .option('--concurrency <n>', 'Number of concurrent installs (only 1 supported)', '1')
    .option('--start-at <time>', 'Schedule start time (HH:MM or ISO datetime)')
    .option('--batch', 'Use legacy batch install API (advanced)')
    .option('--stop-on-error', 'Halt on first package failure (no prompt)')
    .option('--profile <name>', 'Target profile')
    .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
    .option('--allow-insecure-http', 'Allow HTTP connections (credentials sent in plaintext)')
    .option('--debug', 'Log raw API responses for diagnostics')
    .action(async (opts) => {
      const config = await loadConfig({
        stopOnError: opts.stopOnError,
        pollInterval: Number(opts.pollInterval) * 1000,
        excludeAlways: opts.exclude ? opts.exclude.split(',') : [],
      });

      try {
        // --start-at: wait until the scheduled time
        if (opts.startAt) {
          const targetTime = parseStartAt(opts.startAt);
          printInfo(`Scheduled start at ${targetTime.toLocaleString()}`);
          await waitUntil(targetTime);
        }

        // Validate concurrency
        const concurrency = parseInt(opts.concurrency, 10);
        if (concurrency !== 1) {
          printWarn('Concurrency > 1 is not yet supported. Using concurrency=1.');
        }

        const creds = await resolveCredentials(opts.profile, { allowInsecureHttp: opts.allowInsecureHttp });
        const client = createClient(creds);
        const logger = await createLogger(creds.instanceHost);
        const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };

        // Pre-flight: verify CI/CD credential alias is configured
        if (!opts.batch) {
          const aliasOk = await checkCICDCredentialAlias(client);
          if (!aliasOk) {
            printError('CI/CD credential alias (sn_cicd_spoke.CICD) is not configured. Installs will hang at "Pending" forever.');
            printInfo('Run "snbatch doctor" for step-by-step setup instructions.');
            process.exit(2);
          }
        }

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

        if (opts.batch) {
          await runBatchInstall(client, packages, config, opts, creds, logger);
        } else {
          const { succeeded, failed, failedPackages, rollbackVersions } =
            await runSequentialInstall(client, packages, config, opts, creds, logger);

          // Write history with per-app rollback versions
          await appendHistory({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            instance: creds.baseUrl,
            instanceHost: creds.instanceHost,
            profile: opts.profile ?? null,
            action: 'install',
            mode: 'sequential',
            packages: packages.map((p) => ({ scope: p.scope, from: p.currentVersion, to: p.targetVersion })),
            result: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
            rollbackVersions,
          });
          logger.info('Sequential install complete', { succeeded, failed, rollbackVersions });

          if (failed > 0 && succeeded > 0) process.exit(1);
          if (failed > 0 && succeeded === 0) process.exit(2);
        }
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
