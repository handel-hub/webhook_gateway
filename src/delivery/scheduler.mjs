import pg from 'pg';
import { LeaseManager } from './lease-manager.mjs';
import { CircuitBreaker } from './circuit-breaker.mjs';
import { LIMITS } from '../config/limits.mjs';
import { logger } from '../observability/logger.mjs';

/**
 * @typedef {import('../types/delivery.mjs').DeliveryClaim} DeliveryClaim
 */

/**
 * Background Delivery Scheduler executing adaptive polling loops and concurrency management.
 */
export class DeliveryScheduler {
  /**
   * @param {object} options
   * @param {pg.Pool} options.pool - PostgreSQL Worker connection pool.
   * @param {string} [options.workerIdentity] - Unique worker process identifier.
   * @param {number} [options.concurrency=5] - Maximum parallel in-flight dispatches.
   * @param {number} [options.leaseDurationSeconds=30] - Lease length in seconds.
   * @param {(claim: DeliveryClaim) => Promise<void>} options.dispatchHandler - Handler executed for each claimed delivery.
   */
  constructor({
    pool,
    workerIdentity = `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    concurrency = 5,
    leaseDurationSeconds = 30,
    dispatchHandler,
  }) {
    this.pool = pool;
    this.workerIdentity = workerIdentity;
    this.concurrency = concurrency;
    this.leaseDurationSeconds = leaseDurationSeconds;
    this.dispatchHandler = dispatchHandler;

    this.isRunning = false;
    this.activeDispatches = 0;
    this.currentPollDelayMs = 250;
    this.minPollDelayMs = 250;
    this.maxPollDelayMs = 5000;
    /** @type {NodeJS.Timeout | null} */
    this.pollTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.recoveryTimer = null;
  }

  /**
   * Starts the background polling loop and lease recovery scheduler.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting DeliveryScheduler...', {
      workerIdentity: this.workerIdentity,
      concurrency: this.concurrency,
    });

    this.scheduleNextPoll(0);
    this.scheduleRecoverySweep();
  }

  /**
   * Stops the scheduler and waits for active dispatches to finish draining.
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<void>}
   */
  async stop(timeoutMs = 10000) {
    logger.info('Stopping DeliveryScheduler...');
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    const start = Date.now();
    while (this.activeDispatches > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.activeDispatches > 0) {
      logger.warn(`DeliveryScheduler stopped with ${this.activeDispatches} active dispatches still in-flight.`);
    } else {
      logger.info('DeliveryScheduler stopped cleanly.');
    }
  }

  /**
   * Schedules the next poll execution.
   * @param {number} delayMs
   */
  scheduleNextPoll(delayMs) {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  /**
   * Periodically recovers expired leases and sweeps matured circuit breakers every 60 seconds.
   */
  scheduleRecoverySweep() {
    this.recoveryTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await LeaseManager.recoverExpiredLeases(this.pool);
      } catch (err) {
        logger.error('Error in periodic lease recovery sweep', err instanceof Error ? err : new Error(String(err)));
      }
      try {
        const client = await this.pool.connect();
        try {
          await CircuitBreaker.sweepCooldowns(client);
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error('Error in circuit breaker cooldown sweep', err instanceof Error ? err : new Error(String(err)));
      }
    }, 60000);
  }

  /**
   * Poll execution: claims up to available concurrency capacity and dispatches asynchronously.
   */
  async poll() {
    if (!this.isRunning) return;

    const availableSlots = this.concurrency - this.activeDispatches;
    if (availableSlots <= 0) {
      // Saturated worker concurrency -> back off briefly
      this.scheduleNextPoll(this.minPollDelayMs);
      return;
    }

    const batchSize = Math.min(availableSlots, LIMITS.BATCH_CLAIM_LIMIT);
    /** @type {DeliveryClaim[]} */
    let claims = [];

    try {
      claims = await LeaseManager.claimBatch(
        this.pool,
        batchSize,
        this.leaseDurationSeconds,
        this.workerIdentity,
      );
    } catch (err) {
      logger.error('Error claiming deliveries in scheduler poll', err instanceof Error ? err : new Error(String(err)));
      // On DB error, back off
      this.currentPollDelayMs = Math.min(this.currentPollDelayMs * 2, this.maxPollDelayMs);
      this.scheduleNextPoll(this.currentPollDelayMs);
      return;
    }

    if (claims.length === 0) {
      // Queue empty -> ramp up poll delay
      this.currentPollDelayMs = Math.min(this.currentPollDelayMs * 1.5, this.maxPollDelayMs);
      this.scheduleNextPoll(this.currentPollDelayMs);
      return;
    }

    // Work discovered -> reset to minimal poll delay
    this.currentPollDelayMs = this.minPollDelayMs;

    // Dispatch claimed jobs concurrently up to concurrency ceiling
    for (const claim of claims) {
      this.activeDispatches++;
      this.executeDispatch(claim);
    }

    // If we claimed work and still have capacity, poll immediately
    if (this.concurrency - this.activeDispatches > 0) {
      this.scheduleNextPoll(50);
    } else {
      this.scheduleNextPoll(this.minPollDelayMs);
    }
  }

  /**
   * Executes dispatch handler and decrements active dispatches count.
   * @param {DeliveryClaim} claim
   */
  async executeDispatch(claim) {
    try {
      await this.dispatchHandler(claim);
    } catch (err) {
      logger.error(`Error dispatching delivery ${claim.deliveryId}`, err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeDispatches--;
    }
  }
}
