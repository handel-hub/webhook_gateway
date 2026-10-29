import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DeliveriesRepo } from '../../src/db/repositories/deliveries-repo.mjs';
import {
  getTestPool,
  closeTestPool,
  getTestClient,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('Concurrency Hardening (TC-15): 10 concurrent workers claim 100 jobs simultaneously without double-claiming', async () => {
  try {
    const pool = getTestPool();
    const setupClient = await getTestClient();

    const app = await createTestApp(setupClient);
    const endpoint = await createTestEndpoint(setupClient, app.id);
    const conn = await createTestProviderConnection(setupClient, { applicationId: app.id });

    const totalJobs = 100;
    const deliveryIds = [];

    try {
      // Ensure circuit breaker is closed
      await setupClient.query(
        `INSERT INTO cwids.circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight)
         VALUES ($1, 'closed', 0, false)
         ON CONFLICT (destination_endpoint_id) DO UPDATE
         SET state = 'closed', consecutive_failures = 0, half_open_probe_in_flight = false`,
        [endpoint.id],
      );

      // Batch insert 100 events and 100 delivery obligations
      for (let i = 1; i <= totalJobs; i++) {
        const dedupeKey = `cc-test-${app.code}-${i}-${crypto.randomBytes(4).toString('hex')}`;
        const evRes = await setupClient.query(
          `INSERT INTO cwids.webhook_events 
             (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
           VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', $6, 'resolved', 'mode_a', 'v1', 'dummy_sha')
           RETURNING id`,
          [app.id, conn.id, conn.provider, conn.environment, dedupeKey, `ref-${i}`],
        );
        const eventId = evRes.rows[0].id;

        const delivRes = await setupClient.query(
          `INSERT INTO cwids.event_deliveries 
             (event_id, application_id, destination_endpoint_id, status, next_attempt_at)
           VALUES ($1, $2, $3, 'pending', NOW() - INTERVAL '1 minute')
           RETURNING id`,
          [eventId, app.id, endpoint.id],
        );
        deliveryIds.push(delivRes.rows[0].id);
      }

      const numWorkers = 10;
      const claimsPerWorker = 10;

      // Run 10 workers in parallel against the real database pool
      const workerTasks = Array.from({ length: numWorkers }, async (_, index) => {
        const workerId = `worker_cluster_${index + 1}`;
        const claims = await DeliveriesRepo.claimBatch(/** @type {any} */ (pool), claimsPerWorker, 30, workerId);
        return { workerId, claims };
      });

      const results = await Promise.all(workerTasks);

      /** @type {Set<string>} */
      const claimedDeliveryIds = new Set();
      let totalClaimed = 0;

      for (const { workerId, claims } of results) {
        for (const claim of claims) {
          // Only count the ones from this test run
          if (deliveryIds.includes(claim.deliveryId)) {
            assert.equal(
              claimedDeliveryIds.has(claim.deliveryId),
              false,
              `Duplicate claim detected! Delivery ${claim.deliveryId} claimed more than once by ${workerId}.`,
            );
            claimedDeliveryIds.add(claim.deliveryId);
            totalClaimed++;

            // Verify fencing token was incremented to 1
            assert.equal(claim.fencingToken, 1);
          }
        }
      }

      // Every single job out of 100 claimed exactly once on real PostgreSQL engine!
      assert.equal(totalClaimed, totalJobs);
      assert.equal(claimedDeliveryIds.size, totalJobs);
    } finally {
      await cleanupTestTenants(setupClient, [app.id]);
      await setupClient.end();
      await closeTestPool();
    }
  } catch (err) {
    console.error('CONCURRENT CLAIMS ERROR:', err);
    throw err;
  }
});
