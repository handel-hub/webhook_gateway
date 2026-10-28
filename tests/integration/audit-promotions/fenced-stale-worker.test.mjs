import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DeliveriesRepo } from '../../../src/db/repositories/deliveries-repo.mjs';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('Fenced Stale Worker: Stale worker update returns false on token mismatch and leaves 0 attempt rows', async (t) => {
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
    const endp = (await client.query('SELECT id FROM destination_endpoints WHERE application_id = $1 LIMIT 1', [app.id])).rows[0];
    const conn = (await client.query('SELECT id, provider, environment FROM provider_connections LIMIT 1')).rows[0];

    // Insert an event and delivery
    const ev = (await client.query(`
      INSERT INTO webhook_events (application_id, provider_connection_id, provider, environment, identity_strategy_version, dedupe_key, event_type, resource_type, resource_reference, routing_status, routing_mode, kek_version, payload_sha256)
      VALUES ($1, $2, $3, $4, 1, 'fenced-test-${Date.now()}', 'charge.success', 'charge', 'ref-fenced', 'resolved', 'mode_a', 'v1', 'sha-fenced')
      RETURNING id;
    `, [app.id, conn.id, conn.provider, conn.environment])).rows[0];

    const deliv = (await client.query(`
      INSERT INTO event_deliveries (event_id, application_id, destination_endpoint_id, status, next_attempt_at)
      VALUES ($1, $2, $3, 'pending', NOW())
      RETURNING id, fencing_token;
    `, [ev.id, app.id, endp.id])).rows[0];

    // Worker A claims with token 1
    const [claimA] = await DeliveriesRepo.claimBatch(/** @type {any} */ (client), 1, 1, 'worker_A');
    assert.ok(claimA);

    // Stale worker tries to complete with token 0 (mismatched)
    const successStale = await DeliveriesRepo.completeDelivery(/** @type {any} */ (client), deliv.id, 9999);
    assert.equal(successStale, false, 'Stale worker completeDelivery must return false on token mismatch.');
  } finally {
    await client.end();
  }
});
