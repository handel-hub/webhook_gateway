import crypto from 'node:crypto';
import { constantTimeCompare, encodePart } from '../base-adapter.mjs';

/**
 * @typedef {import('../../types/provider.mjs').ProviderAdapter} ProviderAdapter
 * @typedef {import('../../types/provider.mjs').ProviderVerificationResult} ProviderVerificationResult
 * @typedef {import('../../types/provider.mjs').NormalizedPayload} NormalizedPayload
 */

/** @type {ProviderAdapter} */
export const FlutterwaveAdapter = {
  providerName: 'flutterwave',

  /**
   * Generates a collision-resistant, length-prefixed deduplication key:
   * v1:flw:len(txRef):txRef:len(eventType):eventType
   * @param {Record<string, any>} parsedPayload
   * @returns {string}
   */
  generateDedupeKey(parsedPayload) {
    const data = parsedPayload.data ?? parsedPayload;
    const identifier = data.tx_ref || data.id || data.reference || 'unknown_id';
    const eventType = parsedPayload.event || parsedPayload['event.type'] || 'unknown_event';
    return `v1:flw:${encodePart(identifier)}:${encodePart(eventType)}`;
  },

  /**
   * Cryptographically verifies Flutterwave webhook signature and extracts normalized data.
   * Supports `verif-hash` secret token verification and HMAC-SHA256 signature verification.
   *
   * @param {Buffer} rawBody
   * @param {Record<string, string | string[] | undefined>} headers
   * @param {string} secret - Signing secret or verification hash.
   * @returns {Promise<ProviderVerificationResult>}
   */
  async verifyAndNormalize(rawBody, headers, secret) {
    const verifHash = headers['verif-hash'];
    const hmacHeader = headers['x-flutterwave-signature'];

    const signatureString = typeof verifHash === 'string'
      ? verifHash
      : (typeof hmacHeader === 'string' ? hmacHeader : null);

    if (!signatureString) {
      return {
        isValid: false,
        failureReason: 'Missing Flutterwave signature header (verif-hash or x-flutterwave-signature).',
        dedupeKey: 'invalid_signature',
        normalized: null,
      };
    }

    // 1. Direct verif-hash comparison (standard Flutterwave webhook mechanism)
    let isAuthentic = constantTimeCompare(signatureString, secret);

    // 2. Fallback to HMAC-SHA256 if direct hash match failed
    if (!isAuthentic) {
      const computedHmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      isAuthentic = constantTimeCompare(signatureString, computedHmac);
    }

    if (!isAuthentic) {
      return {
        isValid: false,
        failureReason: 'Invalid Flutterwave cryptographic signature.',
        dedupeKey: 'invalid_signature',
        normalized: null,
      };
    }

    // 3. Safely parse JSON payload
    /** @type {Record<string, any>} */
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      return {
        isValid: false,
        failureReason: 'Malformed JSON payload.',
        dedupeKey: 'malformed_json',
        normalized: null,
      };
    }

    const dedupeKey = this.generateDedupeKey(parsed);
    const data = parsed.data ?? parsed;

    // Flutterwave amounts are typically in decimal major units (e.g. 500.00 NGN)
    let amountMinor = null;
    if (data.amount !== undefined && data.amount !== null) {
      const parsedAmount = Number(data.amount);
      if (!Number.isNaN(parsedAmount)) {
        amountMinor = Math.round(parsedAmount * 100);
      }
    }

    /** @type {NormalizedPayload} */
    const normalized = {
      eventType: parsed.event || parsed['event.type'] || 'charge.completed',
      merchantReference: data.tx_ref ? String(data.tx_ref) : null,
      providerReference: data.id !== undefined && data.id !== null ? String(data.id) : (data.flw_ref ? String(data.flw_ref) : null),
      virtualAccountId: data.order_ref ? String(data.order_ref) : null,
      amountMinor,
      currency: data.currency ? String(data.currency).toUpperCase() : null,
      providerStatus: String(data.status || 'unknown'),
      rawData: parsed,
    };

    return {
      isValid: true,
      failureReason: null,
      dedupeKey,
      normalized,
    };
  },
};
