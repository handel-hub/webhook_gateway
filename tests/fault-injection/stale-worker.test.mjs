import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveriesRepo } from '../../src/db/repositories/deliveries-repo.mjs';

function createMockFencingPool() {
  /** @type {Map<string, { id: string, status: string, fencing_token: number, lease_expires_at: Date | null, claimed_by_worker: string | null }>} */
  const deliveries = new Map([
    [
      'deliv_fence_test',
      {
        id: 'deliv_fence_test',
        status: 'in_flight',
        fencing_token: 1, // Worker 1 owns token 1
        lease_expires_at: new Date(Date.now() - 5000), // Lease expired 5s ago!
        claimed_by_worker: 'worker_slow_1',
      },
    ],
  ]);

  const client = {
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // Lease recovery sweep:
      if (s.includes('EVENT_DELIVERIES') && s.includes('LEASE_EXPIRES_AT < CURRENT_TIMESTAMP')) {
        let count = 0;
        const now = Date.now();
        for (const deliv of deliveries.values()) {
          if (deliv.status === 'in_flight' && deliv.lease_expires_at && deliv.lease_expires_at.getTime() < now) {
            deliv.status = 'retry_scheduled';
            deliv.lease_expires_at = null;
            count++;
          }
        }
        return { rowCount: count };
      }

      // Worker 2 claims the recovered job:
      // UPDATE event_deliveries SET status = 'in_flight', fencing_token = target.fencing_token + 1
      if (s.includes("SET STATUS = 'IN_FLIGHT'") && s.includes('FENCING_TOKEN = TARGET.FENCING_TOKEN + 1')) {
        const workerId = params[2];
        const deliv = deliveries.get('deliv_fence_test');
        if (deliv && ['pending', 'retry_scheduled'].includes(deliv.status)) {
          deliv.status = 'in_flight';
          deliv.fencing_token += 1; // Token increments to 2!
          deliv.claimed_by_worker = workerId;
          deliv.lease_expires_at = new Date(Date.now() + 30000);
          return {
            rows: [
              {
                deliveryId: deliv.id,
                fencingToken: deliv.fencing_token,
              },
            ],
          };
        }
        return { rows: [] };
      }

      // Complete delivery with fencing token match:
      // UPDATE cwids.event_deliveries SET status = 'delivered' WHERE id = $1 AND fencing_token = $2 AND status = 'in_flight'
      if (s.includes("SET STATUS = 'DELIVERED'") && s.includes('WHERE ID = $1 AND FENCING_TOKEN = $2 AND STATUS = \'IN_FLIGHT\'')) {
        const id = params[0];
        const token = params[1];
        const deliv = deliveries.get(id);

        if (deliv && deliv.status === 'in_flight' && deliv.fencing_token === token) {
          deliv.status = 'delivered';
          return { rowCount: 1 };
        }
        // Token mismatch or not in_flight!
        return { rowCount: 0 };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    deliveries,
    async connect() {
      return client;
    },
  };
}

test('Fencing Token Integrity (TC-16): Stale worker with expired lease cannot overwrite newer database state', async () => {
  const mockPool = createMockFencingPool();
  const client = await mockPool.connect();

  const deliveryId = 'deliv_fence_test';
  const worker1FencingToken = 1;

  // 1. Lease recovery sweep runs because Worker 1's lease expired
  const recoveredCount = await DeliveriesRepo.recoverExpiredLeases(/** @type {any} */ (client));
  assert.equal(recoveredCount, 1);
  assert.equal(mockPool.deliveries.get(deliveryId)?.status, 'retry_scheduled');

  // 2. Worker 2 claims the recovered job, advancing the fencing token to 2
  const worker2Claims = await client.query(
    'UPDATE event_deliveries SET status = \'in_flight\', fencing_token = target.fencing_token + 1',
    [1, 30, 'worker_fast_2'],
  );
  assert.ok(worker2Claims.rows && worker2Claims.rows[0]);
  assert.equal(worker2Claims.rows[0].fencingToken, 2);
  assert.equal(mockPool.deliveries.get(deliveryId)?.fencing_token, 2);

  // 3. Stale Worker 1 wakes up and attempts to mark the delivery as 'delivered' using stale fencing token 1
  const updateSuccess = await DeliveriesRepo.completeDelivery(
    /** @type {any} */ (client),
    deliveryId,
    worker1FencingToken,
  );

  // Invariant assertion: Update was rejected! 0 rows affected!
  assert.equal(updateSuccess, false, 'Stale worker update was not rejected by database fencing token!');

  // Delivery status in DB was not overwritten by Worker 1
  assert.equal(mockPool.deliveries.get(deliveryId)?.status, 'in_flight');
  assert.equal(mockPool.deliveries.get(deliveryId)?.fencing_token, 2);
});
