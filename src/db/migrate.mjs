import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getEnv } from '../config/env.mjs';
import { logger } from '../observability/logger.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATION_LOCK_ID = 991283749;

/**
 * Runs all unapplied SQL migrations sequentially under a global PostgreSQL advisory lock.
 * @param {string} [connectionString] - Optional connection string override.
 * @returns {Promise<string[]>} Array of newly applied migration versions.
 */
export async function runMigrations(connectionString) {
  const connStr = connectionString ?? getEnv().DATABASE_URL;
  const client = new Client({ connectionString: connStr });

  await client.connect();
  logger.info('Connected to PostgreSQL for database migrations.');

  /** @type {string[]} */
  const applied = [];

  try {
    // 1. Acquire advisory lock to prevent concurrent migration execution
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    logger.info('Acquired PostgreSQL migration advisory lock.');

    // 2. Ensure schema and migration tracking table exist
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS cwids;
      CREATE TABLE IF NOT EXISTS cwids.schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Retrieve already applied migration versions
    const { rows } = await client.query('SELECT version FROM cwids.schema_migrations ORDER BY version ASC');
    const appliedVersions = new Set(rows.map((r) => r.version));

    // 4. Read migration directory
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    // 5. Execute unapplied migrations
    for (const file of sqlFiles) {
      if (appliedVersions.has(file)) {
        logger.debug(`Migration ${file} is already applied. Skipping.`);
        continue;
      }

      logger.info(`Applying migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO cwids.schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info(`Successfully applied migration: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Migration failed on file ${file}. Transaction rolled back.`, err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    }

    if (applied.length === 0) {
      logger.info('Database schema is already up to date. Zero migrations applied.');
    } else {
      logger.info(`Successfully applied ${applied.length} migrations.`, { applied });
    }

    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      logger.info('Released PostgreSQL migration advisory lock.');
    } catch (err) {
      logger.error('Failed to release migration advisory lock', err instanceof Error ? err : new Error(String(err)));
    }
    await client.end();
  }
}

// Auto-run if executed as script
if (process.argv[1] && (process.argv[1].endsWith('migrate.mjs') || process.argv[1].endsWith('migrate.js'))) {
  runMigrations()
    .then((applied) => {
      logger.info('Migration run completed cleanly.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Fatal error during migration run', err);
      process.exit(1);
    });
}
