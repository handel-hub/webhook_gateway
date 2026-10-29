import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAdminRouter } from '../../src/admin/admin-server.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../helpers/db-test-helper.mjs';

const ADMIN_TOKEN = 'secret_admin_token_length_32_ok_long';

/**
 * @param {import('express').Router} router
 */
async function startTestServer(router) {
  const app = express();
  app.use('/v1/admin', router);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined));
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Invalid address');
  }

  const baseUrl = `http://127.0.0.1:${addr.port}/v1/admin`;
  return {
    server,
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test('Admin API & Redrive: Real PostgreSQL Integration Suite', async (t) => {
  const pool = getTestPool();
  /** @type {string[]} */
  const createdAppIds = [];
  /** @type {any} */
  let testServer;

  try {
    const router = createAdminRouter({ pool, adminApiToken: ADMIN_TOKEN });
    testServer = await startTestServer(router);
    const baseUrl = testServer.baseUrl;

    const baseApp = await createTestApp(pool, { name: 'Admin Suite App' });
    createdAppIds.push(baseApp.id);
    const endpoint = await createTestEndpoint(pool, baseApp.id, {
      url: 'https://example.com/webhook-admin',
    });
    const conn = await createTestProviderConnection(pool, { applicationId: baseApp.id });

    await t.test('Admin API: rejects requests without valid Admin Bearer token', async () => {
      const res = await fetch(`${baseUrl}/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'app_noauth', name: 'No Auth App' }),
      });

      assert.equal(res.status, 401);
    });

    await t.test('Admin API: registers application and generates raw API key', async () => {
      const code = `app_${crypto.randomBytes(4).toString('hex')}`;
      const res = await fetch(`${baseUrl}/applications`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code, name: 'Fintech Core' }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.code, code);
      assert.equal(body.name, 'Fintech Core');
      assert.ok(body.api_key.startsWith('cwids_'));
      createdAppIds.push(body.id);

      // Verify row exists in real database
      const appRow = await pool.query(`SELECT * FROM cwids.applications WHERE id = $1`, [body.id]);
      assert.equal(appRow.rows.length, 1);
      assert.equal(appRow.rows[0].code, code);
    });

    await t.test('Admin API: manual redrive transitions dead_lettered to pending with incremented fencing token', async () => {
      // 1. Seed an event
      const dedupeKey = `admin-redrive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const evRes = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
         VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-admin', 'resolved', 'mode_a', 'v1', 'dummy_sha')
         RETURNING id`,
        [baseApp.id, conn.id, conn.provider, conn.environment, dedupeKey],
      );
      const eventId = evRes.rows[0].id;

      // 2. Seed a dead-lettered delivery
      const delivRes = await pool.query(
        `INSERT INTO cwids.event_deliveries
         (id, event_id, application_id, destination_endpoint_id, status, attempt_count, fencing_token, epoch_id, epoch_attempt_count, redrive_count, terminal_reason)
         VALUES
         (gen_random_uuid(), $1, $2, $3, 'dead_lettered', 15, 15, gen_random_uuid(), 15, 0, 'MAX_RETRIES_EXCEEDED')
         RETURNING id`,
        [eventId, baseApp.id, endpoint.id],
      );
      const deliveryId = delivRes.rows[0].id;

      // 3. Execute redrive via Admin API
      const res = await fetch(`${baseUrl}/deliveries/${deliveryId}/redrive`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Destination service recovered from outage' }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.delivery_id, deliveryId);
      assert.equal(body.event_id, eventId);
      assert.equal(body.status, 'pending');
      assert.equal(Number(body.fencing_token), 16); // Incremented!
      assert.equal(Number(body.attempt_count), 15); // Monotonic total attempt history preserved!
      assert.equal(Number(body.epoch_attempt_count), 0); // New epoch attempt reset!
      assert.equal(Number(body.redrive_count), 1); // Redrive counter incremented!
      assert.ok(body.redrive_audit_id); // Audit logged!

      // Verify directly in DB
      const dbCheck = await pool.query(`SELECT * FROM cwids.event_deliveries WHERE id = $1`, [deliveryId]);
      assert.equal(dbCheck.rows[0].status, 'pending');
      assert.equal(Number(dbCheck.rows[0].fencing_token), 16);
      assert.equal(Number(dbCheck.rows[0].attempt_count), 15);
      assert.equal(Number(dbCheck.rows[0].epoch_attempt_count), 0);
      assert.equal(Number(dbCheck.rows[0].redrive_count), 1);
      assert.equal(dbCheck.rows[0].terminal_reason, null);
    });

    await t.test('Admin API: manual redrive on active/delivered delivery returns 409 Conflict', async () => {
      const dedupeKey = `admin-delivered-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const evRes = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
         VALUES ($1, $2, $3, $4, 1, $5, 'charge.success', 'charge', 'ref-admin-2', 'resolved', 'mode_a', 'v1', 'dummy_sha')
         RETURNING id`,
        [baseApp.id, conn.id, conn.provider, conn.environment, dedupeKey],
      );
      const eventId = evRes.rows[0].id;

      const delivRes = await pool.query(
        `INSERT INTO cwids.event_deliveries
         (id, event_id, application_id, destination_endpoint_id, status, attempt_count, fencing_token)
         VALUES
         (gen_random_uuid(), $1, $2, $3, 'delivered', 1, 1)
         RETURNING id`,
        [eventId, baseApp.id, endpoint.id],
      );
      const deliveryId = delivRes.rows[0].id;

      const res = await fetch(`${baseUrl}/deliveries/${deliveryId}/redrive`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Retry test' }),
      });

      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, 'INVALID_STATE');
    });

    await t.test('Admin API: POST /v1/admin/events/:id/resolve manually routes awaiting_route event', async () => {
      const dedupeKey = `admin-awaiting-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const evRes = await pool.query(
        `INSERT INTO cwids.webhook_events 
           (provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
         VALUES ($1, $2, $3, 1, $4, 'charge.success', 'charge', 'ref-awaiting', 'awaiting_route', 'UNRESOLVED_NO_MATCH', 'v1', 'dummy_sha')
         RETURNING id`,
        [conn.id, conn.provider, conn.environment, dedupeKey],
      );
      const eventId = evRes.rows[0].id;

      const res = await fetch(`${baseUrl}/events/${eventId}/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ application_id: baseApp.id, reason: 'Manual ops resolution' }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'success');

      // Verify event is resolved and delivery obligation created
      const evCheck = await pool.query(`SELECT routing_status, application_id FROM cwids.webhook_events WHERE id = $1`, [eventId]);
      assert.equal(evCheck.rows[0].routing_status, 'resolved');
      assert.equal(evCheck.rows[0].application_id, baseApp.id);

      const delivCheck = await pool.query(`SELECT status FROM cwids.event_deliveries WHERE event_id = $1`, [eventId]);
      assert.equal(delivCheck.rows.length, 1);
      assert.equal(delivCheck.rows[0].status, 'pending');
    });
  } finally {
    if (testServer) {
      await testServer.close();
    }
    if (createdAppIds.length > 0) {
      await cleanupTestTenants(pool, createdAppIds);
    }
    await closeTestPool();
  }
});
