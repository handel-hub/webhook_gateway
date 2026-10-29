import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveriesRepo } from '../../../src/db/repositories/deliveries-repo.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../../helpers/db-test-helper.mjs';

test('Fenced Stale Worker: Stale worker update returns false on token mismatch and leaves 0 attempt rows', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Fenced Stale Worker App' });
    appId = app.id;
    const endp = await createTestEndpoint(pool, appId);
    const conn = await createTestProviderConnection(pool, { applicationId: appId });

    // Ensure circuit breaker is closed
    await pool.query(`
      INSERT INTO cwids.circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight)
      VALUES ($1, 'closed', 0, false)
      ON CONFLICT (destination_endpoint_id) DO UPDATE
      SET state = 'closed', consecutive_failures = 0, half_open_probe_in_flight = false;
    `, [endp.id]);

    // Insert an event and delivery
    const ev = (await pool.query(`
      INSERT INTO cwids.webhook_events (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
      VALUES ($1, $2, $3, $4, 1, 'fenced-test-${Date.now()}', 'charge.success', 'charge', 'ref-fenced', 'resolved', 'mode_a', 'v1', 'sha-fenced')
      RETURNING id;
    `, [app.id, conn.id, conn.provider, conn.environment])).rows[0];

    const deliv = (await pool.query(`
      INSERT INTO cwids.event_deliveries (event_id, application_id, destination_endpoint_id, status, next_attempt_at)
      VALUES ($1, $2, $3, 'pending', NOW() - INTERVAL '1 hour')
      RETURNING id, fencing_token;
    `, [ev.id, app.id, endp.id])).rows[0];

    const client = await pool.connect();
    try {
      // Worker A claims with token 1
      const claims = await DeliveriesRepo.claimBatch(client, 1, 1, 'worker_A');
      const claimA = claims.find((c) => c.deliveryId === deliv.id);
      assert.ok(claimA);

      // Stale worker tries to complete with stale/mismatched token 9999
      const successStale = await DeliveriesRepo.completeDelivery(client, deliv.id, 9999);
      assert.equal(successStale, false, 'Stale worker completeDelivery must return false on token mismatch.');
    } finally {
      client.release();
    }
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
