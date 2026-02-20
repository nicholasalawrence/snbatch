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
  { id: 'com.glide.continuousdelivery', label: 'CI/CD REST API' },
];

const WS_TABLES = [
  'sys_store_app',
  'sys_app_version',
  'sys_plugins',
  'sys_properties',
];

// Tables where auto-fixing ws_access is too risky (broad read surface)
const WS_NO_AUTOFIX = new Set(['sys_properties']);

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

  // 5. App repo install API enabled
  results.push(await runCheck('App Repo Install API', async () => {
    const resp = await client.get('/api/now/table/sys_properties', {
      params: {
        sysparm_fields: 'sys_id,value',
        sysparm_query: 'name=sn_cicd.apprepo.install.enabled',
        sysparm_limit: 1,
      },
    });
    const row = resp.data.result?.[0];
    if (!row) {
      return {
        pass: false,
        detail: 'sn_cicd.apprepo.install.enabled property not found',
        fixable: true,
        fixFn: () => setProperty(client, 'sn_cicd.apprepo.install.enabled', 'true'),
      };
    }
    const enabled = row.value === 'true';
    return enabled
      ? { pass: true, detail: 'App repo install API enabled' }
      : {
          pass: false,
          detail: 'sn_cicd.apprepo.install.enabled is false',
          fixable: true,
          fixFn: () => setProperty(client, 'sn_cicd.apprepo.install.enabled', 'true'),
        };
  }));

  // 6. CI/CD Credential Alias
  results.push(await runCheck('CI/CD Credential Alias', async () => {
    const resp = await client.get('/api/now/table/sys_alias', {
      params: {
        sysparm_fields: 'sys_id,id,name,type,configuration',
        sysparm_query: 'id=sn_cicd_spoke.CICD',
        sysparm_limit: 1,
      },
    });
    const row = resp.data.result?.[0];
    if (!row) {
      return {
        pass: false,
        detail: 'sn_cicd_spoke.CICD alias not found. Is the CI/CD Spoke activated?',
        fixable: false,
        manualSetup: true,
      };
    }
    const hasConfig = row.configuration && row.configuration !== '' && row.configuration !== 'null';
    if (!hasConfig) {
      return {
        pass: false,
        detail: 'sn_cicd_spoke.CICD has no credential bound',
        fixable: false,
        manualSetup: true,
      };
    }
    return { pass: true, detail: 'CI/CD credential alias configured' };
  }));

  // 7. User has sn_cicd.sys_ci_automation role
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

  // 7. Web service access on tables
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
      const canAutoFix = !WS_NO_AUTOFIX.has(tableName);
      return {
        pass: false,
        detail: `${tableName}: ws_access disabled${canAutoFix ? '' : ' (enable manually — sensitive table)'}`,
        fixable: canAutoFix,
        fixFn: canAutoFix ? () => fixWsAccess(client, row.sys_id, tableName) : undefined,
      };
    }));
  }

  // 8. Store apps with updates available — use stats API for accurate count
  results.push(await runCheck('Updates available', async () => {
    let count;
    try {
      const statsResp = await client.get('/api/now/stats/sys_store_app', {
        params: {
          sysparm_query: 'active=true^update_available=true',
          sysparm_count: 'true',
        },
      });
      count = Number(statsResp.data.result?.stats?.count ?? 0);
    } catch {
      // Fallback: fetch first page and report that
      const resp = await client.get('/api/now/table/sys_store_app', {
        params: {
          sysparm_fields: 'sys_id',
          sysparm_query: 'active=true^update_available=true',
          sysparm_limit: 1,
        },
      });
      count = resp.data.result?.length ?? 0;
    }
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

/**
 * Fix: set or create a system property.
 */
async function setProperty(client, name, value) {
  const resp = await client.get('/api/now/table/sys_properties', {
    params: { sysparm_fields: 'sys_id', sysparm_query: `name=${name}`, sysparm_limit: 1 },
  });
  const row = resp.data.result?.[0];
  if (row) {
    await client.patch(`/api/now/table/sys_properties/${row.sys_id}`, { value });
  } else {
    await client.post('/api/now/table/sys_properties', { name, value, type: 'true_false' });
  }
  return `Set ${name} = ${value}`;
}

/**
 * Quick check whether the CI/CD credential alias is configured.
 * Returns true if the alias exists and has a credential bound; false otherwise.
 */
export async function checkCICDCredentialAlias(client) {
  try {
    const resp = await client.get('/api/now/table/sys_alias', {
      params: {
        sysparm_fields: 'sys_id,configuration',
        sysparm_query: 'id=sn_cicd_spoke.CICD',
        sysparm_limit: 1,
      },
    });
    const row = resp.data.result?.[0];
    if (!row) return false;
    return !!(row.configuration && row.configuration !== '' && row.configuration !== 'null');
  } catch {
    // If the table isn't accessible, skip this pre-flight check gracefully
    return true;
  }
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

          // Show manual setup instructions for credential alias
          const hasManualIssues = issues.some((r) => r.manualSetup);
          if (hasManualIssues) {
            printWarn('MANUAL SETUP REQUIRED — this cannot be automated.\n');
            printWarn('The CI/CD install API needs a credential to authenticate with the');
            printWarn('app repository. Without this, installs will hang at "Pending" forever.\n');
            printWarn('To fix:');
            printWarn('  1. Navigate to Connections & Credentials \u2192 Credentials');
            printWarn('  2. Click New \u2192 Basic Auth Credentials');
            printWarn('  3. Set Name: "CICD Service Account"');
            printWarn('  4. Set User name: (an admin user on this instance)');
            printWarn('  5. Set Password: (that user\'s password)');
            printWarn('  6. Unlock the Credential alias field (click the lock icon)');
            printWarn('  7. Set Credential alias: sn_cicd_spoke.CICD');
            printWarn('  8. Click Submit\n');
            printWarn('Then re-run: snbatch doctor');
            console.log();
          }
        }

        if (!issues.length) {
          if (!isJson) printSuccess('All checks passed.');
          return;
        }

        if (!isJson) {
          const manualCount = issues.filter((r) => r.manualSetup).length;
          const parts = [`${issues.length} issue(s) found.`];
          if (manualCount > 0) parts.push(`${manualCount} requires manual setup (see above).`);
          printWarn(parts.join(' '));
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
