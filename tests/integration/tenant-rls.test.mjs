import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('PostgreSQL Row-Level Security prevents cross-tenant data leakage', async (t) => {
  if (!dbUrl) {
    t.skip('No DATABASE_URL or TEST_DATABASE_URL provided. Skipping live DB RLS test.');
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (err) {
    t.skip(`Cannot connect to PostgreSQL at ${dbUrl}. Skipping.`);
    return;
  }

  try {
    // Generate two distinct tenant UUIDs
    const tenantAId = 'a1111111-1111-4111-8111-111111111111';
    const tenantBId = 'b2222222-2222-4222-8222-222222222222';

    await client.query('BEGIN');

    // Insert Tenant A and Tenant B applications as superuser/migrator
    await client.query(
      `INSERT INTO cwids.applications (id, code, name, status, api_key_hash)
       VALUES ($1, 'TENANT_A', 'Tenant Alpha', 'active', 'hash_a'),
              ($2, 'TENANT_B', 'Tenant Beta', 'active', 'hash_b')
       ON CONFLICT (id) DO NOTHING`,
      [tenantAId, tenantBId],
    );

    // Switch context to Tenant A and execute as runtime role subject to RLS
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantAId]);
    await client.query('SET ROLE cwids_worker;');

    // Query applications without WHERE clause
    const resA = await client.query('SELECT id, code FROM cwids.applications');
    const idsVisibleToA = resA.rows.map((r) => r.id);

    // Verify Tenant A can only see Tenant A
    assert.ok(idsVisibleToA.includes(tenantAId), 'Tenant A must see its own row.');
    assert.ok(!idsVisibleToA.includes(tenantBId), 'Tenant A MUST NOT see Tenant B rows under RLS.');

    // Switch context to Tenant B
    await client.query('RESET ROLE;');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantBId]);
    await client.query('SET ROLE cwids_worker;');
    const resB = await client.query('SELECT id, code FROM cwids.applications');
    const idsVisibleToB = resB.rows.map((r) => r.id);

    assert.ok(idsVisibleToB.includes(tenantBId), 'Tenant B must see its own row.');
    assert.ok(!idsVisibleToB.includes(tenantAId), 'Tenant B MUST NOT see Tenant A rows under RLS.');

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
});
