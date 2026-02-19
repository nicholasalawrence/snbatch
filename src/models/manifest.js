/**
 * Manifest model — the unit of work for install and reconcile.
 *
 * A manifest is stable/deterministic: packages sorted by scope alphabetically.
 * The createdAt timestamp is in metadata only, so the packages array is diffable.
 */
import { readFile, writeFile } from 'fs/promises';

const MANIFEST_VERSION = 1;

/**
 * Compute upgrade type counts.
 * @param {object[]} packages
 * @returns {{ total: number, patch: number, minor: number, major: number, none: number }}
 */
export function computeStats(packages) {
  const stats = { total: packages.length, patch: 0, minor: 0, major: 0, none: 0 };
  for (const pkg of packages) {
    const t = pkg.upgradeType ?? 'none';
    if (t in stats) stats[t]++;
  }
  return stats;
}

/**
 * Build a manifest object from an array of package objects.
 * @param {object[]} packages
 * @param {string} instanceUrl  e.g. "https://dev.service-now.com"
 * @param {string|null} profileName
 * @param {string} [instanceVersion]
 * @param {string} [snbatchVersion]
 * @returns {object}
 */
export function buildManifest(packages, instanceUrl, profileName, instanceVersion = 'Unknown', snbatchVersion = '0.1.0') {
  const sorted = [...packages].sort((a, b) => a.scope.localeCompare(b.scope));
  return {
    manifestVersion: MANIFEST_VERSION,
    metadata: {
      createdAt: new Date().toISOString(),
      instance: instanceUrl,
      instanceVersion,
      profile: profileName,
      snbatchVersion,
    },
    packages: sorted,
    stats: computeStats(sorted),
  };
}

/**
 * Write a manifest to disk as formatted JSON.
 * @param {object} manifest
 * @param {string} outputPath
 */
export async function writeManifest(manifest, outputPath) {
  await writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Read and parse a manifest from disk.
 * @param {string} inputPath
 * @returns {Promise<object>}
 */
export async function readManifest(inputPath) {
  const raw = await readFile(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const { valid, errors } = validateManifest(parsed);
  if (!valid) throw new Error(`Invalid manifest: ${errors.join(', ')}`);
  return parsed;
}

/**
 * Validate a manifest object.
 * @param {object} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') { errors.push('Must be an object'); return { valid: false, errors }; }
  if (obj.manifestVersion !== MANIFEST_VERSION) errors.push(`Expected manifestVersion ${MANIFEST_VERSION}`);
  if (!obj.metadata?.instance) errors.push('metadata.instance is required');
  if (!Array.isArray(obj.packages)) errors.push('packages must be an array');
  else {
    for (const pkg of obj.packages) {
      if (!pkg.scope) errors.push(`Package missing scope: ${JSON.stringify(pkg)}`);
      if (!pkg.sysId) errors.push(`Package missing sysId (scope: ${pkg.scope})`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Generate the default manifest filename.
 * @param {string} instanceHost  e.g. "dev.service-now.com"
 * @returns {string}
 */
export function defaultManifestName(instanceHost) {
  const safe = instanceHost.replace(/[^a-zA-Z0-9.-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `snbatch-manifest-${safe}-${ts}.json`;
}
