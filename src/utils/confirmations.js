/**
 * Shared confirmation logic used by both CLI and MCP paths.
 * Centralizing here ensures both paths enforce the same rules.
 */

/**
 * Returns true if a batch requires typed instance-hostname confirmation
 * (i.e., any major upgrades are present).
 * @param {{ major: number }} stats
 */
export function requiresTypedConfirmation(stats) {
  return stats.major > 0;
}

/**
 * Validate that the user typed the correct instance hostname.
 * Comparison is case-insensitive and strips leading https://.
 * @param {string} input    What the user typed
 * @param {string} expected The instance hostname (e.g. "myinstance.service-now.com")
 */
export function validateTypedConfirmation(input, expected) {
  const normalize = (s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return normalize(input) === normalize(expected);
}
