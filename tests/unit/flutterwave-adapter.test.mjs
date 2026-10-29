import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FlutterwaveAdapter } from '../../src/providers/flutterwave/adapter.mjs';

const SECRET_HASH = 'flw_secret_verification_hash_123';
const SAMPLE_PAYLOAD = {
  event: 'charge.completed',
  data: {
    id: 998877,
    tx_ref: 'ORDER-12345',
    flw_ref: 'FLW-MOCK-9912',
    amount: 5000.5,
    currency: 'NGN',
    status: 'successful',
  },
};
const RAW_BODY = Buffer.from(JSON.stringify(SAMPLE_PAYLOAD));

test('FlutterwaveAdapter: verifies valid verif-hash header', async () => {
  const result = await FlutterwaveAdapter.verifyAndNormalize(
    RAW_BODY,
    { 'verif-hash': SECRET_HASH },
    SECRET_HASH,
  );

  assert.equal(result.isValid, true);
  assert.equal(result.failureReason, null);
  assert.ok(result.dedupeKey.startsWith('v1:flw:'));
  assert.ok(result.normalized);
  assert.equal(result.normalized.eventType, 'charge.completed');
  assert.equal(result.normalized.merchantReference, 'ORDER-12345');
  assert.equal(result.normalized.providerReference, '998877');
  assert.equal(result.normalized.amountMinor, 500050); // 5000.50 * 100
  assert.equal(result.normalized.currency, 'NGN');
  assert.equal(result.normalized.providerStatus, 'successful');
});

test('FlutterwaveAdapter: verifies valid HMAC-SHA256 signature', async () => {
  const computedHmac = crypto.createHmac('sha256', SECRET_HASH).update(RAW_BODY).digest('hex');
  const result = await FlutterwaveAdapter.verifyAndNormalize(
    RAW_BODY,
    { 'x-flutterwave-signature': computedHmac },
    SECRET_HASH,
  );

  assert.equal(result.isValid, true);
  assert.ok(result.normalized);
});

test('FlutterwaveAdapter: rejects invalid signature', async () => {
  const result = await FlutterwaveAdapter.verifyAndNormalize(
    RAW_BODY,
    { 'verif-hash': 'wrong_hash' },
    SECRET_HASH,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.failureReason, 'Invalid Flutterwave cryptographic signature.');
  assert.equal(result.normalized, null);
});

test('FlutterwaveAdapter: rejects missing signature header', async () => {
  const result = await FlutterwaveAdapter.verifyAndNormalize(
    RAW_BODY,
    {},
    SECRET_HASH,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.failureReason, 'Missing Flutterwave signature header (verif-hash or x-flutterwave-signature).');
});

test('FlutterwaveAdapter: generates length-prefixed dedupe key immune to delimiter injection', () => {
  const key1 = FlutterwaveAdapter.generateDedupeKey({
    event: 'charge:completed',
    data: { tx_ref: 'a:b' },
  });
  const key2 = FlutterwaveAdapter.generateDedupeKey({
    event: 'completed',
    data: { tx_ref: 'a:b:charge' },
  });

  assert.notEqual(key1, key2);
});

test('FlutterwaveAdapter: authentic signature with malformed JSON returns isMalformed = true', async () => {
  const malformedBody = Buffer.from('{"invalid_json:');
  const result = await FlutterwaveAdapter.verifyAndNormalize(
    malformedBody,
    { 'verif-hash': SECRET_HASH },
    SECRET_HASH,
  );

  assert.equal(result.isValid, true);
  assert.equal(result.isMalformed, true);
  assert.equal(result.failureReason, 'Malformed JSON payload.');
  assert.ok(result.dedupeKey.startsWith('v1:flw:malformed:'));
  assert.equal(result.normalized, null);
});
