/**
 * snbatch doctor — check instance prerequisites and optionally fix them
 */
import { Command } from 'commander';
import inquirer from 'inquirer';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { printInfo, printError, printSuccess, printWarn, chalk } from '../utils/display.js';
import { validateTypedConfirmation } from '../utils/confirmations.js';

const CICD_PLUGINS = [
  { id: 'com.sn_cicd_spoke', label: 'CI/CD Spoke' },
  { id: 'com.glide.continuousdelivery', label: 'CI/CD REST API' },
];

const WS_TABLES = [
  'sys_store_app',
  'sys_app_version',
];

const REQUIRED_ROLE = 'sn_cicd.sys_ci_automation';

/**
 * Run a single check and return a result object.
 * @param {string} name
 * @param {() => Promise<{pass: boolean, detail: string, fixable?: boolean, fixFn?: Function}>} fn
 */
async function runCheck(name, fn) {
  try {
    const result = await fn();
    return { name, ...result };
  } catch (e) {
    return { name, pass: false, detail: e.message, fixable: false };
  }
}

/**
 * Core doctor logic — runs all prerequisite checks.
 * Returns structured results for both CLI and MCP consumption.
 * @param {import('axios').AxiosInstance} client
 * @param {{ username: string, instanceHost: string }} creds
 * @returns {Promise<Array<{name: string, pass: boolean, detail: string, fixable?: boolean, fixFn?: Function}>>}
 */
export async function runDoctorChecks(client, creds) {
  const results = [];

  // 1. Connectivity
  results.push(await runCheck('Connectivity', async () => {
    await client.get('/api/now/table/sys_properties', {
      params: { sysparm_limit: 1 },
    });
    return { pass: true, detail: 'Instance reachable' };
  }));

  // If connectivity failed, skip the rest
  if (!results[0].pass) {
    return results;
  }

  // 2. Authentication (a 401 would have thrown in connectivity, but be explicit)
  results.push({ name: 'Authentication', pass: true, detail: `Logged in as: ${creds.username}` });

  // 3. Instance version
  results.push(await runCheck('Instance version', async () => {
    const resp = await client.get('/api/now/table/sys_properties', {
      params: {
        sysparm_fields: 'value',
        sysparm_query: 'name=glide.buildname',
        sysparm_limit: 1,
      },
    });
    const version = resp.data.result?.[0]?.value ?? 'Unknown';
    return { pass: true, detail: version };
  }));

  // 4. CI/CD plugins
  for (const plugin of CICD_PLUGINS) {
    results.push(await runCheck(plugin.label, async () => {
      const resp = await client.get('/api/now/table/sys_plugins', {
        params: {
          sysparm_fields: 'id,active',
          sysparm_query: `id=${plugin.id}`,
          sysparm_limit: 1,
        },
      });
      const row = resp.data.result?.[0];
      if (!row) return { pass: false, detail: `${plugin.id} not found`, fixable: false };
      const active = row.active === 'true' || row.active === true;
      return active
        ? { pass: true, detail: `${plugin.id} active` }
        : { pass: false, detail: `${plugin.id} inactive — activate via Plugins`, fixable: false };
    }));
  }

  // 5. User has sn_cicd.sys_ci_automation role
  results.push(await runCheck('CI/CD Role', async () => {
    const resp = await client.get('/api/now/table/sys_user_has_role', {
      params: {
        sysparm_fields: 'role',
        sysparm_query: `user.user_name=${creds.username}^role.name=${REQUIRED_ROLE}`,
        sysparm_limit: 1,
      },
    });
    if (resp.data.result?.length > 0) {
      return { pass: true, detail: `User has ${REQUIRED_ROLE}` };
    }
    return {
      pass: false,
      detail: `User missing ${REQUIRED_ROLE}`,
      fixable: true,
      fixFn: () => fixMissingRole(client, creds.username),
    };
  }));

  // 6. Web service access on tables
  for (const tableName of WS_TABLES) {
    results.push(await runCheck(`Web Service Access`, async () => {
      const resp = await client.get('/api/now/table/sys_db_object', {
        params: {
          sysparm_fields: 'sys_id,name,ws_access',
          sysparm_query: `name=${tableName}`,
          sysparm_limit: 1,
        },
      });
      const row = resp.data.result?.[0];
      if (!row) return { pass: false, detail: `${tableName}: table not found`, fixable: false };
      const wsAccess = row.ws_access === 'true' || row.ws_access === true;
      if (wsAccess) return { pass: true, detail: `${tableName}: ws_access enabled` };
      return {
        pass: false,
        detail: `${tableName}: ws_access disabled`,
        fixable: true,
        fixFn: () => fixWsAccess(client, row.sys_id, tableName),
      };
    }));
  }

  // 7. Store apps with updates available
  results.push(await runCheck('Updates available', async () => {
    const resp = await client.get('/api/now/table/sys_store_app', {
      params: {
        sysparm_fields: 'sys_id',
        sysparm_query: 'active=true^update_available=true',
        sysparm_limit: 1000,
      },
    });
    const count = resp.data.result?.length ?? 0;
    return count > 0
      ? { pass: true, detail: `${count} store app(s) have updates` }
      : { pass: true, detail: 'No updates currently available' };
  }));

  return results;
}

/**
 * Check if user has admin role (needed for --fix operations).
 */
async function hasAdminRole(client, username) {
  const resp = await client.get('/api/now/table/sys_user_has_role', {
    params: {
      sysparm_fields: 'role',
      sysparm_query: `user.user_name=${username}^role.name=admin`,
      sysparm_limit: 1,
    },
  });
  return resp.data.result?.length > 0;
}

/**
 * Fix: grant sn_cicd.sys_ci_automation role to current user.
 */
async function fixMissingRole(client, username) {
  // Look up role sys_id
  const roleResp = await client.get('/api/now/table/sys_user_role', {
    params: {
      sysparm_fields: 'sys_id',
      sysparm_query: `name=${REQUIRED_ROLE}`,
      sysparm_limit: 1,
    },
  });
  const roleSysId = roleResp.data.result?.[0]?.sys_id;
  if (!roleSysId) throw new Error(`Role ${REQUIRED_ROLE} not found on instance`);

  // Look up user sys_id
  const userResp = await client.get('/api/now/table/sys_user', {
    params: {
      sysparm_fields: 'sys_id',
      sysparm_query: `user_name=${username}`,
      sysparm_limit: 1,
    },
  });
  const userSysId = userResp.data.result?.[0]?.sys_id;
  if (!userSysId) throw new Error(`User ${username} not found`);

  // Insert role assignment
  await client.post('/api/now/table/sys_user_has_role', {
    user: userSysId,
    role: roleSysId,
  });

  return `Granted ${REQUIRED_ROLE} to ${username}`;
}

/**
 * Fix: enable ws_access on a table.
 */
async function fixWsAccess(client, sysId, tableName) {
  await client.patch(`/api/now/table/sys_db_object/${sysId}`, {
    ws_access: 'true',
  });
  return `Enabled ws_access on ${tableName}`;
}

export function doctorCommand() {
  return new Command('doctor')
    .description('Check instance prerequisites and optionally fix them')
    .option('--profile <name>', 'Target profile')
    .option('--fix', 'Attempt to auto-fix failing checks (requires admin)')
    .option('--json', 'Output results as JSON')
    .action(async (opts) => {
      try {
        const creds = await resolveCredentials(opts.profile);
        const client = createClient(creds);

        const isJson = opts.json || !process.stdout.isTTY;

        if (!isJson) printInfo(`\nChecking ${chalk.bold(creds.instanceHost)}...\n`);

        const results = await runDoctorChecks(client, creds);
        const issues = results.filter((r) => !r.pass);

        if (isJson) {
          const output = results.map(({ fixFn, ...r }) => r);
          process.stdout.write(JSON.stringify({ instance: creds.instanceHost, checks: output, issues: issues.length }, null, 2) + '\n');
        } else {
          for (const r of results) {
            const icon = r.pass ? '✅' : '❌';
            const label = r.name.padEnd(22);
            console.log(`  ${icon} ${label} ${r.detail}`);
          }
          console.log();
        }

        if (!issues.length) {
          if (!isJson) printSuccess('All checks passed.');
          return;
        }

        if (!isJson) {
          printWarn(`${issues.length} issue(s) found.`);
        }

        // --fix mode
        if (opts.fix) {
          const fixable = issues.filter((r) => r.fixable && r.fixFn);
          if (!fixable.length) {
            printWarn('No auto-fixable issues. The above issues require manual resolution.');
            process.exit(1);
          }

          // Check admin role
          const isAdmin = await hasAdminRole(client, creds.username);
          if (!isAdmin) {
            printError('Auto-fix requires admin role. Please fix issues manually or use an admin account.');
            process.exit(1);
          }

          // Typed confirmation (same pattern as major installs)
          const { typed } = await inquirer.prompt([{
            type: 'input',
            name: 'typed',
            message: `Auto-fix will modify instance configuration. Type the hostname to confirm (${chalk.bold(creds.instanceHost)}):`,
          }]);
          if (!validateTypedConfirmation(typed, creds.instanceHost)) {
            printError('Confirmation failed. Aborting.');
            process.exit(1);
          }

          for (const issue of fixable) {
            try {
              const msg = await issue.fixFn();
              console.log(`  ✅ Fixed: ${msg}`);
            } catch (e) {
              console.log(`  ❌ Fix failed: ${issue.name} — ${e.message}`);
            }
          }

          printInfo('\nRe-run `snbatch doctor` to verify fixes.');
        } else if (!isJson) {
          printInfo("Run 'snbatch doctor --fix' to attempt auto-repair.");
        }

        if (!opts.fix) process.exit(1);
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });
}
