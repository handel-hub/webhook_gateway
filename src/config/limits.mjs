/**
 * CWIDS System Limits and Boundary Constants.
 * Frozen to prevent accidental runtime mutations.
 */
export const LIMITS = Object.freeze({
  /** Maximum allowable raw webhook payload size (1 MB). */
  MAX_RAW_BODY_BYTES: 1024 * 1024,

  /** Maximum outbound HTTP response excerpt retained in attempts table (2 KB). */
  MAX_RESPONSE_EXCERPT_BYTES: 2048,

  /** Absolute retry cutoff horizon for payment-critical deliveries (72 hours). */
  MAX_RETRY_HORIZON_MS: 72 * 60 * 60 * 1000,

  /** Maximum exponential backoff delay ceiling between individual attempts (2 hours). */
  MAX_BACKOFF_DELAY_MS: 2 * 60 * 60 * 1000,

  /** Initial delay for delivery retries in seconds. */
  DEFAULT_INITIAL_BACKOFF_SECONDS: 30,

  /** Exponential backoff progression multiplier. */
  DEFAULT_BACKOFF_MULTIPLIER: 2.0,

  /** Full jitter randomization ratio (0.0 to 1.0). */
  DEFAULT_BACKOFF_JITTER_RATIO: 0.2,

  /** Default distributed worker lease duration in milliseconds (30 seconds). */
  DEFAULT_LEASE_DURATION_MS: 30 * 1000,

  /** Default outbound HTTP dispatch socket timeout in milliseconds (15 seconds). */
  HTTP_DISPATCH_TIMEOUT_MS: 15 * 1000,

  /** Connection-time DNS resolution timeout in milliseconds (3 seconds). */
  DNS_LOOKUP_TIMEOUT_MS: 3000,

  /** Consecutive failure threshold required to trip destination circuit breaker to OPEN. */
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,

  /** Sliding failure evaluation window for circuit breaker in milliseconds (60 seconds). */
  CIRCUIT_BREAKER_WINDOW_MS: 60 * 1000,

  /** Cooldown duration before circuit breaker transitions from OPEN to HALF-OPEN (120 seconds). */
  CIRCUIT_BREAKER_COOLDOWN_MS: 120 * 1000,

  /** Grace period for retaining expired payment intents before batch pruning (7 days). */
  INTENT_EXPIRY_GRACE_PERIOD_MS: 7 * 24 * 60 * 60 * 1000,

  /** Maximum deliveries claimed per worker poll cycle. */
  BATCH_CLAIM_LIMIT: 50,

  /** Maximum rows deleted per retention/cleanup batch transaction. */
  CLEANUP_BATCH_LIMIT: 1000,
});
