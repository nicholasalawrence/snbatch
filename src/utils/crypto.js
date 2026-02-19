/**
 * AES-256-GCM encryption/decryption for profile credentials.
 * Stored format: salt:iv:authTag:ciphertext (all hex-encoded)
 *
 * Threat model: protects credentials from casual file reads.
 * Not a substitute for a hardware security module or secrets manager.
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {string} "salt:iv:authTag:ciphertext" (all hex)
 */
export function encrypt(plaintext, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [salt.toString('hex'), iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypt a value produced by encrypt().
 * @param {string} ciphertext "salt:iv:authTag:ciphertext" (all hex)
 * @param {string} passphrase
 * @returns {string} decrypted plaintext
 */
export function decrypt(ciphertext, passphrase) {
  const parts = ciphertext.split(':');
  if (parts.length !== 4) throw new Error('Invalid ciphertext format');
  const [saltHex, ivHex, tagHex, dataHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * P1-5: Hash a rollback token for safe storage in history.
 * @param {string} token
 * @returns {string} SHA-256 hex digest
 */
export function hashRollbackToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
