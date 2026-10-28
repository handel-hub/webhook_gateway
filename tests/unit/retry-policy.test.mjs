import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableFailure, evaluateRetry } from '../../src/delivery/retry-policy.mjs';
import { LIMITS } from '../../src/config/limits.mjs';

test('isRetryableFailure: classifies HTTP status and network error codes correctly', () => {
  // Network / socket errors
  assert.equal(isRetryableFailure(0, 'ECONNREFUSED'), true);
  assert.equal(isRetryableFailure(0, 'ETIMEDOUT'), true);
  assert.equal(isRetryableFailure(0, 'ENOTFOUND'), true);
  assert.equal(isRetryableFailure(0, 'EAI_AGAIN'), true);

  // Transient HTTP errors
  assert.equal(isRetryableFailure(429, null), true); // Rate Limited
  assert.equal(isRetryableFailure(408, null), true); // Request Timeout
  assert.equal(isRetryableFailure(500, null), true); // Internal Server Error
  assert.equal(isRetryableFailure(502, null), true); // Bad Gateway
  assert.equal(isRetryableFailure(503, null), true); // Service Unavailable
  assert.equal(isRetryableFailure(504, null), true); // Gateway Timeout

  // Non-retryable HTTP 4xx Client Errors
  assert.equal(isRetryableFailure(400, null), false);
  assert.equal(isRetryableFailure(401, null), false);
  assert.equal(isRetryableFailure(403, null), false);
  assert.equal(isRetryableFailure(404, null), false);
  assert.equal(isRetryableFailure(422, null), false);

  // Successful 2xx should not be retried
  assert.equal(isRetryableFailure(200, null), false);
  assert.equal(isRetryableFailure(201, null), false);
  assert.equal(isRetryableFailure(204, null), false);
});

test('evaluateRetry: non-retryable 4xx dead-letters immediately as CLIENT_REJECTED', () => {
  const result = evaluateRetry({
    firstAttemptAt: new Date(),
    attemptCount: 1,
    httpStatus: 400,
    errorCode: null,
  });

  assert.equal(result.shouldRetry, false);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.isDeadLetter, true);
  assert.equal(result.terminalReason, 'CLIENT_REJECTED');
});

test('evaluateRetry: 408 and 429 schedule retry with exponential backoff and jitter', () => {
  const now = new Date();
  const res429 = evaluateRetry({
    firstAttemptAt: now,
    attemptCount: 1,
    httpStatus: 429,
    errorCode: null,
  });

  assert.equal(res429.shouldRetry, true);
  assert.notEqual(res429.nextAttemptAt, null);
  assert.equal(res429.isDeadLetter, false);
  assert.equal(res429.terminalReason, null);

  const res408 = evaluateRetry({
    firstAttemptAt: now,
    attemptCount: 2,
    httpStatus: 408,
    errorCode: null,
  });

  assert.equal(res408.shouldRetry, true);
  assert.notEqual(res408.nextAttemptAt, null);
  assert.equal(res408.isDeadLetter, false);
});

test('evaluateRetry: 5xx server errors and network drops schedule retries', () => {
  const now = new Date();
  const res503 = evaluateRetry({
    firstAttemptAt: now,
    attemptCount: 1,
    httpStatus: 503,
  });
  assert.equal(res503.shouldRetry, true);

  const resNet = evaluateRetry({
    firstAttemptAt: now,
    attemptCount: 2,
    httpStatus: 0,
    errorCode: 'ECONNRESET',
  });
  assert.equal(resNet.shouldRetry, true);
});

test('evaluateRetry: delay caps at MAX_BACKOFF_DELAY_MS (2 hours)', () => {
  const now = Date.now();
  // Attempt 14 with initial 30s would be 30000 * 2^14 = 491,520,000ms (~136 hours) without cap
  const result = evaluateRetry({
    firstAttemptAt: new Date(now),
    attemptCount: 14,
    httpStatus: 500,
    errorCode: null,
    maxRetries: 20,
    horizonMs: 1000 * 3600 * 24 * 30, // Large horizon for this test
  });

  assert.equal(result.shouldRetry, true);
  assert.ok(result.nextAttemptAt);
  const scheduledTime = result.nextAttemptAt.getTime();
  const delay = scheduledTime - now;

  // Max cap is 2 hours (7,200,000 ms) with ±20% jitter (range: 5,760,000 to 8,640,000)
  const maxCeilingWithJitter = LIMITS.MAX_BACKOFF_DELAY_MS * 1.25;
  const minFloorWithJitter = LIMITS.MAX_BACKOFF_DELAY_MS * 0.75;
  assert.ok(delay <= maxCeilingWithJitter, `Delay ${delay} exceeded max cap with jitter`);
  assert.ok(delay >= minFloorWithJitter, `Delay ${delay} was below min cap with jitter`);
});

test('evaluateRetry: transitions to dead_lettered when max retries exceeded', () => {
  const result = evaluateRetry({
    firstAttemptAt: new Date(),
    attemptCount: 15,
    httpStatus: 500,
    maxRetries: 15,
  });

  assert.equal(result.shouldRetry, false);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.isDeadLetter, true);
  assert.equal(result.terminalReason, 'MAX_RETRIES_EXCEEDED');
});

test('evaluateRetry: transitions to dead_lettered when 72h horizon is exhausted', () => {
  // First attempt occurred 71 hours and 50 minutes ago
  const seventyTwoHoursMs = LIMITS.MAX_RETRY_HORIZON_MS;
  const firstAttemptAt = new Date(Date.now() - (seventyTwoHoursMs - 10000)); // 10 seconds before cutoff

  // Attempt count 5 would require at least 30s * 2^5 = 960s > 10s
  const result = evaluateRetry({
    firstAttemptAt,
    attemptCount: 5,
    httpStatus: 500,
  });

  assert.equal(result.shouldRetry, false);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.isDeadLetter, true);
  assert.equal(result.terminalReason, 'HORIZON_EXHAUSTED');
});
