import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/domain.mjs').ApplicationRecord} ApplicationRecord
 */

export const ApplicationsRepo = {
  /**
   * Retrieves an application by its primary UUID.
   * @param {pg.PoolClient} client
   * @param {string} id
   * @returns {Promise<ApplicationRecord | null>}
   */
  async findById(client, id) {
    const res = await client.query(
      'SELECT id, code, name, status, api_key_hash, created_at, updated_at FROM cwids.applications WHERE id = $1',
      [id],
    );
    /** @type {ApplicationRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Retrieves an application matching the SHA-256 hash of its API key.
   * @param {pg.PoolClient} client
   * @param {string} apiKeyHash
   * @returns {Promise<ApplicationRecord | null>}
   */
  async findByApiKeyHash(client, apiKeyHash) {
    const res = await client.query(
      'SELECT id, code, name, status, api_key_hash, created_at, updated_at FROM cwids.applications WHERE api_key_hash = $1 AND status = $2',
      [apiKeyHash, 'active'],
    );
    /** @type {ApplicationRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Inserts a new tenant application record.
   * @param {pg.PoolClient} client
   * @param {{ id?: string, code: string, name: string, apiKeyHash: string }} data
   * @returns {Promise<ApplicationRecord>}
   */
  async create(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.applications (id, code, name, api_key_hash, status)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, 'active')
       RETURNING id, code, name, status, api_key_hash, created_at, updated_at`,
      [data.id ?? null, data.code, data.name, data.apiKeyHash],
    );
    /** @type {ApplicationRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to create application record.');
    }
    return row;
  },
};
