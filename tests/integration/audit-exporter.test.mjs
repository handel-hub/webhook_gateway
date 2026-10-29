import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuditExporter } from '../../src/maintenance/audit-exporter.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('AuditExporter: Real PostgreSQL Integration Suite', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Audit Exporter App' });
    appId = app.id;

    // 1. Seed 2 administrative audit events and 2 outbox entries in 'pending' status
    /** @type {number[]} */
    const outboxIds = [];
    for (let i = 1; i <= 2; i++) {
      const auditRes = await pool.query(
        `INSERT INTO cwids.administrative_audit_events
           (id, actor_identity, application_id, action, target_type, target_id, request_id, outcome, audit_class, legal_hold)
         VALUES
           (gen_random_uuid(), 'admin', $1, $2, 'application', $3, gen_random_uuid(), 'success', 'operational', false)
         RETURNING id`,
        [appId, `test.action.${i}`, appId],
      );
      const auditId = auditRes.rows[0].id;

      const outboxRes = await pool.query(
        `INSERT INTO cwids.audit_outbox
           (audit_event_id, payload, status)
         VALUES
           ($1, $2, 'pending')
         RETURNING id`,
        [auditId, JSON.stringify({ action: `test.action.${i}`, appId })],
      );
      outboxIds.push(Number(outboxRes.rows[0].id));
    }

    /** @type {any[]} */
    const exported = [];

    // 2. Export batch
    const count = await AuditExporter.exportBatch(pool, 10, (rec) => {
      exported.push(rec);
    });

    assert.ok(count >= 2, 'Should export at least 2 records');
    const matched = exported.filter((e) => outboxIds.includes(Number(e.id)));
    assert.equal(matched.length, 2);

    // 3. Assert outbox rows are marked as 'exported' in real DB
    const checkOutbox = await pool.query(
      `SELECT id, status FROM cwids.audit_outbox WHERE id = ANY($1::bigint[])`,
      [outboxIds],
    );
    assert.equal(checkOutbox.rows.length, 2);
    for (const row of checkOutbox.rows) {
      assert.equal(row.status, 'exported');
    }
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
