import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/delivery/circuit-breaker.mjs';
import { LIMITS } from '../../src/config/limits.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('CircuitBreaker: Real PostgreSQL integration test suite', async (t) => {
  const pool = getTestPool();
  let appId = '';
  let endpointId = '';

  try {
    const app = await createTestApp(pool, { name: 'Circuit Breaker Test App' });
    appId = app.id;
    const endpoint = await createTestEndpoint(pool, appId, {
      url: 'https://example.com/webhook-cb',
    });
    endpointId = endpoint.id;

    await t.test('defaults to CLOSED and allows dispatch for new endpoint', async () => {
      const client = await pool.connect();
      try {
        const status = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(status.allowed, true);
        assert.equal(status.state, 'closed');
      } finally {
        client.release();
      }
    });

    await t.test('trips to OPEN after reaching failure threshold within window', async () => {
      const client = await pool.connect();
      try {
        // 4 failures (threshold is 5)
        for (let i = 1; i <= 4; i++) {
          const state = await CircuitBreaker.recordFailure(client, endpointId);
          assert.equal(state, 'closed');
          const check = await CircuitBreaker.canDispatch(client, endpointId);
          assert.equal(check.allowed, true);
          assert.equal(check.state, 'closed');
        }

        // 5th failure trips the circuit breaker
        const finalState = await CircuitBreaker.recordFailure(client, endpointId);
        assert.equal(finalState, 'open');

        const checkBlocked = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(checkBlocked.allowed, false);
        assert.equal(checkBlocked.state, 'open');
        assert.ok(typeof checkBlocked.cooldownRemainingMs === 'number' && checkBlocked.cooldownRemainingMs > 0);
      } finally {
        client.release();
      }
    });

    await t.test('transitions from OPEN to HALF-OPEN after cooldown expires', async () => {
      const client = await pool.connect();
      try {
        // Artificially age the opened_at timestamp past the cooldown period
        await client.query(
          `UPDATE cwids.circuit_breaker_states
           SET opened_at = CURRENT_TIMESTAMP - interval '200 seconds',
               updated_at = CURRENT_TIMESTAMP - interval '200 seconds'
           WHERE destination_endpoint_id = $1`,
          [endpointId],
        );

        // Check canDispatch: cooldown has expired -> moves to half_open with probe in flight
        const check = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(check.allowed, true);
        assert.equal(check.state, 'half_open');

        // Next dispatch while probe is in flight is blocked
        const checkProbeInFlight = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(checkProbeInFlight.allowed, false);
        assert.equal(checkProbeInFlight.state, 'half_open');
      } finally {
        client.release();
      }
    });

    await t.test('probe success resets HALF-OPEN to CLOSED', async () => {
      const client = await pool.connect();
      try {
        await CircuitBreaker.recordSuccess(client, endpointId);

        const check = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(check.allowed, true);
        assert.equal(check.state, 'closed');

        const res = await client.query(
          `SELECT consecutive_failures, half_open_probe_in_flight FROM cwids.circuit_breaker_states WHERE destination_endpoint_id = $1`,
          [endpointId],
        );
        assert.equal(res.rows[0].consecutive_failures, 0);
        assert.equal(res.rows[0].half_open_probe_in_flight, false);
      } finally {
        client.release();
      }
    });

    await t.test('probe failure trips HALF-OPEN immediately back to OPEN', async () => {
      const client = await pool.connect();
      try {
        // Set to half_open with probe in flight
        await client.query(
          `UPDATE cwids.circuit_breaker_states
           SET state = 'half_open',
               half_open_probe_in_flight = true,
               consecutive_failures = 5
           WHERE destination_endpoint_id = $1`,
          [endpointId],
        );

        const state = await CircuitBreaker.recordFailure(client, endpointId);
        assert.equal(state, 'open');

        const check = await CircuitBreaker.canDispatch(client, endpointId);
        assert.equal(check.allowed, false);
        assert.equal(check.state, 'open');
      } finally {
        client.release();
      }
    });

    await t.test('sweepCooldowns transitions expired OPEN breakers to HALF-OPEN', async () => {
      const client = await pool.connect();
      try {
        // Set breaker to open in the past
        await client.query(
          `UPDATE cwids.circuit_breaker_states
           SET state = 'open',
               opened_at = CURRENT_TIMESTAMP - interval '150 seconds'
           WHERE destination_endpoint_id = $1`,
          [endpointId],
        );

        const swept = await CircuitBreaker.sweepCooldowns(client, 120);
        assert.ok(swept >= 1, 'Should sweep at least 1 open breaker');

        const res = await client.query(
          `SELECT state, half_open_probe_in_flight FROM cwids.circuit_breaker_states WHERE destination_endpoint_id = $1`,
          [endpointId],
        );
        assert.equal(res.rows[0].state, 'half_open');
        assert.equal(res.rows[0].half_open_probe_in_flight, false);
      } finally {
        client.release();
      }
    });
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
