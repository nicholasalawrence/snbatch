/**
 * Credential resolution chain:
 *   1. Environment variables (SNBATCH_INSTANCE, SNBATCH_USERNAME, SNBATCH_PASSWORD)
 *   2. Encrypted profile file (~/.snbatch/profiles.json)
 *   3. Interactive inquirer prompt (P2-3: only when TTY is available)
 *
 * P1-4: HTTP URLs are rejected by default. Set --allow-insecure-http or SNBATCH_ALLOW_HTTP=1 to override.
 */
import inquirer from 'inquirer';
import { getProfile, addProfile } from '../utils/profiles.js';

/**
 * Resolve credentials for the given profile name (or active profile if null).
 * @param {string|null} profileName
 * @param {{ allowInsecureHttp?: boolean }} [options]
 * @returns {Promise<{baseUrl: string, username: string, password: string, instanceHost: string}>}
 */
export async function resolveCredentials(profileName, options = {}) {
  // 1. Environment variables
  if (process.env.SNBATCH_INSTANCE && process.env.SNBATCH_USERNAME && process.env.SNBATCH_PASSWORD) {
    const baseUrl = normalizeUrl(process.env.SNBATCH_INSTANCE, options);
    return { baseUrl, username: process.env.SNBATCH_USERNAME, password: process.env.SNBATCH_PASSWORD, instanceHost: extractHost(baseUrl) };
  }

  // 2. Profile file
  try {
    const profile = await getProfile(profileName);
    const baseUrl = normalizeUrl(profile.url, options);
    return { baseUrl, username: profile.username, password: profile.password, instanceHost: extractHost(baseUrl) };
  } catch (profileErr) {
    // Fall through to interactive prompt
  }

  // P2-3: Check for TTY before attempting interactive prompt
  if (!process.stdin.isTTY) {
    throw new Error(
      'No credentials found. Set SNBATCH_INSTANCE, SNBATCH_USERNAME, and SNBATCH_PASSWORD environment variables, or use --profile.'
    );
  }

  // 3. Interactive prompt
  const answers = await inquirer.prompt([
    { type: 'input', name: 'instance', message: 'ServiceNow instance URL:', validate: (v) => v ? true : 'Required' },
    { type: 'input', name: 'username', message: 'Username:', validate: (v) => v ? true : 'Required' },
    { type: 'password', name: 'password', message: 'Password:', mask: '*', validate: (v) => v ? true : 'Required' },
    { type: 'confirm', name: 'save', message: 'Save as profile?', default: false },
    {
      type: 'input',
      name: 'profileName',
      message: 'Profile name:',
      when: (a) => a.save,
      validate: (v) => v ? true : 'Required',
    },
  ]);

  const baseUrl = normalizeUrl(answers.instance, options);

  if (answers.save && answers.profileName) {
    await addProfile(answers.profileName, {
      url: baseUrl,
      username: answers.username,
      password: answers.password,
    });
  }

  return { baseUrl, username: answers.username, password: answers.password, instanceHost: extractHost(baseUrl) };
}

// P1-4: Reject HTTP by default, require explicit opt-in
function normalizeUrl(raw, options = {}) {
  const url = raw.trim();
  const allowHttp = options.allowInsecureHttp || process.env.SNBATCH_ALLOW_HTTP === '1';

  if (url.startsWith('http://')) {
    if (!allowHttp) {
      throw new Error(
        'HTTP URLs are not allowed — credentials would be sent in plaintext. ' +
        'Use https:// or set --allow-insecure-http / SNBATCH_ALLOW_HTTP=1 to override.'
      );
    }
    process.stderr.write('⚠️  WARNING: Using insecure HTTP connection. Credentials will be sent in plaintext.\n');
    return url.replace(/\/$/, '');
  }
  if (url.startsWith('https://')) return url.replace(/\/$/, '');
  return `https://${url.replace(/\/$/, '')}`;
}

function extractHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}
