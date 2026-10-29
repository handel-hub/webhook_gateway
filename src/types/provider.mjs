/**
 * CWIDS Provider Adapter and Reconciliation Contracts.
 */

/**
 * Normalized representation of inbound provider payload.
 * @typedef {object} NormalizedPayload
 * @property {string} eventType - Normalized event category (e.g. 'charge.completed', 'transfer.failed').
 * @property {string | null} merchantReference - Merchant order or transaction reference.
 * @property {string | null} providerReference - Provider transaction ID or flw_ref.
 * @property {string | null} virtualAccountId - Virtual bank account identifier.
 * @property {number | null} amountMinor - Transaction amount in integer minor units (kobo, cents).
 * @property {string | null} currency - Three-letter uppercase ISO currency code.
 * @property {string} providerStatus - Original raw status string from provider.
 * @property {Record<string, any>} rawData - Unaltered parsed JSON body object.
 */

/**
 * Verification result returned by provider adapters after evaluating raw bytes and headers.
 * @typedef {object} ProviderVerificationResult
 * @property {boolean} isValid - True if signature is cryptographically authentic.
 * @property {boolean} [isMalformed] - True if signature was authentic but payload was malformed JSON or unsupported.
 * @property {string | null} failureReason - Descriptive reason if verification failed.
 * @property {string} dedupeKey - Canonical length-prefixed deduplication key.
 * @property {NormalizedPayload | null} normalized - Normalized event payload if authentic.
 */

/**
 * Contract implemented by all inbound webhook provider adapters.
 * @typedef {object} ProviderAdapter
 * @property {string} providerName - Identifier of the provider (e.g. 'flutterwave', 'paystack').
 * @property {(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string) => Promise<ProviderVerificationResult>} verifyAndNormalize
 * @property {(parsedPayload: Record<string, any>) => string} generateDedupeKey
 */

/**
 * Verification outcome returned by provider reconciliation clients.
 * @typedef {object} ProviderReconciliationResult
 * @property {boolean} isSuccess - True if verification API responded with HTTP 200.
 * @property {string} providerStatus - Provider transaction status (e.g. 'successful', 'failed').
 * @property {number} amountMinor - Verified amount in minor units.
 * @property {string} currency - Verified currency code.
 * @property {string} reference - Verified transaction reference.
 * @property {Record<string, any>} rawResponse - Full parsed JSON verification body.
 */

/**
 * Contract implemented by optional provider reconciliation adapters.
 * @typedef {object} ReconciliationAdapter
 * @property {string} providerName
 * @property {(reference: string, secretKey: string, timeoutMs?: number) => Promise<ProviderReconciliationResult>} verifyTransaction
 */

export {};
