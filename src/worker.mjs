import { getEnv } from './config/env.mjs';
import { getWorkerPool, closeAllPools } from './db/pool.mjs';
import { DeliveryScheduler } from './delivery/scheduler.mjs';
import { DeliveryService } from './delivery/delivery-service.mjs';
import { AuditExporter } from './maintenance/audit-exporter.mjs';
import { IntentCleanupWorker } from './maintenance/intent-cleanup.mjs';
import { RetentionWorker } from './maintenance/retention-worker.mjs';
import { ReconciliationWorker } from './maintenance/reconciliation-worker.mjs';
import { logger } from './observability/logger.mjs';

/**
 * Boots the Background Delivery Worker Daemon.
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startWorker() {
  const env = getEnv();
  const pool = getWorkerPool();
  const workerIdentity = `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

  logger.info('Initializing CWIDS Delivery Worker Daemon...', {
    workerIdentity,
    concurrency: env.WORKER_CONCURRENCY,
    nodeEnv: env.NODE_ENV,
  });

  // 1. Initialize Delivery Scheduler with Dispatch Handler
  const scheduler = new DeliveryScheduler({
    pool,
    workerIdentity,
    concurrency: env.WORKER_CONCURRENCY,
    dispatchHandler: async (claim) => {
      await DeliveryService.processDeliveryClaim(pool, env, claim, workerIdentity);
    },
  });

  // 2. Start maintenance background daemons
  const auditExporter = AuditExporter.startExporter(pool, { intervalMs: 5000 });
  const intentCleanup = IntentCleanupWorker.startWorker(pool, { intervalMs: 3600000 });
  const retentionWorker = RetentionWorker.startWorker(pool, { intervalMs: 86400000 });
  const reconciliationWorker = ReconciliationWorker.startWorker(pool, env);

  // 3. Start scheduler polling loop
  scheduler.start();

  let isStopping = false;

  async function stop() {
    if (isStopping) return;
    isStopping = true;
    logger.info('Commencing graceful shutdown of CWIDS Delivery Worker (30s deadline)...');

    // Stop background maintenance timers
    auditExporter.stop();
    intentCleanup.stop();
    retentionWorker.stop();
    reconciliationWorker.stop();

    // Drain and stop scheduler
    await scheduler.stop(30000);

    // Close database pools
    await closeAllPools();
    logger.info('CWIDS Delivery Worker Daemon stopped cleanly.');
  }

  // Register signal listeners for standalone execution
  const sigHandler = () => {
    stop()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('Error during worker shutdown', err);
        process.exit(1);
      });
  };

  process.once('SIGTERM', sigHandler);
  process.once('SIGINT', sigHandler);

  return { stop };
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith('worker.mjs') || process.argv[1].endsWith('worker.js'))) {
  startWorker().catch((err) => {
    logger.error('Failed to start Delivery Worker', err);
    process.exit(1);
  });
}
