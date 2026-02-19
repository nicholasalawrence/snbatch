/**
 * Package model — canonical shape for an app/plugin with upgrade info.
 */
import { upgradeType } from '../utils/version.js';

/**
 * Build the canonical package object from raw API data.
 * @param {{ sysId, scope, name, version, sourceId, type }} rawApp
 * @param {string|null} targetVersion  Latest available version (null if no update available)
 * @returns {object}
 */
export function buildPackageObject(rawApp, targetVersion) {
  const type = upgradeType(rawApp.version, targetVersion ?? rawApp.version);
  return {
    sysId: rawApp.sysId,
    scope: rawApp.scope,
    name: rawApp.name,
    currentVersion: rawApp.version,
    targetVersion: targetVersion ?? rawApp.version,
    upgradeType: type,
    sourceId: rawApp.sourceId,
    packageType: rawApp.type ?? 'app',
  };
}

/**
 * Convert a package object to the CI/CD API install payload shape.
 * @param {object} pkg
 * @returns {{ id: string, version: string }}
 */
export function toInstallPayload(pkg) {
  return {
    id: pkg.sysId,
    version: pkg.targetVersion,
    type: pkg.packageType === 'plugin' ? 'plugin' : 'application',
  };
}
