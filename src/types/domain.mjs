/**
 * CWIDS Core Domain Entity and Ingestion Contracts.
 */

/**
 * Validated inbound webhook raw byte buffer and transport metadata.
 * @typedef {object} ValidatedWebhookInput
 * @property {string} provider - Provider identifier ('flutterwave' | 'paystack').
 * @property {string} providerConnectionId - UUID of the provider connection.
 * @property {'live' | 'test'} environment - Runtime environment.
 * @property {Buffer} rawBodyBuffer - Unaltered captured request body buffer.
 * @property {Record<string, string | string[] | undefined>} headers - Inbound HTTP headers.
 * @property {string} payloadSha256 - SHA-256 hex digest of rawBodyBuffer.
 * @property {Record<string, any>} parsedPayload - Safely parsed JSON payload object.
 */

/**
 * Extracted routing correlation keys from normalized provider payload.
 * @typedef {object} RoutingKeys
 * @property {string | null} merchantReference - Merchant order or transaction reference.
 * @property {string | null} providerReference - Provider transaction ID or flw_ref.
 * @property {string | null} virtualAccountId - Virtual bank account identifier.
 */

/**
 * Disposition of event routing.
 * @typedef {'resolved' | 'awaiting_route' | 'quarantined' | 'rejected'} RoutingStatus
 */

/**
 * Deterministic routing strategy mode utilized.
 * @typedef {'MODE_A_MERCHANT_REFERENCE' | 'MODE_B_DEDICATED_CONNECTION' | 'MODE_C_DYNAMIC_ALIAS' | 'UNRESOLVED_NO_MATCH' | 'CONFLICT_MULTIPLE_MATCHES'} RoutingMode
 */

/**
 * Deterministic local routing resolution result.
 * @typedef {object} RoutingResolution
 * @property {RoutingStatus} status - Final routing disposition.
 * @property {string | null} applicationId - Target application UUID (if resolved).
 * @property {string | null} paymentIntentId - Associated intent UUID (if resolved).
 * @property {RoutingMode} routingMode - Mode used to determine ownership.
 */

/**
 * Result of the 14-step atomic Tx-Ingest transaction.
 * @typedef {object} IngestionOutcome
 * @property {string} eventId - CWIDS logical event UUID.
 * @property {boolean} isDuplicate - Whether this request matched an existing dedupe key.
 * @property {RoutingStatus} routingStatus - Final routing status.
 * @property {string | null} deliveryId - Delivery obligation UUID (if created).
 * @property {Date} committedAt - PostgreSQL commit timestamp.
 */

/**
 * Database record for cwids.webhook_events.
 * @typedef {object} WebhookEventRecord
 * @property {string} id - UUID
 * @property {string} provider_connection_id - UUID
 * @property {'live' | 'test'} environment
 * @property {string} identity_strategy_version
 * @property {string} dedupe_key
 * @property {string} payload_sha256
 * @property {string | null} event_type
 * @property {string | null} merchant_reference
 * @property {string | null} provider_reference
 * @property {string | null} virtual_account_id
 * @property {number | null} amount_minor
 * @property {string | null} currency
 * @property {string | null} provider_status
 * @property {string | null} routing_status
 * @property {string | null} application_id - UUID
 * @property {string | null} payment_intent_id - UUID
 * @property {Buffer | null} encrypted_payload
 * @property {Buffer | null} payload_nonce
 * @property {Buffer | null} payload_tag
 * @property {Buffer | null} wrapped_dek
 * @property {Date} received_at
 * @property {Date | null} payload_deleted_at
 * @property {boolean} legal_hold
 */

/**
 * Database record for cwids.applications.
 * @typedef {object} ApplicationRecord
 * @property {string} id - UUID
 * @property {string} code
 * @property {string} name
 * @property {'pending' | 'active' | 'suspended' | 'disabled' | 'retired'} status
 * @property {string} api_key_hash
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * Database record for cwids.provider_connections.
 * @typedef {object} ProviderConnectionRecord
 * @property {string} id - UUID
 * @property {string | null} application_id - UUID (null for shared connections)
 * @property {string} provider - 'flutterwave' | 'paystack'
 * @property {'live' | 'test' | 'sandbox'} environment
 * @property {string} [name]
 * @property {string} secret_kms_ref
 * @property {boolean} is_active
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * Database record for cwids.destination_endpoints.
 * @typedef {object} DestinationEndpointRecord
 * @property {string} id - UUID
 * @property {string} application_id - UUID
 * @property {number} version
 * @property {string} url
 * @property {string | null} signing_secret
 * @property {Buffer | null} [encrypted_signing_secret]
 * @property {Buffer | null} [secret_nonce]
 * @property {Buffer | null} [secret_tag]
 * @property {string} [secret_kek_version]
 * @property {'envelope' | 'http_status'} response_validation_mode
 * @property {number} http_timeout_ms
 * @property {number} max_retries
 * @property {string} status
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * Database record for cwids.payment_intent_correlations.
 * @typedef {object} PaymentIntentRecord
 * @property {string} id - UUID
 * @property {string} application_id - UUID
 * @property {string} provider_connection_id - UUID
 * @property {string} environment
 * @property {string} merchant_reference
 * @property {number} expected_amount_minor
 * @property {string} currency
 * @property {'active' | 'expired' | 'consumed' | 'cancelled'} status
 * @property {string} idempotency_key
 * @property {Date} expires_at
 * @property {Record<string, any>} [metadata]
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * Database record for cwids.reconciliation_records.
 * @typedef {object} ReconciliationRecord
 * @property {string} id - UUID
 * @property {string} payment_intent_id - UUID
 * @property {string} provider_connection_id - UUID
 * @property {'matched' | 'discrepancy_detected' | 'quarantined' | 'resolved'} status
 * @property {string | null} provider_status
 * @property {number | null} verified_amount_minor
 * @property {string | null} verified_currency
 * @property {string | null} verified_reference
 * @property {Record<string, any>} raw_response
 * @property {string | null} discrepancy_notes
 * @property {Date} checked_at
 */

export {};
