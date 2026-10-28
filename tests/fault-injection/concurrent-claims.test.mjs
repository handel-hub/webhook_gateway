import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LeaseManager } from '../../src/delivery/lease-manager.mjs';

/**
 * Creates an in-memory mock PostgreSQL pool that accurately simulates
 * row-level locking with PostgreSQL FOR UPDATE SKIP LOCKED across concurrent workers.
 */
function createConcurrentClaimsPool(totalJobs = 100) {
  /** @type {Map<string, { id: string, status: string, fencing_token: number, claimed_by_worker: string | null, lease_expires_at: Date | null, next_attempt_at: Date, attempt_count: number }>} */
  const jobs = new Map();
  /** @type {Set<string>} */
  const lockedJobIds = new Set();

  for (let i = 1; i <= totalJobs; i++) {
    const id = `deliv_${String(i).padStart(4, '0')}`;
    jobs.set(id, {
      id,
      status: 'pending',
      fencing_token: 0,
      claimed_by_worker: null,
      lease_expires_at: null,
      next_attempt_at: new Date(Date.now() - 1000), // Ready now
      attempt_count: 0,
    });
  }

  return {
    jobs,
    async connect() {
      return {
        /**
         * @param {string} sql
         * @param {any[]} [params]
         */
        async query(sql, params = []) {
          const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

          if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
            return { rows: [] };
          }

          // LeaseManager.claimBatch query using FOR UPDATE SKIP LOCKED
          if (s.includes('FROM CWIDS.EVENT_DELIVERIES ED') && s.includes('SKIP LOCKED')) {
            const batchSize = params[0] ?? 10;
            const leaseSeconds = params[1] ?? 30;
            const workerIdentity = params[2] ?? 'worker_test';

            const claimedRows = [];

            // Atomically evaluate claimable rows that are NOT currently locked by another transaction
            for (const job of jobs.values()) {
              if (claimedRows.length >= batchSize) break;

              if (
                ['pending', 'retry_scheduled'].includes(job.status) &&
                !lockedJobIds.has(job.id)
              ) {
                // Lock and claim row
                lockedJobIds.add(job.id);
                job.status = 'in_flight';
                job.fencing_token += 1;
                job.claimed_by_worker = workerIdentity;
                job.lease_expires_at = new Date(Date.now() + leaseSeconds * 1000);

                claimedRows.push({
                  deliveryId: job.id,
                  eventId: `evt_${job.id}`,
                  applicationId: 'app_1',
                  destinationEndpointId: 'ep_1',
                  attemptCount: job.attempt_count,
                  fencingToken: job.fencing_token,
                  firstAttemptAt: new Date(),
                  leaseExpiresAt: job.lease_expires_at,
                });
              }
            }

            return { rows: claimedRows };
          }

          throw new Error(`Unhandled SQL: ${sql}`);
        },
        release() {},
      };
    },
  };
}

test('Concurrency Hardening (TC-15): 10 concurrent workers claim 100 jobs simultaneously without double-claiming', async () => {
  const totalJobs = 100;
  const mockPool = createConcurrentClaimsPool(totalJobs);

  const numWorkers = 10;
  const claimsPerWorker = 10;

  // Run 10 workers in parallel
  const workerTasks = Array.from({ length: numWorkers }, async (_, index) => {
    const workerId = `worker_cluster_${index + 1}`;
    const claims = await LeaseManager.claimBatch(
      /** @type {any} */ (mockPool),
      claimsPerWorker,
      30,
      workerId,
    );
    return { workerId, claims };
  });

  const results = await Promise.all(workerTasks);

  /** @type {Set<string>} */
  const claimedDeliveryIds = new Set();
  let totalClaimed = 0;

  for (const { workerId, claims } of results) {
    for (const claim of claims) {
      assert.equal(
        claimedDeliveryIds.has(claim.deliveryId),
        false,
        `Duplicate claim detected! Delivery ${claim.deliveryId} claimed more than once.`,
      );
      claimedDeliveryIds.add(claim.deliveryId);
      totalClaimed++;

      // Verify fencing token was incremented to 1
      assert.equal(claim.fencingToken, 1);
    }
  }

  // Every single job out of 100 claimed exactly once!
  assert.equal(totalClaimed, totalJobs);
  assert.equal(claimedDeliveryIds.size, totalJobs);
});
