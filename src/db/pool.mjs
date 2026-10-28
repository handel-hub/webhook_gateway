import pg from 'pg';
import { getEnv } from '../config/env.mjs';
import { logger } from '../observability/logger.mjs';

const { Pool } = pg;

/** @type {pg.Pool | null} */
let ingressPool = null;

/** @type {pg.Pool | null} */
let workerPool = null;

/** @type {pg.Pool | null} */
let adminPool = null;

/**
 * Returns the dedicated connection pool for Inbound Webhook Ingress.
 * Strict physical separation prevents worker deliveries from exhausting ingress slots.
 * @returns {pg.Pool}
 */
export function getIngressPool() {
  if (!ingressPool) {
    const env = getEnv();
    ingressPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_INGRESS_MAX_CONNECTIONS,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
      application_name: 'cwids_ingress',
    });

    ingressPool.on('error', (err) => {
      logger.error('Unexpected idle client error in Ingress Pool', err);
    });
  }
  return ingressPool;
}

/**
 * Returns the dedicated connection pool for Background Delivery Workers.
 * @returns {pg.Pool}
 */
export function getWorkerPool() {
  if (!workerPool) {
    const env = getEnv();
    workerPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_WORKER_MAX_CONNECTIONS,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
      application_name: 'cwids_worker',
    });

    workerPool.on('error', (err) => {
      logger.error('Unexpected idle client error in Worker Pool', err);
    });
  }
  return workerPool;
}

/**
 * Returns the connection pool for internal administrative APIs and maintenance workers.
 * @returns {pg.Pool}
 */
export function getAdminPool() {
  if (!adminPool) {
    const env = getEnv();
    adminPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
      application_name: 'cwids_admin',
    });

    adminPool.on('error', (err) => {
      logger.error('Unexpected idle client error in Admin Pool', err);
    });
  }
  return adminPool;
}

/**
 * Gracefully terminates all active connection pools.
 * @returns {Promise<void>}
 */
export async function closeAllPools() {
  const pools = [ingressPool, workerPool, adminPool].filter((p) => p !== null);
  for (const pool of pools) {
    try {
      await pool.end();
    } catch (err) {
      logger.error('Error closing connection pool', err instanceof Error ? err : new Error(String(err)));
    }
  }
  ingressPool = null;
  workerPool = null;
  adminPool = null;
}
