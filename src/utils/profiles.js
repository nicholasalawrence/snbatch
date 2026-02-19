/**
 * Profile management — encrypted credential store at ~/.snbatch/profiles.json
 *
 * Disk format: { encrypted: true, data: "<aes-gcm-ciphertext>" }
 * Decrypted format: { active: "dev", profiles: { dev: { url, username, password }, ... } }
 *
 * The encryption passphrase is derived from a fixed app constant + machine hostname,
 * providing at-rest protection without requiring a user-chosen passphrase.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { hostname } from 'os';
import { dirname } from 'path';
import { PROFILES_PATH, SNBATCH_DIR } from './paths.js';
import { encrypt, decrypt } from './crypto.js';

const APP_KEY_SEED = 'snbatch-v1-profile-store';

function getPassphrase() {
  return `${APP_KEY_SEED}:${hostname()}`;
}

async function loadStore() {
  try {
    const raw = await readFile(PROFILES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.encrypted) {
      const decrypted = decrypt(parsed.data, getPassphrase());
      return JSON.parse(decrypted);
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { active: null, profiles: {} };
    throw err;
  }
}

async function saveStore(store) {
  await mkdir(SNBATCH_DIR, { recursive: true });
  const payload = { encrypted: true, data: encrypt(JSON.stringify(store), getPassphrase()) };
  await writeFile(PROFILES_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * List all profiles (no credentials included).
 * @returns {Promise<Array<{name: string, url: string, active: boolean}>>}
 */
export async function listProfiles() {
  const store = await loadStore();
  return Object.entries(store.profiles).map(([name, data]) => ({
    name,
    url: data.url,
    active: name === store.active,
  }));
}

/**
 * Get a profile's credentials by name (or active profile if name is null).
 * @param {string|null} name
 * @returns {Promise<{url: string, username: string, password: string}>}
 */
export async function getProfile(name) {
  const store = await loadStore();
  const profileName = name ?? store.active;
  if (!profileName) throw new Error('No active profile. Run: snbatch profile add <name>');
  const profile = store.profiles[profileName];
  if (!profile) throw new Error(`Profile not found: ${profileName}`);
  return { ...profile };
}

/**
 * Add or update a profile.
 */
export async function addProfile(name, { url, username, password }) {
  const store = await loadStore();
  store.profiles[name] = { url, username, password };
  if (!store.active) store.active = name;
  await saveStore(store);
}

/**
 * Remove a profile.
 */
export async function removeProfile(name) {
  const store = await loadStore();
  if (!store.profiles[name]) throw new Error(`Profile not found: ${name}`);
  delete store.profiles[name];
  if (store.active === name) {
    const remaining = Object.keys(store.profiles);
    store.active = remaining[0] ?? null;
  }
  await saveStore(store);
}

/**
 * Set the active profile.
 */
export async function setActiveProfile(name) {
  const store = await loadStore();
  if (!store.profiles[name]) throw new Error(`Profile not found: ${name}`);
  store.active = name;
  await saveStore(store);
}

/**
 * Get the name of the active profile.
 */
export async function getActiveProfileName() {
  const store = await loadStore();
  return store.active;
}
