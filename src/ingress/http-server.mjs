import express from 'express';
import { rawBodyMiddleware } from './raw-body-middleware.mjs';
import { handleWebhookIngress } from './webhook-handler.mjs';
import { createInternalApiRouter } from '../admin/internal-api.mjs';
import { getIngressPool } from '../db/pool.mjs';
import { logger } from '../observability/logger.mjs';

/**
 * Creates and configures the Express HTTP server for Inbound Webhooks.
 * @returns {import('express').Express}
 */
export function createHttpServer() {
  const app = express();

  // Disable x-powered-by header
  app.disable('x-powered-by');

  // Liveness probe
  app.get('/live', (req, res) => {
    res.status(200).json({ status: 'live', uptime: process.uptime() });
  });

  // Readiness probe
  app.get('/ready', async (req, res) => {
    try {
      const pool = getIngressPool();
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready', database: 'connected' });
    } catch (err) {
      logger.error('Readiness probe failed', err instanceof Error ? err : new Error(String(err)));
      res.status(503).json({ status: 'unready', database: 'disconnected' });
    }
  });

  // Mount internal application API
  app.use('/v1/internal', createInternalApiRouter({ pool: getIngressPool() }));

  // Mount raw body preserving middleware exclusively on webhook routes
  app.use('/v1/webhooks', rawBodyMiddleware);

  // Inbound Webhook endpoint
  app.post('/v1/webhooks/:provider/:connectionId', handleWebhookIngress);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Route ${req.method} ${req.path} does not exist.` });
  });

  // Global error handler
  // @ts-ignore
  app.use((err, req, res, next) => {
    logger.error('Unhandled Express error', err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred.' });
  });

  return app;
}
