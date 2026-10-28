import crypto from 'node:crypto';
import { CryptoOperationError } from '../errors/base-error.mjs';

/**
 * @typedef {object} EncryptedEnvelope
 * @property {Buffer} encryptedPayload - Ciphertext of the payload.
 * @property {Buffer} payloadNonce - 12-byte initialization vector.
 * @property {Buffer} payloadTag - 16-byte GCM authentication tag.
 * @property {Buffer} wrappedDek - 60-byte wrapped DEK (12-byte nonce + 16-byte tag + 32-byte ciphertext).
 */

const GCM_NONCE_LENGTH = 12; // 96 bits
const GCM_TAG_LENGTH = 16; // 128 bits
const DEK_LENGTH = 32; // 256 bits

/**
 * Encrypts an arbitrary raw payload buffer using envelope encryption:
 * Generates an ephemeral DEK, encrypts payload with AES-256-GCM bound to eventId AAD,
 * and wraps DEK under master KEK.
 *
 * @param {Buffer} rawPayload - Raw byte buffer to encrypt.
 * @param {string} eventId - UUID string bound as Authenticated Additional Data (AAD).
 * @param {Buffer} masterKek - 32-byte master Key Encryption Key.
 * @returns {EncryptedEnvelope}
 */
export function encryptPayloadEnvelope(rawPayload, eventId, masterKek) {
  if (!Buffer.isBuffer(rawPayload)) {
    throw new CryptoOperationError('rawPayload must be a Buffer.');
  }
  if (!eventId || typeof eventId !== 'string') {
    throw new CryptoOperationError('eventId must be a non-empty UUID string.');
  }
  if (!Buffer.isBuffer(masterKek) || masterKek.length !== 32) {
    throw new CryptoOperationError('masterKek must be a 32-byte Buffer.');
  }

  // 1. Generate ephemeral 256-bit DEK
  const dek = crypto.randomBytes(DEK_LENGTH);

  try {
    // 2. Encrypt payload with DEK using AES-256-GCM
    const payloadNonce = crypto.randomBytes(GCM_NONCE_LENGTH);
    const payloadCipher = crypto.createCipheriv('aes-256-gcm', dek, payloadNonce);
    payloadCipher.setAAD(Buffer.from(eventId, 'utf8'));

    const encryptedPayload = Buffer.concat([
      payloadCipher.update(rawPayload),
      payloadCipher.final(),
    ]);
    const payloadTag = payloadCipher.getAuthTag();

    // 3. Wrap DEK under master KEK using AES-256-GCM
    const wrapNonce = crypto.randomBytes(GCM_NONCE_LENGTH);
    const wrapCipher = crypto.createCipheriv('aes-256-gcm', masterKek, wrapNonce);
    wrapCipher.setAAD(Buffer.from(`cwids-dek-wrap:${eventId}`, 'utf8'));

    const wrappedDekCiphertext = Buffer.concat([
      wrapCipher.update(dek),
      wrapCipher.final(),
    ]);
    const wrapTag = wrapCipher.getAuthTag();

    // Pack wrapped DEK: [12-byte wrapNonce][16-byte wrapTag][32-byte wrappedDekCiphertext] = 60 bytes
    const wrappedDek = Buffer.concat([wrapNonce, wrapTag, wrappedDekCiphertext]);

    return {
      encryptedPayload,
      payloadNonce,
      payloadTag,
      wrappedDek,
    };
  } finally {
    // Securely zero ephemeral DEK memory
    dek.fill(0);
  }
}

/**
 * Decrypts an envelope-encrypted payload:
 * Unwraps DEK using master KEK and decrypts ciphertext verifying GCM auth tag and eventId AAD.
 *
 * @param {Buffer} encryptedPayload - Ciphertext buffer.
 * @param {Buffer} payloadNonce - 12-byte nonce.
 * @param {Buffer} payloadTag - 16-byte auth tag.
 * @param {Buffer} wrappedDek - 60-byte wrapped DEK buffer.
 * @param {string} eventId - UUID string bound as Authenticated Additional Data (AAD).
 * @param {Buffer} masterKek - 32-byte master Key Encryption Key.
 * @returns {Buffer} Decrypted raw payload bytes.
 */
export function decryptPayloadEnvelope(
  encryptedPayload,
  payloadNonce,
  payloadTag,
  wrappedDek,
  eventId,
  masterKek,
) {
  if (!Buffer.isBuffer(encryptedPayload) || !Buffer.isBuffer(payloadNonce) || !Buffer.isBuffer(payloadTag) || !Buffer.isBuffer(wrappedDek)) {
    throw new CryptoOperationError('Encrypted payload components must be Buffers.');
  }
  if (!eventId || typeof eventId !== 'string') {
    throw new CryptoOperationError('eventId must be a non-empty UUID string.');
  }
  if (!Buffer.isBuffer(masterKek) || masterKek.length !== 32) {
    throw new CryptoOperationError('masterKek must be a 32-byte Buffer.');
  }

  if (payloadNonce.length !== GCM_NONCE_LENGTH) {
    throw new CryptoOperationError(`Invalid payload nonce length: expected ${GCM_NONCE_LENGTH}, received ${payloadNonce.length}.`);
  }
  if (payloadTag.length !== GCM_TAG_LENGTH) {
    throw new CryptoOperationError(`Invalid payload auth tag length: expected ${GCM_TAG_LENGTH}, received ${payloadTag.length}.`);
  }
  const expectedWrappedDekLength = GCM_NONCE_LENGTH + GCM_TAG_LENGTH + DEK_LENGTH; // 12 + 16 + 32 = 60
  if (wrappedDek.length !== expectedWrappedDekLength) {
    throw new CryptoOperationError(`Invalid wrapped DEK length: expected ${expectedWrappedDekLength}, received ${wrappedDek.length}.`);
  }

  // 1. Unpack wrapped DEK components
  const wrapNonce = wrappedDek.subarray(0, GCM_NONCE_LENGTH);
  const wrapTag = wrappedDek.subarray(GCM_NONCE_LENGTH, GCM_NONCE_LENGTH + GCM_TAG_LENGTH);
  const wrappedKeyCiphertext = wrappedDek.subarray(GCM_NONCE_LENGTH + GCM_TAG_LENGTH);

  /** @type {Buffer} */
  let dek;
  try {
    const unwrapCipher = crypto.createDecipheriv('aes-256-gcm', masterKek, wrapNonce);
    unwrapCipher.setAAD(Buffer.from(`cwids-dek-wrap:${eventId}`, 'utf8'));
    unwrapCipher.setAuthTag(wrapTag);

    dek = Buffer.concat([
      unwrapCipher.update(wrappedKeyCiphertext),
      unwrapCipher.final(),
    ]);
  } catch (err) {
    throw new CryptoOperationError('Failed to unwrap DEK: Authentication failed or tampered wrapped key.', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // 2. Decrypt payload ciphertext using unwrapped DEK
    const payloadDecipher = crypto.createDecipheriv('aes-256-gcm', dek, payloadNonce);
    payloadDecipher.setAAD(Buffer.from(eventId, 'utf8'));
    payloadDecipher.setAuthTag(payloadTag);

    return Buffer.concat([
      payloadDecipher.update(encryptedPayload),
      payloadDecipher.final(),
    ]);
  } catch (err) {
    throw new CryptoOperationError('Failed to decrypt payload: Authentication tag mismatch or tampered ciphertext/AAD.', {
      cause: err instanceof Error ? err.message : String(err),
    });
  } finally {
    dek.fill(0);
  }
}
