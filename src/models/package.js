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
    hasDemoData: rawApp.hasDemoData ?? false,
    loadDemoData: false,
  };
}

/**
 * Convert a package object to the CI/CD API install payload shape.
 * The id field must be the scope (not sys_id) per the batch install API contract.
 * @param {object} pkg
 * @returns {{ id: string, version: string, type: string, load_demo_data: boolean }}
 */
export function toInstallPayload(pkg) {
  return {
    id: pkg.scope,
    version: pkg.targetVersion,
    type: 'application',
    load_demo_data: false,
  };
}
