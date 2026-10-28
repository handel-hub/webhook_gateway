import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditExporter } from '../../src/maintenance/audit-exporter.mjs';

function createMockOutboxPool() {
  /** @type {Map<number, any>} */
  const outbox = new Map([
    [1, { id: 1, auditEventId: 'evt_1', payload: { action: 'app.create' }, status: 'pending' }],
    [2, { id: 2, auditEventId: 'evt_2', payload: { action: 'delivery.redrive' }, status: 'pending' }],
  ]);

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

      // AuditOutboxRepo.fetchPending
      if (s.includes('FROM CWIDS.AUDIT_OUTBOX') && s.includes("STATUS = 'PENDING'")) {
        const limit = params[0] ?? 100;
        const pending = Array.from(outbox.values())
          .filter((row) => row.status === 'pending')
          .slice(0, limit);
        return { rows: pending };
      }

      // AuditOutboxRepo.markExported
      if (s.includes('UPDATE CWIDS.AUDIT_OUTBOX') && s.includes("SET STATUS = 'EXPORTED'")) {
        const ids = params[0];
        let count = 0;
        for (const id of ids) {
          const row = outbox.get(Number(id));
          if (row) {
            row.status = 'exported';
            count++;
          }
        }
        return { rowCount: count };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    outbox,
    async connect() {
      return client;
    },
  };
}

test('AuditExporter: drains pending outbox records and marks them exported', async () => {
  const mockPool = createMockOutboxPool();
  /** @type {any[]} */
  const exported = [];

  const count = await AuditExporter.exportBatch(/** @type {any} */ (mockPool), 10, (rec) => {
    exported.push(rec);
  });

  assert.equal(count, 2);
  assert.equal(exported.length, 2);
  assert.equal(exported[0].id, 1);
  assert.equal(exported[1].id, 2);

  // Assert outbox rows marked exported in DB
  assert.equal(mockPool.outbox.get(1)?.status, 'exported');
  assert.equal(mockPool.outbox.get(2)?.status, 'exported');
});
