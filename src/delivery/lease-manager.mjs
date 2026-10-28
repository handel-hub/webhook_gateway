import pg from 'pg';
import { DeliveriesRepo } from '../db/repositories/deliveries-repo.mjs';
import { withTransaction, withClient } from '../db/transaction.mjs';
import { StaleFencingTokenError } from '../errors/base-error.mjs';
import { logger } from '../observability/logger.mjs';

/**
 * @typedef {import('../types/delivery.mjs').DeliveryClaim} DeliveryClaim
 */

export const LeaseManager = {
  /**
   * Claims a batch of deliveries from PostgreSQL using FOR UPDATE SKIP LOCKED.
   * Monotonically increments fencing_token and sets lease_expires_at via database time.
   *
   * @param {pg.Pool} pool
   * @param {number} batchSize
   * @param {number} leaseSeconds
   * @param {string} workerIdentity
   * @returns {Promise<DeliveryClaim[]>}
   */
  async claimBatch(pool, batchSize, leaseSeconds, workerIdentity) {
    return withTransaction(pool, null, async (client) => {
      return DeliveriesRepo.claimBatch(client, batchSize, leaseSeconds, workerIdentity);
    });
  },

  /**
   * Finalizes a successful delivery attempt with monotonic fencing token guard.
   * If row count is 0, the worker's lease was stolen/preempted by another worker.
   *
   * @param {pg.PoolClient} client - In-transaction client.
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @returns {Promise<void>}
   */
  async completeFenced(client, deliveryId, fencingToken) {
    const updated = await DeliveriesRepo.completeDelivery(client, deliveryId, fencingToken);
    if (!updated) {
      // Query current token to provide detailed diagnostic
      const currentRes = await client.query(
        'SELECT fencing_token FROM cwids.event_deliveries WHERE id = $1',
        [deliveryId],
      );
      const currentToken = currentRes.rows[0]?.fencing_token ?? -1;
      throw new StaleFencingTokenError(deliveryId, fencingToken, currentToken);
    }
  },

  /**
   * Updates delivery status to retry_scheduled with fencing token guard.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @param {Date} nextAttemptAt
   * @param {number | null} httpStatus
   * @param {string | null} errorCode
   * @returns {Promise<void>}
   */
  async retryFenced(client, deliveryId, fencingToken, nextAttemptAt, httpStatus, errorCode) {
    const updated = await DeliveriesRepo.scheduleRetry(
      client,
      deliveryId,
      fencingToken,
      nextAttemptAt,
      httpStatus,
      errorCode,
    );
    if (!updated) {
      const currentRes = await client.query(
        'SELECT fencing_token FROM cwids.event_deliveries WHERE id = $1',
        [deliveryId],
      );
      const currentToken = currentRes.rows[0]?.fencing_token ?? -1;
      throw new StaleFencingTokenError(deliveryId, fencingToken, currentToken);
    }
  },

  /**
   * Finalizes delivery as dead_lettered with fencing token guard.
   * @param {pg.PoolClient} client
   * @param {string} deliveryId
   * @param {number} fencingToken
   * @param {string} terminalReason
   * @param {number | null} httpStatus
   * @param {string | null} errorCode
   * @returns {Promise<void>}
   */
  async deadLetterFenced(client, deliveryId, fencingToken, terminalReason, httpStatus, errorCode) {
    const updated = await DeliveriesRepo.deadLetterDelivery(
      client,
      deliveryId,
      fencingToken,
      terminalReason,
      httpStatus,
      errorCode,
    );
    if (!updated) {
      const currentRes = await client.query(
        'SELECT fencing_token FROM cwids.event_deliveries WHERE id = $1',
        [deliveryId],
      );
      const currentToken = currentRes.rows[0]?.fencing_token ?? -1;
      throw new StaleFencingTokenError(deliveryId, fencingToken, currentToken);
    }
  },

  /**
   * Scans and recovers stranded in-flight deliveries whose lease expired.
   * @param {pg.Pool} pool
   * @returns {Promise<number>} Number of recovered deliveries.
   */
  async recoverExpiredLeases(pool) {
    return withTransaction(pool, null, async (client) => {
      const count = await DeliveriesRepo.recoverExpiredLeases(client);
      if (count > 0) {
        logger.warn(`Recovered ${count} stranded in-flight deliveries from expired leases.`);
      }
      return count;
    });
  },
};
