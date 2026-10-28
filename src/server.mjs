import http from 'node:http';
import { getEnv } from './config/env.mjs';
import { createHttpServer } from './ingress/http-server.mjs';
import { startMetricsServer } from './observability/metrics.mjs';
import { closeAllPools } from './db/pool.mjs';
import { logger } from './observability/logger.mjs';

/**
 * Boots the HTTP Webhook Ingress Gateway.
 * @returns {Promise<{ server: http.Server, close: () => Promise<void> }>}
 */
export async function startServer() {
  const env = getEnv();
  const app = createHttpServer();
  const server = http.createServer(app);

  // 1. Start Prometheus metrics server
  const metricsHandle = await startMetricsServer(env.METRICS_PORT);

  // 2. Start Ingress Gateway
  await new Promise((resolve, reject) => {
    server.listen(env.PORT, () => {
      logger.info('CWIDS Ingress Gateway listening', {
        port: env.PORT,
        metricsPort: env.METRICS_PORT,
        nodeEnv: env.NODE_ENV,
      });
      resolve(null);
    });
    server.once('error', reject);
  });

  let isStopping = false;

  async function close() {
    if (isStopping) return;
    isStopping = true;
    logger.info('Commencing graceful shutdown of CWIDS Ingress Gateway (10s deadline)...');

    // Close HTTP ingress server
    await new Promise((resolve) => {
      server.close(() => {
        logger.info('Ingress HTTP server closed.');
        resolve(null);
      });
    });

    // Close metrics server
    await metricsHandle.close();

    // Close DB pools
    await closeAllPools();
    logger.info('CWIDS Ingress Gateway stopped cleanly.');
  }

  // Register signal listeners for standalone execution
  const sigHandler = () => {
    close()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('Error during gateway shutdown', err);
        process.exit(1);
      });
  };

  process.once('SIGTERM', sigHandler);
  process.once('SIGINT', sigHandler);

  return { server, close };
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith('server.mjs') || process.argv[1].endsWith('server.js'))) {
  startServer().catch((err) => {
    logger.error('Failed to start Ingress Gateway', err);
    process.exit(1);
  });
}
