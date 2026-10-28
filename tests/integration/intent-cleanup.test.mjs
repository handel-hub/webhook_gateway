import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentCleanupWorker } from '../../src/maintenance/intent-cleanup.mjs';

function createMockCleanupPool() {
  /** @type {Map<string, any>} */
  const intents = new Map();

  const client = {
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      if (s.includes('SET_CONFIG')) {
        return { rows: [] };
      }

      // IntentsRepo.deleteExpiredUnreferenced
      if (s.includes('DELETE FROM CWIDS.PAYMENT_INTENT_CORRELATIONS TARGET')) {
        const batchLimit = params[0] ?? 1000;
        let deleted = 0;
        for (const [id, intent] of intents.entries()) {
          if (intent.eligibleForDeletion && deleted < batchLimit) {
            intents.delete(id);
            deleted++;
          }
        }
        return { rowCount: deleted };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    intents,
    async connect() {
      return client;
    },
  };
}

test('IntentCleanupWorker: prunes expired unreferenced intents in batches', async () => {
  const mockPool = createMockCleanupPool();

  // 3 eligible for deletion
  mockPool.intents.set('intent_exp_1', { id: 'intent_exp_1', eligibleForDeletion: true });
  mockPool.intents.set('intent_exp_2', { id: 'intent_exp_2', eligibleForDeletion: true });
  mockPool.intents.set('intent_exp_3', { id: 'intent_exp_3', eligibleForDeletion: true });

  // 1 active unexpired (should NOT be deleted)
  mockPool.intents.set('intent_active_1', { id: 'intent_active_1', eligibleForDeletion: false });

  const result = await IntentCleanupWorker.runCleanup(/** @type {any} */ (mockPool), {
    batchSize: 2,
    maxBatches: 5,
  });

  assert.equal(result.totalDeleted, 3);
  assert.equal(mockPool.intents.size, 1);
  assert.ok(mockPool.intents.has('intent_active_1'));
});
