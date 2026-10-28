import pg from 'pg';
import { AuditOutboxRepo } from '../db/repositories/audit-outbox-repo.mjs';

/**
 * Service for recording administrative and operational audit trails
 * with transactional outbox export.
 */
export const AuditService = {
  /**
   * Records an administrative action and writes an entry to the audit outbox.
   *
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   actorIdentity: string,
   *   applicationId?: string | null,
   *   action: string,
   *   targetType: string,
   *   targetId: string,
   *   requestId: string,
   *   outcome: 'success' | 'failure',
   *   reasonCode?: string | null,
   *   beforeState?: Record<string, any> | null,
   *   afterState?: Record<string, any> | null,
   *   auditClass?: 'security' | 'operational' | 'compliance',
   *   legalHold?: boolean
   * }} params
   * @returns {Promise<{ auditEventId: string, outboxId: number }>}
   */
  async recordAction(client, params) {
    return AuditOutboxRepo.insertAuditEvent(client, {
      ...params,
      auditClass: params.auditClass ?? 'operational',
      legalHold: params.legalHold ?? false,
    });
  },
};
