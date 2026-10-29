import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyCwidsWebhook } from '../../src/security/verify-cwids-webhook.mjs';
import { generateOutboundSignature } from '../../src/security/hmac-signer.mjs';

test('verifyCwidsWebhook: authentic signature and metadata passes verification', () => {
  const secret = 'test_secret_abc123';
  const deliveryId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const provider = 'flutterwave';
  const now = Math.floor(Date.now() / 1000);
  const rawBody = Buffer.from('{"status":"successful","tx_ref":"tx-12345","amount":5000}', 'utf8');

  const signature = generateOutboundSignature(deliveryId, rawBody, secret, now);

  const headers = {
    'content-type': 'application/json',
    'x-cwids-delivery-id': deliveryId,
    'x-cwids-event-id': eventId,
    'x-cwids-provider': provider,
    'x-cwids-timestamp': String(now),
    'x-cwids-signature': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody,
    signingSecret: secret,
    currentTimestamp: now,
  });

  assert.equal(result.isValid, true);
  assert.equal(result.deliveryId, deliveryId);
  assert.equal(result.eventId, eventId);
  assert.equal(result.provider, provider);
  assert.equal(result.timestamp, now);
  assert.equal(result.failureReason, null);
});

test('verifyCwidsWebhook: supports mixed-case and uppercase headers', () => {
  const secret = 'test_secret_abc123';
  const deliveryId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const rawBody = '{"event":"charge.success"}';
  const signature = generateOutboundSignature(deliveryId, rawBody, secret, now);

  const headers = {
    'X-CWIDS-DELIVERY-ID': deliveryId,
    'X-CWIDS-SIGNATURE': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody,
    signingSecret: secret,
    currentTimestamp: now,
  });

  assert.equal(result.isValid, true);
  assert.equal(result.deliveryId, deliveryId);
});

test('verifyCwidsWebhook: rejects tampered payload', () => {
  const secret = 'test_secret_abc123';
  const deliveryId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const originalBody = '{"amount":1000}';
  const signature = generateOutboundSignature(deliveryId, originalBody, secret, now);

  const headers = {
    'x-cwids-delivery-id': deliveryId,
    'x-cwids-signature': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody: '{"amount":9999}', // Tampered!
    signingSecret: secret,
    currentTimestamp: now,
  });

  assert.equal(result.isValid, false);
  assert.ok(result.failureReason?.includes('Cryptographic HMAC-SHA256 signature mismatch'));
});

test('verifyCwidsWebhook: rejects tampered deliveryId', () => {
  const secret = 'test_secret_abc123';
  const originalDeliveryId = crypto.randomUUID();
  const tamperedDeliveryId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const rawBody = '{"test":true}';
  const signature = generateOutboundSignature(originalDeliveryId, rawBody, secret, now);

  const headers = {
    'x-cwids-delivery-id': tamperedDeliveryId,
    'x-cwids-signature': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody,
    signingSecret: secret,
    currentTimestamp: now,
  });

  assert.equal(result.isValid, false);
  assert.ok(result.failureReason?.includes('Cryptographic HMAC-SHA256 signature mismatch'));
});

test('verifyCwidsWebhook: rejects stale timestamp (> 300s in the past)', () => {
  const secret = 'test_secret_abc123';
  const deliveryId = crypto.randomUUID();
  const pastTimestamp = 1000;
  const currentTimestamp = 1301; // 301 seconds later (tolerance is 300s)
  const rawBody = '{"test":true}';
  const signature = generateOutboundSignature(deliveryId, rawBody, secret, pastTimestamp);

  const headers = {
    'x-cwids-delivery-id': deliveryId,
    'x-cwids-signature': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody,
    signingSecret: secret,
    currentTimestamp,
    toleranceSeconds: 300,
  });

  assert.equal(result.isValid, false);
  assert.ok(result.failureReason?.includes('clock drift'));
});

test('verifyCwidsWebhook: rejects future timestamp (> 300s in the future)', () => {
  const secret = 'test_secret_abc123';
  const deliveryId = crypto.randomUUID();
  const futureTimestamp = 2000;
  const currentTimestamp = 1600; // 400 seconds earlier
  const rawBody = '{"test":true}';
  const signature = generateOutboundSignature(deliveryId, rawBody, secret, futureTimestamp);

  const headers = {
    'x-cwids-delivery-id': deliveryId,
    'x-cwids-signature': signature,
  };

  const result = verifyCwidsWebhook({
    headers,
    rawBody,
    signingSecret: secret,
    currentTimestamp,
    toleranceSeconds: 300,
  });

  assert.equal(result.isValid, false);
  assert.ok(result.failureReason?.includes('clock drift'));
});

test('verifyCwidsWebhook: rejects missing headers and incorrect secrets', () => {
  const rawBody = '{"test":true}';

  // Missing secret
  // @ts-ignore
  assert.equal(verifyCwidsWebhook({ headers: {}, rawBody, signingSecret: null }).isValid, false);

  // Missing deliveryId
  assert.equal(verifyCwidsWebhook({ headers: {}, rawBody, signingSecret: 'secret' }).isValid, false);

  // Missing signature
  assert.equal(verifyCwidsWebhook({ headers: { 'x-cwids-delivery-id': 'del-1' }, rawBody, signingSecret: 'secret' }).isValid, false);

  // Malformed signature
  assert.equal(verifyCwidsWebhook({
    headers: { 'x-cwids-delivery-id': 'del-1', 'x-cwids-signature': 'not_valid_format' },
    rawBody,
    signingSecret: 'secret',
  }).isValid, false);
});
