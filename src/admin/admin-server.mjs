import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import { ApplicationsRepo } from '../db/repositories/applications-repo.mjs';
import { DeliveriesRepo } from '../db/repositories/deliveries-repo.mjs';
import { EventsRepo } from '../db/repositories/events-repo.mjs';
import { AuditService } from './audit-service.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { constantTimeCompare } from '../providers/base-adapter.mjs';

/**
 * Creates the Privileged Administrative API Router.
 *
 * @param {object} deps
 * @param {pg.Pool} deps.pool
 * @param {string} deps.adminApiToken
 * @returns {express.Router}
 */
export function createAdminRouter({ pool, adminApiToken }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  /**
   * Admin Bearer token authentication middleware with constant-time comparison.
   * @param {express.Request} req
   * @param {express.Response} res
   * @param {express.NextFunction} next
   * @returns {void}
   */
  function authenticateAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Expected Bearer token.',
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!constantTimeCompare(token, adminApiToken)) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Invalid administrative token.',
      });
      return;
    }

    next();
  }

  router.use(authenticateAdmin);

  /**
   * POST /v1/admin/applications
   * Registers a new tenant application and provisions an API key.
   */
  router.post('/applications', async (req, res, next) => {
    try {
      const { code, name } = req.body ?? {};
      if (!code || typeof code !== 'string' || !name || typeof name !== 'string') {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'code and name are required.' });
        return;
      }

      const rawApiKey = `cwids_${crypto.randomBytes(32).toString('hex')}`;
      const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

      const client = await pool.connect();
      try {
        const app = await ApplicationsRepo.create(client, {
          code: code.trim(),
          name: name.trim(),
          apiKeyHash,
        });

        await AuditService.recordAction(client, {
          actorIdentity: 'admin',
          applicationId: app.id,
          action: 'application.create',
          targetType: 'application',
          targetId: app.id,
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : crypto.randomUUID(),
          outcome: 'success',
          auditClass: 'security',
        });

        res.status(201).json({
          id: app.id,
          code: app.code,
          name: app.name,
          api_key: rawApiKey, // Displayed once at creation
          created_at: app.created_at,
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/admin/applications/:id/endpoints
   * Configures a destination HTTPS webhook endpoint for an application.
   */
  router.post('/applications/:id/endpoints', async (req, res, next) => {
    try {
      const applicationId = req.params.id;
      const { url, signing_secret, http_timeout_ms, max_retries } = req.body ?? {};

      if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'url must be a valid https:// URL.' });
        return;
      }

      if (!signing_secret || typeof signing_secret !== 'string' || signing_secret.length < 16) {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'signing_secret must be at least 16 characters.' });
        return;
      }

      const client = await pool.connect();
      try {
        // Query next version number
        const versionRes = await client.query(
          'SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM cwids.destination_endpoints WHERE application_id = $1',
          [applicationId],
        );
        const nextVersion = versionRes.rows[0].next_version;

        const endpointRes = await client.query(
          `INSERT INTO cwids.destination_endpoints
             (application_id, version, url, signing_secret, http_timeout_ms, max_retries, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           RETURNING id, application_id, version, url, http_timeout_ms, max_retries, status, created_at`,
          [
            applicationId,
            nextVersion,
            url,
            signing_secret,
            http_timeout_ms ?? 5000,
            max_retries ?? 15,
          ],
        );

        const endpoint = endpointRes.rows[0];

        await AuditService.recordAction(client, {
          actorIdentity: 'admin',
          applicationId,
          action: 'endpoint.configure',
          targetType: 'destination_endpoint',
          targetId: endpoint.id,
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : crypto.randomUUID(),
          outcome: 'success',
          auditClass: 'security',
        });

        res.status(201).json(endpoint);
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/admin/events/unresolved
   * Retrieves events awaiting routing or quarantined.
   */
  router.get('/events/unresolved', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT id, provider_connection_id, provider, environment, dedupe_key,
                  event_type, resource_type, resource_reference, routing_status, routing_mode,
                  received_at
           FROM cwids.webhook_events
           WHERE routing_status IN ('awaiting_route', 'quarantined')
           ORDER BY received_at DESC
           LIMIT $1`,
          [limit],
        );
        res.status(200).json({ events: result.rows });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/admin/events/:id/resolve
   * Manually routes an unresolved or quarantined event to an application.
   */
  router.post('/events/:id/resolve', async (req, res, next) => {
    try {
      const eventId = req.params.id;
      const { application_id, reason } = req.body ?? {};

      if (!application_id || typeof application_id !== 'string') {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'application_id is required.' });
        return;
      }

      const client = await pool.connect();
      try {
        const event = await EventsRepo.findById(client, eventId);
        if (!event) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Webhook event not found.' });
          return;
        }

        if (event.routing_status === 'resolved') {
          res.status(409).json({ code: 'ALREADY_RESOLVED', message: 'Event is already resolved.' });
          return;
        }

        // Find active destination endpoint for application
        const epRes = await client.query(
          'SELECT id FROM cwids.destination_endpoints WHERE application_id = $1 AND status = $2 ORDER BY version DESC LIMIT 1',
          [application_id, 'active'],
        );
        const endpoint = epRes.rows[0];
        if (!endpoint) {
          res.status(422).json({ code: 'NO_ACTIVE_ENDPOINT', message: 'Application has no active destination endpoint.' });
          return;
        }

        await withTransaction(pool, application_id, async (txClient) => {
          // Update event routing status
          await txClient.query(
            `UPDATE cwids.webhook_events
             SET routing_status = 'resolved',
                 application_id = $1,
                 routing_mode = 'manual_admin'
             WHERE id = $2`,
            [application_id, eventId],
          );

          // Create delivery obligation
          await DeliveriesRepo.insertDelivery(txClient, {
            eventId,
            applicationId: application_id,
            destinationEndpointId: endpoint.id,
          });

          // Audit record
          await AuditService.recordAction(txClient, {
            actorIdentity: 'admin',
            applicationId: application_id,
            action: 'event.manual_resolve',
            targetType: 'webhook_event',
            targetId: eventId,
            requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : crypto.randomUUID(),
            outcome: 'success',
            reasonCode: reason ?? 'manual_routing_override',
            auditClass: 'operational',
          });
        });

        res.status(200).json({ status: 'success', message: 'Event resolved and delivery scheduled.' });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/admin/deliveries/:id/redrive
   * Controlled administrative redrive for dead-lettered deliveries (GAP-07).
   */
  router.post('/deliveries/:id/redrive', async (req, res, next) => {
    try {
      const deliveryId = req.params.id;
      const { reason } = req.body ?? {};

      const client = await pool.connect();
      try {
        const existing = await DeliveriesRepo.findById(client, deliveryId);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Delivery record not found.' });
          return;
        }

        if (existing.status !== 'dead_lettered') {
          res.status(409).json({
            code: 'INVALID_STATE',
            message: `Delivery status is '${existing.status}'. Only 'dead_lettered' deliveries can be redriven.`,
          });
          return;
        }

        const redriveResult = await withTransaction(pool, existing.application_id, async (txClient) => {
          const updated = await DeliveriesRepo.redriveDelivery(txClient, deliveryId);
          if (!updated) {
            throw new Error('Failed to update delivery during redrive.');
          }

          const audit = await AuditService.recordAction(txClient, {
            actorIdentity: 'admin',
            applicationId: updated.application_id,
            action: 'delivery.manual_redrive',
            targetType: 'event_delivery',
            targetId: deliveryId,
            requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : crypto.randomUUID(),
            outcome: 'success',
            reasonCode: reason ?? 'manual_admin_redrive',
            beforeState: { status: existing.status, fencing_token: existing.fencing_token },
            afterState: { status: updated.status, fencing_token: updated.fencing_token },
            auditClass: 'operational',
          });

          return { updated, auditEventId: audit.auditEventId };
        });

        res.status(200).json({
          delivery_id: redriveResult.updated.id,
          event_id: redriveResult.updated.event_id,
          status: redriveResult.updated.status,
          fencing_token: redriveResult.updated.fencing_token,
          attempt_count: redriveResult.updated.attempt_count,
          next_attempt_at: redriveResult.updated.next_attempt_at,
          redrive_audit_id: redriveResult.auditEventId,
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
