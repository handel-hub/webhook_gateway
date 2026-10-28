import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IngestionService } from '../../src/ingestion/ingestion-service.mjs';

const VALID_KEK_BASE64 = Buffer.alloc(32, 0x42).toString('base64');
process.env.DATABASE_URL = 'postgresql://localhost:5432/cwids';
process.env.CWIDS_KEK_BASE64 = VALID_KEK_BASE64;
process.env.ADMIN_API_TOKEN = 'test_admin_api_token_16_chars';

test('IngestionService.ingestWebhook: resolves, persists event, and creates delivery', async () => {
  /** @type {string[]} */
  const executedSql = [];
  /** @type {any} */
  const mockClient = {
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params) {
      executedSql.push(sql);
      if (sql.includes('payment_intent_correlations')) {
        return {
          rows: [{ id: 'intent_123', application_id: 'app_456' }],
        };
      }
      if (sql.includes('INSERT INTO cwids.webhook_events')) {
        return {
          rows: [{
            id: 'evt_new_1',
            provider_connection_id: 'conn_1',
            environment: 'live',
            application_id: 'app_456',
            payment_intent_id: 'intent_123',
            routing_status: 'resolved',
            payload_sha256: 'sha256_mock',
          }],
        };
      }
      if (sql.includes('destination_endpoints')) {
        return {
          rows: [{ id: 'endpoint_789' }],
        };
      }
      if (sql.includes('INSERT INTO cwids.event_deliveries')) {
        return {
          rows: [{
            id: 'deliv_101',
            event_id: 'evt_new_1',
            application_id: 'app_456',
            destination_endpoint_id: 'endpoint_789',
            status: 'pending',
          }],
        };
      }
      if (sql.includes('audit_outbox') || sql.includes('administrative_audit_events')) {
        return { rows: [{ id: 'audit_1' }] };
      }
      return { rows: [] };
    },
    release() {},
  };

  /** @type {any} */
  const mockPool = {
    async connect() {
      return mockClient;
    },
  };

  /** @type {any} */
  const mockConnection = {
    id: 'conn_1',
    provider: 'flutterwave',
    environment: 'live',
    application_id: null,
  };

  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'ORD-123' } }));
  const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex');

  const outcome = await IngestionService.ingestWebhook(mockPool, {
    providerConnection: mockConnection,
    rawBody,
    payloadSha256,
    verification: {
      isValid: true,
      failureReason: null,
      dedupeKey: 'v1:flw:ORD-123:charge.completed',
      normalized: {
        eventType: 'charge.completed',
        merchantReference: 'ORD-123',
        providerReference: null,
        virtualAccountId: null,
        amountMinor: 50000,
        currency: 'NGN',
        providerStatus: 'successful',
        rawData: {},
      },
    },
  });

  assert.equal(outcome.isDuplicate, false);
  assert.equal(outcome.routingStatus, 'resolved');
  assert.equal(outcome.deliveryId, 'deliv_101');
  assert.ok(executedSql.includes('BEGIN'));
  assert.ok(executedSql.includes('COMMIT'));
});

test('IngestionService.ingestWebhook: absorbs duplicate without creating second delivery', async () => {
  /** @type {any} */
  const mockClient = {
    /** @param {string} sql */
    async query(sql) {
      if (sql.includes('INSERT INTO cwids.webhook_events')) {
        const err = new Error('duplicate key');
        // @ts-ignore
        err.code = '23505';
        throw err;
      }
      if (sql.includes('SELECT') && sql.includes('cwids.webhook_events')) {
        return {
          rows: [{
            id: 'evt_existing_99',
            provider_connection_id: 'conn_1',
            environment: 'live',
            application_id: 'app_456',
            payment_intent_id: 'intent_123',
            routing_status: 'resolved',
            payload_sha256: 'exact_matching_sha',
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };

  /** @type {any} */
  const mockPool = {
    async connect() {
      return mockClient;
    },
  };

  /** @type {any} */
  const mockConnection = {
    id: 'conn_1',
    provider: 'paystack',
    environment: 'live',
    application_id: null,
  };

  const outcome = await IngestionService.ingestWebhook(mockPool, {
    providerConnection: mockConnection,
    rawBody: Buffer.from('{"event":"charge.success"}'),
    payloadSha256: 'exact_matching_sha',
    verification: {
      isValid: true,
      failureReason: null,
      dedupeKey: 'v1:pstk:ref1:charge.success',
      normalized: {
        eventType: 'charge.success',
        merchantReference: 'ref1',
        providerReference: null,
        virtualAccountId: null,
        amountMinor: 1000,
        currency: 'NGN',
        providerStatus: 'success',
        rawData: {},
      },
    },
  });

  assert.equal(outcome.isDuplicate, true);
  assert.equal(outcome.eventId, 'evt_existing_99');
  assert.equal(outcome.deliveryId, null);
});
