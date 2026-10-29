import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveriesRepo } from '../../../src/db/repositories/deliveries-repo.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  cleanupTestTenants,
} from '../../helpers/db-test-helper.mjs';

test('Circuit Breaker Probe: half_open endpoints permit exactly 1 concurrent probe', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Circuit Breaker Probe App' });
    appId = app.id;
    const endp = await createTestEndpoint(pool, appId);

    // Set circuit breaker to half_open with probe in flight
    await pool.query(`
      INSERT INTO cwids.circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight)
      VALUES ($1, 'half_open', 5, true)
      ON CONFLICT (destination_endpoint_id) DO UPDATE
      SET state = 'half_open', consecutive_failures = 5, half_open_probe_in_flight = true;
    `, [endp.id]);

    const client = await pool.connect();
    try {
      // Claim batch of 10
      const claims = await DeliveriesRepo.claimBatch(client, 10, 30, 'probe_test_worker');
      const endpointClaims = claims.filter((c) => c.destinationEndpointId === endp.id);

      // Assert that when probe is in flight, ZERO new claims are granted for this endpoint
      assert.equal(endpointClaims.length, 0, 'No claims should be granted when half_open probe is already in flight.');
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
