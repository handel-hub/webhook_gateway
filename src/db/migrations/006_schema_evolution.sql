-- CWIDS Migration 006: Schema Evolution (Epochs, Secrets, Breakers & Enums)
-- Safe on populated tables.

SET search_path TO cwids, public;

-- 1. Redrive Epoch & Horizon Tracking on event_deliveries
ALTER TABLE cwids.event_deliveries 
    ADD COLUMN IF NOT EXISTS epoch_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS epoch_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS redrive_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS horizon_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_event_deliveries_tenant_schedule 
    ON cwids.event_deliveries (application_id, status, next_attempt_at);

-- 2. Destination Endpoints: Secret Envelope Encryption & Validation Modes
ALTER TABLE cwids.destination_endpoints 
    ALTER COLUMN signing_secret DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS encrypted_signing_secret BYTEA,
    ADD COLUMN IF NOT EXISTS secret_nonce BYTEA,
    ADD COLUMN IF NOT EXISTS secret_tag BYTEA,
    ADD COLUMN IF NOT EXISTS secret_kek_version TEXT DEFAULT 'v1',
    ADD COLUMN IF NOT EXISTS response_validation_mode TEXT NOT NULL DEFAULT 'http_status';

ALTER TABLE cwids.destination_endpoints 
    DROP CONSTRAINT IF EXISTS ck_endpoint_validation_mode;
ALTER TABLE cwids.destination_endpoints 
    ADD CONSTRAINT ck_endpoint_validation_mode CHECK (response_validation_mode IN ('envelope', 'http_status'));

-- 3. Application Lifecycle Enum Alignment (Include 'pending')
ALTER TABLE cwids.applications 
    DROP CONSTRAINT IF EXISTS ck_application_status;
ALTER TABLE cwids.applications 
    ADD CONSTRAINT ck_application_status CHECK (status IN ('pending', 'active', 'suspended', 'disabled', 'retired'));

-- 4. Circuit Breaker Row Provisioning Trigger & Backfill
CREATE OR REPLACE FUNCTION cwids.fn_ensure_circuit_breaker()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO cwids.circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight, updated_at)
    VALUES (NEW.id, 'closed', 0, false, CURRENT_TIMESTAMP)
    ON CONFLICT (destination_endpoint_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_endpoint_circuit_breaker ON cwids.destination_endpoints;
CREATE TRIGGER trg_endpoint_circuit_breaker
AFTER INSERT ON cwids.destination_endpoints
FOR EACH ROW
EXECUTE FUNCTION cwids.fn_ensure_circuit_breaker();

-- Backfill circuit_breaker_states for any destination_endpoints missing a row
INSERT INTO cwids.circuit_breaker_states (destination_endpoint_id, state, consecutive_failures, half_open_probe_in_flight, updated_at)
SELECT id, 'closed', 0, false, CURRENT_TIMESTAMP
FROM cwids.destination_endpoints
ON CONFLICT (destination_endpoint_id) DO NOTHING;
