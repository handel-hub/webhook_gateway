import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayloadEnvelope, decryptPayloadEnvelope } from '../../src/security/crypto-envelope.mjs';
import { CryptoOperationError } from '../../src/errors/base-error.mjs';

const MASTER_KEK = crypto.randomBytes(32);
const ALTERNATE_KEK = crypto.randomBytes(32);
const EVENT_ID = 'b7325ec2-9e23-455b-9d41-35f12a3d76ce';
const SAMPLE_PAYLOAD = Buffer.from(JSON.stringify({ event: 'charge.completed', amount: 50000, customer: 'user@example.com' }));

test('Envelope encryption round-trip succeeds and restores original payload', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);

  assert.ok(envelope.encryptedPayload.length > 0);
  assert.equal(envelope.payloadNonce.length, 12);
  assert.equal(envelope.payloadTag.length, 16);
  assert.equal(envelope.wrappedDek.length, 60);

  const decrypted = decryptPayloadEnvelope(
    envelope.encryptedPayload,
    envelope.payloadNonce,
    envelope.payloadTag,
    envelope.wrappedDek,
    EVENT_ID,
    MASTER_KEK,
  );

  assert.deepEqual(decrypted, SAMPLE_PAYLOAD);
  assert.equal(decrypted.toString('utf8'), SAMPLE_PAYLOAD.toString('utf8'));
});

test('Decryption fails when ciphertext is tampered', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);
  // Flip a bit in the ciphertext
  const tamperedCiphertext = Buffer.from(envelope.encryptedPayload);
  tamperedCiphertext.writeUInt8(tamperedCiphertext.readUInt8(0) ^ 0xff, 0);

  assert.throws(
    () => {
      decryptPayloadEnvelope(
        tamperedCiphertext,
        envelope.payloadNonce,
        envelope.payloadTag,
        envelope.wrappedDek,
        EVENT_ID,
        MASTER_KEK,
      );
    },
    CryptoOperationError,
  );
});

test('Decryption fails when payload authentication tag is tampered', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);
  const tamperedTag = Buffer.from(envelope.payloadTag);
  tamperedTag.writeUInt8(tamperedTag.readUInt8(0) ^ 0xff, 0);

  assert.throws(
    () => {
      decryptPayloadEnvelope(
        envelope.encryptedPayload,
        envelope.payloadNonce,
        tamperedTag,
        envelope.wrappedDek,
        EVENT_ID,
        MASTER_KEK,
      );
    },
    CryptoOperationError,
  );
});

test('Decryption fails when eventId (AAD) does not match', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);
  const differentEventId = 'c8436fd3-0f34-566c-ae52-46f23b4e87df';

  assert.throws(
    () => {
      decryptPayloadEnvelope(
        envelope.encryptedPayload,
        envelope.payloadNonce,
        envelope.payloadTag,
        envelope.wrappedDek,
        differentEventId,
        MASTER_KEK,
      );
    },
    CryptoOperationError,
  );
});

test('Decryption fails when wrong Master KEK is provided', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);

  assert.throws(
    () => {
      decryptPayloadEnvelope(
        envelope.encryptedPayload,
        envelope.payloadNonce,
        envelope.payloadTag,
        envelope.wrappedDek,
        EVENT_ID,
        ALTERNATE_KEK,
      );
    },
    CryptoOperationError,
  );
});

test('Decryption fails when wrapped DEK is tampered', () => {
  const envelope = encryptPayloadEnvelope(SAMPLE_PAYLOAD, EVENT_ID, MASTER_KEK);
  const tamperedWrappedDek = Buffer.from(envelope.wrappedDek);
  const lastIndex = tamperedWrappedDek.length - 1;
  tamperedWrappedDek.writeUInt8(tamperedWrappedDek.readUInt8(lastIndex) ^ 0xff, lastIndex);

  assert.throws(
    () => {
      decryptPayloadEnvelope(
        envelope.encryptedPayload,
        envelope.payloadNonce,
        envelope.payloadTag,
        tamperedWrappedDek,
        EVENT_ID,
        MASTER_KEK,
      );
    },
    CryptoOperationError,
  );
});
