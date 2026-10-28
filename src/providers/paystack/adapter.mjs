import crypto from 'node:crypto';
import { constantTimeCompare, encodePart } from '../base-adapter.mjs';

/**
 * @typedef {import('../../types/provider.mjs').ProviderAdapter} ProviderAdapter
 * @typedef {import('../../types/provider.mjs').ProviderVerificationResult} ProviderVerificationResult
 * @typedef {import('../../types/provider.mjs').NormalizedPayload} NormalizedPayload
 */

/** @type {ProviderAdapter} */
export const PaystackAdapter = {
  providerName: 'paystack',

  /**
   * Generates a collision-resistant, length-prefixed deduplication key:
   * v1:pstk:len(reference):reference:len(event):event
   * @param {Record<string, any>} parsedPayload
   * @returns {string}
   */
  generateDedupeKey(parsedPayload) {
    const data = parsedPayload.data ?? parsedPayload;
    const identifier = data.reference || data.id || 'unknown_ref';
    const eventType = parsedPayload.event || 'unknown_event';
    return `v1:pstk:${encodePart(identifier)}:${encodePart(eventType)}`;
  },

  /**
   * Cryptographically verifies Paystack HMAC-SHA512 webhook signature.
   *
   * @param {Buffer} rawBody
   * @param {Record<string, string | string[] | undefined>} headers
   * @param {string} secret - Paystack secret key.
   * @returns {Promise<ProviderVerificationResult>}
   */
  async verifyAndNormalize(rawBody, headers, secret) {
    const signature = headers['x-paystack-signature'];
    if (typeof signature !== 'string' || !signature) {
      return {
        isValid: false,
        failureReason: 'Missing x-paystack-signature header.',
        dedupeKey: 'invalid_signature',
        normalized: null,
      };
    }

    const computedHmac = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    const isAuthentic = constantTimeCompare(signature, computedHmac);

    if (!isAuthentic) {
      return {
        isValid: false,
        failureReason: 'Invalid Paystack HMAC-SHA512 signature.',
        dedupeKey: 'invalid_signature',
        normalized: null,
      };
    }

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

    // Paystack amounts are already in integer minor units (kobo / cents)
    let amountMinor = null;
    if (data.amount !== undefined && data.amount !== null) {
      const parsedAmount = Number(data.amount);
      if (!Number.isNaN(parsedAmount)) {
        amountMinor = Math.round(parsedAmount);
      }
    }

    /** @type {NormalizedPayload} */
    const normalized = {
      eventType: parsed.event || 'charge.success',
      merchantReference: data.reference ? String(data.reference) : null,
      providerReference: data.id !== undefined && data.id !== null ? String(data.id) : null,
      virtualAccountId: data.dedicated_account_number || (data.customer?.customer_code ? String(data.customer.customer_code) : null),
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
