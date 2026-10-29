import pg from 'pg';
import { EventsRepo } from '../db/repositories/events-repo.mjs';
import { AuditOutboxRepo } from '../db/repositories/audit-outbox-repo.mjs';
import { AuditService } from '../admin/audit-service.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { LIMITS } from '../config/limits.mjs';
import { createLogger } from '../observability/logger.mjs';

const logger = createLogger({ service: 'retention-worker' });

/**
 * @typedef {object} RetentionOptions
 * @property {number} [rawPayloadRetentionDays=30]
 * @property {number} [normalizedMetadataRetentionDays=90]
 * @property {number} [operationalAuditRetentionDays=365]
 * @property {number} [securityAuditRetentionDays=2555]
 * @property {number} [batchLimit=1000]
 */

/**
 * Centralized Data Retention & Classified Audit Purging Engine (ADR-12).
 */
export const RetentionWorker = {
  /**
   * Executes a complete retention sweep across payloads, normalized metadata, and classified audits.
   *
   * @param {pg.Pool} pool
   * @param {RetentionOptions} [options]
   * @returns {Promise<{
   *   payloadsPruned: number,
   *   metadataPurged: number,
   *   auditsPurged: number,
   *   durationMs: number
   * }>}
   */
  async runRetentionSweep(pool, options = {}) {
    const startTime = Date.now();
    const rawPayloadDays = options.rawPayloadRetentionDays ?? 30;
    const metadataDays = options.normalizedMetadataRetentionDays ?? 90;
    const opAuditDays = options.operationalAuditRetentionDays ?? 365;
    const secAuditDays = options.securityAuditRetentionDays ?? 2555;
    const batchLimit = options.batchLimit ?? LIMITS.CLEANUP_BATCH_LIMIT;

    const payloadCutoff = new Date(Date.now() - rawPayloadDays * 24 * 60 * 60 * 1000);
    const metadataCutoff = new Date(Date.now() - metadataDays * 24 * 60 * 60 * 1000);
    const operationalAuditCutoff = new Date(Date.now() - opAuditDays * 24 * 60 * 60 * 1000);
    const securityAuditCutoff = new Date(Date.now() - secAuditDays * 24 * 60 * 60 * 1000);

    let payloadsPruned = 0;
    let metadataPurged = 0;
    let auditsPurged = 0;

    // 1. Prune encrypted payloads (ADR-12: 30 days, bypass legal hold)
    let morePayloads = true;
    while (morePayloads) {
      const pruned = await withTransaction(pool, null, async (client) => {
        return EventsRepo.prunePayloads(client, payloadCutoff, batchLimit);
      });
      payloadsPruned += pruned;
      if (pruned < batchLimit) {
        morePayloads = false;
      }
    }

    // 2. Purge expired terminal metadata (ADR-12: 90 days, bypass legal hold)
    let moreMetadata = true;
    while (moreMetadata) {
      const purged = await withTransaction(pool, null, async (client) => {
        return EventsRepo.purgeExpiredMetadata(client, metadataCutoff, batchLimit);
      });
      metadataPurged += purged;
      if (purged < batchLimit) {
        moreMetadata = false;
      }
    }

    // 3. Purge classified audits (ADR-12: operational 365d, security 7y, bypass legal hold)
    let moreAudits = true;
    while (moreAudits) {
      const purged = await withTransaction(pool, null, async (client) => {
        return AuditOutboxRepo.purgeClassifiedAudit(client, {
          operationalCutoff: operationalAuditCutoff,
          securityCutoff: securityAuditCutoff,
          limit: batchLimit,
        });
      });
      auditsPurged += purged;
      if (purged < batchLimit) {
        moreAudits = false;
      }
    }

    // 4. Scan and log operational alerts for ancient unrouted / quarantined events
    await withTransaction(pool, null, async (client) => {
      const ancientUnrouted = await EventsRepo.findUnroutedAlerts(client, 90);
      if (ancientUnrouted.length > 0) {
        logger.error(`OPERATIONAL_ALERT: Found ${ancientUnrouted.length} unrouted/quarantined events older than 90 days!`, undefined, {
          sampleEventIds: ancientUnrouted.slice(0, 5).map((e) => e.id),
        });
      }
    });

    const durationMs = Date.now() - startTime;

    // 4. Auditability: Record retention execution summary to administrative_audit_events
    await withTransaction(pool, null, async (client) => {
      await AuditService.recordAction(client, {
        actorIdentity: 'system:retention-worker',
        action: 'retention.sweep_completed',
        targetType: 'system',
        targetId: 'data-retention',
        requestId: `retention-${Date.now()}`,
        outcome: 'success',
        afterState: {
          payloadsPruned,
          metadataPurged,
          auditsPurged,
          durationMs,
        },
        auditClass: 'operational',
      });
    });

    logger.info('Retention sweep finished', {
      payloadsPruned,
      metadataPurged,
      auditsPurged,
      durationMs,
    });

    return { payloadsPruned, metadataPurged, auditsPurged, durationMs };
  },

  /**
   * Starts a background schedule for periodic retention sweeps.
   *
   * @param {pg.Pool} pool
   * @param {object} [options]
   * @param {number} [options.intervalMs=86400000] Default: 24 hours
   * @param {RetentionOptions} [options.retentionOptions]
   * @returns {{ stop: () => void }}
   */
  startWorker(pool, { intervalMs = 86400000, retentionOptions = {} } = {}) {
    let running = true;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    async function tick() {
      if (!running) return;
      try {
        await RetentionWorker.runRetentionSweep(pool, retentionOptions);
      } catch (err) {
        logger.error('Retention sweep cycle failed', err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (running) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    }

    timer = setTimeout(tick, intervalMs);

    return {
      stop() {
        running = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  },
};
