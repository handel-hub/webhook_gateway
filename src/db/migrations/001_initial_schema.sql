-- CWIDS Migration 001: Initial Relational Schema
-- Establishes extensions, schema namespace, tables, and constraints.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS cwids;
SET search_path TO cwids, public;

-- 1. APPLICATIONS (TENANTS)
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    api_key_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_application_status CHECK (status IN ('active', 'suspended', 'disabled', 'retired'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

-- 2. DESTINATION ENDPOINTS
CREATE TABLE IF NOT EXISTS destination_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1,
    url TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    http_timeout_ms INTEGER NOT NULL DEFAULT 5000,
    max_retries INTEGER NOT NULL DEFAULT 15,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_app_endpoint_version UNIQUE (application_id, version),
    CONSTRAINT ck_endpoint_timeout CHECK (http_timeout_ms BETWEEN 1000 AND 30000),
    CONSTRAINT ck_endpoint_url_https CHECK (url ~* '^https://.*'),
    CONSTRAINT ck_endpoint_status CHECK (status IN ('active', 'deprecated', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_dest_endpoints_app ON destination_endpoints(application_id, status);

-- 3. PROVIDER CONNECTIONS
CREATE TABLE IF NOT EXISTS provider_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    name TEXT NOT NULL,
    application_id UUID REFERENCES applications(id) ON DELETE RESTRICT,
    credential_reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_provider_name CHECK (provider IN ('flutterwave', 'paystack')),
    CONSTRAINT ck_provider_env CHECK (environment IN ('live', 'test', 'sandbox')),
    CONSTRAINT ck_provider_status CHECK (status IN ('active', 'suspended', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_lookup ON provider_connections(provider, environment, status);

-- 4. PAYMENT INTENT CORRELATIONS (MODE A ROUTING)
CREATE TABLE IF NOT EXISTS payment_intent_correlations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
    environment TEXT NOT NULL,
    merchant_reference TEXT NOT NULL,
    expected_amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_intent_merchant_ref UNIQUE (provider_connection_id, environment, merchant_reference),
    CONSTRAINT uq_intent_app_idempotency UNIQUE (application_id, idempotency_key),
    CONSTRAINT ck_intent_amount CHECK (expected_amount_minor >= 0),
    CONSTRAINT ck_intent_status CHECK (status IN ('active', 'consumed', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_intent_lookup ON payment_intent_correlations(provider_connection_id, environment, merchant_reference) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_intent_cleanup ON payment_intent_correlations(expires_at, id) WHERE status IN ('active', 'expired');

-- 5. PAYMENT INTENT ALIASES (MODE C ROUTING)
CREATE TABLE IF NOT EXISTS payment_intent_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_intent_id UUID NOT NULL REFERENCES payment_intent_correlations(id) ON DELETE CASCADE,
    provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
    environment TEXT NOT NULL,
    alias_type TEXT NOT NULL,
    alias_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_intent_alias UNIQUE (provider_connection_id, environment, alias_type, alias_value),
    CONSTRAINT ck_alias_type CHECK (alias_type IN ('provider_reference', 'virtual_account_id', 'session_id'))
);

CREATE INDEX IF NOT EXISTS idx_intent_alias_lookup ON payment_intent_aliases(provider_connection_id, environment, alias_type, alias_value);

-- 6. WEBHOOK EVENTS (AUTHORITATIVE EVENT STORE)
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    identity_strategy_version INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    provider_event_id TEXT,
    event_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_reference TEXT NOT NULL,
    application_id UUID REFERENCES applications(id) ON DELETE RESTRICT,
    payment_intent_id UUID REFERENCES payment_intent_correlations(id) ON DELETE RESTRICT,
    routing_status TEXT NOT NULL,
    routing_mode TEXT NOT NULL,
    encrypted_payload BYTEA,
    payload_nonce BYTEA,
    payload_tag BYTEA,
    wrapped_dek BYTEA,
    kek_version TEXT NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload_deleted_at TIMESTAMPTZ,
    legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_webhook_events_dedupe UNIQUE (provider_connection_id, environment, identity_strategy_version, dedupe_key),
    CONSTRAINT ck_event_routing_status CHECK (routing_status IN ('resolved', 'awaiting_route', 'quarantined', 'rejected')),
    CONSTRAINT ck_resolved_app CHECK (routing_status != 'resolved' OR application_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_routing ON webhook_events(routing_status, received_at) WHERE routing_status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_webhook_events_intent ON webhook_events(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(application_id, received_at);

-- 7. EVENT DELIVERIES (DURABLE WORK QUEUE)
CREATE TABLE IF NOT EXISTS event_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    destination_endpoint_id UUID NOT NULL REFERENCES destination_endpoints(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_attempt_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_expires_at TIMESTAMPTZ,
    fencing_token BIGINT NOT NULL DEFAULT 0,
    claimed_by_worker TEXT,
    last_http_status INTEGER,
    last_error_code TEXT,
    terminal_reason TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_delivery UNIQUE (event_id, application_id),
    CONSTRAINT ck_delivery_status CHECK (status IN ('pending', 'in_flight', 'retry_scheduled', 'delivered', 'dead_lettered', 'cancelled')),
    CONSTRAINT ck_delivery_attempts CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_tenant_active ON event_deliveries (application_id, status);

-- 8. DELIVERY ATTEMPTS (APPEND-ONLY NETWORK AUDIT)
CREATE TABLE IF NOT EXISTS delivery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID NOT NULL REFERENCES event_deliveries(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    fencing_token BIGINT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER NOT NULL,
    http_status INTEGER,
    response_status TEXT,
    response_body_excerpt TEXT,
    response_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    error_code TEXT,
    error_message TEXT,
    worker_identity TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_delivery_attempt_num UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_deliv ON delivery_attempts(delivery_id, attempt_number);

-- 9. CIRCUIT BREAKER STATES
CREATE TABLE IF NOT EXISTS circuit_breaker_states (
    destination_endpoint_id UUID PRIMARY KEY REFERENCES destination_endpoints(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'closed',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    half_open_probe_in_flight BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_circuit_state CHECK (state IN ('closed', 'open', 'half_open'))
);

-- 10. ADMINISTRATIVE AUDIT EVENTS & OUTBOX
CREATE TABLE IF NOT EXISTS administrative_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_identity TEXT NOT NULL,
    application_id UUID REFERENCES applications(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason_code TEXT,
    before_state JSONB,
    after_state JSONB,
    audit_class TEXT NOT NULL DEFAULT 'operational',
    legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_audit_class CHECK (audit_class IN ('security', 'operational', 'compliance'))
);

CREATE TABLE IF NOT EXISTS audit_outbox (
    id BIGSERIAL PRIMARY KEY,
    audit_event_id UUID NOT NULL REFERENCES administrative_audit_events(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_outbox_status CHECK (status IN ('pending', 'exported', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_audit_outbox_pending ON audit_outbox(id) WHERE status = 'pending';

-- 11. RECONCILIATION RECORDS
CREATE TABLE IF NOT EXISTS reconciliation_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_intent_id UUID NOT NULL REFERENCES payment_intent_correlations(id) ON DELETE CASCADE,
    provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'matched',
    provider_status TEXT,
    verified_amount_minor BIGINT,
    verified_currency VARCHAR(3),
    verified_reference TEXT,
    raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    discrepancy_notes TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_recon_status CHECK (status IN ('matched', 'discrepancy_detected', 'quarantined', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_recon_intent ON reconciliation_records(payment_intent_id, checked_at);
