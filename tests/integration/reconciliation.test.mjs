import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { ReconciliationWorker } from '../../src/maintenance/reconciliation-worker.mjs';
import { PaystackReconciliationAdapter } from '../../src/providers/paystack/reconciliation.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('ReconciliationWorker: Real PostgreSQL Integration Suite', async (t) => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Reconciliation App' });
    appId = app.id;
    const conn = await createTestProviderConnection(pool, {
      applicationId: appId,
      provider: 'paystack',
      environment: 'live',
    });

    await t.test('skips execution when RECONCILIATION_ENABLED is false', async () => {
      /** @type {any} */
      const mockEnv = {
        RECONCILIATION_ENABLED: false,
      };

      const result = await ReconciliationWorker.runReconciliationCycle(pool, mockEnv);

      assert.equal(result.processed, 0);
      assert.equal(result.matched, 0);
      assert.equal(result.discrepancies, 0);
    });

    await t.test('processes matching transaction and records status = matched in database', async () => {
      const merchantRef = `ORD-REC-MATCH-${crypto.randomBytes(4).toString('hex')}`;

      // 1. Seed active intent created 45 minutes ago
      const intentRes = await pool.query(
        `INSERT INTO cwids.payment_intent_correlations
           (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status, created_at)
         VALUES ($1, $2, $3, $4, 500000, 'NGN', $5, CURRENT_TIMESTAMP + interval '1 day', 'active', CURRENT_TIMESTAMP - interval '45 minutes')
         RETURNING id`,
        [appId, conn.id, conn.environment, merchantRef, `idem-${merchantRef}`],
      );
      const intentId = intentRes.rows[0].id;

      // 2. Spin up ephemeral mock provider HTTP verification server
      const server = http.createServer((req, res) => {
        if (req.url?.includes('verify')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: true,
              message: 'Verification successful',
              data: {
                id: 991122,
                reference: merchantRef,
                amount: 500000, // 500000 kobo (matches 500000 minor)
                currency: 'NGN',
                status: 'success',
              },
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      const providerUrl = `http://127.0.0.1:${addr.port}`;

      const origVerify = PaystackReconciliationAdapter.verifyTransaction;
      PaystackReconciliationAdapter.verifyTransaction = (args) =>
        origVerify({ ...args, baseUrl: providerUrl });

      try {
        /** @type {any} */
        const mockEnv = {
          RECONCILIATION_ENABLED: true,
          PAYSTACK_RECONCILIATION_SECRET_KEY: 'sk_test_paystack_secret',
          RECONCILIATION_TIMEOUT_MS: 3000,
        };

        const result = await ReconciliationWorker.runReconciliationCycle(
          pool,
          mockEnv,
          { minAgeMinutes: 30, rateLimitDelayMs: 0 },
        );

        assert.ok(result.processed >= 1, 'Should process at least 1 candidate');
        assert.ok(result.matched >= 1, 'Should match transaction');

        // Verify row in real cwids.reconciliation_records table
        const recCheck = await pool.query(
          `SELECT status, verified_amount_minor, discrepancy_notes FROM cwids.reconciliation_records WHERE payment_intent_id = $1`,
          [intentId],
        );
        assert.equal(recCheck.rows.length, 1);
        assert.equal(recCheck.rows[0].status, 'matched');
        assert.equal(Number(recCheck.rows[0].verified_amount_minor), 500000);
        assert.equal(recCheck.rows[0].discrepancy_notes, null);
      } finally {
        PaystackReconciliationAdapter.verifyTransaction = origVerify;
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    });

    await t.test('detects amount mismatch and records discrepancy_detected with notes in database', async () => {
      const merchantRef = `ORD-REC-DISC-${crypto.randomBytes(4).toString('hex')}`;

      // 1. Seed active intent with expected 500,000 minor
      const intentRes = await pool.query(
        `INSERT INTO cwids.payment_intent_correlations
           (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status, created_at)
         VALUES ($1, $2, $3, $4, 500000, 'NGN', $5, CURRENT_TIMESTAMP + interval '1 day', 'active', CURRENT_TIMESTAMP - interval '45 minutes')
         RETURNING id`,
        [appId, conn.id, conn.environment, merchantRef, `idem-${merchantRef}`],
      );
      const intentId = intentRes.rows[0].id;

      // 2. Mock provider returns conflicting amount (250,000 instead of 500,000)
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: true,
            data: {
              reference: merchantRef,
              amount: 250000,
              currency: 'NGN',
              status: 'success',
            },
          }),
        );
      });

      await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      const providerUrl = `http://127.0.0.1:${addr.port}`;

      const origVerify = PaystackReconciliationAdapter.verifyTransaction;
      PaystackReconciliationAdapter.verifyTransaction = (args) =>
        origVerify({ ...args, baseUrl: providerUrl });

      try {
        /** @type {any} */
        const mockEnv = {
          RECONCILIATION_ENABLED: true,
          PAYSTACK_RECONCILIATION_SECRET_KEY: 'sk_test_paystack_secret',
          RECONCILIATION_TIMEOUT_MS: 3000,
        };

        const result = await ReconciliationWorker.runReconciliationCycle(
          pool,
          mockEnv,
          { minAgeMinutes: 30, rateLimitDelayMs: 0 },
        );

        assert.ok(result.processed >= 1);
        assert.ok(result.discrepancies >= 1);

        // Verify discrepancy row in real cwids.reconciliation_records table
        const recCheck = await pool.query(
          `SELECT status, verified_amount_minor, discrepancy_notes FROM cwids.reconciliation_records WHERE payment_intent_id = $1`,
          [intentId],
        );
        assert.equal(recCheck.rows.length, 1);
        assert.equal(recCheck.rows[0].status, 'discrepancy_detected');
        assert.ok(recCheck.rows[0].discrepancy_notes.includes('Amount mismatch'));
      } finally {
        PaystackReconciliationAdapter.verifyTransaction = origVerify;
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    });
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
