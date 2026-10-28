import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestionService } from '../../src/ingestion/ingestion-service.mjs';

const VALID_KEK_BASE64 = Buffer.alloc(32, 0x42).toString('base64');
process.env.DATABASE_URL = 'postgresql://localhost:5432/cwids';
process.env.CWIDS_KEK_BASE64 = VALID_KEK_BASE64;
process.env.ADMIN_API_TOKEN = 'test_admin_api_token_16_chars';

function createMockDisconnectPool() {
  /** @type {Map<string, any>} */
  const events = new Map();
  /** @type {any[]} */
  const deliveries = [];

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

      // Check payment intent
      if (s.includes('FROM CWIDS.PAYMENT_INTENT_CORRELATIONS')) {
        return { rows: [{ id: 'intent_123', application_id: 'app_123' }] };
      }

      // Check destination endpoint
      if (s.includes('FROM CWIDS.DESTINATION_ENDPOINTS')) {
        return { rows: [{ id: 'ep_123' }] };
      }

      // Find by dedupe key
      if (s.includes('FROM CWIDS.WEBHOOK_EVENTS WHERE PROVIDER_CONNECTION_ID = $1') && s.includes('DEDUPE_KEY = $4')) {
        const dedupeKey = params[3];
        const existing = events.get(dedupeKey);
        return { rows: existing ? [existing] : [] };
      }

      // Insert into webhook_events
      if (s.includes('INSERT INTO CWIDS.WEBHOOK_EVENTS')) {
        const dedupeKey = params[5];
        if (events.has(dedupeKey)) {
          const err = new Error('duplicate key value violates unique constraint "uq_webhook_events_dedupe"');
          // @ts-ignore
          err.code = '23505';
          throw err;
        }

        const newEvent = {
          id: params[0] ?? 'evt_committed_1',
          provider_connection_id: params[1],
          provider: params[2],
          environment: params[3],
          identity_strategy_version: params[4],
          dedupe_key: dedupeKey,
          event_type: params[6],
          resource_type: params[7],
          resource_reference: params[8],
          application_id: params[9],
          payment_intent_id: params[10],
          routing_status: params[11],
          routing_mode: params[12],
          payload_sha256: params[19],
        };
        events.set(dedupeKey, newEvent);
        return { rows: [newEvent] };
      }

      // Insert into event_deliveries
      if (s.includes('INSERT INTO CWIDS.EVENT_DELIVERIES')) {
        deliveries.push({ id: `deliv_${deliveries.length + 1}` });
        return { rows: [{ id: `deliv_${deliveries.length}` }] };
      }

      // Audit events and outbox
      if (s.includes('ADMINISTRATIVE_AUDIT_EVENTS')) {
        return { rows: [{ id: 'audit_1' }] };
      }
      if (s.includes('AUDIT_OUTBOX')) {
        return { rows: [{ id: 1 }] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    events,
    deliveries,
    async connect() {
      return client;
    },
  };
}

test('Commit Disconnect & Redelivery (TC-02): Absorbs duplicate redelivery without creating second delivery obligation', async () => {
  const mockPool = createMockDisconnectPool();

  const mockConnection = {
    id: 'conn_pstk_99',
    provider: 'paystack',
    environment: /** @type {'live'} */ ('live'),
    application_id: null,
  };

  const rawBody = Buffer.from(
    JSON.stringify({ event: 'charge.success', data: { reference: 'ORDER-REDELIVER-1', amount: 500000 } }),
  );
  const payloadSha256 = 'sha256_mock_hash';

  const verification = {
    isValid: true,
    failureReason: null,
    dedupeKey: 'v1:pstk:ORDER-REDELIVER-1:charge.success',
    normalized: {
      eventType: 'charge.success',
      merchantReference: 'ORDER-REDELIVER-1',
      providerReference: null,
      virtualAccountId: null,
      amountMinor: 500000,
      currency: 'NGN',
      providerStatus: 'successful',
      rawData: {},
    },
  };

  const webhookInput = {
    providerConnection: /** @type {any} */ (mockConnection),
    rawBody,
    payloadSha256,
    verification,
  };

  // 1. First webhook ingestion: commits to database, but network drops before HTTP 200 reaches provider
  const firstOutcome = await IngestionService.ingestWebhook(/** @type {any} */ (mockPool), webhookInput);

  assert.equal(firstOutcome.isDuplicate, false);
  assert.equal(firstOutcome.routingStatus, 'resolved');
  assert.equal(mockPool.deliveries.length, 1);

  // 2. Provider retries 10 seconds later with identical payload
  const secondOutcome = await IngestionService.ingestWebhook(/** @type {any} */ (mockPool), webhookInput);

  // Invariant verification: Duplicate absorbed cleanly, identical event ID returned
  assert.equal(secondOutcome.isDuplicate, true);
  assert.equal(secondOutcome.eventId, firstOutcome.eventId);

  // Exactly ONE delivery obligation exists! Second delivery was NOT created!
  assert.equal(mockPool.deliveries.length, 1);
});
