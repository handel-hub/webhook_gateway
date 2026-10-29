import { logger } from './observability/logger.mjs';
import { startServer } from './server.mjs';
import { startWorker } from './worker.mjs';

/**
 * Main application orchestrator for CWIDS.
 * Supports running as standalone Gateway, standalone Worker, or unified in development.
 */
async function main() {
  const args = process.argv.slice(2);
  const runGateway = args.includes('--gateway') || (!args.includes('--worker') && !args.includes('--exporter'));
  const runWorker = args.includes('--worker') || (!args.includes('--gateway') && !args.includes('--exporter'));

  logger.info('Starting CWIDS orchestrator...', { runGateway, runWorker });

  /** @type {Array<() => Promise<void>>} */
  const teardowns = [];

  if (runGateway) {
    const serverInstance = await startServer();
    teardowns.push(serverInstance.close);
  }

  if (runWorker) {
    const workerInstance = await startWorker();
    teardowns.push(workerInstance.stop);
  }

  // Graceful shutdown listener
  /**
   * @param {'SIGINT' | 'SIGTERM'} signal
   */
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Initiating graceful shutdown...`);
    for (const teardown of teardowns) {
      try {
        await teardown();
      } catch (err) {
        logger.error('Error during teardown', err instanceof Error ? err : new Error(String(err)));
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && (process.argv[1].endsWith('index.mjs') || process.argv[1].endsWith('index.js'))) {
  main().catch((err) => {
    logger.error('Fatal crash during CWIDS startup', err);
    process.exit(1);
  });
}

export { verifyCwidsWebhook } from './security/verify-cwids-webhook.mjs';
export { generateOutboundSignature, verifyOutboundSignature } from './security/hmac-signer.mjs';
