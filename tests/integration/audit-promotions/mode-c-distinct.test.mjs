import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { resolveRouting } from '../../../src/routing/routing-resolver.mjs';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('Mode C Distinct: Multiple aliases for the same intent resolve to 1 match without quarantining', async (t) => {
  if (!dbUrl) {
    t.skip('No TEST_DATABASE_URL or DATABASE_URL provided. Skipping.');
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    t.skip(`Cannot connect to PostgreSQL at ${dbUrl}: ${msg}`);
    return;
  }

  try {
    await client.query('SET search_path TO cwids, public;');

    const app = (await client.query('SELECT id FROM applications LIMIT 1')).rows[0];
    const conn = (await client.query("SELECT * FROM provider_connections WHERE provider = 'paystack' LIMIT 1")).rows[0];

    // Create an intent
    const intent = (await client.query(`
      INSERT INTO payment_intent_correlations (
        application_id, provider_connection_id, environment, merchant_reference,
        expected_amount_minor, currency, idempotency_key, expires_at, status
      ) VALUES (
        $1, $2, $3, 'REF-DISTINCT-${Date.now()}',
        5000, 'NGN', 'idem-distinct-${Date.now()}', NOW() + INTERVAL '1 hour', 'active'
      ) RETURNING id;
    `, [app.id, conn.id, conn.environment])).rows[0];

    const provRef = 'TX-PROV-' + Date.now();
    const vaRef = 'VA-ACC-' + Date.now();

    // Add BOTH aliases for the SAME intent
    await client.query(`
      INSERT INTO payment_intent_aliases (payment_intent_id, provider_connection_id, environment, alias_type, alias_value)
      VALUES
        ($1, $2, $3, 'provider_reference', $4),
        ($1, $2, $3, 'virtual_account_id', $5);
    `, [intent.id, conn.id, conn.environment, provRef, vaRef]);

    // Provider webhook includes BOTH keys matching the same intent
    const routing = await resolveRouting(/** @type {any} */ (client), {
      providerConnection: conn,
      routingKeys: {
        merchantReference: null,
        providerReference: provRef,
        virtualAccountId: vaRef,
      },
    });

    assert.equal(routing.status, 'resolved', 'Routing must resolve to single matching intent.');
    assert.equal(routing.applicationId, app.id, 'Resolved application must match intent owner.');
  } finally {
    await client.end();
  }
});
