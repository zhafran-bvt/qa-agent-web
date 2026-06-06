import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptionAvailable, encryptSecret } from '../../src/server/services/crypto';

test('encrypt → decrypt round-trips with a key set', () => {
  process.env.ENCRYPTION_KEY = 'unit-test-secret-key';
  assert.equal(encryptionAvailable(), true);
  const secret = 'tr-api-key-abc123';
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret); // not plaintext
  assert.equal(decryptSecret(enc), secret);
});

test('two encryptions of the same value differ (random IV)', () => {
  process.env.ENCRYPTION_KEY = 'unit-test-secret-key';
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('tampered ciphertext fails to decrypt (GCM auth)', () => {
  process.env.ENCRYPTION_KEY = 'unit-test-secret-key';
  const enc = encryptSecret('secret');
  const buf = Buffer.from(enc, 'base64');
  buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
  assert.throws(() => decryptSecret(buf.toString('base64')));
});

test('unavailable when no key', () => {
  delete process.env.ENCRYPTION_KEY;
  assert.equal(encryptionAvailable(), false);
  assert.throws(() => encryptSecret('x'));
});
