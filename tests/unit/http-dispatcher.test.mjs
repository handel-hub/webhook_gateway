import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dispatchWebhook } from '../../src/delivery/http-dispatcher.mjs';

test('dispatchWebhook: streaming response exceeding 2KB is severed and capped (TC-37)', async () => {
  // Start mock server emitting 50KB stream
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const chunk = Buffer.alloc(1024, 'A'); // 1KB chunks
    for (let i = 0; i < 50; i++) {
      res.write(chunk);
    }
    res.end();
  });

  await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
  // @ts-ignore
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/destination`;

  try {
    const result = await dispatchWebhook({
      deliveryId: 'deliv_test_truncation',
      targetUrl,
      payload: '{"test":"payload"}',
      signingSecret: 'secret_123',
      // Pass null agent for local HTTP test
      // @ts-ignore
      agent: undefined,
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(result.isTruncated, true);
    assert.ok(Buffer.byteLength(result.responseExcerpt, 'utf8') <= 2048);
    assert.equal(result.responseStatus, 'processed');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('dispatchWebhook: captures connection timeout as ETIMEDOUT', async () => {
  // Server that never responds
  const server = http.createServer((req, res) => {
    // Deliberately hold connection open
  });

  await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
  // @ts-ignore
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/hang`;

  try {
    const result = await dispatchWebhook({
      deliveryId: 'deliv_test_timeout',
      targetUrl,
      payload: '{"test":"timeout"}',
      signingSecret: 'secret_123',
      timeoutMs: 200, // Short timeout
      // @ts-ignore
      agent: undefined,
    });

    assert.equal(result.httpStatus, 0);
    assert.equal(result.errorCode, 'ETIMEDOUT');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('dispatchWebhook: transmits complete Model B-hybrid header set and unaltered raw payload', async () => {
  /** @type {Record<string, string | string[] | undefined>} */
  let capturedHeaders = {};
  /** @type {string} */
  let capturedBody = '';

  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      capturedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processed' }));
    });
  });

  await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
  // @ts-ignore
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/webhook-target`;

  const rawTestPayload = '{"provider_tx_id":998877,"customer":{"email":"user@test.com"},"amount":1500}';
  const deliveryId = 'd3b07384-d113-494a-a1b6-d3b07384d113';
  const eventId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const provider = 'flutterwave';
  const signingSecret = 'tenant_signing_secret_xyz';

  try {
    const result = await dispatchWebhook({
      deliveryId,
      eventId,
      provider,
      targetUrl,
      payload: rawTestPayload,
      signingSecret,
      // @ts-ignore
      agent: undefined,
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(result.responseStatus, 'processed');

    // Assert exact raw payload delivery
    assert.equal(capturedBody, rawTestPayload);

    // Assert all Model B-hybrid wire headers
    assert.equal(capturedHeaders['x-cwids-delivery-id'], deliveryId);
    assert.equal(capturedHeaders['x-cwids-event-id'], eventId);
    assert.equal(capturedHeaders['x-cwids-provider'], provider);
    assert.ok(capturedHeaders['x-cwids-timestamp']);
    assert.ok(capturedHeaders['x-cwids-signature']);

    const timestampNum = Number(capturedHeaders['x-cwids-timestamp']);
    assert.ok(!Number.isNaN(timestampNum) && timestampNum > 0);

    // Assert X-CWIDS-Signature contains t= matching timestamp and valid v1
    const sigHeader = String(capturedHeaders['x-cwids-signature']);
    assert.ok(sigHeader.includes(`t=${timestampNum}`));
    assert.ok(sigHeader.includes('v1='));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
