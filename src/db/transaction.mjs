import pg from 'pg';
import { DatabaseOperationError } from '../errors/base-error.mjs';

/**
 * Executes a callback within a managed PostgreSQL transaction.
 * If tenantId is provided, automatically injects transaction-local `app.current_tenant`
 * to enforce database engine Row-Level Security.
 *
 * @template T
 * @param {pg.Pool} pool - Connection pool to acquire a client from.
 * @param {string | null} tenantId - Application tenant UUID (or null if unscoped/admin).
 * @param {(client: pg.PoolClient) => Promise<T>} callback - Work to execute within transaction.
 * @returns {Promise<T>} Result of the transaction callback.
 */
export async function withTransaction(pool, tenantId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (tenantId) {
      // Injects session variable for current transaction only (is_local = true)
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Preserve primary error
    }
    if (err instanceof DatabaseOperationError) {
      throw err;
    }
    throw new DatabaseOperationError(
      `Transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      { tenantId },
      err instanceof Error ? err : undefined,
    );
  } finally {
    client.release();
  }
}

/**
 * Executes a read query with optional tenant RLS scope applied.
 * @template T
 * @param {pg.Pool} pool
 * @param {string | null} tenantId
 * @param {(client: pg.PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withClient(pool, tenantId, callback) {
  const client = await pool.connect();
  try {
    if (tenantId) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }
    return await callback(client);
  } finally {
    client.release();
  }
}
