import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DeliveriesRepo } from '../../src/db/repositories/deliveries-repo.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('Fencing Token Integrity (TC-16): Stale worker with expired lease cannot overwrite newer database state', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Stale Worker Test App' });
    appId = app.id;
    const endpoint = await createTestEndpoint(pool, appId, {
      url: 'https://example.com/webhook-stale',
      maxRetries: 5,
    });
    const conn = await createTestProviderConnection(pool, { applicationId: appId });

    // 1. Insert an event and an in-flight delivery whose lease expired 5 seconds ago
    const dedupeKey = `stale-${app.code}-${crypto.randomBytes(4).toString('hex')}`;
    const eventRes = await pool.query(
      `INSERT INTO cwids.webhook_events 
         (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
       VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-stale', 'resolved', 'mode_a', 'v1', 'dummy_sha')
       RETURNING id`,
      [app.id, conn.id, conn.provider, conn.environment, dedupeKey],
    );
    const eventId = eventRes.rows[0].id;

    const delivRes = await pool.query(
      `INSERT INTO cwids.event_deliveries
       (id, event_id, application_id, destination_endpoint_id, status, fencing_token,
        claimed_by_worker, lease_expires_at, next_attempt_at, epoch_id, epoch_attempt_count, attempt_count)
       VALUES
       (gen_random_uuid(), $1, $2, $3, 'in_flight', 1,
        'worker_slow_1', CURRENT_TIMESTAMP - interval '5 seconds', CURRENT_TIMESTAMP - interval '10 seconds',
        gen_random_uuid(), 0, 1)
       RETURNING id, fencing_token, status`,
      [eventId, appId, endpoint.id]
    );
    const deliveryId = delivRes.rows[0].id;
    const worker1FencingToken = 1;

    // 2. Lease recovery sweep runs because Worker 1's lease expired
    const recoveredCount = await DeliveriesRepo.recoverExpiredLeases(/** @type {any} */ (pool));
    assert.ok(recoveredCount >= 1, 'Should have recovered at least 1 expired lease');

    const checkRecovered = await pool.query(
      `SELECT status, fencing_token FROM cwids.event_deliveries WHERE id = $1`,
      [deliveryId]
    );
    assert.equal(checkRecovered.rows[0].status, 'retry_scheduled');
    assert.equal(Number(checkRecovered.rows[0].fencing_token), 1);

    // Set next_attempt_at to now so Worker 2 can immediately claim it
    await pool.query(
      `UPDATE cwids.event_deliveries SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [deliveryId]
    );

    // 3. Worker 2 claims the recovered job, advancing the fencing token to 2
    const client2 = await pool.connect();
    let worker2Claims;
    try {
      worker2Claims = await DeliveriesRepo.claimBatch(client2, 1, 30, 'worker_fast_2');
    } finally {
      client2.release();
    }

    const claimedByWorker2 = worker2Claims.find((c) => c.deliveryId === deliveryId);
    assert.ok(claimedByWorker2, 'Worker 2 should claim the recovered delivery');
    assert.equal(claimedByWorker2.fencingToken, 2);

    // 4. Stale Worker 1 wakes up and attempts to complete the delivery using stale fencing token 1
    const updateSuccess = await DeliveriesRepo.completeDelivery(
      /** @type {any} */ (pool),
      deliveryId,
      worker1FencingToken,
    );
    assert.equal(updateSuccess, false, 'Stale worker update must be rejected by database fencing token!');

    // Stale Worker 1 attempting to scheduleRetry with token 1 must also fail
    const retrySuccess = await DeliveriesRepo.scheduleRetry(
      /** @type {any} */ (pool),
      deliveryId,
      worker1FencingToken,
      new Date(),
      500,
      'TIMEOUT',
    );
    assert.equal(retrySuccess, false, 'Stale worker scheduleRetry must be rejected!');

    // Stale Worker 1 attempting to deadLetter with token 1 must also fail
    const deadLetterSuccess = await DeliveriesRepo.deadLetterDelivery(
      /** @type {any} */ (pool),
      deliveryId,
      worker1FencingToken,
      'EXHAUSTED',
      500,
      'TIMEOUT',
    );
    assert.equal(deadLetterSuccess, false, 'Stale worker deadLetter must be rejected!');

    // Verify DB row remains intact with Worker 2's state
    const finalState = await pool.query(
      `SELECT status, fencing_token, claimed_by_worker FROM cwids.event_deliveries WHERE id = $1`,
      [deliveryId]
    );
    assert.equal(finalState.rows[0].status, 'in_flight');
    assert.equal(Number(finalState.rows[0].fencing_token), 2);
    assert.equal(finalState.rows[0].claimed_by_worker, 'worker_fast_2');

    // 5. Worker 2 successfully completes delivery using legitimate fencing token 2
    const worker2Success = await DeliveriesRepo.completeDelivery(
      /** @type {any} */ (pool),
      deliveryId,
      2,
    );
    assert.equal(worker2Success, true, 'Legitimate worker update must succeed');

    const completedState = await pool.query(
      `SELECT status FROM cwids.event_deliveries WHERE id = $1`,
      [deliveryId]
    );
    assert.equal(completedState.rows[0].status, 'delivered');
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
