import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/domain.mjs').WebhookEventRecord} WebhookEventRecord
 */

export const EventsRepo = {
  /**
   * Retrieves an event by its primary UUID.
   * @param {pg.PoolClient} client
   * @param {string} id
   * @returns {Promise<WebhookEventRecord | null>}
   */
  async findById(client, id) {
    const res = await client.query(
      `SELECT id, provider_connection_id, environment, identity_strategy_version, dedupe_key,
              provider_event_id, event_type, resource_type, resource_reference, application_id,
              payment_intent_id, routing_status, routing_mode, encrypted_payload, payload_nonce,
              payload_tag, wrapped_dek, kek_version, payload_sha256, received_at, created_at,
              payload_deleted_at, legal_hold
       FROM cwids.webhook_events
       WHERE id = $1`,
      [id],
    );
    /** @type {WebhookEventRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Finds an existing event by its natural deduplication key.
   * @param {pg.PoolClient} client
   * @param {string} providerConnectionId
   * @param {string} environment
   * @param {number} identityStrategyVersion
   * @param {string} dedupeKey
   * @returns {Promise<WebhookEventRecord | null>}
   */
  async findByDedupe(client, providerConnectionId, environment, identityStrategyVersion, dedupeKey) {
    const res = await client.query(
      `SELECT id, provider_connection_id, environment, identity_strategy_version, dedupe_key,
              provider_event_id, event_type, resource_type, resource_reference, application_id,
              payment_intent_id, routing_status, routing_mode, encrypted_payload, payload_nonce,
              payload_tag, wrapped_dek, kek_version, payload_sha256, received_at, created_at,
              payload_deleted_at, legal_hold
       FROM cwids.webhook_events
       WHERE provider_connection_id = $1
         AND environment = $2
         AND identity_strategy_version = $3
         AND dedupe_key = $4`,
      [providerConnectionId, environment, identityStrategyVersion, dedupeKey],
    );
    /** @type {WebhookEventRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Inserts an event record. If duplicate constraint trips (23505), queries existing event.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   providerConnectionId: string,
   *   provider: string,
   *   environment: string,
   *   identityStrategyVersion: number,
   *   dedupeKey: string,
   *   providerEventId?: string | null,
   *   eventType: string,
   *   resourceType: string,
   *   resourceReference: string,
   *   applicationId?: string | null,
   *   paymentIntentId?: string | null,
   *   routingStatus: string,
   *   routingMode: string,
   *   encryptedPayload?: Buffer | null,
   *   payloadNonce?: Buffer | null,
   *   payloadTag?: Buffer | null,
   *   wrappedDek?: Buffer | null,
   *   kekVersion: string,
   *   payloadSha256: string
   * }} data
   * @returns {Promise<{ event: WebhookEventRecord, isDuplicate: boolean }>}
   */
  async insertEvent(client, data) {
    try {
      await client.query('SAVEPOINT sp_insert_event');
      const res = await client.query(
        `INSERT INTO cwids.webhook_events
           (id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key,
            provider_event_id, event_type, resource_type, resource_reference, application_id,
            payment_intent_id, routing_status, routing_mode, encrypted_payload, payload_nonce,
            payload_tag, wrapped_dek, kek_version, payload_sha256)
         VALUES
           (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING id, provider_connection_id, environment, identity_strategy_version, dedupe_key,
                   provider_event_id, event_type, resource_type, resource_reference, application_id,
                   payment_intent_id, routing_status, routing_mode, encrypted_payload, payload_nonce,
                   payload_tag, wrapped_dek, kek_version, payload_sha256, received_at, created_at,
                   payload_deleted_at, legal_hold`,
        [
          data.id ?? null,
          data.providerConnectionId,
          data.provider,
          data.environment,
          data.identityStrategyVersion,
          data.dedupeKey,
          data.providerEventId ?? null,
          data.eventType,
          data.resourceType,
          data.resourceReference,
          data.applicationId ?? null,
          data.paymentIntentId ?? null,
          data.routingStatus,
          data.routingMode,
          data.encryptedPayload ?? null,
          data.payloadNonce ?? null,
          data.payloadTag ?? null,
          data.wrappedDek ?? null,
          data.kekVersion,
          data.payloadSha256,
        ],
      );
      await client.query('RELEASE SAVEPOINT sp_insert_event');
      /** @type {WebhookEventRecord[]} */
      const rows = res.rows;
      const row = rows[0];
      if (!row) {
        throw new DatabaseOperationError('Failed to insert webhook event record.');
      }
      return { event: row, isDuplicate: false };
    } catch (err) {
      // @ts-ignore - pg error code check
      if (err && err.code === '23505') {
        try {
          await client.query('ROLLBACK TO SAVEPOINT sp_insert_event');
        } catch (_) {}
        const existing = await this.findByDedupe(
          client,
          data.providerConnectionId,
          data.environment,
          data.identityStrategyVersion,
          data.dedupeKey,
        );
        if (existing) {
          return { event: existing, isDuplicate: true };
        }
      }
      throw err;
    }
  },

  /**
   * Prunes raw encrypted payload bytes for events older than cutoff without legal hold (ADR-12).
   * Unrouted and quarantined events are strictly excluded to preserve investigation payload.
   *
   * @param {pg.PoolClient} client
   * @param {Date} cutoffDate
   * @param {number} [limit=1000]
   * @returns {Promise<number>} Number of pruned records.
   */
  async prunePayloads(client, cutoffDate, limit = 1000) {
    const res = await client.query(
      `WITH candidates AS (
         SELECT id FROM cwids.webhook_events
         WHERE received_at < $1
           AND encrypted_payload IS NOT NULL
           AND legal_hold = FALSE
           AND routing_status NOT IN ('awaiting_route', 'quarantined')
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE cwids.webhook_events target
       SET encrypted_payload = NULL,
           payload_nonce = NULL,
           payload_tag = NULL,
           wrapped_dek = NULL,
           payload_deleted_at = CURRENT_TIMESTAMP
       FROM candidates
       WHERE target.id = candidates.id`,
      [cutoffDate, limit],
    );
    return res.rowCount ?? 0;
  },

  /**
   * Purges normalized metadata for webhook events older than cutoff without active deliveries or legal holds (ADR-12).
   * Unrouted and quarantined events are strictly excluded.
   *
   * @param {pg.PoolClient} client
   * @param {Date} cutoffDate
   * @param {number} [limit=1000]
   * @returns {Promise<number>} Number of deleted event records.
   */
  async purgeExpiredMetadata(client, cutoffDate, limit = 1000) {
    const res = await client.query(
      `WITH candidates AS (
         SELECT we.id
         FROM cwids.webhook_events we
         WHERE we.received_at < $1
           AND we.legal_hold = FALSE
           AND we.routing_status NOT IN ('awaiting_route', 'quarantined')
           AND NOT EXISTS (
             SELECT 1
             FROM cwids.event_deliveries ed
             WHERE ed.event_id = we.id
               AND ed.status NOT IN ('delivered', 'cancelled')
           )
         LIMIT $2
         FOR UPDATE OF we SKIP LOCKED
       ),
       del_deliveries AS (
         DELETE FROM cwids.event_deliveries ed
         USING candidates
         WHERE ed.event_id = candidates.id
       )
       DELETE FROM cwids.webhook_events target
       USING candidates
       WHERE target.id = candidates.id`,
      [cutoffDate, limit],
    );
    return res.rowCount ?? 0;
  },

  /**
   * Scans for unrouted events (awaiting_route, quarantined) older than threshold (e.g. 90 days) for operational alerting.
   * @param {pg.PoolClient} client
   * @param {number} [daysOld=90]
   * @returns {Promise<Array<{ id: string, provider: string, routing_status: string, received_at: Date }>>}
   */
  async findUnroutedAlerts(client, daysOld = 90) {
    const res = await client.query(
      `SELECT id, provider, routing_status, received_at
       FROM cwids.webhook_events
       WHERE routing_status IN ('awaiting_route', 'quarantined')
         AND received_at < CURRENT_TIMESTAMP - make_interval(days => $1)
       LIMIT 100`,
      [daysOld],
    );
    return res.rows;
  },
};
