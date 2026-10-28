import https from 'node:https';
import http from 'node:http';
import { ssrfAgent } from '../security/ssrf-agent.mjs';
import { generateOutboundSignature } from '../security/hmac-signer.mjs';
import { LIMITS } from '../config/limits.mjs';

/**
 * @typedef {import('../types/delivery.mjs').DeliveryAttemptResult} DeliveryAttemptResult
 * @typedef {import('../types/delivery.mjs').DestinationResponseStatus} DestinationResponseStatus
 */

/**
 * Dispatches an outbound webhook HTTP request with streaming response truncation at 2,048 bytes.
 *
 * @param {object} params
 * @param {string} params.deliveryId - Unique delivery UUID.
 * @param {string} params.targetUrl - Destination HTTPS URL.
 * @param {Buffer | string} params.payload - Webhook payload body.
 * @param {string} params.signingSecret - Application signing secret.
 * @param {number} [params.timeoutMs=15000] - Request timeout.
 * @param {any} [params.agent=ssrfAgent] - Custom agent (defaults to SSRF-guarded agent).
 * @returns {Promise<DeliveryAttemptResult>}
 */
export async function dispatchWebhook({
  deliveryId,
  targetUrl,
  payload,
  signingSecret,
  timeoutMs = LIMITS.HTTP_DISPATCH_TIMEOUT_MS,
  agent = ssrfAgent,
}) {
  const startTime = Date.now();
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const signatureHeader = generateOutboundSignature(deliveryId, payloadBuffer, signingSecret);

  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  /** @type {https.RequestOptions} */
  const requestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payloadBuffer.length,
      'User-Agent': 'CWIDS-Webhook-Delivery/1.0',
      'X-CWIDS-Delivery-ID': deliveryId,
      'X-CWIDS-Signature': signatureHeader,
    },
    timeout: timeoutMs,
    ...(isHttps ? { agent } : {}),
  };

  return new Promise((resolve) => {
    let resolved = false;

    /**
     * @param {DeliveryAttemptResult} result
     */
    function finish(result) {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    }

    const req = transport.request(requestOptions, (res) => {
      const httpStatus = res.statusCode ?? 0;
      /** @type {Buffer[]} */
      const chunks = [];
      let totalBytes = 0;
      let isTruncated = false;

      res.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;

        if (totalBytes <= LIMITS.MAX_RESPONSE_EXCERPT_BYTES) {
          chunks.push(buf);
        } else if (!isTruncated) {
          isTruncated = true;
          // Capture up to limit
          const remaining = LIMITS.MAX_RESPONSE_EXCERPT_BYTES - (totalBytes - buf.length);
          if (remaining > 0) {
            chunks.push(buf.subarray(0, remaining));
          }
          // Sever socket immediately to eliminate destination response memory inflation attack (SEC-007)
          res.destroy();
        }
      });

      res.on('end', () => {
        const durationMs = Date.now() - startTime;
        const responseExcerpt = Buffer.concat(chunks).toString('utf8');

        /** @type {DestinationResponseStatus} */
        let responseStatus = 'http_acknowledged_unverified';
        if (httpStatus >= 200 && httpStatus < 300) {
          responseStatus = 'processed';
        } else if (httpStatus === 409) {
          responseStatus = 'duplicate_acknowledged';
        } else if (httpStatus >= 400 && httpStatus < 500) {
          responseStatus = 'rejected';
        }

        finish({
          httpStatus,
          responseStatus,
          responseExcerpt,
          isTruncated,
          durationMs,
          errorCode: null,
          errorMessage: null,
        });
      });

      res.on('error', (err) => {
        finish({
          httpStatus,
          responseStatus: 'http_acknowledged_unverified',
          responseExcerpt: Buffer.concat(chunks).toString('utf8'),
          isTruncated,
          durationMs: Date.now() - startTime,
          errorCode: 'ECONNRESET',
          errorMessage: err.message,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({
        httpStatus: 0,
        responseStatus: 'http_acknowledged_unverified',
        responseExcerpt: '',
        isTruncated: false,
        durationMs: Date.now() - startTime,
        errorCode: 'ETIMEDOUT',
        errorMessage: `Request timed out after ${timeoutMs}ms`,
      });
    });

    req.on('error', (err) => {
      // @ts-ignore
      const code = err.code || 'ECONNREFUSED';
      finish({
        httpStatus: 0,
        responseStatus: 'http_acknowledged_unverified',
        responseExcerpt: '',
        isTruncated: false,
        durationMs: Date.now() - startTime,
        errorCode: code,
        errorMessage: err.message,
      });
    });

    req.write(payloadBuffer);
    req.end();
  });
}
