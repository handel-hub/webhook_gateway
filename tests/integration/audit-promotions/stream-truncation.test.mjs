import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dispatchWebhook } from '../../../src/delivery/http-dispatcher.mjs';

test('Stream Truncation: 50MB response stream severs immediately in <1000ms and resolves cleanly', { timeout: 1000 }, async (t) => {
  let interval = null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Connection': 'close' });
    const chunk = Buffer.alloc(64 * 1024, 'X');
    interval = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(chunk);
      } else {
        if (interval) clearInterval(interval);
      }
    }, 5);
    interval.unref();
    req.on('close', () => {
      if (interval) clearInterval(interval);
    });
  });

  await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const targetUrl = `http://127.0.0.1:${port}/webhook`;

  const startTime = Date.now();
  try {
    const outcome = await Promise.race([
      dispatchWebhook({
        deliveryId: 'd0000000-0000-0000-0000-000000000000',
        targetUrl,
        payload: Buffer.from('{}'),
        signingSecret: 'secret_test',
        timeoutMs: 800,
        agent: null,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('HANG: dispatchWebhook promise did not resolve upon res.destroy()')), 700)),
    ]);

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed < 1000, `Stream must sever within 1000ms (took ${elapsed}ms).`);
    assert.equal(outcome.httpStatus, 200);
    assert.equal(outcome.isTruncated, true);
    assert.equal(outcome.responseStatus, 'processed');
  } finally {
    if (interval) clearInterval(interval);
    server.closeAllConnections();
    server.close();
  }
});
