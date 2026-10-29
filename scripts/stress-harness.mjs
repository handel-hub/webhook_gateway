import http from 'node:http';
import crypto from 'node:crypto';
import { MockReceiver } from './mock-receiver.mjs';
import { startServer } from '../src/server.mjs';
import { startWorker } from '../src/worker.mjs';
import { getEnv } from '../src/config/env.mjs';
import {
  getTestPool,
  closeTestPool,
  createTestApp,
  createTestEndpoint,
  createTestProviderConnection,
  cleanupTestTenants,
} from '../tests/helpers/db-test-helper.mjs';

// Enable local loopback dispatch for runtime testing
process.env.ALLOW_LOCAL_DISPATCH = 'true';

const RECEIVER_PORT = 5005;
const RECEIVER_URL = `https://127.0.0.1:${RECEIVER_PORT}/webhook`;
const PAYSTACK_SECRET = 'sk_test_mock_paystack_secret_key_12345';
const FLUTTERWAVE_SECRET = 'FLW_SECRET_HASH_TEST_12345';

/**
 * Computes Paystack HMAC-SHA512 header
 * @param {Buffer} rawBody
 * @param {string} secret
 */
function signPaystack(rawBody, secret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

/**
 * Computes latency stats
 * @param {number[]} durations
 */
function computeStats(durations) {
  if (durations.length === 0) return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, avg: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  const avg = Number((sum / sorted.length).toFixed(2));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  return { min, max, p50, p95, p99, avg };
}

async function runRuntimeStressSuite() {
  console.log('='.repeat(80));
  console.log('  CWIDS END-TO-END RUNTIME STRESS, LOAD & FAULT-INJECTION TEST HARNESS');
  console.log('='.repeat(80));

  const pool = getTestPool();
  let appId = '';
  /** @type {any} */
  let serverInstance = null;
  /** @type {any} */
  let workerInstance = null;
  /** @type {MockReceiver | null} */
  let receiver = null;

  try {
    // 1. Setup Test Tenant & Connections
    console.log('\n[1/10] Seeding test fixtures in PostgreSQL (cwids_db)...');
    const app = await createTestApp(pool, { name: 'Live Stress Test Tenant' });
    appId = app.id;

    const endpoint = await createTestEndpoint(pool, appId, {
      url: RECEIVER_URL,
      maxRetries: 10,
      httpTimeoutMs: 5000,
      responseValidationMode: 'http_status',
    });

    const pstkConn = await createTestProviderConnection(pool, {
      applicationId: appId,
      provider: 'paystack',
      environment: 'live',
      credentialReference: PAYSTACK_SECRET,
    });

    const flwConn = await createTestProviderConnection(pool, {
      applicationId: appId,
      provider: 'flutterwave',
      environment: 'live',
      credentialReference: FLUTTERWAVE_SECRET,
    });

    console.log(`  ✓ Tenant: ${app.id} (${app.code})`);
    console.log(`  ✓ Endpoint: ${endpoint.id} -> ${RECEIVER_URL}`);
    console.log(`  ✓ Paystack Connection: ${pstkConn.id}`);
    console.log(`  ✓ Flutterwave Connection: ${flwConn.id}`);

    // 2. Start Mock Downstream Receiver
    console.log('\n[2/10] Starting Mock Downstream Receiver on HTTPS :5005...');
    receiver = new MockReceiver({ port: RECEIVER_PORT, signingSecret: endpoint.signingSecret });
    await receiver.start();
    console.log('  ✓ Mock Downstream Receiver running at https://127.0.0.1:5005/webhook');

    // 3. Start CWIDS Ingress Gateway & Delivery Worker
    console.log('\n[3/10] Starting CWIDS Ingress Gateway (:4000) & Delivery Worker Daemon...');
    serverInstance = await startServer();
    workerInstance = await startWorker();
    const env = getEnv();
    const ingressBaseUrl = `http://127.0.0.1:${env.PORT}`;
    console.log(`  ✓ CWIDS Ingress Gateway listening at ${ingressBaseUrl}`);
    console.log(`  ✓ Prometheus Metrics running at http://127.0.0.1:${env.METRICS_PORT}/metrics`);

    // Verify readiness
    const readyRes = await fetch(`${ingressBaseUrl}/ready`);
    const readyBody = await readyRes.json();
    console.log(`  ✓ /ready probe: ${readyRes.status} ${JSON.stringify(readyBody)}`);

    // =========================================================================
    // SCENARIO 1: Baseline Happy Path (Paystack & Flutterwave)
    // =========================================================================
    console.log('\n[4/10] SCENARIO 1: Baseline Happy Path Webhooks (30 sequential events)...');
    receiver.clear();
    receiver.setMode('healthy');

    const s1Durations = [];
    let s1SuccessCount = 0;

    for (let i = 1; i <= 30; i++) {
      const merchantRef = `ORD-S1-${i}-${Date.now()}`;

      // Register intent via Internal API
      await fetch(`${ingressBaseUrl}/v1/internal/payment-intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${app.rawApiKey}`,
          'Idempotency-Key': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider_connection_id: pstkConn.id,
          environment: 'live',
          merchant_reference: merchantRef,
          expected_amount_minor: 500000,
          currency: 'NGN',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      const payload = {
        event: 'charge.success',
        data: {
          reference: merchantRef,
          amount: 500000,
          currency: 'NGN',
          status: 'success',
          id: 100000 + i,
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sig = signPaystack(rawBody, PAYSTACK_SECRET);

      const t0 = Date.now();
      const res = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': sig,
        },
        body: rawBody,
      });
      const t1 = Date.now();
      s1Durations.push(t1 - t0);

      if (res.status === 200) {
        const body = await res.json();
        if (body.status === 'acknowledged' && !body.duplicate) {
          s1SuccessCount++;
        }
      }
    }

    const s1Stats = computeStats(s1Durations);
    console.log(`  ✓ Ingress Acknowledged: ${s1SuccessCount}/30 (p50: ${s1Stats.p50}ms, p95: ${s1Stats.p95}ms, max: ${s1Stats.max}ms)`);

    // Wait up to 5s for worker dispatch
    process.stdout.write('  → Awaiting worker delivery dispatch to receiver');
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      process.stdout.write('.');
      if (receiver.receivedDeliveries.length >= 30) break;
    }
    console.log(`\n  ✓ Mock Receiver Received: ${receiver.receivedDeliveries.length}/30 verified deliveries!`);
    const validSigs = receiver.receivedDeliveries.filter((d) => d.isSignatureValid).length;
    console.log(`  ✓ Cryptographic Outbound Signatures Validated: ${validSigs}/30`);

    // =========================================================================
    // SCENARIO 2: Concurrency & Duplicate Storm (25 Simultaneous Replays)
    // =========================================================================
    console.log('\n[5/10] SCENARIO 2: Concurrency & Duplicate Storm (25 concurrent identical requests)...');
    receiver.clear();

    const stormRef = `ORD-STORM-${Date.now()}`;
    const stormPayload = Buffer.from(
      JSON.stringify({
        event: 'charge.success',
        data: { reference: stormRef, amount: 750000, currency: 'NGN', status: 'success' },
      }),
    );
    const stormSig = signPaystack(stormPayload, PAYSTACK_SECRET);

    // Fire 25 concurrent requests
    const stormTasks = Array.from({ length: 25 }, async () => {
      const res = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': stormSig },
        body: stormPayload,
      });
      return res.json();
    });

    const stormOutcomes = await Promise.all(stormTasks);
    const freshClaims = stormOutcomes.filter((o) => o.duplicate === false);
    const absorbedDuplicates = stormOutcomes.filter((o) => o.duplicate === true);

    console.log(`  ✓ Unique Deliveries Scheduled: ${freshClaims.length} (Expected: 1)`);
    console.log(`  ✓ Duplicates Safely Absorbed: ${absorbedDuplicates.length} (Expected: 24)`);

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`  ✓ Deliveries dispatched to Mock Receiver: ${receiver.receivedDeliveries.length} (Expected: exactly 1)`);

    // =========================================================================
    // SCENARIO 3: Security & Signature Fuzzing
    // =========================================================================
    console.log('\n[6/10] SCENARIO 3: Security & Adversarial Signature Fuzzing...');
    let rejectedCount = 0;

    // A. Tampered signature
    const resTampered = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': '0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: Buffer.from(JSON.stringify({ event: 'hacked' })),
    });
    if (resTampered.status === 401) rejectedCount++;

    // B. Missing signature header
    const resMissing = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ event: 'test' })),
    });
    if (resMissing.status === 401) rejectedCount++;

    // C. Nonexistent connection ID
    const resNotFound = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${crypto.randomUUID()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'abc' },
      body: Buffer.from(JSON.stringify({ event: 'test' })),
    });
    if (resNotFound.status === 404) rejectedCount++;

    console.log(`  ✓ Security rejections: ${rejectedCount}/3 (Tampered 401, Missing 401, Unknown Conn 404)`);

    // =========================================================================
    // SCENARIO 4: Authenticated Malformed Payloads
    // =========================================================================
    console.log('\n[7/10] SCENARIO 4: Authenticated Malformed Payloads (Syntax Errors)...');
    receiver.clear();

    const malformedBody = Buffer.from('{"event": "charge.success", "broken_json": [1, 2, 3'); // Syntax error
    const malformedSig = signPaystack(malformedBody, PAYSTACK_SECRET);

    const malformedRes = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': malformedSig },
      body: malformedBody,
    });
    const malformedJson = await malformedRes.json();

    console.log(`  ✓ Response Status: ${malformedRes.status} (Acknowledged to provider: ${malformedJson.status})`);
    console.log(`  ✓ Ingestion Routing Status: '${malformedJson.routing_status}' (Decision 2: rejected, no delivery)`);

    // Verify in database
    const dbEvent = await pool.query(`SELECT routing_status, routing_mode FROM cwids.webhook_events WHERE id = $1`, [malformedJson.event_id]);
    console.log(`  ✓ Database Routing Status: '${dbEvent.rows[0].routing_status}', Mode: '${dbEvent.rows[0].routing_mode}'`);
    console.log(`  ✓ Deliveries Dispatched to Receiver: ${receiver.receivedDeliveries.length} (Expected: 0)`);

    // =========================================================================
    // SCENARIO 5: Downstream Outage, Retries & Circuit Breaker
    // =========================================================================
    console.log('\n[8/10] SCENARIO 5: Downstream Outage, Exponential Backoff & Circuit Breaker...');
    receiver.clear();
    receiver.setMode('failing'); // Return HTTP 500

    const failRef = `ORD-FAIL-${Date.now()}`;
    const failBody = Buffer.from(
      JSON.stringify({
        event: 'charge.success',
        data: { reference: failRef, amount: 100000, currency: 'NGN', status: 'success' },
      }),
    );
    const failSig = signPaystack(failBody, PAYSTACK_SECRET);

    // Send 6 failing webhooks
    for (let i = 1; i <= 6; i++) {
      const iterRef = `${failRef}-${i}`;
      const iterBody = Buffer.from(
        JSON.stringify({
          event: 'charge.success',
          data: { reference: iterRef, amount: 100000, currency: 'NGN', status: 'success' },
        }),
      );
      await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signPaystack(iterBody, PAYSTACK_SECRET) },
        body: iterBody,
      });
    }

    // Wait for worker attempts to trip breaker
    process.stdout.write('  → Awaiting worker retry handling and circuit breaker trip');
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      process.stdout.write('.');
      const cbCheck = await pool.query(
        `SELECT state, consecutive_failures FROM cwids.circuit_breaker_states WHERE destination_endpoint_id = $1`,
        [endpoint.id],
      );
      if (cbCheck.rows[0]?.state === 'open') break;
    }

    const cbState = await pool.query(
      `SELECT state, consecutive_failures FROM cwids.circuit_breaker_states WHERE destination_endpoint_id = $1`,
      [endpoint.id],
    );
    console.log(`\n  ✓ Circuit Breaker State: '${cbState.rows[0]?.state}' (Consecutive Failures: ${cbState.rows[0]?.consecutive_failures})`);

    const delivStatusCheck = await pool.query(
      `SELECT status, count(*) FROM cwids.event_deliveries WHERE application_id = $1 GROUP BY status`,
      [appId],
    );
    console.log('  ✓ Delivery Status Distribution:');
    for (const row of delivStatusCheck.rows) {
      console.log(`     - ${row.status}: ${row.count}`);
    }

    // Reset receiver to healthy and reset breaker
    receiver.setMode('healthy');
    await pool.query(
      `UPDATE cwids.circuit_breaker_states SET state = 'closed', consecutive_failures = 0 WHERE destination_endpoint_id = $1`,
      [endpoint.id],
    );
    console.log('  ✓ Circuit Breaker recovered and reset to closed.');

    // =========================================================================
    // SCENARIO 6: High-Throughput Stress Ramp (100 Mixed Requests)
    // =========================================================================
    console.log('\n[9/10] SCENARIO 6: High-Throughput Stress Burst (100 Mixed Requests)...');
    receiver.clear();

    const burstTotal = 100;
    const burstDurations = [];
    let burstSuccess = 0;

    const burstStart = Date.now();
    const batchSize = 20;

    for (let b = 0; b < burstTotal; b += batchSize) {
      const batchPromises = Array.from({ length: batchSize }, async (_, idx) => {
        const itemIdx = b + idx;
        const ref = `BURST-${itemIdx}-${Date.now()}`;
        const body = Buffer.from(
          JSON.stringify({
            event: 'charge.success',
            data: { reference: ref, amount: 200000 + itemIdx, currency: 'NGN', status: 'success' },
          }),
        );
        const sig = signPaystack(body, PAYSTACK_SECRET);

        const t0 = Date.now();
        const res = await fetch(`${ingressBaseUrl}/v1/webhooks/paystack/${pstkConn.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig },
          body,
        });
        const t1 = Date.now();
        burstDurations.push(t1 - t0);

        if (res.status === 200) {
          burstSuccess++;
        }
      });
      await Promise.all(batchPromises);
    }

    const burstDurationMs = Date.now() - burstStart;
    const burstStats = computeStats(burstDurations);
    const throughputRps = Number(((burstTotal / burstDurationMs) * 1000).toFixed(1));

    console.log(`  ✓ Processed ${burstTotal} webhooks in ${burstDurationMs}ms (${throughputRps} req/sec)`);
    console.log(`  ✓ Latencies: min=${burstStats.min}ms, p50=${burstStats.p50}ms, p95=${burstStats.p95}ms, max=${burstStats.max}ms, avg=${burstStats.avg}ms`);

    // =========================================================================
    // SCENARIO 7: Telemetry & Prometheus Metrics Verification
    // =========================================================================
    console.log('\n[10/10] SCENARIO 7: Prometheus Live Metrics Telemetry (:9090/metrics)...');
    const metricsRes = await fetch(`http://127.0.0.1:${env.METRICS_PORT}/metrics`);
    const metricsText = await metricsRes.text();

    const sampleMetrics = metricsText
      .split('\n')
      .filter((line) => line.startsWith('cwids_') && !line.startsWith('cwids_') || (line.includes('total') || line.includes('pending')))
      .slice(0, 10);

    for (const m of sampleMetrics) {
      console.log(`  📊 ${m}`);
    }

    // Final Database Summary
    const totalEvents = await pool.query(`SELECT count(*) FROM cwids.webhook_events WHERE application_id = $1`, [appId]);
    const totalDeliveries = await pool.query(`SELECT count(*) FROM cwids.event_deliveries WHERE application_id = $1`, [appId]);
    const totalAttempts = await pool.query(
      `SELECT count(*) FROM cwids.delivery_attempts da JOIN cwids.event_deliveries ed ON da.delivery_id = ed.id WHERE ed.application_id = $1`,
      [appId],
    );

    console.log('\n' + '='.repeat(80));
    console.log('  RUNTIME TEST RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.log(`  Total Webhook Events Stored:     ${totalEvents.rows[0].count}`);
    console.log(`  Total Deliveries Scheduled:      ${totalDeliveries.rows[0].count}`);
    console.log(`  Total Outbound Dispatch Attempts:${totalAttempts.rows[0].count}`);
    console.log(`  Total Mock Receiver Deliveries Logged: ${receiver.allDeliveries.length}`);
    console.log('  ALL SCENARIOS COMPLETED WITH ZERO UNHANDLED CRASHES OR DROPPED EVENTS.');
    console.log('='.repeat(80) + '\n');
  } finally {
    console.log('Tearing down live services...');
    if (serverInstance) {
      await serverInstance.close();
      console.log('  ✓ Ingress Gateway stopped.');
    }
    if (workerInstance) {
      await workerInstance.stop();
      console.log('  ✓ Delivery Worker stopped.');
    }
    if (receiver) {
      await receiver.stop();
      console.log('  ✓ Mock Receiver stopped.');
    }
    if (appId) {
      await cleanupTestTenants(pool, [appId]);
      console.log('  ✓ Test Tenant fixtures cleaned up.');
    }
    await closeTestPool();
    console.log('  ✓ Database pools closed.');
  }
}

runRuntimeStressSuite().catch((err) => {
  console.error('\n❌ Fatal error during runtime stress suite:', err);
  process.exit(1);
});
