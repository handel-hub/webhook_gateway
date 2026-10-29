import pg from 'pg';
import crypto from 'node:crypto';

const { Pool, Client } = pg;

/**
 * Returns the active database URL for testing.
 * @returns {string}
 */
export function getDbUrl() {
  return (
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://postgres:amajonlaw@localhost:5432/cwids_db'
  );
}

/** @type {pg.Pool | null} */
let sharedPool = null;

/**
 * Returns a shared test pool.
 * @returns {pg.Pool}
 */
export function getTestPool() {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: getDbUrl(),
      max: 20,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return sharedPool;
}

/**
 * Closes the shared pool if open.
 * @returns {Promise<void>}
 */
export async function closeTestPool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

/**
 * Returns a new Client connected directly to PostgreSQL.
 * @param {'cwids_ingress' | 'cwids_worker' | 'cwids_admin' | null} [role=null]
 * @returns {Promise<pg.Client>}
 */
export async function getTestClient(role = null) {
  const client = new Client({ connectionString: getDbUrl() });
  await client.connect();
  await client.query('SET search_path TO cwids, public;');
  if (role) {
    await client.query(`SET ROLE ${role};`);
  }
  return client;
}

/**
 * Creates an isolated test application.
 * @param {pg.Pool | pg.Client | pg.PoolClient} client
 * @param {Partial<{ id: string, code: string, name: string, status: string }>} [overrides]
 * @returns {Promise<{ id: string, code: string, name: string, rawApiKey: string, apiKeyHash: string }>}
 */
export async function createTestApp(client, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const code = overrides.code ?? `app_${crypto.randomBytes(4).toString('hex')}`;
  const name = overrides.name ?? `Test App ${code}`;
  const status = overrides.status ?? 'active';
  const rawApiKey = `cwids_key_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

  await client.query(
    `INSERT INTO cwids.applications (id, code, name, status, api_key_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
    [id, code, name, status, apiKeyHash],
  );

  return { id, code, name, rawApiKey, apiKeyHash };
}

/**
 * Creates a destination endpoint for an application.
 * @param {pg.Pool | pg.Client | pg.PoolClient} client
 * @param {string} applicationId
 * @param {Partial<{ id: string, version: number, url: string, signingSecret: string, httpTimeoutMs: number, maxRetries: number, responseValidationMode: 'http_status' | 'envelope' }>} [overrides]
 * @returns {Promise<{ id: string, applicationId: string, version: number, url: string, signingSecret: string }>}
 */
export async function createTestEndpoint(client, applicationId, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const version = overrides.version ?? 1;
  const url = overrides.url ?? 'https://endpoint.example.com/webhook';
  const signingSecret = overrides.signingSecret ?? `sec_${crypto.randomBytes(16).toString('hex')}`;
  const httpTimeoutMs = overrides.httpTimeoutMs ?? 5000;
  const maxRetries = overrides.maxRetries ?? 15;
  const responseValidationMode = overrides.responseValidationMode ?? 'http_status';

  await client.query(
    `INSERT INTO cwids.destination_endpoints 
       (id, application_id, version, url, signing_secret, http_timeout_ms, max_retries, response_validation_mode, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
     ON CONFLICT (application_id, version) DO UPDATE SET url = EXCLUDED.url`,
    [id, applicationId, version, url, signingSecret, httpTimeoutMs, maxRetries, responseValidationMode],
  );

  return { id, applicationId, version, url, signingSecret };
}

/**
 * Creates a provider connection.
 * @param {pg.Pool | pg.Client | pg.PoolClient} client
 * @param {Partial<{ id: string, provider: 'flutterwave' | 'paystack', environment: 'live' | 'test', applicationId: string | null, credentialReference: string }>} [overrides]
 * @returns {Promise<any>}
 */
export async function createTestProviderConnection(client, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const provider = overrides.provider ?? 'flutterwave';
  const environment = overrides.environment ?? 'live';
  const applicationId = overrides.applicationId ?? null;
  const credentialReference = overrides.credentialReference ?? `ref_${provider}_${environment}`;

  await client.query(
    `INSERT INTO cwids.provider_connections (id, provider, environment, name, application_id, credential_reference, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [id, provider, environment, `Test Connection ${id}`, applicationId, credentialReference],
  );

  return {
    id,
    provider,
    environment,
    name: `Test Connection ${id}`,
    applicationId,
    application_id: applicationId,
    secret_kms_ref: credentialReference,
    credential_reference: credentialReference,
    status: 'active',
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/**
 * Cleans up all records associated with the given tenant applications.
 * @param {pg.Pool | pg.Client | pg.PoolClient} client
 * @param {string[]} applicationIds
 * @returns {Promise<void>}
 */
export async function cleanupTestTenants(client, applicationIds) {
  if (!applicationIds || applicationIds.length === 0) return;

  // Cleanup in reverse foreign-key order
  await client.query(
    `DELETE FROM cwids.delivery_attempts WHERE delivery_id IN (
       SELECT id FROM cwids.event_deliveries WHERE application_id = ANY($1)
     )`,
    [applicationIds],
  );

  await client.query('DELETE FROM cwids.event_deliveries WHERE application_id = ANY($1)', [applicationIds]);

  await client.query(
    `DELETE FROM cwids.payment_intent_aliases WHERE payment_intent_id IN (
       SELECT id FROM cwids.payment_intent_correlations WHERE application_id = ANY($1)
     )`,
    [applicationIds],
  );

  await client.query('DELETE FROM cwids.webhook_events WHERE application_id = ANY($1)', [applicationIds]);
  await client.query('DELETE FROM cwids.payment_intent_correlations WHERE application_id = ANY($1)', [applicationIds]);
  await client.query('DELETE FROM cwids.circuit_breaker_states WHERE destination_endpoint_id IN (SELECT id FROM cwids.destination_endpoints WHERE application_id = ANY($1))', [applicationIds]);
  await client.query('DELETE FROM cwids.destination_endpoints WHERE application_id = ANY($1)', [applicationIds]);
  await client.query('DELETE FROM cwids.provider_connections WHERE application_id = ANY($1)', [applicationIds]);
  await client.query('DELETE FROM cwids.administrative_audit_events WHERE application_id = ANY($1)', [applicationIds]);
  await client.query('DELETE FROM cwids.applications WHERE id = ANY($1)', [applicationIds]);
}
