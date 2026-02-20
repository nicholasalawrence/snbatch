#!/usr/bin/env node
/**
 * snbatch — CLI entry point
 * Not affiliated with or endorsed by ServiceNow, Inc.
 */
import { program } from 'commander';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';

import { scanCommand } from '../src/commands/scan.js';
import { previewCommand } from '../src/commands/preview.js';
import { installCommand } from '../src/commands/install.js';
import { rollbackCommand } from '../src/commands/rollback.js';
import { reconcileCommand } from '../src/commands/reconcile.js';
import { profileCommand } from '../src/commands/profile.js';
import { doctorCommand } from '../src/commands/doctor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf8'));

program
  .name('snbatch')
  .description(
    'Batch-update ServiceNow store applications across multiple instances.\n' +
    'Not affiliated with or endorsed by ServiceNow, Inc.'
  )
  .version(pkg.version);

program.addCommand(scanCommand());
program.addCommand(previewCommand());
program.addCommand(installCommand());
program.addCommand(rollbackCommand());
program.addCommand(reconcileCommand());
program.addCommand(profileCommand());
program.addCommand(doctorCommand());

program
  .command('serve')
  .description('Start MCP server for LLM integration')
  .option('--mcp', 'Start MCP server (stdio transport)')
  .action(async (opts) => {
    if (opts.mcp) {
      const { startMcpServer } = await import('../src/mcp/server.js');
      await startMcpServer();
    } else {
      program.help();
    }
  });

await program.parseAsync(process.argv);
