/**
 * Programmatic API — re-exports for use without spawning a subprocess.
 */
export { scanData } from './commands/scan.js';
export { reconcilePackages } from './commands/reconcile.js';
export { buildManifest, readManifest, writeManifest, validateManifest, computeStats } from './models/manifest.js';
export { buildPackageObject, toInstallPayload } from './models/package.js';
export { upgradeType, compareVersions, riskEmoji } from './utils/version.js';
export { loadConfig } from './utils/config.js';
export { resolveCredentials } from './api/auth.js';
export { createClient } from './api/index.js';
export { startBatchInstall, startBatchRollback, pollProgress } from './api/cicd.js';
