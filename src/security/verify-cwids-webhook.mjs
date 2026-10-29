import crypto from 'node:crypto';
import { constantTimeCompare } from '../providers/base-adapter.mjs';

/**
 * Result returned by verifyCwidsWebhook.
 * @typedef {object} CwidsWebhookVerificationResult
 * @property {boolean} isValid - True if signature is cryptographically valid and timestamp is fresh.
 * @property {string | null} deliveryId - CWIDS delivery UUID.
 * @property {string | null} eventId - CWIDS event UUID.
 * @property {string | null} provider - Originating provider (e.g. 'paystack', 'flutterwave').
 * @property {number | null} timestamp - Delivery timestamp (unix epoch seconds).
 * @property {string | null} failureReason - Error message if verification failed.
 */

/**
 * Case-insensitive header value lookup helper.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} headerName
 * @returns {string | null}
 */
function getHeader(headers, headerName) {
  if (!headers || typeof headers !== 'object') return null;
  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) return value[0] ?? null;
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/**
 * Production-ready verification helper for downstream applications consuming CWIDS webhooks.
 * Cryptographically verifies X-CWIDS-Signature, enforces clock drift tolerance,
 * and extracts standard delivery metadata without modifying the raw payload.
 *
 * @param {object} params
 * @param {Record<string, string | string[] | undefined>} params.headers - HTTP request headers.
 * @param {Buffer | string} params.rawBody - Exact raw request body buffer or string.
 * @param {string} params.signingSecret - Endpoint signing secret configured in CWIDS.
 * @param {number} [params.toleranceSeconds=300] - Maximum allowable clock drift (default 5 minutes).
 * @param {number} [params.currentTimestamp] - Current unix epoch seconds (override for testing).
 * @returns {CwidsWebhookVerificationResult}
 */
export function verifyCwidsWebhook({
  headers,
  rawBody,
  signingSecret,
  toleranceSeconds = 300,
  currentTimestamp,
}) {
  if (!signingSecret || typeof signingSecret !== 'string') {
    return {
      isValid: false,
      deliveryId: null,
      eventId: null,
      provider: null,
      timestamp: null,
      failureReason: 'Missing or invalid application signingSecret.',
    };
  }

  const deliveryId = getHeader(headers, 'x-cwids-delivery-id');
  const eventId = getHeader(headers, 'x-cwids-event-id');
  const provider = getHeader(headers, 'x-cwids-provider');
  const signatureHeader = getHeader(headers, 'x-cwids-signature');

  if (!deliveryId) {
    return {
      isValid: false,
      deliveryId: null,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: null,
      failureReason: 'Missing X-CWIDS-Delivery-ID header.',
    };
  }

  if (!signatureHeader) {
    return {
      isValid: false,
      deliveryId,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: null,
      failureReason: 'Missing X-CWIDS-Signature header.',
    };
  }

  // Parse signature header: t=<timestamp>,v1=<signatureHex>
  const parts = signatureHeader.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) {
    return {
      isValid: false,
      deliveryId,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: null,
      failureReason: 'Malformed X-CWIDS-Signature header format (expected t=...,v1=...).',
    };
  }

  const timestampSeconds = Number.parseInt(timestampPart.replace('t=', ''), 10);
  const signatureHex = signaturePart.replace('v1=', '');

  if (Number.isNaN(timestampSeconds) || !signatureHex) {
    return {
      isValid: false,
      deliveryId,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: null,
      failureReason: 'Invalid timestamp or signature value in X-CWIDS-Signature header.',
    };
  }

  // Enforce clock drift / replay window
  const now = currentTimestamp ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > toleranceSeconds) {
    return {
      isValid: false,
      deliveryId,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: timestampSeconds,
      failureReason: `Signature timestamp expired or excessive clock drift (delta: ${Math.abs(now - timestampSeconds)}s, max tolerance: ${toleranceSeconds}s).`,
    };
  }

  // Canonical string reconstruction: `${timestamp}.${deliveryId}.${rawBodyString}`
  const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : (typeof rawBody === 'string' ? rawBody : '');
  const canonicalString = `${timestampSeconds}.${deliveryId}.${bodyString}`;
  const computedSignatureHex = crypto.createHmac('sha256', signingSecret).update(canonicalString).digest('hex');

  const isAuthentic = constantTimeCompare(signatureHex, computedSignatureHex);

  if (!isAuthentic) {
    return {
      isValid: false,
      deliveryId,
      eventId: eventId ?? null,
      provider: provider ?? null,
      timestamp: timestampSeconds,
      failureReason: 'Cryptographic HMAC-SHA256 signature mismatch.',
    };
  }

  return {
    isValid: true,
    deliveryId,
    eventId: eventId ?? deliveryId,
    provider: provider ?? 'unknown',
    timestamp: timestampSeconds,
    failureReason: null,
  };
}
