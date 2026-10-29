import pg from 'pg';

/**
 * @typedef {import('../types/domain.mjs').RoutingResolution} RoutingResolution
 * @typedef {import('../types/domain.mjs').RoutingKeys} RoutingKeys
 * @typedef {import('../types/domain.mjs').ProviderConnectionRecord} ProviderConnectionRecord
 */

/**
 * Resolves destination application ownership for an incoming authenticated webhook.
 * Executes purely local database queries with zero synchronous external HTTP calls.
 *
 * @param {pg.PoolClient} client - Active database transaction client.
 * @param {object} params
 * @param {ProviderConnectionRecord} params.providerConnection - Ingress provider connection row.
 * @param {RoutingKeys} params.routingKeys - Extracted keys (merchantRef, providerRef, virtualAccountId).
 * @returns {Promise<RoutingResolution>}
 */
export async function resolveRouting(client, { providerConnection, routingKeys }) {
  // Mode B: Dedicated Provider Connection (Single-Tenant Mode)
  if (providerConnection.application_id !== null && providerConnection.application_id !== undefined) {
    return {
      status: 'resolved',
      applicationId: providerConnection.application_id,
      paymentIntentId: null,
      routingMode: 'MODE_B_DEDICATED_CONNECTION',
    };
  }

  // Mode A: Merchant Reference Match (Payment Intent Correlation)
  if (routingKeys.merchantReference) {
    const res = await client.query(
      `SELECT DISTINCT id, application_id
       FROM cwids.payment_intent_correlations
       WHERE provider_connection_id = $1
         AND environment = $2
         AND merchant_reference = $3
         AND status IN ('active', 'consumed')
         AND (expires_at IS NULL OR expires_at + INTERVAL '7 days' >= CURRENT_TIMESTAMP)`,
      [providerConnection.id, providerConnection.environment, routingKeys.merchantReference],
    );

    if (res.rows.length === 1) {
      return {
        status: 'resolved',
        applicationId: res.rows[0].application_id,
        paymentIntentId: res.rows[0].id,
        routingMode: 'MODE_A_MERCHANT_REFERENCE',
      };
    }

    if (res.rows.length > 1) {
      // Ambiguous multiple matches -> Quarantine
      return {
        status: 'quarantined',
        applicationId: null,
        paymentIntentId: null,
        routingMode: 'CONFLICT_MULTIPLE_MATCHES',
      };
    }
  }

  // Mode C: Dynamic Provider Alias Match (Virtual Account / Dynamic Provider Reference)
  if (routingKeys.providerReference || routingKeys.virtualAccountId) {
    const aliasRes = await client.query(
      `SELECT DISTINCT pic.id, pic.application_id
       FROM cwids.payment_intent_aliases pia
       JOIN cwids.payment_intent_correlations pic ON pia.payment_intent_id = pic.id
       WHERE pia.provider_connection_id = $1
         AND pia.environment = $2
         AND ((pia.alias_type = 'provider_reference' AND pia.alias_value = $3)
           OR (pia.alias_type = 'virtual_account_id' AND pia.alias_value = $4))
         AND pic.status IN ('active', 'consumed')
         AND (pic.expires_at IS NULL OR pic.expires_at + INTERVAL '7 days' >= CURRENT_TIMESTAMP)`,
      [
        providerConnection.id,
        providerConnection.environment,
        routingKeys.providerReference || '',
        routingKeys.virtualAccountId || '',
      ],
    );

    if (aliasRes.rows.length === 1) {
      return {
        status: 'resolved',
        applicationId: aliasRes.rows[0].application_id,
        paymentIntentId: aliasRes.rows[0].id,
        routingMode: 'MODE_C_DYNAMIC_ALIAS',
      };
    }

    if (aliasRes.rows.length > 1) {
      return {
        status: 'quarantined',
        applicationId: null,
        paymentIntentId: null,
        routingMode: 'CONFLICT_MULTIPLE_MATCHES',
      };
    }
  }

  // Mode D: Unresolved (Hold for late-arriving intent or manual operator review)
  return {
    status: 'awaiting_route',
    applicationId: null,
    paymentIntentId: null,
    routingMode: 'UNRESOLVED_NO_MATCH',
  };
}
