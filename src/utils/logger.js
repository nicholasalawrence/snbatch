/**
 * Structured JSON Lines logger.
 * Writes to ~/.snbatch/logs/{instance}-{timestamp}.log
 * Suppressed in MCP mode (SNBATCH_MCP_MODE=1) — logs go to stderr.
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { LOGS_DIR } from './paths.js';

const MCP_MODE = process.env.SNBATCH_MCP_MODE === '1';

// P3-1: Expanded list of sensitive key patterns
const SENSITIVE_KEY_PATTERNS = [
  'password', 'token', 'auth', 'secret',
  'apikey', 'api_key', 'credential', 'bearer',
  'authorization', 'private_key', 'access_token',
];

// P3-1: Pattern for URL-embedded credentials (://user:pass@)
const URL_CREDENTIAL_RE = /:\/\/[^:]+:[^@]+@/;

function sanitize(obj) {
  if (typeof obj === 'string') {
    // Redact URL-embedded credentials
    if (URL_CREDENTIAL_RE.test(obj)) {
      return obj.replace(/:\/\/([^:]+):[^@]+@/, '://$1:[REDACTED]@');
    }
    return obj;
  }
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some((p) => lk.includes(p))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

// Exported for testing
export { sanitize };

/**
 * Create a logger bound to a specific instance and run.
 * @param {string} instanceHost e.g. "dev.service-now.com"
 * @returns {{ info, warn, error, debug }}
 */
export async function createLogger(instanceHost) {
  const safe = instanceHost.replace(/[^a-zA-Z0-9.-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = join(LOGS_DIR, `${safe}-${ts}.log`);

  // P2-10: Create log directory with restricted permissions
  await mkdir(LOGS_DIR, { recursive: true, mode: 0o700 });

  function writeLine(level, message, meta = {}) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...sanitize(meta) });
    if (MCP_MODE) {
      process.stderr.write(line + '\n');
    } else {
      // P2-10: Write log files with restricted permissions
      appendFile(logFile, line + '\n', { mode: 0o600 }).catch(() => {});
    }
  }

  return {
    info: (msg, meta) => writeLine('info', msg, meta),
    warn: (msg, meta) => writeLine('warn', msg, meta),
    error: (msg, meta) => writeLine('error', msg, meta),
    debug: (msg, meta) => writeLine('debug', msg, meta),
    path: logFile,
  };
}
