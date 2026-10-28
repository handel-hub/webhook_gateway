import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/delivery.mjs').DeliveryAttemptRecord} DeliveryAttemptRecord
 */

export const AttemptsRepo = {
  /**
   * Appends an outbound delivery attempt record.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   deliveryId: string,
   *   attemptNumber: number,
   *   fencingToken: number,
   *   startedAt: Date,
   *   finishedAt: Date,
   *   durationMs: number,
   *   httpStatus?: number | null,
   *   responseStatus?: string | null,
   *   responseExcerpt?: string | null,
   *   isTruncated?: boolean,
   *   errorCode?: string | null,
   *   errorMessage?: string | null,
   *   workerIdentity: string
   * }} data
   * @returns {Promise<DeliveryAttemptRecord>}
   */
  async recordAttempt(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.delivery_attempts
         (id, delivery_id, attempt_number, fencing_token, started_at, finished_at,
          duration_ms, http_status, response_status, response_body_excerpt,
          response_truncated, error_code, error_message, worker_identity)
       VALUES
         (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, delivery_id, attempt_number, fencing_token,
                 http_status, response_status, response_body_excerpt as response_excerpt,
                 response_truncated as is_truncated, duration_ms, error_code, error_message,
                 created_at as attempted_at`,
      [
        data.id ?? null,
        data.deliveryId,
        data.attemptNumber,
        data.fencingToken,
        data.startedAt,
        data.finishedAt,
        data.durationMs,
        data.httpStatus ?? null,
        data.responseStatus ?? null,
        data.responseExcerpt ?? null,
        data.isTruncated ?? false,
        data.errorCode ?? null,
        data.errorMessage ?? null,
        data.workerIdentity,
      ],
    );
    /** @type {DeliveryAttemptRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to record delivery attempt.');
    }
    return row;
  },
};
