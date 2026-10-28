import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { evaluateRetry } from '../../src/delivery/retry-policy.mjs';
import { encodePart } from '../../src/providers/base-adapter.mjs';
import { LIMITS } from '../../src/config/limits.mjs';

test('Property Invariant 1: Exponential backoff with full jitter across 10,000 random evaluations satisfies all bounds', () => {
  const maxDelayCeilingWithJitter = LIMITS.MAX_BACKOFF_DELAY_MS * 1.25;

  for (let i = 0; i < 10000; i++) {
    const attemptCount = Math.floor(Math.random() * 15);
    const firstAttemptOffsetMs = Math.floor(Math.random() * (LIMITS.MAX_RETRY_HORIZON_MS - 60000));
    const firstAttemptAt = new Date(Date.now() - firstAttemptOffsetMs);

    const decision = evaluateRetry({
      firstAttemptAt,
      attemptCount,
      httpStatus: 500,
    });

    if (decision.shouldRetry) {
      assert.ok(decision.nextAttemptAt);
      const delay = decision.nextAttemptAt.getTime() - Date.now();

      // Lower bound invariant
      assert.ok(delay >= 1000, `Delay ${delay} was below minimum 1000ms`);

      // Upper bound invariant (2 hours + max 20% jitter)
      assert.ok(delay <= maxDelayCeilingWithJitter, `Delay ${delay} exceeded maximum 2h cap`);

      // Horizon invariant: next attempt must never exceed 72h from firstAttemptAt
      const scheduledAbsolute = decision.nextAttemptAt.getTime();
      const horizonCutoff = firstAttemptAt.getTime() + LIMITS.MAX_RETRY_HORIZON_MS;
      assert.ok(
        scheduledAbsolute <= horizonCutoff,
        `Scheduled attempt ${scheduledAbsolute} exceeded horizon cutoff ${horizonCutoff}`,
      );
    } else {
      assert.equal(decision.isDeadLetter, true);
      assert.notEqual(decision.terminalReason, null);
    }
  }
});

test('Property Invariant 2: Delimiter-free length-prefixed encoding is injective across 10,000 randomized tuples', () => {
  /** @type {Set<string>} */
  const seenEncodings = new Set();
  /** @type {Set<string>} */
  const seenInputs = new Set();

  for (let i = 0; i < 10000; i++) {
    // Generate random strings with colons, numbers, and special characters
    const part1 = crypto.randomBytes(Math.floor(Math.random() * 8) + 1).toString('hex') + (i % 2 === 0 ? ':' : '');
    const part2 = crypto.randomBytes(Math.floor(Math.random() * 8) + 1).toString('hex') + (i % 3 === 0 ? '::' : '');

    const inputKey = `${part1}#-#${part2}`;
    const encoded = `${encodePart(part1)}:${encodePart(part2)}`;

    if (seenInputs.has(inputKey)) {
      continue;
    }
    seenInputs.add(inputKey);

    // If encoded already exists for a different input, delimiter collision has occurred!
    assert.equal(
      seenEncodings.has(encoded),
      false,
      `Collision detected! Different inputs generated same encoding: ${encoded}`,
    );
    seenEncodings.add(encoded);
  }
});
