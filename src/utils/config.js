/**
 * Config resolution: CLI flags → env vars → .snbatchrc (walk up) → ~/.snbatch/config.json → defaults
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { CONFIG_PATH } from './paths.js';

const DEFAULTS = {
  format: 'table',
  type: 'all',
  pollInterval: 10_000,
  maxPollDuration: 7_200_000,
  retries: 3,
  backoffBase: 2_000,
  stopOnError: false,
};

async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function findSnbatchrc(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, '.snbatchrc');
    const data = await readJson(candidate);
    if (data) return data;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load the merged config object.
 * @param {object} [cliOverrides]  Values from CLI flags (truthy values only applied)
 * @returns {Promise<object>} Frozen merged config
 */
export async function loadConfig(cliOverrides = {}) {
  const [projectRc, globalConfig] = await Promise.all([
    findSnbatchrc(process.cwd()),
    readJson(CONFIG_PATH),
  ]);

  const envOverrides = {};
  if (process.env.SNBATCH_FORMAT) envOverrides.format = process.env.SNBATCH_FORMAT;
  if (process.env.SNBATCH_POLL_INTERVAL) envOverrides.pollInterval = Number(process.env.SNBATCH_POLL_INTERVAL);
  if (process.env.SNBATCH_RETRIES) envOverrides.retries = Number(process.env.SNBATCH_RETRIES);

  const merged = {
    ...DEFAULTS,
    ...(globalConfig?.defaults ?? globalConfig ?? {}),
    ...(projectRc?.defaults ?? projectRc ?? {}),
    ...envOverrides,
  };

  // Apply CLI overrides — only defined values
  for (const [k, v] of Object.entries(cliOverrides)) {
    if (v !== undefined && v !== null) merged[k] = v;
  }

  // excludeAlways: merge arrays from global + project + cli
  const globalExclude = globalConfig?.exclude_always ?? [];
  const projectExclude = projectRc?.exclude_always ?? [];
  const cliExclude = cliOverrides?.exclude ?? [];
  merged.excludeAlways = [...new Set([...globalExclude, ...projectExclude, ...cliExclude])];

  return Object.freeze(merged);
}
