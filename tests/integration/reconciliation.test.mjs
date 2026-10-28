import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReconciliationWorker } from '../../src/maintenance/reconciliation-worker.mjs';
import { FlutterwaveReconciliationAdapter } from '../../src/providers/flutterwave/reconciliation.mjs';
import { PaystackReconciliationAdapter } from '../../src/providers/paystack/reconciliation.mjs';

function createMockReconciliationPool() {
  /** @type {any[]} */
  const candidates = [];
  /** @type {any[]} */
  const savedRecords = [];

  const client = {
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params = []) {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      if (s.includes('SET_CONFIG')) {
        return { rows: [] };
      }

      // ReconciliationRepo.findCandidates
      if (s.includes('FROM CWIDS.PAYMENT_INTENT_CORRELATIONS PIC') && s.includes('LEFT JOIN CWIDS.RECONCILIATION_RECORDS')) {
        return { rows: [...candidates] };
      }

      // ReconciliationRepo.insertRecord
      if (s.includes('INSERT INTO CWIDS.RECONCILIATION_RECORDS')) {
        const record = {
          id: params[0] ?? 'rec_1',
          payment_intent_id: params[1],
          provider_connection_id: params[2],
          status: params[3],
          provider_status: params[4],
          verified_amount_minor: params[5],
          verified_currency: params[6],
          verified_reference: params[7],
          raw_response: JSON.parse(params[8]),
          discrepancy_notes: params[9],
        };
        savedRecords.push(record);
        return { rows: [record] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    candidates,
    savedRecords,
    async connect() {
      return client;
    },
  };
}

test('ReconciliationWorker: skips execution when RECONCILIATION_ENABLED is false', async () => {
  const mockPool = createMockReconciliationPool();
  /** @type {any} */
  const mockEnv = {
    RECONCILIATION_ENABLED: false,
  };

  const result = await ReconciliationWorker.runReconciliationCycle(
    /** @type {any} */ (mockPool),
    mockEnv,
  );

  assert.equal(result.processed, 0);
  assert.equal(mockPool.savedRecords.length, 0);
});

test('ReconciliationWorker: processes matching transaction and records status = matched', async () => {
  // Spin up mock provider HTTP verification server
  const server = http.createServer((req, res) => {
    if (req.url?.includes('verify')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          message: 'Verification successful',
          data: {
            id: 991122,
            reference: 'ORDER-MATCH-01',
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

  const mockPool = createMockReconciliationPool();
  mockPool.candidates.push({
    intentId: 'intent_match_1',
    merchantReference: 'ORDER-MATCH-01',
    providerConnectionId: 'conn_pstk_1',
    provider: 'paystack',
    environment: 'live',
    expectedAmountMinor: 500000,
    expectedCurrency: 'NGN',
  });

  // Temporarily override adapter baseUrl for test
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
      /** @type {any} */ (mockPool),
      mockEnv,
      { rateLimitDelayMs: 0 },
    );

    assert.equal(result.processed, 1);
    assert.equal(result.matched, 1);
    assert.equal(result.discrepancies, 0);

    const saved = mockPool.savedRecords[0];
    assert.ok(saved);
    assert.equal(saved.status, 'matched');
    assert.equal(saved.verified_amount_minor, 500000);
    assert.equal(saved.discrepancy_notes, null);
  } finally {
    PaystackReconciliationAdapter.verifyTransaction = origVerify;
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('ReconciliationWorker: detects amount mismatch and records discrepancy_detected with notes', async () => {
  // Mock provider returning different charged amount
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: true,
        data: {
          reference: 'ORDER-DISC-01',
          amount: 250000, // Charged 250000 kobo instead of expected 500000!
          currency: 'NGN',
          status: 'success',
        },
      }),
    );
  });

  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  const providerUrl = `http://127.0.0.1:${addr.port}`;

  const mockPool = createMockReconciliationPool();
  mockPool.candidates.push({
    intentId: 'intent_disc_1',
    merchantReference: 'ORDER-DISC-01',
    providerConnectionId: 'conn_pstk_1',
    provider: 'paystack',
    environment: 'live',
    expectedAmountMinor: 500000, // Expected 500,000 minor
    expectedCurrency: 'NGN',
  });

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
      /** @type {any} */ (mockPool),
      mockEnv,
      { rateLimitDelayMs: 0 },
    );

    assert.equal(result.processed, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.discrepancies, 1);

    const saved = mockPool.savedRecords[0];
    assert.ok(saved);
    assert.equal(saved.status, 'discrepancy_detected');
    assert.ok(saved.discrepancy_notes.includes('Amount mismatch'));
  } finally {
    PaystackReconciliationAdapter.verifyTransaction = origVerify;
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
