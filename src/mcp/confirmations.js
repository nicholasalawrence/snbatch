/**
 * MCP confirmation challenge/response flow.
 *
 * Because MCP tools communicate via JSON-RPC (no terminal readline), confirmations
 * use a token-based challenge: the tool returns a challenge, the LLM relays it to
 * the user, and the next tool call includes the token + user's response.
 */
import { randomUUID } from 'crypto';
import { requiresTypedConfirmation, validateTypedConfirmation } from '../utils/confirmations.js';

// In-memory map — tokens expire after 5 minutes
const challenges = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

// P3-2: Clean up expired tokens to prevent memory leaks
function cleanupExpired() {
  const now = Date.now();
  for (const [token, data] of challenges) {
    if (now > data.expiresAt) challenges.delete(token);
  }
}

/**
 * Issue a confirmation challenge for a destructive operation.
 * @param {string} instanceHost
 * @param {'install'|'rollback'} operation
 * @returns {{ token: string, message: string }}
 */
export function issueConfirmationChallenge(instanceHost, operation = 'install') {
  // P3-2: Clean expired tokens before issuing new ones
  cleanupExpired();

  const token = randomUUID();
  challenges.set(token, {
    instanceHost,
    operation,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return {
    token,
    message: `⚠️  This ${operation} requires confirmation. Type the instance hostname to proceed: ${instanceHost}\n\nCall this tool again with: { confirmationToken: "${token}", confirmationValue: "<typed hostname>" }`,
  };
}

/**
 * Verify a previously issued challenge.
 * @param {string} token
 * @param {string} value  What the user typed
 * @param {string} [operation] Operation type to verify against (P2-8)
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyConfirmation(token, value, operation) {
  const challenge = challenges.get(token);
  if (!challenge) return { valid: false, error: 'Confirmation token not found or already used' };
  if (Date.now() > challenge.expiresAt) {
    challenges.delete(token);
    return { valid: false, error: 'Confirmation token has expired. Start the operation again.' };
  }
  // P2-8: Verify operation type matches what was issued
  if (operation && challenge.operation !== operation) {
    challenges.delete(token);
    return { valid: false, error: `Confirmation token was issued for "${challenge.operation}", not "${operation}".` };
  }
  if (!validateTypedConfirmation(value, challenge.instanceHost)) {
    return { valid: false, error: `Confirmation value does not match. Expected: ${challenge.instanceHost}` };
  }
  challenges.delete(token);
  return { valid: true };
}

/**
 * Determine if an install operation needs a confirmation challenge.
 * @param {object[]} packages
 * @returns {boolean}
 */
export function installNeedsConfirmation(packages) {
  const stats = { major: 0 };
  for (const p of packages) if (p.upgradeType === 'major') stats.major++;
  return requiresTypedConfirmation(stats);
}
