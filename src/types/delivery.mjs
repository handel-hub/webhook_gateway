/**
 * CWIDS Outbound Delivery, Claiming, and Retry Contracts.
 */

/**
 * State machine status of an outbound webhook delivery.
 * @typedef {'pending' | 'in_flight' | 'retry_scheduled' | 'delivered' | 'dead_lettered' | 'cancelled'} DeliveryStatus
 */

/**
 * Claimed delivery job leased to an active worker thread.
 * @typedef {object} DeliveryClaim
 * @property {string} deliveryId - Delivery UUID.
 * @property {string} eventId - Webhook event UUID.
 * @property {string} applicationId - Application UUID.
 * @property {string} destinationEndpointId - Active endpoint UUID.
 * @property {number} attemptCount - Prior attempt count.
 * @property {number} fencingToken - Monotonically incremented fencing generation token.
 * @property {Date | null} firstAttemptAt - Timestamp of first attempt.
 * @property {Date} leaseExpiresAt - Database lease expiration timestamp.
 * @property {string} [epochId] - Current delivery epoch UUID.
 * @property {number} [epochAttemptCount] - Attempt count within current epoch.
 * @property {number} [redriveCount] - Number of times redriven.
 * @property {Date} [horizonStartedAt] - Epoch start timestamp for 72h window.
 */

/**
 * Parsed disposition from destination endpoint JSON response.
 * @typedef {'processed' | 'duplicate_acknowledged' | 'rejected' | 'http_acknowledged_unverified'} DestinationResponseStatus
 */

/**
 * Result of executing an outbound HTTPS delivery attempt.
 * @typedef {object} DeliveryAttemptResult
 * @property {number} httpStatus - HTTP response status code (e.g. 200, 500).
 * @property {DestinationResponseStatus} responseStatus - Parsed destination status.
 * @property {string} responseExcerpt - Capped response excerpt (max 2,048 bytes).
 * @property {boolean} isTruncated - Whether response exceeded 2KB and was severed.
 * @property {number} durationMs - Socket elapsed duration in milliseconds.
 * @property {string | null} errorCode - System error code (e.g. 'ETIMEDOUT', 'ECONNRESET').
 * @property {string | null} errorMessage - Safe error description.
 */

/**
 * Evaluated retry decision computed by the retry policy engine.
 * @typedef {object} RetryDecision
 * @property {boolean} shouldRetry - True if failure is classified as retryable.
 * @property {Date | null} nextAttemptAt - Scheduled timestamp for next attempt.
 * @property {boolean} isDeadLetter - True if 72-hour horizon or retries are exhausted.
 * @property {string | null} terminalReason - Reason code if transitioning to dead_lettered.
 */

/**
 * Database record for cwids.event_deliveries.
 * @typedef {object} EventDeliveryRecord
 * @property {string} id - UUID
 * @property {string} event_id - UUID
 * @property {string} application_id - UUID
 * @property {string} destination_endpoint_id - UUID
 * @property {DeliveryStatus} status
 * @property {number} attempt_count
 * @property {number} fencing_token
 * @property {Date | null} first_attempt_at
 * @property {Date | null} last_attempt_at
 * @property {Date} next_attempt_at
 * @property {string | null} leased_by
 * @property {Date | null} lease_expires_at
 * @property {Date | null} delivered_at
 * @property {Date | null} dead_lettered_at
 * @property {string | null} terminal_reason
 * @property {string} [epoch_id]
 * @property {number} [epoch_attempt_count]
 * @property {number} [redrive_count]
 * @property {Date} [horizon_started_at]
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * Database record for cwids.delivery_attempts.
 * @typedef {object} DeliveryAttemptRecord
 * @property {string} id - UUID
 * @property {string} delivery_id - UUID
 * @property {number} attempt_number
 * @property {number} fencing_token
 * @property {string} target_url
 * @property {number} http_status
 * @property {DestinationResponseStatus} response_status
 * @property {string} response_excerpt
 * @property {boolean} is_truncated
 * @property {number} duration_ms
 * @property {string | null} error_code
 * @property {string | null} error_message
 * @property {Date} attempted_at
 */

export {};
