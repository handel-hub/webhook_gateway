-- CWIDS Migration 007: Endpoint Version Audit on Delivery Attempts
-- Safe on populated tables.

SET search_path TO cwids, public;

ALTER TABLE cwids.delivery_attempts 
    ADD COLUMN IF NOT EXISTS destination_endpoint_id UUID REFERENCES cwids.destination_endpoints(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS endpoint_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_endpoint 
    ON cwids.delivery_attempts(destination_endpoint_id);
