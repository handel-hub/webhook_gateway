import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IngestionService } from '../../src/ingestion/ingestion-service.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

test('Commit Disconnect & Redelivery (TC-02): Absorbs duplicate redelivery without creating second delivery obligation', async () => {
  const pool = getTestPool();
  let appId = '';

  try {
    const app = await createTestApp(pool, { name: 'Commit Disconnect App' });
    appId = app.id;
    await createTestEndpoint(pool, appId, {
      url: 'https://example.com/webhook-disconnect',
    });
    const conn = await createTestProviderConnection(pool, {
      provider: 'paystack',
      environment: 'live',
      applicationId: appId,
    });

    const merchantRef = `ORDER-DISCONN-${crypto.randomBytes(4).toString('hex')}`;

    // Seed payment intent correlation so Mode A routing resolves to this application
    await pool.query(
      `INSERT INTO cwids.payment_intent_correlations
         (application_id, provider_connection_id, environment, merchant_reference, expected_amount_minor, currency, idempotency_key, expires_at, status)
       VALUES
         ($1, $2, $3, $4, 500000, 'NGN', $5, CURRENT_TIMESTAMP + interval '1 day', 'active')`,
      [appId, conn.id, conn.environment, merchantRef, `idem-${merchantRef}`],
    );

    const rawBody = Buffer.from(
      JSON.stringify({ event: 'charge.success', data: { reference: merchantRef, amount: 500000 } }),
    );
    const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex');

    const dedupeKey = `v1:pstk:${merchantRef}:charge.success`;

    const verification = {
      isValid: true,
      failureReason: null,
      dedupeKey,
      normalized: {
        eventType: 'charge.success',
        merchantReference: merchantRef,
        providerReference: `pstk_ref_${Date.now()}`,
        virtualAccountId: null,
        amountMinor: 500000,
        currency: 'NGN',
        providerStatus: 'successful',
        rawData: {},
      },
    };

    const webhookInput = {
      providerConnection: conn,
      rawBody,
      payloadSha256,
      verification,
    };

    // 1. First webhook ingestion: commits to database, but network drops before HTTP 200 reaches provider
    const firstOutcome = await IngestionService.ingestWebhook(pool, webhookInput);

    assert.equal(firstOutcome.isDuplicate, false);
    assert.equal(firstOutcome.routingStatus, 'resolved');
    assert.ok(firstOutcome.deliveryId, 'Should create delivery obligation');

    // Verify 1 delivery obligation exists in database
    const delivCount1 = await pool.query(
      `SELECT count(*) FROM cwids.event_deliveries WHERE event_id = $1`,
      [firstOutcome.eventId],
    );
    assert.equal(Number(delivCount1.rows[0].count), 1);

    // 2. Provider retries 10 seconds later with identical payload
    const secondOutcome = await IngestionService.ingestWebhook(pool, webhookInput);

    // Invariant verification: Duplicate absorbed cleanly, identical event ID returned
    assert.equal(secondOutcome.isDuplicate, true);
    assert.equal(secondOutcome.eventId, firstOutcome.eventId);

    // Exactly ONE delivery obligation exists! Second delivery was NOT created!
    const delivCount2 = await pool.query(
      `SELECT count(*) FROM cwids.event_deliveries WHERE event_id = $1`,
      [firstOutcome.eventId],
    );
    assert.equal(Number(delivCount2.rows[0].count), 1);
  } finally {
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
    }
    await closeTestPool();
  }
});
