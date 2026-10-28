import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { createInternalApiRouter } from '../../src/admin/internal-api.mjs';

/**
 * Creates an in-memory mock PostgreSQL pool for testing the internal API.
 */
function createMockPool() {
  const apiKey = 'test_app_key_secret_12345';
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  const apps = new Map([
    [
      apiKeyHash,
      {
        id: 'app_test_111',
        code: 'app_test',
        name: 'Test Application',
        status: 'active',
        api_key_hash: apiKeyHash,
      },
    ],
  ]);

  /** @type {Map<string, any>} */
  const intentsById = new Map();
  /** @type {Map<string, any>} */
  const intentsByIdempotency = new Map();
  /** @type {Map<string, any>} */
  const intentsByMerchantRef = new Map();
  /** @type {any[]} */
  const aliases = [];

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

      // Application lookup by API key hash
      if (s.includes('FROM CWIDS.APPLICATIONS WHERE API_KEY_HASH')) {
        const hash = params[0];
        const app = apps.get(hash);
        return { rows: app ? [app] : [] };
      }

      // Find intent by idempotency key
      if (s.includes('FROM CWIDS.PAYMENT_INTENT_CORRELATIONS') && s.includes('IDEMPOTENCY_KEY = $2')) {
        const appId = params[0];
        const key = params[1];
        const compositeKey = `${appId}:${key}`;
        const record = intentsByIdempotency.get(compositeKey);
        return { rows: record ? [record] : [] };
      }

      // Find intent by ID
      if (s.includes('FROM CWIDS.PAYMENT_INTENT_CORRELATIONS') && s.includes('WHERE ID = $1')) {
        const id = params[0];
        const record = intentsById.get(id);
        return { rows: record ? [record] : [] };
      }

      // Insert into payment_intent_correlations
      if (s.includes('INSERT INTO CWIDS.PAYMENT_INTENT_CORRELATIONS')) {
        const [
          id,
          applicationId,
          providerConnectionId,
          environment,
          merchantReference,
          expectedAmountMinor,
          currency,
          idempotencyKey,
          expiresAt,
          metadata,
        ] = params;

        const refKey = `${providerConnectionId}:${environment}:${merchantReference}`;
        if (intentsByMerchantRef.has(refKey)) {
          const err = new Error('duplicate key value violates unique constraint "uq_intent_merchant_ref"');
          // @ts-ignore
          err.code = '23505';
          throw err;
        }

        const newRecord = {
          id: id ?? crypto.randomUUID(),
          application_id: applicationId,
          provider_connection_id: providerConnectionId,
          environment,
          merchant_reference: merchantReference,
          expected_amount_minor: expectedAmountMinor,
          currency,
          idempotency_key: idempotencyKey,
          status: 'active',
          expires_at: expiresAt,
          metadata: JSON.parse(metadata),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        intentsById.set(newRecord.id, newRecord);
        intentsByIdempotency.set(`${applicationId}:${idempotencyKey}`, newRecord);
        intentsByMerchantRef.set(refKey, newRecord);

        return { rows: [newRecord] };
      }

      // Insert alias
      if (s.includes('INSERT INTO CWIDS.PAYMENT_INTENT_ALIASES')) {
        aliases.push({
          paymentIntentId: params[0],
          providerConnectionId: params[1],
          environment: params[2],
          aliasType: params[3],
          aliasValue: params[4],
        });
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL in mock client: ${sql}`);
    },
    release() {},
  };

  return {
    apiKey,
    intentsById,
    aliases,
    async connect() {
      return client;
    },
  };
}

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

test('POST /v1/internal/payment-intents: rejects unauthenticated requests', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const res = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'UNAUTHORIZED');
  } finally {
    await close();
  }
});

test('POST /v1/internal/payment-intents: registers valid intent and returns 201', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const futureDate = new Date(Date.now() + 3600000).toISOString(); // 1 hour in future
    const idempotencyKey = crypto.randomUUID();

    const res = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider_connection_id: 'conn_flw_123',
        environment: 'live',
        merchant_reference: 'ORDER-2026-10-01',
        expected_amount_minor: 2500000,
        currency: 'NGN',
        expires_at: futureDate,
        aliases: [
          { alias_type: 'virtual_account_id', alias_value: 'VA-998877' },
        ],
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.merchant_reference, 'ORDER-2026-10-01');
    assert.equal(body.expected_amount_minor, 2500000);
    assert.equal(body.currency, 'NGN');
    assert.equal(body.status, 'active');
    assert.ok(body.id);

    // Verify alias was stored
    assert.equal(mockPool.aliases.length, 1);
    assert.equal(mockPool.aliases[0].aliasValue, 'VA-998877');
  } finally {
    await close();
  }
});

test('POST /v1/internal/payment-intents: idempotent retry with identical payload returns 200 OK', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      provider_connection_id: 'conn_flw_123',
      environment: 'live',
      merchant_reference: 'ORDER-IDEMP-01',
      expected_amount_minor: 500000,
      currency: 'NGN',
      expires_at: futureDate,
    };

    // First request -> 201 Created
    const res1 = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
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
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.id, body1.id);
  } finally {
    await close();
  }
});

test('POST /v1/internal/payment-intents: idempotent retry with conflicting payload returns 409 Conflict', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const idempotencyKey = crypto.randomUUID();

    // First request
    await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider_connection_id: 'conn_flw_123',
        environment: 'live',
        merchant_reference: 'ORDER-CONFLICT-01',
        expected_amount_minor: 500000,
        currency: 'NGN',
        expires_at: futureDate,
      }),
    });

    // Conflicting second request
    const res2 = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider_connection_id: 'conn_flw_123',
        environment: 'live',
        merchant_reference: 'ORDER-CONFLICT-DIFFERENT',
        expected_amount_minor: 999999,
        currency: 'NGN',
        expires_at: futureDate,
      }),
    });

    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await close();
  }
});

test('POST /v1/internal/payment-intents: non-integer amount returns 422 INVALID_AMOUNT', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const res = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider_connection_id: 'conn_123',
        environment: 'live',
        merchant_reference: 'ORDER-FLOAT-01',
        expected_amount_minor: 250.75, // Floats are invalid!
        currency: 'NGN',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    });

    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_AMOUNT');
  } finally {
    await close();
  }
});

test('POST /v1/internal/payment-intents/:id/aliases: registers dynamic alias for existing intent', async () => {
  const mockPool = createMockPool();
  const router = createInternalApiRouter({ pool: /** @type {any} */ (mockPool) });
  const { baseUrl, close } = await startTestServer(router);

  try {
    // Create intent first
    const createRes = await fetch(`${baseUrl}/payment-intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider_connection_id: 'conn_123',
        environment: 'live',
        merchant_reference: 'ORDER-ALIAS-01',
        expected_amount_minor: 100000,
        currency: 'NGN',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    });

    const intent = await createRes.json();

    // Register dynamic alias
    const aliasRes = await fetch(`${baseUrl}/payment-intents/${intent.id}/aliases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockPool.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alias_type: 'provider_reference',
        alias_value: 'FLW-TX-998877',
      }),
    });

    assert.equal(aliasRes.status, 201);
    const aliasBody = await aliasRes.json();
    assert.equal(aliasBody.status, 'success');
  } finally {
    await close();
  }
});
