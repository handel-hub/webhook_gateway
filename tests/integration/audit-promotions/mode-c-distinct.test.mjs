import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouting } from '../../../src/routing/routing-resolver.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../../helpers/db-test-helper.mjs';

test('Mode C Distinct: Multiple aliases for the same intent resolve to 1 match without quarantining', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Mode C Distinct App' });
    appId = app.id;
    const conn = await createTestProviderConnection(pool, {
      applicationId: null, // Shared connection
      provider: 'paystack',
      environment: 'live',
    });

    // Create an intent
    const intentRes = await pool.query(`
      INSERT INTO cwids.payment_intent_correlations (
        application_id, provider_connection_id, environment, merchant_reference,
        expected_amount_minor, currency, idempotency_key, expires_at, status
      ) VALUES (
        $1, $2, $3, 'REF-DISTINCT-${Date.now()}',
        5000, 'NGN', 'idem-distinct-${Date.now()}', NOW() + INTERVAL '1 hour', 'active'
      ) RETURNING id;
    `, [appId, conn.id, conn.environment]);
    const intent = intentRes.rows[0];

    const provRef = 'TX-PROV-' + Date.now();
    const vaRef = 'VA-ACC-' + Date.now();

    // Add BOTH aliases for the SAME intent
    await pool.query(`
      INSERT INTO cwids.payment_intent_aliases (payment_intent_id, provider_connection_id, environment, alias_type, alias_value)
      VALUES
        ($1, $2, $3, 'provider_reference', $4),
        ($1, $2, $3, 'virtual_account_id', $5);
    `, [intent.id, conn.id, conn.environment, provRef, vaRef]);

    const client = await pool.connect();
    try {
      // Simulate an incoming webhook that carries BOTH provider_reference and virtual_account_id
      const resolution = await resolveRouting(client, {
        providerConnection: conn,
        routingKeys: {
          merchantReference: null,
          providerReference: provRef,
          virtualAccountId: vaRef,
        },
      });

      // Must resolve cleanly to the single tenant, NOT quarantine as ambiguous
      assert.equal(resolution.status, 'resolved', 'Resolution should be resolved, not quarantined.');
      assert.equal(resolution.applicationId, appId);
      assert.equal(resolution.paymentIntentId, intent.id);
      assert.equal(resolution.routingMode, 'MODE_C_DYNAMIC_ALIAS');
    } finally {
      client.release();
    }
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
