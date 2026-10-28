import crypto from 'node:crypto';
import { constantTimeCompare } from '../providers/base-adapter.mjs';

/**
 * Generates an outbound webhook authentication signature header (FR-010).
 * Format: t=<timestamp_seconds>,v1=<hex_signature>
 *
 * @param {string} deliveryId - Delivery UUID.
 * @param {Buffer | string} payload - Request body.
 * @param {string} secret - Shared application signing secret.
 * @param {number} [timestampSeconds=Math.floor(Date.now() / 1000)]
 * @returns {string} Value for X-CWIDS-Signature header.
 */
export function generateOutboundSignature(
  deliveryId,
  payload,
  secret,
  timestampSeconds = Math.floor(Date.now() / 1000),
) {
  const payloadString = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  const canonicalString = `${timestampSeconds}.${deliveryId}.${payloadString}`;
  const signatureHex = crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
  return `t=${timestampSeconds},v1=${signatureHex}`;
}

/**
 * Validates an incoming outbound signature header (useful for receivers and tests).
 *
 * @param {string} headerValue - Full header string (t=...,v1=...).
 * @param {string} deliveryId
 * @param {Buffer | string} payload
 * @param {string} secret
 * @param {number} [toleranceSeconds=300] - 5-minute clock drift tolerance.
 * @returns {boolean}
 */
export function verifyOutboundSignature(
  headerValue,
  deliveryId,
  payload,
  secret,
  toleranceSeconds = 300,
) {
  if (!headerValue || typeof headerValue !== 'string') return false;

  const parts = headerValue.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestampSeconds = Number.parseInt(timestampPart.replace('t=', ''), 10);
  const signatureHex = signaturePart.replace('v1=', '');

  if (Number.isNaN(timestampSeconds) || !signatureHex) return false;

  const currentSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(currentSeconds - timestampSeconds) > toleranceSeconds) {
    return false; // Signature expired or excessive clock drift
  }

  const expectedHeader = generateOutboundSignature(deliveryId, payload, secret, timestampSeconds);
  const expectedSignature = expectedHeader.split('v1=')[1];

  return constantTimeCompare(signatureHex, expectedSignature);
}
