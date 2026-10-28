-- CWIDS Migration 003: Partial Indexes & Autovacuum Tuning
-- Essential for sub-10ms SKIP LOCKED queue claims and index-assisted retention pruning.

SET search_path TO cwids, public;

-- 1. High-Performance Queue Partial Indexes
CREATE INDEX IF NOT EXISTS idx_event_deliveries_claimable 
    ON event_deliveries (next_attempt_at, id) 
    WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_event_deliveries_leases 
    ON event_deliveries (lease_expires_at) 
    WHERE status = 'in_flight';

-- 2. Data Retention Partial Cleanup Indexes
CREATE INDEX IF NOT EXISTS idx_webhook_events_payload_cleanup 
    ON webhook_events (received_at, id) 
    WHERE encrypted_payload IS NOT NULL AND legal_hold = FALSE;

CREATE INDEX IF NOT EXISTS idx_webhook_events_metadata_cleanup 
    ON webhook_events (received_at, id) 
    WHERE legal_hold = FALSE;

CREATE INDEX IF NOT EXISTS idx_audit_events_cleanup 
    ON administrative_audit_events (created_at, audit_class) 
    WHERE legal_hold = FALSE;

-- 3. Autovacuum Tuning for High-Churn Queue Table
ALTER TABLE event_deliveries SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_cost_limit = 1000,
    autovacuum_vacuum_cost_delay = 2
);
