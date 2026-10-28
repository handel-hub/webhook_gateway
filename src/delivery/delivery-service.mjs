import pg from 'pg';
import { CircuitBreaker } from './circuit-breaker.mjs';
import { EventsRepo } from '../db/repositories/events-repo.mjs';
import { DeliveriesRepo } from '../db/repositories/deliveries-repo.mjs';
import { LeaseManager } from './lease-manager.mjs';
import { AttemptsRepo } from '../db/repositories/attempts-repo.mjs';
import { decryptPayloadEnvelope } from '../security/crypto-envelope.mjs';
import { dispatchWebhook } from './http-dispatcher.mjs';
import { evaluateRetry } from './retry-policy.mjs';
import { withClient, withTransaction } from '../db/transaction.mjs';
import { createLogger } from '../observability/logger.mjs';

const logger = createLogger({ service: 'delivery-service' });

/**
 * @typedef {import('../types/delivery.mjs').DeliveryClaim} DeliveryClaim
 * @typedef {import('../config/env.mjs').AppEnv} AppEnv
 */

/**
 * Delivery Execution Orchestration Service.
 * Coordinates circuit breaking, envelope decryption, HTTP dispatch, attempt auditing, and retry transitions.
 */
export const DeliveryService = {
  /**
   * Processes a single claimed delivery obligation.
   *
   * @param {pg.Pool} pool
   * @param {AppEnv} env
   * @param {DeliveryClaim} claim
   * @param {string} workerIdentity
   * @returns {Promise<{ status: 'delivered' | 'retry_scheduled' | 'dead_lettered' | 'circuit_open_deferred' }>}
   */
  async processDeliveryClaim(pool, env, claim, workerIdentity) {
    const startedAt = new Date();

    // 1. Check Circuit Breaker for target destination endpoint
    const circuit = await withClient(pool, null, async (client) => {
      return CircuitBreaker.canDispatch(client, claim.destinationEndpointId);
    });

    if (!circuit.allowed) {
      logger.warn('Deferred delivery due to open circuit breaker', {
        deliveryId: claim.deliveryId,
        endpointId: claim.destinationEndpointId,
        cooldownRemainingMs: circuit.cooldownRemainingMs,
      });
      return { status: 'circuit_open_deferred' };
    }

    // 2. Fetch event record and decrypt payload envelope
    const { event, endpoint } = await withClient(pool, claim.applicationId, async (client) => {
      const ev = await EventsRepo.findById(client, claim.eventId);
      const epRes = await client.query(
        'SELECT id, url, signing_secret, http_timeout_ms, max_retries FROM cwids.destination_endpoints WHERE id = $1',
        [claim.destinationEndpointId],
      );
      return { event: ev, endpoint: epRes.rows[0] };
    });

    if (!event || !endpoint) {
      logger.error('Failed to resolve event or endpoint for delivery', undefined, {
        deliveryId: claim.deliveryId,
        eventId: claim.eventId,
        endpointId: claim.destinationEndpointId,
      });
      return { status: 'dead_lettered' };
    }

    // Decrypt payload
    let decryptedPayload;
    try {
      if (event.encrypted_payload && event.payload_nonce && event.payload_tag && event.wrapped_dek) {
        decryptedPayload = decryptPayloadEnvelope(
          event.encrypted_payload,
          event.payload_nonce,
          event.payload_tag,
          event.wrapped_dek,
          event.id,
          env.MASTER_KEK,
        );
      } else {
        // Payload was already pruned by retention worker; reconstruct fallback stub
        decryptedPayload = Buffer.from(
          JSON.stringify({
            event_id: event.id,
            event_type: event.event_type,
            notice: 'Payload pruned by data retention policy',
          }),
          'utf8',
        );
      }
    } catch (err) {
      logger.error('Failed to decrypt event envelope for delivery', err instanceof Error ? err : new Error(String(err)), {
        deliveryId: claim.deliveryId,
      });
      return { status: 'dead_lettered' };
    }

    // 3. Dispatch outbound HTTP request
    const dispatchResult = await dispatchWebhook({
      deliveryId: claim.deliveryId,
      targetUrl: endpoint.url,
      payload: decryptedPayload,
      signingSecret: endpoint.signing_secret,
      timeoutMs: endpoint.http_timeout_ms,
    });

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const isSuccess = dispatchResult.httpStatus >= 200 && dispatchResult.httpStatus < 300;

    // 4. Update Database inside transaction enforcing fencing token match FIRST before auditing attempt
    return withTransaction(pool, claim.applicationId, async (client) => {
      if (isSuccess) {
        // Enforce monotonic fencing token match FIRST
        await LeaseManager.completeFenced(client, claim.deliveryId, claim.fencingToken);
        await CircuitBreaker.recordSuccess(client, claim.destinationEndpointId);

        // Record attempt only after successful fenced write
        await AttemptsRepo.recordAttempt(client, {
          deliveryId: claim.deliveryId,
          attemptNumber: claim.attemptCount + 1,
          fencingToken: claim.fencingToken,
          startedAt,
          finishedAt,
          durationMs,
          httpStatus: dispatchResult.httpStatus,
          responseStatus: dispatchResult.responseStatus,
          responseExcerpt: dispatchResult.responseExcerpt,
          isTruncated: dispatchResult.isTruncated,
          errorCode: dispatchResult.errorCode,
          errorMessage: dispatchResult.errorMessage,
          workerIdentity,
        });

        logger.info('Delivery successfully completed', {
          deliveryId: claim.deliveryId,
          attempt: claim.attemptCount + 1,
          durationMs,
        });
        return { status: 'delivered' };
      }

      // Record circuit breaker failure
      await CircuitBreaker.recordFailure(client, claim.destinationEndpointId);

      // Evaluate retry policy
      const retryDecision = evaluateRetry({
        firstAttemptAt: claim.firstAttemptAt,
        horizonStartedAt: claim.horizonStartedAt ?? null,
        attemptCount: claim.attemptCount + 1,
        epochAttemptCount: (claim.epochAttemptCount ?? 0) + 1,
        httpStatus: dispatchResult.httpStatus,
        errorCode: dispatchResult.errorCode,
        maxRetries: Math.min(endpoint.max_retries ?? 50, 50),
      });

      if (retryDecision.shouldRetry && retryDecision.nextAttemptAt) {
        // Enforce monotonic fencing token match FIRST
        await LeaseManager.retryFenced(
          client,
          claim.deliveryId,
          claim.fencingToken,
          retryDecision.nextAttemptAt,
          dispatchResult.httpStatus,
          dispatchResult.errorCode,
        );

        // Record attempt only after successful fenced write
        await AttemptsRepo.recordAttempt(client, {
          deliveryId: claim.deliveryId,
          attemptNumber: claim.attemptCount + 1,
          fencingToken: claim.fencingToken,
          startedAt,
          finishedAt,
          durationMs,
          httpStatus: dispatchResult.httpStatus,
          responseStatus: dispatchResult.responseStatus,
          responseExcerpt: dispatchResult.responseExcerpt,
          isTruncated: dispatchResult.isTruncated,
          errorCode: dispatchResult.errorCode,
          errorMessage: dispatchResult.errorMessage,
          workerIdentity,
        });

        logger.warn('Delivery scheduled for retry', {
          deliveryId: claim.deliveryId,
          nextAttemptAt: retryDecision.nextAttemptAt.toISOString(),
          httpStatus: dispatchResult.httpStatus,
        });
        return { status: 'retry_scheduled' };
      } else {
        // Enforce monotonic fencing token match FIRST
        await LeaseManager.deadLetterFenced(
          client,
          claim.deliveryId,
          claim.fencingToken,
          retryDecision.terminalReason ?? 'MAX_RETRIES_EXCEEDED',
          dispatchResult.httpStatus,
          dispatchResult.errorCode,
        );

        // Record attempt only after successful fenced write
        await AttemptsRepo.recordAttempt(client, {
          deliveryId: claim.deliveryId,
          attemptNumber: claim.attemptCount + 1,
          fencingToken: claim.fencingToken,
          startedAt,
          finishedAt,
          durationMs,
          httpStatus: dispatchResult.httpStatus,
          responseStatus: dispatchResult.responseStatus,
          responseExcerpt: dispatchResult.responseExcerpt,
          isTruncated: dispatchResult.isTruncated,
          errorCode: dispatchResult.errorCode,
          errorMessage: dispatchResult.errorMessage,
          workerIdentity,
        });

        logger.error(
          'Delivery transitioned to dead_lettered',
          undefined,
          {
            deliveryId: claim.deliveryId,
            terminalReason: retryDecision.terminalReason,
            httpStatus: dispatchResult.httpStatus,
          },
        );
        return { status: 'dead_lettered' };
      }
    });
  },
};
