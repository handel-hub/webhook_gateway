import pg from 'pg';

export const AuditOutboxRepo = {
  /**
   * Commits an administrative audit event and places a message on the transactional audit outbox.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   actorIdentity: string,
   *   applicationId?: string | null,
   *   action: string,
   *   targetType: string,
   *   targetId: string,
   *   requestId: string,
   *   outcome: string,
   *   reasonCode?: string | null,
   *   beforeState?: Record<string, any> | null,
   *   afterState?: Record<string, any> | null,
   *   auditClass?: 'security' | 'operational' | 'compliance',
   *   legalHold?: boolean
   * }} data
   * @returns {Promise<{ auditEventId: string, outboxId: number }>}
   */
  async insertAuditEvent(client, data) {
    const auditRes = await client.query(
      `INSERT INTO cwids.administrative_audit_events
         (id, actor_identity, application_id, action, target_type, target_id,
          request_id, outcome, reason_code, before_state, after_state, audit_class, legal_hold)
       VALUES
         (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        data.id ?? null,
        data.actorIdentity,
        data.applicationId ?? null,
        data.action,
        data.targetType,
        data.targetId,
        data.requestId,
        data.outcome,
        data.reasonCode ?? null,
        data.beforeState ? JSON.stringify(data.beforeState) : null,
        data.afterState ? JSON.stringify(data.afterState) : null,
        data.auditClass ?? 'operational',
        data.legalHold ?? false,
      ],
    );
    const auditEventId = auditRes.rows[0].id;

    const outboxPayload = {
      auditEventId,
      actorIdentity: data.actorIdentity,
      action: data.action,
      targetType: data.targetType,
      targetId: data.targetId,
      outcome: data.outcome,
      timestamp: new Date().toISOString(),
    };

    const outboxRes = await client.query(
      `INSERT INTO cwids.audit_outbox (audit_event_id, payload, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [auditEventId, JSON.stringify(outboxPayload)],
    );

    return { auditEventId, outboxId: outboxRes.rows[0].id };
  },

  /**
   * Fetches pending outbox records to export.
   * @param {pg.PoolClient} client
   * @param {number} limit
   * @returns {Promise<Array<{ id: number, auditEventId: string, payload: Record<string, any> }>>}
   */
  async fetchPending(client, limit = 100) {
    const res = await client.query(
      `SELECT id, audit_event_id as "auditEventId", payload
       FROM cwids.audit_outbox
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return res.rows;
  },

  /**
   * Marks outbox entries as exported.
   * @param {pg.PoolClient} client
   * @param {number[]} ids
   * @returns {Promise<number>}
   */
  async markExported(client, ids) {
    if (ids.length === 0) return 0;
    const res = await client.query(
      `UPDATE cwids.audit_outbox
       SET status = 'exported'
       WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    return res.rowCount ?? 0;
  },

  /**
   * Purges administrative audit events exceeding classified retention windows (ADR-12).
   * @param {pg.PoolClient} client
   * @param {{ operationalCutoff: Date, securityCutoff: Date, limit?: number }} params
   * @returns {Promise<number>} Number of purged audit records.
   */
  async purgeClassifiedAudit(client, { operationalCutoff, securityCutoff, limit = 1000 }) {
    const res = await client.query(
      `WITH candidates AS (
         SELECT id
         FROM cwids.administrative_audit_events
         WHERE legal_hold = FALSE
           AND (
             (audit_class = 'operational' AND created_at < $1)
             OR
             (audit_class IN ('security', 'compliance') AND created_at < $2)
           )
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM cwids.administrative_audit_events target
       USING candidates
       WHERE target.id = candidates.id`,
      [operationalCutoff, securityCutoff, limit],
    );
    return res.rowCount ?? 0;
  },
};
