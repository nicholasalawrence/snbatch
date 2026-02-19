/**
 * Minimal semver utilities without external dependencies.
 * Handles standard MAJOR.MINOR.PATCH version strings.
 */

/**
 * Parse a version string into numeric parts.
 * @param {string} v e.g. "3.2.1"
 * @returns {number[]} [major, minor, patch]
 */
function parse(v) {
  return String(v)
    .split('.')
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}

/**
 * Compare two version strings.
 * @returns {-1|0|1} -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Returns true if version b is strictly newer than a.
 */
export function isUpgrade(from, to) {
  return compareVersions(from, to) === -1;
}

/**
 * Classify the magnitude of an upgrade.
 * @param {string} from current version
 * @param {string} to   target version
 * @returns {'patch'|'minor'|'major'|'none'}
 */
export function upgradeType(from, to) {
  const [fromMaj, fromMin] = parse(from);
  const [toMaj, toMin] = parse(to);

  if (!isUpgrade(from, to)) return 'none';
  if (toMaj > fromMaj) return 'major';
  if (toMin > fromMin) return 'minor';
  return 'patch';
}

/**
 * Returns an emoji indicator for the upgrade risk level.
 * @param {'patch'|'minor'|'major'|'none'} type
 */
export function riskEmoji(type) {
  switch (type) {
    case 'patch': return '🟢';
    case 'minor': return '🟡';
    case 'major': return '🔴';
    default: return '⚪';
  }
}
