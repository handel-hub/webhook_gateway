import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/delivery/circuit-breaker.mjs';
import { LIMITS } from '../../src/config/limits.mjs';

/**
 * Creates an in-memory mock pg.PoolClient for circuit breaker state testing.
 */
function createMockClient() {
  /** @type {Map<string, { destination_endpoint_id: string, state: string, consecutive_failures: number, last_failure_at: Date | null, opened_at: Date | null, half_open_probe_in_flight: boolean, updated_at: Date }>} */
  const store = new Map();

  return {
    store,
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      // SELECT destination_endpoint_id, state, consecutive_failures...
      if (normalizedSql.startsWith('SELECT')) {
        const endpointId = params[0];
        const record = store.get(endpointId);
        return {
          rows: record ? [{ ...record }] : [],
          rowCount: record ? 1 : 0,
        };
      }

      // UPDATE cwids.circuit_breaker_states SET state = 'half_open'...
      if (normalizedSql.startsWith('UPDATE')) {
        const endpointId = params[0];
        const existing = store.get(endpointId);
        if (existing) {
          existing.state = 'half_open';
          existing.half_open_probe_in_flight = true;
          existing.updated_at = new Date();
        }
        return { rows: [], rowCount: existing ? 1 : 0 };
      }

      // INSERT INTO cwids.circuit_breaker_states ... (recordSuccess or recordFailure)
      if (normalizedSql.startsWith('INSERT INTO cwids.circuit_breaker_states')) {
        const endpointId = params[0];
        const existing = store.get(endpointId);

        if (normalizedSql.includes("VALUES ($1, 'closed', 0, false")) {
          // recordSuccess
          store.set(endpointId, {
            destination_endpoint_id: endpointId,
            state: 'closed',
            consecutive_failures: 0,
            last_failure_at: existing ? existing.last_failure_at : null,
            opened_at: null,
            half_open_probe_in_flight: false,
            updated_at: new Date(),
          });
        } else {
          // recordFailure: params = [endpointId, newState, failures]
          const newState = params[1];
          const failures = params[2];
          const now = new Date();

          store.set(endpointId, {
            destination_endpoint_id: endpointId,
            state: newState,
            consecutive_failures: failures,
            last_failure_at: now,
            opened_at: newState === 'open' ? (existing?.opened_at ?? now) : null,
            half_open_probe_in_flight: false,
            updated_at: now,
          });
        }
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled mock query: ${sql}`);
    },
  };
}

test('CircuitBreaker: defaults to CLOSED and allows dispatch for new endpoint', async () => {
  const client = /** @type {any} */ (createMockClient());
  const status = await CircuitBreaker.canDispatch(client, 'ep_123');

  assert.equal(status.allowed, true);
  assert.equal(status.state, 'closed');
});

test('CircuitBreaker: trips to OPEN after reaching failure threshold within window', async () => {
  const client = /** @type {any} */ (createMockClient());
  const endpointId = 'ep_trip_test';

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
});

test('CircuitBreaker: transitions from OPEN to HALF-OPEN after cooldown expires', async () => {
  const client = /** @type {any} */ (createMockClient());
  const endpointId = 'ep_cooldown_test';

  // Force trip to open with past opened_at
  const now = Date.now();
  const expiredOpenedAt = new Date(now - (LIMITS.CIRCUIT_BREAKER_COOLDOWN_MS + 1000));

  client.store.set(endpointId, {
    destination_endpoint_id: endpointId,
    state: 'open',
    consecutive_failures: 5,
    last_failure_at: expiredOpenedAt,
    opened_at: expiredOpenedAt,
    half_open_probe_in_flight: false,
    updated_at: expiredOpenedAt,
  });

  // Check canDispatch: cooldown has expired -> moves to half_open with probe in flight
  const check = await CircuitBreaker.canDispatch(client, endpointId);
  assert.equal(check.allowed, true);
  assert.equal(check.state, 'half_open');

  // Next dispatch while probe is in flight is blocked
  const checkProbeInFlight = await CircuitBreaker.canDispatch(client, endpointId);
  assert.equal(checkProbeInFlight.allowed, false);
  assert.equal(checkProbeInFlight.state, 'half_open');
});

test('CircuitBreaker: probe success resets HALF-OPEN to CLOSED', async () => {
  const client = /** @type {any} */ (createMockClient());
  const endpointId = 'ep_probe_success';

  client.store.set(endpointId, {
    destination_endpoint_id: endpointId,
    state: 'half_open',
    consecutive_failures: 5,
    last_failure_at: new Date(),
    opened_at: new Date(),
    half_open_probe_in_flight: true,
    updated_at: new Date(),
  });

  await CircuitBreaker.recordSuccess(client, endpointId);

  const check = await CircuitBreaker.canDispatch(client, endpointId);
  assert.equal(check.allowed, true);
  assert.equal(check.state, 'closed');

  const rec = client.store.get(endpointId);
  assert.equal(rec?.consecutive_failures, 0);
  assert.equal(rec?.half_open_probe_in_flight, false);
});

test('CircuitBreaker: probe failure trips HALF-OPEN immediately back to OPEN', async () => {
  const client = /** @type {any} */ (createMockClient());
  const endpointId = 'ep_probe_failure';

  client.store.set(endpointId, {
    destination_endpoint_id: endpointId,
    state: 'half_open',
    consecutive_failures: 5,
    last_failure_at: new Date(),
    opened_at: new Date(),
    half_open_probe_in_flight: true,
    updated_at: new Date(),
  });

  const state = await CircuitBreaker.recordFailure(client, endpointId);
  assert.equal(state, 'open');

  const check = await CircuitBreaker.canDispatch(client, endpointId);
  assert.equal(check.allowed, false);
  assert.equal(check.state, 'open');
});
