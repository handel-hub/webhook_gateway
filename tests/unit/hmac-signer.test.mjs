import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOutboundSignature, verifyOutboundSignature } from '../../src/security/hmac-signer.mjs';

const DELIVERY_ID = 'deliv_8899aabb-ccdd-eeff-0011-223344556677';
const PAYLOAD = JSON.stringify({ event: 'charge.completed', amount_minor: 500000 });
const SECRET = 'app_signing_secret_key_very_secure';

test('generateOutboundSignature generates standard t=...,v1=... format and validates', () => {
  const header = generateOutboundSignature(DELIVERY_ID, PAYLOAD, SECRET);

  assert.ok(header.startsWith('t='));
  assert.ok(header.includes(',v1='));

  const isValid = verifyOutboundSignature(header, DELIVERY_ID, PAYLOAD, SECRET);
  assert.equal(isValid, true);
});

test('verifyOutboundSignature rejects tampered payload', () => {
  const header = generateOutboundSignature(DELIVERY_ID, PAYLOAD, SECRET);
  const tamperedPayload = JSON.stringify({ event: 'charge.completed', amount_minor: 1000 });

  const isValid = verifyOutboundSignature(header, DELIVERY_ID, tamperedPayload, SECRET);
  assert.equal(isValid, false);
});

test('verifyOutboundSignature rejects tampered deliveryId', () => {
  const header = generateOutboundSignature(DELIVERY_ID, PAYLOAD, SECRET);
  const differentDeliveryId = 'deliv_different';

  const isValid = verifyOutboundSignature(header, differentDeliveryId, PAYLOAD, SECRET);
  assert.equal(isValid, false);
});

test('verifyOutboundSignature rejects wrong secret', () => {
  const header = generateOutboundSignature(DELIVERY_ID, PAYLOAD, SECRET);

  const isValid = verifyOutboundSignature(header, DELIVERY_ID, PAYLOAD, 'wrong_secret');
  assert.equal(isValid, false);
});

test('verifyOutboundSignature rejects timestamps outside clock drift tolerance', () => {
  const oldTimestampSeconds = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
  const header = generateOutboundSignature(DELIVERY_ID, PAYLOAD, SECRET, oldTimestampSeconds);

  // Default tolerance is 300s (5 minutes)
  const isValid = verifyOutboundSignature(header, DELIVERY_ID, PAYLOAD, SECRET, 300);
  assert.equal(isValid, false);
});
