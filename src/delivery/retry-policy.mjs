import { LIMITS } from '../config/limits.mjs';

/**
 * @typedef {import('../types/delivery.mjs').RetryDecision} RetryDecision
 */

/**
 * Classifies an HTTP status code or network error code to determine retry eligibility.
 *
 * @param {number} httpStatus
 * @param {string | null} [errorCode]
 * @returns {boolean} True if failure is classified as transient / retryable.
 */
export function isRetryableFailure(httpStatus, errorCode = null) {
  // Network and socket errors are always retryable
  if (errorCode && errorCode !== 'NONE') {
    return true;
  }

  // HTTP 429 (Rate Limited) and HTTP 408 (Request Timeout) are transient
  if (httpStatus === 429 || httpStatus === 408) {
    return true;
  }

  // 5xx Server Errors (500, 502, 503, 504) are transient
  if (httpStatus >= 500 && httpStatus <= 599) {
    return true;
  }

  // 4xx Client Errors (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404, 422) are non-retryable
  return false;
}

/**
 * Computes retry decision using 72-hour exponential backoff with full jitter (ADR-08).
 *
 * @param {object} params
 * @param {Date | null} [params.firstAttemptAt] - Timestamp when the delivery was first attempted.
 * @param {Date | null} [params.horizonStartedAt] - Timestamp when current 72h epoch started.
 * @param {number} params.attemptCount - Number of prior attempts made.
 * @param {number} [params.epochAttemptCount] - Prior attempts within current epoch.
 * @param {number} params.httpStatus - Last HTTP status code returned.
 * @param {string | null} [params.errorCode=null] - System error code if socket failed.
 * @param {number} [params.maxRetries=50] - Maximum permitted attempt count.
 * @param {number} [params.initialDelayMs=30000] - Base delay in milliseconds (30s).
 * @param {number} [params.maxDelayMs=7200000] - Maximum delay ceiling (2 hours).
 * @param {number} [params.horizonMs=259200000] - Absolute cutoff horizon (72 hours).
 * @returns {RetryDecision}
 */
export function evaluateRetry({
  firstAttemptAt = null,
  horizonStartedAt = null,
  attemptCount,
  epochAttemptCount,
  httpStatus,
  errorCode = null,
  maxRetries = 50,
  initialDelayMs = LIMITS.DEFAULT_INITIAL_BACKOFF_SECONDS * 1000,
  maxDelayMs = LIMITS.MAX_BACKOFF_DELAY_MS,
  horizonMs = LIMITS.MAX_RETRY_HORIZON_MS,
}) {
  const retryable = isRetryableFailure(httpStatus, errorCode);

  // If destination explicitly rejected with non-retryable 4xx
  if (!retryable) {
    return {
      shouldRetry: false,
      nextAttemptAt: null,
      isDeadLetter: true,
      terminalReason: httpStatus >= 400 && httpStatus < 500 ? 'CLIENT_REJECTED' : 'UNRETRYABLE_ERROR',
    };
  }

  const effectiveAttemptCount = epochAttemptCount ?? attemptCount;

  // Max retry count exhausted
  if (effectiveAttemptCount >= maxRetries) {
    return {
      shouldRetry: false,
      nextAttemptAt: null,
      isDeadLetter: true,
      terminalReason: 'MAX_RETRIES_EXCEEDED',
    };
  }

  const now = Date.now();
  const baselineTime = horizonStartedAt
    ? new Date(horizonStartedAt).getTime()
    : firstAttemptAt
      ? new Date(firstAttemptAt).getTime()
      : now;
  const horizonCutoff = baselineTime + horizonMs;

  if (now >= horizonCutoff) {
    return {
      shouldRetry: false,
      nextAttemptAt: null,
      isDeadLetter: true,
      terminalReason: 'HORIZON_EXHAUSTED',
    };
  }

  // Calculate exponential delay: initialDelay * 2^effectiveAttemptCount
  const rawDelay = initialDelayMs * Math.pow(LIMITS.DEFAULT_BACKOFF_MULTIPLIER, effectiveAttemptCount);
  const cappedDelay = Math.min(rawDelay, maxDelayMs);

  // Apply jitter: ±20% randomization with 5s floor (1s if delay < 5s)
  const jitterRange = cappedDelay * LIMITS.DEFAULT_BACKOFF_JITTER_RATIO;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  const minFloor = cappedDelay < 5000 ? 1000 : 5000;
  const jitteredDelayMs = Math.max(minFloor, Math.round(cappedDelay + jitter));

  const scheduledNextAttempt = now + jitteredDelayMs;

  // Check 72-hour absolute cutoff horizon
  if (scheduledNextAttempt >= horizonCutoff || now >= horizonCutoff) {
    return {
      shouldRetry: false,
      nextAttemptAt: null,
      isDeadLetter: true,
      terminalReason: 'HORIZON_EXHAUSTED',
    };
  }

  return {
    shouldRetry: true,
    nextAttemptAt: new Date(scheduledNextAttempt),
    isDeadLetter: false,
    terminalReason: null,
  };
}
