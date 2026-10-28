import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAdminRouter } from '../../src/admin/admin-server.mjs';

function createMockAdminPool() {
  /** @type {Map<string, any>} */
  const applications = new Map();
  /** @type {Map<string, any>} */
  const endpoints = new Map();
  /** @type {Map<string, any>} */
  const events = new Map();
  /** @type {Map<string, any>} */
  const deliveries = new Map();
  /** @type {any[]} */
  const auditEvents = [];

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

      // Application insert
      if (s.includes('INSERT INTO CWIDS.APPLICATIONS')) {
        const [id, code, name, apiKeyHash] = params;
        const app = {
          id: id ?? crypto.randomUUID(),
          code,
          name,
          api_key_hash: apiKeyHash,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        applications.set(app.id, app);
        return { rows: [app] };
      }

      // Endpoint version query
      if (s.includes('FROM CWIDS.DESTINATION_ENDPOINTS') && s.includes('NEXT_VERSION')) {
        return { rows: [{ next_version: 1 }] };
      }

      // Endpoint insert
      if (s.includes('INSERT INTO CWIDS.DESTINATION_ENDPOINTS')) {
        const [applicationId, version, url, signingSecret, timeoutMs, maxRetries] = params;
        const ep = {
          id: crypto.randomUUID(),
          application_id: applicationId,
          version,
          url,
          signing_secret: signingSecret,
          http_timeout_ms: timeoutMs,
          max_retries: maxRetries,
          status: 'active',
          created_at: new Date().toISOString(),
        };
        endpoints.set(ep.id, ep);
        return { rows: [ep] };
      }

      // Query event by ID
      if (s.includes('FROM CWIDS.WEBHOOK_EVENTS') && s.includes('WHERE ID = $1')) {
        const ev = events.get(params[0]);
        return { rows: ev ? [ev] : [] };
      }

      // Find active endpoint for application
      if (s.includes('FROM CWIDS.DESTINATION_ENDPOINTS') && s.includes('APPLICATION_ID = $1')) {
        const appId = params[0];
        const match = Array.from(endpoints.values()).find(
          (ep) => ep.application_id === appId && ep.status === 'active',
        );
        return { rows: match ? [match] : [] };
      }

      // Update event routing status
      if (s.includes('UPDATE CWIDS.WEBHOOK_EVENTS') && s.includes("SET ROUTING_STATUS = 'RESOLVED'")) {
        const [appId, evId] = params;
        const ev = events.get(evId);
        if (ev) {
          ev.routing_status = 'resolved';
          ev.application_id = appId;
        }
        return { rows: [] };
      }

      // Insert delivery
      if (s.includes('INSERT INTO CWIDS.EVENT_DELIVERIES')) {
        const [id, eventId, applicationId, destinationEndpointId] = params;
        const deliv = {
          id: id ?? crypto.randomUUID(),
          event_id: eventId,
          application_id: applicationId,
          destination_endpoint_id: destinationEndpointId,
          status: 'pending',
          attempt_count: 0,
          fencing_token: 0,
          next_attempt_at: new Date(),
        };
        deliveries.set(deliv.id, deliv);
        return { rows: [deliv] };
      }

      // Find delivery by ID
      if (s.includes('FROM CWIDS.EVENT_DELIVERIES') && s.includes('WHERE ID = $1')) {
        const deliv = deliveries.get(params[0]);
        return { rows: deliv ? [deliv] : [] };
      }

      // Redrive delivery: UPDATE event_deliveries SET status = 'pending', fencing_token = fencing_token + 1
      if (s.includes('UPDATE CWIDS.EVENT_DELIVERIES') && s.includes("STATUS = 'DEAD_LETTERED'")) {
        const deliv = deliveries.get(params[0]);
        if (deliv && deliv.status === 'dead_lettered') {
          deliv.status = 'pending';
          deliv.fencing_token += 1;
          deliv.next_attempt_at = new Date();
          return { rows: [deliv] };
        }
        return { rows: [] };
      }

      // Audit events & outbox insert
      if (s.includes('INSERT INTO CWIDS.ADMINISTRATIVE_AUDIT_EVENTS')) {
        const audit = { id: params[0] ?? crypto.randomUUID() };
        auditEvents.push(audit);
        return { rows: [audit] };
      }

      if (s.includes('INSERT INTO CWIDS.AUDIT_OUTBOX')) {
        return { rows: [{ id: auditEvents.length }] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    applications,
    endpoints,
    events,
    deliveries,
    auditEvents,
    async connect() {
      return client;
    },
  };
}

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

const ADMIN_TOKEN = 'secret_admin_token_length_32_ok';

test('Admin API: rejects requests without valid Admin Bearer token', async () => {
  const mockPool = createMockAdminPool();
  const router = createAdminRouter({ pool: /** @type {any} */ (mockPool), adminApiToken: ADMIN_TOKEN });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const res = await fetch(`${baseUrl}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'app_1', name: 'App 1' }),
    });

    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('Admin API: registers application and generates raw API key', async () => {
  const mockPool = createMockAdminPool();
  const router = createAdminRouter({ pool: /** @type {any} */ (mockPool), adminApiToken: ADMIN_TOKEN });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const res = await fetch(`${baseUrl}/applications`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: 'fintech_app', name: 'Fintech Core' }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.code, 'fintech_app');
    assert.equal(body.name, 'Fintech Core');
    assert.ok(body.api_key.startsWith('cwids_'));
  } finally {
    await close();
  }
});

test('Admin API: manual redrive transitions dead_lettered to pending with incremented fencing token', async () => {
  const mockPool = createMockAdminPool();
  const router = createAdminRouter({ pool: /** @type {any} */ (mockPool), adminApiToken: ADMIN_TOKEN });
  const { baseUrl, close } = await startTestServer(router);

  try {
    // Seed a dead-lettered delivery
    const deliveryId = 'deliv_dlq_123';
    mockPool.deliveries.set(deliveryId, {
      id: deliveryId,
      event_id: 'evt_123',
      application_id: 'app_999',
      destination_endpoint_id: 'ep_1',
      status: 'dead_lettered',
      attempt_count: 15,
      fencing_token: 15,
      next_attempt_at: new Date(),
    });

    // Execute redrive
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
    assert.equal(body.event_id, 'evt_123');
    assert.equal(body.status, 'pending');
    assert.equal(body.fencing_token, 16); // Incremented!
    assert.equal(body.attempt_count, 15); // History preserved!
    assert.ok(body.redrive_audit_id); // Audit logged!
  } finally {
    await close();
  }
});

test('Admin API: manual redrive on active/delivered delivery returns 409 Conflict', async () => {
  const mockPool = createMockAdminPool();
  const router = createAdminRouter({ pool: /** @type {any} */ (mockPool), adminApiToken: ADMIN_TOKEN });
  const { baseUrl, close } = await startTestServer(router);

  try {
    const deliveryId = 'deliv_already_delivered';
    mockPool.deliveries.set(deliveryId, {
      id: deliveryId,
      event_id: 'evt_123',
      application_id: 'app_999',
      destination_endpoint_id: 'ep_1',
      status: 'delivered', // Not dead_lettered!
      attempt_count: 1,
      fencing_token: 1,
    });

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
  } finally {
    await close();
  }
});
