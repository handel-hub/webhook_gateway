import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePart } from '../../src/providers/base-adapter.mjs';
import { FlutterwaveAdapter } from '../../src/providers/flutterwave/adapter.mjs';
import { PaystackAdapter } from '../../src/providers/paystack/adapter.mjs';

test('encodePart handles null, undefined, numbers, and strings safely', () => {
  assert.equal(encodePart(null), '0:');
  assert.equal(encodePart(undefined), '0:');
  assert.equal(encodePart('hello'), '5:hello');
  assert.equal(encodePart(12345), '5:12345');
  assert.equal(encodePart(''), '0:');
});

test('encodePart measures UTF-8 byte length accurately for multi-byte characters', () => {
  // '✨' is 3 or 4 bytes in UTF-8 (4 bytes)
  const emoji = '✨';
  const expectedByteLength = Buffer.byteLength(emoji, 'utf8');
  assert.equal(encodePart(emoji), `${expectedByteLength}:${emoji}`);
});

test('Delimiter collision attack resistance: colons in IDs cannot spoof adjacent fields', () => {
  // Scenario 1: Attacker sends ID "ord:1" with event "complete"
  // Scenario 2: Attacker sends ID "ord" with event "1:complete"
  const flwKey1 = FlutterwaveAdapter.generateDedupeKey({
    event: 'complete',
    data: { tx_ref: 'ord:1' },
  });
  const flwKey2 = FlutterwaveAdapter.generateDedupeKey({
    event: '1:complete',
    data: { tx_ref: 'ord' },
  });

  assert.notEqual(flwKey1, flwKey2);

  const pstkKey1 = PaystackAdapter.generateDedupeKey({
    event: 'success',
    data: { reference: 'ref:foo' },
  });
  const pstkKey2 = PaystackAdapter.generateDedupeKey({
    event: 'foo:success',
    data: { reference: 'ref' },
  });

  assert.notEqual(pstkKey1, pstkKey2);
});

test('Collision fuzzing with random punctuation and prefixes', () => {
  const generatedKeys = new Set();
  const testCases = [
    { ref: 'a', ev: 'b:c' },
    { ref: 'a:b', ev: 'c' },
    { ref: 'a::b', ev: 'c' },
    { ref: 'a', ev: ':b:c' },
    { ref: ':::a', ev: 'b' },
    { ref: '', ev: 'a:b' },
    { ref: 'a:b', ev: '' },
    { ref: '0:', ev: 'test' },
    { ref: 'test', ev: '0:' },
  ];

  for (const tc of testCases) {
    const key = FlutterwaveAdapter.generateDedupeKey({
      event: tc.ev,
      data: { tx_ref: tc.ref },
    });
    assert.ok(!generatedKeys.has(key), `Key collision detected for ${JSON.stringify(tc)}: ${key}`);
    generatedKeys.add(key);
  }
});
