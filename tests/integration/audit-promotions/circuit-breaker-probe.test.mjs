import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DeliveriesRepo } from '../../../src/db/repositories/deliveries-repo.mjs';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('Circuit Breaker Probe: half_open endpoints permit exactly 1 concurrent probe', async (t) => {
  if (!dbUrl) {
    t.skip('No TEST_DATABASE_URL or DATABASE_URL provided. Skipping.');
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    t.skip(`Cannot connect to PostgreSQL at ${dbUrl}: ${msg}`);
    return;
  }

  /** @type {any} */
  let endp;
  try {
    await client.query('SET search_path TO cwids, public;');

    // Find an active endpoint
    endp = (await client.query('SELECT id, application_id FROM destination_endpoints LIMIT 1')).rows[0];
    if (!endp) {
      t.skip('No destination endpoint seeded. Skipping.');
      return;
    }

    // Set circuit breaker to half_open with probe in flight
    await client.query(`
      INSERT INTO circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight)
      VALUES ($1, 'half_open', 5, true)
      ON CONFLICT (destination_endpoint_id) DO UPDATE
      SET state = 'half_open', consecutive_failures = 5, half_open_probe_in_flight = true;
    `, [endp.id]);

    // Claim batch of 10
    const claims = await DeliveriesRepo.claimBatch(/** @type {any} */ (client), 10, 30, 'probe_test_worker');
    const endpointClaims = claims.filter((c) => c.destinationEndpointId === endp.id);

    // Assert that when probe is in flight, ZERO new claims are granted for this endpoint
    assert.equal(endpointClaims.length, 0, 'No claims should be granted when half_open probe is already in flight.');
  } finally {
    if (endp) {
      await client.query(`
        UPDATE circuit_breaker_states
        SET state = 'closed', half_open_probe_in_flight = false
        WHERE destination_endpoint_id = $1;
      `, [endp.id]);
    }
    await client.end();
  }
});
