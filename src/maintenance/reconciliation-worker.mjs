import pg from 'pg';
import { ReconciliationRepo } from '../db/repositories/reconciliation-repo.mjs';
import { FlutterwaveReconciliationAdapter } from '../providers/flutterwave/reconciliation.mjs';
import { PaystackReconciliationAdapter } from '../providers/paystack/reconciliation.mjs';
import { withTransaction } from '../db/transaction.mjs';
import { createLogger } from '../observability/logger.mjs';

const logger = createLogger({ service: 'reconciliation-worker' });

/**
 * @typedef {import('../config/env.mjs').AppEnv} AppEnv
 */

/**
 * Optional Automated Provider Reconciliation Engine (ADR-11).
 */
export const ReconciliationWorker = {
  /**
   * Processes a single batch of eligible payment intents for provider reconciliation.
   *
   * @param {pg.Pool} pool
   * @param {AppEnv} env
   * @param {object} [options]
   * @param {number} [options.minAgeMinutes=30]
   * @param {number} [options.limit=50]
   * @param {number} [options.rateLimitDelayMs=200] 5 requests per second
   * @returns {Promise<{ processed: number, matched: number, discrepancies: number, errors: number }>}
   */
  async runReconciliationCycle(pool, env, options = {}) {
    if (!env.RECONCILIATION_ENABLED) {
      logger.debug('Reconciliation worker skipped (RECONCILIATION_ENABLED is false)');
      return { processed: 0, matched: 0, discrepancies: 0, errors: 0 };
    }

    const minAge = options.minAgeMinutes ?? 30;
    const limit = options.limit ?? 50;
    const rateLimitDelayMs = options.rateLimitDelayMs ?? 200;

    // 1. Fetch eligible candidates
    const candidates = await withTransaction(pool, null, async (client) => {
      return ReconciliationRepo.findCandidates(client, minAge, limit);
    });

    if (candidates.length === 0) {
      return { processed: 0, matched: 0, discrepancies: 0, errors: 0 };
    }

    let processed = 0;
    let matched = 0;
    let discrepancies = 0;
    let errors = 0;

    for (const candidate of candidates) {
      processed++;
      try {
        let verificationResult;

        if (candidate.provider === 'flutterwave') {
          if (!env.FLUTTERWAVE_RECONCILIATION_SECRET_KEY) {
            logger.warn('Flutterwave reconciliation key not configured; skipping candidate', {
              intentId: candidate.intentId,
            });
            continue;
          }
          verificationResult = await FlutterwaveReconciliationAdapter.verifyTransaction({
            secretKey: env.FLUTTERWAVE_RECONCILIATION_SECRET_KEY,
            merchantReference: candidate.merchantReference,
            timeoutMs: env.RECONCILIATION_TIMEOUT_MS,
          });
        } else if (candidate.provider === 'paystack') {
          if (!env.PAYSTACK_RECONCILIATION_SECRET_KEY) {
            logger.warn('Paystack reconciliation key not configured; skipping candidate', {
              intentId: candidate.intentId,
            });
            continue;
          }
          verificationResult = await PaystackReconciliationAdapter.verifyTransaction({
            secretKey: env.PAYSTACK_RECONCILIATION_SECRET_KEY,
            merchantReference: candidate.merchantReference,
            timeoutMs: env.RECONCILIATION_TIMEOUT_MS,
          });
        } else {
          logger.warn('Unsupported provider for reconciliation', { provider: candidate.provider });
          continue;
        }

        // Evaluate discrepancy
        let status = 'matched';
        /** @type {string[]} */
        const discrepancyNotes = [];

        if (!verificationResult.success || verificationResult.status !== 'successful') {
          status = 'discrepancy_detected';
          discrepancyNotes.push(`Provider verification status: '${verificationResult.status}'`);
        }

        if (
          verificationResult.verifiedAmountMinor !== null &&
          Number(candidate.expectedAmountMinor) !== verificationResult.verifiedAmountMinor
        ) {
          status = 'discrepancy_detected';
          discrepancyNotes.push(
            `Amount mismatch: expected ${candidate.expectedAmountMinor}, received ${verificationResult.verifiedAmountMinor}`,
          );
        }

        if (
          verificationResult.verifiedCurrency &&
          candidate.expectedCurrency.toUpperCase() !== verificationResult.verifiedCurrency.toUpperCase()
        ) {
          status = 'discrepancy_detected';
          discrepancyNotes.push(
            `Currency mismatch: expected ${candidate.expectedCurrency}, received ${verificationResult.verifiedCurrency}`,
          );
        }

        if (status === 'matched') {
          matched++;
        } else {
          discrepancies++;
        }

        // Insert record into reconciliation_records
        await withTransaction(pool, null, async (client) => {
          await ReconciliationRepo.insertRecord(client, {
            paymentIntentId: candidate.intentId,
            providerConnectionId: candidate.providerConnectionId,
            status: /** @type {'matched' | 'discrepancy_detected'} */ (status),
            providerStatus: verificationResult.status,
            verifiedAmountMinor: verificationResult.verifiedAmountMinor,
            verifiedCurrency: verificationResult.verifiedCurrency,
            verifiedReference: verificationResult.verifiedReference,
            rawResponse: verificationResult.rawResponse,
            discrepancyNotes: discrepancyNotes.length > 0 ? discrepancyNotes.join('; ') : null,
          });
        });

        // Bounded rate limiting
        if (rateLimitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs));
        }
      } catch (err) {
        errors++;
        logger.error(
          'Reconciliation failed for candidate',
          err instanceof Error ? err : new Error(String(err)),
          { intentId: candidate.intentId },
        );
      }
    }

    logger.info('Reconciliation cycle completed', {
      processed,
      matched,
      discrepancies,
      errors,
    });

    return { processed, matched, discrepancies, errors };
  },

  /**
   * Starts periodic reconciliation daemon if enabled.
   *
   * @param {pg.Pool} pool
   * @param {AppEnv} env
   * @param {object} [options]
   * @returns {{ stop: () => void }}
   */
  startWorker(pool, env, options = {}) {
    if (!env.RECONCILIATION_ENABLED) {
      logger.info('Reconciliation worker is disabled by configuration (RECONCILIATION_ENABLED=false)');
      return { stop() {} };
    }

    let running = true;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    const intervalMs = (env.RECONCILIATION_INTERVAL_MIN ?? 60) * 60 * 1000;

    async function tick() {
      if (!running) return;
      try {
        await ReconciliationWorker.runReconciliationCycle(pool, env, options);
      } catch (err) {
        logger.error('Error in reconciliation worker loop', err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (running) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    }

    timer = setTimeout(tick, intervalMs);

    return {
      stop() {
        running = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  },
};
