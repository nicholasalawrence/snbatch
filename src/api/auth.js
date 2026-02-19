/**
 * Credential resolution chain:
 *   1. Environment variables (SNBATCH_INSTANCE, SNBATCH_USERNAME, SNBATCH_PASSWORD)
 *   2. Encrypted profile file (~/.snbatch/profiles.json)
 *   3. Interactive inquirer prompt
 */
import inquirer from 'inquirer';
import { getProfile, addProfile } from '../utils/profiles.js';

/**
 * Resolve credentials for the given profile name (or active profile if null).
 * @param {string|null} profileName
 * @returns {Promise<{baseUrl: string, username: string, password: string, instanceHost: string}>}
 */
export async function resolveCredentials(profileName) {
  // 1. Environment variables
  if (process.env.SNBATCH_INSTANCE && process.env.SNBATCH_USERNAME && process.env.SNBATCH_PASSWORD) {
    const baseUrl = normalizeUrl(process.env.SNBATCH_INSTANCE);
    return { baseUrl, username: process.env.SNBATCH_USERNAME, password: process.env.SNBATCH_PASSWORD, instanceHost: extractHost(baseUrl) };
  }

  // 2. Profile file
  try {
    const profile = await getProfile(profileName);
    const baseUrl = normalizeUrl(profile.url);
    return { baseUrl, username: profile.username, password: profile.password, instanceHost: extractHost(baseUrl) };
  } catch (profileErr) {
    // Fall through to interactive prompt
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

  const baseUrl = normalizeUrl(answers.instance);

  if (answers.save && answers.profileName) {
    await addProfile(answers.profileName, {
      url: baseUrl,
      username: answers.username,
      password: answers.password,
    });
  }

  return { baseUrl, username: answers.username, password: answers.password, instanceHost: extractHost(baseUrl) };
}

function normalizeUrl(raw) {
  const url = raw.trim();
  if (url.startsWith('http://') || url.startsWith('https://')) return url.replace(/\/$/, '');
  return `https://${url.replace(/\/$/, '')}`;
}

function extractHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}
