/**
 * snbatch rollback — roll back installed apps (per-app or legacy batch)
 */
import { Command } from 'commander';
import { readFile, appendFile, mkdir } from 'fs/promises';
import inquirer from 'inquirer';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { rollbackApp, startBatchRollback, pollProgress, isProgressSuccess } from '../api/cicd.js';
import { validateTypedConfirmation } from '../utils/confirmations.js';
import { printTable, printInfo, printWarn, printError, printSuccess, createSpinner, chalk } from '../utils/display.js';
import { HISTORY_PATH, SNBATCH_DIR } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { hashRollbackToken } from '../utils/crypto.js';
import { formatElapsed } from '../utils/schedule.js';

// P2-4: Per-line JSON parse with try/catch — skip corrupted entries
async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const entries = [];
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        process.stderr.write(`[snbatch] Warning: skipping corrupted history entry\n`);
      }
    }
    return entries;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// P2-10: Restricted file permissions for history
async function appendHistory(entry) {
  await mkdir(SNBATCH_DIR, { recursive: true, mode: 0o700 });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/**
 * Run per-app rollback using the app_repo API.
 */
async function runPerAppRollback(client, rollbackVersions, config, logger) {
  const total = rollbackVersions.length;
  let succeeded = 0;
  let failed = 0;
  const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };
  const isTTY = process.stderr.isTTY;
  const totalStart = Date.now();

  for (let i = 0; i < total; i++) {
    const { scope, version } = rollbackVersions[i];
    const idx = i + 1;
    const label = `${scope} \u2192 ${version}`;

    const inProgressLine = `[${idx}/${total}] \uD83D\uDD04 Rolling back ${label}...`;
    if (isTTY) {
      process.stderr.write(`\r\x1b[K${inProgressLine}`);
    } else {
      process.stderr.write(`${inProgressLine}\n`);
    }

    const appStart = Date.now();

    try {
      const { progressId } = await rollbackApp(client, scope, version, retryOpts);

      let lastData = null;
      for await (const data of pollProgress(client, progressId, {
        pollInterval: config.sequentialPollInterval,
        maxPollDuration: config.maxPollDuration,
        retries: config.retries,
        backoffBase: config.backoffBase,
      })) {
        lastData = data;
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
        const failLine = `[${idx}/${total}] \u274C ${label} (${appElapsed}) \u2014 ${errorMsg}`;
        if (isTTY) {
          process.stderr.write(`\r\x1b[K${failLine}\n`);
        } else {
          process.stderr.write(`${failLine}\n`);
        }
      }

      logger.info('App rollback complete', { scope, version, success, elapsed: appElapsed });
    } catch (err) {
      const appElapsed = formatElapsed(Date.now() - appStart);
      failed++;
      const failLine = `[${idx}/${total}] \u274C ${label} (${appElapsed}) \u2014 ${err.message}`;
      if (isTTY) {
        process.stderr.write(`\r\x1b[K${failLine}\n`);
      } else {
        process.stderr.write(`${failLine}\n`);
      }
      logger.info('App rollback error', { scope, version, error: err.message });
    }
  }

  const totalElapsed = formatElapsed(Date.now() - totalStart);
  process.stderr.write('\n');
  printInfo(`Rollback: ${succeeded} succeeded, ${failed} failed, ${totalElapsed} total`);

  return { succeeded, failed };
}

export function rollbackCommand() {
  return new Command('rollback')
    .description('Roll back installed apps')
    .option('--last', 'Roll back the most recent install')
    .option('--batch-id <id>', 'Roll back a specific history entry by ID')
    .option('--token <token>', 'Provide batch rollback token directly (legacy)')
    .option('--list', 'Show rollback-eligible entries')
    .option('--profile <name>', 'Target profile')
    .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
    .option('--allow-insecure-http', 'Allow HTTP connections (credentials sent in plaintext)')
    .action(async (opts) => {
      try {
        const history = await loadHistory();
        // Support both old batch format (rollbackToken/rollbackTokenHash) and new per-app format (rollbackVersions)
        const eligible = history.filter((e) =>
          e.action === 'install' &&
          (e.rollbackToken || e.rollbackTokenHash || e.rollbackVersions?.length > 0)
        );

        if (opts.list) {
          if (!eligible.length) { printInfo('No rollback-eligible entries found.'); return; }
          printTable(
            ['ID', 'Timestamp', 'Instance', 'Packages', 'Result', 'Mode'],
            eligible.map((e) => [
              e.id.slice(0, 8),
              e.timestamp,
              e.instanceHost ?? e.instance,
              String(e.packages?.length ?? '?'),
              e.result,
              e.rollbackVersions ? 'per-app' : 'batch',
            ])
          );
          return;
        }

        let rollbackToken = opts.token;

        // Also check SNBATCH_ROLLBACK_TOKEN env var (legacy batch)
        if (!rollbackToken && process.env.SNBATCH_ROLLBACK_TOKEN) {
          rollbackToken = process.env.SNBATCH_ROLLBACK_TOKEN;
        }

        let targetEntry = null;

        if (!rollbackToken && opts.batchId) {
          targetEntry = eligible.find((e) => e.id === opts.batchId || e.id.startsWith(opts.batchId));
          if (!targetEntry) { printError(`No entry found with ID: ${opts.batchId}`); process.exit(2); }
          // If it's a per-app entry, rollbackToken stays null — we use rollbackVersions instead
          rollbackToken = targetEntry.rollbackToken ?? null;
        }

        if (!rollbackToken && !targetEntry && opts.last) {
          if (!eligible.length) { printError('No rollback-eligible entries found.'); process.exit(2); }
          targetEntry = eligible[eligible.length - 1];
          rollbackToken = targetEntry.rollbackToken ?? null;
        }

        if (!rollbackToken && !targetEntry) {
          // Interactive selection
          if (!eligible.length) { printError('No rollback-eligible entries found.'); process.exit(2); }
          const choices = eligible.slice(-10).reverse().map((e) => {
            const mode = e.rollbackVersions ? 'per-app' : 'batch';
            return {
              name: `${e.timestamp}  ${e.instanceHost ?? e.instance}  (${e.packages?.length ?? '?'} packages, ${mode})`,
              value: e,
            };
          });
          const { selected } = await inquirer.prompt([{
            type: 'list',
            name: 'selected',
            message: 'Select an entry to roll back:',
            choices,
          }]);
          targetEntry = selected;
          rollbackToken = selected.rollbackToken ?? null;
        }

        // Per-app entries don't need a batch rollback token
        const isPerApp = targetEntry?.rollbackVersions?.length > 0;

        if (!isPerApp && !rollbackToken) {
          printError('This history entry does not have a stored rollback token. Provide one with --token.');
          process.exit(2);
        }

        const creds = await resolveCredentials(targetEntry?.profile ?? opts.profile ?? null, { allowInsecureHttp: opts.allowInsecureHttp });
        const instanceHost = targetEntry?.instanceHost ?? creds.instanceHost;

        // Rollback always requires typed confirmation
        printWarn(`You are about to roll back on ${chalk.bold(instanceHost)}.`);
        if (isPerApp) {
          printWarn(`This will roll back ${targetEntry.rollbackVersions.length} app(s) to their previous versions.`);
        } else {
          printWarn('Rollback is all-or-nothing \u2014 all packages in the batch will be reverted.');
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

        const client = createClient(creds);
        const logger = await createLogger(instanceHost);
        const config = await loadConfig({});

        if (isPerApp) {
          // Per-app rollback using app_repo API
          const { succeeded, failed } = await runPerAppRollback(client, targetEntry.rollbackVersions, config, logger);

          await appendHistory({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            instance: creds.baseUrl,
            instanceHost,
            profile: targetEntry?.profile ?? opts.profile ?? null,
            action: 'rollback',
            mode: 'sequential',
            rollbackVersions: targetEntry.rollbackVersions,
            result: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
          });

          if (failed === 0) {
            printSuccess('Rollback completed successfully.');
          } else {
            printWarn(`Rollback partial: ${succeeded} succeeded, ${failed} failed.`);
            process.exit(1);
          }
        } else {
          // Legacy batch rollback
          const retryOpts = { retries: config.retries, backoffBase: config.backoffBase };
          const spinner = createSpinner('Starting rollback...');
          spinner.start();

          const { progressId } = await startBatchRollback(client, rollbackToken, retryOpts);
          logger.info('Rollback started', { progressId, rollbackToken });

          let lastData = null;
          for await (const data of pollProgress(client, progressId, {
            pollInterval: Number(opts.pollInterval) * 1000,
            retries: config.retries,
            backoffBase: config.backoffBase,
          })) {
            lastData = data;
            const pct = data.percentComplete ?? data.percent_complete ?? 0;
            spinner.text = `[${Math.round(pct)}%] Rolling back...`;
          }

          spinner.stop();

          // P1-5: Hash rollback token in history
          await appendHistory({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            instance: creds.baseUrl,
            instanceHost,
            profile: targetEntry?.profile ?? opts.profile ?? null,
            action: 'rollback',
            mode: 'batch',
            rollbackTokenHash: hashRollbackToken(rollbackToken),
            rollbackTokenHint: `...${rollbackToken.slice(-4)}`,
            result: 'success',
            progressId,
          });

          logger.info('Rollback complete', { progressId });
          printSuccess('Rollback completed successfully.');
        }
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
