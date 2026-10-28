import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/domain.mjs').PaymentIntentRecord} PaymentIntentRecord
 */

export const IntentsRepo = {
  /**
   * Finds an intent by its primary UUID.
   * @param {pg.PoolClient} client
   * @param {string} id
   * @returns {Promise<PaymentIntentRecord | null>}
   */
  async findById(client, id) {
    const res = await client.query(
      `SELECT id, application_id, provider_connection_id, environment, merchant_reference,
              expected_amount_minor, currency, idempotency_key, status, expires_at, metadata, created_at, updated_at
       FROM cwids.payment_intent_correlations
       WHERE id = $1`,
      [id],
    );
    /** @type {PaymentIntentRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Finds an intent by application ID and idempotency key.
   * @param {pg.PoolClient} client
   * @param {string} applicationId
   * @param {string} idempotencyKey
   * @returns {Promise<PaymentIntentRecord | null>}
   */
  async findByIdempotencyKey(client, applicationId, idempotencyKey) {
    const res = await client.query(
      `SELECT id, application_id, provider_connection_id, environment, merchant_reference,
              expected_amount_minor, currency, idempotency_key, status, expires_at, metadata, created_at, updated_at
       FROM cwids.payment_intent_correlations
       WHERE application_id = $1 AND idempotency_key = $2`,
      [applicationId, idempotencyKey],
    );
    /** @type {PaymentIntentRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Finds an active payment intent matching merchant reference (Mode A).
   * @param {pg.PoolClient} client
   * @param {string} providerConnectionId
   * @param {string} environment
   * @param {string} merchantReference
   * @returns {Promise<PaymentIntentRecord | null>}
   */
  async findByMerchantRef(client, providerConnectionId, environment, merchantReference) {
    const res = await client.query(
      `SELECT id, application_id, provider_connection_id, environment, merchant_reference,
              expected_amount_minor, currency, idempotency_key, status, expires_at, created_at, updated_at
       FROM cwids.payment_intent_correlations
       WHERE provider_connection_id = $1
         AND environment = $2
         AND merchant_reference = $3
         AND status = 'active'
         AND expires_at > CURRENT_TIMESTAMP`,
      [providerConnectionId, environment, merchantReference],
    );
    /** @type {PaymentIntentRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Finds a payment intent via a dynamic alias (Mode C).
   * @param {pg.PoolClient} client
   * @param {string} providerConnectionId
   * @param {string} environment
   * @param {string} aliasType
   * @param {string} aliasValue
   * @returns {Promise<PaymentIntentRecord | null>}
   */
  async findByAlias(client, providerConnectionId, environment, aliasType, aliasValue) {
    const res = await client.query(
      `SELECT pic.id, pic.application_id, pic.provider_connection_id, pic.environment, pic.merchant_reference,
              pic.expected_amount_minor, pic.currency, pic.idempotency_key, pic.status, pic.expires_at, pic.created_at, pic.updated_at
       FROM cwids.payment_intent_aliases pia
       JOIN cwids.payment_intent_correlations pic ON pia.payment_intent_id = pic.id
       WHERE pia.provider_connection_id = $1
         AND pia.environment = $2
         AND pia.alias_type = $3
         AND pia.alias_value = $4
         AND pic.status = 'active'`,
      [providerConnectionId, environment, aliasType, aliasValue],
    );
    /** @type {PaymentIntentRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Inserts a new payment intent correlation.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   applicationId: string,
   *   providerConnectionId: string,
   *   environment: string,
   *   merchantReference: string,
   *   expectedAmountMinor: number,
   *   currency: string,
   *   idempotencyKey: string,
   *   expiresAt: Date,
   *   metadata?: Record<string, any>
   * }} data
   * @returns {Promise<PaymentIntentRecord>}
   */
  async createIntent(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.payment_intent_correlations
         (id, application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, metadata, status)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING id, application_id, provider_connection_id, environment, merchant_reference,
                 expected_amount_minor, currency, idempotency_key, status, expires_at, created_at, updated_at`,
      [
        data.id ?? null,
        data.applicationId,
        data.providerConnectionId,
        data.environment,
        data.merchantReference,
        data.expectedAmountMinor,
        data.currency.toUpperCase(),
        data.idempotencyKey,
        data.expiresAt,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    /** @type {PaymentIntentRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to create payment intent correlation.');
    }
    return row;
  },

  /**
   * Inserts an alias for an existing payment intent.
   * @param {pg.PoolClient} client
   * @param {{
   *   paymentIntentId: string,
   *   providerConnectionId: string,
   *   environment: string,
   *   aliasType: string,
   *   aliasValue: string
   * }} data
   * @returns {Promise<void>}
   */
  async createAlias(client, data) {
    await client.query(
      `INSERT INTO cwids.payment_intent_aliases
         (payment_intent_id, provider_connection_id, environment, alias_type, alias_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_connection_id, environment, alias_type, alias_value) DO NOTHING`,
      [
        data.paymentIntentId,
        data.providerConnectionId,
        data.environment,
        data.aliasType,
        data.aliasValue,
      ],
    );
  },

  /**
   * Deletes expired payment intents that are older than the 7-day grace period
   * and NOT referenced by any webhook events.
   * @param {pg.PoolClient} client
   * @param {number} [batchSize=1000]
   * @returns {Promise<number>} Number of deleted intent records.
   */
  async deleteExpiredUnreferenced(client, batchSize = 1000) {
    const res = await client.query(
      `WITH to_delete AS (
         SELECT pic.id
         FROM cwids.payment_intent_correlations pic
         WHERE pic.expires_at < CURRENT_TIMESTAMP - INTERVAL '7 days'
           AND NOT EXISTS (
             SELECT 1 FROM cwids.webhook_events we WHERE we.payment_intent_id = pic.id
           )
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM cwids.payment_intent_correlations target
       USING to_delete
       WHERE target.id = to_delete.id`,
      [batchSize],
    );
    return res.rowCount ?? 0;
  },
};
