import dotenv from 'dotenv';

// Load environment variables from .env file if present
dotenv.config();

/**
 * @typedef {object} AppEnv
 * @property {'development' | 'test' | 'staging' | 'production'} NODE_ENV
 * @property {number} PORT
 * @property {number} ADMIN_PORT
 * @property {number} METRICS_PORT
 * @property {string} DATABASE_URL
 * @property {string} CWIDS_KEK_BASE64
 * @property {Buffer} MASTER_KEK
 * @property {string} ADMIN_API_TOKEN
 * @property {number} DB_INGRESS_MAX_CONNECTIONS
 * @property {number} DB_WORKER_MAX_CONNECTIONS
 * @property {number} DB_IDLE_TIMEOUT_MS
 * @property {number} DB_CONNECTION_TIMEOUT_MS
 * @property {number} WORKER_CONCURRENCY
 * @property {number} MAX_TENANT_CONCURRENCY
 * @property {number} RETENTION_RAW_PAYLOAD_DAYS
 * @property {number} RETENTION_NORMALIZED_METADATA_DAYS
 * @property {number} RETENTION_AUDIT_SECURITY_DAYS
 * @property {number} RETENTION_AUDIT_OPERATIONAL_DAYS
 * @property {boolean} RECONCILIATION_ENABLED
 * @property {number} RECONCILIATION_INTERVAL_MIN
 * @property {number} RECONCILIATION_TIMEOUT_MS
 * @property {number} RECONCILIATION_CONCURRENCY
 * @property {string | null} FLUTTERWAVE_RECONCILIATION_SECRET_KEY
 * @property {string | null} PAYSTACK_RECONCILIATION_SECRET_KEY
 */

/**
 * Parses and strictly validates environment variables.
 * @param {Record<string, string | undefined>} [source=process.env]
 * @returns {AppEnv}
 */
export function loadEnv(source = process.env) {
  const errors = [];

  const rawNodeEnv = source.NODE_ENV ?? 'development';
  if (!['development', 'test', 'staging', 'production'].includes(rawNodeEnv)) {
    errors.push(`Invalid NODE_ENV: '${rawNodeEnv}'. Expected development, test, staging, or production.`);
  }
  const NODE_ENV = /** @type {'development' | 'test' | 'staging' | 'production'} */ (rawNodeEnv);

  /**
   * Helper to parse integer with bounds
   * @param {string} key
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function parseBoundedInt(key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const val = source[key];
    if (val === undefined || val.trim() === '') {
      return fallback;
    }
    const parsed = Number.parseInt(val, 10);
    if (Number.isNaN(parsed) || parsed < min || parsed > max) {
      errors.push(`Invalid ${key}: '${val}'. Expected integer between ${min} and ${max}.`);
      return fallback;
    }
    return parsed;
  }

  const PORT = parseBoundedInt('PORT', 3000, 1, 65535);
  const ADMIN_PORT = parseBoundedInt('ADMIN_PORT', 3001, 1, 65535);
  const METRICS_PORT = parseBoundedInt('METRICS_PORT', 9090, 1, 65535);

  const DATABASE_URL = source.DATABASE_URL?.trim() ?? '';
  if (!DATABASE_URL) {
    errors.push('DATABASE_URL is required and cannot be empty.');
  }

  const CWIDS_KEK_BASE64 = source.CWIDS_KEK_BASE64?.trim() ?? '';
  /** @type {Buffer} */
  let MASTER_KEK = Buffer.alloc(0);
  if (!CWIDS_KEK_BASE64) {
    errors.push('CWIDS_KEK_BASE64 is required for AES-256-GCM envelope encryption.');
  } else {
    try {
      MASTER_KEK = Buffer.from(CWIDS_KEK_BASE64, 'base64');
      if (MASTER_KEK.length !== 32) {
        errors.push(`CWIDS_KEK_BASE64 must decode to exactly 32 bytes (256 bits). Received ${MASTER_KEK.length} bytes.`);
      }
    } catch (e) {
      errors.push(`CWIDS_KEK_BASE64 is not valid base64: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ADMIN_API_TOKEN = source.ADMIN_API_TOKEN?.trim() ?? '';
  if (!ADMIN_API_TOKEN || ADMIN_API_TOKEN.length < 16) {
    errors.push('ADMIN_API_TOKEN is required and must be at least 16 characters.');
  }

  const DB_INGRESS_MAX_CONNECTIONS = parseBoundedInt('DB_INGRESS_MAX_CONNECTIONS', 20, 1, 100);
  const DB_WORKER_MAX_CONNECTIONS = parseBoundedInt('DB_WORKER_MAX_CONNECTIONS', 15, 1, 100);
  const DB_IDLE_TIMEOUT_MS = parseBoundedInt('DB_IDLE_TIMEOUT_MS', 10000, 1000, 300000);
  const DB_CONNECTION_TIMEOUT_MS = parseBoundedInt('DB_CONNECTION_TIMEOUT_MS', 5000, 500, 60000);

  const WORKER_CONCURRENCY = parseBoundedInt('WORKER_CONCURRENCY', 5, 1, 50);
  const MAX_TENANT_CONCURRENCY = parseBoundedInt('MAX_TENANT_CONCURRENCY', 10, 1, 100);

  const RETENTION_RAW_PAYLOAD_DAYS = parseBoundedInt('RETENTION_RAW_PAYLOAD_DAYS', 30, 1, 3650);
  const RETENTION_NORMALIZED_METADATA_DAYS = parseBoundedInt('RETENTION_NORMALIZED_METADATA_DAYS', 90, 1, 3650);
  const RETENTION_AUDIT_SECURITY_DAYS = parseBoundedInt('RETENTION_AUDIT_SECURITY_DAYS', 2555, 30, 7300);
  const RETENTION_AUDIT_OPERATIONAL_DAYS = parseBoundedInt('RETENTION_AUDIT_OPERATIONAL_DAYS', 365, 30, 3650);

  const rawReconciliation = source.RECONCILIATION_ENABLED?.trim().toLowerCase();
  const RECONCILIATION_ENABLED = rawReconciliation === 'true' || rawReconciliation === '1';

  const RECONCILIATION_INTERVAL_MIN = parseBoundedInt('RECONCILIATION_INTERVAL_MIN', 60, 5, 1440);
  const RECONCILIATION_TIMEOUT_MS = parseBoundedInt('RECONCILIATION_TIMEOUT_MS', 10000, 1000, 60000);
  const RECONCILIATION_CONCURRENCY = parseBoundedInt('RECONCILIATION_CONCURRENCY', 2, 1, 10);

  const FLUTTERWAVE_RECONCILIATION_SECRET_KEY = source.FLUTTERWAVE_RECONCILIATION_SECRET_KEY?.trim() || null;
  const PAYSTACK_RECONCILIATION_SECRET_KEY = source.PAYSTACK_RECONCILIATION_SECRET_KEY?.trim() || null;

  if (RECONCILIATION_ENABLED) {
    if (!FLUTTERWAVE_RECONCILIATION_SECRET_KEY && !PAYSTACK_RECONCILIATION_SECRET_KEY) {
      errors.push('RECONCILIATION_ENABLED is true, but neither FLUTTERWAVE_RECONCILIATION_SECRET_KEY nor PAYSTACK_RECONCILIATION_SECRET_KEY is configured.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    NODE_ENV,
    PORT,
    ADMIN_PORT,
    METRICS_PORT,
    DATABASE_URL,
    CWIDS_KEK_BASE64,
    MASTER_KEK,
    ADMIN_API_TOKEN,
    DB_INGRESS_MAX_CONNECTIONS,
    DB_WORKER_MAX_CONNECTIONS,
    DB_IDLE_TIMEOUT_MS,
    DB_CONNECTION_TIMEOUT_MS,
    WORKER_CONCURRENCY,
    MAX_TENANT_CONCURRENCY,
    RETENTION_RAW_PAYLOAD_DAYS,
    RETENTION_NORMALIZED_METADATA_DAYS,
    RETENTION_AUDIT_SECURITY_DAYS,
    RETENTION_AUDIT_OPERATIONAL_DAYS,
    RECONCILIATION_ENABLED,
    RECONCILIATION_INTERVAL_MIN,
    RECONCILIATION_TIMEOUT_MS,
    RECONCILIATION_CONCURRENCY,
    FLUTTERWAVE_RECONCILIATION_SECRET_KEY,
    PAYSTACK_RECONCILIATION_SECRET_KEY,
  };
}

/**
 * Default singleton instance loaded from process.env.
 * Note: When running in test environments, consumers can call loadEnv() with mock dictionaries.
 * @type {AppEnv | null}
 */
let cachedEnv = null;

/**
 * Accessor for validated configuration singleton.
 * @returns {AppEnv}
 */
export function getEnv() {
  if (!cachedEnv) {
    cachedEnv = loadEnv(process.env);
  }
  return cachedEnv;
}
