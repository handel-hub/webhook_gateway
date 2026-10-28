import pg from 'pg';
import { DatabaseOperationError } from '../../errors/base-error.mjs';

/**
 * @typedef {import('../../types/domain.mjs').ProviderConnectionRecord} ProviderConnectionRecord
 */

export const ConnectionsRepo = {
  /**
   * Retrieves a provider connection by its primary UUID.
   * @param {pg.PoolClient} client
   * @param {string} id
   * @returns {Promise<ProviderConnectionRecord | null>}
   */
  async findById(client, id) {
    const res = await client.query(
      `SELECT id, provider, environment, name, application_id, credential_reference as secret_kms_ref,
              (status = 'active') as is_active, created_at, updated_at
       FROM cwids.provider_connections
       WHERE id = $1`,
      [id],
    );
    /** @type {ProviderConnectionRecord[]} */
    const rows = res.rows;
    return rows[0] ?? null;
  },

  /**
   * Finds all active connections for a given provider and environment.
   * @param {pg.PoolClient} client
   * @param {string} provider
   * @param {string} environment
   * @returns {Promise<ProviderConnectionRecord[]>}
   */
  async findActiveByProvider(client, provider, environment) {
    const res = await client.query(
      `SELECT id, provider, environment, name, application_id, credential_reference as secret_kms_ref,
              (status = 'active') as is_active, created_at, updated_at
       FROM cwids.provider_connections
       WHERE provider = $1 AND environment = $2 AND status = 'active'`,
      [provider, environment],
    );
    /** @type {ProviderConnectionRecord[]} */
    return res.rows;
  },

  /**
   * Creates a provider connection record.
   * @param {pg.PoolClient} client
   * @param {{
   *   id?: string,
   *   provider: string,
   *   environment: string,
   *   name: string,
   *   applicationId?: string | null,
   *   credentialReference: string
   * }} data
   * @returns {Promise<ProviderConnectionRecord>}
   */
  async create(client, data) {
    const res = await client.query(
      `INSERT INTO cwids.provider_connections (id, provider, environment, name, application_id, credential_reference, status)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'active')
       RETURNING id, provider, environment, name, application_id, credential_reference as secret_kms_ref,
                 (status = 'active') as is_active, created_at, updated_at`,
      [
        data.id ?? null,
        data.provider,
        data.environment,
        data.name,
        data.applicationId ?? null,
        data.credentialReference,
      ],
    );
    /** @type {ProviderConnectionRecord[]} */
    const rows = res.rows;
    const row = rows[0];
    if (!row) {
      throw new DatabaseOperationError('Failed to create provider connection.');
    }
    return row;
  },
};
