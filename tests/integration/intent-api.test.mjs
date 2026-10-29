import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { createInternalApiRouter } from '../../src/admin/internal-api.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

/**
 * Helper to spin up ephemeral Express test server
 * @param {express.Router} router
 * @returns {Promise<{ server: http.Server, baseUrl: string, close: () => Promise<void> }>}
 */
async function startTestServer(router) {
  const app = express();
  app.use('/v1/internal', router);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined));
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Invalid address');
  }

  const baseUrl = `http://127.0.0.1:${addr.port}/v1/internal`;
  return {
    server,
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('Internal Intent & Alias API: Real PostgreSQL Integration Suite', async (t) => {
  const pool = getTestPool();
  let appId = '';
  let rawApiKey = '';
  let connId = '';
  /** @type {any} */
  let testServer;

  try {
    const app = await createTestApp(pool, { name: 'Intent API Test App' });
    appId = app.id;
    rawApiKey = app.rawApiKey;

    const conn = await createTestProviderConnection(pool, {
      applicationId: appId,
      provider: 'flutterwave',
      environment: 'live',
    });
    connId = conn.id;

    const router = createInternalApiRouter({ pool });
    testServer = await startTestServer(router);
    const baseUrl = testServer.baseUrl;

    await t.test('POST /v1/internal/payment-intents: rejects unauthenticated requests', async () => {
      const res = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'UNAUTHORIZED');
    });

    await t.test('POST /v1/internal/payment-intents: registers valid intent and returns 201', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString(); // 1 hour in future
      const idempotencyKey = crypto.randomUUID();
      const merchantRef = `ORDER-INTENT-${crypto.randomBytes(4).toString('hex')}`;

      const res = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: connId,
          environment: 'live',
          merchant_reference: merchantRef,
          expected_amount_minor: 2500000,
          currency: 'NGN',
          expires_at: futureDate,
          aliases: [
            { alias_type: 'virtual_account_id', alias_value: `VA-${crypto.randomBytes(4).toString('hex')}` },
          ],
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.merchant_reference, merchantRef);
      assert.equal(body.expected_amount_minor, 2500000);
      assert.equal(body.currency, 'NGN');
      assert.equal(body.status, 'active');
      assert.ok(body.id);

      // Verify alias was stored in real database
      const aliasRes = await pool.query(
        `SELECT * FROM cwids.payment_intent_aliases WHERE payment_intent_id = $1`,
        [body.id],
      );
      assert.equal(aliasRes.rows.length, 1);
    });

    await t.test('POST /v1/internal/payment-intents: idempotent retry with identical payload returns 200 OK', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const idempotencyKey = crypto.randomUUID();
      const merchantRef = `ORDER-IDEMP-${crypto.randomBytes(4).toString('hex')}`;
      const payload = {
        provider_connection_id: connId,
        environment: 'live',
        merchant_reference: merchantRef,
        expected_amount_minor: 500000,
        currency: 'NGN',
        expires_at: futureDate,
      };

      // First request -> 201 Created
      const res1 = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res1.status, 201);
      const body1 = await res1.json();

      // Second request with same idempotency key -> 200 OK
      const res2 = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.equal(body2.id, body1.id);
    });

    await t.test('POST /v1/internal/payment-intents: idempotent retry with conflicting payload returns 409 Conflict', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const idempotencyKey = crypto.randomUUID();
      const merchantRef = `ORDER-CONF-${crypto.randomBytes(4).toString('hex')}`;

      // First request
      const res1 = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: connId,
          environment: 'live',
          merchant_reference: merchantRef,
          expected_amount_minor: 500000,
          currency: 'NGN',
          expires_at: futureDate,
        }),
      });
      assert.equal(res1.status, 201);

      // Conflicting second request
      const res2 = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: connId,
          environment: 'live',
          merchant_reference: `${merchantRef}-DIFF`,
          expected_amount_minor: 999999,
          currency: 'NGN',
          expires_at: futureDate,
        }),
      });

      assert.equal(res2.status, 409);
      const body2 = await res2.json();
      assert.equal(body2.code, 'IDEMPOTENCY_CONFLICT');
    });

    await t.test('POST /v1/internal/payment-intents: non-integer amount returns 422 INVALID_AMOUNT', async () => {
      const res = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: connId,
          environment: 'live',
          merchant_reference: `ORDER-FLOAT-${crypto.randomBytes(4).toString('hex')}`,
          expected_amount_minor: 250.75, // Floats are invalid!
          currency: 'NGN',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.code, 'INVALID_AMOUNT');
    });

    await t.test('POST /v1/internal/payment-intents/:id/aliases: registers dynamic alias for existing intent', async () => {
      // Create intent first
      const createRes = await fetch(`${baseUrl}/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Idempotency-Key': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: connId,
          environment: 'live',
          merchant_reference: `ORDER-ALIAS-${crypto.randomBytes(4).toString('hex')}`,
          expected_amount_minor: 100000,
          currency: 'NGN',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      assert.equal(createRes.status, 201);
      const intent = await createRes.json();

      // Register dynamic alias
      const aliasValue = `FLW-TX-${crypto.randomBytes(4).toString('hex')}`;
      const aliasRes = await fetch(`${baseUrl}/payment-intents/${intent.id}/aliases`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alias_type: 'provider_reference',
          alias_value: aliasValue,
        }),
      });

      assert.equal(aliasRes.status, 201);
      const aliasBody = await aliasRes.json();
      assert.equal(aliasBody.status, 'success');

      // Verify in database
      const dbCheck = await pool.query(
        `SELECT * FROM cwids.payment_intent_aliases WHERE payment_intent_id = $1 AND alias_value = $2`,
        [intent.id, aliasValue],
      );
      assert.equal(dbCheck.rows.length, 1);
    });
  } finally {
    if (testServer) {
      await testServer.close();
    }
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
