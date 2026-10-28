import express from 'express';
import pg from 'pg';

/**
 * Creates Health and Liveness router for orchestration probes (Kubernetes, AWS ALB, PM2).
 *
 * @param {object} deps
 * @param {pg.Pool} deps.pool
 * @returns {express.Router}
 */
export function createHealthRouter({ pool }) {
  const router = express.Router();

  /**
   * GET /live
   * Liveness probe: verifies process is alive and event loop is responsive.
   */
  router.get('/live', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /ready
   * Readiness probe: checks PostgreSQL connection pool responsiveness with timeout.
   */
  router.get('/ready', async (_req, res) => {
    const timeoutMs = 2000;
    let client;
    try {
      // Connect and query with bounded timeout
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection pool checkout timeout')), timeoutMs),
        ),
      ]);

      await Promise.race([
        // @ts-ignore
        client.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Health probe query timeout')), timeoutMs),
        ),
      ]);

      res.status(200).json({
        status: 'ready',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        status: 'unready',
        database: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (client) {
        // @ts-ignore
        client.release();
      }
    }
  });

  return router;
}
