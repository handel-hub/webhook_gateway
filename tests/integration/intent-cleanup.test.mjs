import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IntentCleanupWorker } from '../../src/maintenance/intent-cleanup.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('IntentCleanupWorker: Real PostgreSQL Integration Suite', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Intent Cleanup App' });
    appId = app.id;
    const conn = await createTestProviderConnection(pool, { applicationId: appId });

    // 1. Seed 3 expired unreferenced intents (> 7 days expired)
    const expiredIds = [];
    for (let i = 1; i <= 3; i++) {
      const ref = `EXP-${i}-${crypto.randomBytes(4).toString('hex')}`;
      const res = await pool.query(
        `INSERT INTO cwids.payment_intent_correlations
           (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
         VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP - INTERVAL '10 days', 'expired')
         RETURNING id`,
        [appId, conn.id, conn.environment, ref, `idem-${ref}`],
      );
      expiredIds.push(res.rows[0].id);
    }

    // 2. Seed 1 active unexpired intent
    const activeRef = `ACT-${crypto.randomBytes(4).toString('hex')}`;
    const activeRes = await pool.query(
      `INSERT INTO cwids.payment_intent_correlations
         (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
       VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP + INTERVAL '1 day', 'active')
       RETURNING id`,
      [appId, conn.id, conn.environment, activeRef, `idem-${activeRef}`],
    );
    const activeId = activeRes.rows[0].id;

    // 3. Seed 1 expired intent (> 7 days expired) BUT referenced by a webhook event
    const refRef = `EXP-REFERENCED-${crypto.randomBytes(4).toString('hex')}`;
    const referencedRes = await pool.query(
      `INSERT INTO cwids.payment_intent_correlations
         (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
       VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP - INTERVAL '10 days', 'consumed')
       RETURNING id`,
      [appId, conn.id, conn.environment, refRef, `idem-${refRef}`],
    );
    const referencedId = referencedRes.rows[0].id;

    await pool.query(
      `INSERT INTO cwids.webhook_events 
         (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, payment_intent_id, routing_status, routing_mode, kek_version, payload_sha256)
       VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-consumed', $6, 'resolved', 'mode_a', 'v1', 'dummy_sha')`,
      [appId, conn.id, conn.provider, conn.environment, `dedupe-${refRef}`, referencedId],
    );

    // 4. Run cleanup worker in batches of 2
    const result = await IntentCleanupWorker.runCleanup(pool, {
      batchSize: 2,
      maxBatches: 5,
    });

    assert.ok(result.totalDeleted >= 3, 'Should delete at least the 3 expired unreferenced intents');

    // 5. Verify unreferenced expired intents are deleted from DB
    const checkDeleted = await pool.query(
      `SELECT id FROM cwids.payment_intent_correlations WHERE id = ANY($1::uuid[])`,
      [expiredIds],
    );
    assert.equal(checkDeleted.rows.length, 0);

    // 6. Verify active intent is preserved
    const checkActive = await pool.query(
      `SELECT id FROM cwids.payment_intent_correlations WHERE id = $1`,
      [activeId],
    );
    assert.equal(checkActive.rows.length, 1);

    // 7. Verify referenced expired intent is preserved!
    const checkReferenced = await pool.query(
      `SELECT id FROM cwids.payment_intent_correlations WHERE id = $1`,
      [referencedId],
    );
    assert.equal(checkReferenced.rows.length, 1);
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
