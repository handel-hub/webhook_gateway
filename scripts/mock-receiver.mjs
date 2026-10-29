import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { verifyOutboundSignature } from '../src/security/hmac-signer.mjs';

/**
 * @typedef {'healthy' | 'duplicate_ack' | 'no_content' | 'client_error' | 'rate_limited' | 'failing' | 'server_error' | 'bad_gateway' | 'service_unavailable' | 'socket_hangup' | 'massive_response' | 'slow' | 'flapping'} ReceiverMode
 */

export class MockReceiver {
  /**
   * @param {object} [options]
   * @param {number} [options.port=5005]
   * @param {string} [options.signingSecret]
   */
  constructor({ port = 5005, signingSecret = '' } = {}) {
    this.port = port;
    this.signingSecret = signingSecret;
    /** @type {ReceiverMode} */
    this.mode = 'healthy';
    this.consecutiveRequests = 0;
    /** @type {any[]} */
    this.receivedDeliveries = [];
    /** @type {any[]} */
    this.allDeliveries = [];
    /** @type {https.Server | null} */
    this.server = null;
  }

  setMode(mode) {
    this.mode = mode;
    this.consecutiveRequests = 0;
  }

  setSigningSecret(secret) {
    this.signingSecret = secret;
  }

  clear() {
    this.receivedDeliveries = [];
    this.consecutiveRequests = 0;
  }

  async start() {
    const certPath = path.resolve('scripts/certs/test-cert.pfx');
    const pfx = fs.readFileSync(certPath);

    this.server = https.createServer({ pfx, passphrase: 'password123' }, (req, res) => {
      const url = new URL(req.url || '/', `https://${req.headers.host || '127.0.0.1'}`);

      // Control endpoints
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: this.mode, count: this.receivedDeliveries.length, total: this.allDeliveries.length }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/deliveries') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: this.receivedDeliveries.length, total: this.allDeliveries.length, deliveries: this.receivedDeliveries }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/reset') {
        this.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reset_ok' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/mode') {
        /** @type {Buffer[]} */
        const bodyChunks = [];
        req.on('data', (c) => bodyChunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
            if (body.mode) this.setMode(body.mode);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'mode_updated', mode: this.mode }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // Webhook ingestion endpoint
      if (req.method === 'POST' && (url.pathname.startsWith('/webhook') || url.pathname === '/')) {
        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          this.consecutiveRequests++;
          const rawBody = Buffer.concat(chunks);
          const deliveryId = /** @type {string} */ (req.headers['x-cwids-delivery-id'] || '');
          const signature = /** @type {string} */ (req.headers['x-cwids-signature'] || '');

          let isSignatureValid = false;
          if (this.signingSecret && signature && deliveryId) {
            isSignatureValid = verifyOutboundSignature(signature, deliveryId, rawBody, this.signingSecret);
          }

          let parsedBody = null;
          try {
            parsedBody = JSON.parse(rawBody.toString('utf8'));
          } catch (_) {
            parsedBody = rawBody.toString('utf8');
          }

          const record = {
            deliveryId,
            signature,
            isSignatureValid,
            payload: parsedBody,
            headers: req.headers,
            url: req.url,
            receivedAt: new Date().toISOString(),
          };
          this.receivedDeliveries.push(record);
          this.allDeliveries.push(record);

          // Evaluate mock response mode (from query param, header, or instance mode)
          const modeFromQuery = url.searchParams.get('mode');
          const effectiveMode = modeFromQuery || req.headers['x-mock-mode'] || this.mode;

          // 1. Socket Hangup (abrupt drop without response)
          if (effectiveMode === 'socket_hangup') {
            req.socket.destroy();
            return;
          }

          // 2. Slow Response (12s to trigger client timeout)
          if (effectiveMode === 'slow') {
            await new Promise((resolve) => setTimeout(resolve, 12000));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'delayed_ok', deliveryId }));
            return;
          }

          // 3. Client Error (HTTP 400 Bad Request - Non-Retryable)
          if (effectiveMode === 'client_error') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Request (Client Error)', message: 'Non-retryable downstream rejection' }));
            return;
          }

          // 4. Rate Limited (HTTP 429 Too Many Requests with Retry-After)
          if (effectiveMode === 'rate_limited') {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3' });
            res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: 3 }));
            return;
          }

          // 5. Server Errors (500, 502, 503)
          if (effectiveMode === 'failing' || effectiveMode === 'server_error') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error (Simulated Downstream Failure)' }));
            return;
          }
          if (effectiveMode === 'bad_gateway') {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway' }));
            return;
          }
          if (effectiveMode === 'service_unavailable') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service Unavailable' }));
            return;
          }

          // 6. Flapping (fails 5 times, then succeeds)
          if (effectiveMode === 'flapping') {
            if (this.consecutiveRequests <= 5) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Flapping failure ${this.consecutiveRequests}/5` }));
              return;
            }
          }

          // 7. No Content (HTTP 204)
          if (effectiveMode === 'no_content') {
            res.writeHead(204);
            res.end();
            return;
          }

          // 8. Massive Response Body (100 KB to verify 2,048-byte streaming truncation)
          if (effectiveMode === 'massive_response') {
            const bigData = 'X'.repeat(1024 * 100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'processed', deliveryId, payloadBlob: bigData }));
            return;
          }

          // 9. Duplicate Acknowledged
          if (effectiveMode === 'duplicate_ack') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'duplicate_acknowledged', deliveryId }));
            return;
          }

          // 10. Default: Healthy processed 200 OK
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'processed', deliveryId, acknowledgedAt: new Date().toISOString() }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    await new Promise((resolve, reject) => {
      this.server?.listen(this.port, () => resolve(undefined));
      this.server?.once('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server?.close(() => resolve(undefined)));
      this.server = null;
    }
  }
}

// Standalone execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('mock-receiver.mjs')) {
  const receiver = new MockReceiver({ port: 5005 });
  receiver.start().then(() => {
    console.log(`[MockReceiver] Running at https://127.0.0.1:5005/webhook`);
  });
}
