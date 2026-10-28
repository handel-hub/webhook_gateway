import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import { ApplicationsRepo } from '../db/repositories/applications-repo.mjs';
import { IntentsRepo } from '../db/repositories/intents-repo.mjs';
import { withTransaction } from '../db/transaction.mjs';

/**
 * @typedef {import('../types/domain.mjs').ApplicationRecord} ApplicationRecord
 * @typedef {express.Request & { appTenant: ApplicationRecord }} AuthenticatedRequest
 */

/**
 * Creates the Internal API router for payment intent correlation and alias registration.
 *
 * @param {object} deps
 * @param {pg.Pool} deps.pool
 * @returns {express.Router}
 */
export function createInternalApiRouter({ pool }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  /**
   * Bearer token authentication middleware for application tenants.
   * @param {express.Request} req
   * @param {express.Response} res
   * @param {express.NextFunction} next
   * @returns {Promise<void>}
   */
  async function authenticateApplication(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Expected Bearer token.',
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Empty Bearer token provided.',
      });
      return;
    }

    const apiKeyHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const client = await pool.connect();
      try {
        const app = await ApplicationsRepo.findByApiKeyHash(client, apiKeyHash);
        if (!app) {
          res.status(401).json({
            code: 'UNAUTHORIZED',
            message: 'Invalid or inactive application API key.',
          });
          return;
        }
        /** @type {AuthenticatedRequest} */ (/** @type {unknown} */ (req)).appTenant = app;
        next();
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }

  router.use(authenticateApplication);

  /**
   * POST /v1/internal/payment-intents
   * Registers a payment intent correlation for Mode A routing.
   */
  router.post('/payment-intents', async (req, res, next) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        res.status(400).json({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required.',
        });
        return;
      }

      const body = req.body ?? {};
      const {
        provider_connection_id,
        environment,
        merchant_reference,
        expected_amount_minor,
        currency,
        expires_at,
        aliases,
        metadata,
      } = body;

      // 1. Validate required fields
      if (!provider_connection_id || typeof provider_connection_id !== 'string') {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'provider_connection_id is required.' });
        return;
      }
      if (!environment || !['live', 'test', 'sandbox'].includes(environment)) {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: "environment must be 'live', 'test', or 'sandbox'." });
        return;
      }
      if (!merchant_reference || typeof merchant_reference !== 'string' || !merchant_reference.trim()) {
        res.status(422).json({ code: 'VALIDATION_ERROR', message: 'merchant_reference is required.' });
        return;
      }

      // 2. Validate amount minor units
      if (
        typeof expected_amount_minor !== 'number' ||
        !Number.isInteger(expected_amount_minor) ||
        expected_amount_minor < 0
      ) {
        res.status(422).json({
          code: 'INVALID_AMOUNT',
          message: 'expected_amount_minor must be a non-negative integer representing minor units.',
        });
        return;
      }

      // 3. Validate currency (ISO 4217 3-letter code)
      if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
        res.status(422).json({
          code: 'INVALID_CURRENCY',
          message: 'currency must be an ISO 4217 three-letter currency code.',
        });
        return;
      }

      // 4. Validate expires_at
      const expiresDate = new Date(expires_at);
      if (Number.isNaN(expiresDate.getTime())) {
        res.status(422).json({
          code: 'INVALID_EXPIRY',
          message: 'expires_at must be a valid ISO 8601 UTC timestamp.',
        });
        return;
      }

      const now = Date.now();
      const expiresMs = expiresDate.getTime();
      const minDuration = 15 * 60 * 1000; // 15 minutes
      const maxDuration = 30 * 24 * 60 * 60 * 1000; // 30 days

      if (expiresMs < now + minDuration || expiresMs > now + maxDuration) {
        res.status(422).json({
          code: 'INVALID_EXPIRY_RANGE',
          message: 'expires_at must be between 15 minutes and 30 days in the future.',
        });
        return;
      }

      // 5. Validate metadata (ensure no PAN / sensitive card data)
      if (metadata) {
        const metadataStr = JSON.stringify(metadata);
        if (/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/.test(metadataStr)) {
          res.status(422).json({
            code: 'PROHIBITED_METADATA',
            message: 'metadata must not contain payment card numbers (PAN).',
          });
          return;
        }
      }

      const app = /** @type {AuthenticatedRequest} */ (/** @type {unknown} */ (req)).appTenant;
      const appId = app.id;

      // 6. Check existing intent by idempotency key
      const client = await pool.connect();
      try {
        const existing = await IntentsRepo.findByIdempotencyKey(client, appId, idempotencyKey);
        if (existing) {
          const isMatching =
            existing.provider_connection_id === provider_connection_id &&
            existing.environment === environment &&
            existing.merchant_reference === merchant_reference &&
            Number(existing.expected_amount_minor) === expected_amount_minor &&
            existing.currency.toUpperCase() === currency.toUpperCase();

          if (isMatching) {
            res.status(200).json({
              id: existing.id,
              application_id: existing.application_id,
              provider_connection_id: existing.provider_connection_id,
              environment: existing.environment,
              merchant_reference: existing.merchant_reference,
              expected_amount_minor: Number(existing.expected_amount_minor),
              currency: existing.currency,
              status: existing.status,
              expires_at: existing.expires_at,
              created_at: existing.created_at,
            });
            return;
          } else {
            res.status(409).json({
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'Idempotency-Key was already used with conflicting parameters.',
            });
            return;
          }
        }
      } finally {
        client.release();
      }

      // 7. Insert new payment intent correlation inside transaction
      let createdIntent;
      try {
        createdIntent = await withTransaction(pool, appId, async (txClient) => {
          const intent = await IntentsRepo.createIntent(txClient, {
            applicationId: appId,
            providerConnectionId: provider_connection_id,
            environment,
            merchantReference: merchant_reference,
            expectedAmountMinor: expected_amount_minor,
            currency,
            idempotencyKey,
            expiresAt: expiresDate,
            metadata: metadata ?? {},
          });

          // Insert optional aliases
          if (Array.isArray(aliases)) {
            for (const alias of aliases) {
              if (alias.alias_type && alias.alias_value) {
                await IntentsRepo.createAlias(txClient, {
                  paymentIntentId: intent.id,
                  providerConnectionId: provider_connection_id,
                  environment,
                  aliasType: alias.alias_type,
                  aliasValue: alias.alias_value,
                });
              }
            }
          }

          return intent;
        });
      } catch (err) {
        // @ts-ignore
        if (err && err.code === '23505') {
          // Unique violation: merchant_reference conflict
          res.status(409).json({
            code: 'MERCHANT_REF_CONFLICT',
            message: 'Merchant reference is already registered for this provider connection.',
          });
          return;
        }
        throw err;
      }

      res.status(201).json({
        id: createdIntent.id,
        application_id: createdIntent.application_id,
        provider_connection_id: createdIntent.provider_connection_id,
        environment: createdIntent.environment,
        merchant_reference: createdIntent.merchant_reference,
        expected_amount_minor: Number(createdIntent.expected_amount_minor),
        currency: createdIntent.currency,
        status: createdIntent.status,
        expires_at: createdIntent.expires_at,
        created_at: createdIntent.created_at,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/internal/payment-intents/:id/aliases
   * Enriches an existing intent with dynamic provider-issued aliases.
   */
  router.post('/payment-intents/:id/aliases', async (req, res, next) => {
    try {
      const intentId = req.params.id;
      const { alias_type, alias_value } = req.body ?? {};

      if (!alias_type || !['provider_reference', 'virtual_account_id', 'session_id'].includes(alias_type)) {
        res.status(422).json({
          code: 'INVALID_ALIAS_TYPE',
          message: "alias_type must be one of 'provider_reference', 'virtual_account_id', 'session_id'.",
        });
        return;
      }

      if (!alias_value || typeof alias_value !== 'string' || !alias_value.trim()) {
        res.status(422).json({
          code: 'INVALID_ALIAS_VALUE',
          message: 'alias_value is required.',
        });
        return;
      }

      const app = /** @type {AuthenticatedRequest} */ (/** @type {unknown} */ (req)).appTenant;
      const client = await pool.connect();
      try {
        const intent = await IntentsRepo.findById(client, intentId);
        if (!intent) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Payment intent not found.' });
          return;
        }

        if (intent.application_id !== app.id) {
          res.status(403).json({ code: 'FORBIDDEN', message: 'Payment intent belongs to another tenant.' });
          return;
        }

        await IntentsRepo.createAlias(client, {
          paymentIntentId: intent.id,
          providerConnectionId: intent.provider_connection_id,
          environment: intent.environment,
          aliasType: alias_type,
          aliasValue: alias_value,
        });

        res.status(201).json({
          status: 'success',
          message: 'Alias registered successfully.',
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
