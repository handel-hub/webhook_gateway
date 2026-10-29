import { getIngressPool } from '../db/pool.mjs';
import { ConnectionsRepo } from '../db/repositories/connections-repo.mjs';
import { getAdapter } from '../providers/adapter-registry.mjs';
import { IngestionService } from '../ingestion/ingestion-service.mjs';
import { withClient } from '../db/transaction.mjs';
import { logger } from '../observability/logger.mjs';

/**
 * Express controller handling inbound provider webhooks:
 * POST /v1/webhooks/:provider/:connectionId
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleWebhookIngress(req, res) {
  const providerParam = req.params.provider;
  const connectionIdParam = req.params.connectionId;

  if (!providerParam || !connectionIdParam) {
    res.status(400).json({ error: 'Bad Request', message: 'Missing provider or connectionId route parameter.' });
    return;
  }

  const provider = Array.isArray(providerParam) ? String(providerParam[0]) : String(providerParam);
  const connectionId = Array.isArray(connectionIdParam) ? String(connectionIdParam[0]) : String(connectionIdParam);

  // @ts-ignore - custom property populated by rawBodyMiddleware
  const rawBody = req.rawBody;
  // @ts-ignore - custom property populated by rawBodyMiddleware
  const payloadSha256 = req.payloadSha256;

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Missing or empty request body.' });
    return;
  }

  const pool = getIngressPool();

  try {
    // 1. Resolve provider connection record
    const connection = await withClient(pool, null, async (client) => {
      return ConnectionsRepo.findById(client, connectionId);
    });

    if (!connection || !connection.is_active) {
      logger.warn('Webhook received for unknown or inactive connection', { connectionId, provider });
      res.status(404).json({ error: 'Not Found', message: 'Provider connection not found or inactive.' });
      return;
    }

    if (connection.provider.toLowerCase() !== provider.toLowerCase()) {
      res.status(400).json({ error: 'Bad Request', message: 'Provider path mismatch with connection record.' });
      return;
    }

    // 2. Resolve adapter & verify cryptographic signature
    const adapter = getAdapter(connection.provider);
    const verification = await adapter.verifyAndNormalize(
      rawBody,
      req.headers,
      connection.secret_kms_ref,
    );

    if (!verification.isValid) {
      logger.warn('Rejected webhook with invalid cryptographic signature', {
        provider,
        connectionId,
        reason: verification.failureReason,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: verification.failureReason || 'Cryptographic signature verification failed.',
      });
      return;
    }

    // 3. Execute 14-step atomic Tx-Ingest
    const outcome = await IngestionService.ingestWebhook(pool, {
      providerConnection: connection,
      rawBody,
      payloadSha256,
      verification,
    });

    // 4. Return HTTP 200 acknowledgement only after commit
    res.status(200).json({
      status: 'acknowledged',
      event_id: outcome.eventId,
      duplicate: outcome.isDuplicate,
      routing_status: outcome.routingStatus,
      delivery_id: outcome.deliveryId,
    });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : '';
    const errorCode = (err && typeof err === 'object' && 'code' in err) ? /** @type {any} */ (err).code : '';
    const errorMessage = err instanceof Error ? err.message : String(err);

    // B1: Infrastructure capacity errors -> HTTP 503 with Retry-After: 30
    const isPoolOrConnError =
      errorName === 'PoolAcquisitionTimeoutError' ||
      errorCode === 'ECONNREFUSED' ||
      errorCode === '57P01' ||
      errorCode === '53300' ||
      errorMessage.includes('timeout exceeded when connecting to database') ||
      errorMessage.includes('Connection terminated unexpectedly');

    if (isPoolOrConnError) {
      logger.error('Database infrastructure backpressure during webhook ingestion', err instanceof Error ? err : new Error(String(err)));
      res.setHeader('Retry-After', '30');
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Database connection capacity exhausted or temporarily unavailable. Please retry.',
      });
      return;
    }

    logger.error('Unexpected error during webhook ingestion', err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An error occurred while processing the webhook.',
    });
  }
}
