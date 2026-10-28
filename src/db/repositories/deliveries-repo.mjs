import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/delivery.mjs').EventDeliveryRecord} EventDeliveryRecord
 * @typedef {import('../../types/delivery.mjs').DeliveryClaim} DeliveryClaim
 */

export const DeliveriesRepo = {
  /**
   * Retrieves a delivery by its primary UUID.
   * @param {pg.PoolClient} client
   * @param {string} id
   * @returns {Promise<EventDeliveryRecord | null>}
   */
  async findById(client, id) {
    const res = await client.query(
      `SELECT id, event_id, application_id, destination_endpoint_id, status,
              attempt_count, fencing_token, first_attempt_at, last_attempt_at,
              next_attempt_at, claimed_by_worker as leased_by, lease_expires_at,
              delivered_at, dead_lettered_at, terminal_reason, created_at, updated_at
       FROM cwids.event_deliveries
       WHERE id = $1`,
      [id],
    );
    /** @type {EventDeliveryRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Redrives a dead-lettered delivery back to pending status, incrementing fencing token.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @returns {Promise<{ id: string, event_id: string, application_id: string, destination_endpoint_id: string, status: string, attempt_count: number, fencing_token: number, next_attempt_at: Date } | null>}
   */
  async redriveDelivery(client, deliveryId) {
    const res = await client.query(
      `UPDATE cwids.event_deliveries
       SET status = 'pending',
           fencing_token = fencing_token + 1,
           next_attempt_at = CURRENT_TIMESTAMP,
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'dead_lettered'
       RETURNING id, event_id, application_id, destination_endpoint_id, status,
                 attempt_count, fencing_token, next_attempt_at`,
      [deliveryId],
    );
    return res.rows[0] ?? null;
  },

  /**
   * Inserts an initial delivery record for a resolved event.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   eventId: string,
   *   applicationId: string,
   *   destinationEndpointId: string
   * }} data
   * @returns {Promise<EventDeliveryRecord>}
   */
  async insertDelivery(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.event_deliveries
         (id, event_id, application_id, destination_endpoint_id, status, next_attempt_at)
       VALUES
         (COALESCE($1, gen_random_uuid()), $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
       RETURNING id, event_id, application_id, destination_endpoint_id, status,
                 attempt_count, fencing_token, first_attempt_at, last_attempt_at,
                 next_attempt_at, claimed_by_worker as leased_by, lease_expires_at,
                 delivered_at, dead_lettered_at, terminal_reason, created_at, updated_at`,
      [data.id ?? null, data.eventId, data.applicationId, data.destinationEndpointId],
    );
    /** @type {EventDeliveryRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to insert event delivery record.');
    }
    return row;
  },

  /**
   * Claims a batch of claimable deliveries using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Joins circuit_breaker_states to skip destination endpoints whose circuit is open.
   * Increments the monotonic fencing_token.
   *
   * @param {pg.PoolClient} client
   * @param {number} batchSize - Maximum deliveries to claim.
   * @param {number} leaseSeconds - Duration of lease in seconds.
   * @param {string} workerIdentity - Unique worker instance identifier.
   * @returns {Promise<DeliveryClaim[]>}
   */
  async claimBatch(client, batchSize, leaseSeconds, workerIdentity) {
    const res = await client.query(
      `WITH claimable AS (
         SELECT ed.id
         FROM cwids.event_deliveries ed
         LEFT JOIN cwids.circuit_breaker_states cb ON ed.destination_endpoint_id = cb.destination_endpoint_id
         WHERE ed.status IN ('pending', 'retry_scheduled')
           AND ed.next_attempt_at <= CURRENT_TIMESTAMP
           AND (cb.state IS NULL OR cb.state != 'open')
         ORDER BY ed.next_attempt_at ASC
         LIMIT $1
         FOR UPDATE OF ed SKIP LOCKED
       )
       UPDATE cwids.event_deliveries target
       SET status = 'in_flight',
           lease_expires_at = CURRENT_TIMESTAMP + ($2 || ' seconds')::interval,
           fencing_token = target.fencing_token + 1,
           claimed_by_worker = $3,
           updated_at = CURRENT_TIMESTAMP
       FROM claimable
       WHERE target.id = claimable.id
       RETURNING
         target.id as "deliveryId",
         target.event_id as "eventId",
         target.application_id as "applicationId",
         target.destination_endpoint_id as "destinationEndpointId",
         target.attempt_count as "attemptCount",
         target.fencing_token as "fencingToken",
         target.first_attempt_at as "firstAttemptAt",
         target.lease_expires_at as "leaseExpiresAt"`,
      [batchSize, leaseSeconds, workerIdentity],
    );
    /** @type {DeliveryClaim[]} */
    return res.rows;
  },

  /**
   * Completes a delivery with success, enforcing monotonic fencing token match.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @returns {Promise<boolean>} True if row updated, false if lease was stolen/preempted.
   */
  async completeDelivery(client, deliveryId, fencingToken) {
    const res = await client.query(
      `UPDATE cwids.event_deliveries
       SET status = 'delivered',
           delivered_at = CURRENT_TIMESTAMP,
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND fencing_token = $2 AND status = 'in_flight'`,
      [deliveryId, fencingToken],
    );
    return (res.rowCount ?? 0) === 1;
  },

  /**
   * Schedules a retry attempt with updated backoff, enforcing fencing token match.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @param {Date} nextAttemptAt
   * @param {number | null} httpStatus
   * @param {string | null} errorCode
   * @returns {Promise<boolean>}
   */
  async scheduleRetry(client, deliveryId, fencingToken, nextAttemptAt, httpStatus, errorCode) {
    const res = await client.query(
      `UPDATE cwids.event_deliveries
       SET status = 'retry_scheduled',
           next_attempt_at = $3,
           attempt_count = attempt_count + 1,
           last_http_status = $4,
           last_error_code = $5,
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND fencing_token = $2 AND status = 'in_flight'`,
      [deliveryId, fencingToken, nextAttemptAt, httpStatus, errorCode],
    );
    return (res.rowCount ?? 0) === 1;
  },

  /**
   * Transitions delivery to terminal dead_lettered state upon exhaustion or non-retryable error.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @param {string} terminalReason
   * @param {number | null} httpStatus
   * @param {string | null} errorCode
   * @returns {Promise<boolean>}
   */
  async deadLetterDelivery(client, deliveryId, fencingToken, terminalReason, httpStatus, errorCode) {
    const res = await client.query(
      `UPDATE cwids.event_deliveries
       SET status = 'dead_lettered',
           terminal_reason = $3,
           last_http_status = $4,
           last_error_code = $5,
           dead_lettered_at = CURRENT_TIMESTAMP,
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND fencing_token = $2 AND status = 'in_flight'`,
      [deliveryId, fencingToken, terminalReason, httpStatus, errorCode],
    );
    return (res.rowCount ?? 0) === 1;
  },

  /**
   * Sweeps expired in-flight leases and transitions them back to retry_scheduled.
   * @param {pg.PoolClient} client
   * @returns {Promise<number>} Number of recovered deliveries.
   */
  async recoverExpiredLeases(client) {
    const res = await client.query(
      `UPDATE cwids.event_deliveries
       SET status = 'retry_scheduled',
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'in_flight'
         AND lease_expires_at < CURRENT_TIMESTAMP`,
    );
    return res.rowCount ?? 0;
  },
};
