import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PaystackAdapter } from '../../src/providers/paystack/adapter.mjs';

const PAYSTACK_SECRET = 'sk_test_paystack_secret_key_9988';
const SAMPLE_PAYLOAD = {
  event: 'charge.success',
  data: {
    id: 11223344,
    reference: 'REF-PAY-98765',
    amount: 2500000, // 25,000 NGN in kobo
    currency: 'NGN',
    status: 'success',
    dedicated_account_number: '9988776655',
  },
};
const RAW_BODY = Buffer.from(JSON.stringify(SAMPLE_PAYLOAD));

test('PaystackAdapter: verifies authentic HMAC-SHA512 signature', async () => {
  const signature = crypto.createHmac('sha512', PAYSTACK_SECRET).update(RAW_BODY).digest('hex');

  const result = await PaystackAdapter.verifyAndNormalize(
    RAW_BODY,
    { 'x-paystack-signature': signature },
    PAYSTACK_SECRET,
  );

  assert.equal(result.isValid, true);
  assert.equal(result.failureReason, null);
  assert.ok(result.dedupeKey.startsWith('v1:pstk:'));
  assert.ok(result.normalized);
  assert.equal(result.normalized.eventType, 'charge.success');
  assert.equal(result.normalized.merchantReference, 'REF-PAY-98765');
  assert.equal(result.normalized.providerReference, '11223344');
  assert.equal(result.normalized.virtualAccountId, '9988776655');
  assert.ok(result.normalized.rawData);
});

test('PaystackAdapter: rejects tampered signature', async () => {
  const result = await PaystackAdapter.verifyAndNormalize(
    RAW_BODY,
    { 'x-paystack-signature': 'invalid_signature_hex_digest' },
    PAYSTACK_SECRET,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.failureReason, 'Invalid Paystack HMAC-SHA512 signature.');
  assert.equal(result.normalized, null);
});

test('PaystackAdapter: rejects missing x-paystack-signature header', async () => {
  const result = await PaystackAdapter.verifyAndNormalize(
    RAW_BODY,
    {},
    PAYSTACK_SECRET,
  );

  assert.equal(result.isValid, false);
  assert.equal(result.failureReason, 'Missing x-paystack-signature header.');
});

test('PaystackAdapter: length-prefixed dedupe keys avoid collision', () => {
  const key1 = PaystackAdapter.generateDedupeKey({
    event: 'charge:success',
    data: { reference: 'foo' },
  });
  const key2 = PaystackAdapter.generateDedupeKey({
    event: 'success',
    data: { reference: 'foo:charge' },
  });

  assert.notEqual(key1, key2);
});

test('PaystackAdapter: authentic signature with malformed JSON returns isMalformed = true', async () => {
  const malformedBody = Buffer.from('{"not_valid_json:');
  const signature = crypto.createHmac('sha512', PAYSTACK_SECRET).update(malformedBody).digest('hex');

  const result = await PaystackAdapter.verifyAndNormalize(
    malformedBody,
    { 'x-paystack-signature': signature },
    PAYSTACK_SECRET,
  );

  assert.equal(result.isValid, true);
  assert.equal(result.isMalformed, true);
  assert.equal(result.failureReason, 'Malformed JSON payload.');
  assert.ok(result.dedupeKey.startsWith('v1:pstk:malformed:'));
  assert.equal(result.normalized, null);
});
