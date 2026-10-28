import pg from 'pg';
import { IntentsRepo } from '../db/repositories/intents-repo.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { LIMITS } from '../config/limits.mjs';
import { createLogger } from '../observability/logger.mjs';

const logger = createLogger({ service: 'intent-cleanup' });

/**
 * Expired Payment-Intent Batch Cleanup Worker.
 * Safely removes expired intents older than the 7-day grace period
 * that were never referenced by webhook events (GAP-02).
 */
export const IntentCleanupWorker = {
  /**
   * Executes a batch cleanup cycle for unreferenced expired payment intents.
   *
   * @param {pg.Pool} pool
   * @param {object} [options]
   * @param {number} [options.batchSize=1000]
   * @param {number} [options.maxBatches=10]
   * @returns {Promise<{ totalDeleted: number, batchesRun: number }>}
   */
  async runCleanup(pool, { batchSize = LIMITS.CLEANUP_BATCH_LIMIT, maxBatches = 10 } = {}) {
    let totalDeleted = 0;
    let batchesRun = 0;

    for (let i = 0; i < maxBatches; i++) {
      const deletedInBatch = await withTransaction(pool, null, async (client) => {
        return IntentsRepo.deleteExpiredUnreferenced(client, batchSize);
      });

      totalDeleted += deletedInBatch;
      batchesRun++;

      if (deletedInBatch < batchSize) {
        // Queue is drained
        break;
      }
    }

    if (totalDeleted > 0) {
      logger.info('Expired unreferenced payment intents pruned', { totalDeleted, batchesRun });
    }

    return { totalDeleted, batchesRun };
  },

  /**
   * Starts a background schedule for periodic intent cleanup.
   *
   * @param {pg.Pool} pool
   * @param {object} [options]
   * @param {number} [options.intervalMs=3600000] Default: 1 hour
   * @param {number} [options.batchSize=1000]
   * @returns {{ stop: () => void }}
   */
  startWorker(pool, { intervalMs = 3600000, batchSize = LIMITS.CLEANUP_BATCH_LIMIT } = {}) {
    let running = true;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    async function tick() {
      if (!running) return;
      try {
        await IntentCleanupWorker.runCleanup(pool, { batchSize });
      } catch (err) {
        logger.error('Failed to execute intent cleanup cycle', err instanceof Error ? err : new Error(String(err)));
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
