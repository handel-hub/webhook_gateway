import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveRouting } from '../../src/routing/routing-resolver.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('Routing Resolver: Real PostgreSQL Integration Suite', async (t) => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Routing Resolver App' });
    appId = app.id;

    const sharedConn = await createTestProviderConnection(pool, {
      applicationId: null, // Shared connection
      provider: 'paystack',
      environment: 'live',
    });

    const dedicatedConn = await createTestProviderConnection(pool, {
      applicationId: appId, // Dedicated connection
      provider: 'flutterwave',
      environment: 'live',
    });

    await t.test('Mode B resolves directly on dedicated connection without DB queries', async () => {
      let queryCalled = false;
      const dummyClient = {
        async query() {
          queryCalled = true;
          return { rows: [] };
        },
      };

      const result = await resolveRouting(/** @type {any} */ (dummyClient), {
        providerConnection: dedicatedConn,
        routingKeys: { merchantReference: 'ref_1', providerReference: null, virtualAccountId: null },
      });

      assert.equal(result.status, 'resolved');
      assert.equal(result.applicationId, appId);
      assert.equal(result.routingMode, 'MODE_B_DEDICATED_CONNECTION');
      assert.equal(queryCalled, false);
    });

    await t.test('Mode A matches merchant reference for active payment intent', async () => {
      const client = await pool.connect();
      try {
        const merchantRef = `ORD-ACTIVE-${crypto.randomBytes(4).toString('hex')}`;
        const res = await client.query(
          `INSERT INTO cwids.payment_intent_correlations
             (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
           VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP + interval '1 day', 'active')
           RETURNING id`,
          [appId, sharedConn.id, sharedConn.environment, merchantRef, `idem-${merchantRef}`],
        );
        const intentId = res.rows[0].id;

        const result = await resolveRouting(client, {
          providerConnection: sharedConn,
          routingKeys: { merchantReference: merchantRef, providerReference: null, virtualAccountId: null },
        });

        assert.equal(result.status, 'resolved');
        assert.equal(result.applicationId, appId);
        assert.equal(result.paymentIntentId, intentId);
        assert.equal(result.routingMode, 'MODE_A_MERCHANT_REFERENCE');
      } finally {
        client.release();
      }
    });

    await t.test('Mode A matches consumed intent and expired intent within 7-day grace period', async () => {
      const client = await pool.connect();
      try {
        // Consumed intent expired 2 days ago (within 7-day grace)
        const merchantRef = `ORD-CONSUMED-${crypto.randomBytes(4).toString('hex')}`;
        const res = await client.query(
          `INSERT INTO cwids.payment_intent_correlations
             (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
           VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP - interval '2 days', 'consumed')
           RETURNING id`,
          [appId, sharedConn.id, sharedConn.environment, merchantRef, `idem-${merchantRef}`],
        );
        const intentId = res.rows[0].id;

        const result = await resolveRouting(client, {
          providerConnection: sharedConn,
          routingKeys: { merchantReference: merchantRef, providerReference: null, virtualAccountId: null },
        });

        assert.equal(result.status, 'resolved');
        assert.equal(result.applicationId, appId);
        assert.equal(result.paymentIntentId, intentId);
        assert.equal(result.routingMode, 'MODE_A_MERCHANT_REFERENCE');
      } finally {
        client.release();
      }
    });

    await t.test('Mode C matches dynamic provider reference alias', async () => {
      const client = await pool.connect();
      try {
        const merchantRef = `ORD-ALIAS-BASE-${crypto.randomBytes(4).toString('hex')}`;
        const aliasVal = `flw_dyn_${crypto.randomBytes(4).toString('hex')}`;

        const intentRes = await client.query(
          `INSERT INTO cwids.payment_intent_correlations
             (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
           VALUES ($1, $2, $3, $4, 100000, 'NGN', $5, CURRENT_TIMESTAMP + interval '1 day', 'active')
           RETURNING id`,
          [appId, sharedConn.id, sharedConn.environment, merchantRef, `idem-${merchantRef}`],
        );
        const intentId = intentRes.rows[0].id;

        await client.query(
          `INSERT INTO cwids.payment_intent_aliases
             (payment_intent_id, provider_connection_id, environment, alias_type, alias_value)
           VALUES ($1, $2, $3, 'provider_reference', $4)`,
          [intentId, sharedConn.id, sharedConn.environment, aliasVal],
        );

        const result = await resolveRouting(client, {
          providerConnection: sharedConn,
          routingKeys: {
            merchantReference: 'UNMATCHED_MERCHANT_REF',
            providerReference: aliasVal,
            virtualAccountId: null,
          },
        });

        assert.equal(result.status, 'resolved');
        assert.equal(result.applicationId, appId);
        assert.equal(result.paymentIntentId, intentId);
        assert.equal(result.routingMode, 'MODE_C_DYNAMIC_ALIAS');
      } finally {
        client.release();
      }
    });

    await t.test('Mode D returns awaiting_route when no candidates match', async () => {
      const client = await pool.connect();
      try {
        const result = await resolveRouting(client, {
          providerConnection: sharedConn,
          routingKeys: { merchantReference: 'UNKNOWN_ORD_REF', providerReference: null, virtualAccountId: null },
        });

        assert.equal(result.status, 'awaiting_route');
        assert.equal(result.applicationId, null);
        assert.equal(result.paymentIntentId, null);
        assert.equal(result.routingMode, 'UNRESOLVED_NO_MATCH');
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
