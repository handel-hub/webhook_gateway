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
