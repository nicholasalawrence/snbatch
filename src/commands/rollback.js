/**
 * snbatch rollback — roll back a batch installation
 */
import { Command } from 'commander';
import { readFile, appendFile, mkdir } from 'fs/promises';
import inquirer from 'inquirer';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { startBatchRollback, pollProgress } from '../api/cicd.js';
import { validateTypedConfirmation } from '../utils/confirmations.js';
import { printTable, printInfo, printWarn, printError, printSuccess, createSpinner, chalk } from '../utils/display.js';
import { HISTORY_PATH, SNBATCH_DIR } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';

async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function appendHistory(entry) {
  await mkdir(SNBATCH_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

export function rollbackCommand() {
  return new Command('rollback')
    .description('Roll back a batch installation (all-or-nothing)')
    .option('--last', 'Roll back the most recent batch')
    .option('--batch-id <id>', 'Roll back a specific history entry by ID')
    .option('--token <token>', 'Provide rollback token directly')
    .option('--list', 'Show rollback-eligible batches')
    .option('--profile <name>', 'Target profile')
    .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
    .action(async (opts) => {
      try {
        const history = await loadHistory();
        const eligible = history.filter((e) => e.action === 'install' && e.rollbackToken);

        if (opts.list) {
          if (!eligible.length) { printInfo('No rollback-eligible batches found.'); return; }
          printTable(
            ['ID', 'Timestamp', 'Instance', 'Packages', 'Result', 'Token'],
            eligible.map((e) => [e.id.slice(0, 8), e.timestamp, e.instanceHost ?? e.instance, String(e.packages?.length ?? '?'), e.result, e.rollbackToken?.slice(0, 12) + '...'])
          );
          return;
        }

        let rollbackToken = opts.token;
        let targetEntry = null;

        if (!rollbackToken && opts.batchId) {
          targetEntry = eligible.find((e) => e.id === opts.batchId || e.id.startsWith(opts.batchId));
          if (!targetEntry) { printError(`No batch found with ID: ${opts.batchId}`); process.exit(2); }
          rollbackToken = targetEntry.rollbackToken;
        }

        if (!rollbackToken && opts.last) {
          if (!eligible.length) { printError('No rollback-eligible batches found.'); process.exit(2); }
          targetEntry = eligible[eligible.length - 1];
          rollbackToken = targetEntry.rollbackToken;
        }

        if (!rollbackToken) {
          // Interactive selection
          if (!eligible.length) { printError('No rollback-eligible batches found.'); process.exit(2); }
          const choices = eligible.slice(-10).reverse().map((e) => ({
            name: `${e.timestamp}  ${e.instanceHost ?? e.instance}  (${e.packages?.length ?? '?'} packages)`,
            value: e,
          }));
          const { selected } = await inquirer.prompt([{
            type: 'list',
            name: 'selected',
            message: 'Select a batch to roll back:',
            choices,
          }]);
          targetEntry = selected;
          rollbackToken = selected.rollbackToken;
        }

        const creds = await resolveCredentials(targetEntry?.profile ?? opts.profile ?? null);
        const instanceHost = targetEntry?.instanceHost ?? creds.instanceHost;

        // Rollback always requires typed confirmation — --yes does NOT bypass
        printWarn(`You are about to roll back a batch on ${chalk.bold(instanceHost)}.`);
        printWarn('Rollback is all-or-nothing — all packages in the batch will be reverted.');

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

        const spinner = createSpinner('Starting rollback...');
        spinner.start();

        const { progressId } = await startBatchRollback(client, rollbackToken);
        logger.info('Rollback started', { progressId, rollbackToken });

        let lastData = null;
        for await (const data of pollProgress(client, progressId, {
          pollInterval: Number(opts.pollInterval) * 1000,
        })) {
          lastData = data;
          const pct = data.percentComplete ?? data.percent_complete ?? 0;
          spinner.text = `[${Math.round(pct)}%] Rolling back...`;
        }

        spinner.stop();

        await appendHistory({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          instance: creds.baseUrl,
          instanceHost,
          profile: targetEntry?.profile ?? opts.profile ?? null,
          action: 'rollback',
          rollbackToken,
          result: 'success',
          progressId,
        });

        logger.info('Rollback complete', { progressId });
        printSuccess('Rollback completed successfully.');
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
