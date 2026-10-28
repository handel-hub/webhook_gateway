-- CWIDS Migration 002: Row-Level Security Policies & Least-Privilege Roles
-- Enforces tenant isolation at the database engine tier.

SET search_path TO cwids, public;

-- 1. Enable and Force RLS on all Tenant-Scoped Tables
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;

ALTER TABLE destination_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE destination_endpoints FORCE ROW LEVEL SECURITY;

ALTER TABLE payment_intent_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intent_correlations FORCE ROW LEVEL SECURITY;

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;

ALTER TABLE event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries FORCE ROW LEVEL SECURITY;

-- 2. Drop existing policies if re-running
DROP POLICY IF EXISTS tenant_isolation_applications ON applications;
DROP POLICY IF EXISTS tenant_isolation_endpoints ON destination_endpoints;
DROP POLICY IF EXISTS tenant_isolation_intents ON payment_intent_correlations;
DROP POLICY IF EXISTS tenant_isolation_events ON webhook_events;
DROP POLICY IF EXISTS tenant_isolation_deliveries ON event_deliveries;

-- 3. Define RLS Policies Bound to app.current_tenant Session Setting
CREATE POLICY tenant_isolation_applications ON applications
    FOR ALL
    USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation_endpoints ON destination_endpoints
    FOR ALL
    USING (application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation_intents ON payment_intent_correlations
    FOR ALL
    USING (application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation_events ON webhook_events
    FOR ALL
    USING (
        application_id IS NULL OR 
        application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    );

CREATE POLICY tenant_isolation_deliveries ON event_deliveries
    FOR ALL
    USING (application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- 4. Create Database Roles (Idempotent block)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cwids_ingress') THEN
        CREATE ROLE cwids_ingress;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cwids_worker') THEN
        CREATE ROLE cwids_worker;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cwids_admin') THEN
        CREATE ROLE cwids_admin;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cwids_migrator') THEN
        CREATE ROLE cwids_migrator;
    END IF;
END $$;

-- 5. Grant Permissions to Ingress and Worker Roles
GRANT USAGE ON SCHEMA cwids TO cwids_ingress, cwids_worker, cwids_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA cwids TO cwids_ingress, cwids_worker, cwids_admin;
GRANT INSERT, UPDATE ON webhook_events, event_deliveries, audit_outbox TO cwids_ingress;
GRANT INSERT, UPDATE ON event_deliveries, delivery_attempts, circuit_breaker_states TO cwids_worker;
GRANT INSERT, UPDATE ON payment_intent_correlations, payment_intent_aliases, reconciliation_records, administrative_audit_events TO cwids_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cwids TO cwids_ingress, cwids_worker, cwids_admin;
