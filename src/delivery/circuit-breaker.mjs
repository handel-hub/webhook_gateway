import pg from 'pg';
import { LIMITS } from '../config/limits.mjs';

/**
 * Destination Endpoint Circuit Breaker State Machine.
 * Prevents continuous network saturation to down or crashing destination hosts.
 */
export const CircuitBreaker = {
  /**
   * Checks whether a delivery can be dispatched to the given endpoint.
   * Handles automatic transition from OPEN to HALF-OPEN after cooldown expires.
   *
   * @param {pg.PoolClient} client
   * @param {string} destinationEndpointId
   * @returns {Promise<{ allowed: boolean, state: 'closed' | 'open' | 'half_open', cooldownRemainingMs?: number }>}
   */
  async canDispatch(client, destinationEndpointId) {
    const res = await client.query(
      `SELECT destination_endpoint_id, state, consecutive_failures, last_failure_at, opened_at, half_open_probe_in_flight
       FROM cwids.circuit_breaker_states
       WHERE destination_endpoint_id = $1`,
      [destinationEndpointId],
    );

    const record = res.rows[0];
    if (!record) {
      // Default initial state is closed
      return { allowed: true, state: 'closed' };
    }

    if (record.state === 'closed') {
      return { allowed: true, state: 'closed' };
    }

    const now = Date.now();
    const openedAt = record.opened_at ? new Date(record.opened_at).getTime() : now;
    const cooldownExpiresAt = openedAt + LIMITS.CIRCUIT_BREAKER_COOLDOWN_MS;

    if (record.state === 'open') {
      if (now >= cooldownExpiresAt) {
        // Cooldown matured -> Transition to HALF-OPEN for single canary probe
        await client.query(
          `UPDATE cwids.circuit_breaker_states
           SET state = 'half_open',
               half_open_probe_in_flight = true,
               updated_at = CURRENT_TIMESTAMP
           WHERE destination_endpoint_id = $1`,
          [destinationEndpointId],
        );
        return { allowed: true, state: 'half_open' };
      } else {
        const cooldownRemainingMs = cooldownExpiresAt - now;
        return { allowed: false, state: 'open', cooldownRemainingMs };
      }
    }

    if (record.state === 'half_open') {
      // If probe already in flight, block other dispatches
      if (record.half_open_probe_in_flight) {
        return { allowed: false, state: 'half_open' };
      }
      return { allowed: true, state: 'half_open' };
    }

    return { allowed: true, state: 'closed' };
  },

  /**
   * Records a successful delivery attempt to the endpoint.
   * Resets failures to 0 and transitions HALF-OPEN back to CLOSED.
   *
   * @param {pg.PoolClient} client
   * @param {string} destinationEndpointId
   * @returns {Promise<void>}
   */
  async recordSuccess(client, destinationEndpointId) {
    await client.query(
      `INSERT INTO cwids.circuit_breaker_states
         (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight, updated_at)
       VALUES ($1, 'closed', 0, false, CURRENT_TIMESTAMP)
       ON CONFLICT (destination_endpoint_id) DO UPDATE
       SET state = 'closed',
           consecutive_failures = 0,
           half_open_probe_in_flight = false,
           opened_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
      [destinationEndpointId],
    );
  },

  /**
   * Records a delivery failure. If consecutive failures cross threshold, trips to OPEN.
   *
   * @param {pg.PoolClient} client
   * @param {string} destinationEndpointId
   * @returns {Promise<'closed' | 'open'>} Resulting circuit breaker state.
   */
  async recordFailure(client, destinationEndpointId) {
    const res = await client.query(
      `SELECT state, consecutive_failures, last_failure_at
       FROM cwids.circuit_breaker_states
       WHERE destination_endpoint_id = $1`,
      [destinationEndpointId],
    );

    const record = res.rows[0];
    const now = Date.now();
    let failures = (record?.consecutive_failures ?? 0) + 1;

    // Reset failure counter if last failure was outside the sliding window
    if (record?.last_failure_at) {
      const lastFailureTime = new Date(record.last_failure_at).getTime();
      if (now - lastFailureTime > LIMITS.CIRCUIT_BREAKER_WINDOW_MS) {
        failures = 1;
      }
    }

    const shouldTrip = failures >= LIMITS.CIRCUIT_BREAKER_FAILURE_THRESHOLD || record?.state === 'half_open';
    const newState = shouldTrip ? 'open' : 'closed';

    await client.query(
      `INSERT INTO cwids.circuit_breaker_states
         (destination_endpoint_id, state, consecutive_failures, last_failure_at, opened_at, half_open_probe_in_flight, updated_at)
       VALUES
         ($1, $2, $3, CURRENT_TIMESTAMP, CASE WHEN $2 = 'open' THEN CURRENT_TIMESTAMP ELSE NULL END, false, CURRENT_TIMESTAMP)
       ON CONFLICT (destination_endpoint_id) DO UPDATE
       SET state = $2,
           consecutive_failures = $3,
           last_failure_at = CURRENT_TIMESTAMP,
           opened_at = CASE WHEN $2 = 'open' THEN CURRENT_TIMESTAMP ELSE cwids.circuit_breaker_states.opened_at END,
           half_open_probe_in_flight = false,
           updated_at = CURRENT_TIMESTAMP`,
      [destinationEndpointId, newState, failures],
    );

    return newState;
  },

  /**
   * Sweeps circuit breakers in 'open' state whose cooldown has elapsed,
   * transitioning them to 'half_open' with half_open_probe_in_flight = false.
   *
   * @param {pg.PoolClient} client
   * @param {number} [cooldownSeconds=120]
   * @returns {Promise<number>} Number of circuit breakers transitioned.
   */
  async sweepCooldowns(client, cooldownSeconds = 120) {
    const res = await client.query(
      `UPDATE cwids.circuit_breaker_states
       SET state = 'half_open',
           half_open_probe_in_flight = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE state = 'open'
         AND opened_at + make_interval(secs => $1) <= CURRENT_TIMESTAMP`,
      [cooldownSeconds],
    );
    return res.rowCount ?? 0;
  },
};

/**
 * Background worker that periodically sweeps matured open circuit breakers into half_open.
 */
export class CircuitBreakerSweeper {
  /**
   * Starts periodic circuit breaker cooldown sweeper.
   * @param {pg.Pool} pool
   * @param {object} [options]
   * @param {number} [options.intervalMs=10000]
   * @param {number} [options.cooldownSeconds=120]
   * @returns {{ stop: () => void }}
   */
  static startSweeper(pool, { intervalMs = 10000, cooldownSeconds = 120 } = {}) {
    const timer = setInterval(async () => {
      try {
        const client = await pool.connect();
        try {
          await CircuitBreaker.sweepCooldowns(client, cooldownSeconds);
        } finally {
          client.release();
        }
      } catch {
        // Suppress background sweeper transient errors
      }
    }, intervalMs);
    timer.unref();

    return {
      stop: () => clearInterval(timer),
    };
  }
}
