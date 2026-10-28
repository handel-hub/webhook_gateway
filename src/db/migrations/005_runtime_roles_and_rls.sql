-- CWIDS Migration 005: Runtime Roles Least Privilege & Complete RLS Coverage
-- Adds missing application_id FKs, enables RLS on all remaining tables, and defines explicit runtime role policies.

SET search_path TO cwids, public;

-- 1. Add application_id columns to tables lacking tenant foreign keys
ALTER TABLE cwids.payment_intent_aliases 
    ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES cwids.applications(id) ON DELETE RESTRICT;

ALTER TABLE cwids.delivery_attempts 
    ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES cwids.applications(id) ON DELETE RESTRICT;

-- Backfill application_id on existing rows
UPDATE cwids.payment_intent_aliases pia
SET application_id = pic.application_id
FROM cwids.payment_intent_correlations pic
WHERE pia.payment_intent_id = pic.id AND pia.application_id IS NULL;

UPDATE cwids.delivery_attempts da
SET application_id = ed.application_id
FROM cwids.event_deliveries ed
WHERE da.delivery_id = ed.id AND da.application_id IS NULL;

-- Create indexes on newly added foreign key columns
CREATE INDEX IF NOT EXISTS idx_payment_intent_aliases_app ON cwids.payment_intent_aliases(application_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_app ON cwids.delivery_attempts(application_id);

-- 2. Enable and Force RLS on all remaining tables
ALTER TABLE cwids.payment_intent_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.payment_intent_aliases FORCE ROW LEVEL SECURITY;

ALTER TABLE cwids.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.delivery_attempts FORCE ROW LEVEL SECURITY;

ALTER TABLE cwids.circuit_breaker_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.circuit_breaker_states FORCE ROW LEVEL SECURITY;

ALTER TABLE cwids.reconciliation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.reconciliation_records FORCE ROW LEVEL SECURITY;

ALTER TABLE cwids.administrative_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.administrative_audit_events FORCE ROW LEVEL SECURITY;

ALTER TABLE cwids.audit_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwids.audit_outbox FORCE ROW LEVEL SECURITY;

-- 3. Ingress Role Policies (cwids_ingress)
DROP POLICY IF EXISTS ingress_read_apps ON cwids.applications;
CREATE POLICY ingress_read_apps ON cwids.applications 
    FOR SELECT TO cwids_ingress USING (true);

DROP POLICY IF EXISTS ingress_read_intents ON cwids.payment_intent_correlations;
CREATE POLICY ingress_read_intents ON cwids.payment_intent_correlations 
    FOR SELECT TO cwids_ingress USING (true);

DROP POLICY IF EXISTS ingress_read_aliases ON cwids.payment_intent_aliases;
CREATE POLICY ingress_read_aliases ON cwids.payment_intent_aliases 
    FOR SELECT TO cwids_ingress USING (true);

DROP POLICY IF EXISTS ingress_read_endpoints ON cwids.destination_endpoints;
CREATE POLICY ingress_read_endpoints ON cwids.destination_endpoints 
    FOR SELECT TO cwids_ingress USING (true);

DROP POLICY IF EXISTS ingress_manage_events ON cwids.webhook_events;
CREATE POLICY ingress_manage_events ON cwids.webhook_events 
    FOR ALL TO cwids_ingress USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ingress_manage_deliveries ON cwids.event_deliveries;
CREATE POLICY ingress_manage_deliveries ON cwids.event_deliveries 
    FOR ALL TO cwids_ingress USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ingress_manage_outbox ON cwids.audit_outbox;
CREATE POLICY ingress_manage_outbox ON cwids.audit_outbox 
    FOR ALL TO cwids_ingress USING (true) WITH CHECK (true);

-- 4. Worker Role Policies (cwids_worker)
DROP POLICY IF EXISTS worker_read_events ON cwids.webhook_events;
CREATE POLICY worker_read_events ON cwids.webhook_events 
    FOR SELECT TO cwids_worker USING (true);

DROP POLICY IF EXISTS worker_read_endpoints ON cwids.destination_endpoints;
CREATE POLICY worker_read_endpoints ON cwids.destination_endpoints 
    FOR SELECT TO cwids_worker USING (true);

DROP POLICY IF EXISTS worker_manage_deliveries ON cwids.event_deliveries;
CREATE POLICY worker_manage_deliveries ON cwids.event_deliveries 
    FOR ALL TO cwids_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS worker_manage_attempts ON cwids.delivery_attempts;
CREATE POLICY worker_manage_attempts ON cwids.delivery_attempts 
    FOR ALL TO cwids_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS worker_manage_circuits ON cwids.circuit_breaker_states;
CREATE POLICY worker_manage_circuits ON cwids.circuit_breaker_states 
    FOR ALL TO cwids_worker USING (true) WITH CHECK (true);

-- 5. Admin Role Policies (cwids_admin)
DROP POLICY IF EXISTS admin_all_apps ON cwids.applications;
CREATE POLICY admin_all_apps ON cwids.applications FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_endpoints ON cwids.destination_endpoints;
CREATE POLICY admin_all_endpoints ON cwids.destination_endpoints FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_intents ON cwids.payment_intent_correlations;
CREATE POLICY admin_all_intents ON cwids.payment_intent_correlations FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_aliases ON cwids.payment_intent_aliases;
CREATE POLICY admin_all_aliases ON cwids.payment_intent_aliases FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_events ON cwids.webhook_events;
CREATE POLICY admin_all_events ON cwids.webhook_events FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_deliveries ON cwids.event_deliveries;
CREATE POLICY admin_all_deliveries ON cwids.event_deliveries FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_attempts ON cwids.delivery_attempts;
CREATE POLICY admin_all_attempts ON cwids.delivery_attempts FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_audits ON cwids.administrative_audit_events;
CREATE POLICY admin_all_audits ON cwids.administrative_audit_events FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_outbox ON cwids.audit_outbox;
CREATE POLICY admin_all_outbox ON cwids.audit_outbox FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_reconciliation ON cwids.reconciliation_records;
CREATE POLICY admin_all_reconciliation ON cwids.reconciliation_records FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS admin_all_circuits ON cwids.circuit_breaker_states;
CREATE POLICY admin_all_circuits ON cwids.circuit_breaker_states FOR ALL TO cwids_admin USING (true) WITH CHECK (true);

-- 6. Tenant Context Isolation Policies (app.current_tenant)
DROP POLICY IF EXISTS tenant_isolation_aliases ON cwids.payment_intent_aliases;
CREATE POLICY tenant_isolation_aliases ON cwids.payment_intent_aliases
    FOR ALL
    USING (application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_attempts ON cwids.delivery_attempts;
CREATE POLICY tenant_isolation_attempts ON cwids.delivery_attempts
    FOR ALL
    USING (application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_audits ON cwids.administrative_audit_events;
CREATE POLICY tenant_isolation_audits ON cwids.administrative_audit_events
    FOR ALL
    USING (
        application_id IS NULL OR 
        application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    );

DROP POLICY IF EXISTS tenant_isolation_reconciliation ON cwids.reconciliation_records;
CREATE POLICY tenant_isolation_reconciliation ON cwids.reconciliation_records
    FOR ALL
    USING (
        payment_intent_id IN (
            SELECT id FROM cwids.payment_intent_correlations
            WHERE application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
        )
    );

DROP POLICY IF EXISTS tenant_isolation_circuits ON cwids.circuit_breaker_states;
CREATE POLICY tenant_isolation_circuits ON cwids.circuit_breaker_states
    FOR ALL
    USING (
        destination_endpoint_id IN (
            SELECT id FROM cwids.destination_endpoints
            WHERE application_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
        )
    );

-- 7. Ensure role table permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON cwids.payment_intent_aliases TO cwids_ingress, cwids_admin;
GRANT SELECT, INSERT, UPDATE ON cwids.delivery_attempts TO cwids_worker, cwids_admin;
GRANT SELECT, INSERT, UPDATE ON cwids.circuit_breaker_states TO cwids_worker, cwids_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON cwids.administrative_audit_events, cwids.audit_outbox, cwids.reconciliation_records TO cwids_admin;
