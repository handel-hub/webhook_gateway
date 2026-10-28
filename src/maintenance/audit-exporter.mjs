import pg from 'pg';
import { AuditOutboxRepo } from '../db/repositories/audit-outbox-repo.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { createLogger } from '../observability/logger.mjs';

const logger = createLogger({ service: 'audit-exporter' });

/**
 * Audit Outbox Exporter.
 * Drains transactional audit outbox records and streams them to structured audit output.
 */
export const AuditExporter = {
  /**
   * Processes a single batch of pending audit outbox records.
   *
   * @param {pg.Pool} pool
   * @param {number} [limit=100]
   * @param {(record: { id: number, auditEventId: string, payload: Record<string, any> }) => void} [sink]
   * @returns {Promise<number>} Number of records exported.
   */
  async exportBatch(pool, limit = 100, sink) {
    return withTransaction(pool, null, async (client) => {
      const pendingRecords = await AuditOutboxRepo.fetchPending(client, limit);
      if (pendingRecords.length === 0) {
        return 0;
      }

      const exportedIds = [];
      for (const record of pendingRecords) {
        if (sink) {
          sink(record);
        } else {
          // Default structured stdout emission
          logger.info('Audit event exported', {
            outboxId: record.id,
            auditEventId: record.auditEventId,
            auditRecord: record.payload,
          });
        }
        exportedIds.push(record.id);
      }

      await AuditOutboxRepo.markExported(client, exportedIds);
      return exportedIds.length;
    });
  },

  /**
   * Starts a continuous background export loop.
   *
   * @param {pg.Pool} pool
   * @param {object} [options]
   * @param {number} [options.intervalMs=5000]
   * @param {number} [options.batchSize=100]
   * @returns {{ stop: () => void }}
   */
  startExporter(pool, { intervalMs = 5000, batchSize = 100 } = {}) {
    let running = true;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    async function tick() {
      if (!running) return;
      try {
        const count = await AuditExporter.exportBatch(pool, batchSize);
        if (count > 0) {
          logger.debug(`Exported ${count} audit outbox records`);
        }
      } catch (err) {
        logger.error('Error exporting audit outbox batch', err instanceof Error ? err : new Error(String(err)));
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
