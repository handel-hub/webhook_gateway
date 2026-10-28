import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.mjs';

const { Client } = pg;
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('Database migrations apply idempotently', async (t) => {
  if (!dbUrl) {
    t.skip('No DATABASE_URL or TEST_DATABASE_URL provided. Skipping live DB migration test.');
    return;
  }

  // Probe connection
  const probe = new Client({ connectionString: dbUrl });
  try {
    await probe.connect();
    await probe.end();
  } catch (err) {
    t.skip(`Cannot connect to PostgreSQL at ${dbUrl}: ${err instanceof Error ? err.message : String(err)}. Skipping.`);
    return;
  }

  // Run migrations
  const firstRun = await runMigrations(dbUrl);
  assert.ok(Array.isArray(firstRun));

  // Second run must be clean and apply 0 migrations
  const secondRun = await runMigrations(dbUrl);
  assert.equal(secondRun.length, 0);
});
