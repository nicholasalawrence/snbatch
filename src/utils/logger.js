/**
 * Structured JSON Lines logger.
 * Writes to ~/.snbatch/logs/{instance}-{timestamp}.log
 * Suppressed in MCP mode (SNBATCH_MCP_MODE=1) — logs go to stderr.
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { LOGS_DIR } from './paths.js';

const MCP_MODE = process.env.SNBATCH_MCP_MODE === '1';

function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes('password') || lk.includes('token') || lk.includes('auth') || lk.includes('secret')) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

/**
 * Create a logger bound to a specific instance and run.
 * @param {string} instanceHost e.g. "dev.service-now.com"
 * @returns {{ info, warn, error, debug }}
 */
export async function createLogger(instanceHost) {
  const safe = instanceHost.replace(/[^a-zA-Z0-9.-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = join(LOGS_DIR, `${safe}-${ts}.log`);

  await mkdir(LOGS_DIR, { recursive: true });

  function writeLine(level, message, meta = {}) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...sanitize(meta) });
    if (MCP_MODE) {
      process.stderr.write(line + '\n');
    } else {
      appendFile(logFile, line + '\n').catch(() => {});
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
