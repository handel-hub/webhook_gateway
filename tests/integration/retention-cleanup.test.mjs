import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RetentionWorker } from '../../src/maintenance/retention-worker.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('Data Retention & Classified Audits: Real PostgreSQL Integration Suite', async (t) => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Retention Test App' });
    appId = app.id;
    const conn = await createTestProviderConnection(pool, { applicationId: appId });

    await t.test('prunes 30-day raw encrypted payloads while preserving metadata', async () => {
      const now = Date.now();
      const thirtyFiveDaysAgo = new Date(now - 35 * 24 * 3600 * 1000);
      const tenDaysAgo = new Date(now - 10 * 24 * 3600 * 1000);

      const oldDedupe = `ret-old-${crypto.randomBytes(4).toString('hex')}`;
      const oldRes = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256, encrypted_payload, wrapped_dek, received_at, legal_hold)
         VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-old', 'resolved', 'mode_a', 'v1', 'sha_old', $6, $7, $8, false)
         RETURNING id`,
        [appId, conn.id, conn.provider, conn.environment, oldDedupe, Buffer.from('old_bytes'), Buffer.alloc(48), thirtyFiveDaysAgo],
      );
      const oldEventId = oldRes.rows[0].id;

      const recentDedupe = `ret-rec-${crypto.randomBytes(4).toString('hex')}`;
      const recRes = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256, encrypted_payload, wrapped_dek, received_at, legal_hold)
         VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-rec', 'resolved', 'mode_a', 'v1', 'sha_rec', $6, $7, $8, false)
         RETURNING id`,
        [appId, conn.id, conn.provider, conn.environment, recentDedupe, Buffer.from('rec_bytes'), Buffer.alloc(48), tenDaysAgo],
      );
      const recEventId = recRes.rows[0].id;

      // Execute retention sweep
      const result = await RetentionWorker.runRetentionSweep(pool, {
        rawPayloadRetentionDays: 30,
        normalizedMetadataRetentionDays: 90,
        operationalAuditRetentionDays: 365,
        securityAuditRetentionDays: 2555,
      });

      assert.ok(result.payloadsPruned >= 1, 'Should prune at least the old payload');

      // Verify in DB that old event payload is nullified and metadata is intact
      const checkOld = await pool.query(
        `SELECT encrypted_payload, wrapped_dek, payload_deleted_at, dedupe_key FROM cwids.webhook_events WHERE id = $1`,
        [oldEventId],
      );
      assert.equal(checkOld.rows[0].encrypted_payload, null);
      assert.equal(checkOld.rows[0].wrapped_dek, null);
      assert.notEqual(checkOld.rows[0].payload_deleted_at, null);
      assert.equal(checkOld.rows[0].dedupe_key, oldDedupe);

      // Verify in DB that recent event payload is NOT touched
      const checkRec = await pool.query(
        `SELECT encrypted_payload, payload_deleted_at FROM cwids.webhook_events WHERE id = $1`,
        [recEventId],
      );
      assert.notEqual(checkRec.rows[0].encrypted_payload, null);
      assert.equal(checkRec.rows[0].payload_deleted_at, null);
    });

    await t.test('legal_hold = TRUE strictly bypasses payload pruning and metadata purging', async () => {
      const oneHundredDaysAgo = new Date(Date.now() - 100 * 24 * 3600 * 1000);
      const legalDedupe = `ret-legal-${crypto.randomBytes(4).toString('hex')}`;

      const res = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256, encrypted_payload, wrapped_dek, received_at, legal_hold)
         VALUES ($1, $2, $3, $4, 1, $5, 'dispute.created', 'dispute', 'ref-legal', 'resolved', 'mode_a', 'v1', 'sha_legal', $6, $7, $8, true)
         RETURNING id`,
        [appId, conn.id, conn.provider, conn.environment, legalDedupe, Buffer.from('dispute_evidence'), Buffer.alloc(48), oneHundredDaysAgo],
      );
      const legalEventId = res.rows[0].id;

      await RetentionWorker.runRetentionSweep(pool, {
        rawPayloadRetentionDays: 30,
        normalizedMetadataRetentionDays: 90,
      });

      // Event must still exist and payload must remain intact
      const check = await pool.query(
        `SELECT encrypted_payload, payload_deleted_at FROM cwids.webhook_events WHERE id = $1`,
        [legalEventId],
      );
      assert.equal(check.rows.length, 1);
      assert.notEqual(check.rows[0].encrypted_payload, null);
      assert.equal(check.rows[0].payload_deleted_at, null);
    });

    await t.test('purges classified audits according to purpose (365d operational vs 7y security)', async () => {
      const fourHundredDaysAgo = new Date(Date.now() - 400 * 24 * 3600 * 1000);

      const opRes = await pool.query(
        `INSERT INTO cwids.administrative_audit_events
           (id, actor_identity, application_id, action, target_type, target_id, request_id, outcome, audit_class, legal_hold, created_at)
         VALUES
           (gen_random_uuid(), 'system', $1, 'delivery.attempt', 'event_delivery', $2, gen_random_uuid(), 'success', 'operational', false, $3)
         RETURNING id`,
        [appId, crypto.randomUUID(), fourHundredDaysAgo],
      );
      const opAuditId = opRes.rows[0].id;

      const secRes = await pool.query(
        `INSERT INTO cwids.administrative_audit_events
           (id, actor_identity, application_id, action, target_type, target_id, request_id, outcome, audit_class, legal_hold, created_at)
         VALUES
           (gen_random_uuid(), 'admin', $1, 'application.key_rotated', 'application', $2, gen_random_uuid(), 'success', 'security', false, $3)
         RETURNING id`,
        [appId, String(appId), fourHundredDaysAgo],
      );
      const secAuditId = secRes.rows[0].id;

      const sweepResult = await RetentionWorker.runRetentionSweep(pool, {
        operationalAuditRetentionDays: 365,
        securityAuditRetentionDays: 2555,
      });

      assert.ok(sweepResult.auditsPurged >= 1, 'Should purge the operational audit');

      // Verify DB: Operational audit was deleted
      const checkOp = await pool.query(
        `SELECT id FROM cwids.administrative_audit_events WHERE id = $1`,
        [opAuditId],
      );
      assert.equal(checkOp.rows.length, 0);

      // Verify DB: Security audit was retained!
      const checkSec = await pool.query(
        `SELECT id FROM cwids.administrative_audit_events WHERE id = $1`,
        [secAuditId],
      );
      assert.equal(checkSec.rows.length, 1);
    });
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
