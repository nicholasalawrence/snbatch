/**
 * MCP tool definitions and handlers.
 * Handlers call the data layer directly — display layer is skipped.
 *
 * P0-1: Uses McpServer.tool() API which auto-converts zod→JSON Schema.
 * P2-9: All file path parameters are validated against path traversal.
 * P3-6: Error messages returned to MCP client are generic; full details go to stderr.
 */
import { z } from 'zod';
import path from 'path';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { startBatchInstall, startBatchRollback, pollProgress, fetchBatchResults } from '../api/cicd.js';
import { fetchInstalledApps } from '../api/table.js';
import { toInstallPayload } from '../models/package.js';
import { buildManifest, readManifest, writeManifest, defaultManifestName } from '../models/manifest.js';
import { reconcilePackages } from '../commands/reconcile.js';
import { scanData } from '../commands/scan.js';
import { runDoctorChecks } from '../commands/doctor.js';
import { listProfiles } from '../utils/profiles.js';
import { loadConfig } from '../utils/config.js';
import { issueConfirmationChallenge, verifyConfirmation, installNeedsConfirmation } from './confirmations.js';
import { HISTORY_PATH, SNBATCH_DIR } from '../utils/paths.js';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { realpathSync, existsSync } from 'fs';
import { hashRollbackToken } from '../utils/crypto.js';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// P3-6: Wrap handler to return generic error messages and log full details to stderr
function safeErr(e) {
  process.stderr.write(`[snbatch-mcp] Error: ${e.message}\n${e.stack ?? ''}\n`);
  return err('An internal error occurred. Check server logs for details.');
}

async function appendHistory(entry) {
  await mkdir(SNBATCH_DIR, { recursive: true, mode: 0o700 });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// P2-9: Validate that a file path is within cwd — reject traversal and symlinks
function validatePath(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!resolved.startsWith(process.cwd() + path.sep) && resolved !== process.cwd()) {
    throw new Error('Path must be within the current working directory');
  }
  // If the path already exists, resolve symlinks and re-check
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!real.startsWith(process.cwd() + path.sep) && real !== process.cwd()) {
      throw new Error('Path resolves via symlink to outside the current working directory');
    }
  }
  return resolved;
}

/**
 * Register all MCP tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerTools(server) {
  server.tool(
    'snbatch_scan',
    'Scan a ServiceNow instance for available store app updates.',
    {
      profile: z.string().optional().describe('Profile name to use'),
    },
    async ({ profile }) => {
      try {
        const config = await loadConfig({});
        const { upgrades, creds, instanceVersion } = await scanData(profile, config);
        return ok({ instance: creds.instanceHost, instanceVersion, count: upgrades.length, packages: upgrades });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_preview',
    'Generate a reviewable upgrade manifest for a ServiceNow instance.',
    {
      profile: z.string().optional(),
      scope: z.enum(['patches', 'minor', 'all']).optional().default('all'),
      output: z.string().optional().describe('Output file path for manifest (relative to cwd)'),
    },
    async ({ profile, scope, output }) => {
      try {
        const config = await loadConfig({});
        const { upgrades, creds, instanceVersion } = await scanData(profile, config);
        let packages = upgrades;
        if (scope === 'patches') packages = packages.filter((p) => p.upgradeType === 'patch');
        else if (scope === 'minor') packages = packages.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
        const manifest = buildManifest(packages, creds.baseUrl, profile ?? null, instanceVersion);
        const outPath = output ? validatePath(output) : path.join(process.cwd(), defaultManifestName(creds.instanceHost));
        await writeManifest(manifest, outPath);
        return ok({ manifestPath: outPath, packages: packages.length, stats: manifest.stats });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_install',
    'Execute a batch install. For major updates or rollbacks, a confirmation challenge is issued first — relay it to the user and call again with confirmationToken + confirmationValue.',
    {
      profile: z.string().optional(),
      manifest: z.string().optional().describe('Path to a manifest file (relative to cwd)'),
      scope: z.enum(['patches', 'minor', 'all']).optional().default('all'),
      confirmationToken: z.string().optional(),
      confirmationValue: z.string().optional(),
    },
    async ({ profile, manifest: manifestPath, scope, confirmationToken, confirmationValue }) => {
      try {
        const config = await loadConfig({});
        let packages;

        if (manifestPath) {
          const safePath = validatePath(manifestPath);
          const m = await readManifest(safePath);
          packages = m.packages;
        } else {
          const { upgrades } = await scanData(profile, config);
          if (scope === 'patches') packages = upgrades.filter((p) => p.upgradeType === 'patch');
          else if (scope === 'minor') packages = upgrades.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
          else packages = upgrades;
        }

        const creds = await resolveCredentials(profile);

        // Check if confirmation is needed
        if (installNeedsConfirmation(packages)) {
          if (!confirmationToken) {
            const challenge = issueConfirmationChallenge(creds.instanceHost, 'install');
            return ok({ status: 'requires_confirmation', ...challenge });
          }
          // P2-8: pass operation type for verification
          const result = verifyConfirmation(confirmationToken, confirmationValue ?? '', 'install');
          if (!result.valid) return err(result.error);
        }

        const client = createClient(creds);
        const payloads = packages.map(toInstallPayload);
        const { progressId, rollbackToken, resultsId } = await startBatchInstall(client, payloads);

        let lastData = null;
        for await (const data of pollProgress(client, progressId, {
          pollInterval: config.pollInterval,
          maxPollDuration: config.maxPollDuration,
        })) { lastData = data; }

        // Fetch per-package results from the dedicated results endpoint
        let batchResults = [];
        if (resultsId) {
          try {
            batchResults = await fetchBatchResults(client, resultsId);
          } catch { /* fall through to progress data */ }
        }
        if (!batchResults.length) {
          batchResults = lastData?.packages ?? lastData?.result?.packages ?? [];
        }

        let succeeded = 0;
        let failed = 0;
        for (const r of batchResults) {
          const s = (r.status ?? r.state ?? '').toLowerCase();
          if (s === 'success' || s === 'complete') succeeded++;
          else failed++;
        }

        // P1-5: hash rollback token for history storage
        const tokenHash = rollbackToken ? hashRollbackToken(rollbackToken) : null;
        const tokenHint = rollbackToken ? rollbackToken.slice(-4) : null;
        const resultStatus = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial';

        await appendHistory({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          instance: creds.baseUrl,
          instanceHost: creds.instanceHost,
          profile: profile ?? null,
          action: 'install',
          packages: packages.map((p) => ({ scope: p.scope, from: p.currentVersion, to: p.targetVersion })),
          result: resultStatus,
          progressId,
          rollbackTokenHash: tokenHash,
          rollbackTokenHint: tokenHint,
        });

        // P1: Return only the hint, not the full token — MCP transcripts may be logged
        return ok({ status: 'complete', result: resultStatus, progressId, rollbackTokenHint: tokenHint ? `...${tokenHint}` : null, succeeded, failed, packages: packages.length, batchResults });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_rollback',
    'Roll back a batch installation. Always requires typed confirmation — issue a challenge first.',
    {
      rollbackToken: z.string().describe('Rollback token from install history'),
      profile: z.string().optional(),
      confirmationToken: z.string().optional(),
      confirmationValue: z.string().optional(),
    },
    async ({ rollbackToken, profile, confirmationToken, confirmationValue }) => {
      try {
        const creds = await resolveCredentials(profile);

        if (!confirmationToken) {
          const challenge = issueConfirmationChallenge(creds.instanceHost, 'rollback');
          return ok({ status: 'requires_confirmation', ...challenge });
        }
        // P2-8: pass operation type for verification
        const result = verifyConfirmation(confirmationToken, confirmationValue ?? '', 'rollback');
        if (!result.valid) return err(result.error);

        const client = createClient(creds);
        const { progressId } = await startBatchRollback(client, rollbackToken);

        let lastData = null;
        const config = await loadConfig({});
        for await (const data of pollProgress(client, progressId, {
          pollInterval: config.pollInterval,
          maxPollDuration: config.maxPollDuration,
        })) { lastData = data; }

        await appendHistory({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          instance: creds.baseUrl,
          instanceHost: creds.instanceHost,
          profile: profile ?? null,
          action: 'rollback',
          rollbackTokenHash: hashRollbackToken(rollbackToken),
          rollbackTokenHint: rollbackToken.slice(-4),
          result: 'success',
          progressId,
        });

        return ok({ status: 'complete', progressId, lastResult: lastData });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_reconcile',
    'Reconcile a manifest from one environment to another, producing an adjusted manifest.',
    {
      manifestPath: z.string().describe('Path to source manifest (relative to cwd)'),
      targetProfile: z.string().describe('Profile for target instance'),
      output: z.string().optional(),
    },
    async ({ manifestPath, targetProfile, output }) => {
      try {
        const safePath = validatePath(manifestPath);
        const sourceManifest = await readManifest(safePath);
        const creds = await resolveCredentials(targetProfile);
        const client = createClient(creds);
        const targetApps = await fetchInstalledApps(client);
        const reconciled = reconcilePackages(sourceManifest.packages, targetApps);
        const toInstall = reconciled.filter((r) => r.action === 'include');
        const adjusted = buildManifest(toInstall, creds.baseUrl, targetProfile);
        const outPath = output ? validatePath(output) : path.join(process.cwd(), defaultManifestName(creds.instanceHost));
        await writeManifest(adjusted, outPath);
        return ok({ adjustedManifestPath: outPath, toInstall: toInstall.length, skipped: reconciled.length - toInstall.length });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_profiles',
    'List available instance profiles.',
    {},
    async () => {
      try {
        const profiles = await listProfiles();
        return ok({ profiles });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_history',
    'Show recent operation history.',
    {
      limit: z.number().optional().default(10),
    },
    async ({ limit }) => {
      try {
        const raw = await readFile(HISTORY_PATH, 'utf8').catch(() => '');
        const entries = raw.trim().split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        return ok({ entries: entries.slice(-limit).reverse() });
      } catch (e) { return safeErr(e); }
    }
  );

  server.tool(
    'snbatch_doctor',
    'Check instance prerequisites (connectivity, auth, CI/CD plugins, roles, web service access, available updates). Run this before scan or install to diagnose issues.',
    {
      profile: z.string().optional().describe('Profile name to use'),
    },
    async ({ profile }) => {
      try {
        const creds = await resolveCredentials(profile);
        const client = createClient(creds);
        const results = await runDoctorChecks(client, creds);
        const checks = results.map(({ fixFn, ...r }) => r);
        const issues = checks.filter((r) => !r.pass);
        return ok({ instance: creds.instanceHost, checks, issues: issues.length });
      } catch (e) { return safeErr(e); }
    }
  );
}
