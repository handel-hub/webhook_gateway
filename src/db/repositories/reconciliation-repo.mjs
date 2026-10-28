import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/domain.mjs').ReconciliationRecord} ReconciliationRecord
 */

export const ReconciliationRepo = {
  /**
   * Inserts a transaction verification result and discrepancy record.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   paymentIntentId: string,
   *   providerConnectionId: string,
   *   status: 'matched' | 'discrepancy_detected' | 'quarantined' | 'resolved',
   *   providerStatus?: string | null,
   *   verifiedAmountMinor?: number | null,
   *   verifiedCurrency?: string | null,
   *   verifiedReference?: string | null,
   *   rawResponse?: Record<string, any>,
   *   discrepancyNotes?: string | null
   * }} data
   * @returns {Promise<ReconciliationRecord>}
   */
  async insertRecord(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.reconciliation_records
         (id, payment_intent_id, provider_connection_id, status, provider_status,
          verified_amount_minor, verified_currency, verified_reference, raw_response, discrepancy_notes)
       VALUES
         (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, payment_intent_id, provider_connection_id, status, provider_status,
                 verified_amount_minor, verified_currency, verified_reference, raw_response,
                 discrepancy_notes, checked_at`,
      [
        data.id ?? null,
        data.paymentIntentId,
        data.providerConnectionId,
        data.status,
        data.providerStatus ?? null,
        data.verifiedAmountMinor ?? null,
        data.verifiedCurrency ?? null,
        data.verifiedReference ?? null,
        JSON.stringify(data.rawResponse ?? {}),
        data.discrepancyNotes ?? null,
      ],
    );
    /** @type {ReconciliationRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to insert reconciliation record.');
    }
    return row;
  },

  /**
   * Finds payment intents eligible for background reconciliation:
   * Active intents older than minAgeMinutes that have not yet been checked.
   * @param {pg.PoolClient} client
   * @param {number} minAgeMinutes
   * @param {number} limit
   * @returns {Promise<Array<{ intentId: string, merchantReference: string, providerConnectionId: string, provider: string, environment: string, expectedAmountMinor: number, expectedCurrency: string }>>}
   */
  async findCandidates(client, minAgeMinutes = 30, limit = 50) {
    const res = await client.query(
      `SELECT pic.id as "intentId",
              pic.merchant_reference as "merchantReference",
              pic.provider_connection_id as "providerConnectionId",
              pc.provider,
              pic.environment,
              pic.expected_amount_minor as "expectedAmountMinor",
              pic.currency as "expectedCurrency"
       FROM cwids.payment_intent_correlations pic
       JOIN cwids.provider_connections pc ON pic.provider_connection_id = pc.id
       LEFT JOIN cwids.reconciliation_records rr ON pic.id = rr.payment_intent_id
       WHERE pic.status = 'active'
         AND pic.created_at < CURRENT_TIMESTAMP - ($1 || ' minutes')::interval
         AND rr.id IS NULL
       LIMIT $2
       FOR UPDATE OF pic SKIP LOCKED`,
      [minAgeMinutes, limit],
    );
    return res.rows;
  },
};
