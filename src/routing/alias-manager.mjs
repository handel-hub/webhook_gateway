import pg from 'pg';
import { IntentsRepo } from '../db/repositories/intents-repo.mjs';

/**
 * Helper module for managing payment intent dynamic aliases (Mode C routing).
 */
export const AliasManager = {
  /**
   * Registers a dynamic alias for an active payment intent.
   * @param {pg.PoolClient} client
   * @param {string} paymentIntentId
   * @param {string} providerConnectionId
   * @param {string} environment
   * @param {'provider_reference' | 'virtual_account_id' | 'session_id'} aliasType
   * @param {string} aliasValue
   * @returns {Promise<void>}
   */
  async registerAlias(client, paymentIntentId, providerConnectionId, environment, aliasType, aliasValue) {
    if (!aliasValue || !aliasValue.trim()) {
      return;
    }
    await IntentsRepo.createAlias(client, {
      paymentIntentId,
      providerConnectionId,
      environment,
      aliasType,
      aliasValue: aliasValue.trim(),
    });
  },

  /**
   * Looks up a payment intent by an alias value.
   * @param {pg.PoolClient} client
   * @param {string} providerConnectionId
   * @param {string} environment
   * @param {string} aliasType
   * @param {string} aliasValue
   * @returns {Promise<import('../types/domain.mjs').PaymentIntentRecord | null>}
   */
  async lookupAlias(client, providerConnectionId, environment, aliasType, aliasValue) {
    return IntentsRepo.findByAlias(client, providerConnectionId, environment, aliasType, aliasValue);
  },
};
