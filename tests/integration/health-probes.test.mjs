import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHealthRouter } from '../../src/ingress/health.mjs';
import { metrics, startMetricsServer } from '../../src/observability/metrics.mjs';
import { getTestPool, closeTestPool } from '../helpers/db-test-helper.mjs';

test('Health probes: GET /live returns 200 with uptime and status = ok', async () => {
  const router = createHealthRouter({ pool: /** @type {any} */ ({}) });
  const app = express();
  app.use(router);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/live`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptime === 'number');
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('Health probes: GET /ready returns 200 when database connection is healthy', async () => {
  const pool = getTestPool();
  const router = createHealthRouter({ pool });
  const app = express();
  app.use(router);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.database, 'connected');
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('Health probes: GET /ready returns 503 when database is unreachable', async () => {
  const mockFailingPool = {
    async connect() {
      throw new Error('Connection refused to PostgreSQL host');
    },
  };

  const router = createHealthRouter({ pool: /** @type {any} */ (mockFailingPool) });
  const app = express();
  app.use(router);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'unready');
    assert.equal(body.database, 'disconnected');
    assert.ok(body.error.includes('Connection refused'));
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('Metrics: Prometheus /metrics exposes standard metrics format', async () => {
  // Update sample metrics
  metrics.increment('cwids_ingress_requests_total', { provider: 'flutterwave', status: 200 }, 5);
  metrics.increment('cwids_signature_verification_failures_total', { provider: 'paystack', reason: 'bad_signature' }, 1);
  metrics.setGauge('cwids_queue_depth_pending', {}, 42);

  const port = 9091; // Test ephemeral port
  const metricsHandle = await startMetricsServer(port);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.ok(text.includes('# HELP cwids_ingress_requests_total'));
    assert.ok(text.includes('# TYPE cwids_ingress_requests_total counter'));
    assert.ok(text.includes('cwids_ingress_requests_total{provider="flutterwave",status="200"} 5'));
    assert.ok(text.includes('cwids_queue_depth_pending 42'));
    assert.ok(text.includes('cwids_delivery_attempts_total 0'));
  } finally {
    await metricsHandle.close();
    await closeTestPool();
  }
});
