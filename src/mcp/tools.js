/**
 * MCP tool definitions and handlers.
 * Handlers call the data layer directly — display layer is skipped.
 */
import { z } from 'zod';
import { resolveCredentials } from '../api/auth.js';
import { createClient } from '../api/index.js';
import { startBatchInstall, startBatchRollback, pollProgress } from '../api/cicd.js';
import { fetchInstalledApps, fetchAvailableVersions, fetchInstanceVersion } from '../api/table.js';
import { buildPackageObject, toInstallPayload } from '../models/package.js';
import { buildManifest, readManifest, writeManifest, defaultManifestName } from '../models/manifest.js';
import { reconcilePackages } from '../commands/reconcile.js';
import { scanData } from '../commands/scan.js';
import { listProfiles } from '../utils/profiles.js';
import { loadConfig } from '../utils/config.js';
import { isUpgrade } from '../utils/version.js';
import { issueConfirmationChallenge, verifyConfirmation, installNeedsConfirmation } from './confirmations.js';
import { HISTORY_PATH, SNBATCH_DIR } from '../utils/paths.js';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

async function appendHistory(entry) {
  await mkdir(SNBATCH_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

export const tools = [
  {
    name: 'snbatch_scan',
    description: 'Scan a ServiceNow instance for available application and plugin updates.',
    inputSchema: z.object({
      profile: z.string().optional().describe('Profile name to use'),
      type: z.enum(['app', 'plugin', 'all']).optional().default('all'),
    }),
    async handler({ profile, type }) {
      try {
        const config = await loadConfig({ type });
        const { upgrades, creds, instanceVersion } = await scanData(profile, config);
        return ok({ instance: creds.instanceHost, instanceVersion, count: upgrades.length, packages: upgrades });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_preview',
    description: 'Generate a reviewable upgrade manifest for a ServiceNow instance.',
    inputSchema: z.object({
      profile: z.string().optional(),
      scope: z.enum(['patches', 'minor', 'all']).optional().default('all'),
      output: z.string().optional().describe('Output file path for manifest'),
    }),
    async handler({ profile, scope, output }) {
      try {
        const config = await loadConfig({});
        const { upgrades, creds, instanceVersion } = await scanData(profile, config);
        let packages = upgrades;
        if (scope === 'patches') packages = packages.filter((p) => p.upgradeType === 'patch');
        else if (scope === 'minor') packages = packages.filter((p) => ['patch', 'minor'].includes(p.upgradeType));
        const manifest = buildManifest(packages, creds.baseUrl, profile ?? null, instanceVersion);
        const path = output ?? join(process.cwd(), defaultManifestName(creds.instanceHost));
        await writeManifest(manifest, path);
        return ok({ manifestPath: path, packages: packages.length, stats: manifest.stats });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_install',
    description: 'Execute a batch install. For major updates or rollbacks, a confirmation challenge is issued first — relay it to the user and call again with confirmationToken + confirmationValue.',
    inputSchema: z.object({
      profile: z.string().optional(),
      manifest: z.string().optional().describe('Path to a manifest file'),
      scope: z.enum(['patches', 'minor', 'all']).optional().default('all'),
      confirmationToken: z.string().optional(),
      confirmationValue: z.string().optional(),
    }),
    async handler({ profile, manifest: manifestPath, scope, confirmationToken, confirmationValue }) {
      try {
        const config = await loadConfig({});
        let packages;

        if (manifestPath) {
          const m = await readManifest(manifestPath);
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
          const result = verifyConfirmation(confirmationToken, confirmationValue ?? '');
          if (!result.valid) return err(result.error);
        }

        const client = createClient(creds);
        const payloads = packages.map(toInstallPayload);
        const { progressId, rollbackToken } = await startBatchInstall(client, payloads);

        let lastData = null;
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
          action: 'install',
          packages: packages.map((p) => ({ scope: p.scope, from: p.currentVersion, to: p.targetVersion })),
          result: 'success',
          progressId,
          rollbackToken,
        });

        return ok({ status: 'complete', progressId, rollbackToken, packages: packages.length, lastResult: lastData });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_rollback',
    description: 'Roll back a batch installation. Always requires typed confirmation — issue a challenge first.',
    inputSchema: z.object({
      rollbackToken: z.string().describe('Rollback token from install history'),
      profile: z.string().optional(),
      confirmationToken: z.string().optional(),
      confirmationValue: z.string().optional(),
    }),
    async handler({ rollbackToken, profile, confirmationToken, confirmationValue }) {
      try {
        const creds = await resolveCredentials(profile);

        if (!confirmationToken) {
          const challenge = issueConfirmationChallenge(creds.instanceHost, 'rollback');
          return ok({ status: 'requires_confirmation', ...challenge });
        }
        const result = verifyConfirmation(confirmationToken, confirmationValue ?? '');
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
          rollbackToken,
          result: 'success',
          progressId,
        });

        return ok({ status: 'complete', progressId, lastResult: lastData });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_reconcile',
    description: 'Reconcile a manifest from one environment to another, producing an adjusted manifest.',
    inputSchema: z.object({
      manifestPath: z.string().describe('Path to source manifest'),
      targetProfile: z.string().describe('Profile for target instance'),
      output: z.string().optional(),
    }),
    async handler({ manifestPath, targetProfile, output }) {
      try {
        const sourceManifest = await readManifest(manifestPath);
        const creds = await resolveCredentials(targetProfile);
        const client = createClient(creds);
        const targetApps = await fetchInstalledApps(client);
        const reconciled = reconcilePackages(sourceManifest.packages, targetApps);
        const toInstall = reconciled.filter((r) => r.action === 'include');
        const adjusted = buildManifest(toInstall, creds.baseUrl, targetProfile);
        const path = output ?? join(process.cwd(), defaultManifestName(creds.instanceHost));
        await writeManifest(adjusted, path);
        return ok({ adjustedManifestPath: path, toInstall: toInstall.length, skipped: reconciled.length - toInstall.length });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_profiles',
    description: 'List available instance profiles.',
    inputSchema: z.object({}),
    async handler() {
      try {
        const profiles = await listProfiles();
        return ok({ profiles });
      } catch (e) { return err(e.message); }
    },
  },

  {
    name: 'snbatch_history',
    description: 'Show recent operation history.',
    inputSchema: z.object({ limit: z.number().optional().default(10) }),
    async handler({ limit }) {
      try {
        const raw = await readFile(HISTORY_PATH, 'utf8').catch(() => '');
        const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        return ok({ entries: entries.slice(-limit).reverse() });
      } catch (e) { return err(e.message); }
    },
  },
];
