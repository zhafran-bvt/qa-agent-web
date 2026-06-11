import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for per-user secrets (TestRail API keys), at rest.
 * The key is derived from the ENCRYPTION_KEY env via SHA-256 (so any-length secret works).
 * Payload format (base64): [12-byte IV][16-byte auth tag][ciphertext].
 */
function rawKey(): string {
  return process.env.ENCRYPTION_KEY || '';
}

export function encryptionAvailable(): boolean {
  return rawKey().length > 0;
}

/**
 * The AES key is SHA-256(ENCRYPTION_KEY) with no salt/work factor, which is only safe when the key is
 * high-entropy random material (≥32 random bytes). Surface a warning when the configured value looks
 * like a short/low-entropy human passphrase. Returns the problem string, or null when the key looks
 * adequate. (We don't switch to scrypt/pbkdf2 here because that would invalidate already-encrypted
 * secrets at rest; this is a guardrail, not a re-keying.)
 */
export function assessEncryptionKeyStrength(): string | null {
  const key = rawKey();
  if (!key) return null; // not configured → encryptionAvailable() handles that path
  if (key.length < 32) {
    return `ENCRYPTION_KEY is only ${key.length} characters; use ≥32 random bytes (e.g. \`openssl rand -base64 48\`).`;
  }
  const distinct = new Set(key).size;
  if (distinct < 12) {
    return `ENCRYPTION_KEY has low character diversity (${distinct} distinct chars); it looks like a weak passphrase rather than random bytes.`;
  }
  return null;
}

function derivedKey(): Buffer {
  return crypto.createHash('sha256').update(rawKey(), 'utf8').digest();
}

export function encryptSecret(plain: string): string {
  if (!encryptionAvailable()) throw new Error('ENCRYPTION_KEY is not configured.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  if (!encryptionAvailable()) throw new Error('ENCRYPTION_KEY is not configured.');
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
