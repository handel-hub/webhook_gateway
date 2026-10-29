import crypto from 'node:crypto';
import pg from 'pg';
import { getEnv } from '../config/env.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { EventsRepo } from '../db/repositories/events-repo.mjs';
import { DeliveriesRepo } from '../db/repositories/deliveries-repo.mjs';
import { AuditOutboxRepo } from '../db/repositories/audit-outbox-repo.mjs';
import { resolveRouting } from '../routing/routing-resolver.mjs';
import { encryptPayloadEnvelope } from '../security/crypto-envelope.mjs';
import { logger } from '../observability/logger.mjs';
import { NotFoundError } from '../errors/base-error.mjs';

/**
 * @typedef {import('../types/domain.mjs').ValidatedWebhookInput} ValidatedWebhookInput
 * @typedef {import('../types/domain.mjs').IngestionOutcome} IngestionOutcome
 * @typedef {import('../types/domain.mjs').ProviderConnectionRecord} ProviderConnectionRecord
 * @typedef {import('../types/provider.mjs').ProviderVerificationResult} ProviderVerificationResult
 */

/**
 * Ingestion Service executing the 14-step atomic Tx-Ingest workflow.
 */
export const IngestionService = {
  /**
   * Executes atomic event persistence and initial delivery scheduling.
   *
   * @param {pg.Pool} pool - Database ingress connection pool.
   * @param {object} params
   * @param {ProviderConnectionRecord} params.providerConnection - Ingress connection row.
   * @param {Buffer} params.rawBody - Raw request body buffer.
   * @param {string} params.payloadSha256 - SHA-256 hex digest of rawBody.
   * @param {ProviderVerificationResult} params.verification - Authentic verification result with normalized payload.
   * @returns {Promise<IngestionOutcome>}
   */
  async ingestWebhook(pool, { providerConnection, rawBody, payloadSha256, verification }) {
    const env = getEnv();
    const eventId = crypto.randomUUID();

    // 1. Application-layer AES-256-GCM envelope encryption
    const envelope = encryptPayloadEnvelope(rawBody, eventId, env.MASTER_KEK);

    const normalized = verification.normalized;

    if (verification.isMalformed || !normalized) {
      // Authenticated malformed / unsupported payload (Approved Decision 2)
      // Persist raw encrypted payload with routing_status = 'rejected' and no delivery obligation
      return withTransaction(pool, null, async (client) => {
        const { event, isDuplicate } = await EventsRepo.insertEvent(client, {
          id: eventId,
          providerConnectionId: providerConnection.id,
          provider: providerConnection.provider,
          environment: providerConnection.environment,
          identityStrategyVersion: 1,
          dedupeKey: verification.dedupeKey,
          providerEventId: null,
          eventType: 'malformed_payload',
          resourceType: 'raw',
          resourceReference: 'malformed',
          applicationId: null,
          paymentIntentId: null,
          routingStatus: 'rejected',
          routingMode: 'UNRESOLVED_NO_MATCH',
          encryptedPayload: envelope.encryptedPayload,
          payloadNonce: envelope.payloadNonce,
          payloadTag: envelope.payloadTag,
          wrappedDek: envelope.wrappedDek,
          kekVersion: 'v1',
          payloadSha256,
        });

        logger.warn('Persisted authenticated malformed webhook as rejected', {
          eventId: event.id,
          dedupeKey: verification.dedupeKey,
        });

        return {
          eventId: event.id,
          isDuplicate,
          routingStatus: 'rejected',
          deliveryId: null,
          committedAt: new Date(),
        };
      });
    }

    return withTransaction(pool, null, async (client) => {
      // 2. Deterministic local routing resolution
      const routing = await resolveRouting(client, {
        providerConnection,
        routingKeys: {
          merchantReference: normalized.merchantReference,
          providerReference: normalized.providerReference,
          virtualAccountId: normalized.virtualAccountId,
        },
      });

      // 3. Insert or detect duplicate event in webhook_events
      const { event, isDuplicate } = await EventsRepo.insertEvent(client, {
        id: eventId,
        providerConnectionId: providerConnection.id,
        provider: providerConnection.provider,
        environment: providerConnection.environment,
        identityStrategyVersion: 1,
        dedupeKey: verification.dedupeKey,
        providerEventId: normalized.providerReference,
        eventType: normalized.eventType,
        resourceType: 'transaction',
        resourceReference: normalized.merchantReference || normalized.providerReference || 'unknown',
        applicationId: routing.applicationId,
        paymentIntentId: routing.paymentIntentId,
        routingStatus: routing.status,
        routingMode: routing.routingMode,
        encryptedPayload: envelope.encryptedPayload,
        payloadNonce: envelope.payloadNonce,
        payloadTag: envelope.payloadTag,
        wrappedDek: envelope.wrappedDek,
        kekVersion: 'v1',
        payloadSha256,
      });

      let deliveryId = null;

      if (isDuplicate) {
        logger.info('Duplicate webhook detected and absorbed', {
          eventId: event.id,
          dedupeKey: verification.dedupeKey,
        });

        // Check for payload conflict
        if (event.payload_sha256 !== payloadSha256) {
          logger.warn('PAYLOAD_CONFLICT: Provider reused dedupe key with conflicting payload', {
            eventId: event.id,
            originalSha256: event.payload_sha256,
            newSha256: payloadSha256,
          });

          await AuditOutboxRepo.insertAuditEvent(client, {
            actorIdentity: `provider:${providerConnection.provider}`,
            applicationId: event.application_id,
            action: 'PAYLOAD_CONFLICT_WARNING',
            targetType: 'webhook_event',
            targetId: event.id,
            requestId: crypto.randomUUID(),
            outcome: 'warning',
            reasonCode: 'CONFLICTING_PAYLOAD_DIGEST',
            beforeState: { sha256: event.payload_sha256 },
            afterState: { sha256: payloadSha256 },
            auditClass: 'security',
          });
        }
      } else if (routing.status === 'resolved' && routing.applicationId) {
        // 4. If routing resolved and not duplicate, query active destination endpoint
        const endpointRes = await client.query(
          `SELECT id FROM cwids.destination_endpoints
           WHERE application_id = $1 AND status = 'active'
           ORDER BY version DESC LIMIT 1`,
          [routing.applicationId],
        );

        const endpoint = endpointRes.rows[0];
        if (endpoint) {
          // 5. Create initial delivery obligation in pending state
          const delivery = await DeliveriesRepo.insertDelivery(client, {
            eventId: event.id,
            applicationId: routing.applicationId,
            destinationEndpointId: endpoint.id,
          });
          deliveryId = delivery.id;
        } else {
          logger.warn('No active destination endpoint found for application', {
            applicationId: routing.applicationId,
            eventId: event.id,
          });
        }

        // 6. Queue audit outbox event
        await AuditOutboxRepo.insertAuditEvent(client, {
          actorIdentity: `provider:${providerConnection.provider}`,
          applicationId: routing.applicationId,
          action: 'WEBHOOK_INGESTED',
          targetType: 'webhook_event',
          targetId: event.id,
          requestId: crypto.randomUUID(),
          outcome: 'success',
          afterState: {
            routingStatus: routing.status,
            routingMode: routing.routingMode,
            deliveryId,
          },
          auditClass: 'operational',
        });
      }

      return {
        eventId: event.id,
        isDuplicate,
        routingStatus: routing.status,
        deliveryId,
        committedAt: new Date(),
      };
    });
  },
};
