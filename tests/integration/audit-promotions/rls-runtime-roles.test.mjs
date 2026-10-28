import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('RLS Runtime Roles: Ingress and Worker roles can operate without leaking cross-tenant data', async (t) => {
  if (!dbUrl) {
    t.skip('No TEST_DATABASE_URL or DATABASE_URL provided. Skipping.');
    return;
  }

  const superClient = new Client({ connectionString: dbUrl });
  try {
    await superClient.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    t.skip(`Cannot connect to PostgreSQL at ${dbUrl}: ${msg}`);
    return;
  }

  try {
    await superClient.query('SET search_path TO cwids, public;');

    // Verify runtime roles exist and do not have BYPASSRLS
    const rolesRes = await superClient.query(
      `SELECT rolname, rolsuper, rolbypassrls 
       FROM pg_roles 
       WHERE rolname IN ('cwids_ingress', 'cwids_worker', 'cwids_admin')`,
    );
    assert.equal(rolesRes.rows.length, 3, 'All 3 runtime roles must exist.');
    for (const r of rolesRes.rows) {
      assert.equal(r.rolsuper, false, `Role ${r.rolname} MUST NOT be superuser.`);
      assert.equal(r.rolbypassrls, false, `Role ${r.rolname} MUST NOT have BYPASSRLS.`);
    }

    // Check table RLS status
    const rlsRes = await superClient.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity 
       FROM pg_class 
       WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'cwids')
         AND relkind = 'r'
         AND relname IN ('applications', 'payment_intent_correlations', 'payment_intent_aliases', 'event_deliveries', 'delivery_attempts')`,
    );
    const rlsMap = new Map(rlsRes.rows.map((r) => [r.relname, r.relrowsecurity]));

    // Assert every tenant-scoped table has RLS enabled
    assert.ok(rlsMap.get('applications'), 'applications must have RLS enabled.');
    assert.ok(rlsMap.get('payment_intent_correlations'), 'payment_intent_correlations must have RLS enabled.');
    assert.ok(rlsMap.get('payment_intent_aliases'), 'payment_intent_aliases must have RLS enabled.');
    assert.ok(rlsMap.get('event_deliveries'), 'event_deliveries must have RLS enabled.');
    assert.ok(rlsMap.get('delivery_attempts'), 'delivery_attempts must have RLS enabled.');
  } finally {
    await superClient.end();
  }
});
